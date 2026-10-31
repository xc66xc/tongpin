import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameDatabase } from '../apps/server/src/db';
import { GameService, type Identity } from '../apps/server/src/game';
import type { GameAction } from '../packages/shared/src/index';

describe('最大轮次与结束原因优先级', () => {
  let db: GameDatabase;
  let game: GameService;
  let now: number;

  beforeEach(() => {
    now = 1_000;
    db = new GameDatabase(':memory:');
    game = new GameService(db, () => now);
  });
  afterEach(() => db.close());

  function createPlayers(playerCount: 2 | 3, maxRounds: number) {
    const host = game.create({ playerCount, maxRounds, roundSeconds: 5 });
    const players = [host];
    for (let index = 1; index < playerCount; index++) players.push(game.join(host.credentials.roomCode));
    return players;
  }
  function view(identity: Identity) { return game.snapshot(identity, () => true); }
  function act(identity: Identity, action: GameAction, word?: string) {
    const snapshot = view(identity);
    game.apply(identity, { action, gameNumber: snapshot.gameNumber, roundNumber: snapshot.roundNumber, ...(word === undefined ? {} : { word }) });
  }
  function expectNoExtraRound(identity: Identity, expectedCount: number) {
    expect(db.one<{ count: number }>('SELECT count(*) AS count FROM rounds WHERE rooms_id = ? AND game_number = 1', identity.roomId)?.count).toBe(expectedCount);
  }

  it('默认最多10轮，第10轮不同词结算结束且不创建第11轮', () => {
    const host = game.create();
    const guest = game.join(host.credentials.roomCode);
    expect(view(host.identity).maxRounds).toBe(10);
    for (let round = 1; round <= 10; round++) {
      act(host.identity, 'submit', `甲${round}`);
      act(guest.identity, 'submit', `乙${round}`);
    }
    expect(view(host.identity)).toMatchObject({ phase: 'ended', endReason: 'round_limit', maxRounds: 10,
      roundNumber: 10, historyCount: 10, deadlineAt: null });
    expectNoExtraRound(host.identity, 10);
  });

  it.each([2, 3] as const)('%i人最后一轮不同词时结束，重开必须全员准备并沿用最大轮次', playerCount => {
    const players = createPlayers(playerCount, 2);
    for (let round = 1; round <= 2; round++) {
      for (const player of players) act(player.identity, 'submit', `词${player.identity.seat}`);
    }
    const identity = players[0].identity;
    const ended = view(identity);
    expect(ended).toMatchObject({ phase: 'ended', endReason: 'round_limit', roundNumber: 2,
      historyCount: 2, deadlineAt: null, maxRounds: 2 });
    expect(ended.history.at(-1)?.words).toEqual(players.map(player => `词${player.identity.seat}`));
    expectNoExtraRound(identity, 2);
    now += 6_000;
    expect(game.processTimeouts()).toEqual([]);
    act(identity, 'raise');
    expect(view(identity).endReason).toBe('round_limit');
    expect(() => act(identity, 'submit', '不能再作答')).toThrow();
    for (const player of players.slice(0, -1)) act(player.identity, 'again');
    expect(view(identity).phase).toBe('ended');
    act(players.at(-1)!.identity, 'again');
    expect(view(identity)).toMatchObject({ phase: 'playing', endReason: null, maxRounds: 2,
      gameNumber: 2, roundNumber: 1, history: [], historyCount: 0, deadlineAt: now + 5_000 });
  });

  it.each([2, 3] as const)('%i人最后一轮全员同词时匹配成功优先于轮次上限', playerCount => {
    const players = createPlayers(playerCount, 1);
    for (const player of players) act(player.identity, 'submit', '同频');
    expect(view(players[0].identity)).toMatchObject({ phase: 'ended', endReason: 'matched', maxRounds: 1,
      roundNumber: 1, historyCount: 1, deadlineAt: null });
    expectNoExtraRound(players[0].identity, 1);
  });

  it.each([2, 3] as const)('%i人最后一轮全员举手仍为共识结束，不消耗未揭晓轮次', playerCount => {
    const players = createPlayers(playerCount, 1);
    act(players[0].identity, 'submit', '还没揭晓的词');
    now += 4_999;
    for (const player of players) act(player.identity, 'raise');
    const snapshot = view(players.at(-1)!.identity);
    expect(snapshot).toMatchObject({ phase: 'ended', endReason: 'consensus', historyCount: 0, history: [], deadlineAt: null });
    expect(JSON.stringify(snapshot)).not.toContain('还没揭晓的词');
    expectNoExtraRound(players[0].identity, 1);
  });

  it.each([
    { playerCount: 2 as const, partial: false }, { playerCount: 3 as const, partial: false },
    { playerCount: 2 as const, partial: true }, { playerCount: 3 as const, partial: true },
  ])('最后一轮到时结束，不因缺答而无限续轮：%j', ({ playerCount, partial }) => {
    const players = createPlayers(playerCount, 1);
    if (partial) for (const player of players.slice(0, -1)) act(player.identity, 'submit', '相同但未齐');
    now += 5_000;
    expect(game.processTimeouts()).toEqual([players[0].identity.roomId]);
    const snapshot = view(players[0].identity);
    expect(snapshot).toMatchObject({ phase: 'ended', endReason: 'round_limit', maxRounds: 1,
      roundNumber: 1, historyCount: 1, deadlineAt: null });
    expect(snapshot.history[0].words).toEqual(players.map((_, index) => partial && index < playerCount - 1 ? '相同但未齐' : null));
    expectNoExtraRound(players[0].identity, 1);
    expect(game.processTimeouts()).toEqual([]);
  });

  it('最后一轮截止瞬间迟到提交不能回滚结束或生成新轮', () => {
    const players = createPlayers(3, 1);
    act(players[0].identity, 'submit', '相同');
    act(players[1].identity, 'submit', '相同');
    now += 5_000;
    expect(() => game.apply(players[2].identity, { action: 'submit', gameNumber: 1, roundNumber: 1, word: '相同' })).toThrow();
    expect(view(players[2].identity)).toMatchObject({ phase: 'ended', endReason: 'round_limit',
      history: [{ roundNumber: 1, words: ['相同', '相同', null] }], deadlineAt: null });
    expectNoExtraRound(players[0].identity, 1);
  });

  it('旧revealed房间恢复时也遵守上限，合法凭证不能直接越过最后轮', () => {
    const players = createPlayers(2, 1);
    const id = players[0].identity.roomId;
    db.run("UPDATE rounds SET word_one = '云', word_two = '风', is_revealed = 1 WHERE rooms_id = ?", id);
    db.run("UPDATE rooms SET phase = 'revealed' WHERE id = ?", id);
    expect(() => game.resume(players[0].credentials.roomCode, 'wrong-token')).toThrow();
    expect(view(players[0].identity).phase).toBe('revealed');
    const restored = game.resume(players[0].credentials.roomCode, players[0].credentials.token);
    expect(view(restored)).toMatchObject({ phase: 'ended', endReason: 'round_limit', roundNumber: 1, deadlineAt: null });
    game.resume(players[1].credentials.roomCode, players[1].credentials.token);
    expectNoExtraRound(restored, 1);
  });

  it.each([1, 20, 1000])('支持整数最大轮次边界或预设 %i', maxRounds => {
    const host = game.create({ maxRounds });
    expect(view(host.identity).maxRounds).toBe(maxRounds);
  });
  it.each([0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY])('服务端拒绝非法最大轮次 %s', maxRounds => {
    expect(() => game.create({ maxRounds })).toThrow();
  });
});
