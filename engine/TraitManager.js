'use strict';
const Data = require('./Data');
const ItemManager = require('./ItemManager');

// Calcul des synergies actives d'un plateau.
// Un même champion (même id) présent plusieurs fois ne compte qu'une fois par trait.
function computeTraits(boardUnits) {
  const { traits } = Data.get();
  const holders = {}; // traitId -> Set(champId ou uid de monstre)
  for (const u of boardUnits) {
    for (const t of ItemManager.unitTraits(u)) {
      if (!holders[t]) holders[t] = new Set();
      holders[t].add(u.champId);
    }
  }
  const out = [];
  for (const t of traits) {
    const count = holders[t.id] ? holders[t.id].size : 0;
    if (count === 0) continue;
    let activeIndex = -1;
    t.breakpoints.forEach((bp, i) => {
      if (count >= bp.count) activeIndex = i;
    });
    out.push({
      id: t.id,
      name: t.name,
      category: t.category,
      count,
      breakpoints: t.breakpoints.map((b) => b.count),
      activeIndex,
      active: activeIndex >= 0 ? t.breakpoints[activeIndex] : null,
    });
  }
  // Actifs d'abord, puis par nombre d'unités.
  out.sort((a, b) => (b.activeIndex >= 0) - (a.activeIndex >= 0) || b.count - a.count || a.id.localeCompare(b.id));
  return out;
}

// Pour chaque unité du plateau : bonus de stats et effets apportés par les synergies.
function bonusesFor(unit, activeTraits) {
  const unitTraitIds = ItemManager.unitTraits(unit);
  const stats = {};
  const effects = [];
  for (const t of activeTraits) {
    if (!t.active) continue;
    const applies = t.active.scope === 'full_team' || unitTraitIds.includes(t.id);
    if (!applies) continue;
    for (const [k, v] of Object.entries(t.active.bonuses || {})) stats[k] = (stats[k] || 0) + v;
    // Les effets spéciaux ne concernent que les porteurs du trait, sauf ceux pensés pour toute l'équipe.
    if (t.active.effect_id && (unitTraitIds.includes(t.id) || t.active.scope === 'full_team')) {
      effects.push({ id: t.active.effect_id, params: t.active.effect_params || {}, source: t.id });
    }
  }
  return { stats, effects };
}

module.exports = { computeTraits, bonusesFor };
