-- ============================================================================
--  DeepResearch 多 Agent 行业深度分析助手 · Supabase 初始化脚本
--
--  使用方式：
--    1. 打开 https://supabase.com/dashboard → 新建项目（免费层即可）
--    2. 左侧 SQL Editor → New query → 粘贴本文件全部内容 → RUN
--    3. 左侧 Project Settings → API，复制 Project URL 与 anon public key，
--       分别填入 Netlify 环境变量 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
--
--  这张脚本建了 4 张表：
--    documents        文档元数据（用户导入的研报 / 内部资料）
--    knowledge_chunks 文档分片 + 512 维向量（本地知识库检索的数据源）
--    memories         长期记忆（语义偏好 + 情景任务）
--    research_runs    历史研究任务（情景记忆的明细）
-- ============================================================================

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- 1. 文档元数据
-- ---------------------------------------------------------------------------
create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  user_id      text        not null,
  title        text        not null,
  source_type  text        not null default 'upload',
  chunk_count  integer     not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists documents_user_created_idx
  on public.documents (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. 知识分片 + 向量
--    向量维度固定 512：与前端 embedding.ts 的
--    「特征哈希向量」和「bge-small-zh-v1.5」两种后端保持一致，
--    因此切换向量后端无需重建表结构。
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_chunks (
  id              bigserial primary key,
  document_id     uuid        not null references public.documents(id) on delete cascade,
  user_id         text        not null,
  document_title  text        not null default '',
  chunk_index     integer     not null default 0,
  content         text        not null,
  embedding       vector(512),
  created_at      timestamptz not null default now()
);

create index if not exists knowledge_chunks_user_idx
  on public.knowledge_chunks (user_id);

create index if not exists knowledge_chunks_document_idx
  on public.knowledge_chunks (document_id);

-- HNSW 索引：比 IVFFlat 更适合「数据量中等但要求高召回」的场景，
-- 且不需要预先训练，导入后立即可用。
create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- 3. 长期记忆
--    kind = 'semantic'  用户偏好 / 画像（如「偏好通俗表达」）
--    kind = 'episodic'  历史任务（如「用户曾研究过某行业」）
-- ---------------------------------------------------------------------------
create table if not exists public.memories (
  id         uuid primary key default gen_random_uuid(),
  user_id    text        not null,
  tenant_id  text        not null default 'public',
  kind       text        not null default 'semantic',
  content    text        not null,
  embedding  vector(512),
  created_at timestamptz not null default now()
);

create index if not exists memories_user_idx
  on public.memories (user_id, kind);

create index if not exists memories_embedding_idx
  on public.memories using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- 4. 历史研究任务
-- ---------------------------------------------------------------------------
create table if not exists public.research_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       text        not null,
  tenant_id     text        not null default 'public',
  thread_id     text        not null default 'default',
  query         text        not null,
  answer        text        not null default '',
  iterations    integer     not null default 0,
  source_count  integer     not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists research_runs_user_created_idx
  on public.research_runs (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. 向量检索函数
--    参数用 text 接收 '[0.1,0.2,...]' 形式的向量字面量，函数内部再转 vector，
--    这样可以绕开 PostgREST 的类型推断歧义，前端只需传字符串即可。
-- ---------------------------------------------------------------------------
create or replace function public.match_knowledge_chunks(
  query_embedding text,
  match_user_id   text,
  match_count     integer default 5,
  match_threshold double precision default 0.1
)
returns table (
  id             bigint,
  document_id    uuid,
  document_title text,
  chunk_index    integer,
  content        text,
  similarity     double precision
)
language sql
stable
as $$
  select
    kc.id,
    kc.document_id,
    kc.document_title,
    kc.chunk_index,
    kc.content,
    1 - (kc.embedding <=> (query_embedding)::vector(512)) as similarity
  from public.knowledge_chunks kc
  where kc.user_id = match_user_id
    and kc.embedding is not null
    and 1 - (kc.embedding <=> (query_embedding)::vector(512)) > match_threshold
  order by kc.embedding <=> (query_embedding)::vector(512)
  limit greatest(match_count, 1);
$$;

create or replace function public.match_memories(
  query_embedding text,
  match_user_id   text,
  match_count     integer default 6,
  match_threshold double precision default 0.1
)
returns table (
  id         uuid,
  kind       text,
  content    text,
  created_at timestamptz,
  similarity double precision
)
language sql
stable
as $$
  select
    m.id,
    m.kind,
    m.content,
    m.created_at,
    1 - (m.embedding <=> (query_embedding)::vector(512)) as similarity
  from public.memories m
  where m.user_id = match_user_id
    and m.embedding is not null
    and 1 - (m.embedding <=> (query_embedding)::vector(512)) > match_threshold
  order by m.embedding <=> (query_embedding)::vector(512)
  limit greatest(match_count, 1);
$$;

grant execute on function public.match_knowledge_chunks(text, text, integer, double precision) to anon, authenticated;
grant execute on function public.match_memories(text, text, integer, double precision) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. 行级安全（RLS）
--
-- 默认策略（下面这组）适用于「公开演示站」：任何持有 anon key 的访客都能读写，
-- 数据按 user_id 逻辑隔离，但服务端不做强制校验 —— 适合演示，不适合存放敏感数据。
--
-- 如果要真正做多租户隔离，请按顺序做两件事：
--   (1) Supabase 控制台 → Authentication → Sign In / Providers → 打开 Anonymous Sign-Ins
--   (2) 注释掉下面的默认策略，改用文件末尾「严格策略」那一段
-- ---------------------------------------------------------------------------
alter table public.documents        enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.memories         enable row level security;
alter table public.research_runs    enable row level security;

drop policy if exists demo_all_documents        on public.documents;
drop policy if exists demo_all_knowledge_chunks on public.knowledge_chunks;
drop policy if exists demo_all_memories         on public.memories;
drop policy if exists demo_all_research_runs    on public.research_runs;

create policy demo_all_documents on public.documents
  for all to anon, authenticated using (true) with check (true);

create policy demo_all_knowledge_chunks on public.knowledge_chunks
  for all to anon, authenticated using (true) with check (true);

create policy demo_all_memories on public.memories
  for all to anon, authenticated using (true) with check (true);

create policy demo_all_research_runs on public.research_runs
  for all to anon, authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 7.（可选）严格策略 —— 开启 Anonymous Sign-In 后，把上面 4 条 demo 策略删掉，
--     再执行下面这段，即可实现真正的「只能访问自己的数据」。
-- ---------------------------------------------------------------------------
-- drop policy if exists demo_all_documents        on public.documents;
-- drop policy if exists demo_all_knowledge_chunks on public.knowledge_chunks;
-- drop policy if exists demo_all_memories         on public.memories;
-- drop policy if exists demo_all_research_runs    on public.research_runs;
--
-- create policy own_documents on public.documents
--   for all to authenticated
--   using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);
--
-- create policy own_knowledge_chunks on public.knowledge_chunks
--   for all to authenticated
--   using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);
--
-- create policy own_memories on public.memories
--   for all to authenticated
--   using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);
--
-- create policy own_research_runs on public.research_runs
--   for all to authenticated
--   using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);
