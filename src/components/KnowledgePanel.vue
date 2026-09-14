<script setup lang="ts">
import { ref } from 'vue'
import type { DocumentMeta } from '@/core/knowledge'

defineProps<{
  documents: DocumentMeta[]
  mode: 'supabase' | 'local'
  semantic: boolean
}>()

const emit = defineEmits<{
  (event: 'add', title: string, content: string): void
  (event: 'remove', id: string): void
  (event: 'sample'): void
}>()

const title = ref('')
const content = ref('')
const dragging = ref(false)
const busy = ref(false)

async function readFiles(files: FileList | null) {
  if (!files || files.length === 0) return
  const file = files[0]
  const text = await file.text()
  title.value = file.name.replace(/\.[^.]+$/, '')
  content.value = text
}

function onDrop(event: DragEvent) {
  dragging.value = false
  void readFiles(event.dataTransfer?.files ?? null)
}

function submit() {
  const body = content.value.trim()
  if (!body) return
  busy.value = true
  emit('add', title.value.trim() || '未命名文档', body)
  title.value = ''
  content.value = ''
  busy.value = false
}
</script>

<template>
  <div class="section">
    <div class="section-head">
      <span class="section-title">本地知识库</span>
      <span class="tag" :class="mode === 'supabase' ? 'teal' : 'amber'">
        {{ mode === 'supabase' ? 'Supabase pgvector' : '浏览器本地' }}
      </span>
    </div>

    <input v-model="title" placeholder="文档标题（可选）" />

    <div
      class="dropzone"
      :class="{ active: dragging }"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input
        type="file"
        accept=".txt,.md,.markdown,.csv,.json,.log"
        style="display: none"
        id="kb-file"
        @change="readFiles(($event.target as HTMLInputElement).files)"
      />
      <label for="kb-file" style="cursor: pointer">
        拖拽或点击上传 .txt / .md / .csv（内容会分片并向量化）
      </label>
    </div>

    <textarea v-model="content" rows="4" placeholder="也可以直接粘贴研报 / 内部资料，作为「双源检索」中的本地一侧" />

    <div class="row">
      <button class="primary" :disabled="!content.trim() || busy" style="flex: 1" @click="submit">
        建立索引
      </button>
      <button class="ghost" @click="emit('sample')">导入示例</button>
    </div>

    <p class="note">
      {{ semantic ? '当前使用语义向量模型（512 维）' : '当前使用特征哈希向量（512 维，零依赖零下载）' }}；
      导入的文档会在「本地检索」节点被召回，与网络结果一起进入证据裁判。
    </p>

    <div v-if="documents.length" class="doc-list">
      <div v-for="doc in documents" :key="doc.id" class="doc-item">
        <span :title="doc.title">{{ doc.title }} · {{ doc.chunk_count }} 片</span>
        <button class="ghost" style="padding: 2px 6px" @click="emit('remove', doc.id)">删除</button>
      </div>
    </div>
  </div>
</template>
