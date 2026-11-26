'use strict';
const Data = require('./Data');
const P = require('./Player');

// Pool partagé, tirages pondérés, achats, ventes et fusions d'étoiles.
const COPIES_BY_STAR = { 1: 1, 2: 3, 3: 9 };

class ShopManager {
  constructor(rng) {
    const { champions, balance } = Data.get();
    this.rng = rng;
    this.pool = {};
    for (const c of champions) this.pool[c.id] = balance.pool_size_by_cost[String(c.cost)];
  }

  oddsFor(player) {
    const odds = P.levelInfo(player.level).odds.slice();
    // Bonus d'augment : ajouté au coût visé (s'il est déjà disponible), retiré au coût 1 puis 2, etc.
    for (const [costStr, bonus] of Object.entries(player.oddsBonus || {})) {
      const idx = Number(costStr) - 1;
      if (odds[idx] <= 0) continue;
      let remaining = bonus;
      for (let i = 0; i < odds.length && remaining > 0; i++) {
        if (i === idx) continue;
        const take = Math.min(odds[i], remaining);
        odds[i] -= take;
        remaining -= take;
      }
      odds[idx] += bonus - remaining;
    }
    return odds;
  }

  rollOne(player) {
    const { champions } = Data.get();
    const odds = this.oddsFor(player);
    // Si un coût est épuisé, on retombe sur les autres coûts.
    for (let attempt = 0; attempt < 6; attempt++) {
      const cost = this.rng.weighted(odds) + 1;
      const candidates = champions.filter((c) => c.cost === cost && this.pool[c.id] > 0);
      if (candidates.length) {
        const idx = this.rng.weighted(candidates.map((c) => this.pool[c.id]));
        return candidates[idx].id;
      }
      odds[cost - 1] = 0;
      if (odds.every((o) => o <= 0)) break;
    }
    return null;
  }

  refresh(player) {
    const { balance } = Data.get();
    player.shop = [];
    for (let i = 0; i < balance.shop.slots; i++) player.shop.push(this.rollOne(player));
  }

  reroll(player) {
    if (player.freeRerolls > 0) {
      player.freeRerolls -= 1;
    } else {
      if (player.gold < player.rerollCost) return { ok: false, error: 'NOT_ENOUGH_GOLD' };
      player.gold -= player.rerollCost;
    }
    this.refresh(player);
    return { ok: true };
  }

  // Un achat est possible si une place se libère sur le banc ou si l'achat déclenche une fusion.
  canReceive(player, champId) {
    if (P.freeBenchSlot(player) >= 0) return true;
    const owned = player.units.filter((u) => u.champId === champId && u.star === 1).length;
    return owned >= 2;
  }

  buy(player, slotIndex) {
    const { championById } = Data.get();
    const champId = player.shop[slotIndex];
    if (!champId) return { ok: false, error: 'SHOP_SLOT_EMPTY' };
    const champ = championById[champId];
    if (player.gold < champ.cost) return { ok: false, error: 'NOT_ENOUGH_GOLD' };
    if (this.pool[champId] <= 0) return { ok: false, error: 'POOL_EMPTY' };
    if (!this.canReceive(player, champId)) return { ok: false, error: 'BENCH_FULL' };
    player.gold -= champ.cost;
    this.pool[champId] -= 1;
    player.shop[slotIndex] = null;
    this.giveUnit(player, champId, 1, true);
    return { ok: true };
  }

  // Ajoute une unité (achat, carrousel, butin). Si le banc est plein et qu'aucune fusion
  // n'est possible, l'unité est mise en attente (jamais perdue).
  giveUnit(player, champId, star = 1, fromPool = false, items = []) {
    const unit = P.createUnit(champId, star);
    unit.items = items.slice();
    const slot = P.freeBenchSlot(player);
    if (slot >= 0) {
      unit.zone = 'bench';
      unit.slot = slot;
      player.units.push(unit);
    } else {
      // Banc plein : on l'ajoute « virtuellement » pour tenter une fusion immédiate.
      unit.zone = 'bench';
      unit.slot = -1;
      player.units.push(unit);
    }
    this.mergeAll(player);
    if (unit.slot === -1 && player.units.includes(unit)) {
      player.units = player.units.filter((u) => u !== unit);
      player.pendingUnits.push({ champId, star, items: unit.items });
    }
    void fromPool;
    return unit;
  }

  // Place les unités en attente dès qu'un emplacement se libère.
  flushPending(player) {
    while (player.pendingUnits.length && P.freeBenchSlot(player) >= 0) {
      const p = player.pendingUnits.shift();
      this.giveUnit(player, p.champId, p.star, false, p.items);
    }
  }

  mergeAll(player) {
    const { balance } = Data.get();
    let merged = true;
    while (merged) {
      merged = false;
      for (const star of [1, 2]) {
        const groups = {};
        for (const u of player.units) {
          if (u.star !== star) continue;
          (groups[u.champId] = groups[u.champId] || []).push(u);
        }
        for (const list of Object.values(groups)) {
          if (list.length < 3) continue;
          // On garde de préférence une unité déjà sur le plateau.
          const rank = (u) => (u.zone === 'board' ? 0 : u.slot === -1 ? 2 : 1);
          const trio = list
            .slice()
            .sort((a, b) => rank(a) - rank(b))
            .slice(0, 3);
          const keeper = trio.find((u) => u.slot !== -1) || trio[0];
          const others = trio.filter((u) => u !== keeper);
          const allItems = trio.flatMap((u) => u.items);
          keeper.star = star + 1;
          keeper.items = allItems.slice(0, balance.player.max_items_per_unit);
          player.itemBench.push(...allItems.slice(balance.player.max_items_per_unit));
          if (keeper.slot === -1) {
            const freed = others.find((u) => u.zone === 'bench' && u.slot >= 0) || others.find((u) => u.zone === 'board');
            if (freed) {
              keeper.zone = freed.zone;
              keeper.slot = freed.slot;
              keeper.row = freed.row;
              keeper.col = freed.col;
            }
          }
          player.units = player.units.filter((u) => !others.includes(u));
          merged = true;
        }
      }
    }
  }

  sellValue(unit) {
    const { championById, balance } = Data.get();
    const cost = championById[unit.champId].cost;
    if (unit.star === 1) return cost;
    return cost * COPIES_BY_STAR[unit.star] - (cost >= 2 ? balance.sell.upgraded_refund_minus : 0);
  }

  sell(player, uid) {
    const unit = player.units.find((u) => u.uid === uid);
    if (!unit) return { ok: false, error: 'UNIT_NOT_FOUND' };
    player.gold += this.sellValue(unit);
    this.pool[unit.champId] += COPIES_BY_STAR[unit.star];
    player.itemBench.push(...unit.items);
    player.units = player.units.filter((u) => u !== unit);
    this.flushPending(player);
    return { ok: true };
  }

  // Élimination : toutes les unités retournent dans le pool.
  returnAll(player) {
    for (const u of player.units) this.pool[u.champId] += COPIES_BY_STAR[u.star];
    for (const p of player.pendingUnits) this.pool[p.champId] += COPIES_BY_STAR[p.star];
    player.units = [];
    player.pendingUnits = [];
  }

  takeFromPool(champId, n = 1) {
    if (this.pool[champId] < n) return false;
    this.pool[champId] -= n;
    return true;
  }
}

ShopManager.COPIES_BY_STAR = COPIES_BY_STAR;
module.exports = ShopManager;
