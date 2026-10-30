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
        seat INTEGER NOT NULL, token_hash TEXT NOT NULL,
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
      } finally {
        migrated.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
