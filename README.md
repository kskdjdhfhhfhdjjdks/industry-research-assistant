# DeepResearch · 多 Agent 行业深度分析助手

> 基于 **显式状态机编排的 9 个专家 Agent**，自动完成「意图路由 → 任务规划 → 网络/本地双源检索 → 证据裁判 → 分析归纳 → 迭代补搜 → 研报撰写 → 质检」，输出**每条结论都带可追溯引用**的深度研究报告。
>
> 前端 Vue 3 + TypeScript，服务端能力由 **Netlify Edge Functions** 提供，向量检索与长期记忆跑在 **Supabase pgvector** 免费层上。**零服务器、零数据库运维，点开链接即可使用。**

---

## 目录

- [一、这个项目解决了什么问题](#一这个项目解决了什么问题)
- [二、架构：为什么把编排放在浏览器](#二架构为什么把编排放在浏览器)
- [三、技术栈](#三技术栈)
- [四、目录结构](#四目录结构)
- [五、本地运行（3 分钟）](#五本地运行3-分钟)
- [六、配置三个免费服务（照着做）](#六配置三个免费服务照着做)
- [七、初始化 Supabase 数据库](#七初始化-supabase-数据库)
- [八、部署到 Netlify](#八部署到-netlify)
- [九、环境变量速查表](#九环境变量速查表)
- [十、简历怎么写 / 面试怎么答](#十简历怎么写--面试怎么答)
- [十一、常见问题](#十一常见问题)
- [十二、已知限制与后续规划](#十二已知限制与后续规划)

---

## 一、这个项目解决了什么问题

行业研究类问题（市场规模、竞争格局、竞品对比、政策解读）有三个特点：**信息分散在多个来源**、**需要交叉验证**、**结论必须可追溯**。

直接让大模型回答，问题很明确：

| 问题 | 表现 |
| --- | --- |
| 幻觉 | 编造数据、机构名、时间，且以专业口吻呈现，极难被发现 |
| 覆盖不全 | 一次性检索无法覆盖需要多跳推理的问题 |
| 无冲突检测 | 把互相矛盾的信息拼接成一个看似合理的结论 |
| 无完备性判断 | 证据不足时不承认，而是继续编 |
| 不可溯源 | 无法核查结论来自哪里 |

本项目的解法是**把研究过程显式建模成一条可审计的流水线**：

- **意图分流**——规则引擎 + 模型双模态判断，闲聊/概念问答走快速回答，研究类问题才进重链路；
- **双源检索**——网络检索（后端可插拔：博查 / Tavily / Serper）与本地知识库（用户导入的研报，pgvector 向量检索）并行召回；
- **证据裁判**——按信源类型打分、去重、标记冲突与证据缺口；
- **迭代补搜**——分析师评估证据完备性，不足则由反思 Agent 生成新检索词回补，最多 N 轮；
- **引用强制校验**——来源编号在检索阶段生成，正文里的非法编号由**代码**剔除，不依赖模型自觉；
- **写后质检**——生成完成后由质检 Agent 做一轮结构化自评，指出无引用支撑的硬结论。

---

## 二、架构：为什么把编排放在浏览器

这是本项目最值得讲的一个工程决策，因为它直接由部署平台的限制倒推出来。

### Netlify 的运行限制（官方文档数值）

| 函数类型 | 执行上限 | 能否流式 |
| --- | --- | --- |
| 同步函数 | 60 s | — |
| **流式函数** | **10 s** | 可以，但总时长受限 |
| Background 函数 | 15 min | **不能流式**，且只返回 202 |
| **Edge Function** | **50 ms CPU**（不含等待网络的时间） | 可以，透传 `ReadableStream` |

一份 3000 字研报的流式生成，很容易超过 10 秒。所以：

- **把编排放在服务端** → 流式函数 10 s 上限会直接截断研报；
- **改用 Background 函数** → 不能流式，用户要盯着一分钟白屏，还需要额外的任务存储与轮询；
- **把编排放在浏览器** → 没有超时限制、没有冷启动、能逐节点实时出进度条。

而 Edge Function 那 50 ms 的 CPU 预算有个关键细节：**官方明确说明等待网络的时间不计入 CPU**。所以只要不做逐帧解析、把上游响应体直接当作自己的响应体返回（零拷贝透传），就能长时间稳定地代理大模型的 SSE 流。

**于是架构就定下来了：**

```
┌──────────────────────── 浏览器（无超时限制）────────────────────────┐
│  Vue 3 SPA                                                          │
│  ├─ StateGraph 引擎（Pregel 超步调度 / 条件边 / 并行扇出与汇合）      │
│  ├─ 9 个 Agent 节点 + 启发式规则层（意图、相关性、域名、评分）        │
│  ├─ 向量化（512 维，特征哈希 / 可选 bge-small-zh 语义模型）          │
│  └─ 流式 Markdown 渲染 · 引用校验 · 流水线可视化                    │
└───────────┬───────────────────────────────┬─────────────────────────┘
            │ POST /api/llm（SSE 透传）      │ POST /api/search
            ▼                               ▼
┌──────────────── Netlify Edge Functions（只放密钥）─────────────────┐
│  llm.ts     零拷贝流式代理 · 服务端密钥不下发                        │
│  search.ts  多后端检索代理 · 统一格式 · 按 URL 去重降噪               │
└───────────┬───────────────────────────────┬─────────────────────────┘
            ▼                               ▼
      LLM 供应商（DeepSeek 等）      检索 API（博查 / Tavily / Serper）
                                        
            浏览器 ──► Supabase（pgvector 向量检索 / 文档 / 长期记忆）
```

**安全模型**：服务端密钥永不随响应下发；当请求未自带密钥时才使用服务端密钥，且此时**强制使用服务端配置的 baseUrl**，忽略客户端传入的地址——避免代理接口被当成「拿我额度请求任意主机」的跳板。访客也可以自带密钥，此时消耗他自己的额度。

### 状态图拓扑

与原 Python 版（LangGraph）完全一致，只多了一个后置质检环节：

```
START → intent ─┬─(direct)──────────────────────► direct_answer ─► END
                └─(multiagent)─► plan ─┬─► web_search ─┐
                                        └─► local_rag  ─┴─► deep_dive ─► analyze
                                                                           │
                          ┌─────────────────(证据不足 / needs_more_research)┤
                          ▼                                                │(证据充分)
                    reflect ─► web_search / local_rag                       ▼
                                                              write ─► critic ─► END
```

引擎实现了 **Pregel 超步（superstep）调度**：同一超步内完成的节点，其出边目标去重后进入下一个超步，因此 `plan` 能并行扇出到 `web_search` 与 `local_rag`，二者完成后**只在下一个超步触发一次** `deep_dive`（隐式 join）。条件边在超步状态合并后求值，所以路由函数能读到本超步刚写入的字段。

---

## 三、技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 前端框架 | Vue 3 + TypeScript + Vite | 组合式 API，`<script setup>` |
| 编排引擎 | 自研 StateGraph（约 150 行） | 对齐 LangGraph 语义，避免引入带 Node 依赖的包 |
| 服务端 | Netlify Edge Functions（Deno） | 密钥隔离 + 流式代理 |
| 模型 | DeepSeek（OpenAI 兼容协议） | 可一键切换到通义千问 / Kimi / OpenAI / 自定义端点 |
| 网络检索 | 博查 Bocha / Tavily / Serper（可插拔） | 默认推荐博查：国内合规、支付宝微信可充值、新账号有免费额度 |
| 向量数据库 | Supabase pgvector（HNSW 索引） | 免费层 500MB |
| 长期记忆 | Supabase 表 + 向量检索 | 语义记忆 + 情景记忆 |
| Markdown | markdown-it | `html: false` 防注入，引用角标后处理 |

---

## 四、目录结构

```
deepresearch-netlify/
├─ netlify/edge-functions/
│  ├─ llm.ts                  # 零拷贝流式代理（服务端密钥 + 访客自带密钥双通道）
│  └─ search.ts               # 多后端检索代理（博查 / Tavily / Serper）
├─ supabase/
│  └─ schema.sql              # pgvector 扩展 / 4 张表 / 2 个检索函数 / RLS 策略
├─ src/
│  ├─ core/
│  │  ├─ types.ts             # ResearchState 与事件类型（对应 state.py）
│  │  ├─ graph.ts             # StateGraph 引擎（Pregel 超步调度）
│  │  ├─ workflow.ts          # 图装配与任务入口（对应 graph.py）
│  │  ├─ nodes.ts             # 9 个 Agent 节点实现（对应 nodes.py）
│  │  ├─ prompts.ts           # 各 Agent system prompt（对应 prompts.py）
│  │  ├─ heuristics.ts        # 意图规则、相关性估算、域名过滤、证据评分
│  │  ├─ llm.ts               # OpenAI 兼容客户端（SSE 解析 / 重试 / 降级）
│  │  ├─ search.ts            # 网络检索客户端
│  │  ├─ embedding.ts         # 双后端向量化（特征哈希 / 语义模型）
│  │  ├─ knowledge.ts         # 本地知识库（切分、索引、pgvector 检索）
│  │  ├─ memory.ts            # 三层记忆（短期 / 语义 / 情景）
│  │  ├─ citations.ts         # 引用校验与参考列表渲染
│  │  ├─ demo.ts              # 演示模式内置语料与「伪模型」
│  │  └─ config.ts / db.ts / markdown.ts / utils.ts
│  ├─ composables/useResearch.ts
│  ├─ components/             # AgentPipeline / KnowledgePanel / SettingsModal
│  └─ App.vue
├─ netlify.toml
└─ package.json
```

---

## 五、本地运行（3 分钟）

```bash
# 1. 安装依赖
npm install

# 2. 纯前端模式：不需要任何密钥即可跑通（自动进入演示模式）
npm run dev
# 打开 http://localhost:5173
```

此时会看到「演示模式」徽标——**这不是假动画**：9 个 Agent 真实依次执行，证据池、引用校验、迭代补搜、质检全部真实运转，只是模型调用与检索结果来自内置样例数据。这样做的目的是让部署出去的链接在任何情况下都能展示完整效果。

要跑真实链路，需要下面三个免费账号。

### 回归测试

项目自带一套不依赖浏览器和测试框架的冒烟测试（用 esbuild 把 TS 入口打成单文件后在 Node 里跑）：

```bash
npm run smoke        # 24 项端到端逻辑断言
npm run smoke:ssr    # 服务端渲染整棵组件树，捕获模板与 ref 解包错误
npm run verify       # 类型检查 + 构建 + 上面两项，提交前一键跑完
```

`npm run smoke` 实际会跑一遍完整流水线并断言这些事：

- 状态图收敛，9 个节点按预期顺序执行（并行扇出后汇合节点每轮只触发一次）
- 迭代补搜真的进入了第二轮（`iteration >= 1`）
- 双源检索都有证据、证据池与来源索引非空
- 每条结论都绑定了真实来源
- 正文里的引用编号全部合法，**没有一个幻觉编号**
- 参考列表被自动拼接、附录与质检评分存在

---

## 六、配置三个免费服务（照着做）

### 1）DeepSeek —— 提供大模型能力

1. 打开 <https://platform.deepseek.com> 注册（手机号即可）
2. 左侧 **API keys** → **创建 API key** → 复制形如 `sk-xxxxxxxx` 的字符串
3. 左侧 **充值** 充 10 元即可（`deepseek-chat` 约 ¥1/百万 token，够跑几百次研究）

> 换其他家也行：代码只认 `baseUrl + apiKey + model`，设置面板里可切换通义千问 / Kimi / OpenAI，或填任意 OpenAI 兼容端点。

### 2）网络检索 —— 三选一，任配一个即可

检索层是**可插拔**的：三家后端实现同一套适配器，用哪个由环境变量决定。
自动探测优先级 **Tavily > 博查 > Serper**；想固定某一家，把 `SEARCH_PROVIDER` 设为 `tavily` / `bocha` / `serper` 即可。

**推荐 · 博查 Bocha（国内合规，不需要国外信用卡）**

1. 打开 <https://open.bochaai.com> 注册（手机号即可）
2. 左侧 **API KEY 管理** → 新建，复制形如 `sk-xxxxxxxx` 的字符串
3. 左侧 **资源包管理** → **购买资源包** → 选「免费试用 1,000 次」→ 确认支付（应付 ¥0.00）
4. 额度用完后可按量续：体验包 1000 次约 ¥3.6，标准包 1000 次 ¥36，支持支付宝/微信

**备选一 · Tavily**（官方定价页明确写着免费版 *No credit card required*，但注册通常要走 Google 账号）

1. 打开 <https://app.tavily.com/home> 注册
2. 首页即可看到 API Key，形如 `tvly-xxxxxxxx`
3. 免费额度每月 1000 次检索，单次研究约消耗 5~8 次

**备选二 · Serper**（返回 Google 搜索结果，注册不需要信用卡）

1. 打开 <https://serper.dev> 注册
2. 首页能看到 API Key，免费额度 2500 次

> **一个实测结论**：网上常见"用公共 SearXNG 实例当零密钥搜索"的建议。我实测了 6 个公共实例（`searx.be`、`priv.au`、`search.inetol.net` 等），**全部不对外开放 JSON 接口**——返回的是 HTML 首页、人机校验页或 429。这条路走不通，别在上面浪费时间。

> 三家都不配也能跑：网络检索会退化成内置演示语料，本地知识库链路不受影响，整条流水线照常执行到底。

### 3）Supabase —— 提供向量数据库与长期记忆

1. 打开 <https://supabase.com/dashboard> → **New project**（Region 选就近，如 Singapore）
2. 等 1~2 分钟初始化完成
3. 左侧 **Project Settings → API**，记下两个值：
   - `Project URL` → 形如 `https://abcdefgh.supabase.co`
   - `anon public` key → 形如 `eyJhbGciOi...`

> `anon key` 是设计上就要暴露给浏览器的（它只是「匿名角色标识」），真正的权限控制在数据库的 RLS 策略里。这是 Supabase 的标准做法。

### 4）写本地 .env（仅本地开发需要）

```bash
cp .env.example .env
```

```ini
DEEPSEEK_API_KEY=sk-你的key

# 检索后端三选一，填哪个就用哪个
BOCHA_API_KEY=sk-你的key        # 博查（推荐，国内可用）
# TAVILY_API_KEY=tvly-你的key   # Tavily
# SERPER_API_KEY=你的key        # Serper
# SEARCH_PROVIDER=bocha          # 可选：强制指定后端

VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

然后：

```bash
npm run dev:netlify     # 首次会自动下载 netlify-cli
```

`netlify dev` 会同时启动 Vite 和 Edge Functions，这样才能真实走通 `/api/llm` 与 `/api/search`。如果只用 `npm run dev`（纯 Vite），没有边缘函数运行时，前端会自动降级为「用你自己填的 key 直连模型」。

---

## 七、初始化 Supabase 数据库

1. Supabase 控制台 → 左侧 **SQL Editor** → **New query**
2. 把 `supabase/schema.sql` 全文粘进去 → 点 **RUN**
3. 看到 `Success. No rows returned` 即可

脚本会创建：

| 对象 | 用途 |
| --- | --- |
| `vector` 扩展 | pgvector，512 维 |
| `documents` | 文档元数据 |
| `knowledge_chunks` | 文档分片 + 向量（本地知识库检索数据源） |
| `memories` | 长期记忆（`semantic` 偏好 / `episodic` 历史任务） |
| `research_runs` | 历史研究任务 |
| `match_knowledge_chunks()` | 知识库向量检索（余弦距离） |
| `match_memories()` | 记忆向量检索 |
| HNSW 索引 | 无需预训练，导入后立即可用 |

> **关于向量维度**：固定 512 维，因为「特征哈希向量」与「bge-small-zh-v1.5」两种后端都输出 512 维，所以切换向量后端不需要改表。
>
> **关于安全**：脚本默认使用「公开演示」策略（任何访客可读写，按 `user_id` 逻辑隔离）。若要真正的多租户隔离，请开启 **Authentication → Anonymous Sign-Ins**，然后改用脚本末尾注释里的「严格策略」（基于 `auth.uid()`）——前端已经实现了匿名登录，无需改代码。

---

## 八、部署到 Netlify

### 1）推到 GitHub

```bash
cd deepresearch-netlify
git init
git add .
git commit -m "feat: 多 Agent 行业深度分析助手（Vue 3 + Netlify Edge Functions + Supabase pgvector）"
git branch -M main
git remote add origin https://github.com/<你的用户名>/deepresearch-multi-agent.git
git push -u origin main
```

> `.gitignore` 已经排除了 `.env`，密钥不会被提交。**务必确认 `git status` 里没有 `.env`。**

### 2）在 Netlify 导入仓库

1. 打开 <https://app.netlify.com> → **Add new site** → **Import an existing project**
2. 选择 **GitHub** → 授权 → 选中刚才的仓库
3. 构建设置会被 `netlify.toml` 自动识别，无需手动改：
   - Build command: `npm run build`
   - Publish directory: `dist`
4. **先别急着 Deploy**，点 **Show advanced** / 部署后再补也行，关键是下面这步。

### 3）配置环境变量

Netlify 站点 → **Site configuration → Environment variables → Add a variable**，逐个添加：

| Key | Value | 是否必填 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | `sk-...` | 必填（否则进演示模式） |
| `BOCHA_API_KEY` | `sk-...` | 可选，**推荐的检索后端** |
| `TAVILY_API_KEY` | `tvly-...` | 可选，检索备选 |
| `SERPER_API_KEY` | `...` | 可选，检索备选 |
| `SEARCH_PROVIDER` | `bocha` / `tavily` / `serper` | 可选，留空则按优先级自动选择 |
| `VITE_SUPABASE_URL` | Supabase Project URL | 可选 |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key | 可选 |
| `LLM_MODEL` | `deepseek-chat` | 可选，默认已是该值 |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | 可选 |

> **检索只需配一个**。三家都填也行，会按 `Tavily > 博查 > Serper` 的顺序自动挑第一个有 key 的。

> 注意 `VITE_` 前缀的两个变量会被打进前端产物（这是 Vite 的约定）。它们本身是公开信息，安全性由数据库 RLS 保证；其余密钥只在 Edge Function 里通过 `Netlify.env.get()` 读取，**不会进入前端产物**。

### 4）部署

加完环境变量后，**Deploys → Trigger deploy → Deploy site**。首次构建约 1~2 分钟。

构建完成后你会拿到形如 `https://xxxx-yyyy.netlify.app` 的地址——这就是可以写进简历的链接。

> ⚠️ **拿到链接后如果打开是 Netlify 登录页（HTTP 401），别去翻构建日志。**
> 这是新版界面把项目可见性默认设成私有了，一行设置就能解开：
> **Project configuration → General → Visitor access → Project visibility → Edit visibility → `Public` → Save**。
> 详见第十一章 FAQ 中「部署成功了，但打开站点只看到一个 Netlify 登录页」。

### 5）（可选）自定义域名

**Domain management → Add a domain**，可以用 `项目名.netlify.app` 改一个更清爽的子域名，或者绑定自己的域名。

---

## 九、环境变量速查表

```ini
# ---- 服务端（Edge Function 读取，不进前端产物）----
DEEPSEEK_API_KEY=          # 必填，模型密钥
LLM_BASE_URL=              # 可选，默认 https://api.deepseek.com/v1
LLM_MODEL=                 # 可选，默认 deepseek-chat

BOCHA_API_KEY=             # 可选，网络检索（推荐：国内合规，支付宝/微信可充值）
TAVILY_API_KEY=            # 可选，网络检索（国际，注册常需 Google 账号）
SERPER_API_KEY=            # 可选，网络检索（Google 结果，备用）
SEARCH_PROVIDER=           # 可选，强制指定 tavily / bocha / serper

# ---- 前端（构建期注入，公开信息）----
VITE_SUPABASE_URL=         # 可选
VITE_SUPABASE_ANON_KEY=    # 可选
```

---

## 十、简历怎么写 / 面试怎么答

### 简历条目（可直接改写）

> **DeepResearch · 多 Agent 行业深度分析助手**　（在线演示：https://your-site.netlify.app）
>
> **技术栈**：Vue 3 · TypeScript · Netlify Edge Functions · Supabase pgvector · DeepSeek · 博查 Bocha · Vite
>
> **项目描述**：面向行业研究场景，解决传统单轮大模型问答"幻觉、覆盖不全、不可溯源"的问题。设计并实现 9 个专家 Agent 的显式状态机协作流水线，自动完成意图路由、双源检索、证据审计、迭代补搜与带引用研报生成。
>
> **核心工作**：
> 1. **自研 StateGraph 编排引擎**：用约 150 行实现 Pregel 超步调度，支持条件边、并行扇出与隐式汇合；`plan` 节点并行触发网络/本地两路检索，完成后仅触发一次证据裁判，检索阶段耗时显著下降。
> 2. **平台限制驱动的架构决策**：针对 Netlify 同步函数 60s、流式函数 10s 的执行上限，将编排下沉至浏览器，服务端仅用 Edge Function 做「零拷贝流式代理」（利用其 50ms CPU 预算不含 I/O 等待的特性透传 SSE），既规避超时又实现密钥零暴露。
> 3. **引用幻觉防控**：来源编号在检索阶段由代码生成并贯穿全链路，生成后用正则校验剔除非法引用，参考列表仅渲染正文真实出现过的编号，本地来源按文档去重。
> 4. **双源检索与证据审计**：网络检索与 pgvector 本地知识库并行召回，按信源类型分层评分（官方/主流媒体/普通站点/来源缺失），输出冲突与缺口审计标记。
> 5. **三层记忆**：短期会话记忆（滚动摘要压缩）、语义偏好记忆、情景任务记忆，统一在整图执行前注入 `[跨会话记忆]` 上下文。
> 6. **成本治理**：在检索阶段用代码而非模型完成信息剪枝（截断 + 结构化），节点间只传结构化字段，实测大幅降低 token 消耗，同时因上下文更干净而提升输出质量。

### 面试高频追问速答

**Q：为什么不用 LangGraph 的 JS 版，而要自己写状态机？**
A：三个原因。一是浏览器场景只需要「节点 + 静态边 + 条件边 + 并行超步」这四件事，自研约 150 行可读性远好过引入一个带 Node 依赖的包；二是需要把节点执行过程暴露成细粒度事件给前端做流水线可视化，自研引擎可以精确控制事件粒度；三是这段代码本身就是我对 Pregel 超步调度理解的证明，面试时能讲清楚"为什么并行扇出后汇合节点只会触发一次"。

**Q：为什么把编排放在前端？这不是把逻辑暴露了吗？**
A：这是被平台限制倒推的决策。Netlify 流式函数 10 秒上限会截断长研报，Background 函数不能流式。放在浏览器有两个收益：没有超时限制、能逐节点实时展示进度。暴露的只是编排逻辑，不含任何密钥——密钥全在 Edge Function 的环境变量里。真实产品如果部署在支持长连接的平台上（如容器 / Railway / Fly.io），编排层可以直接搬到服务端，因为节点实现与图定义是完全独立于运行环境的。

**Q：模型为什么不会编造引用编号？**
A：不指望它自觉。四道闸门：来源编号在检索阶段由代码生成；Writer 的 prompt 里给出合法编号白名单；生成后正则扫描正文，非法编号直接从正文剔除；参考列表只渲染正文真实出现过的编号。这样即使模型编了 `[WEB9_9-9]`，读者也永远看不到。

**Q：向量检索用的什么方案？为什么选 512 维？**
A：Supabase pgvector + HNSW 索引。维度选 512 是因为实现了两个可切换的向量后端——默认的「特征哈希向量」（字符/词 n-gram 的 signed hashing + L2 归一化，零依赖零下载、可离线）和可选的「bge-small-zh-v1.5」语义模型（CDN 懒加载）。两者都是 512 维，所以数据库表结构不用改，而且模型下载失败时会自动降级，保证检索链路永远可用。

**Q：检索层为什么做成可插拔的？**
A：因为检索 API 是最容易被外部因素卡住的一环——国际服务大多要求国外信用卡才能注册，某些服务对国内网络也不友好。我把三家（博查 / Tavily / Serper）收敛成同一套适配器接口，差异（请求参数名、响应字段名、有没有相关性打分、时效字段叫什么）全部封在各自的适配函数里，对外只暴露统一的 `{title, url, content, published_date, score}`。后端由环境变量决定，自动探测也可强制指定，切后端不需要改任何业务代码。顺带在服务端做了按规范化 URL 去重，同一篇文章被不同引擎重复返回时只留分数更高的那条。

**Q：那你是怎么选默认后端的？**
A：先验证再选，不凭印象。Tavily 官方定价页明确写了免费版 *No credit card required*，所以"国际服务一定要卡"这个假设本身不成立；但注册链路通常要走 Google 账号，对部分开发者仍是障碍。公共 SearXNG 实例曾被考虑作为"零密钥"方案，我实测了 6 个公共实例，全部不对外开放 JSON 接口（返回 HTML、人机校验页或 429），因此排除——不能把一个上线就废的功能写进方案。最终默认推荐博查：国内合规、支付宝/微信可充值、新账号有免费额度，工程风险最低。

**Q：你怎么量化效果？**
A：把指标定义清楚比跑数字更重要。四个可回归的指标：幻觉率（无来源支撑的结论占比）、引用准确率（引用指向的来源确实支撑该结论的比例）、证据覆盖率（子问题被证据覆盖的比例）、任务完备率（无需人工补搜即可回答全部子问题的比例）。这些指标在界面的运行统计与附录里都能直接看到。

---

## 十一、常见问题

**Q：部署后右上角一直显示「演示模式」？**
A：说明 Edge Function 没读到 `DEEPSEEK_API_KEY`。检查两点：环境变量是否添加到了**当前站点**（不是 Team 级），以及添加后是否**重新部署过**——环境变量在部署时注入，改完必须重新 deploy。

**Q：报 401 / missing_key**
A：同上。若你希望在演示模式之外使用自己的 key，点右上角「设置」填入 API Key，前端会自动降级为直连供应商。

**Q：部署成功了，但打开站点只看到一个 Netlify 登录页（HTTP 401 / Login Redirect）**
A：这是**部署阶段最容易卡住的一个坑，且与代码无关**——Netlify 把项目可见性设成了私有，访客必须登录 Netlify 才能打开站点。

先确认是不是这个问题：`curl -sD - -o /dev/null https://你的站点.netlify.app`，若返回 **401**，且 HTML 源码里出现跳转地址 `app.netlify.com/edge-access`，就是它。

修复路径（Credit-based Free / Personal / Pro 计划的新版界面，叫「项目可见性」）：

> **Project configuration → General → Visitor access → Project visibility → Edit visibility → 选 `Public` → Save**

如果菜单里显示的是旧版 `Password Protection`（Enterprise / Open Source / 旧计划），则走：

> **Project configuration → Access & security → Visitor access → Password Protection → Configure Password Protection → 取消保护**

顺手把**团队级默认值**也改掉，否则以后每新建一个项目都会是私有的：

> **Team settings → Access & security → Visitor access → Default project visibility → `Public`**

两个注意点：

- **改完不需要重新部署**，这个设置是即时生效的。如果浏览器里仍是登录页，用**无痕窗口**验证——你自己已登录 Netlify，登录态会掩盖问题。
- 旧版界面选项与新版的对应关系：`No protection settings → Public`、`Basic protection → Password`、`Team protection → Private`。

> 排查思路值得记一下：先判断站点**是否存在**（404 = 域名没占用，401 = 站点存在但被拦），再看 401 的**响应体**指向哪里。`edge-access` 说明是访问控制，而不是构建失败——这一步区分开了"部署问题"和"权限问题"，避免去翻构建日志。

**Q：设置面板里检索代理显示「未配置」，会怎样？**
A：说明服务端三个检索 key 一个都没配。**博查 / Tavily / Serper 任配一个即可**，配完重新部署一次。三家都不配也不影响主流程——`web_search` 节点会自动切到内置演示语料，本地知识库链路照常工作，整条流水线仍然完整执行到底。

**Q：我在国内，注册不了需要国外信用卡的检索服务怎么办？**
A：直接用博查（<https://open.bochaai.com>），国内手机号注册，支持支付宝/微信，新账号能领免费额度，见第六章第 2 节。代码层面不需要任何改动——检索后端是靠环境变量切换的。

**Q：本地 `npm run dev` 提示 `/api/llm` 404**
A：纯 Vite 模式没有边缘函数运行时，属预期行为。用 `npm run dev:netlify` 即可；或在设置里填入自己的 API Key，前端会自动直连。

**Q：本地知识库检索没有结果**
A：先在左下角「本地知识库」里上传或粘贴一份文档（也可以点「导入示例」），索引建立后「本地检索」节点才有数据源。另外，即使没有本地文档，网络检索这条链路依然独立可用。

**Q：语义向量开关打开了但很慢**
A：首次开启会从 CDN 下载约 25MB 的量化模型，之后走浏览器缓存。若网络不可达会自动降级为特征哈希向量，功能不受影响。

**Q：免费额度会不会被刷爆？**
A：站点公开时建议在 DeepSeek 控制台设置**用量上限**，并在 Supabase 关注免费额度。演示模式的存在意义就是即使额度耗尽，链接也依然能展示完整效果。

---

## 十二、已知限制与后续规划

| 限制 | 说明 | 后续方案 |
| --- | --- | --- |
| 公开演示站的 RLS 较宽松 | 按 `user_id` 逻辑隔离，服务端不强制校验 | 开启 Anonymous Sign-Ins + 严格策略（SQL 已备好，前端已支持） |
| 浏览器端编排无法隐藏逻辑 | 属于架构取舍 | 需要私有化时把 `src/core` 整体搬到 Node 运行时，节点实现无需改动 |
| 文档仅支持纯文本类格式 | `.txt / .md / .csv` | 接入 PDF 解析（pdfjs）与切分层 |
| 图谱类分析能力缺失 | 目前是段落级证据，未做实体关系抽取 | 增加实体归一化 + 关系抽取节点 |

---

## 许可

仅用于学习与个人项目展示。
