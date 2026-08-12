<script setup lang="ts">
import MarkdownRender from 'markstream-vue'
import 'markstream-vue/index.css'

const props = withDefaults(defineProps<{
  text: string
  streaming?: boolean
  done?: boolean
}>(), {
  streaming: false,
  done: true,
})
</script>

<template>
  <!-- review 2026-08-12 P1：SSE 已流式追加文字，关闭 markstream 二次打字机（防正文追不上/结束时突补齐）；
       htmlPolicy=escape 显式禁止模型输出原始 HTML（<script>/事件属性/未知标签按文本渲染） -->
  <MarkdownRender
    mode="chat"
    :content="props.text"
    :final="props.done || !props.streaming"
    :typewriter="false"
    :fade="false"
    :html-policy="'escape'"
  />
</template>
