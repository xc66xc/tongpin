import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import type { RoomSnapshot } from '@tongpin/shared';

/** Render locally; only the server decides whether a submission met the deadline. */
export function useRoundClock(room: Ref<RoomSnapshot>) {
  const currentTime = ref(Date.now());
  let offset = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  const update = () => { currentTime.value = Date.now() + offset; };
  watch(() => [room.value.serverNow, room.value.deadlineAt], () => {
    offset = room.value.serverNow - Date.now();
    update();
  }, { immediate: true });
  const secondsLeft = computed(() => room.value.deadlineAt === null
    ? null : Math.max(0, Math.ceil((room.value.deadlineAt - currentTime.value) / 1000)));
  const expired = computed(() => secondsLeft.value === 0);
  onMounted(() => {
    interval = setInterval(update, 250);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pageshow', update);
  });
  onBeforeUnmount(() => {
    clearInterval(interval);
    document.removeEventListener('visibilitychange', update);
    window.removeEventListener('pageshow', update);
  });
  return { secondsLeft, expired };
}
