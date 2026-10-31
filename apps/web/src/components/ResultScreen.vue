<script setup lang="ts">
import { computed } from 'vue';
import type { RoomSnapshot } from '@tongpin/shared';
import WordHistory from './WordHistory.vue';
import WordPair from './WordPair.vue';
const props = defineProps<{ room: RoomSnapshot; disabled: boolean }>();
defineEmits<{ again: []; home: [] }>();
const lastRound = computed(() => props.room.history.at(-1));
const someoneReady = computed(() => props.room.opponents.some(player => player.rematchReady));
const someoneOffline = computed(() => props.room.opponents.some(player => !player.online));
</script>

<template>
  <section>
    <div class="screen-intro">
      <p class="screen-eyebrow">默契，刚好发生</p>
      <h1 class="screen-heading" tabindex="-1">原来，我们想的一样。</h1>
      <p class="screen-subtitle">{{ room.endReason === 'matched' ? '同词成功' : `${room.playerCount === 2 ? '双方' : '三人全部'}举手，确认同频` }} · 完成 {{ room.historyCount }} 轮对词</p>
    </div>
    <WordPair v-if="lastRound" :words="lastRound.words" :seat="room.self.seat" />
    <p v-else class="result-empty">还没揭晓词语，我们就已经心照不宣。</p>
    <div class="action-stack">
      <button class="action-button" :disabled="disabled || room.self.rematchReady" @click="$emit('again')">{{ room.self.rematchReady ? (room.playerCount === 2 ? '已准备，等待对方' : '已准备，等待所有人') : '再来一局' }}</button>
      <button class="action-button action-button--secondary" @click="$emit('home')">回到首页</button>
    </div>
    <p v-if="someoneReady && !room.self.rematchReady" class="form-hint" role="status">{{ room.playerCount === 2 ? '对方' : '有玩家' }}想再玩一局，等你准备好。</p>
    <p v-if="someoneOffline" class="form-hint" role="status">{{ room.playerCount === 2 ? '对方' : '有玩家' }}暂时离线，重连后可以继续。</p>
    <WordHistory :rounds="room.history" :seat="room.self.seat" :player-count="room.playerCount" :total-count="room.historyCount" title="这一路，怎么靠近的" />
  </section>
</template>

<style scoped>
.result-empty { color: var(--color-muted); font-size: var(--text-sm); padding: var(--space-5) 0 var(--space-8); }
</style>
