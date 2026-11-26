'use strict';
const Data = require('./Data');

// Recettes, règles d'équipement et cumul des stats d'objets.

function isComponent(itemId) {
  return Boolean(Data.get().componentById[itemId]);
}

function combine(a, b) {
  return Data.get().recipes[[a, b].sort().join('+')] || null;
}

function grantedTrait(itemId) {
  const it = Data.get().combinedById[itemId];
  return it && it.effect_id === 'grant_trait' ? it.effect_params.trait_id : null;
}

// Traits d'une unité : ceux du champion + ceux apportés par ses emblèmes.
function unitTraits(unit, extraEmblems = []) {
  const { championById } = Data.get();
  const base = unit.monster ? [] : championById[unit.champId].traits;
  const out = [...base];
  for (const itemId of [...unit.items, ...extraEmblems]) {
    const t = grantedTrait(itemId);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// Vérifie (sans rien modifier) le résultat d'un équipement.
// Retourne { ok, items, error, combinedInto }.
function previewEquip(unit, itemId) {
  const { balance, itemById } = Data.get();
  const max = balance.player.max_items_per_unit;
  const item = itemById[itemId];
  if (!item) return { ok: false, error: 'ITEM_UNKNOWN' };

  let items = unit.items.slice();
  let resulting = itemId;
  let combinedInto = null;

  if (isComponent(itemId)) {
    const idx = items.findIndex((x) => isComponent(x));
    if (idx >= 0) {
      resulting = combine(items[idx], itemId);
      combinedInto = resulting;
      items.splice(idx, 1);
    }
  }
  if (items.length >= max) return { ok: false, error: 'ITEM_SLOTS_FULL' };

  const res = itemById[resulting];
  if (res.unique && items.includes(resulting)) return { ok: false, error: 'ITEM_UNIQUE' };
  const trait = grantedTrait(resulting);
  if (trait && unitTraits({ ...unit, items }).includes(trait)) return { ok: false, error: 'EMBLEM_ALREADY_HAS_TRAIT' };

  items = [...items, resulting];
  return { ok: true, items, combinedInto };
}

function equip(player, itemIndex, unit) {
  const itemId = player.itemBench[itemIndex];
  if (itemId == null) return { ok: false, error: 'ITEM_NOT_FOUND' };
  if (unit.monster) return { ok: false, error: 'INVALID_TARGET' };
  const p = previewEquip(unit, itemId);
  if (!p.ok) return p;
  unit.items = p.items;
  player.itemBench.splice(itemIndex, 1);
  return p;
}

// Somme des stats de tous les objets portés.
function itemStats(items) {
  const { itemById } = Data.get();
  const out = {};
  for (const id of items) {
    const st = itemById[id] ? itemById[id].stats : {};
    for (const [k, v] of Object.entries(st)) out[k] = (out[k] || 0) + v;
  }
  return out;
}

function itemEffects(items) {
  const { combinedById } = Data.get();
  const out = [];
  for (const id of items) {
    const it = combinedById[id];
    if (it && it.effect_id && it.effect_id !== 'grant_trait') {
      out.push({ id: it.effect_id, params: it.effect_params || {}, source: id });
    }
  }
  return out;
}

module.exports = { isComponent, combine, grantedTrait, unitTraits, previewEquip, equip, itemStats, itemEffects };
