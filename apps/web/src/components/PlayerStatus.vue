<script setup lang="ts">
import { computed } from 'vue';
import type { PlayerView } from '@tongpin/shared';
import { playerLabel } from '../utils/playerLabel';
const props = defineProps<{ self: PlayerView; opponents: PlayerView[]; playerCount: 2 | 3 }>();
const people = computed(() => [props.self, ...props.opponents].map(player => ({
  name: playerLabel(player.seat, props.self.seat, props.playerCount), player,
})));
</script>

<template>
  <div class="player-status" :class="{ 'player-status--three': playerCount === 3 }" aria-label="玩家提交状态" role="status">
    <div v-for="person in people" :key="person.player.seat" class="player-status__person" :class="{ 'player-status__person--ready': person.player.submitted }">
      <p class="player-status__name">{{ person.name }}<span v-if="!person.player.online" class="player-status__offline"> · 离线</span></p>
      <p class="player-status__state">{{ person.player.submitted ? (person.name === '对方' ? '对方已提交' : '已提交') : '正在想词' }}<span v-if="person.player.raised"> · 已举手</span></p>
    </div>
  </div>
</template>

<style scoped>
.player-status { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-3); margin-bottom: var(--space-6); }
.player-status--three { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); }
.player-status__person { border-top: 2px solid var(--color-border); padding-top: var(--space-3); }
.player-status__person--ready { border-color: var(--color-primary); }
.player-status__name { font-size: var(--text-sm); margin-bottom: var(--space-1); }
.player-status__state { font-size: var(--text-xs); color: var(--color-muted); }
.player-status__offline { color: var(--color-muted); font-size: var(--text-xs); }
</style>
