<script setup lang="ts">
import { computed } from 'vue';
import type { GameAction, RoomSnapshot } from '@tongpin/shared';
import PlayerStatus from './PlayerStatus.vue';
import WordHistory from './WordHistory.vue';
import WordInput from './WordInput.vue';
import WordPair from './WordPair.vue';
const props = defineProps<{ room: RoomSnapshot; disabled: boolean }>();
defineEmits<{ action: [action: GameAction, word?: string] }>();
const currentRound = computed(() => props.room.history.find(round => round.roundNumber === props.room.roundNumber));
const previousRounds = computed(() => props.room.history.filter(round => round.roundNumber !== props.room.roundNumber));
</script>

<template>
  <section>
    <div class="game-round"><span class="game-round__label">第 {{ String(room.roundNumber).padStart(2, '0') }} 轮</span><span class="game-round__online">{{ room.opponent?.online ? '双方在线' : '对方离线，等待重连' }}</span></div>
    <h1 class="screen-heading" tabindex="-1">{{ room.phase === 'revealed' ? '离同频，又近了一点。' : '这次，你想到了什么？' }}</h1>
    <p class="screen-subtitle">{{ room.phase === 'revealed' ? '词不一样，意思也许已经很接近。' : room.roundNumber === 1 ? '随意想一个词，看看彼此的起点。' : '沿着上一轮的两个词，继续联想。' }}</p>
    <div v-if="room.opponent?.raised && !room.self.raised" class="game-callout" role="status">对方举手了，觉得已经同频。<small class="game-callout__detail">你也认同的话，点击下方举手结束。</small></div>
    <PlayerStatus :self="room.self" :opponent="room.opponent" />
    <template v-if="room.phase === 'revealed' && currentRound">
      <WordPair :words="currentRound.words" :seat="room.self.seat" />
      <button class="action-button" :disabled="disabled || room.self.nextReady" @click="$emit('action', 'next')">{{ room.self.nextReady ? '已准备，等待对方' : '继续下一轮' }}</button>
      <p class="form-hint" role="status">{{ room.opponent?.nextReady ? '对方已准备好，等你继续。' : '双方都准备好后，再进入下一轮。' }}</p>
    </template>
    <div v-else-if="room.self.submitted" class="game-entry" role="status">
      <p class="game-entry__label">你提交的词</p><p class="game-entry__word">{{ room.self.word }}</p><p class="form-hint">等待对方提交，随后一起揭晓。</p>
    </div>
    <WordInput v-else :key="`${room.gameNumber}-${room.roundNumber}`" :disabled="disabled" @submit="$emit('action', 'submit', $event)" />
    <div class="game-hand">
      <button class="action-button action-button--secondary" :disabled="disabled || room.self.raised" @click="$emit('action', 'raise')">{{ room.self.raised ? '你已举手，等待对方确认' : room.opponent?.raised ? '举手结束 · 我也认同' : '举手结束' }}</button>
      <p class="form-hint">{{ room.self.raised ? '举手不可撤回，可以继续出词。' : '意思相同也算默契。双方举手即可结束，不可撤回。' }}</p>
    </div>
    <WordHistory :rounds="previousRounds" :seat="room.self.seat" />
  </section>
</template>

<style scoped>
.game-round { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); margin-bottom: var(--space-5); }
.game-round__label { font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
.game-round__online { color: var(--color-primary); font-size: var(--text-xs); text-align: right; }
.game-callout { background: var(--color-soft); padding: var(--space-4); border-radius: var(--radius-sm); font-size: var(--text-sm); margin-bottom: var(--space-5); }
.game-callout__detail { display: block; color: var(--color-muted); font-size: var(--text-xs); margin-top: var(--space-1); }
.game-entry { background: var(--color-paper); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-6) var(--space-5); min-height: 205px; }
.game-entry__label { color: var(--color-muted); font-size: var(--text-sm); }
.game-entry__word { font-size: var(--text-display); font-weight: 500; line-height: var(--leading-normal); margin-top: var(--space-3); overflow-wrap: anywhere; }
.game-hand { margin-top: var(--space-5); }
</style>
