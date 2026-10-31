import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { GameDatabase } from '../apps/server/src/db.js';
import { GameService } from '../apps/server/src/game.js';

const directory = mkdtempSync(join(tmpdir(), 'tongpin-sql-'));
const path = join(directory, 'check.db');
const db = new GameDatabase(path);
let now = Date.now();
const service = new GameService(db, () => now, 60_000);
const latencies: number[] = [];
try {
  for (let room = 0; room < 100; room++) {
    const host = service.create({ maxRounds: 1000 });
    const guest = service.join(host.credentials.roomCode);
    for (let round = 1; round <= 20; round++) {
      for (const [identity, action, word] of [
        [host.identity, 'submit', '夏天'], [guest.identity, 'submit', '海边'],
      ] as const) {
        const start = performance.now();
        service.apply(identity, { action, gameNumber: 1, roundNumber: round, ...(word ? { word } : {}) });
        service.snapshot(identity, () => true);
        latencies.push(performance.now() - start);
      }
    }
  }
  const plans = [
    ['room-code', 'SELECT id,code,revision,phase,game_number,round_number,end_reason,player_count,round_seconds,max_rounds,created_at,updated_at,expires_at FROM rooms WHERE code = ?', ['100000']],
    ['players', 'SELECT id,rooms_id,seat,token_hash,is_raised,is_next_ready,is_rematch_ready FROM players WHERE rooms_id = ? ORDER BY seat', [1]],
    ['current-round', 'SELECT id,rooms_id,game_number,round_number,word_one,word_two,word_three,deadline_at,is_revealed FROM rounds WHERE rooms_id = ? AND game_number = ? AND round_number = ?', [1, 1, 1]],
    ['history', 'SELECT id,rooms_id,game_number,round_number,word_one,word_two,word_three,deadline_at,is_revealed FROM rounds WHERE rooms_id = ? AND game_number = ? AND is_revealed = 1 ORDER BY round_number DESC LIMIT 100', [1, 1]],
    ['cleanup', 'SELECT id FROM rooms WHERE expires_at <= ? ORDER BY expires_at LIMIT 25', [now]],
  ] as const;
  const executionPlans = plans.map(([name, sql, params]) => ({ name, detail: db.all<{ detail: string }>('EXPLAIN QUERY PLAN ' + sql, ...params).map(row => row.detail) }));
  const counts = Object.fromEntries(['rooms', 'players', 'rounds'].map(table => [table, db.one<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count]));
  db.connection.pragma('wal_checkpoint(TRUNCATE)');
  const bytes = statSync(path).size;
  const start = performance.now();
  now += 60_001;
  const cleaned = service.cleanup();
  const cleanupMs = performance.now() - start;
  latencies.sort((a, b) => a - b);
  process.stdout.write(JSON.stringify({ environment: { node: process.version, platform: process.platform, arch: process.arch }, workload: '100 rooms × 20 automatically advanced rounds; 4000 apply+one-view-snapshot calls on local temporary SQLite WAL; excludes networking', counts, samples: latencies.length, p50Ms: latencies[Math.floor(latencies.length * .5)], p95Ms: latencies[Math.floor(latencies.length * .95)], maxMs: latencies.at(-1), checkpointedDatabaseBytes: bytes, cleanup: { rooms: cleaned.length, milliseconds: cleanupMs }, executionPlans, integrity: db.connection.pragma('integrity_check') }, null, 2) + '\n');
} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
