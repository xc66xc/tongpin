import { z } from 'zod';
import { resolve } from 'node:path';
import { createApp } from './app.js';

const env = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_PATH: z.string().min(1).default('./data/tongpin.db'),
  ALLOWED_ORIGIN: z.url().optional(), WEB_ROOT: z.string().optional(),
}).parse(process.env);
const app = await createApp({ dbPath: resolve(env.DATABASE_PATH), logger: true, allowedOrigin: env.ALLOWED_ORIGIN, webRoot: env.WEB_ROOT });
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await app.close(); }
  catch (error) { app.log.error({ err: error, tag: '[error]' }, 'Shutdown failed'); process.exitCode = 1; }
};
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try { await app.listen({ host: env.HOST, port: env.PORT }); }
catch (error) { app.log.error({ err: error, tag: '[error]' }, 'Startup failed'); await shutdown(); process.exitCode = 1; }
