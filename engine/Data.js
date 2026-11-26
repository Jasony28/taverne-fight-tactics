'use strict';
const fs = require('fs');
const path = require('path');

// Charge le contenu (data/*.json) et l'équilibrage (config/*.json) une seule fois.
function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
}

function load() {
  const traits = readJson('data/traits.json');
  const champions = readJson('data/champions.json');
  const items = readJson('data/items.json');
  const augments = readJson('data/augments.json');
  const balance = readJson('config/balance.json');
  const pve = readJson('config/pve.json');

  const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
  const recipes = {};
  for (const it of items.combined) {
    recipes[[...it.recipe].sort().join('+')] = it.id;
  }
  // Emblèmes d'origine : pas de recette, ils s'obtiennent seulement par augment.
  for (const t of traits) {
    if (t.category !== 'origin') continue;
    const id = 'embleme_' + t.id;
    if (items.combined.some((x) => x.id === id)) continue;
    items.combined.push({
      id,
      name: 'Emblème : ' + t.name,
      icon_path: 'assets/items/' + id + '.png',
      recipe: [],
      unique: true,
      stats: {},
      effect_id: 'grant_trait',
      effect_params: { trait_id: t.id },
      description: "Le porteur obtient l'origine " + t.name + '.',
      augment_only: true,
    });
  }
  return {
    traits,
    champions,
    items,
    augments,
    balance,
    pve,
    traitById: byId(traits),
    championById: byId(champions),
    componentById: byId(items.components),
    combinedById: byId(items.combined),
    itemById: { ...byId(items.components), ...byId(items.combined) },
    augmentById: byId(augments),
    recipes,
  };
}

let cache = null;
module.exports = {
  get() {
    if (!cache) cache = load();
    return cache;
  },
  reload() {
    cache = load();
    return cache;
  },
};
