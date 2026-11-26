'use strict';
// Règles ciblées du cahier des charges (§9.2 cas limites, fusions, objets).
const assert = require('assert');
const Rng = require('../engine/Rng');
const P = require('../engine/Player');
const ShopManager = require('../engine/ShopManager');
const ItemManager = require('../engine/ItemManager');
const Hex = require('../engine/HexGrid');

const shop = new ShopManager(new Rng(5));
const fresh = () => {
  const p = P.createPlayer({ id: 'p', name: 'p' });
  p.gold = 100;
  return p;
};

// Banc plein + achat qui complète un trio : autorisé et fusion immédiate.
{
  const p = fresh();
  for (let i = 0; i < 9; i++) shop.giveUnit(p, i < 2 ? 'kebabier' : ['frigovide', 'ronflexor', 'pique_chope', 'valet_de_trefle', 'vusansreponse', 'dracaufeu_carton', 'angelika'][i - 2]);
  assert.strictEqual(P.freeBenchSlot(p), -1);
  p.shop = ['kebabier', null, null, null, null];
  const r = shop.buy(p, 0);
  assert.ok(r.ok, 'achat autorisé banc plein');
  assert.ok(p.units.some((u) => u.champId === 'kebabier' && u.star === 2), 'fusion 2★');
  p.shop = ['celina', null, null, null, null];
  assert.ok(P.freeBenchSlot(p) >= 0);
}

// 3★ : 9 copies, objets conservés (max 3), surplus renvoyé au banc d'objets.
{
  const p = fresh();
  for (let i = 0; i < 9; i++) shop.giveUnit(p, 'tomix', 1, false, i < 4 ? ['poele_fonte'] : []);
  const t = p.units.filter((u) => u.champId === 'tomix');
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].star, 3);
  assert.strictEqual(t[0].items.length + p.itemBench.length, 4);
  assert.ok(t[0].items.length <= 3);
}

// Banc plein sans fusion possible : le champion part en attente, jamais perdu.
{
  const p = fresh();
  ['frigovide', 'ronflexor', 'pique_chope', 'valet_de_trefle', 'vusansreponse', 'dracaufeu_carton', 'angelika', 'celina', 'emmalia'].forEach((c) => shop.giveUnit(p, c));
  shop.giveUnit(p, 'tomix');
  assert.strictEqual(p.pendingUnits.length, 1);
  shop.sell(p, p.units[0].uid);
  assert.strictEqual(p.pendingUnits.length, 0);
  assert.ok(p.units.some((u) => u.champId === 'tomix'));
}

// Revente : 1★ = prix plein, 2★ coût ≥ 2 = prix total − 1, objets rendus.
{
  const p = fresh();
  const u = shop.giveUnit(p, 'tomix');
  u.items = ['poele_fonte'];
  const g = p.gold;
  shop.sell(p, u.uid);
  assert.strictEqual(p.gold, g + 3);
  assert.deepStrictEqual(p.itemBench, ['poele_fonte']);
  assert.strictEqual(shop.sellValue({ champId: 'tomix', star: 2 }), 8);
  assert.strictEqual(shop.sellValue({ champId: 'kebabier', star: 2 }), 3);
}

// Objets : combinaison automatique, unique, emblème refusé si trait déjà présent.
{
  const p = fresh();
  const u = shop.giveUnit(p, 'nicolax');
  p.itemBench = ['poele_fonte', 'couvercle_tupperware', 'poele_fonte', 'couvercle_tupperware'];
  assert.ok(ItemManager.equip(p, 0, u).ok);
  const r = ItemManager.equip(p, 0, u);
  assert.ok(r.ok && r.combinedInto === 'bouclier_cuisine');
  const r2 = ItemManager.equip(p, 0, u); // poêle seule
  assert.ok(r2.ok);
  const r3 = ItemManager.equip(p, 0, u); // couvercle → bouclier_cuisine (unique) déjà porté
  assert.strictEqual(r3.error, 'ITEM_UNIQUE');
  const v = shop.giveUnit(p, 'tomix');
  p.itemBench = ['embleme_murailles_granit'];
  assert.strictEqual(ItemManager.equip(p, 0, v).error, 'EMBLEM_ALREADY_HAS_TRAIT');
  p.itemBench = ['embleme_ordre_chope'];
  assert.ok(ItemManager.equip(p, 0, v).ok);
  assert.ok(ItemManager.unitTraits(v).includes('ordre_chope'));
}

// Géométrie hexagonale.
{
  assert.strictEqual(Hex.distance({ row: 0, col: 0 }, { row: 0, col: 3 }), 3);
  assert.strictEqual(Hex.neighbors({ row: 1, col: 1 }, 8, 7).length, 6);
  assert.deepStrictEqual(Hex.boardToArena(0, 0, 1), { row: 3, col: 6 });
  assert.deepStrictEqual(Hex.boardToArena(0, 0, 0), { row: 4, col: 0 });
}

console.log('OK règles');
