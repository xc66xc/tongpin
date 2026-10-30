<script setup lang="ts">
import { ref } from 'vue';
const props = defineProps<{ disabled: boolean; initialCode: string; savedRoom: string }>();
defineEmits<{ create: []; join: [code: string] }>();
const code = ref(props.initialCode);
const composing = ref(false);
</script>

<template>
  <section>
    <div class="screen-intro">
      <p class="screen-eyebrow">TWO MINDS, ONE WORD</p>
      <h1 class="screen-heading" tabindex="-1">你想到的，<br>也是我想到的吗？</h1>
      <p class="screen-subtitle">每人一个词，直到我们同频。</p>
      <div class="home-mark" aria-hidden="true"><span class="home-mark__token">你</span><span class="home-mark__dots">···</span><span class="home-mark__token home-mark__token--second">我</span></div>
    </div>
    <button class="action-button" :disabled="disabled" @click="$emit('create')">创建房间，邀请朋友</button>
    <hr class="screen-divider">
    <form @submit.prevent="!composing && $emit('join', code)">
      <label class="form-label" for="room-code">已有房间码？</label>
      <input id="room-code" v-model="code" class="form-input" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="输入 6 位房间码" :disabled="disabled" @compositionstart="composing = true" @compositionend="composing = false">
      <button class="action-button action-button--secondary" :disabled="disabled">加入房间</button>
    </form>
    <button v-if="savedRoom" class="action-button action-button--text home-resume" :disabled="disabled" @click="$emit('join', savedRoom)">回到房间 {{ savedRoom }}</button>
    <p class="form-hint text-center">无需注册 · 两人一间 · 手机直接玩</p>
  </section>
</template>

<style scoped>
.home-mark { display: flex; align-items: center; justify-content: center; gap: var(--space-3); min-height: 100px; margin: var(--space-2) 0 var(--space-8); }
.home-mark__token { display: grid; place-items: center; width: 80px; height: 80px; border-radius: 50%; background: var(--color-soft); font-size: var(--text-xl); }
.home-mark__token--second { background: var(--color-text); color: var(--color-surface); transform: translateY(var(--space-3)); }
.home-mark__dots { color: var(--color-muted); }
.home-resume { margin-top: var(--space-3); }
</style>
