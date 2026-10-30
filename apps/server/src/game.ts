import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Command, Credentials, PlayerView, RoomSnapshot, Seat } from '@tongpin/shared';
import { GameDatabase, type PlayerRow, type RoomRow, type RoundRow } from './db.js';

const ROOM_COLUMNS = 'id, code, revision, phase, game_number, round_number, end_reason, created_at, updated_at, expires_at';
const PLAYER_COLUMNS = 'id, rooms_id, seat, token_hash, is_raised, is_next_ready, is_rematch_ready';
const ROUND_COLUMNS = 'id, rooms_id, game_number, round_number, word_one, word_two, is_revealed';
export interface Identity { roomId: number; roomCode: string; seat: Seat }
export class GameError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
type GameCommand = Extract<Command, { gameNumber: number }>;
type OnlineCheck = (roomId: number, seat: Seat) => boolean;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class GameService {
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
  private insertRound(roomId: number, gameNumber: number, roundNumber: number): void {
    const now = this.now();
    this.db.run('INSERT INTO rounds(rooms_id,game_number,round_number,created_at,updated_at) VALUES (?,?,?,?,?)', roomId, gameNumber, roundNumber, now, now);
  }

  create(): { identity: Identity; credentials: Credentials } {
    return this.db.transaction(() => {
      let code = '';
      for (let attempt = 0; attempt < 20; attempt++) {
        code = String(randomInt(100000, 1000000));
        if (!this.db.one('SELECT id FROM rooms WHERE code = ?', code)) break;
        code = '';
      }
      if (!code) throw new GameError('ROOM_LIMIT', '暂时无法创建房间，请稍后重试。');
      const now = this.now();
      const result = this.db.run('INSERT INTO rooms(code,created_at,updated_at,expires_at) VALUES (?,?,?,?)', code, now, now, now + this.ttlMs);
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
      if (room.phase !== 'waiting' || this.players(room.id).length !== 1) throw new GameError('ROOM_FULL', '房间已有两人，请让朋友创建新房间。');
      const token = randomBytes(32).toString('hex');
      this.insertPlayer(room.id, 2, token);
      this.db.run("UPDATE rooms SET phase = 'playing' WHERE id = ?", room.id);
      this.touch(room.id);
      return { identity: { roomId: room.id, roomCode: code, seat: 2 }, credentials: { roomCode: code, token } };
    });
  }
  resume(code: string, token: string): Identity {
    return this.db.transaction(() => {
      const room = this.findRoom(code);
      const digest = Buffer.from(hash(token), 'hex');
      const player = this.players(room.id).find(p => timingSafeEqual(Buffer.from(p.token_hash, 'hex'), digest));
      if (!player) throw new GameError('INVALID_TOKEN', '无法恢复你的玩家身份，请使用原来的浏览器。');
      this.touch(room.id);
      return { roomId: room.id, roomCode: code, seat: player.seat };
    });
  }

  apply(identity: Identity, command: GameCommand): void {
    this.db.transaction(() => {
      const room = this.getRoom(identity.roomId);
      if (command.gameNumber !== room.game_number || command.roundNumber !== room.round_number) throw new GameError('STALE_COMMAND', '游戏进度已更新，请查看最新状态后再操作。');
      const players = this.players(room.id);
      const self = players.find(p => p.seat === identity.seat);
      if (!self) throw new GameError('UNAUTHORIZED', '玩家身份失效，请重新连接。');
      if (command.action === 'submit') this.submit(room, self, command.word);
      else if (command.action === 'raise') this.raise(room, self);
      else if (command.action === 'next') this.next(room, self);
      else this.again(room, self);
      this.touch(room.id);
    });
  }

  private submit(room: RoomRow, self: PlayerRow, value: string | undefined): void {
    if (room.phase !== 'playing') throw new GameError('INVALID_PHASE', '这一轮已经结束，不能再提交。');
    const word = value?.trim() ?? '';
    if ([...word].length < 1 || [...word].length > 30 || /[\u0000-\u001f\u007f]/u.test(word)) throw new GameError('INVALID_WORD', '请输入 1–30 个字，不要包含换行或控制字符。');
    const round = this.round(room);
    const previous = self.seat === 1 ? round.word_one : round.word_two;
    if (previous !== null) {
      if (previous === word) return;
      throw new GameError('ALREADY_SUBMITTED', '本轮已经提交，不能修改词语。');
    }
    const sql = self.seat === 1 ? 'UPDATE rounds SET word_one = ?, updated_at = ? WHERE id = ?' : 'UPDATE rounds SET word_two = ?, updated_at = ? WHERE id = ?';
    this.db.run(sql, word, this.now(), round.id);
    const updated = this.round(room);
    if (updated.word_one !== null && updated.word_two !== null) {
      this.db.run('UPDATE rounds SET is_revealed = 1, updated_at = ? WHERE id = ?', this.now(), round.id);
      if (updated.word_one === updated.word_two) this.end(room, 'matched');
      else this.db.run("UPDATE rooms SET phase = 'revealed' WHERE id = ?", room.id);
    }
  }
  private raise(room: RoomRow, self: PlayerRow): void {
    if (room.phase === 'ended') return;
    if (room.phase === 'waiting') throw new GameError('INVALID_PHASE', '等朋友加入后再举手。');
    this.db.run('UPDATE players SET is_raised = 1, updated_at = ? WHERE id = ?', this.now(), self.id);
    if (this.players(room.id).every(p => p.is_raised === 1)) this.end(room, 'consensus');
  }
  private end(room: RoomRow, reason: 'matched' | 'consensus'): void {
    this.db.run("UPDATE rooms SET phase = 'ended', end_reason = ? WHERE id = ?", reason, room.id);
  }
  private next(room: RoomRow, self: PlayerRow): void {
    if (room.phase !== 'revealed') throw new GameError('INVALID_PHASE', '双方揭晓后才能进入下一轮。');
    this.db.run('UPDATE players SET is_next_ready = 1, updated_at = ? WHERE id = ?', this.now(), self.id);
    if (this.players(room.id).every(p => p.is_next_ready === 1)) {
      this.insertRound(room.id, room.game_number, room.round_number + 1);
      this.db.run("UPDATE rooms SET phase = 'playing', round_number = round_number + 1 WHERE id = ?", room.id);
      this.db.run('UPDATE players SET is_next_ready = 0, updated_at = ? WHERE rooms_id = ?', this.now(), room.id);
    }
  }
  private again(room: RoomRow, self: PlayerRow): void {
    if (room.phase !== 'ended') throw new GameError('INVALID_PHASE', '这一局结束后才能再来一局。');
    this.db.run('UPDATE players SET is_rematch_ready = 1, updated_at = ? WHERE id = ?', this.now(), self.id);
    if (this.players(room.id).every(p => p.is_rematch_ready === 1)) {
      this.insertRound(room.id, room.game_number + 1, 1);
      this.db.run("UPDATE rooms SET phase = 'playing', game_number = game_number + 1, round_number = 1, end_reason = NULL WHERE id = ?", room.id);
      this.db.run('UPDATE players SET is_raised = 0, is_next_ready = 0, is_rematch_ready = 0, updated_at = ? WHERE rooms_id = ?', this.now(), room.id);
    }
  }

  snapshot(identity: Identity, online: OnlineCheck): RoomSnapshot {
    const room = this.getRoom(identity.roomId);
    const players = this.players(room.id);
    const current = this.round(room);
    const self = players.find(p => p.seat === identity.seat);
    if (!self) throw new GameError('UNAUTHORIZED', '玩家身份失效，请重新连接。');
    const view = (player: PlayerRow): PlayerView => {
      const word = player.seat === 1 ? current.word_one : current.word_two;
      return { seat: player.seat, online: online(room.id, player.seat), submitted: word !== null,
        word: player.seat === identity.seat || current.is_revealed === 1 ? word : null,
        raised: player.is_raised === 1, nextReady: player.is_next_ready === 1, rematchReady: player.is_rematch_ready === 1 };
    };
    const opponent = players.find(p => p.seat !== identity.seat);
    const history = this.db.all<RoundRow>(`SELECT ${ROUND_COLUMNS} FROM rounds WHERE rooms_id = ? AND game_number = ? AND is_revealed = 1 ORDER BY round_number`, room.id, room.game_number);
    return { roomCode: room.code, revision: room.revision, phase: room.phase, gameNumber: room.game_number, roundNumber: room.round_number,
      endReason: room.end_reason, self: view(self), opponent: opponent ? view(opponent) : null,
      history: history.map(row => {
        if (row.word_one === null || row.word_two === null) throw new Error('Revealed round is incomplete');
        return { roundNumber: row.round_number, words: [row.word_one, row.word_two] };
      }) };
  }

  presenceChanged(roomId: number): void {
    this.db.run('UPDATE rooms SET revision = revision + 1 WHERE id = ? AND expires_at > ?', roomId, this.now());
  }

  /** Parent batch is bounded; cascading a single very long room is still proportional to its history. */
  cleanup(): number[] {
    return this.db.transaction(() => {
      const expired = this.db.all<{ id: number }>('SELECT id FROM rooms WHERE expires_at <= ? ORDER BY expires_at LIMIT 25', this.now());
      for (const room of expired) this.db.run('DELETE FROM rooms WHERE id = ?', room.id);
      return expired.map(room => room.id);
    });
  }
}
