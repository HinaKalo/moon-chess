'use strict';

const { createServer } = require('node:http');
const { randomBytes, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Chess } = require('./vendor/chess.cjs');

const port = Number(process.env.PORT || 18887);
const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
const base = (process.env.BASE_PATH || '').replace(/\/$/, '');
const database = new DatabaseSync(process.env.DB_PATH || join(__dirname, 'rooms.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY, updated INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rooms_updated ON rooms (updated);
  CREATE TABLE IF NOT EXISTS archives (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, round INTEGER NOT NULL,
    finished INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE (code, round)
  );
`);
const load = database.prepare('SELECT data FROM rooms WHERE code = ?');
const insert = database.prepare('INSERT INTO rooms VALUES (?, ?, ?)');
const update = database.prepare('UPDATE rooms SET updated = ?, data = ? WHERE code = ?');
const count = database.prepare('SELECT count(*) AS total FROM rooms');
const stale = database.prepare('SELECT code FROM rooms WHERE updated < ?');
const remove = database.prepare('DELETE FROM rooms WHERE code = ?');
const saveArchive = database.prepare('INSERT INTO archives VALUES (?, ?, ?, ?, ?)');
const findArchive = database.prepare('SELECT * FROM archives WHERE id = ?');
const roomArchives = database.prepare('SELECT id, code, round, finished FROM archives WHERE code = ? ORDER BY round DESC LIMIT 50');
const archivedCode = database.prepare('SELECT 1 FROM archives WHERE code = ? LIMIT 1');
const runningRooms = database.prepare("SELECT data FROM rooms WHERE json_extract(data, '$.game.clock.deadline') IS NOT NULL");

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
].map(([path, [file, type]]) => [path, { type, data: readFileSync(join(__dirname, 'public', file)) }]));
const streams = new Map();
const rates = new Map();
const timers = new Map();
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const promotions = ['q', 'r', 'b', 'n'];
const square = /^[a-h][1-8]$/;
const expiry = 7 * 24 * 60 * 60 * 1000;
const minutes = [0, 1, 3, 5, 10, 15, 30, 60];
const standard = { minutes: 0 };
const other = side => side === 'w' ? 'b' : 'w';
const digest = token => createHash('sha256').update(token).digest('hex');

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function options(data) {
  const time = data.minutes === undefined ? 0 : data.minutes;
  if (!minutes.includes(time)) fail(400, '请选择有效的每方用时。');
  return { minutes: time };
}

function newGame(settings, startedAt = null) {
  const time = settings.minutes * 60_000;
  return {
    moves: [], result: null, ready: [], archiveId: null, offer: null, feedback: null,
    clock: time ? { remaining: { w: time, b: time }, turn: 'w', deadline: startedAt === null ? null : startedAt + time } : null
  };
}

function reply(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function allow(request, group, limit) {
  // The production listener is loopback-only and Caddy supplies the client address.
  const address = process.env.TRUST_PROXY === '1'
    ? request.headers['x-forwarded-for']?.split(',').at(-1).trim() || request.socket.remoteAddress
    : request.socket.remoteAddress;
  const key = group + ':' + address;
  let entry = rates.get(key);
  if (!entry || entry.until <= Date.now()) {
    if (rates.size >= 10000 && !entry) fail(429, '请求太多，请稍后再试。');
    entry = { until: Date.now() + 60_000, count: 0 };
    rates.set(key, entry);
  }
  if (++entry.count > limit) fail(429, '请求太频繁，请稍后再试。');
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    fail(415, '请求格式无效。');
  }
  if (Number(request.headers['content-length']) > 1024) fail(413, '请求过大。');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 1024) {
      request.resume();
      fail(413, '请求过大。');
    }
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks)); }
  catch { fail(400, '请求格式无效。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, '请求格式无效。');
  return data;
}

function identify(request, room) {
  const token = request.headers.cookie?.match(/(?:^|;\s*)chess_seat=([a-f0-9]{48})(?:;|$)/)?.[1];
  if (!token) return null;
  const hash = digest(token);
  return ['w', 'b'].find(side => room.seats[side] === hash) || null;
}

function reserve(response, room, side) {
  const token = randomBytes(24).toString('hex');
  room.seats[side] = digest(token);
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  response.setHeader('Set-Cookie', `chess_seat=${token}; Path=${base}/api/rooms/${room.code}; HttpOnly; SameSite=Strict; Max-Age=604800${secure}`);
}

function restore(moves, positions) {
  const engine = new Chess();
  positions?.push(engine.fen());
  for (const { from, to, promotion } of moves) {
    engine.move({ from, to, promotion });
    positions?.push(engine.fen());
  }
  return engine;
}

function state(room, engine = restore(room.game.moves)) {
  const viewers = [...(streams.get(room.code) || [])];
  const { moves, result, ready } = room.game;
  const playing = Boolean(room.seats.b && !result);
  const legal = playing ? engine.moves({ verbose: true }).map(({ from, to, promotion }) => promotion ? [from, to, promotion] : [from, to]) : [];
  return {
    code: room.code,
    round: room.round,
    version: room.version,
    joined: Boolean(room.seats.b),
    online: { w: viewers.some(v => v.side === 'w'), b: viewers.some(v => v.side === 'b') },
    fen: engine.fen(),
    turn: engine.turn(),
    check: playing && engine.isCheck(),
    settings: room.settings || standard,
    clock: room.game.clock || null,
    serverNow: Date.now(),
    offer: room.game.offer || null,
    feedback: room.game.feedback || null,
    legal,
    moves,
    result,
    archiveId: room.game.archiveId,
    archives: roomArchives.all(room.code),
    ready
  };
}

function emit(viewer, snapshot) {
  if (viewer.response.destroyed) return;
  if (viewer.response.writableLength > 128 * 1024) {
    viewer.response.destroy();
    return;
  }
  viewer.response.write(`data: ${JSON.stringify({ ...snapshot, side: viewer.side })}\n\n`);
}

function publish(room, snapshot = state(room)) {
  for (const viewer of streams.get(room.code) || []) {
    viewer.side = room.seats.w === viewer.hash ? 'w' : 'b';
    emit(viewer, snapshot);
  }
}

function listen(response, room, side) {
  const viewers = streams.get(room.code) || new Set();
  const hash = room.seats[side];
  if ([...viewers].filter(v => v.hash === hash).length >= 5) fail(429, '此席位打开了太多页面。');
  const viewer = { response, side, hash };
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  response.write('retry: 1500\n\n');
  viewers.add(viewer);
  streams.set(room.code, viewers);
  const heartbeat = setInterval(() => {
    if (response.writableLength > 128 * 1024) response.destroy();
    else response.write(': heartbeat\n\n');
  }, 10_000);
  response.on('close', () => {
    clearInterval(heartbeat);
    viewers.delete(viewer);
    if (!viewers.size) streams.delete(room.code);
    else {
      const record = load.get(room.code);
      if (record) publish(JSON.parse(record.data));
    }
  });
  publish(room);
}

function charge(clock, now) {
  if (clock?.deadline === null || !clock) return;
  clock.remaining[clock.turn] = Math.max(0, clock.deadline - now);
}

function switchClock(clock, turn, now) {
  if (!clock) return;
  charge(clock, now);
  clock.turn = turn;
  clock.deadline = now + clock.remaining[turn];
}

function finish(game, winner, reason, now) {
  charge(game.clock, now);
  if (game.clock) game.clock.deadline = null;
  game.offer = null;
  game.feedback = null;
  game.result = { winner, reason };
}

function negotiate(room, side, action, data, now) {
  const { game } = room;
  const { offer } = game;
  if (action === 'offer') {
    if (offer) fail(409, '请先处理当前申请。');
    if (!['undo', 'draw'].includes(data.kind)) fail(400, '申请类型无效。');
    if (data.kind === 'undo' && !game.moves.some(move => move.color === side)) fail(409, '你还没有可撤回的走子。');
    game.offer = { kind: data.kind, from: side };
    game.feedback = null;
    return;
  }

  if (!offer) fail(409, '该申请已失效。');
  if (data.decision === 'cancel') {
    if (offer.from !== side) fail(403, '只有申请方可以撤回申请。');
  } else {
    if (!['accept', 'decline'].includes(data.decision)) fail(400, '请选择接受或拒绝。');
    if (offer.from === side) fail(403, '请等待对方确认。');
  }
  game.offer = null;
  game.feedback = { kind: offer.kind, decision: data.decision };
  if (data.decision !== 'accept') return;
  if (offer.kind === 'draw') {
    finish(game, null, 'agreedDraw', now);
    return;
  }
  game.moves.length = game.moves.findLastIndex(move => move.color === offer.from);
  const engine = restore(game.moves);
  switchClock(game.clock, engine.turn(), now);
  return engine;
}

function play(room, side, action, data, now) {
  if (!room.seats.b) fail(409, '好友入座后即可开局。');
  const game = room.game;

  if (action === 'rematch') {
    if (data.round !== room.round) fail(409, '棋局已更新，请重试。');
    if (!game.result) fail(409, '对局结束后才能再来一局。');
    if (game.ready.includes(side)) return;
    game.ready.push(side);
    if (game.ready.length === 2) {
      [room.seats.w, room.seats.b] = [room.seats.b, room.seats.w];
      room.round++;
      room.game = newGame(room.settings || standard, now);
    }
    return;
  }

  if (data.version !== room.version) fail(409, '棋局已更新，请重试。');
  if (game.result) fail(409, '这局已经结束。');
  if (action === 'resign') {
    finish(game, other(side), 'resigned', now);
    return;
  }
  if (action === 'offer' || action === 'respond') return negotiate(room, side, action, data, now);

  const { from, to, promotion } = data;
  if (typeof from !== 'string' || typeof to !== 'string' || !square.test(from) || !square.test(to) ||
      (promotion !== undefined && !promotions.includes(promotion))) fail(400, '棋格或升变棋子无效。');
  const engine = restore(game.moves);
  if (engine.turn() !== side) fail(409, '还没轮到你。');
  const available = engine.moves({ square: from, verbose: true });
  if (!available.some(move => move.to === to && move.promotion === promotion)) {
    fail(422, '这步棋不能走。');
  }
  const { san, color } = engine.move({ from, to, promotion });
  game.feedback = game.offer ? { kind: game.offer.kind, decision: 'expired' } : null;
  game.offer = null;
  if (engine.isCheckmate()) finish(game, side, 'checkmate', now);
  else if (engine.isStalemate()) finish(game, null, 'stalemate', now);
  else if (engine.isInsufficientMaterial()) finish(game, null, 'material', now);
  else if (engine.isThreefoldRepetition()) finish(game, null, 'repetition', now);
  else if (engine.isDrawByFiftyMoves()) finish(game, null, 'fifty', now);
  game.moves.push({ from, to, promotion, color, san });
  if (!game.result) switchClock(game.clock, engine.turn(), now);
  return engine;
}

function persist(room) {
  const now = Date.now();
  const { game } = room;
  if (game.result && !game.archiveId) {
    game.archiveId = randomBytes(18).toString('hex');
    database.exec('BEGIN');
    try {
      saveArchive.run(game.archiveId, room.code, room.round, now, JSON.stringify({
        moves: game.moves,
        result: game.result,
        settings: room.settings || standard
      }));
      update.run(now, JSON.stringify(room), room.code);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } else {
    update.run(now, JSON.stringify(room), room.code);
  }
}

function schedule(room) {
  clearTimeout(timers.get(room.code));
  timers.delete(room.code);
  const deadline = room.game.clock?.deadline;
  if (deadline == null) return;
  const code = room.code;
  timers.set(code, setTimeout(() => {
    timers.delete(code);
    const record = load.get(code);
    if (!record) return;
    const current = JSON.parse(record.data);
    if (!expireClock(current, Date.now())) schedule(current);
  }, Math.max(0, deadline - Date.now())).unref());
}

function expireClock(room, now) {
  const clock = room.game.clock;
  if (clock?.deadline == null || now < clock.deadline) return false;
  finish(room.game, other(clock.turn), 'timeout', now);
  room.version++;
  persist(room);
  schedule(room);
  publish(room);
  return true;
}

function archive(response, id, download) {
  const record = findArchive.get(id);
  if (!record) fail(404, '找不到这份棋谱。');
  const { data, ...info } = record;
  const { moves, result, settings = standard } = JSON.parse(data);
  const positions = [];
  const engine = restore(moves, positions);
  if (!download) return reply(response, 200, { ...info, moves, result, settings, positions });
  const score = result.winner === 'w' ? '1-0' : result.winner === 'b' ? '0-1' : '1/2-1/2';
  engine.setHeader('Event', 'Moon GameHub Chess');
  engine.setHeader('Site', origin + base + '/');
  engine.setHeader('Date', new Date(info.finished).toISOString().slice(0, 10).replaceAll('-', '.'));
  engine.setHeader('Round', String(info.round));
  engine.setHeader('White', 'White');
  engine.setHeader('Black', 'Black');
  engine.setHeader('Result', score);
  if (settings.minutes) engine.setHeader('TimeControl', settings.minutes * 60 + '+0');
  response.writeHead(200, {
    'Content-Type': 'application/x-chess-pgn; charset=utf-8',
    'Content-Disposition': `attachment; filename="chess-${info.code}-${info.round}.pgn"`
  });
  response.end(engine.pgn({ maxWidth: 78 }) + '\n');
}

async function route(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const { pathname } = new URL(request.url, origin);
  if (!pathname.startsWith(base + '/')) fail(404, '页面不存在。');
  const path = pathname.slice(base.length);
  if (request.method === 'GET' && files.has(path)) {
    const file = files.get(path);
    response.writeHead(200, { 'Content-Type': file.type });
    response.end(file.data);
    return;
  }
  if (request.method === 'GET' && path === '/health') return reply(response, 200, { ok: true });
  const replay = path.match(/^\/api\/archives\/([a-f0-9]{36})(\/download)?$/);
  if (request.method === 'GET' && replay) {
    allow(request, 'read', 240);
    return archive(response, replay[1], Boolean(replay[2]));
  }
  const creating = path === '/api/rooms' && request.method === 'POST';
  const match = path.match(/^\/api\/rooms\/([2-9A-HJ-NP-Z]{8})(?:\/(info|join|events|move|resign|rematch|offer|respond))?$/);
  if (!creating && !match) fail(404, '房间或页面不存在。');

  let data;
  if (request.method === 'POST') {
    if (request.headers.origin !== origin) fail(403, '请从 GameHub 内操作。');
    allow(request, creating || match[2] === 'join' ? 'entry' : 'play', creating || match[2] === 'join' ? 40 : 240);
    data = await readBody(request);
  } else {
    allow(request, 'read', 240);
  }
  // Read and mutate synchronously after the request body is complete.
  if (creating) {
    const settings = options(data);
    if (count.get().total >= 10000) fail(503, '房间已满，请稍后再试。');
    let code;
    do {
      code = Array.from(randomBytes(8), byte => alphabet[byte & 31]).join('');
    } while (load.get(code) || archivedCode.get(code));
    const room = { code, seats: { w: null, b: null }, round: 1, version: 0, settings, game: newGame(settings) };
    reserve(response, room, 'w');
    insert.run(code, Date.now(), JSON.stringify(room));
    return reply(response, 201, { ...state(room), side: 'w' });
  }

  const [, code, action] = match;
  const record = load.get(code);
  if (!record) fail(404, '房间不存在或已过期，请重新开房。');
  const room = JSON.parse(record.data);
  const now = Date.now();
  const timedOut = expireClock(room, now);
  let side = identify(request, room);
  if (request.method === 'GET' && action === 'info') {
    const settings = room.settings || standard;
    return reply(response, 200, { settings, fen: new Chess().fen(), joined: Boolean(room.seats.b) });
  }

  if (request.method === 'POST' && action === 'join') {
    if (!side) {
      if (room.seats.b) fail(409, '两个席位已坐满。');
      side = 'b';
      reserve(response, room, side);
      room.version++;
      room.game = newGame(room.settings || standard, now);
      persist(room);
      schedule(room);
      publish(room);
    }
    return reply(response, 200, { ...state(room), side });
  }
  if (!side) fail(401, '请先入座。');
  if (request.method === 'GET' && !action) return reply(response, 200, { ...state(room), side });
  if (request.method === 'GET' && action === 'events') return listen(response, room, side);
  if (request.method === 'POST' && ['move', 'resign', 'rematch', 'offer', 'respond'].includes(action)) {
    if (timedOut) return reply(response, 200, { ...state(room), side });
    const engine = play(room, side, action, data, now);
    room.version++;
    persist(room);
    schedule(room);
    side = identify(request, room);
    for (const viewer of streams.get(code) || []) viewer.side = room.seats.w === viewer.hash ? 'w' : 'b';
    const snapshot = state(room, engine);
    publish(room, snapshot);
    return reply(response, 200, { ...snapshot, side });
  }
  fail(405, '此操作不可用。');
}

setInterval(() => {
  for (const [key, entry] of rates) if (entry.until <= Date.now()) rates.delete(key);
  for (const { code } of stale.all(Date.now() - expiry)) if (!streams.has(code)) remove.run(code);
}, 60_000).unref();
for (const { data } of runningRooms.all()) schedule(JSON.parse(data));

const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, (request, response) => {
  route(request, response).catch(error => {
    if (!error.status) console.error(error);
    if (response.headersSent) return response.destroy();
    response.removeHeader('Set-Cookie');
    reply(response, error.status || 500, { error: error.status ? error.message : '服务暂时不可用，请稍后再试。' });
  });
});
server.maxConnections = 1024;
if (process.connected) process.on('disconnect', () => process.exit(0));
server.listen(port, '127.0.0.1', () => console.log(`Chess listening on 127.0.0.1:${port}${base}/`));
