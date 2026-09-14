<script setup lang="ts">
import { PROVIDER_PRESETS } from '@/core/config'
import type { AppSettings } from '@/core/config'

const props = defineProps<{
  settings: AppSettings
  capability: { llm: boolean; search: boolean; searchProvider: string; proxyPresent: boolean; probed: boolean }
  demoMode: boolean
  supabaseEnabled: boolean
  knowledgeSource: 'supabase' | 'local'
  sessionUserId: string
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'save'): void
  (event: 'provider', id: string): void
}>()

const preset = () => PROVIDER_PRESETS.find((item) => item.id === props.settings.providerId)

const SEARCH_PROVIDER_LABELS: Record<string, string> = {
  bocha: '博查 Bocha',
  tavily: 'Tavily',
  serper: 'Serper（Google）',
}

const searchProviderLabel = () => SEARCH_PROVIDER_LABELS[props.capability.searchProvider] ?? ''
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <div>
          <h3>运行设置</h3>
          <p>模型与检索密钥只保存在你自己浏览器或站点服务端，不会上传到任何第三方。</p>
        </div>
        <button class="ghost" @click="emit('close')">关闭</button>
      </div>

      <div class="section">
        <span class="section-title">服务端能力探测</span>
        <p class="note" :class="capability.llm ? 'ok' : 'warn'">
          {{ capability.probed ? '' : '探测中…' }}
          模型代理：{{ capability.proxyPresent ? (capability.llm ? '已配置服务端密钥' : '已部署但未配置密钥') : '未部署（当前为纯静态运行）' }}<br />
          检索代理：{{ capability.search ? `已启用 ${searchProviderLabel() || '检索后端'}` : '未配置（网络检索将退化为内置演示语料）' }}<br />
          {{ demoMode ? '当前运行在「演示模式」：使用内置样例语料与内置模型输出，全链路仍真实执行。' : '当前运行在「真实模式」：调用真实模型与检索 API。' }}
        </p>
      </div>

      <div class="section">
        <span class="section-title">模型供应商</span>
        <select
          :value="settings.providerId"
          @change="emit('provider', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="item in PROVIDER_PRESETS" :key="item.id" :value="item.id">{{ item.label }}</option>
        </select>

        <div class="field">
          <label>Base URL（OpenAI 兼容端点）</label>
          <input v-model="settings.baseUrl" placeholder="https://api.deepseek.com/v1" />
        </div>

        <div class="field">
          <label>模型</label>
          <input v-model="settings.model" placeholder="deepseek-chat" />
        </div>

        <div class="field">
          <label>API Key（可选，填写后优先使用你自己的额度）</label>
          <input v-model="settings.apiKey" type="password" placeholder="留空则使用站点服务端密钥" />
        </div>

        <p v-if="preset()?.docs" class="note">
          获取地址：<a :href="preset()?.docs" target="_blank" rel="noreferrer">{{ preset()?.docs }}</a>
        </p>
      </div>

      <div class="section">
        <span class="section-title">研究参数</span>
        <div class="field">
          <label>最大补搜轮次（迭代上限，防止死循环）</label>
          <input v-model.number="settings.maxIterations" type="number" min="0" max="4" />
        </div>
        <label class="row" style="font-size: 12px">
          <input
            type="checkbox"
            v-model="settings.semanticEmbedding"
            style="width: auto"
          />
          启用语义向量模型（首次使用会下载约 25MB 模型，失败自动降级）
        </label>
      </div>

      <div class="section">
        <span class="section-title">会话标识</span>
        <div class="row">
          <div class="field" style="flex: 1">
            <label>Thread ID</label>
            <input v-model="settings.threadId" />
          </div>
          <div class="field" style="flex: 1">
            <label>Tenant ID</label>
            <input v-model="settings.tenantId" />
          </div>
        </div>
        <p class="note">
          与会话记忆：{{ sessionUserId }}<br />
          数据存储：{{ supabaseEnabled ? 'Supabase 云端' : '浏览器本地' }} ｜ 知识库：{{ knowledgeSource === 'supabase' ? 'Supabase pgvector' : '浏览器本地' }}
        </p>
      </div>

      <div class="row" style="justify-content: flex-end">
        <button @click="emit('close')">取消</button>
        <button class="primary" @click="emit('save')">保存</button>
      </div>
    </div>
  </div>
</template>
