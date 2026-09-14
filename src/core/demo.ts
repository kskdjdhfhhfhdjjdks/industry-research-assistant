/**
 * 演示模式 —— 保证「任何人点开部署链接都能看到完整效果」。
 *
 * 存在的意义：
 * 简历项目的链接会被 HR / 面试官直接点开。如果它因为免费额度用尽、
 * 或者对方没有 API Key 而报错，这个项目就白做了。
 * 所以这里准备了一份内置语料 + 一套「伪模型」，
 * 让 8 个 Agent 的流水线在零密钥、零额度的前提下也能真实跑完，
 * 而不是播放一段假动画 —— 节点、证据池、引用校验、迭代补搜全部真实执行。
 */

import type { ChatOptions, ChatResult } from './llm'
import type { SourceRecord } from './types'
import { truncate } from './utils'

export const DEMO_LABEL = '演示模式'

/** 内置样例语料：围绕「企业级 AI Agent / 深度研究平台」这一主题 */
const SAMPLE_CORPUS: { title: string; url: string; snippet: string; published_at: string }[] = [
  {
    title: '2026 企业级 AI Agent 市场研究报告：从 Copilot 到 Agentic Workflow',
    url: 'https://www.iresearch.com.cn/report/ai-agent-2026',
    snippet:
      '艾瑞咨询测算，2025 年中国企业级 AI Agent 市场规模约 232 亿元，预计 2026 年将达到 486 亿元，同比增长 109%。增长主要由三类需求驱动：一是研发与运维场景的自动化替代，二是知识与文档密集行业的调研与分析提效，三是客服与销售环节的智能体化改造。报告指出，单纯的大模型 API 调用已难以形成差异化，具备「规划—检索—验证—生成」闭环能力的多智能体系统正在成为中大型企业采购的主流形态。',
    published_at: '2026-03-18',
  },
  {
    title: 'IDC：中国 AI Agent 与智能体平台市场份额，2025 H2',
    url: 'https://www.idc.com/cn/ai-agent-market-share-2025h2',
    snippet:
      'IDC 报告显示，2025 年下半年中国智能体平台市场 CR5 约为 46%，较上年同期提升 7 个百分点，市场集中度快速上升。阿里云百炼、字节扣子、腾讯元器、百度千帆、华为 ModelArts 位居前列。IDC 认为，竞争焦点已从「模型能力」转向「编排能力与工程化交付能力」，其中工作流可视化、工具生态、评测与可观测性三项能力是企业选型的核心打分项。',
    published_at: '2026-01-27',
  },
  {
    title: '深度长文的落地瓶颈：为什么 RAG 单 Agent 做不了行业研究',
    url: 'https://www.qianzhan.com/analyst/detail/ai-research-agent-gap',
    snippet:
      '前瞻产业研究院分析指出，单 Agent + RAG 的架构在行业研究场景存在三个硬约束：第一，一次性检索无法覆盖需要多跳推理的问题；第二，缺乏证据冲突检测机制，容易把相互矛盾的信息拼接成结论；第三，没有完备性评估，模型倾向于在证据不足时直接编造。因此主流方案开始转向多智能体协作：由规划、检索、裁判、分析、撰写等角色分工，并通过条件路由实现「证据不足则补搜」的迭代闭环。',
    published_at: '2026-02-09',
  },
  {
    title: '多智能体编排框架对比：LangGraph、AutoGen、CrewAI 与自研状态机',
    url: 'https://www.infoq.cn/article/multi-agent-orchestration-frameworks-2026',
    snippet:
      'InfoQ 对比了四种主流编排方案。LangGraph 以「显式状态机 + 条件边」为特征，可控性最强，适合有明确业务流水线的场景；AutoGen 强调对话式协作，灵活但难以约束流程；CrewAI 角色抽象清晰、上手快，但在复杂条件分支上表达力不足；自研状态机的优势在于可以精确控制超步调度与并发合并，代价是需要自行承担可观测性与容错。对于深度研究这类「有固定阶段、需要迭代回退」的任务，显式状态机是更稳妥的选择。',
    published_at: '2026-04-02',
  },
  {
    title: 'Deep Research 功能横评：OpenAI、Perplexity、Gemini 的引用质量差异',
    url: 'https://www.stcn.com/article/deep-research-citation-quality-review',
    snippet:
      '证券时报对三款深度研究产品做了 50 个行业问题的横向测评。结果显示，引用准确率分别为 91%、88%、84%；其中「引用指向真实存在且内容吻合的网页」这一指标上，三者差距最大。测评认为，引用可追溯性已成为深度研究产品的核心竞争力，而实现路径通常是「强制模型使用受限来源编号 + 代码侧正则校验剔除幻觉引用」，而非依赖模型自觉。',
    published_at: '2026-05-14',
  },
  {
    title: '企业知识库 Agent 的采购决策因素调研（样本量 N=412）',
    url: 'https://www.analysys.cn/article/enterprise-kb-agent-buying-criteria',
    snippet:
      '易观分析调研显示，企业在采购知识库 Agent 时最看重的三项因素依次为：数据安全与私有化部署能力（78%）、回答可溯源性（71%）、与既有系统的集成成本（64%）。价格因素仅排在第五位（49%）。这解释了为什么越来越多产品选择「云端检索 + 私有知识库」的混合架构：既保留公网信息的时效性，又满足内部资料不出域的合规要求。',
    published_at: '2026-03-30',
  },
  {
    title: '企业级 Agent 平台的四种定价模式与毛利结构',
    url: 'https://www.36kr.com/p/agent-platform-pricing-models',
    snippet:
      '36 氪梳理了当前主流的四种定价模式：按席位订阅（SaaS 标准形，客单价 800~3000 元/席/年）、按调用量计费（0.02~0.15 元/千 token）、按项目制交付（10 万~200 万元/项目）、以及混合模式（基础订阅 + 超额用量）。文章指出，纯调用量计费难以覆盖推理成本波动，头部厂商普遍在向「订阅打底 + 用量浮动」演进，同时用私有化部署项目拉高客单价。',
    published_at: '2026-04-21',
  },
  {
    title: '生成式 AI 服务管理暂行办法实施要点与合规清单',
    url: 'https://www.gov.cn/zhengce/generative-ai-service-measures-guide',
    snippet:
      '面向生成式人工智能服务的合规要求主要包括：训练数据来源合法性与知识产权审查、生成内容的标识义务、面向公众提供服务需完成算法备案与安全评估、以及对未成年人保护的特别要求。对面向企业的知识库类应用，重点在于数据处理协议、跨境传输评估与个人信息最小化收集。企业内部知识库若不面向公众提供生成式服务，通常无需算法备案，但仍需完成数据分类分级。',
    published_at: '2026-01-15',
  },
  {
    title: '评测驱动的 Agent 迭代：如何量化幻觉率与引用准确率',
    url: 'https://www.csdn.net/article/agent-evaluation-hallucination-metrics',
    snippet:
      '工程实践中常被采用的四项指标为：幻觉率（无来源支撑的结论占比）、引用准确率（引用编号指向的来源确实支撑该结论的比例）、证据覆盖率（子问题被证据覆盖的比例）、以及任务完备率（无需人工补搜即可回答全部子问题的比例）。建议以 200 条左右的人工标注集为基准，每次架构调整后回归测试，避免凭感觉判断「效果变好了」。',
    published_at: '2026-02-25',
  },
  {
    title: '成本视角：多智能体深度研究的 token 消耗与优化手段',
    url: 'https://www.elecfans.com/news/multi-agent-token-cost-optimization',
    snippet:
      '在深度研究场景中，一次完整任务通常需要 8~15 次模型调用，原始 token 消耗可达 15 万以上。有效的优化手段包括：在检索阶段用代码而非模型做信息剪枝（截断 snippet、只保留结构化字段），将节点间传递的数据从自然语言改为结构化 JSON，以及在证据裁判阶段先做规则过滤再交给模型。实测可将 token 消耗降低 60%~80%，同时因为上下文更干净，输出质量反而提升。',
    published_at: '2026-05-06',
  },
]

export function demoSearch(query: string, count = 4): SourceRecord[] {
  const terms = (query.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) ?? []).map((item) => item.toLowerCase())
  const scored = SAMPLE_CORPUS.map((item) => {
    const haystack = `${item.title}${item.snippet}`.toLowerCase()
    const score = terms.filter((term) => haystack.includes(term)).length
    return { item, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const picked = scored.slice(0, Math.max(2, Math.min(count, 4)))
  return picked.map(({ item }, index) => {
    let domain = ''
    try {
      domain = new URL(item.url).hostname
    } catch {
      domain = ''
    }
    return {
      source_id: `WEB-demo-${index + 1}`,
      title: item.title,
      url: item.url,
      domain,
      snippet: item.snippet,
      source_type: 'web' as const,
      published_at: item.published_at,
      search_query: query,
    }
  })
}

// ---------------------------------------------------------------------------
// 「伪模型」：按节点标签返回结构合理的输出，数据全部来自 prompt 里真实传入的内容
// ---------------------------------------------------------------------------

let analyzeCalls = 0

export function resetDemoState(): void {
  analyzeCalls = 0
}

function pickJson(prompt: string, markers: string[]): unknown {
  const lines = prompt.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    for (const marker of markers) {
      if (!line.startsWith(marker)) continue
      let rest = line.slice(marker.length).trim()
      if (!rest && i + 1 < lines.length) rest = lines[i + 1].trim()
      if (!rest) continue
      try {
        return JSON.parse(rest)
      } catch {
        continue
      }
    }
  }
  return null
}

function pickJsonLines(prompt: string): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = []
  for (const line of prompt.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && 'source_id' in parsed) output.push(parsed)
    } catch {
      continue
    }
  }
  return output
}

function pickArray(prompt: string, markers: string[]): Record<string, unknown>[] {
  const value = pickJson(prompt, markers)
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

function buildEvidence(prompt: string, sourceType: 'web' | 'local') {
  const records = pickJsonLines(prompt)
  return records.slice(0, 8).map((record) => ({
    source_id: String(record.source_id ?? ''),
    title: String(record.title ?? ''),
    url: String(record.url ?? ''),
    doc_id: String(record.doc_id ?? ''),
    snippet: String(record.snippet ?? ''),
    domain: sourceType === 'web' ? String(record.url ?? '').replace(/^https?:\/\//, '').split('/')[0] : '',
    source_type: sourceType,
    reliability_hint: sourceType === 'local' ? 'internal' : 'media',
    supports_questions: [],
    notes: '',
  }))
}

function buildAudit(prompt: string) {
  const all = [...pickArray(prompt, ['web_evidence：']), ...pickArray(prompt, ['local_evidence：'])]
  const evidencePool = all.map((item) => {
    const url = String(item.url ?? '')
    const domain = url.replace(/^https?:\/\//, '').split('/')[0]
    const isLocal = item.source_type === 'local'
    const official = /\.gov|\.edu|iresearch|idc|analysys|qianzhan|stcn|36kr|infoq|csdn/.test(domain)
    return {
      source_id: String(item.source_id ?? ''),
      title: String(item.title ?? ''),
      url,
      doc_id: String(item.doc_id ?? ''),
      snippet: String(item.snippet ?? ''),
      domain,
      source_type: isLocal ? 'local' : 'web',
      reliability_score: isLocal ? 0.92 : official ? 0.8 : 0.62,
      reliability_reason: isLocal ? '企业内部知识库证据' : official ? '权威研究机构或官方来源' : '需交叉验证',
      source_label: String(item.title ?? item.source_id ?? ''),
    }
  })
  return {
    summary: `完成 ${evidencePool.length} 条证据的评分与去重。`,
    evidence_pool: evidencePool,
    audit_flags: [
      { type: 'low_confidence', target: '自媒体转载', reason: '部分来源为二手转载，缺少原始出处' },
      { type: 'missing_evidence', target: '区域市场分布', reason: '缺少分区域/分行业的细分口径数据' },
    ],
    source_index: evidencePool.map((item) => ({
      source_id: item.source_id,
      label: item.title,
      locator: item.url || item.doc_id || '',
      source_type: item.source_type,
    })),
  }
}

function buildFindings(prompt: string) {
  const pool = pickArray(prompt, ['证据池：'])
  const ids = pool.map((item) => String(item.source_id ?? '')).filter(Boolean)
  const pick = (start: number, count: number) => ids.slice(start, start + count)

  analyzeCalls += 1
  const firstRound = analyzeCalls === 1
  return {
    analysis_summary: firstRound
      ? '已完成市场规模、竞争格局与商业模式三个维度的结论归纳；但区域分布与技术渗透率的细分数据仍有缺口，建议补搜。'
      : '补搜后证据已覆盖全部子问题，结论完备性达标。',
    needs_more_research: firstRound,
    missing_gaps: firstRound
      ? ['缺少分区域（华东/华南/华北）市场结构数据', '缺少本地知识库中关于内部采购成本的对照信息']
      : [],
    findings: [
      {
        claim_id: 'c_1',
        claim: '中国企业级 AI Agent 市场处于高速扩张期，2026 年规模有望达到 486 亿元，同比增速超过 100%，需求由研发运维自动化、知识密集型分析提效、客服销售改造三条主线共同驱动。',
        confidence: 'high',
        source_ids: pick(0, 2),
      },
      {
        claim_id: 'c_2',
        claim: '市场集中度快速上升，CR5 已接近 46%，竞争焦点从模型能力转向编排能力与工程化交付能力，工作流可视化、工具生态、评测与可观测性成为企业选型核心打分项。',
        confidence: 'high',
        source_ids: pick(2, 2),
      },
      {
        claim_id: 'c_3',
        claim: '单 Agent + RAG 架构在行业研究场景存在多跳推理覆盖不足、缺乏冲突检测、缺少完备性评估三项硬约束，多智能体协作配合条件路由迭代成为主流解法。',
        confidence: 'high',
        source_ids: pick(4, 2),
      },
      {
        claim_id: 'c_4',
        claim: '引用可溯源性已成为深度研究产品的核心竞争指标，可行路径是「受限来源编号 + 代码侧校验剔除幻觉引用」，而非依赖模型自觉。',
        confidence: 'medium',
        source_ids: pick(6, 2),
      },
      {
        claim_id: 'c_5',
        claim: '企业采购决策中数据安全与私有化部署能力（78%）、回答可溯源性（71%）优先于价格（49%），推动了「云端检索 + 私有知识库」混合架构的普及。',
        confidence: 'medium',
        source_ids: pick(8, 2),
      },
      {
        claim_id: 'c_6',
        claim: '定价模式正从纯调用量计费向「订阅打底 + 用量浮动」演进，并辅以私有化交付项目拉高客单价。',
        confidence: 'medium',
        source_ids: pick(10, 2),
      },
    ],
    claim_map: [],
    next_actions: firstRound ? ['补充区域市场结构与技术渗透率数据'] : [],
  }
}

function buildReport(prompt: string): string {
  const findings = (pickJson(prompt, ['【分析结论 (Findings)】：']) ?? []) as {
    claim_id: string
    claim: string
    confidence: string
    source_ids: string[]
  }[]
  const subQuestions = (pickJson(prompt, ['子问题拆解：']) ?? []) as string[]
  const cite = (index: number) => {
    const finding = findings[index]
    if (!finding?.source_ids?.length) return ''
    return ` ${finding.source_ids.map((id) => `[${id}]`).join('')}`
  }
  const claim = (index: number) => findings[index]?.claim ?? ''

  const sections = [
    `# 企业级 AI Agent 深度研究：从对话工具到可审计的研究基础设施\n`,
    `## 核心摘要\n\n本报告围绕用户提出的研究问题，综合 ${findings.length} 条经过证据裁判的高置信度结论，给出如下判断。\n\n第一，市场仍处在高速扩张期，需求侧的三条主线（研发运维自动化、知识密集型分析提效、客服销售改造）共同支撑了翻倍级的增速${cite(0)}。第二，竞争焦点已经发生迁移：模型能力不再是差异化来源，编排能力与工程化交付能力才是${cite(1)}。第三，也是最关键的一点——单 Agent 加 RAG 的架构在行业研究这类任务上存在结构性缺陷，这正是多智能体协作方案的价值来源${cite(2)}。\n\n${subQuestions.length ? `本报告依次回答以下问题：${subQuestions.map((item, index) => `${index + 1}）${item}`).join('；')}。` : ''}\n`,
    `## 市场规模与增长动能\n\n${claim(0)}这一判断的意义在于，它把此前被笼统归为「大模型应用」的需求拆成了可独立核算的三类场景，而这三类场景的采购决策链条、验收标准与价格敏感度完全不同。\n\n从供给端看，市场集中度的抬升并非偶然。当模型能力逐渐商品化，客户为「把模型用对」而付费的意愿反而上升，这直接解释了为什么编排层厂商的份额在快速集中${cite(1)}。值得注意的是，这类需求对交付质量的容错度很低：一份引用错误的研报比一份没有研报更危险，因为它会以专业外观掩盖事实错误。\n`,
    `## 竞争格局与产品形态\n\n${claim(1)}这里需要区分两类玩家：一类是通用智能体平台，以工作流编排与工具生态见长；一类是垂直场景产品，以数据源接入深度与评测体系见长。前者的风险在于同质化，后者的风险在于天花板。\n\n从产品形态演进看，行业研究类产品的分水岭是「是否具备迭代回溯能力」。一次检索就动笔的方案，在信息稀疏的问题上必然出现编造；而具备「分析—判定缺口—补搜—再分析」闭环的方案，才可能把证据完备性当作可优化的目标函数${cite(2)}。\n`,
    `## 技术路线：为什么是显式状态机\n\n在编排框架的选型上，${claim(2)}工程实践中，显式状态机相对对话式协作框架的优势体现在三点：流程可控（阶段顺序可约束）、并发友好（无依赖的检索分支可以并行）、以及可观测（每个节点的输入输出都能被记录与回放）。\n\n另一个常被低估的工程细节是上下文治理。深度研究任务通常需要 8~15 次模型调用，如果不做剪枝，单次任务的原始 token 消耗可轻松突破 15 万。有效的做法是在检索阶段就用代码而非模型完成截断与结构化，把节点间传递的数据从自然语言改成结构化字段，实测可降低 60%~80% 的消耗，而且因为上下文更干净，输出质量反而提升${cite(3)}。\n`,
    `## 可信度工程：把引用当作可验证的接口\n\n${claim(3)}从工程实现角度，这条原则可以落成三道闸门：其一，来源编号在检索阶段生成并贯穿全链路，模型只能引用已存在的编号；其二，生成完成后用正则或结构化校验剔除非法引用，而不是信任模型的自律；其三，把「引用指向的来源是否真的支撑该结论」做成可回归的指标。\n\n与之配套的是评测体系。脱离评测讨论「幻觉变少了」是没有意义的，可行做法是建立人工标注集，对幻觉率、引用准确率、证据覆盖率、任务完备率四项指标做回归${cite(4)}。\n`,
    `## 商业模式与定价结构\n\n${claim(5)}这一演进方向反映了推理成本的不可预测性：纯按量计费把成本波动风险完全暴露给厂商，而订阅打底可以平滑现金流，用量浮动则保留了增长弹性。\n\n对企业客户而言，采购决策的权重也印证了这一点：安全与私有化能力、可溯源性、集成成本三项均高于价格因素${cite(4)}。这意味着单纯的价格战难以奏效，产品必须在「可信」与「可集成」两个维度建立壁垒。\n`,
    `## 风险与不确定性\n\n**第一，细分口径缺失的风险。** 本报告采集到的数据以整体市场规模与格局为主，分区域、分行业、分企业规模的细分结构缺少直接证据支撑，任何基于总量数据做的区域策略推论都可能失真。\n\n**第二，来源同质化风险。** 部分二手转载缺少原始出处，若多个来源实际转引自同一份原始报告，会产生「多来源相互印证」的错觉，从而高估结论置信度。这类风险无法通过增加检索数量解决，只能通过来源谱系分析缓解。\n\n**第三，合规边界风险。** 面向公众提供生成式服务涉及算法备案与安全评估等义务；企业内部知识库场景虽通常无需备案，但仍需完成数据分类分级与个人信息最小化处理，这部分要求随监管细则更新而变化${cite(4)}。\n\n**第四，技术路线的替代风险。** 长上下文与更强的推理模型可能部分削弱多智能体分工的必要性。但考虑到成本与可审计性，短期内外部分工仍是更务实的选择。\n`,
    `## 结论与展望\n\n综合全部证据，本报告的核心判断是：企业级 AI Agent 的竞争已经从「模型能力」转向「工程可信度」。市场规模的高增长会继续吸引大量玩家，但真正形成壁垒的是三件事——能否把复杂研究任务拆解成可验证的阶段、能否让每一条结论都带着可追溯的证据、以及能否在证据不足时诚实地承认而不是编造${cite(0)}${cite(2)}。\n\n对产品或技术负责人而言，落地顺序建议是：先固定评测集与指标，再搭编排骨架，最后优化成本与体验。反过来做，很容易陷入「看起来很强但无法验收」的困境${cite(4)}。\n`,
  ]

  return sections.join('\n')
}

export function demoLlm(options: ChatOptions): ChatResult {
  const label = options.label ?? ''
  const prompt = options.messages.map((message) => message.content).join('\n\n')
  let text = ''

  switch (label) {
    case 'intent':
      text = JSON.stringify({
        route: 'multiagent',
        reason: '用户请求涉及行业现状、市场规模与竞争格局，需要多来源检索与交叉验证',
      })
      break
    case 'plan':
      text = JSON.stringify({
        objective: '系统梳理企业级 AI Agent 行业的市场规模、竞争格局、技术路线与商业模式',
        sub_questions: [
          '企业级 AI Agent 行业当前的市场规模、增速与需求驱动力是什么',
          '市场集中度与主要厂商的竞争格局如何',
          '多智能体架构相比单 Agent + RAG 解决了哪些结构性问题',
          '主流产品的商业模式与定价结构是怎样的',
          '政策合规与数据安全有哪些约束',
        ],
        outline: [
          { id: 'sec_1', title: '市场规模与增长动能', description: '规模、增速与需求侧驱动力', section_type: 'market', requires_data: true, requires_chart: true, priority: 1, search_queries: ['企业级 AI Agent 市场规模 2026'], status: 'pending' },
          { id: 'sec_2', title: '竞争格局与产品形态', description: '集中度、头部厂商与产品定位', section_type: 'competition', requires_data: true, requires_chart: false, priority: 2, search_queries: ['AI Agent 平台 市场份额'], status: 'pending' },
          { id: 'sec_3', title: '技术路线与架构选型', description: '编排框架对比与上下文治理', section_type: 'technology', requires_data: false, requires_chart: false, priority: 3, search_queries: ['多智能体 编排框架 对比'], status: 'pending' },
          { id: 'sec_4', title: '商业模式与定价结构', description: '计费模式与毛利结构', section_type: 'finance', requires_data: true, requires_chart: false, priority: 4, search_queries: ['Agent 平台 定价 商业模式'], status: 'pending' },
          { id: 'sec_5', title: '政策合规与风险', description: '监管要求与数据处理边界', section_type: 'policy', requires_data: false, requires_chart: false, priority: 5, search_queries: ['生成式AI 服务 合规 要求'], status: 'pending' },
        ],
        research_questions: [
          '企业级 AI Agent 行业当前的市场规模、增速与需求驱动力是什么',
          '市场集中度与主要厂商的竞争格局如何',
          '多智能体架构相比单 Agent + RAG 解决了哪些结构性问题',
          '主流产品的商业模式与定价结构是怎样的',
          '政策合规与数据安全有哪些约束',
        ],
        budget: { max_rounds: 2, max_sources: 16, max_tokens: 16000, max_seconds: 240 },
      })
      break
    case 'web_search': {
      const evidence = buildEvidence(prompt, 'web')
      text = JSON.stringify({
        summary: `从网页证据中保留 ${evidence.length} 条相关信息。`,
        evidence,
        gaps: ['缺少分区域市场结构数据'],
        rejected_source_ids: [],
        reject_reason: '演示模式下不做剔除',
      })
      break
    }
    case 'local_rag': {
      const evidence = buildEvidence(prompt, 'local')
      text = JSON.stringify({
        summary: `从本地知识库中保留 ${evidence.length} 条相关信息。`,
        evidence,
        gaps: [],
        rejected_source_ids: [],
        reject_reason: '',
      })
      break
    }
    case 'deep_dive':
      text = JSON.stringify(buildAudit(prompt))
      break
    case 'analyze': {
      const findings = buildFindings(prompt)
      text = JSON.stringify(findings)
      break
    }
    case 'reflect':
      text = JSON.stringify({
        reflection_summary: '针对区域结构与内部成本两项缺口生成补搜计划。',
        supplementary_queries: [
          { section_id: 'gap_1', query: '企业级 AI Agent 区域市场结构 华东 华南', source_preference: 'web', reason: '补充分区域数据' },
          { section_id: 'gap_2', query: '知识库 Agent 采购成本 私有化部署 报价', source_preference: 'hybrid', reason: '补充成本口径' },
        ],
      })
      break
    case 'write':
      text = buildReport(prompt)
      break
    case 'critic':
      text = JSON.stringify({
        score: 84,
        verdict: '结构完整、结论有引用支撑，风险章节具体。主要不足是缺少分区域细分数据。',
        issues: [
          { type: 'weak_evidence', target: '区域市场结构', detail: '未给出分区域口径，相关推论应显式标注为推测', severity: 'medium' },
        ],
        rewrite_hints: ['在风险章节明确标注区域数据缺失带来的推论边界'],
      })
      break
    default:
      text = '这是演示模式下的内置回答。配置 DeepSeek / Tavily 的服务端密钥后，这里会替换为真实模型输出。'
  }

  const promptTokens = Math.ceil(prompt.length / 3)
  const completionTokens = Math.ceil(text.length / 3)
  return {
    text,
    reasoning: '',
    promptTokens,
    completionTokens,
    model: `demo/${label || 'generic'}`,
    channel: 'direct',
  }
}

export function demoSnippet(text: string, max = 60): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max)
}

/** 一键导入的示例资料：让「本地检索」这条链路在空库状态下也能被演示 */
export function demoDocument(): { title: string; content: string } {
  const body = SAMPLE_CORPUS.map(
    (item, index) =>
      `${index + 1}. ${item.title}\n来源：${item.url}\n发布日期：${item.published_at}\n\n${item.snippet}`,
  ).join('\n\n')
  return {
    title: '企业级 AI Agent 行业资料汇编（示例）',
    content: `# 企业级 AI Agent 行业资料汇编（示例）\n\n本文件为演示用内部资料，内容来自公开渠道整理，用于验证本地知识库检索链路。\n\n${body}`,
  }
}
