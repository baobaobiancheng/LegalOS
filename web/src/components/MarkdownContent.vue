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
  <MarkdownRender
    mode="chat"
    :content="props.text"
    :final="props.done || !props.streaming"
    :typewriter="props.streaming"
    :fade="false"
  />
</template>
