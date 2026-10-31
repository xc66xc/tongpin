import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createApp } from '../apps/server/src/app';
import { GameService } from '../apps/server/src/game';
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

describe('多人对词真实 SQLite / Socket.IO 联机', () => {
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
    await waitFor(host, (snapshot) => snapshot.phase === 'playing' && snapshot.roundNumber === 2);
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
    expect(guest.snapshot).toMatchObject({ phase: 'playing', roundNumber: 2, endReason: null });
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

  it('不同词语揭晓后自动进入下一轮，单方举手跨轮保留且无法撤回', async () => {
    const { host, guest } = await pair();
    await play(host, 'raise');
    await reveal(host, guest);
    const snapshot = await waitFor(host, (value) => value.phase === 'playing' && value.roundNumber === 2);
    expect(snapshot.self).toMatchObject({ raised: true, nextReady: false, submitted: false, word: null });
    expect(snapshot.opponent?.submitted).toBe(false);
    expect(snapshot.history).toEqual([{ roundNumber: 1, words: ['大海', '沙滩'] }]);
    // Legacy confirmation requests must never skip a fresh round.
    expect((await request(host.socket, action(host, 'next'))).ok).toBe(false);
    expect((await request(guest.socket, action(guest, 'next'))).ok).toBe(false);
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

  it('已提交的一方离线时仍自动进入下一轮，重连恢复上一轮揭晓与新输入状态', async () => {
    const { host, guest } = await pair();
    await play(host, 'submit', '大海');
    host.socket.disconnect();
    await waitFor(guest, value => value.opponent?.online === false);
    await play(guest, 'submit', '沙滩');
    expect(guest.snapshot).toMatchObject({ phase: 'playing', roundNumber: 2 });
    expect(guest.snapshot.self).toMatchObject({ submitted: false, word: null });
    const restored = await enter({ action: 'resume', ...host.credentials });
    expect(restored.snapshot).toMatchObject({ phase: 'playing', roundNumber: 2 });
    expect(restored.snapshot.self).toMatchObject({ submitted: false, word: null });
    expect(restored.snapshot.history).toEqual([{ roundNumber: 1, words: ['大海', '沙滩'] }]);
  });

  it('自动续轮后到达的同局旧轮举手仍生效，但未来轮举手和旧轮词语不会生效', async () => {
    const { host, guest } = await pair();
    await play(host, 'submit', '大海');
    const delayedRaise = action(host, 'raise');
    const delayedWord = action(host, 'submit', '迟到的词');
    await play(guest, 'submit', '沙滩');
    const raised = requireSuccess(await request(host.socket, delayedRaise));
    expect(raised.snapshot).toMatchObject({ phase: 'playing', roundNumber: 2, self: { raised: true, submitted: false } });
    const futureRaise = { ...delayedRaise, roundNumber: 3 };
    expect((await request(guest.socket, futureRaise)).ok).toBe(false);
    expect((await request(host.socket, delayedWord)).ok).toBe(false);
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

  it('三人联机等待满员，前两份词对第三人保密，第三份提交后一起揭晓', async () => {
    const host = await enter({ action: 'create', playerCount: 3, roundSeconds: 45 });
    const second = await enter({ action: 'join', roomCode: host.credentials.roomCode });
    expect(second.snapshot).toMatchObject({ phase: 'waiting', playerCount: 3, roundSeconds: 45, deadlineAt: null });
    const third = await enter({ action: 'join', roomCode: host.credentials.roomCode });
    await waitFor(host, value => value.phase === 'playing');
    await waitFor(second, value => value.phase === 'playing');
    expect(third.snapshot.self.seat).toBe(3);
    await play(host, 'submit', '三人暗号');
    await play(second, 'submit', '三人暗号');
    await waitFor(third, value => value.opponents.every(player => player.submitted));
    expect(third.snapshot.opponents.every(player => player.word === null)).toBe(true);
    expect(third.received.every(value => !JSON.stringify(value).includes('三人暗号'))).toBe(true);
    await play(third, 'submit', '另一种答案');
    const revealed = await waitFor(host, value => value.roundNumber === 2);
    expect(revealed.history).toEqual([{ roundNumber: 1, words: ['三人暗号', '三人暗号', '另一种答案'] }]);
    expect(revealed.historyCount).toBe(1);
    expect(revealed.phase).toBe('playing');
  });

  it.each([
    { playerCount: 1 }, { playerCount: 4 }, { roundSeconds: 4 },
    { roundSeconds: 3601 }, { roundSeconds: 5.5 }, { roundSeconds: '30' },
  ])('创建房间拒绝非法人数或时间 %j', async settings => {
    const socket = await connect();
    const reply = await request(socket, { action: 'create', ...settings } as Command);
    expect(reply).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('定时器向三端广播部分超时与全空续轮，时间内重连不重置截止时间', async () => {
    await app.close();
    let time = 1_000;
    app = await createApp({ dbPath: join(directory, 'game.db'), now: () => time });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const host = await enter({ action: 'create', playerCount: 3, roundSeconds: 5 });
    const second = await enter({ action: 'join', roomCode: host.credentials.roomCode });
    const third = await enter({ action: 'join', roomCode: host.credentials.roomCode });
    await waitFor(host, value => value.phase === 'playing');
    await play(host, 'submit', '及时的答案');
    time += 2_000;
    const restored = requireSuccess(await request(third.socket, { action: 'resume', ...third.credentials }));
    expect(restored.snapshot.deadlineAt).toBe(6_000);
    time = 6_000;
    const partial = await Promise.all([host, second, third].map(player => waitFor(player, value => value.roundNumber === 2)));
    for (const snapshot of partial) {
      expect(snapshot.history).toEqual([{ roundNumber: 1, words: ['及时的答案', null, null] }]);
      expect(snapshot.deadlineAt).toBe(11_000);
    }
    time = 11_000;
    const empty = await Promise.all([host, second, third].map(player => waitFor(player, value => value.roundNumber === 3)));
    for (const snapshot of empty) {
      expect(snapshot.history.at(-1)).toEqual({ roundNumber: 2, words: [null, null, null] });
      expect(snapshot.phase).toBe('playing');
    }
  });


  it('关闭应用时停止截止扫描，不在数据库关闭后继续调用定时任务', async () => {
    await app.close();
    const scan = vi.spyOn(GameService.prototype, 'processTimeouts');
    try {
      app = await createApp({ dbPath: join(directory, 'game.db'), timeoutIntervalMs: 5 });
      await app.listen({ port: 0, host: '127.0.0.1' });
      await vi.waitFor(() => expect(scan).toHaveBeenCalled(), { interval: 5, timeout: 500 });
      await app.close();
      const countAtClose = scan.mock.calls.length;
      await new Promise<void>(resolve => setTimeout(resolve, 30));
      expect(scan).toHaveBeenCalledTimes(countAtClose);
    } finally {
      scan.mockRestore();
    }
  });


  it('迟到提交触发结算并返回错误时，三端仍收到同一份新轮快照', async () => {
    await app.close();
    let time = 1_000;
    app = await createApp({ dbPath: join(directory, 'game.db'), now: () => time, timeoutIntervalMs: 60_000 });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const host = await enter({ action: 'create', playerCount: 3, roundSeconds: 5 });
    const second = await enter({ action: 'join', roomCode: host.credentials.roomCode });
    const third = await enter({ action: 'join', roomCode: host.credentials.roomCode });
    await waitFor(host, value => value.phase === 'playing');
    const lateCommand = action(host, 'submit', '迟到不能入库');
    time = 6_000;
    expect(await request(host.socket, lateCommand)).toMatchObject({ ok: false, error: { code: 'STALE_COMMAND' } });
    const snapshots = await Promise.all([host, second, third].map(player => waitFor(player, value => value.roundNumber === 2)));
    for (const snapshot of snapshots) {
      expect(snapshot.history).toEqual([{ roundNumber: 1, words: [null, null, null] }]);
      expect(JSON.stringify(snapshot)).not.toContain('迟到不能入库');
    }
  });

});
