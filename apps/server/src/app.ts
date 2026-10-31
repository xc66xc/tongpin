import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClientEvents, Command, Reply, Seat, ServerEvents } from '@tongpin/shared';
import { GameDatabase } from './db.js';
import { GameError, GameService, type Identity } from './game.js';

interface AppOptions {
  dbPath: string; logger?: boolean; now?: () => number; ttlMs?: number;
  cleanupIntervalMs?: number; timeoutIntervalMs?: number; webRoot?: string; allowedOrigin?: string;
}
interface SocketData { identity?: Identity; count: number; windowStart: number }
type GameSocket = Socket<ClientEvents, ServerEvents, Record<string, never>, SocketData>;
const roomCode = z.string().regex(/^\d{6}$/);
const progress = { gameNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), roundNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) };
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), playerCount: z.union([z.literal(2), z.literal(3)]).optional(), roundSeconds: z.number().int().min(5).max(3600).optional(), maxRounds: z.number().int().min(1).max(1000).optional() }).strict(),
  z.object({ action: z.literal('join'), roomCode }).strict(),
  z.object({ action: z.literal('resume'), roomCode, token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal('submit'), ...progress, word: z.string().max(120) }).strict(),
  z.object({ action: z.literal('next'), ...progress }).strict(),
  z.object({ action: z.literal('raise'), ...progress }).strict(),
  z.object({ action: z.literal('again'), ...progress }).strict(),
]);

export async function createApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 8192, requestTimeout: 15_000, forceCloseConnections: true });
  const db = new GameDatabase(options.dbPath);
  const game = new GameService(db, options.now, options.ttlMs);
  const groups = new Map<number, Set<string>>();
  const entranceLimits = new Map<string, { start: number; count: number }>();
  const io = new Server<ClientEvents, ServerEvents, Record<string, never>, SocketData>(app.server, {
    maxHttpBufferSize: 8192, serveClient: false,
    cors: options.allowedOrigin ? { origin: options.allowedOrigin } : undefined,
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, !options.allowedOrigin || !origin || origin === options.allowedOrigin);
    },
  });
  const online = (roomId: number, seat: Seat): boolean => {
    for (const id of groups.get(roomId) ?? []) {
      if (io.sockets.sockets.get(id)?.data.identity?.seat === seat) return true;
    }
    return false;
  };
  const expireGroup = (roomId: number) => {
    const sockets = [...(groups.get(roomId) ?? [])];
    groups.delete(roomId);
    for (const id of sockets) {
      const socket = io.sockets.sockets.get(id);
      if (socket) { delete socket.data.identity; socket.emit('expired'); }
    }
  };
  const broadcast = (roomId: number) => {
    for (const id of groups.get(roomId) ?? []) {
      const socket = io.sockets.sockets.get(id);
      if (!socket?.data.identity) continue;
      try { socket.emit('snapshot', game.snapshot(socket.data.identity, online)); }
      catch (error) {
        if (error instanceof GameError && error.code === 'ROOM_EXPIRED') { expireGroup(roomId); return; }
        throw error;
      }
    }
  };
  const unbind = (socket: GameSocket) => {
    const previous = socket.data.identity;
    if (!previous) return;
    const group = groups.get(previous.roomId);
    group?.delete(socket.id);
    if (group?.size === 0) groups.delete(previous.roomId);
    delete socket.data.identity;
    game.presenceChanged(previous.roomId);
    broadcast(previous.roomId);
  };
  const bind = (socket: GameSocket, identity: Identity) => {
    const changed = socket.data.identity?.roomId !== identity.roomId || socket.data.identity.seat !== identity.seat;
    if (changed) unbind(socket);
    socket.data.identity = identity;
    const group = groups.get(identity.roomId) ?? new Set<string>();
    group.add(socket.id); groups.set(identity.roomId, group);
    if (changed) game.presenceChanged(identity.roomId);
  };
  const errorReply = (error: unknown, socket: GameSocket): Reply => {
    if (error instanceof GameError) {
      app.log.info({ tag: 'game.rejected', code: error.code, roomId: socket.data.identity?.roomId }, 'Command rejected');
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    app.log.error({ err: error, tag: '[error]', roomId: socket.data.identity?.roomId }, 'Game command failed');
    return { ok: false, error: { code: 'SERVER_ERROR', message: '服务暂时异常，请稍后重试。' } };
  };

  io.on('connection', socket => {
    socket.data.count = 0; socket.data.windowStart = Date.now();
    socket.on('command', (raw: unknown, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      try {
        const now = Date.now();
        if (now - socket.data.windowStart >= 10_000) { socket.data.count = 0; socket.data.windowStart = now; }
        if (++socket.data.count > 40) throw new GameError('RATE_LIMIT', '操作太快了，请稍等几秒。');
        const parsed = commandSchema.safeParse(raw);
        if (!parsed.success) throw new GameError('INVALID_INPUT', '输入格式不正确，请检查后重试。');
        const command: Command = parsed.data;
        let credentials;
        if (command.action === 'create' || command.action === 'join') {
          const ip = socket.handshake.address;
          let limit = entranceLimits.get(ip);
          if (!limit || now - limit.start >= 60_000) { limit = { start: now, count: 0 }; entranceLimits.set(ip, limit); }
          if (++limit.count > 120) throw new GameError('RATE_LIMIT', '创建或加入太频繁，请稍后重试。');
          const result = command.action === 'create' ? game.create(command) : game.join(command.roomCode);
          bind(socket, result.identity); credentials = result.credentials;
        } else if (command.action === 'resume') {
          bind(socket, game.resume(command.roomCode, command.token));
        } else {
          const identity = socket.data.identity;
          if (!identity) throw new GameError('UNAUTHORIZED', '请先创建或加入房间。');
          game.apply(identity, command);
        }
        const identity = socket.data.identity;
        if (!identity) throw new Error('Accepted command has no identity');
        const snapshot = game.snapshot(identity, online);
        acknowledge({ ok: true, snapshot, ...(credentials ? { credentials } : {}) });
        broadcast(identity.roomId);
        app.log.info({ tag: 'game.command', action: command.action, roomId: identity.roomId, seat: identity.seat, phase: snapshot.phase, roundNumber: snapshot.roundNumber }, 'Game command accepted');
      } catch (error) {
        acknowledge(errorReply(error, socket));
        // A rejected late submit may have committed the timeout first.
        if (socket.data.identity) {
          try { broadcast(socket.data.identity.roomId); }
          catch (broadcastError) { app.log.error({ err: broadcastError, tag: '[error]', roomId: socket.data.identity.roomId }, 'Rejected command state broadcast failed'); }
        }
      }
    });
    socket.on('disconnect', () => {
      try { unbind(socket); }
      catch (error) { app.log.error({ err: error, tag: '[error]' }, 'Disconnect broadcast failed'); }
    });
  });

  const cleanup = setInterval(() => {
    try {
      const expired = game.cleanup();
      for (const roomId of expired) expireGroup(roomId);
      const now = Date.now();
      for (const [ip, entry] of entranceLimits) if (now - entry.start >= 60_000) entranceLimits.delete(ip);
      if (expired.length) app.log.info({ tag: 'rooms.cleanup', count: expired.length }, 'Expired rooms removed');
    } catch (error) { app.log.error({ err: error, tag: '[error]' }, 'Room cleanup failed'); }
  }, options.cleanupIntervalMs ?? 60_000);
  cleanup.unref();

  const timeouts = setInterval(() => {
    try {
      const changed = game.processTimeouts((error, roomId) => {
        app.log.error({ err: error, tag: '[error]', operation: 'room.round_timeout', roomId }, 'Room timeout failed');
      });
      for (const roomId of changed) {
        try {
          broadcast(roomId);
          const state = db.one<{ phase: string; game_number: number; round_number: number }>('SELECT phase,game_number,round_number FROM rooms WHERE id = ?', roomId);
          app.log.info({ tag: 'room.round_timeout', roomId, phase: state?.phase, gameNumber: state?.game_number, roundNumber: state?.round_number }, 'Timed-out round revealed and settled');
        } catch (error) { app.log.error({ err: error, tag: '[error]', operation: 'room.round_timeout.broadcast', roomId }, 'Timeout state broadcast failed'); }
      }
    } catch (error) { app.log.error({ err: error, tag: '[error]', operation: 'room.round_timeout.scan' }, 'Timeout scan failed'); }
  }, options.timeoutIntervalMs ?? 500);
  timeouts.unref();

  app.addHook('preClose', async () => {
    clearInterval(cleanup);
    clearInterval(timeouts);
    await new Promise<void>(resolveClose => { io.close(() => resolveClose()); });
  });
  app.addHook('onClose', async () => { groups.clear(); entranceLimits.clear(); db.close(); });
  try {
    await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
    app.get('/api/health', async () => {
      db.one('SELECT 1 AS ready');
      return { status: 'ok' };
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Referrer-Policy', 'same-origin');
      reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    });
    const webRoot = options.webRoot ?? [resolve('apps/web/dist'), resolve('../web/dist')].find(path => existsSync(resolve(path, 'index.html')));
    if (webRoot) {
      await app.register(fastifyStatic, { root: resolve(webRoot), maxAge: 0 });
      app.setNotFoundHandler((request, reply) => {
        if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.includes('.')) return reply.sendFile('index.html');
        return reply.code(404).send({ message: 'Not found' });
      });
    }
    return app;
  } catch (error) { await app.close(); throw error; }
}
