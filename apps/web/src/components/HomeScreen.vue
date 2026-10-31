<script setup lang="ts">
import { computed, ref } from 'vue';
const props = defineProps<{ disabled: boolean; initialCode: string; savedRoom: string }>();
defineEmits<{ create: [settings: { playerCount: 2 | 3; roundSeconds: number }]; join: [code: string] }>();
const code = ref(props.initialCode);
const composing = ref(false);
const playerCount = ref<2 | 3>(2);
const duration = ref<number | 'custom'>(30);
const customSeconds = ref('90');
const roundSeconds = computed(() => duration.value === 'custom' ? Number(customSeconds.value) : duration.value);
const validDuration = computed(() => Number.isInteger(roundSeconds.value) && roundSeconds.value >= 5 && roundSeconds.value <= 3600);
</script>

<template>
  <section>
    <div class="screen-intro">
      <p class="screen-eyebrow">DIFFERENT MINDS, ONE WORD</p>
      <h1 class="screen-heading" tabindex="-1">你想到的，<br>也是我想到的吗？</h1>
      <p class="screen-subtitle">每人一个词，直到我们同频。</p>
      <div class="home-mark" aria-hidden="true"><span class="home-mark__token">你</span><span class="home-mark__dots">···</span><span class="home-mark__token home-mark__token--second">我</span></div>
    </div>
    <form @submit.prevent="validDuration && $emit('create', { playerCount, roundSeconds })">
      <fieldset class="home-settings" :disabled="disabled">
        <legend class="form-label">房间人数</legend>
        <div class="home-choices"><label v-for="count in ([2, 3] as const)" :key="count" class="home-choice" :class="{ 'home-choice--selected': playerCount === count }"><input v-model="playerCount" type="radio" name="player-count" :value="count">{{ count }} 人</label></div>
      </fieldset>
      <fieldset class="home-settings" :disabled="disabled">
        <legend class="form-label">每轮思考时间</legend>
        <div class="home-choices home-choices--time"><label v-for="seconds in [30, 45, 60]" :key="seconds" class="home-choice" :class="{ 'home-choice--selected': duration === seconds }"><input v-model="duration" type="radio" name="round-duration" :value="seconds">{{ seconds }}s</label><label class="home-choice" :class="{ 'home-choice--selected': duration === 'custom' }"><input v-model="duration" type="radio" name="round-duration" value="custom">自定义</label></div>
        <template v-if="duration === 'custom'"><label class="form-label" for="custom-seconds">自定义时长（秒）</label><input id="custom-seconds" v-model="customSeconds" class="form-input" type="number" inputmode="numeric" min="5" max="3600" step="1" required aria-describedby="duration-hint" :aria-invalid="!validDuration"><p id="duration-hint" class="form-hint" :class="{ 'form-error': !validDuration }">请输入 5–3600 的整数，每轮到时自动揭晓。</p></template>
      </fieldset>
      <button class="action-button" :disabled="disabled || !validDuration">创建房间，邀请朋友</button>
    </form>
    <hr class="screen-divider">
    <form @submit.prevent="!composing && $emit('join', code)">
      <label class="form-label" for="room-code">已有房间码？</label>
      <input id="room-code" v-model="code" class="form-input" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="输入 6 位房间码" :disabled="disabled" @compositionstart="composing = true" @compositionend="composing = false">
      <button class="action-button action-button--secondary" :disabled="disabled">加入房间</button>
    </form>
    <button v-if="savedRoom" class="action-button action-button--text home-resume" :disabled="disabled" @click="$emit('join', savedRoom)">回到房间 {{ savedRoom }}</button>
    <p class="form-hint text-center">无需注册 · 两人或三人 · 手机直接玩</p>
  </section>
</template>

<style scoped>
.home-mark { display: flex; align-items: center; justify-content: center; gap: var(--space-3); min-height: 100px; margin: var(--space-2) 0 var(--space-8); }
.home-mark__token { display: grid; place-items: center; width: 80px; height: 80px; border-radius: 50%; background: var(--color-soft); font-size: var(--text-xl); }
.home-mark__token--second { background: var(--color-text); color: var(--color-surface); transform: translateY(var(--space-3)); }
.home-mark__dots { color: var(--color-muted); }
.home-resume { margin-top: var(--space-3); }
.home-settings { min-width: 0; margin: 0 0 var(--space-5); padding: 0; border: 0; }
.home-choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); margin: var(--space-2) 0; }
.home-choices--time { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.home-choice { display: flex; align-items: center; justify-content: center; gap: var(--space-1); min-height: var(--space-12); padding: var(--space-2) var(--space-1); border: 1px solid var(--color-border); border-radius: var(--radius-sm); font-size: var(--text-sm); cursor: pointer; }
.home-choice--selected { background: var(--color-soft); border-color: var(--color-primary); }
.home-choice input { margin: 0; accent-color: var(--color-primary); }
</style>
