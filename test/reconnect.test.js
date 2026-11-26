'use strict';
// Déconnexion en partie : un bot reprend le plateau après 15 s, le joueur le récupère en revenant.
const assert = require('assert');
const GameRoom = require('../engine/GameRoom');
const FakeClock = require('./fakeClock');

const clock = new FakeClock();
const room = new GameRoom({ code: 'RECO', seed: 9, clock });
room.addHuman({ id: 'h1', name: 'Humain', sessionId: 's1' });
assert.ok(room.start('h1', 'normal').ok);
const me = room.getPlayer('h1');
assert.strictEqual(me.botControlled, false);

clock.runUntil(() => room.label() === '1-3' && room.phase === 'planning');
room.setConnected('h1', false);
const t0 = clock.now();
clock.runUntil(() => me.botControlled);
assert.ok(me.botControlled, 'le bot doit prendre le relais');
assert.ok(clock.now() - t0 >= 15000, 'pas avant 15 s');
assert.ok(me.alive, "le joueur n'est pas éliminé");

clock.runUntil(() => room.label() === '2-2');
room.setConnected('h1', true);
assert.strictEqual(me.botControlled, false, 'le joueur reprend la main');
assert.ok(me.units.length > 0, 'le bot a joué pour lui');

// Une déconnexion brève (< 15 s) ne déclenche pas de reprise.
room.setConnected('h1', false);
clock.runUntil(() => clock.now() - t0 > 0 && false, 50);
room.setConnected('h1', true);
clock.runUntil(() => room.label() === '2-4');
assert.strictEqual(me.botControlled, false);
console.log('OK reconnexion');
