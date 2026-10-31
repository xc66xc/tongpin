import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameDatabase } from '../apps/server/src/db';
import { GameService, type Identity } from '../apps/server/src/game';
import type { GameAction } from '../packages/shared/src/index';

describe('多人限时作答与服务器截止时间', () => {
  let db: GameDatabase;
  let game: GameService;
  let now: number;

  beforeEach(() => {
    now = 1_000;
    db = new GameDatabase(':memory:');
    game = new GameService(db, () => now);
  });
  afterEach(() => db.close());

  function room(playerCount: 2 | 3 = 3, roundSeconds = 5) {
    const host = game.create({ playerCount, roundSeconds });
    const people = [host];
    for (let index = 1; index < playerCount; index++) people.push(game.join(host.credentials.roomCode));
    return people;
  }
  function view(identity: Identity) { return game.snapshot(identity, () => true); }
  function act(identity: Identity, action: GameAction, word?: string) {
    const snapshot = view(identity);
    game.apply(identity, { action, gameNumber: snapshot.gameNumber, roundNumber: snapshot.roundNumber, ...(word === undefined ? {} : { word }) });
  }

  it('默认双人30秒，三人房间人数齐全时才创建共同截止时间', () => {
    const defaultRoom = game.create();
    expect(view(defaultRoom.identity)).toMatchObject({ playerCount: 2, roundSeconds: 30, deadlineAt: null });
    const host = game.create({ playerCount: 3, roundSeconds: 45 });
    now += 10_000;
    const second = game.join(host.credentials.roomCode);
    expect(view(second.identity)).toMatchObject({ phase: 'waiting', playerCount: 3, roundSeconds: 45, deadlineAt: null });
    now += 10_000;
    const third = game.join(host.credentials.roomCode);
    expect(view(host.identity)).toMatchObject({ phase: 'playing', deadlineAt: now + 45_000, serverNow: now });
    expect(view(third.identity).opponents.map(player => player.seat)).toEqual([1, 2]);
    expect(() => game.join(host.credentials.roomCode)).toThrow();
  });

  it('三人所有词都提交后才揭晓，任意两人相同不足以结束', () => {
    const [host, second, third] = room();
    act(host.identity, 'submit', '海风暗号');
    act(second.identity, 'submit', '海风暗号');
    const hidden = view(third.identity);
    expect(hidden).toMatchObject({ phase: 'playing', roundNumber: 1, history: [] });
    expect(hidden.opponents.map(player => ({ submitted: player.submitted, word: player.word })))
      .toEqual([{ submitted: true, word: null }, { submitted: true, word: null }]);
    expect(JSON.stringify(hidden)).not.toContain('海风暗号');
    act(third.identity, 'submit', '海边的风');
    expect(view(host.identity)).toMatchObject({ phase: 'playing', roundNumber: 2, historyCount: 1,
      history: [{ roundNumber: 1, words: ['海风暗号', '海风暗号', '海边的风'] }], deadlineAt: now + 5_000 });
  });

  it('三人全部同词才成功，结束后不再被到期扫描推进', () => {
    const players = room();
    for (const player of players) act(player.identity, 'submit', '苹果');
    expect(view(players[0].identity)).toMatchObject({ phase: 'ended', endReason: 'matched', historyCount: 1, deadlineAt: null });
    now += 6_000;
    expect(game.processTimeouts()).toEqual([]);
    expect(view(players[0].identity).roundNumber).toBe(1);
  });

  it('三人全部举手才结束，三人全部准备才重开且保留房间人数时长', () => {
    const players = room(3, 60);
    act(players[0].identity, 'submit', '未揭晓机密');
    act(players[0].identity, 'raise');
    act(players[1].identity, 'raise');
    expect(view(players[2].identity).phase).toBe('playing');
    act(players[2].identity, 'raise');
    const ended = view(players[2].identity);
    expect(ended).toMatchObject({ phase: 'ended', endReason: 'consensus', history: [], deadlineAt: null });
    expect(JSON.stringify(ended)).not.toContain('未揭晓机密');
    act(players[0].identity, 'again');
    act(players[1].identity, 'again');
    expect(view(players[0].identity).phase).toBe('ended');
    now += 1_000;
    act(players[2].identity, 'again');
    expect(view(players[0].identity)).toMatchObject({ phase: 'playing', gameNumber: 2, roundNumber: 1,
      playerCount: 3, roundSeconds: 60, deadlineAt: now + 60_000, history: [], historyCount: 0 });
    for (const player of players) expect(view(player.identity).self).toMatchObject({ raised: false, rematchReady: false });
  });

  it('到时揭晓部分作答，未作答保留为null并自动进入下一轮', () => {
    const players = room();
    act(players[0].identity, 'submit', '云');
    act(players[2].identity, 'submit', '风');
    now += 4_999;
    expect(game.processTimeouts()).toEqual([]);
    now += 1;
    expect(game.processTimeouts()).toEqual([players[0].identity.roomId]);
    expect(view(players[1].identity)).toMatchObject({ phase: 'playing', roundNumber: 2,
      history: [{ roundNumber: 1, words: ['云', null, '风'] }], deadlineAt: now + 5_000,
      self: { submitted: false, word: null } });
    expect(game.processTimeouts()).toEqual([]);
  });

  it.each([2, 3] as const)('%i人全部未作答仍续轮，null相等不能触发成功', playerCount => {
    const players = room(playerCount);
    now += 5_000;
    expect(game.processTimeouts()).toEqual([players[0].identity.roomId]);
    expect(view(players[0].identity)).toMatchObject({ phase: 'playing', roundNumber: 2, endReason: null,
      history: [{ roundNumber: 1, words: Array(playerCount).fill(null) }] });
  });

  it('截止瞬间的迟到提交被拒绝，但已经结算的新轮不会随拒绝回滚', () => {
    const players = room();
    const command = { action: 'submit' as const, gameNumber: 1, roundNumber: 1, word: '迟到的词' };
    now += 5_000;
    expect(() => game.apply(players[0].identity, command)).toThrow();
    const snapshot = view(players[0].identity);
    expect(snapshot).toMatchObject({ roundNumber: 2, historyCount: 1, self: { submitted: false, word: null } });
    expect(JSON.stringify(snapshot)).not.toContain('迟到的词');
    expect(game.processTimeouts()).toEqual([]);
  });

  it('截止前一毫秒完成全部提交仍可匹配成功', () => {
    const players = room();
    act(players[0].identity, 'submit', '光');
    act(players[1].identity, 'submit', '光');
    now += 4_999;
    act(players[2].identity, 'submit', '光');
    expect(view(players[0].identity)).toMatchObject({ phase: 'ended', endReason: 'matched' });
  });

  it('长时间停机后只结算当前轮，不补跑成百上千个空轮', () => {
    const players = room();
    now += 3_600_000;
    expect(game.processTimeouts()).toEqual([players[0].identity.roomId]);
    expect(view(players[0].identity)).toMatchObject({ roundNumber: 2, historyCount: 1, deadlineAt: now + 5_000 });
    expect(game.processTimeouts()).toEqual([]);
  });

  it('无人自动续轮不延长24小时房间有效期，过期房间不会继续产生轮次', () => {
    const players = room();
    const id = players[0].identity.roomId;
    const expiresAt = db.one<{ expires_at: number }>('SELECT expires_at FROM rooms WHERE id = ?', id)!.expires_at;
    now += 5_000;
    game.processTimeouts();
    expect(db.one<{ expires_at: number }>('SELECT expires_at FROM rooms WHERE id = ?', id)?.expires_at).toBe(expiresAt);
    now = expiresAt;
    expect(game.processTimeouts()).toEqual([]);
    expect(game.cleanup()).toEqual([id]);
  });

  it('到期扫描每次最多结算25个房间，后续批次不会被已续轮房间饿死', () => {
    const ids: number[] = [];
    for (let index = 0; index < 26; index++) ids.push(room(2)[0].identity.roomId);
    now += 5_000;
    const first = game.processTimeouts();
    expect(first).toHaveLength(25);
    const second = game.processTimeouts();
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second])).toEqual(new Set(ids));
    expect(game.processTimeouts()).toEqual([]);
  });

  it('历史快照只返回最近100轮，但总轮数与原始记录保留', () => {
    const players = room();
    for (let index = 0; index < 105; index++) {
      now += 5_000;
      game.processTimeouts();
    }
    const snapshot = view(players[0].identity);
    expect(snapshot.historyCount).toBe(105);
    expect(snapshot.history).toHaveLength(100);
    expect(snapshot.history[0].roundNumber).toBe(6);
    expect(snapshot.history.at(-1)?.roundNumber).toBe(105);
    expect(db.one<{ count: number }>('SELECT count(*) AS count FROM rounds WHERE rooms_id = ?', players[0].identity.roomId)?.count).toBe(106);
  });

  it('连续25个故障房间不会饿死下一批，修复后失败房间可重试收敛', () => {
    const rooms = Array.from({ length: 26 }, () => room(2));
    const healthyId = rooms[25][0].identity.roomId;
    db.connection.exec(`CREATE TRIGGER reject_reveal BEFORE UPDATE OF is_revealed ON rounds
      WHEN OLD.rooms_id != ${healthyId} AND NEW.is_revealed = 1
      BEGIN SELECT RAISE(ABORT, 'injected room failure'); END`);
    now += 5_000;
    const failed: number[] = [];
    expect(game.processTimeouts((_error, roomId) => failed.push(roomId))).toEqual([]);
    expect(failed).toHaveLength(25);
    expect(new Set(failed)).toEqual(new Set(rooms.slice(0, 25).map(players => players[0].identity.roomId)));
    expect(game.processTimeouts()).toEqual([healthyId]);
    expect(view(rooms[25][0].identity).roundNumber).toBe(2);
    expect(view(rooms[0][0].identity).roundNumber).toBe(1);
    expect(game.processTimeouts()).toEqual([]); // Finish this sweep and reset the fairness cursor.
    db.connection.exec('DROP TRIGGER reject_reveal');
    expect(game.processTimeouts()).toHaveLength(25);
    expect(view(rooms[0][0].identity)).toMatchObject({ roundNumber: 2, historyCount: 1 });
  });

});
