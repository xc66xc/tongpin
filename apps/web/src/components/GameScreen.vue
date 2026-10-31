<script setup lang="ts">
import { computed, toRef } from 'vue';
import type { GameAction, RoomSnapshot } from '@tongpin/shared';
import PlayerStatus from './PlayerStatus.vue';
import WordHistory from './WordHistory.vue';
import WordInput from './WordInput.vue';
import WordPair from './WordPair.vue';
import { useRoundClock } from '../composables/useRoundClock';
const props = defineProps<{ room: RoomSnapshot; disabled: boolean }>();
const emit = defineEmits<{ action: [action: GameAction, word?: string] }>();
const lastRound = computed(() => props.room.history.at(-1));
const previousRounds = computed(() => props.room.history.slice(0, -1));
const { secondsLeft, expired } = useRoundClock(toRef(props, 'room'));
const someoneRaised = computed(() => props.room.opponents.some(player => player.raised));
const onlineText = computed(() => props.room.playerCount === 2
  ? (props.room.opponents.every(player => player.online) ? '双方在线' : '对方离线，等待重连')
  : `${[props.room.self, ...props.room.opponents].filter(player => player.online).length} / ${props.room.playerCount} 人在线`);
function submitWord(word: string) {
  if (!props.disabled && !expired.value) emit('action', 'submit', word);
}
</script>

<template>
  <section>
    <div class="game-round"><span class="game-round__label">第 {{ String(room.roundNumber).padStart(2, '0') }} 轮</span><span class="game-round__online">{{ onlineText }}</span></div>
    <h1 class="screen-heading" tabindex="-1">这次，你想到了什么？</h1>
    <p class="screen-subtitle">{{ room.roundNumber === 1 ? '随意想一个词，看看彼此的起点。' : '沿着上一轮的词语，继续联想。' }}</p>
    <div class="game-clock" :class="{ 'game-clock--urgent': secondsLeft !== null && secondsLeft <= 10 }"><span role="timer" aria-label="本轮剩余时间" aria-live="off">{{ secondsLeft === null ? '正在同步时间' : `剩余 ${secondsLeft}s` }}</span><span class="app-caption">每轮 {{ room.roundSeconds }} 秒 · 到时自动揭晓</span></div>
    <p v-if="expired" class="form-hint game-timeout" role="status">时间到，正在同步揭晓结果…</p>
    <div v-if="lastRound" class="game-previous" role="status">
      <p class="form-hint">上一轮 · 第 {{ String(lastRound.roundNumber).padStart(2, '0') }} 轮已揭晓</p>
      <WordPair :words="lastRound.words" :seat="room.self.seat" label="上一轮揭晓的词语" />
    </div>
    <div v-if="someoneRaised && !room.self.raised" class="game-callout" role="status">{{ room.playerCount === 2 ? '对方举手了，觉得已经同频。' : '有玩家举手了，觉得已经同频。' }}<small class="game-callout__detail">你也认同的话，点击下方举手结束。</small></div>
    <PlayerStatus :self="room.self" :opponents="room.opponents" :player-count="room.playerCount" />
    <div v-if="room.self.submitted" class="game-entry" role="status">
      <p class="game-entry__label">你提交的词</p><p class="game-entry__word">{{ room.self.word }}</p><p class="form-hint">{{ room.playerCount === 2 ? '等待对方提交，随后一起揭晓。' : '等待其他玩家提交，随后一起揭晓。' }}</p>
    </div>
    <WordInput v-else :key="`${room.gameNumber}-${room.roundNumber}`" :disabled="disabled || expired" :player-count="room.playerCount" @submit="submitWord" />
    <div class="game-hand">
      <button class="action-button action-button--secondary" :disabled="disabled || room.self.raised" @click="$emit('action', 'raise')">{{ room.self.raised ? (room.playerCount === 2 ? '你已举手，等待对方确认' : '你已举手，等待所有人确认') : someoneRaised ? '举手结束 · 我也认同' : '举手结束' }}</button>
      <p class="form-hint">{{ room.self.raised ? '举手不可撤回，可以继续出词。' : `意思相同也算默契。${room.playerCount === 2 ? '双方' : '三人全部'}举手即可结束，不可撤回。` }}</p>
    </div>
    <WordHistory v-if="previousRounds.length || !lastRound" :rounds="previousRounds" :seat="room.self.seat" :player-count="room.playerCount" :total-count="Math.max(0, room.historyCount - (lastRound ? 1 : 0))" />
  </section>
</template>

<style scoped>
.game-round { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); margin-bottom: var(--space-5); }
.game-round__label { font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
.game-round__online { color: var(--color-primary); font-size: var(--text-xs); text-align: right; }
.game-clock { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-3) 0; margin-bottom: var(--space-5); border-block: 1px solid var(--color-border); font-size: var(--text-lg); font-variant-numeric: tabular-nums; }
.game-clock--urgent { color: var(--color-warning); }
.game-timeout { margin-bottom: var(--space-4); }
.game-callout { background: var(--color-soft); padding: var(--space-4); border-radius: var(--radius-sm); font-size: var(--text-sm); margin-bottom: var(--space-5); }
.game-callout__detail { display: block; color: var(--color-muted); font-size: var(--text-xs); margin-top: var(--space-1); }
.game-entry { background: var(--color-paper); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-6) var(--space-5); min-height: 205px; }
.game-entry__label { color: var(--color-muted); font-size: var(--text-sm); }
.game-entry__word { font-size: var(--text-display); font-weight: 500; line-height: var(--leading-normal); margin-top: var(--space-3); overflow-wrap: anywhere; }
.game-hand { margin-top: var(--space-5); }
</style>
