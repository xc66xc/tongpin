import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createApp } from '../apps/server/src/app';
import type {
  ClientEvents, Command, Credentials, GameAction, Reply, RoomSnapshot, ServerEvents,
} from '../packages/shared/src/index';

type Success = Extract<Reply, { ok: true }>;
interface Player {
  socket: Socket<ServerEvents, ClientEvents>;
  credentials: Credentials;
  snapshot: RoomSnapshot;
  received: RoomSnapshot[];
}

describe('双人对词真实 SQLite / Socket.IO 联机', () => {
  let directory: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let baseUrl: string;
  const clients = new Set<Socket<ServerEvents, ClientEvents>>();

  async function startServer() {
    app = await createApp({ dbPath: join(directory, 'game.db'), logger: false });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tongpin-test-'));
    await startServer();
  });

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    clients.clear();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function connect() {
    const socket: Socket<ServerEvents, ClientEvents> = io(baseUrl, {
      autoConnect: false, forceNew: true, reconnection: false, transports: ['websocket'],
    });
    clients.add(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接超时')), 4_000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
      socket.connect();
    });
    return socket;
  }

  async function request(socket: Player['socket'], command: Command): Promise<Reply> {
    return socket.timeout(4_000).emitWithAck('command', command);
  }

  function requireSuccess(reply: Reply): Success {
    if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
    return reply;
  }

  async function enter(command: Command): Promise<Player> {
    const socket = await connect();
    const received: RoomSnapshot[] = [];
    socket.on('snapshot', (snapshot) => received.push(snapshot));
    const response = requireSuccess(await request(socket, command));
    const credentials = response.credentials ?? (command.action === 'resume'
      ? { roomCode: command.roomCode, token: command.token } : undefined);
    if (!credentials) throw new Error('创建或加入房间未返回身份凭证');
    const player = { socket, credentials, snapshot: response.snapshot, received };
    socket.on('snapshot', (snapshot) => { player.snapshot = snapshot; });
    return player;
  }

  async function waitFor(player: Player, predicate: (snapshot: RoomSnapshot) => boolean) {
    if (predicate(player.snapshot)) return player.snapshot;
    return new Promise<RoomSnapshot>((resolve, reject) => {
      const listener = (snapshot: RoomSnapshot) => {
        if (!predicate(snapshot)) return;
        clearTimeout(timer);
        player.socket.off('snapshot', listener);
        resolve(snapshot);
      };
      const timer = setTimeout(() => {
        player.socket.off('snapshot', listener);
        reject(new Error(`未收到预期状态，当前状态：${JSON.stringify(player.snapshot)}`));
      }, 4_000);
      player.socket.on('snapshot', listener);
    });
  }

  async function pair() {
    const host = await enter({ action: 'create' });
    const guest = await enter({ action: 'join', roomCode: host.credentials.roomCode });
    await waitFor(host, (snapshot) => snapshot.phase === 'playing');
    return { host, guest };
  }

  function action(player: Player, name: GameAction, word?: string): Command {
    return {
      action: name, gameNumber: player.snapshot.gameNumber,
      roundNumber: player.snapshot.roundNumber, ...(word === undefined ? {} : { word }),
    };
  }

  async function play(player: Player, name: GameAction, word?: string) {
    // A promise continuation for an older ACK may run after a newer broadcast
    // in the same Socket.IO packet batch; compare authoritative revisions.
    const response = requireSuccess(await request(player.socket, action(player, name, word)));
    if (response.snapshot.revision >= player.snapshot.revision) player.snapshot = response.snapshot;
    return response.snapshot;
  }

  async function reveal(host: Player, guest: Player) {
    await play(host, 'submit', '大海');
    await play(guest, 'submit', '沙滩');
    await waitFor(host, (snapshot) => snapshot.phase === 'revealed');
  }

  it('第二人加入才开始，并拒绝第三人占用同一房间', async () => {
    const host = await enter({ action: 'create' });
    expect(host.snapshot.phase).toBe('waiting');
    expect(host.snapshot.opponent).toBeNull();
    const guest = await enter({ action: 'join', roomCode: host.credentials.roomCode });
    expect(guest.snapshot.phase).toBe('playing');
    const third = await connect();
    const reply = await request(third, { action: 'join', roomCode: host.credentials.roomCode });
    expect(reply.ok).toBe(false);
  });

  it('揭晓前只发布提交状态，不通过快照或回复泄漏对方的词', async () => {
    const { host, guest } = await pair();
    await play(host, 'submit', '  海风暗号  ');
    await waitFor(guest, (snapshot) => snapshot.opponent?.submitted === true);
    expect(host.snapshot.self.word).toBe('海风暗号');
    expect(guest.snapshot.opponent).toMatchObject({ submitted: true, word: null });
    expect(guest.received.every((snapshot) => !JSON.stringify(snapshot).includes('海风暗号'))).toBe(true);
    expect(guest.snapshot.history).toEqual([]);
    await play(guest, 'submit', '海边的风');
    expect(guest.snapshot).toMatchObject({ phase: 'revealed', endReason: null });
    expect(guest.snapshot.history).toEqual([{ roundNumber: 1, words: ['海风暗号', '海边的风'] }]);
    expect(JSON.stringify(guest.snapshot)).not.toContain(host.credentials.token);
  });

  it('双方去掉首尾空格后相同的词自动结束并且只记录一轮', async () => {
    const { host, guest } = await pair();
    await play(host, 'submit', '  苹果  ');
    await play(guest, 'submit', '苹果');
    const snapshot = await waitFor(host, (value) => value.phase === 'ended');
    expect(snapshot).toMatchObject({ endReason: 'matched', roundNumber: 1 });
    expect(snapshot.history).toEqual([{ roundNumber: 1, words: ['苹果', '苹果'] }]);
  });

  it.each(['', '   ', '词'.repeat(31)])('拒绝空白或过长输入 %#，并保留未提交状态', async (word) => {
    const { host } = await pair();
    const reply = await request(host.socket, action(host, 'submit', word));
    expect(reply.ok).toBe(false);
    const resumed = requireSuccess(await request(host.socket, { action: 'resume', ...host.credentials }));
    expect(resumed.snapshot.self.submitted).toBe(false);
  });

  it('重复提交不能覆盖已经锁定的词', async () => {
    const { host, guest } = await pair();
    await play(host, 'submit', '原词');
    const reply = await request(host.socket, action(host, 'submit', '想改的词'));
    expect(reply.ok).toBe(false);
    await play(guest, 'submit', '另一个词');
    expect(guest.snapshot.history[0]?.words).toEqual(['原词', '另一个词']);
  });

  it('双方都确认才进入下一轮，单方举手跨轮保留且无法撤回', async () => {
    const { host, guest } = await pair();
    await play(host, 'raise');
    await reveal(host, guest);
    await play(host, 'next');
    expect(host.snapshot).toMatchObject({ phase: 'revealed', roundNumber: 1 });
    expect(host.snapshot.self.nextReady).toBe(true);
    await play(guest, 'next');
    const snapshot = await waitFor(host, (value) => value.phase === 'playing' && value.roundNumber === 2);
    expect(snapshot.self).toMatchObject({ raised: true, nextReady: false, submitted: false, word: null });
    expect(snapshot.opponent?.submitted).toBe(false);
    const duplicateRaise = await request(host.socket, action(host, 'raise'));
    if (duplicateRaise.ok) expect(duplicateRaise.snapshot.self.raised).toBe(true);
    const resumed = requireSuccess(await request(host.socket, { action: 'resume', ...host.credentials }));
    expect(resumed.snapshot.self.raised).toBe(true);
  });

  it('双方举手立即结束，尚未双方提交的一轮不计入结果也不泄漏词', async () => {
    const { host, guest } = await pair();
    await play(host, 'submit', '未揭晓机密');
    await play(host, 'raise');
    await play(guest, 'raise');
    expect(guest.snapshot).toMatchObject({ phase: 'ended', endReason: 'consensus', history: [] });
    expect(guest.snapshot.opponent?.word).toBeNull();
    expect(JSON.stringify(guest.snapshot)).not.toContain('未揭晓机密');
    expect((await request(guest.socket, action(guest, 'submit', '太迟了'))).ok).toBe(false);
  });

  it('双方揭晓后举手结束，保留已揭晓的历史词语', async () => {
    const { host, guest } = await pair();
    await reveal(host, guest);
    await Promise.all([play(host, 'raise'), play(guest, 'raise')]);
    const result = await waitFor(host, (snapshot) => snapshot.phase === 'ended');
    expect(result.endReason).toBe('consensus');
    expect(result.history).toHaveLength(1);
  });

  it('过期轮次请求不会将上一轮的词写入下一轮', async () => {
    const { host, guest } = await pair();
    const stale = action(host, 'submit', '迟到的词');
    await reveal(host, guest);
    await play(host, 'next');
    await play(guest, 'next');
    await waitFor(host, (snapshot) => snapshot.roundNumber === 2);
    expect((await request(host.socket, stale)).ok).toBe(false);
    const resumed = requireSuccess(await request(host.socket, { action: 'resume', ...host.credentials }));
    expect(resumed.snapshot.self).toMatchObject({ submitted: false, word: null });
  });

  it('再来一局需要双方准备，重置举手与历史，并拒绝上一局的请求', async () => {
    const { host, guest } = await pair();
    const stale = action(host, 'raise');
    await play(host, 'raise');
    await play(guest, 'raise');
    await waitFor(host, (snapshot) => snapshot.phase === 'ended');
    await play(host, 'again');
    expect(host.snapshot.phase).toBe('ended');
    expect(host.snapshot.self.rematchReady).toBe(true);
    await play(guest, 'again');
    const restarted = await waitFor(host, (snapshot) => snapshot.gameNumber === 2);
    expect(restarted).toMatchObject({ phase: 'playing', roundNumber: 1, endReason: null, history: [] });
    expect(restarted.self).toMatchObject({ raised: false, nextReady: false, rematchReady: false });
    expect((await request(host.socket, stale)).ok).toBe(false);
  });

  it('随机凭证不能冒充已有玩家，合法凭证断线后恢复自己的座位与提交', async () => {
    const { host, guest } = await pair();
    await play(host, 'submit', '海风');
    host.socket.disconnect();
    await waitFor(guest, (snapshot) => snapshot.opponent?.online === false);
    const attacker = await connect();
    const denied = await request(attacker, {
      action: 'resume', roomCode: host.credentials.roomCode, token: '0'.repeat(64),
    });
    expect(denied.ok).toBe(false);
    const resumed = await enter({ action: 'resume', ...host.credentials });
    expect(resumed.snapshot.self).toMatchObject({ seat: 1, submitted: true, word: '海风', online: true });
    await waitFor(guest, (snapshot) => snapshot.opponent?.online === true);
    expect(guest.snapshot.opponent?.word).toBeNull();
  });

  it('服务器重启后从同一 SQLite 文件恢复当前轮次、提交和举手', async () => {
    const { host, guest } = await pair();
    await play(host, 'submit', '重启后仍在');
    await play(guest, 'raise');
    const previousRevision = guest.snapshot.revision;
    for (const client of clients) client.disconnect();
    clients.clear();
    await app.close();
    await startServer();
    const restored = await enter({ action: 'resume', ...host.credentials });
    expect(restored.snapshot).toMatchObject({ phase: 'playing', gameNumber: 1, roundNumber: 1 });
    expect(restored.snapshot.self).toMatchObject({ submitted: true, word: '重启后仍在' });
    expect(restored.snapshot.opponent).toMatchObject({ online: false, raised: true, word: null });
    expect(restored.snapshot.revision).toBeGreaterThan(previousRevision);
  });

  it('同一玩家两个标签页中只关闭一个，不将该玩家误报为离线', async () => {
    const { host, guest } = await pair();
    const secondTab = await enter({ action: 'resume', ...host.credentials });
    const connectedRevision = secondTab.snapshot.revision;
    host.socket.disconnect();
    const refreshed = requireSuccess(await request(guest.socket, { action: 'resume', ...guest.credentials }));
    expect(refreshed.snapshot.opponent?.online).toBe(true);
    secondTab.socket.disconnect();
    const disconnected = await waitFor(guest, (snapshot) => snapshot.opponent?.online === false);
    expect(disconnected.phase).toBe('playing');
    expect(disconnected.revision).toBeGreaterThan(connectedRevision);
  });

  it('两人同时争抢最后一个座位时仅一人成功', async () => {
    const host = await enter({ action: 'create' });
    const first = await connect();
    const second = await connect();
    const replies = await Promise.all([
      request(first, { action: 'join', roomCode: host.credentials.roomCode }),
      request(second, { action: 'join', roomCode: host.credentials.roomCode }),
    ]);
    expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
    expect(replies.filter((reply) => !reply.ok)).toHaveLength(1);
  });

  it('定时清理向在线双方发送过期事件，并移除原房间操作身份', async () => {
    await app.close();
    let time = 1_000;
    app = await createApp({
      dbPath: join(directory, 'game.db'), logger: false,
      now: () => time, ttlMs: 100, cleanupIntervalMs: 5,
    });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const { host, guest } = await pair();
    const expired = Promise.all([host, guest].map((player) => new Promise<void>((resolve) => {
      player.socket.once('expired', () => resolve());
    })));
    time += 101;
    await expired;
    const reply = await request(host.socket, action(host, 'raise'));
    expect(reply.ok).toBe(false);
    const nextRoom = requireSuccess(await request(host.socket, { action: 'create' }));
    expect(nextRoom.snapshot.phase).toBe('waiting');
  });
});
