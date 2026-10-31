<script setup lang="ts">
import { computed, ref } from 'vue';
import type { RoomSnapshot } from '@tongpin/shared';
const props = defineProps<{ room: RoomSnapshot }>();
defineEmits<{ home: [] }>();
const note = ref('人数齐了，自动开始计时。');
const linkInput = ref<HTMLInputElement | null>(null);
const inviteLink = computed(() => {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('room', props.room.roomCode);
  return url.toString();
});
const formattedCode = computed(() => props.room.roomCode.slice(0, 3) + ' ' + props.room.roomCode.slice(3));
const joinedCount = computed(() => props.room.opponents.length + 1);
async function copyLink() {
  try {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(inviteLink.value);
    note.value = '邀请链接已复制，发给朋友就能加入。';
  } catch {
    linkInput.value?.focus();
    linkInput.value?.select();
    note.value = '无法自动复制，请长按下方链接，选择复制。';
  }
}
async function shareLink() {
  if (!navigator.share) { await copyLink(); return; }
  try {
    await navigator.share({ title: '来和我玩同频', text: '每人一个词，看看我们几轮能同频。', url: inviteLink.value });
    note.value = '邀请已发出，等朋友加入吧。';
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') note.value = '已取消分享，也可以复制邀请链接。';
    else { note.value = '暂时无法调用分享，请复制下方邀请链接。'; }
  }
}
</script>

<template>
  <section>
    <div class="screen-intro">
      <p class="screen-eyebrow">留好位置，等你来</p>
      <h1 class="screen-heading" tabindex="-1">把朋友叫来吧。</h1>
      <p class="screen-subtitle">分享房间码，或直接发送邀请链接。</p>
    </div>
    <div class="lobby-code">
      <p class="app-caption">房间码</p>
      <p class="lobby-code__number">{{ formattedCode }}</p>
      <p class="form-hint" role="status">已加入 {{ joinedCount }} / {{ room.playerCount }} 人 · 等待朋友加入</p>
      <p class="form-hint">{{ room.playerCount }} 人模式 · 每轮 {{ room.roundSeconds }} 秒</p>
      <p class="form-hint">本局最多 {{ room.maxRounds }} 轮</p>
    </div>
    <div class="action-stack lobby-actions">
      <button class="action-button" @click="shareLink">分享邀请链接</button>
      <button class="action-button action-button--secondary" @click="copyLink">复制链接</button>
    </div>
    <p class="form-hint text-center" role="status">{{ note }}</p>
    <label class="form-label lobby-link-label" for="invite-link">邀请链接</label>
    <input id="invite-link" ref="linkInput" class="form-input lobby-link" :value="inviteLink" readonly @click="linkInput?.select()">
    <button class="action-button action-button--text" @click="$emit('home')">返回首页</button>
  </section>
</template>

<style scoped>
.lobby-code { padding: var(--space-6) var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-paper); text-align: center; }
.lobby-code__number { font-size: var(--text-display); letter-spacing: 5px; font-variant-numeric: tabular-nums; margin: var(--space-5) 0; }
.lobby-actions { margin-top: var(--space-5); }
.lobby-link-label { color: var(--color-muted); font-size: var(--text-xs); margin-top: var(--space-6); }
.lobby-link { font-size: var(--text-md); height: var(--space-12); }
</style>
