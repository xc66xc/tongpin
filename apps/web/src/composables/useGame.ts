import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { io, type Socket } from 'socket.io-client';
import type { ClientEvents, Command, Credentials, GameAction, Reply, RoomSnapshot, ServerEvents } from '@tongpin/shared';

const CREDENTIALS_KEY = 'tongpin.credentials.v1';
const CURRENT_KEY = 'tongpin.current-room.v1';

function isCredentials(value: unknown): value is Credentials {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.roomCode === 'string' && /^\d{6}$/.test(entry.roomCode)
    && typeof entry.token === 'string' && /^[a-f0-9]{64}$/.test(entry.token);
}

export function useGame() {
  const snapshot = ref<RoomSnapshot | null>(null);
  const connection = ref<'connecting' | 'connected' | 'offline' | 'recovering'>('connecting');
  const busy = ref(false);
  const error = ref('');
  const storageWarning = ref('');
  const uncertain = ref(false);
  const inviteCode = new URLSearchParams(window.location.search).get('room') ?? '';
  const roomCode = ref(/^\d{6}$/.test(inviteCode) ? inviteCode : '');
  const savedRoom = ref('');
  let credentials: Credentials | null = null;
  let epoch = 0;
  let disposed = false;
  let credentialsByRoom: Record<string, Credentials> = {};
  const pendingSnapshots = new Map<string, RoomSnapshot>();
  const socket: Socket<ServerEvents, ClientEvents> = io({ autoConnect: false, path: `${import.meta.env.BASE_URL}socket.io` });
  const canAct = computed(() => connection.value === 'connected' && !busy.value && !uncertain.value);

  function warnStorage() {
    storageWarning.value = '浏览器无法保存玩家身份。本次可继续，请勿刷新或关闭页面，否则可能无法回到原来的位置。';
  }
  function saveCredentials(value: Credentials) {
    if (!credentials || credentials.roomCode !== value.roomCode || credentials.token !== value.token) snapshot.value = null;
    credentials = value;
    credentialsByRoom[value.roomCode] = value;
    savedRoom.value = value.roomCode;
    try {
      localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentialsByRoom));
      sessionStorage.setItem(CURRENT_KEY, value.roomCode);
    } catch { warnStorage(); }
    const url = new URL(window.location.href);
    url.searchParams.set('room', value.roomCode);
    window.history.replaceState(null, '', url);
  }
  function readCredentials() {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(CREDENTIALS_KEY) ?? '{}');
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw)) {
          if (isCredentials(value) && value.roomCode === key) credentialsByRoom[key] = value;
        }
      }
      const current = sessionStorage.getItem(CURRENT_KEY) ?? '';
      const chosen = roomCode.value || current;
      credentials = credentialsByRoom[chosen] ?? null;
      savedRoom.value = credentials?.roomCode ?? '';
    } catch { warnStorage(); }
  }
  function applySnapshot(value: RoomSnapshot) {
    if (!credentials || value.roomCode !== credentials.roomCode) return;
    const previous = snapshot.value;
    if (previous?.roomCode === value.roomCode && previous.self.seat !== value.self.seat) return;
    if (previous?.roomCode === value.roomCode && (
      value.revision < previous.revision || value.gameNumber < previous.gameNumber
      || (value.gameNumber === previous.gameNumber && value.roundNumber < previous.roundNumber)
    )) return;
    snapshot.value = value;
  }
  function accept(reply: Extract<Reply, { ok: true }>) {
    if (reply.credentials) saveCredentials(reply.credentials);
    applySnapshot(reply.snapshot);
    const buffered = pendingSnapshots.get(reply.snapshot.roomCode);
    if (buffered) applySnapshot(buffered);
    pendingSnapshots.clear();
  }
  function forgetCurrent() {
    if (credentials) delete credentialsByRoom[credentials.roomCode];
    credentials = null;
    savedRoom.value = '';
    snapshot.value = null;
    try {
      localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentialsByRoom));
      sessionStorage.removeItem(CURRENT_KEY);
    } catch { warnStorage(); }
  }
  async function request(command: Command): Promise<Reply> {
    return socket.timeout(8000).emitWithAck('command', command);
  }
  async function recover() {
    if (!credentials || !socket.connected || disposed) return;
    const requestEpoch = epoch;
    connection.value = 'recovering';
    busy.value = true;
    try {
      const reply = await request({ action: 'resume', ...credentials });
      if (disposed || requestEpoch !== epoch) return;
      if (reply.ok) {
        accept(reply);
        error.value = '';
        uncertain.value = false;
      } else {
        error.value = reply.error.message;
        if (['ROOM_NOT_FOUND', 'ROOM_EXPIRED', 'INVALID_TOKEN', 'UNAUTHORIZED'].includes(reply.error.code)) forgetCurrent();
      }
      connection.value = socket.connected ? 'connected' : 'offline';
    } catch {
      if (requestEpoch === epoch && !disposed) {
        connection.value = 'offline';
        error.value = '暂时无法恢复房间，请检查网络后点击重新连接。';
      }
    } finally {
      if (requestEpoch === epoch && !disposed) busy.value = false;
    }
  }
  async function send(command: Command) {
    if (!canAct.value) return;
    error.value = '';
    busy.value = true;
    const requestEpoch = epoch;
    try {
      const reply = await request(command);
      if (disposed || requestEpoch !== epoch) return;
      if (reply.ok) accept(reply);
      else error.value = reply.error.message;
    } catch {
      if (requestEpoch !== epoch || disposed) return;
      if (credentials) {
        error.value = '操作结果尚未确认，正在重新同步。';
        await recover();
      } else {
        uncertain.value = true;
        error.value = '请求结果尚未确认，已暂停重复操作。请检查网络后刷新；未确认的房间会自动过期。';
      }
    } finally {
      if (requestEpoch === epoch && !disposed) busy.value = false;
    }
  }
  function createRoom(settings: { playerCount: 2 | 3; roundSeconds: number } = { playerCount: 2, roundSeconds: 30 }) {
    return send({ action: 'create', ...settings });
  }
  async function joinRoom(code: string) {
    const clean = code.trim();
    if (!/^\d{6}$/.test(clean)) { error.value = '请输入 6 位数字房间码。'; return; }
    if (credentialsByRoom[clean]) {
      if (!canAct.value) return;
      credentials = credentialsByRoom[clean] ?? null;
      await recover();
      return;
    }
    return send({ action: 'join', roomCode: clean });
  }
  function act(action: GameAction, word?: string) {
    const room = snapshot.value;
    if (!room) return Promise.resolve();
    return send({ action, gameNumber: room.gameNumber, roundNumber: room.roundNumber, ...(word === undefined ? {} : { word }) });
  }
  function goHome() {
    epoch += 1;
    credentials = null;
    snapshot.value = null;
    busy.value = false;
    uncertain.value = false;
    error.value = '';
    try { sessionStorage.removeItem(CURRENT_KEY); } catch { warnStorage(); }
    window.history.replaceState(null, '', window.location.pathname);
    socket.disconnect();
    socket.connect();
  }
  function reconnect() {
    if (credentials && socket.connected) void recover();
    else { connection.value = 'connecting'; socket.connect(); }
  }
  function onConnect() {
    connection.value = 'connected';
    if (credentials) void recover();
  }
  function onDisconnect() {
    if (busy.value && !credentials) {
      uncertain.value = true;
      error.value = '请求结果尚未确认，已暂停重复操作。请检查网络后刷新；未确认的房间会自动过期。';
    }
    epoch += 1;
    busy.value = false;
    pendingSnapshots.clear();
    connection.value = 'offline';
  }
  function onConnectError() { connection.value = 'offline'; }
  function onBrowserOffline() {
    socket.disconnect();
    connection.value = 'offline';
  }
  function onBrowserOnline() {
    connection.value = 'connecting';
    socket.connect();
  }
  function onSnapshot(value: RoomSnapshot) {
    if (!credentials && busy.value) {
      const previous = pendingSnapshots.get(value.roomCode);
      if (!previous || value.revision >= previous.revision) pendingSnapshots.set(value.roomCode, value);
      return;
    }
    applySnapshot(value);
  }
  function onExpired() {
    epoch += 1;
    pendingSnapshots.clear();
    forgetCurrent();
    busy.value = false;
    uncertain.value = false;
    connection.value = socket.connected ? 'connected' : 'offline';
    error.value = '房间因长时间无操作已过期，可以创建新房间。';
  }
  onMounted(() => {
    readCredentials();
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('snapshot', onSnapshot);
    socket.on('expired', onExpired);
    window.addEventListener('offline', onBrowserOffline);
    window.addEventListener('online', onBrowserOnline);
    if (navigator.onLine) socket.connect();
    else connection.value = 'offline';
  });
  onBeforeUnmount(() => {
    disposed = true;
    epoch += 1;
    window.removeEventListener('offline', onBrowserOffline);
    window.removeEventListener('online', onBrowserOnline);
    socket.removeAllListeners();
    socket.disconnect();
  });
  return { snapshot, connection, busy, error, storageWarning, uncertain, roomCode, savedRoom, canAct, createRoom, joinRoom, act, goHome, reconnect };
}
