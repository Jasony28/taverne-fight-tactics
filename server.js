'use strict';
// Serveur HTTP + Socket.io + WebSocket standard (client Godot) — routeur des événements réseau.
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { WebSocketServer } = require('ws');
const GameRoom = require('./engine/GameRoom');
const Data = require('./engine/Data');

const PORT = Number(process.env.PORT) || 3000;
const TIME_SCALE = Number(process.env.TIME_SCALE) || 1; // > 1 pour accélérer les parties (tests)

Data.get(); // valide le chargement des JSON au démarrage

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(path.join(__dirname, 'data')));
app.use('/config', express.static(path.join(__dirname, 'config')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));
// Contenu complet (avec emblèmes d'origine générés) pour les clients.
app.get('/api/content', (req, res) => {
  const d = Data.get();
  res.json({ traits: d.traits, champions: d.champions, items: d.items, augments: d.augments, balance: d.balance, monsters: d.pve.monsters });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const wss = new WebSocketServer({ noServer: true });
// Socket.io gère ses propres connexions ; /ws est réservé au WebSocket brut (client Godot).
server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.split('?')[0] === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
});

const rooms = new Map(); // code -> { room, clients: Map(playerId -> Set(client)) }
const sessions = new Map(); // sessionId -> { code, playerId }

const MESSAGES = {
  NOT_ENOUGH_GOLD: "Pas assez d'or.",
  BENCH_FULL: 'Banc plein.',
  BOARD_FULL: "Limite d'unités atteinte : achète de l'XP pour en placer plus.",
  BOARD_LOCKED: 'Le plateau est verrouillé pendant le combat.',
  ITEM_SLOTS_FULL: 'Cette unité porte déjà 3 objets.',
  ITEM_UNIQUE: 'Objet unique : déjà porté par cette unité.',
  EMBLEM_ALREADY_HAS_TRAIT: 'Cette unité possède déjà ce trait.',
  POOL_EMPTY: "Plus aucun exemplaire disponible.",
  ROOM_NOT_FOUND: 'Salon introuvable.',
  ROOM_FULL: 'Salon complet.',
  GAME_ALREADY_STARTED: 'La partie a déjà commencé.',
  NOT_HOST: "Seul l'hôte peut lancer la partie.",
  WRONG_PHASE: "Action impossible pendant cette phase.",
  NOT_YOUR_TURN: "Ce n'est pas encore ton tour au carrousel.",
  CAROUSEL_SLOT_TAKEN: 'Ce champion a déjà été pris.',
  MAX_LEVEL: 'Niveau maximum atteint.',
  NOT_IN_ROOM: "Tu n'es dans aucun salon.",
};

// --- Clients (Socket.io ou WebSocket brut avec enveloppe { event, payload }) ---

function wrapSocketIo(socket) {
  return {
    kind: 'socket.io',
    send: (event, payload) => socket.emit(event, payload),
    onAny: (handler) => socket.onAny((event, payload) => handler(event, payload)),
    onClose: (handler) => socket.on('disconnect', handler),
  };
}

function wrapWs(ws) {
  const handlers = [];
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg && typeof msg.event === 'string') for (const h of handlers) h(msg.event, msg.payload);
  });
  return {
    kind: 'ws',
    send: (event, payload) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ event, payload }));
    },
    onAny: (h) => handlers.push(h),
    onClose: (h) => ws.on('close', h),
  };
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function sendTo(entry, playerId, event, payload) {
  const set = entry.clients.get(playerId);
  if (set) for (const c of set) c.send(event, payload);
}

function broadcast(entry, event, payload) {
  for (const set of entry.clients.values()) for (const c of set) c.send(event, payload);
}

function syncAll(entry) {
  if (entry.syncPending) return;
  entry.syncPending = true;
  setImmediate(() => {
    entry.syncPending = false;
    for (const playerId of entry.clients.keys()) {
      const st = entry.room.stateFor(playerId);
      if (st) sendTo(entry, playerId, 'game:state_sync', st);
    }
  });
}

function replayPayload(match, viewerId) {
  return {
    matchId: match.matchId,
    homePlayer: match.homeId,
    awayPlayer: match.awayId,
    pve: Boolean(match.pve),
    ghost: Boolean(match.ghost),
    viewerSide: match.awayId === viewerId && !match.ghost ? 1 : 0,
    durationTicks: match.replay.durationTicks,
    initialUnits: match.replay.initialUnits,
    eventLog: match.replay.eventLog,
    result: match.replay.result,
    stats: match.replay.stats,
  };
}

function createRoomEntry() {
  const code = makeCode();
  const room = new GameRoom({ code, seed: crypto.randomInt(2 ** 31), timeScale: TIME_SCALE });
  const entry = { code, room, clients: new Map(), syncPending: false, createdAt: Date.now() };
  room.on('lobby', (lobby) => broadcast(entry, 'room:lobby', lobby));
  room.on('phase', (info) => {
    broadcast(entry, 'game:phase_change', info);
    syncAll(entry);
  });
  room.on('state', () => syncAll(entry));
  room.on('player_update', () => syncAll(entry));
  room.on('carousel', (c) => broadcast(entry, 'game:carousel', c));
  room.on('combats', (matches) => {
    for (const playerId of entry.clients.keys()) {
      const m = room.matchFor(playerId);
      if (m) sendTo(entry, playerId, 'game:combat_replay', replayPayload(m, playerId));
    }
  });
  room.on('eliminated', (e) => broadcast(entry, 'game:eliminated', e));
  room.on('takeover', (e) => broadcast(entry, 'game:takeover', e));
  room.on('finished', (f) => broadcast(entry, 'game:over', f));
  rooms.set(code, entry);
  return entry;
}

function attach(entry, playerId, client, sessionId) {
  if (!entry.clients.has(playerId)) entry.clients.set(playerId, new Set());
  entry.clients.get(playerId).add(client);
  sessions.set(sessionId, { code: entry.code, playerId });
  client.ctx = { code: entry.code, playerId, sessionId };
  entry.room.setConnected(playerId, true);
  client.send('room:joined', { roomCode: entry.code, playerId, lobby: entry.room.lobbyState() });
  if (entry.room.status !== 'lobby') {
    client.send('game:phase_change', entry.room.phaseInfo());
    client.send('game:state_sync', entry.room.stateFor(playerId));
    const m = entry.room.phase === 'combat' ? entry.room.matchFor(playerId) : null;
    if (m) client.send('game:combat_replay', replayPayload(m, playerId));
    if (entry.room.carousel) client.send('game:carousel', entry.room.carouselState());
  }
}

function detach(client) {
  const ctx = client.ctx;
  if (!ctx) return;
  const entry = rooms.get(ctx.code);
  client.ctx = null;
  if (!entry) return;
  const set = entry.clients.get(ctx.playerId);
  if (set) {
    set.delete(client);
    if (set.size === 0) {
      entry.clients.delete(ctx.playerId);
      entry.room.setConnected(ctx.playerId, false);
    }
  }
}

function reject(client, code, message) {
  client.send('error:action_rejected', { code, message: message || MESSAGES[code] || code });
}

function handle(client, event, payload = {}) {
  payload = payload || {};
  const sessionId = String(payload.sessionId || (client.ctx && client.ctx.sessionId) || '').slice(0, 64);

  if (event === 'session:resume') {
    const s = sessions.get(sessionId);
    const entry = s && rooms.get(s.code);
    if (!entry || !entry.room.getPlayer(s.playerId)) return client.send('session:none', {});
    return attach(entry, s.playerId, client, sessionId);
  }

  if (event === 'room:create') {
    if (!sessionId) return reject(client, 'SESSION_REQUIRED', 'Session manquante.');
    detach(client);
    const entry = createRoomEntry();
    const playerId = 'p_' + crypto.randomBytes(4).toString('hex');
    entry.room.addHuman({ id: playerId, name: payload.playerName, sessionId });
    return attach(entry, playerId, client, sessionId);
  }

  if (event === 'room:join') {
    if (!sessionId) return reject(client, 'SESSION_REQUIRED', 'Session manquante.');
    const code = String(payload.roomCode || '').toUpperCase().trim();
    const entry = rooms.get(code);
    if (!entry) return reject(client, 'ROOM_NOT_FOUND');
    const existing = entry.room.players.find((p) => p.sessionId === sessionId);
    detach(client);
    if (existing) return attach(entry, existing.id, client, sessionId);
    const playerId = 'p_' + crypto.randomBytes(4).toString('hex');
    const r = entry.room.addHuman({ id: playerId, name: payload.playerName, sessionId });
    if (!r.ok) return reject(client, r.error);
    return attach(entry, playerId, client, sessionId);
  }

  const ctx = client.ctx;
  const entry = ctx && rooms.get(ctx.code);
  if (!entry) return reject(client, 'NOT_IN_ROOM');
  const room = entry.room;

  switch (event) {
    case 'room:ready':
      return room.setReady(ctx.playerId, payload.ready);
    case 'room:leave':
      if (room.status === 'lobby') room.removeFromLobby(ctx.playerId);
      sessions.delete(ctx.sessionId);
      detach(client);
      return client.send('room:left', {});
    case 'room:start': {
      const r = room.start(ctx.playerId, payload.botDifficulty);
      if (!r.ok) reject(client, r.error);
      return;
    }
    case 'action:scout_player': {
      const target = room.getPlayer(payload.targetPlayerId);
      if (!target) return reject(client, 'PLAYER_NOT_FOUND', 'Joueur introuvable.');
      const view = room.boardView(target);
      const m = room.phase === 'combat' ? room.matchFor(target.id) : null;
      return client.send('game:scout', { board: view, replay: m ? replayPayload(m, target.id) : null });
    }
    default:
      if (event.startsWith('action:')) {
        const r = room.action(ctx.playerId, event.slice(7), payload);
        if (!r.ok) reject(client, r.error);
        else syncAll(entry);
      }
  }
}

function onClient(client) {
  client.onAny((event, payload) => {
    try {
      handle(client, event, payload);
    } catch (err) {
      console.error('Erreur sur', event, err);
      reject(client, 'SERVER_ERROR', 'Erreur serveur.');
    }
  });
  client.onClose(() => detach(client));
}

io.on('connection', (socket) => onClient(wrapSocketIo(socket)));
wss.on('connection', (ws) => onClient(wrapWs(ws)));

// Nettoyage des salons abandonnés.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of rooms) {
    const empty = entry.clients.size === 0;
    const old = now - entry.createdAt > 6 * 3600 * 1000;
    if ((empty && entry.room.status !== 'playing') || old || (empty && now - (entry.lastSeen || now) > 10 * 60 * 1000)) {
      entry.room.destroy();
      rooms.delete(code);
      for (const [sid, s] of sessions) if (s.code === code) sessions.delete(sid);
    } else if (!empty) entry.lastSeen = now;
  }
}, 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Taverne Fight Tactics : http://localhost:${PORT}`));
}

module.exports = { server, rooms };
