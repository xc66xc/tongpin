import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GameDatabase } from '../apps/server/src/db';
import { GameService } from '../apps/server/src/game';

describe('SQLite 房间存储与过期生命周期', () => {
  let db: GameDatabase;
  let service: GameService;
  let now: number;

  beforeEach(() => {
    db = new GameDatabase(':memory:');
    now = 1_000;
    service = new GameService(db, () => now, 5_000);
  });

  afterEach(() => db?.close());

  it('凭证仅以哈希保存，玩家快照不包含身份凭证或数据库字段', () => {
    const room = service.create();
    const saved = db.one<{ token_hash: string }>('SELECT token_hash FROM players WHERE rooms_id = ?', room.identity.roomId);
    expect(saved?.token_hash).toHaveLength(64);
    expect(saved?.token_hash).not.toBe(room.credentials.token);
    const snapshot = JSON.stringify(service.snapshot(room.identity, () => true));
    expect(snapshot).not.toContain('token');
    expect(snapshot).not.toContain('rooms_id');
  });

  it('房间过期后不能继续恢复，清理级联删除玩家和轮次', () => {
    const room = service.create();
    service.join(room.credentials.roomCode);
    now += 5_001;
    expect(() => service.resume(room.credentials.roomCode, room.credentials.token)).toThrow();
    expect(service.cleanup()).toEqual([room.identity.roomId]);
    for (const table of ['rooms', 'players', 'rounds']) {
      expect(db.one<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count).toBe(0);
    }
  });

  it('合法恢复延长空闲期限，但不为无效凭证续期', () => {
    const room = service.create();
    now += 4_000;
    expect(() => service.resume(room.credentials.roomCode, 'invalid')).toThrow();
    expect(db.one<{ expires_at: number }>('SELECT expires_at FROM rooms WHERE id = ?', room.identity.roomId)?.expires_at).toBe(6_000);
    service.resume(room.credentials.roomCode, room.credentials.token);
    expect(db.one<{ expires_at: number }>('SELECT expires_at FROM rooms WHERE id = ?', room.identity.roomId)?.expires_at).toBe(10_000);
    now += 2_000;
    expect(service.cleanup()).toEqual([]);
  });

  it('每次最多清理25个房间，不误删仍活跃的房间', () => {
    for (let index = 0; index < 26; index++) service.create();
    now += 4_000;
    const active = service.create();
    now += 1_001;
    expect(service.cleanup()).toHaveLength(25);
    expect(service.cleanup()).toHaveLength(1);
    expect(service.snapshot(active.identity, () => true).phase).toBe('waiting');
  });

  it('旧版停在揭晓页的房间在合法重连后自动续轮，双方重连只前进一次且保留举手', () => {
    const host = service.create();
    const guest = service.join(host.credentials.roomCode);
    // Reproduce persisted state from the former two-confirmation flow.
    db.run("UPDATE rounds SET word_one = '大海', word_two = '沙滩', is_revealed = 1 WHERE rooms_id = ?", host.identity.roomId);
    db.run("UPDATE rooms SET phase = 'revealed' WHERE id = ?", host.identity.roomId);
    db.run('UPDATE players SET is_raised = 1, is_next_ready = 1 WHERE rooms_id = ? AND seat = 1', host.identity.roomId);
    expect(() => service.resume(host.credentials.roomCode, 'wrong-token')).toThrow();
    expect(service.snapshot(host.identity, () => false).roundNumber).toBe(1);
    const restoredHost = service.resume(host.credentials.roomCode, host.credentials.token);
    const first = service.snapshot(restoredHost, () => true);
    expect(first).toMatchObject({ phase: 'playing', roundNumber: 2, history: [{ roundNumber: 1, words: ['大海', '沙滩'] }] });
    expect(first.self).toMatchObject({ raised: true, nextReady: false, submitted: false });
    const restoredGuest = service.resume(guest.credentials.roomCode, guest.credentials.token);
    expect(service.snapshot(restoredGuest, () => true).roundNumber).toBe(2);
    expect(db.one<{ count: number }>('SELECT count(*) AS count FROM rounds WHERE rooms_id = ?', host.identity.roomId)?.count).toBe(2);
  });
});

it('已有无 revision 字段的 SQLite 房间可幂等升级，保留游戏数据与时间戳', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tongpin-migration-'));
  const path = join(directory, 'legacy.db');
  const token = 'a'.repeat(64);
  const raw = new Database(path);
  try {
    // Reproduce the pre-revision rooms schema directly, without using the
    // current application constructor to create the table under test.
    raw.exec(`
      CREATE TABLE rooms (
        id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL DEFAULT 'waiting', game_number INTEGER NOT NULL DEFAULT 1,
        round_number INTEGER NOT NULL DEFAULT 1, end_reason TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      INSERT INTO rooms(id,code,phase,game_number,round_number,created_at,updated_at,expires_at)
      VALUES(42,'123456','playing',1,1,100,200,999999);
      CREATE TABLE players (
        id INTEGER PRIMARY KEY, rooms_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        seat INTEGER NOT NULL CHECK(seat IN (1,2)), token_hash TEXT NOT NULL,
        is_raised INTEGER NOT NULL DEFAULT 0, is_next_ready INTEGER NOT NULL DEFAULT 0,
        is_rematch_ready INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(rooms_id,seat)
      );
      CREATE TABLE rounds (
        id INTEGER PRIMARY KEY, rooms_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        game_number INTEGER NOT NULL, round_number INTEGER NOT NULL,
        word_one TEXT DEFAULT NULL, word_two TEXT DEFAULT NULL, is_revealed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(rooms_id,game_number,round_number)
      );
      INSERT INTO rounds(rooms_id,game_number,round_number,word_one,created_at,updated_at)
      VALUES(42,1,1,'保留的词',100,200);
    `);
    raw.prepare('INSERT INTO players(rooms_id,seat,token_hash,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(42, 1, createHash('sha256').update(token).digest('hex'), 100, 200);
  } finally {
    raw.close();
  }
  try {
    for (let reopen = 0; reopen < 2; reopen++) {
      const migrated = new GameDatabase(path);
      try {
        const saved = migrated.one<{ revision: number; created_at: number; updated_at: number }>(
          'SELECT revision, created_at, updated_at FROM rooms WHERE id = ?', 42,
        );
        expect(saved).toEqual({ revision: 0, created_at: 100, updated_at: 200 });
        const columns = migrated.connection.pragma('table_info(rooms)') as { name: string }[];
        expect(columns.filter((column) => column.name === 'revision')).toHaveLength(1);
        const service = new GameService(migrated, () => 1_000);
        const snapshot = service.snapshot({ roomId: 42, roomCode: '123456', seat: 1 }, () => false);
        expect(snapshot).toMatchObject({ revision: 0, phase: 'playing', gameNumber: 1, roundNumber: 1 });
        expect(snapshot.self).toMatchObject({ word: '保留的词', submitted: true });
        expect(snapshot).toMatchObject({ playerCount: 2, roundSeconds: 30, deadlineAt: null });
        expect(migrated.connection.pragma('foreign_key_check')).toEqual([]);
        expect(migrated.connection.pragma('integrity_check', { simple: true })).toBe('ok');
        const savedPlayer = migrated.one<{ id: number; token_hash: string; created_at: number; updated_at: number }>(
          'SELECT id,token_hash,created_at,updated_at FROM players WHERE rooms_id = ?', 42,
        );
        expect(savedPlayer).toEqual({ id: 1, token_hash: createHash('sha256').update(token).digest('hex'), created_at: 100, updated_at: 200 });
        const restored = service.resume('123456', token);
        expect(service.snapshot(restored, () => true)).toMatchObject({ phase: 'playing', deadlineAt: 31_000 });
        // The old CHECK(seat IN (1,2)) must actually be replaced, not only the CREATE template.
        migrated.run('INSERT INTO players(rooms_id,seat,token_hash,created_at,updated_at) VALUES(?,?,?,?,?)', 42, 3, 'b'.repeat(64), 100, 200);
        expect(() => migrated.run('INSERT INTO players(rooms_id,seat,token_hash,created_at,updated_at) VALUES(?,?,?,?,?)', 42, 4, 'c'.repeat(64), 100, 200)).toThrow();
        migrated.run('DELETE FROM players WHERE rooms_id = ? AND seat = 3', 42);
        // Reset only the legacy clock mutation so the second constructor repeats
        // the same migration assertions against the unchanged original fixture.
        migrated.run('UPDATE rooms SET revision = 0,updated_at = 200,expires_at = 999999 WHERE id = 42');
        migrated.run('UPDATE rounds SET deadline_at = NULL WHERE rooms_id = 42');
      } finally {
        migrated.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('三人限时房间重启后保持设置、截止时间和第三位玩家的提交', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tongpin-timer-restart-'));
  const path = join(directory, 'game.db');
  let time = 1_000;
  let db = new GameDatabase(path);
  try {
    let service = new GameService(db, () => time);
    const host = service.create({ playerCount: 3, roundSeconds: 45 });
    service.join(host.credentials.roomCode);
    const third = service.join(host.credentials.roomCode);
    service.apply(third.identity, { action: 'submit', gameNumber: 1, roundNumber: 1, word: '重启前的词' });
    db.close();
    time += 10_000;
    db = new GameDatabase(path);
    service = new GameService(db, () => time);
    const restored = service.resume(third.credentials.roomCode, third.credentials.token);
    expect(service.snapshot(restored, () => false)).toMatchObject({ playerCount: 3, roundSeconds: 45,
      deadlineAt: 46_000, roundNumber: 1, self: { seat: 3, word: '重启前的词', submitted: true } });
    time = 46_000;
    expect(service.processTimeouts()).toEqual([host.identity.roomId]);
    const snapshot = service.snapshot(restored, () => false);
    expect(snapshot).toMatchObject({ roundNumber: 2, deadlineAt: 91_000,
      history: [{ roundNumber: 1, words: [null, null, '重启前的词'] }] });
    expect(db.connection.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
