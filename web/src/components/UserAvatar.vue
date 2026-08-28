<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  src?: string | null
  name?: string | null
  fallback?: string
}>(), {
  src: null,
  name: '',
  fallback: '用',
})

const failed = ref(false)
const initial = computed(() => props.name?.trim().charAt(0) || props.fallback)
const showImage = computed(() => Boolean(props.src) && !failed.value)

watch(() => props.src, () => {
  failed.value = false
})
</script>

<template>
  <span
    class="user-avatar"
    :aria-label="props.name ? `${props.name}的头像` : '用户头像'"
  >
    <img
      v-if="showImage"
      :src="props.src!"
      alt=""
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      @error="failed = true"
    >
    <span v-else>{{ initial }}</span>
  </span>
</template>

<style scoped>
.user-avatar{display:grid;overflow:hidden;place-items:center;flex:0 0 auto}.user-avatar img{display:block;width:100%;height:100%;object-fit:cover}.user-avatar>span{display:grid;width:100%;height:100%;place-items:center}
</style>
