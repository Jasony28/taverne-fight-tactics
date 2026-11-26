'use strict';
// Partie complète 8 bots, sans réseau : vérifie que la boucle de jeu va jusqu'au bout.
const assert = require('assert');
const GameRoom = require('../engine/GameRoom');
const FakeClock = require('./fakeClock');

function playGame(seed, difficulty = 'normal') {
  const clock = new FakeClock();
  const room = new GameRoom({ code: 'TEST', seed, clock });
  let combats = 0;
  const P = require('../engine/Player');
  room.on('combats', (m) => {
    combats += m.length;
    for (const pl of room.alivePlayers()) {
      const board = P.boardUnits(pl);
      assert.ok(board.length <= P.maxUnits(pl), pl.name + ' dépasse la limite du plateau');
      const cells = new Set(board.map((u) => u.row * 100 + u.col));
      assert.strictEqual(cells.size, board.length, 'deux unités sur la même case');
      for (const u of board) assert.ok(u.row >= 0 && u.row < 4 && u.col >= 0 && u.col < 7, 'case invalide');
      const slots = P.benchUnits(pl).map((u) => u.slot);
      assert.strictEqual(new Set(slots).size, slots.length, 'deux unités sur le même emplacement de banc');
      for (const s of slots) assert.ok(s >= 0 && s < 9, 'emplacement de banc invalide ' + s);
      for (const u of pl.units) assert.ok(u.items.length <= 3, 'plus de 3 objets');
      assert.ok(pl.gold >= 0, 'or négatif');
    }
  });
  const res = room.start(null, difficulty);
  assert.ok(res.ok, 'start');
  const done = clock.runUntil(() => room.status === 'finished');
  assert.ok(done, 'la partie doit se terminer (phase ' + room.phase + ' ' + room.label() + ')');
  const placements = room.players.map((p) => p.placement).sort((a, b) => a - b);
  assert.deepStrictEqual(placements, [1, 2, 3, 4, 5, 6, 7, 8], 'classement 1 à 8');
  // Le pool ne doit jamais être négatif.
  for (const [id, n] of Object.entries(room.shop.pool)) assert.ok(n >= 0, 'pool négatif ' + id);
  return { room, combats, lastRound: room.label() };
}

for (const [seed, diff] of [[1, 'normal'], [2, 'easy'], [3, 'competitive'], [4, 'normal']]) {
  const t0 = Date.now();
  const { room, combats, lastRound } = playGame(seed, diff);
  const winner = room.players.find((p) => p.placement === 1);
  console.log(`graine ${seed} (${diff}) : fin en ${lastRound}, ${combats} combats, gagnant ${winner.name} niv ${winner.level}, ${Date.now() - t0} ms`);
}
console.log('OK partie complète');
