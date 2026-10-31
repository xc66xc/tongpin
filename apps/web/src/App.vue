<script setup lang="ts">
import { computed, nextTick, onErrorCaptured, ref, watch } from 'vue';
import { useGame } from './composables/useGame';
import HomeScreen from './components/HomeScreen.vue';
import LobbyScreen from './components/LobbyScreen.vue';
import GameScreen from './components/GameScreen.vue';
import ResultScreen from './components/ResultScreen.vue';
const game = useGame();
const { snapshot, connection, busy, error, storageWarning, roomCode, savedRoom, canAct } = game;
const mainElement = ref<HTMLElement | null>(null);
const renderError = ref(false);
const phaseKey = computed(() => snapshot.value ? `${snapshot.value.gameNumber}-${snapshot.value.phase}-${snapshot.value.roundNumber}` : 'home');
const connectionText = computed(() => ({ connecting: '正在连接，马上就好。', connected: '', offline: '连接已断开，正在尝试重连。已提交的词和游戏进度会保留。', recovering: '正在恢复房间和游戏进度…' })[connection.value]);
watch(phaseKey, async () => {
  await nextTick();
  mainElement.value?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
});
onErrorCaptured(() => {
  renderError.value = true;
  return false;
});
function reload() { window.location.reload(); }
</script>

<template>
  <div class="app-shell">
    <header class="app-header"><span class="app-brand">同频<span class="app-brand__dot">·</span></span><span class="app-caption">{{ snapshot ? `房间 ${snapshot.roomCode.slice(0, 3)} ${snapshot.roomCode.slice(3)}` : '两人 / 三人默契游戏' }}</span></header>
    <main ref="mainElement" class="app-main">
      <div v-if="connectionText" class="app-alert" role="status">{{ connectionText }}<button v-if="connection === 'offline'" class="app-alert__action" @click="game.reconnect">重新连接</button></div>
      <div v-if="storageWarning" class="app-alert" role="status">{{ storageWarning }}</div>
      <div v-if="error" class="app-alert app-alert--error" role="alert">{{ error }}</div>
      <section v-if="renderError"><h1 class="screen-heading" tabindex="-1">页面暂时遇到问题。</h1><p class="screen-subtitle">已保存的房间身份会保留，请刷新重试。</p><button class="action-button" @click="reload">刷新页面</button></section>
      <HomeScreen v-else-if="!snapshot" :disabled="!canAct" :initial-code="roomCode" :saved-room="savedRoom" @create="game.createRoom" @join="game.joinRoom" />
      <LobbyScreen v-else-if="snapshot.phase === 'waiting'" :room="snapshot" @home="game.goHome" />
      <ResultScreen v-else-if="snapshot.phase === 'ended'" :room="snapshot" :disabled="!canAct" @again="game.act('again')" @home="game.goHome" />
      <GameScreen v-else :room="snapshot" :disabled="!canAct" @action="game.act" />
      <p v-if="busy" class="form-hint text-center" role="status">正在同步…</p>
    </main>
    <footer class="app-footer">每人一个词，一点点靠近。</footer>
  </div>
</template>
