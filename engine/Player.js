'use strict';
const Data = require('./Data');

// État d'un participant (humain ou bot). Aucune logique réseau ici.
let unitCounter = 0;
function newUid() {
  unitCounter += 1;
  return 'u' + unitCounter.toString(36);
}

function createPlayer({ id, name, sessionId = null, isBot = false, botDifficulty = 'normal' }) {
  const { balance } = Data.get();
  return {
    id,
    name,
    sessionId,
    isBot,
    botDifficulty,
    connected: !isBot,
    botControlled: isBot,
    disconnectedAt: null,
    hp: balance.player.start_hp,
    gold: balance.player.start_gold,
    level: balance.player.start_level,
    xp: 0,
    streak: 0, // > 0 : série de victoires, < 0 : série de défaites
    units: [], // { uid, champId, star, items: [], zone: 'board'|'bench', row, col, slot }
    itemBench: [], // identifiants d'objets (composants, objets complets, emblèmes)
    shop: [null, null, null, null, null],
    shopLocked: false,
    augments: [],
    augmentChoices: null, // { tier, options: [id,id,id], rerolled: [bool,bool,bool] }
    rerollCost: balance.shop.reroll_cost,
    freeRerollsPerRound: 0,
    freeRerolls: 0,
    oddsBonus: {}, // { "4": 0.10 }
    goldPerRound: [], // { amount, roundsLeft (null = permanent) }
    xpPerRound: 0,
    pendingUnits: [], // champions gagnés (PvE, carrousel) en attente d'une place sur le banc
    lastOpponentIds: [],
    alive: true,
    placement: null,
    eliminatedRound: null,
    lastCombat: null, // { won, damageTaken, opponentId }
    dpsLastCombat: [],
  };
}

function levelInfo(level) {
  const { balance } = Data.get();
  return balance.levels[Math.min(level, balance.levels.length) - 1];
}

function maxUnits(player) {
  return levelInfo(player.level).max_units;
}

function boardUnits(player) {
  return player.units.filter((u) => u.zone === 'board');
}

function benchUnits(player) {
  return player.units.filter((u) => u.zone === 'bench');
}

function freeBenchSlot(player) {
  const { balance } = Data.get();
  const used = new Set(benchUnits(player).map((u) => u.slot));
  for (let s = 0; s < balance.player.bench_size; s++) if (!used.has(s)) return s;
  return -1;
}

function unitAt(player, zone, row, col) {
  if (zone === 'bench') return player.units.find((u) => u.zone === 'bench' && u.slot === col);
  return player.units.find((u) => u.zone === 'board' && u.row === row && u.col === col);
}

function addXp(player, amount) {
  const { balance } = Data.get();
  player.xp += amount;
  while (player.level < balance.levels.length) {
    const need = levelInfo(player.level).xp_to_next;
    if (need == null || player.xp < need) break;
    player.xp -= need;
    player.level += 1;
  }
  if (player.level >= balance.levels.length) player.xp = 0;
}

function createUnit(champId, star = 1) {
  return { uid: newUid(), champId, star, items: [], zone: 'bench', row: null, col: null, slot: null };
}

module.exports = {
  createPlayer,
  createUnit,
  levelInfo,
  maxUnits,
  boardUnits,
  benchUnits,
  freeBenchSlot,
  unitAt,
  addXp,
  newUid,
};
