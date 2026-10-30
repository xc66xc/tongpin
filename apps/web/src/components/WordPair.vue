<script setup lang="ts">
import type { Seat } from '@tongpin/shared';
withDefaults(defineProps<{ words: [string, string]; seat: Seat; label?: string }>(), { label: '本轮揭晓的词语' });
</script>

<template>
  <div class="word-pair" :aria-label="label">
    <div class="word-pair__item"><span class="app-caption">你想到的</span><strong class="word-pair__word">{{ words[seat - 1] }}</strong></div>
    <div class="word-pair__item"><span class="app-caption">对方想到的</span><strong class="word-pair__word">{{ words[seat === 1 ? 1 : 0] }}</strong></div>
  </div>
</template>

<style scoped>
.word-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-3); margin: var(--space-6) 0; }
.word-pair__item { padding: var(--space-6) var(--space-3); border-radius: var(--radius-md); background: var(--color-soft); text-align: center; }
.word-pair__word { display: block; margin-top: var(--space-3); font-size: var(--text-xl); font-weight: 500; overflow-wrap: anywhere; }
</style>
