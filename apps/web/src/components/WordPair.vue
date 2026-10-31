<script setup lang="ts">
import { computed } from 'vue';
import type { Seat } from '@tongpin/shared';
import { playerLabel } from '../utils/playerLabel';
const props = withDefaults(defineProps<{ words: (string | null)[]; seat: Seat; label?: string }>(), { label: '本轮揭晓的词语' });
const people = computed(() => [props.seat, ...props.words.map((_, index) => (index + 1) as Seat).filter(seat => seat !== props.seat)]
  .map(seat => ({ seat, name: playerLabel(seat, props.seat, props.words.length), word: props.words[seat - 1] ?? null })));
</script>

<template>
  <div class="word-pair" :class="{ 'word-pair--three': words.length === 3 }" :aria-label="label">
    <div v-for="person in people" :key="person.seat" class="word-pair__item" :class="{ 'word-pair__item--compact': words.length === 3 }"><span class="app-caption">{{ person.name }}想到的</span><strong class="word-pair__word" :class="{ 'word-pair__word--compact': words.length === 3, 'word-pair__word--missing': person.word === null }">{{ person.word ?? '未作答' }}</strong></div>
  </div>
</template>

<style scoped>
.word-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-3); margin: var(--space-6) 0; }
.word-pair__item { padding: var(--space-6) var(--space-3); border-radius: var(--radius-md); background: var(--color-soft); text-align: center; }
.word-pair__word { display: block; margin-top: var(--space-3); font-size: var(--text-xl); font-weight: 500; overflow-wrap: anywhere; }
.word-pair--three { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); }
.word-pair__item--compact { padding-inline: var(--space-2); }
.word-pair__word--compact { font-size: var(--text-lg); }
.word-pair__word--missing { color: var(--color-muted); font-size: var(--text-sm); font-weight: 400; }
</style>
