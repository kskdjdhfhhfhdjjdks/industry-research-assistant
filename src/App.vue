<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import AgentPipeline from './components/AgentPipeline.vue'
import KnowledgePanel from './components/KnowledgePanel.vue'
import SettingsModal from './components/SettingsModal.vue'
import { useResearch } from './composables/useResearch'
import { renderMarkdown } from './core/markdown'
import { demoDocument } from './core/demo'
import { formatDuration } from './core/utils'

const research = useResearch()

const query = ref('')
const showSettings = ref(false)
const messageListRef = ref<HTMLElement | null>(null)

const starterPrompts = [
  {
    title: '行业深度调研',
    prompt: '请系统调研 2026 年企业级 AI Agent 行业，覆盖市场规模与增速、竞争格局、技术路线、商业模式与政策合规，并给出带来源引用的结论。',
  },
  {
    title: '方案对比选型',
    prompt: '我们在选型多智能体编排框架，请对比 LangGraph、AutoGen、CrewAI 与自研状态机四种方案的优缺点、适用场景与落地风险。',
  },
  {
    title: '竞品分析',
    prompt: '请分析企业知识库 Agent 平台的竞争格局，说明主要玩家的定位差异、定价模式，以及采购决策中最关键的三个因素。',
  },
  {
    title: '概念快速问答',
    prompt: '什么是 Pregel 超步调度？用三句话解释清楚。',
  },
]

const routeLabel = computed(() => {
  if (research.route.value === 'direct') return { text: '快速回答路径', cls: 'amber' }
  if (research.route.value === 'multiagent') return { text: '多智能体研究路径', cls: 'purple' }
  return { text: '待路由', cls: '' }
})

const totalContentLength = computed(() =>
  research.messages.value.reduce((sum, item) => sum + item.content.length, 0),
)

const showEmpty = computed(() => research.messages.value.length === 0 && !research.running.value)

async function scrollToBottom() {
  await nextTick()
  const el = messageListRef.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(totalContentLength, scrollToBottom)

function submit() {
  const text = query.value.trim()
  if (!text || research.running.value) return
  query.value = ''
  void research.start(text)
}

function usePrompt(prompt: string) {
  query.value = prompt
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
}

async function importSample() {
  const sample = demoDocument()
  await research.addDocument(sample.title, sample.content)
}

function useRunHistory(runQuery: string) {
  query.value = runQuery
}

onMounted(async () => {
  await research.init()
})

watch(
  () => research.toast.value,
  (value) => {
    if (!value) return
    window.setTimeout(() => {
      if (research.toast.value === value) research.toast.value = ''
    }, 5200)
  },
)
</script>

<template>
  <div class="app-frame">
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <h1>DeepResearch</h1>
          <p>
            多 Agent 协作的行业深度分析助手。意图路由 → 双源检索 → 证据裁判 → 迭代补搜 → 带引用研报，
            全流程运行在你的浏览器里。
          </p>
        </div>

        <div class="row">
          <button class="primary" style="flex: 1" @click="research.newSession()">新建会话</button>
          <button @click="showSettings = true">设置</button>
        </div>

        <div class="section">
          <div class="section-head">
            <span class="section-title">Agent 流水线</span>
            <span class="tag" :class="routeLabel.cls">{{ routeLabel.text }}</span>
          </div>
          <AgentPipeline :nodes="research.pipeline.value" :running="research.running.value" />
        </div>

        <div class="section">
          <span class="section-title">运行统计</span>
          <div class="stat-grid">
            <div class="stat"><span>模型调用</span><strong>{{ research.stats.value.calls }}</strong></div>
            <div class="stat"><span>Token 累计</span><strong>{{ research.stats.value.tokens }}</strong></div>
            <div class="stat"><span>证据池</span><strong>{{ research.stats.value.evidence }}</strong></div>
            <div class="stat"><span>来源索引</span><strong>{{ research.stats.value.sources }}</strong></div>
            <div class="stat"><span>迭代轮次</span><strong>{{ research.stats.value.round }}</strong></div>
            <div class="stat"><span>质检评分</span><strong>{{ research.stats.value.score || '—' }}</strong></div>
          </div>
          <p v-if="research.usage.elapsedMs" class="note">
            端到端耗时 {{ formatDuration(research.usage.elapsedMs) }}；累计 token
            {{ research.usage.promptTokens + research.usage.outputTokens }}（输入
            {{ research.usage.promptTokens }} / 输出 {{ research.usage.outputTokens }}）
          </p>
        </div>

        <KnowledgePanel
          :documents="research.documents.value"
          :mode="research.knowledgeSource.value"
          :semantic="research.settings.semanticEmbedding"
          @add="(title, content) => research.addDocument(title, content)"
          @remove="(id) => research.removeDocument(id)"
          @sample="importSample"
        />

        <div v-if="research.logs.value.length" class="section">
          <span class="section-title">执行日志</span>
          <div class="logs">
            <div
              v-for="line in research.logs.value.slice(-40)"
              :key="line.id"
              class="log-line"
              :class="line.level"
            >
              [{{ line.node }}] {{ line.message }}
            </div>
          </div>
        </div>

        <div v-if="research.runs.value.length" class="section">
          <span class="section-title">最近研究（长期记忆）</span>
          <div class="doc-list">
            <button
              v-for="run in research.runs.value"
              :key="run.created_at + run.query"
              class="doc-item"
              style="text-align: left"
              @click="useRunHistory(run.query)"
            >
              <span :title="run.query">{{ run.query }}</span>
            </button>
          </div>
        </div>
      </aside>

      <main class="main">
        <header class="main-header">
          <div>
            <h2>行业深度分析工作台</h2>
            <p>9 个专家 Agent 协作 · 双源检索 · 证据审计 · 引用可溯源</p>
          </div>
          <div class="header-tags">
            <span v-if="research.demoMode.value" class="tag amber" title="未检测到服务端模型密钥，使用内置样例数据">
              演示模式
            </span>
            <span v-else class="tag teal">真实模型</span>
            <span class="tag">StateGraph 编排</span>
            <span class="tag">pgvector</span>
            <span class="tag">SSE 流式</span>
          </div>
        </header>

        <div ref="messageListRef" class="messages">
          <section v-if="showEmpty" class="empty">
            <h3>先讲清目标，剩下交给 Agent 团队</h3>
            <p>
              系统会先用规则引擎与模型双重判断问题类型：闲聊与概念问答走快速回答，行业研究类问题走完整的
              规划 → 双源检索 → 证据裁判 → 分析 → 迭代补搜 → 撰写 → 质检链路。
            </p>
            <div class="chips">
              <button
                v-for="item in starterPrompts"
                :key="item.title"
                class="chip"
                @click="usePrompt(item.prompt)"
              >
                <strong style="display: block; margin-bottom: 4px">{{ item.title }}</strong>
                {{ item.prompt.slice(0, 52) }}…
              </button>
            </div>
          </section>

          <div
            v-for="message in research.messages.value"
            :key="message.id"
            class="message"
            :class="message.role"
          >
            <div class="avatar">{{ message.role === 'user' ? '我' : message.role === 'status' ? '…' : 'AI' }}</div>
            <div v-if="message.role === 'status'" class="bubble message-status">
              <div class="stream-status">
                <div v-for="(log, index) in research.logs.value.slice(-8)" :key="index">
                  · {{ log.message }}
                </div>
              </div>
            </div>
            <div
              v-else
              class="bubble md"
              :class="{ 'md-streaming': message.streaming }"
              v-html="renderMarkdown(message.content)"
            />
          </div>
        </div>

        <div class="composer">
          <div class="composer-inner">
            <textarea
              v-model="query"
              rows="2"
              :disabled="research.running.value"
              placeholder="描述你的研究需求，例如「调研某行业并给出带来源的结论」；Enter 发送，Shift + Enter 换行"
              @keydown="handleKeydown"
            />
            <button v-if="research.running.value" @click="research.abort()">停止</button>
            <button v-else class="primary" :disabled="!query.trim()" @click="submit">发送</button>
          </div>
          <p class="composer-hint">
            <span>
              {{ research.capability.proxyPresent ? '边缘函数代理已就绪' : '未检测到边缘函数（本地纯 Vite 模式将以直连方式调用模型）' }}
            </span>
            <span v-if="research.toast.value">{{ research.toast.value }}</span>
          </p>
        </div>
      </main>
    </div>

    <SettingsModal
      v-if="showSettings"
      :settings="research.settings"
      :capability="research.capability"
      :demo-mode="research.demoMode.value"
      :supabase-enabled="research.supabaseEnabled.value"
      :knowledge-source="research.knowledgeSource.value"
      :session-user-id="research.sessionUserId.value"
      @close="showSettings = false"
      @provider="(id) => research.updateProvider(id)"
      @save="
        () => {
          research.save()
          showSettings = false
        }
      "
    />
  </div>
</template>
