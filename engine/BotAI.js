'use strict';
const Data = require('./Data');
const P = require('./Player');
const ItemManager = require('./ItemManager');
const TraitManager = require('./TraitManager');

// IA des bots : économie, achats pondérés, montée de niveau, placement, objets, augments.

function champ(id) {
  return Data.get().championById[id];
}

function roundIndex(label) {
  const [s, r] = label.split('-').map(Number);
  return s * 10 + r;
}

function config(p) {
  const { bots } = Data.get().balance;
  return bots.difficulty[p.botDifficulty] || bots.difficulty.normal;
}

// Case libre préférée selon la portée : corps à corps devant, distance dans les coins arrière.
function freeCellFor(p, range, balance = Data.get().balance) {
  const rows = balance.combat.board_rows;
  const cols = balance.combat.cols;
  const taken = new Set(P.boardUnits(p).map((u) => u.row * 100 + u.col));
  const rowOrder = range <= 1 ? [0, 1, 2, 3] : range === 2 ? [1, 2, 0, 3] : [3, 2, 1, 0];
  const colOrder = range >= 3 ? [0, 6, 1, 5, 2, 4, 3] : [3, 2, 4, 1, 5, 0, 6];
  for (const r of rowOrder) {
    if (r >= rows) continue;
    for (const c of colOrder) {
      if (c >= cols) continue;
      if (!taken.has(r * 100 + c)) return { row: r, col: c };
    }
  }
  return null;
}

// Valeur d'une unité pour décider qui joue sur le plateau.
function unitValue(p, u) {
  const c = champ(u.champId);
  const owned = new Set(P.boardUnits(p).map((x) => x.champId));
  let synergy = 0;
  for (const t of ItemManager.unitTraits(u)) {
    synergy += p.units.filter((x) => x !== u && owned.has(x.champId) && ItemManager.unitTraits(x).includes(t)).length;
  }
  return c.cost * Math.pow(3, u.star - 1) * 10 + u.items.length * 6 + synergy * 4;
}

// Score d'une carte de boutique (cahier des charges §3.2).
function shopScore(room, p, champId) {
  const c = champ(champId);
  const same1 = p.units.filter((u) => u.champId === champId && u.star === 1).length;
  const same2 = p.units.filter((u) => u.champId === champId && u.star === 2).length;
  let score = 0;
  if (same1 === 2 || (same1 >= 1 && same2 === 2)) score += 100; // fusion 2★ ou 3★
  if (same1 + same2 > 0) score += 45;
  const boardTraits = TraitManager.computeTraits(P.boardUnits(p));
  for (const t of c.traits) {
    const info = boardTraits.find((x) => x.id === t);
    if (!info) continue;
    const next = info.breakpoints.find((b) => b > info.count);
    if (next && next - info.count <= 1) score += 30; // active ou rapproche un palier
    else if (info.count > 0) score += 15;
  }
  if (room.stage >= 4) score += 10 * c.cost;
  else score += 4 * c.cost;
  return score;
}

function reserveGold(room, p) {
  const { bots } = Data.get().balance;
  if (p.hp < bots.panic_hp) return 0; // mode panique : tout dépenser
  const keep = bots.interest_thresholds.filter((t) => t <= p.gold).pop() || 0;
  return room.stage <= 1 ? 0 : keep;
}

function levelUp(room, p) {
  const { bots, shop } = Data.get().balance;
  const now = roundIndex(room.label());
  let target = 0;
  let minGold = 0;
  for (const step of bots.level_plan) {
    if (now >= roundIndex(step.round)) {
      target = step.level;
      minGold = step.min_gold || 0;
    }
  }
  if (p.hp < bots.panic_hp && room.stage >= 4) target = Math.max(target, Math.min(8, p.level + 1));
  while (p.level < target && p.gold >= shop.xp_cost && p.gold - shop.xp_cost >= Math.min(minGold, p.gold)) {
    if (minGold && p.gold < minGold) break;
    room.doAction(p, 'buy_xp', {});
  }
}

function buyPhase(room, p, threshold) {
  for (let pass = 0; pass < 2; pass++) {
    const offers = p.shop
      .map((id, i) => ({ id, i, score: id ? shopScore(room, p, id) : -1 }))
      .filter((o) => o.id)
      .sort((a, b) => b.score - a.score);
    for (const o of offers) {
      const cost = champ(o.id).cost;
      const reserve = reserveGold(room, p);
      const mustBuy = o.score >= 100;
      if (o.score < threshold && !mustBuy) continue;
      if (p.gold - cost < reserve && !mustBuy) continue;
      if (p.gold < cost) continue;
      if (!room.shop.canReceive(p, o.id)) {
        if (!sellWorstBench(room, p, o.id)) continue;
      }
      room.doAction(p, 'buy_unit', { shopSlotIndex: o.i });
    }
  }
}

function sellWorstBench(room, p, protectChampId = null) {
  const bench = P.benchUnits(p).filter((u) => u.champId !== protectChampId);
  if (!bench.length) return false;
  const counts = {};
  for (const u of p.units) counts[u.champId] = (counts[u.champId] || 0) + 1;
  bench.sort((a, b) => counts[a.champId] - counts[b.champId] || unitValue(p, a) - unitValue(p, b));
  const victim = bench[0];
  if (counts[victim.champId] >= 2 && P.freeBenchSlot(p) >= 0) return false;
  room.doAction(p, 'sell_unit', { unitInstanceId: victim.uid });
  return true;
}

function rerollPhase(room, p) {
  const { bots } = Data.get().balance;
  const panic = p.hp < bots.panic_hp;
  let guard = 0;
  while (guard++ < 15) {
    const reserve = panic ? 0 : room.stage >= 4 ? 50 : Infinity;
    if (p.freeRerolls <= 0 && p.gold - p.rerollCost < reserve) break;
    if (p.freeRerolls <= 0 && p.gold < p.rerollCost) break;
    room.doAction(p, 'reroll', {});
    buyPhase(room, p, 45);
  }
}

// Placement : meilleures unités sur le plateau, positions selon la portée.
// On repart de zéro : les unités choisies vont sur le plateau, les autres sur le banc.
function arrangeBoard(room, p) {
  const { balance } = Data.get();
  const all = p.units.slice().sort((a, b) => unitValue(p, b) - unitValue(p, a));
  const chosen = all.slice(0, P.maxUnits(p));
  const rest = all.slice(P.maxUnits(p));
  for (const u of p.units) u.zone = 'none';
  const order = chosen.slice().sort((a, b) => champ(a.champId).stats.range - champ(b.champId).stats.range);
  for (const u of order) {
    const cell = freeCellFor(p, champ(u.champId).stats.range, balance);
    if (cell) room.place(u, 'board', cell.row, cell.col);
    else rest.push(u);
  }
  let slot = 0;
  for (const u of rest) room.place(u, 'bench', null, slot++);
}

// Objets : sur le carry dont le profil correspond le mieux (AD, AP, tank).
function itemAffinity(u, itemId) {
  const role = champ(u.champId).role;
  const st = Data.get().itemById[itemId].stats || {};
  const ad = (st.ad || 0) + (st.attack_speed || 0) * 60 + (st.crit_chance || 0) * 60;
  const ap = (st.ap || 0) + (st.mana_start || 0);
  const tank = (st.armor || 0) + (st.mr || 0) + (st.hp || 0) / 8;
  if (role === 'mage' || role === 'support') return ap * 2 + tank * 0.5 + ad * 0.3;
  if (role === 'tank') return tank * 2 + ap * 0.3 + ad * 0.3;
  return ad * 2 + tank * 0.4 + ap * 0.3;
}

function equipItems(room, p) {
  let guard = 0;
  while (p.itemBench.length && guard++ < 20) {
    const board = P.boardUnits(p);
    if (!board.length) break;
    const idx = 0;
    const itemId = p.itemBench[idx];
    const candidates = board
      .map((u) => ({ u, score: itemAffinity(u, itemId) + champ(u.champId).cost * 3 * u.star + u.items.length * 5 }))
      .sort((a, b) => b.score - a.score);
    let done = false;
    for (const c of candidates) {
      if (ItemManager.previewEquip(c.u, itemId).ok) {
        room.doAction(p, 'equip_item', { itemIndex: idx, unitInstanceId: c.u.uid });
        done = true;
        break;
      }
    }
    if (!done) {
      // Objet inutilisable pour l'instant : on le garde en fin de liste.
      p.itemBench.push(p.itemBench.shift());
      if (guard > p.itemBench.length) break;
    }
  }
}

function chooseAugment(room, p) {
  const { augmentById } = Data.get();
  const c = p.augmentChoices;
  if (!c) return null;
  if (!config(p).uses_augments_smartly) return room.rng.pick(c.options);
  const boardTraits = TraitManager.computeTraits(P.boardUnits(p));
  const score = (id) => {
    const a = augmentById[id];
    if (a.effect_type === 'trait_emblem') {
      const t = boardTraits.find((x) => x.id === a.params.trait_id);
      return t ? 40 + t.count * 12 : 10;
    }
    if (a.effect_type === 'team_stat') {
      if (a.params.scope === 'trait_units') {
        const t = boardTraits.find((x) => x.id === a.params.trait_id);
        return t ? 30 + t.count * 10 : 5;
      }
      return 45;
    }
    if (a.effect_type === 'grant_gold') return room.stage <= 3 ? 50 : 30;
    if (a.effect_type === 'grant_xp') return room.stage <= 3 ? 42 : 25;
    if (a.effect_type === 'shop_modifier') return 35;
    return 20;
  };
  return c.options.slice().sort((a, b) => score(b) - score(a))[0];
}

function chooseCarousel(room, p) {
  const c = room.carousel;
  const free = c.slots.map((s, i) => ({ s, i })).filter((x) => !x.s.takenBy);
  if (!free.length) return 0;
  free.sort((a, b) => shopScore(room, p, b.s.champId) - shopScore(room, p, a.s.champId));
  return free[0].i;
}

// Cycle de décision (appelé à 3 s, 12 s et 22 s de la préparation).
function decide(room, p, moment) {
  const cfg = config(p);
  if (room.rng.chance(cfg.mistake_rate)) {
    arrangeBoard(room, p);
    return;
  }
  if (p.augmentChoices) room.doAction(p, 'pick_augment', { augmentId: chooseAugment(room, p) });
  levelUp(room, p);
  buyPhase(room, p, 40);
  if (moment >= 12) rerollPhase(room, p);
  room.shop.flushPending(p);
  arrangeBoard(room, p);
  equipItems(room, p);
  // Banc trop plein : on revend les unités isolées.
  while (P.freeBenchSlot(p) < 0 && sellWorstBench(room, p)) {
    /* boucle */
  }
}

module.exports = { decide, chooseAugment, chooseCarousel, freeCellFor, arrangeBoard, shopScore };
