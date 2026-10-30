<script setup lang="ts">
import { computed } from 'vue';
import type { PlayerView } from '@tongpin/shared';
const props = defineProps<{ self: PlayerView; opponent: PlayerView | null }>();
const people = computed(() => [
  { name: '你', player: props.self },
  { name: '对方', player: props.opponent },
]);
</script>

<template>
  <div class="player-status" aria-label="双方提交状态" role="status">
    <div v-for="person in people" :key="person.name" class="player-status__person" :class="{ 'player-status__person--ready': person.player?.submitted }">
      <p class="player-status__name">{{ person.name }}</p>
      <p class="player-status__state">{{ person.player?.submitted ? (person.name === '你' ? '已提交' : '对方已提交') : '正在想词' }}<span v-if="person.player?.raised"> · 已举手</span></p>
    </div>
  </div>
</template>

<style scoped>
.player-status { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-3); margin-bottom: var(--space-6); }
.player-status__person { border-top: 2px solid var(--color-border); padding-top: var(--space-3); }
.player-status__person--ready { border-color: var(--color-primary); }
.player-status__name { font-size: var(--text-sm); margin-bottom: var(--space-1); }
.player-status__state { font-size: var(--text-xs); color: var(--color-muted); }
</style>
