import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EndReason, Phase, Seat } from '@tongpin/shared';

export interface RoomRow {
  id: number; code: string; revision: number; phase: Phase; game_number: number; round_number: number;
  end_reason: EndReason; created_at: number; updated_at: number; expires_at: number;
  player_count: 2 | 3; round_seconds: number;
}
export interface PlayerRow {
  id: number; rooms_id: number; seat: Seat; token_hash: string;
  is_raised: number; is_next_ready: number; is_rematch_ready: number;
}
export interface RoundRow {
  id: number; rooms_id: number; game_number: number; round_number: number;
  word_one: string | null; word_two: string | null; is_revealed: number;
  word_three: string | null; deadline_at: number | null;
}
type Parameter = string | number | null;

/** One connection and cached prepared statements; synchronous transactions never await. */
export class GameDatabase {
  readonly connection: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.connection = new Database(path);
    try {
      this.connection.pragma('journal_mode = WAL');
      this.connection.pragma('foreign_keys = ON');
      this.connection.pragma('busy_timeout = 1000');
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          id INTEGER PRIMARY KEY,
          code TEXT NOT NULL UNIQUE CHECK(length(code) = 6),
          revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
          phase TEXT NOT NULL DEFAULT 'waiting' CHECK(phase IN ('waiting','playing','revealed','ended')),
          game_number INTEGER NOT NULL DEFAULT 1 CHECK(game_number > 0),
          round_number INTEGER NOT NULL DEFAULT 1 CHECK(round_number > 0),
          end_reason TEXT DEFAULT NULL CHECK(end_reason IN ('matched','consensus') OR end_reason IS NULL),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS rooms_expires_at ON rooms(expires_at);
        CREATE TABLE IF NOT EXISTS players (
          id INTEGER PRIMARY KEY,
          rooms_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          seat INTEGER NOT NULL CHECK(seat IN (1,2)),
          token_hash TEXT NOT NULL CHECK(length(token_hash) = 64),
          is_raised INTEGER NOT NULL DEFAULT 0 CHECK(is_raised IN (0,1)),
          is_next_ready INTEGER NOT NULL DEFAULT 0 CHECK(is_next_ready IN (0,1)),
          is_rematch_ready INTEGER NOT NULL DEFAULT 0 CHECK(is_rematch_ready IN (0,1)),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(rooms_id,seat)
        );
        CREATE TABLE IF NOT EXISTS rounds (
          id INTEGER PRIMARY KEY,
          rooms_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          game_number INTEGER NOT NULL CHECK(game_number > 0),
          round_number INTEGER NOT NULL CHECK(round_number > 0),
          word_one TEXT DEFAULT NULL CHECK(word_one IS NULL OR length(word_one) BETWEEN 1 AND 30),
          word_two TEXT DEFAULT NULL CHECK(word_two IS NULL OR length(word_two) BETWEEN 1 AND 30),
          is_revealed INTEGER NOT NULL DEFAULT 0 CHECK(is_revealed IN (0,1)),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(rooms_id,game_number,round_number)
        );
      `);
      this.connection.transaction(() => {
        const columns = this.connection.pragma('table_info(rooms)') as { name: string }[];
        if (!columns.some(column => column.name === 'revision')) {
          this.connection.exec('ALTER TABLE rooms ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)');
        }
        if (Number(this.connection.pragma('user_version', { simple: true })) < 1) {
          this.connection.exec(`
            ALTER TABLE rooms ADD COLUMN player_count INTEGER NOT NULL DEFAULT 2 CHECK(player_count IN (2,3));
            ALTER TABLE rooms ADD COLUMN round_seconds INTEGER NOT NULL DEFAULT 30 CHECK(round_seconds BETWEEN 5 AND 3600);
            ALTER TABLE rounds ADD COLUMN word_three TEXT DEFAULT NULL CHECK(word_three IS NULL OR length(word_three) BETWEEN 1 AND 30);
            ALTER TABLE rounds ADD COLUMN deadline_at INTEGER DEFAULT NULL;
            CREATE TABLE players_expanded (
              id INTEGER PRIMARY KEY,
              rooms_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
              seat INTEGER NOT NULL CHECK(seat IN (1,2,3)),
              token_hash TEXT NOT NULL CHECK(length(token_hash) = 64),
              is_raised INTEGER NOT NULL DEFAULT 0 CHECK(is_raised IN (0,1)),
              is_next_ready INTEGER NOT NULL DEFAULT 0 CHECK(is_next_ready IN (0,1)),
              is_rematch_ready INTEGER NOT NULL DEFAULT 0 CHECK(is_rematch_ready IN (0,1)),
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              UNIQUE(rooms_id,seat)
            );
            INSERT INTO players_expanded(id,rooms_id,seat,token_hash,is_raised,is_next_ready,is_rematch_ready,created_at,updated_at)
              SELECT id,rooms_id,seat,token_hash,is_raised,is_next_ready,is_rematch_ready,created_at,updated_at FROM players;
            DROP TABLE players;
            ALTER TABLE players_expanded RENAME TO players;
            CREATE INDEX rounds_deadline_at ON rounds(deadline_at) WHERE is_revealed = 0 AND deadline_at IS NOT NULL;
            PRAGMA user_version = 1;
          `);
        }
      }).immediate();
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  private statement(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.connection.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  one<T>(sql: string, ...parameters: Parameter[]): T | undefined {
    return this.statement(sql).get(...parameters) as T | undefined;
  }
  all<T>(sql: string, ...parameters: Parameter[]): T[] {
    return this.statement(sql).all(...parameters) as T[];
  }
  run(sql: string, ...parameters: Parameter[]): Database.RunResult {
    return this.statement(sql).run(...parameters);
  }
  transaction<T>(operation: () => T): T { return this.connection.transaction(operation).immediate(); }
  close(): void { this.statements.clear(); this.connection.close(); }
}
