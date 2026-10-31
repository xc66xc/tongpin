<script setup lang="ts">
import { computed } from 'vue';
import type { RoundView, Seat } from '@tongpin/shared';
import { playerLabel } from '../utils/playerLabel';
const props = withDefaults(defineProps<{ rounds: RoundView[]; seat: Seat; playerCount: 2 | 3; totalCount?: number; title?: string }>(), { totalCount: 0 });
const sortedRounds = computed(() => [...props.rounds].reverse());
const seats = computed(() => [props.seat, ...Array.from({ length: props.playerCount }, (_, index) => (index + 1) as Seat).filter(seat => seat !== props.seat)]);
</script>

<template>
  <section class="word-history" aria-labelledby="history-heading">
    <h2 id="history-heading" class="word-history__heading">{{ title ?? '刚刚的思路' }}</h2>
    <p v-if="!rounds.length" class="form-hint">此前的词会留在这里，陪你找到下一步。</p>
    <table v-else class="word-history__table" aria-label="已揭晓的对词记录">
      <thead><tr><th scope="col" class="word-history__round">轮次</th><th v-for="playerSeat in seats" :key="playerSeat" scope="col">{{ playerLabel(playerSeat, seat, playerCount) }}</th></tr></thead>
      <tbody><tr v-for="round in sortedRounds" :key="round.roundNumber"><td class="word-history__round">{{ String(round.roundNumber).padStart(2, '0') }} 轮</td><td v-for="playerSeat in seats" :key="playerSeat" :class="{ 'word-history__missing': round.words[playerSeat - 1] === null }">{{ round.words[playerSeat - 1] ?? '未作答' }}</td></tr></tbody>
    </table>
    <p v-if="totalCount > rounds.length" class="form-hint">共 {{ totalCount }} 轮，此处展示最近 {{ rounds.length }} 轮。</p>
  </section>
</template>

<style scoped>
.word-history { margin-top: var(--space-8); }
.word-history__heading { font-size: var(--text-sm); font-weight: 400; color: var(--color-muted); margin-bottom: var(--space-2); }
.word-history__table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: var(--text-sm); }
.word-history__table th { color: var(--color-muted); font-size: var(--text-xs); font-weight: 400; text-align: left; padding: var(--space-2) var(--space-2) var(--space-2) 0; }
.word-history__table td { border-top: 1px solid var(--color-border); padding: var(--space-3) var(--space-2) var(--space-3) 0; vertical-align: top; overflow-wrap: anywhere; }
.word-history__round { width: var(--space-16); color: var(--color-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.word-history__missing { color: var(--color-muted); font-size: var(--text-xs); }
</style>
