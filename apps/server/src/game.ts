import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Command, Credentials, PlayerView, RoomOptions, RoomSnapshot, Seat } from '@tongpin/shared';
import { GameDatabase, type PlayerRow, type RoomRow, type RoundRow } from './db.js';

const ROOM_COLUMNS = 'id, code, revision, phase, game_number, round_number, end_reason, player_count, round_seconds, max_rounds, created_at, updated_at, expires_at';
const PLAYER_COLUMNS = 'id, rooms_id, seat, token_hash, is_raised, is_next_ready, is_rematch_ready';
const ROUND_COLUMNS = 'id, rooms_id, game_number, round_number, word_one, word_two, word_three, deadline_at, is_revealed';
const WORD_COLUMNS = { 1: 'word_one', 2: 'word_two', 3: 'word_three' } as const;
export interface Identity { roomId: number; roomCode: string; seat: Seat }
export class GameError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
type GameCommand = Extract<Command, { gameNumber: number }>;
type OnlineCheck = (roomId: number, seat: Seat) => boolean;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const words = (round: RoundRow, count: number) => [round.word_one, round.word_two, round.word_three].slice(0, count);

export class GameService {
  // Scan past failed rows as well as successful ones; a broken room cannot
  // occupy the oldest batch forever. Cursor resets at the end of each sweep.
  private timeoutCursor = { deadline: -Number.MAX_SAFE_INTEGER, id: 0 };
  constructor(readonly db: GameDatabase, private readonly now = Date.now, private readonly ttlMs = 86_400_000) {}

  private getRoom(id: number): RoomRow {
    const room = this.db.one<RoomRow>(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = ?`, id);
    if (!room || room.expires_at <= this.now()) throw new GameError('ROOM_EXPIRED', '房间不存在或已过期，请创建新房间。');
    return room;
  }
  private findRoom(code: string): RoomRow {
    const room = this.db.one<RoomRow>(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE code = ?`, code);
    if (!room || room.expires_at <= this.now()) throw new GameError('ROOM_EXPIRED', '房间不存在或已过期，请检查房间码。');
    return room;
  }
  private players(roomId: number): PlayerRow[] {
    return this.db.all<PlayerRow>(`SELECT ${PLAYER_COLUMNS} FROM players WHERE rooms_id = ? ORDER BY seat`, roomId);
  }
  private round(room: RoomRow): RoundRow {
    const round = this.db.one<RoundRow>(`SELECT ${ROUND_COLUMNS} FROM rounds WHERE rooms_id = ? AND game_number = ? AND round_number = ?`, room.id, room.game_number, room.round_number);
    if (!round) throw new Error('Current round missing');
    return round;
  }
  private touch(id: number): void {
    const now = this.now();
    this.db.run('UPDATE rooms SET revision = revision + 1, updated_at = ?, expires_at = ? WHERE id = ?', now, now + this.ttlMs, id);
  }
  private insertPlayer(roomId: number, seat: Seat, token: string): void {
    const now = this.now();
    this.db.run('INSERT INTO players(rooms_id, seat, token_hash, created_at, updated_at) VALUES (?,?,?,?,?)', roomId, seat, hash(token), now, now);
  }
  private insertRound(roomId: number, gameNumber: number, roundNumber: number, seconds?: number): void {
    const now = this.now();
    this.db.run('INSERT INTO rounds(rooms_id,game_number,round_number,deadline_at,created_at,updated_at) VALUES (?,?,?,?,?,?)', roomId, gameNumber, roundNumber, seconds === undefined ? null : now + seconds * 1000, now, now);
  }
  private startClock(room: RoomRow): void {
    this.db.run('UPDATE rounds SET deadline_at = ?, updated_at = ? WHERE rooms_id = ? AND game_number = ? AND round_number = ? AND deadline_at IS NULL', this.now() + room.round_seconds * 1000, this.now(), room.id, room.game_number, room.round_number);
  }

  create(options: RoomOptions = {}): { identity: Identity; credentials: Credentials } {
    const count = options.playerCount ?? 2;
    const seconds = options.roundSeconds ?? 30;
    const maxRounds = options.maxRounds ?? 10;
    if (![2, 3].includes(count) || !Number.isInteger(seconds) || seconds < 5 || seconds > 3600) throw new GameError('INVALID_INPUT', '请选择 2 或 3 人，每轮时间为 5–3600 秒整数。');
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 1000) throw new GameError('INVALID_INPUT', '最大轮次请输入 1–1000 的整数。');
    return this.db.transaction(() => {
      let code = '';
      for (let attempt = 0; attempt < 20; attempt++) {
        code = String(randomInt(100000, 1000000));
        if (!this.db.one('SELECT id FROM rooms WHERE code = ?', code)) break;
        code = '';
      }
      if (!code) throw new GameError('ROOM_LIMIT', '暂时无法创建房间，请稍后重试。');
      const now = this.now();
      const result = this.db.run('INSERT INTO rooms(code,player_count,round_seconds,max_rounds,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?)', code, count, seconds, maxRounds, now, now, now + this.ttlMs);
      const roomId = Number(result.lastInsertRowid);
      const token = randomBytes(32).toString('hex');
      this.insertPlayer(roomId, 1, token);
      this.insertRound(roomId, 1, 1);
      return { identity: { roomId, roomCode: code, seat: 1 }, credentials: { roomCode: code, token } };
    });
  }
  join(code: string): { identity: Identity; credentials: Credentials } {
    return this.db.transaction(() => {
      const room = this.findRoom(code);
      const occupied = this.players(room.id).length;
      if (room.phase !== 'waiting' || occupied >= room.player_count) throw new GameError('ROOM_FULL', '房间人数已满，请让朋友创建新房间。');
      const seat = (occupied + 1) as Seat;
      const token = randomBytes(32).toString('hex');
      this.insertPlayer(room.id, seat, token);
      if (seat === room.player_count) {
        this.db.run("UPDATE rooms SET phase = 'playing' WHERE id = ?", room.id);
        this.startClock(room);
      }
      this.touch(room.id);
      return { identity: { roomId: room.id, roomCode: code, seat }, credentials: { roomCode: code, token } };
    });
  }
  resume(code: string, token: string): Identity {
    const identity = this.db.transaction(() => {
      const room = this.findRoom(code);
      const digest = Buffer.from(hash(token), 'hex');
      const player = this.players(room.id).find(p => timingSafeEqual(Buffer.from(p.token_hash, 'hex'), digest));
      if (!player) throw new GameError('INVALID_TOKEN', '无法恢复你的玩家身份，请使用原来的浏览器。');
      if (room.phase === 'revealed') this.advanceRound(room);
      else if (room.phase === 'playing') this.startClock(room);
      this.touch(room.id);
      return { roomId: room.id, roomCode: code, seat: player.seat };
    });
    this.expireRound(identity.roomId);
    return identity;
  }

  apply(identity: Identity, command: GameCommand): void {
    // Commit the deadline independently: rejecting a late command must never
    // roll the timeout back or place the late word into the following round.
    this.expireRound(identity.roomId);
    this.db.transaction(() => {
      const room = this.getRoom(identity.roomId);
      const validRound = command.roundNumber === room.round_number
        || (command.action === 'raise' && command.roundNumber < room.round_number);
      if (command.gameNumber !== room.game_number || !validRound) throw new GameError('STALE_COMMAND', '游戏进度已更新，请查看最新状态后再操作。');
      const self = this.players(room.id).find(p => p.seat === identity.seat);
      if (!self) throw new GameError('UNAUTHORIZED', '玩家身份失效，请重新连接。');
      if (command.action === 'submit') this.submit(room, self, command.word);
      else if (command.action === 'raise') this.raise(room, self);
      else if (command.action === 'next') throw new GameError('AUTO_ADVANCE', '已自动进入下一轮，无需再次确认。');
      else this.again(room, self);
      this.touch(room.id);
    });
  }

  private submit(room: RoomRow, self: PlayerRow, value: string | undefined): void {
    if (room.phase !== 'playing') throw new GameError('INVALID_PHASE', '这一轮已经结束，不能再提交。');
    const word = value?.trim() ?? '';
    if ([...word].length < 1 || [...word].length > 30 || /[\u0000-\u001f\u007f]/u.test(word)) throw new GameError('INVALID_WORD', '请输入 1–30 个字，不要包含换行或控制字符。');
    const round = this.round(room);
    const previous = round[WORD_COLUMNS[self.seat]];
    if (previous !== null) {
      if (previous === word) return;
      throw new GameError('ALREADY_SUBMITTED', '本轮已经提交，不能修改词语。');
    }
    // Column comes exclusively from the fixed seat whitelist, never input text.
    this.db.run(`UPDATE rounds SET ${WORD_COLUMNS[self.seat]} = ?, updated_at = ? WHERE id = ?`, word, this.now(), round.id);
    const updated = this.round(room);
    if (words(updated, room.player_count).every(word => word !== null)) this.reveal(room, updated);
  }
  private reveal(room: RoomRow, round: RoundRow): void {
    this.db.run('UPDATE rounds SET is_revealed = 1, deadline_at = NULL, updated_at = ? WHERE id = ?', this.now(), round.id);
    const values = words(round, room.player_count);
    if (values[0] !== null && values.every(word => word === values[0])) this.end(room, 'matched');
    else this.advanceRound(room);
  }
  private raise(room: RoomRow, self: PlayerRow): void {
    if (room.phase === 'ended') return;
    if (room.phase === 'waiting') throw new GameError('INVALID_PHASE', '等朋友加入后再举手。');
    this.db.run('UPDATE players SET is_raised = 1, updated_at = ? WHERE id = ?', this.now(), self.id);
    if (this.players(room.id).every(p => p.is_raised === 1)) this.end(room, 'consensus');
  }
  private end(room: RoomRow, reason: 'matched' | 'consensus' | 'round_limit'): void {
    // Preserve the deployed parent-table CHECK without rebuilding rooms and
    // its foreign-key children. Only ended + NULL means round_limit on wire.
    this.db.run("UPDATE rooms SET phase = 'ended', end_reason = ? WHERE id = ?", reason === 'round_limit' ? null : reason, room.id);
    this.db.run('UPDATE rounds SET deadline_at = NULL WHERE rooms_id = ? AND game_number = ? AND round_number = ?', room.id, room.game_number, room.round_number);
  }
  private advanceRound(room: RoomRow): void {
    if (room.round_number >= room.max_rounds) {
      this.end(room, 'round_limit');
      return;
    }
    this.insertRound(room.id, room.game_number, room.round_number + 1, room.round_seconds);
    this.db.run("UPDATE rooms SET phase = 'playing', round_number = round_number + 1 WHERE id = ?", room.id);
    this.db.run('UPDATE players SET is_next_ready = 0, updated_at = ? WHERE rooms_id = ?', this.now(), room.id);
  }
  private again(room: RoomRow, self: PlayerRow): void {
    if (room.phase !== 'ended') throw new GameError('INVALID_PHASE', '这一局结束后才能再来一局。');
    this.db.run('UPDATE players SET is_rematch_ready = 1, updated_at = ? WHERE id = ?', this.now(), self.id);
    if (this.players(room.id).every(p => p.is_rematch_ready === 1)) {
      this.insertRound(room.id, room.game_number + 1, 1, room.round_seconds);
      this.db.run("UPDATE rooms SET phase = 'playing', game_number = game_number + 1, round_number = 1, end_reason = NULL WHERE id = ?", room.id);
      this.db.run('UPDATE players SET is_raised = 0, is_next_ready = 0, is_rematch_ready = 0, updated_at = ? WHERE rooms_id = ?', this.now(), room.id);
    }
  }

  private expireRound(roomId: number): boolean {
    return this.db.transaction(() => {
      const room = this.getRoom(roomId);
      if (room.phase !== 'playing') return false;
      const round = this.round(room);
      if (round.is_revealed || round.deadline_at === null || round.deadline_at > this.now()) return false;
      this.reveal(room, round);
      // Automatic rounds do not count as human activity for room expiry.
      this.db.run('UPDATE rooms SET revision = revision + 1 WHERE id = ?', room.id);
      return true;
    });
  }

  /** A bounded, fair sweep; one room failure does not roll back other rooms. */
  processTimeouts(onError?: (error: unknown, roomId: number) => void): number[] {
    const now = this.now();
    const due = this.db.all<{ id: number; rooms_id: number; deadline_at: number }>(`
      SELECT rounds.id, rounds.rooms_id, rounds.deadline_at FROM rounds
      INNER JOIN rooms ON rooms.id = rounds.rooms_id
      WHERE rounds.is_revealed = 0 AND rounds.deadline_at IS NOT NULL AND rounds.deadline_at <= ?
        AND (rounds.deadline_at, rounds.id) > (?,?)
        AND rooms.phase = 'playing' AND rooms.expires_at > ?
        AND rooms.game_number = rounds.game_number AND rooms.round_number = rounds.round_number
      ORDER BY rounds.deadline_at, rounds.id LIMIT 25`, now, this.timeoutCursor.deadline, this.timeoutCursor.id, now);
    if (!due.length) this.timeoutCursor = { deadline: -Number.MAX_SAFE_INTEGER, id: 0 };
    const changed: number[] = [];
    const errors: unknown[] = [];
    for (const row of due) {
      this.timeoutCursor = { deadline: row.deadline_at, id: row.id };
      try { if (this.expireRound(row.rooms_id)) changed.push(row.rooms_id); }
      catch (error) { if (onError) onError(error, row.rooms_id); else errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Round timeout processing failed');
    return changed;
  }

  snapshot(identity: Identity, online: OnlineCheck): RoomSnapshot {
    const room = this.getRoom(identity.roomId);
    const players = this.players(room.id);
    const current = this.round(room);
    const self = players.find(p => p.seat === identity.seat);
    if (!self) throw new GameError('UNAUTHORIZED', '玩家身份失效，请重新连接。');
    const view = (player: PlayerRow): PlayerView => {
      const word = current[WORD_COLUMNS[player.seat]];
      return { seat: player.seat, online: online(room.id, player.seat), submitted: word !== null,
        word: player.seat === identity.seat || current.is_revealed === 1 ? word : null,
        raised: player.is_raised === 1, nextReady: player.is_next_ready === 1, rematchReady: player.is_rematch_ready === 1 };
    };
    const opponents = players.filter(p => p.seat !== identity.seat).map(view);
    const history = this.db.all<RoundRow>(`SELECT ${ROUND_COLUMNS} FROM rounds WHERE rooms_id = ? AND game_number = ? AND is_revealed = 1 ORDER BY round_number DESC LIMIT 100`, room.id, room.game_number).reverse();
    return { roomCode: room.code, revision: room.revision, phase: room.phase, gameNumber: room.game_number, roundNumber: room.round_number,
      endReason: room.phase === 'ended' && room.end_reason === null ? 'round_limit' : room.end_reason,
      playerCount: room.player_count, roundSeconds: room.round_seconds, maxRounds: room.max_rounds,
      deadlineAt: room.phase === 'playing' ? current.deadline_at : null, serverNow: this.now(),
      self: view(self), opponents, opponent: opponents[0] ?? null,
      historyCount: room.round_number - 1 + current.is_revealed,
      history: history.map(row => ({ roundNumber: row.round_number, words: words(row, room.player_count) })) };
  }

  presenceChanged(roomId: number): void {
    this.db.run('UPDATE rooms SET revision = revision + 1 WHERE id = ? AND expires_at > ?', roomId, this.now());
  }

  /** Parent batch is bounded; cascading a long room is proportional to history. */
  cleanup(): number[] {
    return this.db.transaction(() => {
      const expired = this.db.all<{ id: number }>('SELECT id FROM rooms WHERE expires_at <= ? ORDER BY expires_at LIMIT 25', this.now());
      for (const room of expired) this.db.run('DELETE FROM rooms WHERE id = ?', room.id);
      return expired.map(room => room.id);
    });
  }
}
