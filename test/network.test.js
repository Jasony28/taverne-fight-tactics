'use strict';
// Test réseau : 2 humains (Socket.io + WebSocket brut) + 6 bots, partie accélérée jusqu'au bout.
process.env.TIME_SCALE = '40';
process.env.PORT = '0';
const assert = require('assert');
const { io } = require('socket.io-client');
const WebSocket = require('ws');
const { server } = require('../server');

server.listen(0, async () => {
  const port = server.address().port;
  const url = 'http://localhost:' + port;
  const a = io(url, { transports: ['websocket'] });
  const counts = { state: 0, replay: 0, phase: 0, rejected: 0, scout: 0 };
  let code = null;
  let aId = null;
  let over = null;

  a.on('room:joined', (d) => {
    code = d.roomCode;
    aId = d.playerId;
    // Second joueur : WebSocket standard avec enveloppe { event, payload } (comme un client Godot).
    const b = new WebSocket('ws://localhost:' + port + '/ws');
    b.on('open', () => b.send(JSON.stringify({ event: 'room:join', payload: { playerName: 'Godot', sessionId: 'sess-b', roomCode: code } })));
    b.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.event === 'room:joined' && m.payload.lobby.players.length === 2) {
        a.emit('room:start', { roomCode: code, botDifficulty: 'competitive' });
      }
      if (m.event === 'game:combat_replay') counts.wsReplay = (counts.wsReplay || 0) + 1;
    });
  });
  a.on('game:state_sync', (s) => {
    counts.state++;
    // Le joueur A achète ce qu'il peut pendant la préparation.
    if (s.phase.phase === 'planning' && s.self.alive) {
      const i = s.self.shop.findIndex((c) => c);
      if (i >= 0 && s.self.gold >= 5 && counts.state % 3 === 0) a.emit('action:buy_unit', { shopSlotIndex: i });
      if (s.self.augmentChoices) a.emit('action:pick_augment', { augmentId: s.self.augmentChoices.options[0] });
    }
    if (s.carousel && s.carousel.currentWave.includes(aId)) {
      const free = s.carousel.slots.findIndex((x) => !x.takenBy);
      a.emit('action:pick_carousel', { carouselSlotIndex: free });
    }
  });
  a.on('game:phase_change', () => counts.phase++);
  a.on('game:combat_replay', (r) => {
    counts.replay++;
    assert.ok(Array.isArray(r.eventLog) && r.initialUnits);
    if (counts.replay === 3) a.emit('action:scout_player', { targetPlayerId: 'bot1' });
  });
  a.on('game:scout', (s) => {
    counts.scout++;
    assert.ok(s.board.units);
  });
  a.on('error:action_rejected', () => counts.rejected++);
  a.on('game:over', (o) => {
    over = o;
    assert.strictEqual(o.ranking.length, 8);
    console.log('Partie réseau terminée :', JSON.stringify(counts), 'classement de A :', o.ranking.find((r) => r.id === aId).placement);
    process.exit(0);
  });
  a.emit('room:create', { playerName: 'Alice', sessionId: 'sess-a' });
  setTimeout(() => {
    console.error('Délai dépassé', counts, over);
    process.exit(1);
  }, 240000);
});
