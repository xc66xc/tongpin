<script setup lang="ts">
import { computed, ref } from 'vue';
defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ submit: [word: string] }>();
const word = ref('');
const composing = ref(false);
const length = computed(() => [...word.value.trim()].length);
const invalid = ref('');
function submit() {
  if (composing.value) return;
  if (!length.value || length.value > 30) { invalid.value = '请输入 1–30 个字的词语。'; return; }
  invalid.value = '';
  emit('submit', word.value.trim());
}
</script>

<template>
  <form @submit.prevent="submit">
    <label class="form-label" for="your-word">你的词</label>
    <input id="your-word" v-model="word" class="form-input" placeholder="写下你想到的词" autocomplete="off" :disabled="disabled" maxlength="60" aria-describedby="word-hint word-error" :aria-invalid="!!invalid" @compositionstart="composing = true" @compositionend="composing = false" @keydown.enter="($event.isComposing || composing) && $event.preventDefault()">
    <button class="action-button" :disabled="disabled || !length || length > 30">提交，等对方揭晓</button>
    <p id="word-hint" class="form-hint">提交后不可修改，对方暂时看不到。最多 30 个字。</p>
    <p v-if="invalid" id="word-error" class="form-error" role="alert">{{ invalid }}</p>
  </form>
</template>
