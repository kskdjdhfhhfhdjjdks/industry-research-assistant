<script setup lang="ts">
import type { PipelineNodeState } from '@/composables/useResearch'

defineProps<{ nodes: PipelineNodeState[]; running: boolean }>()

const statusIcon = (status: PipelineNodeState['status']): string => {
  if (status === 'done') return '✓'
  if (status === 'running') return '●'
  if (status === 'error') return '!'
  if (status === 'skipped') return '–'
  return ''
}

const formatMs = (ms: number): string => {
  if (!ms) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
</script>

<template>
  <div class="pipeline">
    <div
      v-for="(item, index) in nodes"
      :key="item.node"
      class="pipeline-item"
      :class="item.status"
    >
      <div class="pipeline-rail">
        <div class="pipeline-dot">{{ statusIcon(item.status) }}</div>
        <div v-if="index < nodes.length - 1" class="pipeline-line" />
      </div>
      <div class="pipeline-body">
        <div class="pipeline-name">
          <span>{{ item.label }}</span>
          <span class="pipeline-role">{{ item.role }}</span>
          <span v-if="item.round > 1" class="tag purple">第 {{ item.round }} 轮</span>
          <span v-if="item.ms" class="pipeline-time">{{ formatMs(item.ms) }}</span>
        </div>
        <p v-if="item.summary" class="pipeline-summary">{{ item.summary }}</p>
      </div>
    </div>
  </div>
</template>
