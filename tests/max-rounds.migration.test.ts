import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { GameDatabase } from '../apps/server/src/db';
import { GameService } from '../apps/server/src/game';

it('v1旧库第12轮迁移后保留进度、凭证和旧结束约束，限次结果可重启恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tongpin-max-rounds-migration-'));
  const path = join(directory, 'legacy-v1.db');
  const tokens = ['a'.repeat(64), 'b'.repeat(64)];
  const raw = new Database(path);
  try {
    // Build the actual v1 shape independently of the new migration code.
    raw.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE rooms (
        id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE CHECK(length(code)=6),
        revision INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'waiting',
        game_number INTEGER NOT NULL DEFAULT 1, round_number INTEGER NOT NULL DEFAULT 1,
        end_reason TEXT DEFAULT NULL CHECK(end_reason IN ('matched','consensus') OR end_reason IS NULL),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        player_count INTEGER NOT NULL DEFAULT 2 CHECK(player_count IN (2,3)),
        round_seconds INTEGER NOT NULL DEFAULT 30 CHECK(round_seconds BETWEEN 5 AND 3600)
      );
      CREATE INDEX rooms_expires_at ON rooms(expires_at);
      CREATE TABLE players (
        id INTEGER PRIMARY KEY, rooms_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        seat INTEGER NOT NULL CHECK(seat IN (1,2,3)), token_hash TEXT NOT NULL CHECK(length(token_hash)=64),
        is_raised INTEGER NOT NULL DEFAULT 0, is_next_ready INTEGER NOT NULL DEFAULT 0,
        is_rematch_ready INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(rooms_id,seat)
      );
      CREATE TABLE rounds (
        id INTEGER PRIMARY KEY, rooms_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        game_number INTEGER NOT NULL, round_number INTEGER NOT NULL,
        word_one TEXT DEFAULT NULL, word_two TEXT DEFAULT NULL, is_revealed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        word_three TEXT DEFAULT NULL, deadline_at INTEGER DEFAULT NULL,
        UNIQUE(rooms_id,game_number,round_number)
      );
      CREATE INDEX rounds_deadline_at ON rounds(deadline_at) WHERE is_revealed=0 AND deadline_at IS NOT NULL;
      INSERT INTO rooms(id,code,revision,phase,round_number,created_at,updated_at,expires_at)
        VALUES(42,'123456',7,'playing',12,100,200,999999);
      INSERT INTO rooms(id,code,created_at,updated_at,expires_at)
        VALUES(43,'123457',100,200,999999);
      PRAGMA user_version = 1;
    `);
    for (let index = 0; index < 2; index++) {
      raw.prepare('INSERT INTO players(id,rooms_id,seat,token_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(index + 10, 42, index + 1, createHash('sha256').update(tokens[index]).digest('hex'), 100, 200);
    }
    for (let round = 1; round <= 12; round++) {
      raw.prepare('INSERT INTO rounds(rooms_id,game_number,round_number,word_one,is_revealed,deadline_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(42, 1, round, round === 12 ? '保留的词' : null, round < 12 ? 1 : 0, round === 12 ? 6000 : null, 100, 200);
    }
  } finally {
    raw.close();
  }

  let migrated: GameDatabase | undefined;
  try {
    migrated = new GameDatabase(path);
    expect(migrated.connection.pragma('user_version', { simple: true })).toBe(2);
    expect(migrated.one('SELECT id,revision,round_number,max_rounds,created_at,updated_at FROM rooms WHERE id=42'))
      .toEqual({ id: 42, revision: 7, round_number: 12, max_rounds: 12, created_at: 100, updated_at: 200 });
    expect(migrated.one<{ max_rounds: number }>('SELECT max_rounds FROM rooms WHERE id=43')?.max_rounds).toBe(10);
    expect(migrated.connection.pragma('foreign_key_check')).toEqual([]);
    expect(migrated.connection.pragma('integrity_check', { simple: true })).toBe('ok');
    // A parent-table rebuild or widening of the deployed CHECK is unnecessary.
    expect(() => migrated!.run("UPDATE rooms SET end_reason = 'round_limit' WHERE id=42")).toThrow();
    let game = new GameService(migrated, () => 1000);
    const host = game.resume('123456', tokens[0]);
    const guest = game.resume('123456', tokens[1]);
    expect(game.snapshot(host, () => true)).toMatchObject({ roundNumber: 12, maxRounds: 12,
      deadlineAt: 6000, historyCount: 11, self: { word: '保留的词', submitted: true } });
    expect(migrated.one('SELECT id,created_at,updated_at FROM players WHERE rooms_id=42 AND seat=1'))
      .toEqual({ id: 10, created_at: 100, updated_at: 200 });
    game.apply(guest, { action: 'submit', gameNumber: 1, roundNumber: 12, word: '不同的词' });
    expect(game.snapshot(host, () => true)).toMatchObject({ phase: 'ended', endReason: 'round_limit', roundNumber: 12,
      maxRounds: 12, historyCount: 12, deadlineAt: null });
    expect(migrated.one('SELECT phase,end_reason FROM rooms WHERE id=42')).toEqual({ phase: 'ended', end_reason: null });
    expect(migrated.one<{ count: number }>('SELECT count(*) AS count FROM rounds WHERE rooms_id=42')?.count).toBe(12);
    migrated.close();
    migrated = new GameDatabase(path);
    game = new GameService(migrated, () => 2000);
    const restoredHost = game.resume('123456', tokens[0]);
    const restoredGuest = game.resume('123456', tokens[1]);
    expect(game.snapshot(restoredHost, () => true)).toMatchObject({ phase: 'ended', endReason: 'round_limit', maxRounds: 12 });
    game.apply(restoredHost, { action: 'again', gameNumber: 1, roundNumber: 12 });
    expect(game.snapshot(restoredHost, () => true).phase).toBe('ended');
    game.apply(restoredGuest, { action: 'again', gameNumber: 1, roundNumber: 12 });
    expect(game.snapshot(restoredHost, () => true)).toMatchObject({ phase: 'playing', endReason: null, gameNumber: 2,
      roundNumber: 1, maxRounds: 12, history: [], historyCount: 0 });
    expect(migrated.connection.pragma('user_version', { simple: true })).toBe(2);
    expect(migrated.connection.pragma('foreign_key_check')).toEqual([]);
    expect(migrated.connection.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    migrated?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
