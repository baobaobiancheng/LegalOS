<script setup lang="ts">
defineProps<{
  message: string
  requestId?: string
  onRetry?: () => void
}>()

const copyRequestId = (id: string) => {
  window.navigator.clipboard?.writeText(id)
}
</script>

<template>
  <div class="error-state">
    <p class="error-msg">
      {{ message }}
    </p>
    <p
      v-if="requestId"
      class="error-rid"
      title="复制请求 ID"
      @click="requestId && copyRequestId(requestId)"
    >
      📋 请求 ID：{{ requestId }}
    </p>
    <button
      v-if="onRetry"
      class="error-retry"
      @click="onRetry"
    >
      重试
    </button>
  </div>
</template>

<style scoped>
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 16px;
  text-align: center;
}
.error-msg { color: #c62828; font-size: 14px; margin: 0; }
.error-rid { color: #8a8a8e; font-size: 12px; margin: 0; cursor: pointer; user-select: all; }
.error-retry {
  padding: 5px 16px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 14px;
  background: #fff;
  color: var(--blue, #0055b3);
  cursor: pointer;
}
</style>
