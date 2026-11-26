'use strict';
const Data = require('./Data');
const Rng = require('./Rng');
const Hex = require('./HexGrid');
const ItemManager = require('./ItemManager');
const TraitManager = require('./TraitManager');

// ---------------------------------------------------------------------------
// Préparation des équipes (stats finales = base × étoiles + objets + synergies + augments)
// ---------------------------------------------------------------------------

function addStats(target, bonus) {
  for (const [k, v] of Object.entries(bonus || {})) target[k] = (target[k] || 0) + v;
}

// Construit la liste des combattants d'un joueur à partir de son plateau.
function buildTeam(player) {
  const { championById, augmentById, balance } = Data.get();
  const board = player.units.filter((u) => u.zone === 'board');
  const traits = TraitManager.computeTraits(board);

  // Bonus d'équipe des augments (team_stat).
  const teamAug = { all: {}, byTrait: {} };
  for (const augId of player.augments) {
    const a = augmentById[augId];
    if (!a || a.effect_type !== 'team_stat') continue;
    if (a.params.scope === 'trait_units') {
      teamAug.byTrait[a.params.trait_id] = teamAug.byTrait[a.params.trait_id] || {};
      addStats(teamAug.byTrait[a.params.trait_id], a.params.bonuses);
    } else addStats(teamAug.all, a.params.bonuses);
  }

  return board.map((u) => {
    const champ = championById[u.champId];
    const mult = balance.star_multiplier[String(u.star)];
    const base = champ.stats;
    const bonus = {};
    addStats(bonus, ItemManager.itemStats(u.items));
    const tb = TraitManager.bonusesFor(u, traits);
    addStats(bonus, tb.stats);
    addStats(bonus, teamAug.all);
    for (const t of ItemManager.unitTraits(u)) addStats(bonus, teamAug.byTrait[t]);

    return {
      uid: u.uid,
      champId: u.champId,
      name: champ.name.split(',')[0],
      star: u.star,
      items: u.items.slice(),
      boardRow: u.row,
      boardCol: u.col,
      traits: ItemManager.unitTraits(u),
      stats: {
        hp: base.hp * mult + (bonus.hp || 0),
        ad: base.ad * mult + (bonus.ad || 0),
        ap: base.ap + (bonus.ap || 0),
        armor: base.armor + (bonus.armor || 0),
        mr: base.mr + (bonus.mr || 0),
        attack_speed: base.attack_speed,
        as_pct: bonus.attack_speed || 0, // bonus en % de la vitesse de base
        range: base.range + (bonus.range || 0),
        mana_start: base.mana_start + (bonus.mana_start || 0),
        mana_max: base.mana_max + (bonus.mana_max || 0),
        crit_chance: base.crit_chance + (bonus.crit_chance || 0),
        crit_mult: base.crit_mult + (bonus.crit_mult || 0),
      },
      spell: champ.spell,
      effects: [...ItemManager.itemEffects(u.items), ...tb.effects],
    };
  });
}

// Monstres PvE (côté adversaire).
function buildMonsters(list) {
  const { pve } = Data.get();
  return list.map((m, i) => {
    const t = pve.monsters[m.id];
    return {
      uid: 'm' + i,
      champId: m.id,
      monster: true,
      name: t.name,
      star: 1,
      items: [],
      boardRow: m.row,
      boardCol: m.col,
      traits: [],
      stats: {
        hp: t.hp, ad: t.ad, ap: 100, armor: t.armor, mr: t.mr, attack_speed: t.attack_speed, as_pct: 0,
        range: t.range, mana_start: 0, mana_max: 0, crit_chance: 0, crit_mult: 1.4,
      },
      spell: null,
      effects: [],
    };
  });
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

const TEAM_EFFECTS = new Set(['royal_feast_heal']); // déclenchés une seule fois par équipe

class Combat {
  constructor({ seed, teams, options = {} }) {
    const { balance } = Data.get();
    this.cfg = balance.combat;
    this.ot = balance.overtime;
    this.timers = balance.timers_sec;
    this.rng = new Rng(seed);
    this.seed = seed;
    this.events = [];
    this.tick = 0;
    this.overtime = false;
    this.units = [];
    this.occupied = new Map();
    this.teamFlags = [{}, {}];
    this.options = options;
    this.summonCount = 0;

    teams.forEach((team, side) => {
      for (const spec of team) this.addUnit(spec, side);
    });
    this.initialUnits = this.units.map((u) => this.snapshot(u));
  }

  ticksPerSec() {
    return 1000 / this.cfg.tick_ms;
  }

  addUnit(spec, side, forcedPos = null) {
    const pos = forcedPos || Hex.boardToArena(spec.boardRow, spec.boardCol, side);
    if (this.occupied.has(Hex.key(pos))) {
      const free = this.nearestFree(pos);
      if (!free) return null;
      pos.row = free.row;
      pos.col = free.col;
    }
    const s = spec.stats;
    const u = {
      uid: spec.uid,
      side,
      champId: spec.champId,
      name: spec.name,
      star: spec.star,
      monster: Boolean(spec.monster),
      summon: Boolean(spec.summon),
      items: spec.items || [],
      traits: spec.traits || [],
      boardRow: spec.boardRow,
      pos: { row: pos.row, col: pos.col },
      maxHp: Math.round(s.hp),
      hp: Math.round(s.hp),
      ad: s.ad,
      ap: s.ap,
      armor: s.armor,
      mr: s.mr,
      baseAS: s.attack_speed,
      asPct: s.as_pct || 0,
      range: Math.max(1, s.range),
      mana: s.mana_start,
      manaMax: s.mana_max,
      critChance: s.crit_chance,
      critMult: s.crit_mult,
      spell: spec.spell,
      effects: spec.effects || [],
      omnivamp: 0,
      ampStatic: 0,
      spellCanCrit: false,
      alive: true,
      target: null,
      attackTimer: 0,
      moveTimer: 0,
      attacks: 0,
      st: {}, // compteurs internes des effets
      stun: 0,
      slow: 0,
      ccImmune: 0,
      untargetable: 0,
      burn: null, // { ticks, perSec, src }
      burnItem: null,
      antiheal: null, // { pct, ticks }
      mrShredDebuff: null, // { pct, ticks }
      auraMrShred: 0,
      auraArmorShred: 0,
      shields: [], // { amount, ticks, tag }
      temp: [], // { stat, amount, ticks }
      ampBuffs: [], // { pct, ticks }
      dealt: 0,
      taken: 0,
      healed: 0,
    };
    this.units.push(u);
    this.occupied.set(Hex.key(u.pos), u.uid);
    return u;
  }

  snapshot(u) {
    return {
      uid: u.uid, side: u.side, champId: u.champId, name: u.name, star: u.star, monster: u.monster, summon: u.summon,
      row: u.pos.row, col: u.pos.col, hp: u.hp, maxHp: u.maxHp, mana: u.mana, manaMax: u.manaMax,
      items: u.items, range: u.range,
    };
  }

  emit(type, data) {
    this.events.push({ t: this.tick, type, ...data });
  }

  // --- Stats effectives -----------------------------------------------------

  tempSum(u, stat) {
    let s = 0;
    for (const b of u.temp) if (b.stat === stat) s += b.amount;
    return s;
  }

  attackSpeed(u) {
    let as = u.baseAS * (1 + u.asPct + this.tempSum(u, 'as_pct'));
    if (u.slow > 0) as *= 1 - this.cfg.slow_pct;
    if (this.overtime) as *= 1 + this.ot.attack_speed_bonus;
    return Math.min(this.cfg.max_attack_speed, Math.max(0.1, as));
  }

  armorOf(u) {
    let a = u.armor + this.tempSum(u, 'armor') + (u.st.attackerArmor || 0);
    return a * (1 - u.auraArmorShred);
  }

  mrOf(u) {
    const shred = Math.max(u.auraMrShred, u.mrShredDebuff ? u.mrShredDebuff.pct : 0);
    return (u.mr + this.tempSum(u, 'mr') + (u.st.attackerMr || 0)) * (1 - shred);
  }

  adOf(u) {
    return u.ad + this.tempSum(u, 'ad');
  }

  apOf(u) {
    return u.ap + this.tempSum(u, 'ap');
  }

  shieldTotal(u) {
    return u.shields.reduce((s, x) => s + x.amount, 0);
  }

  hasEffect(u, id) {
    return u.effects.find((e) => e.id === id);
  }

  // --- Utilitaires de ciblage ----------------------------------------------

  enemiesOf(u) {
    return this.units.filter((x) => x.alive && x.side !== u.side);
  }

  alliesOf(u, includeSelf = true) {
    return this.units.filter((x) => x.alive && x.side === u.side && (includeSelf || x !== u));
  }

  targetable(x) {
    return x && x.alive && x.untargetable <= 0;
  }

  nearestEnemy(u) {
    let best = null;
    let bestD = Infinity;
    for (const e of this.enemiesOf(u)) {
      if (!this.targetable(e)) continue;
      const d = Hex.distance(u.pos, e.pos);
      if (d < bestD || (d === bestD && e.hp < best.hp)) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }

  farthestEnemy(u) {
    let best = null;
    let bestD = -1;
    for (const e of this.enemiesOf(u)) {
      if (!this.targetable(e)) continue;
      const d = Hex.distance(u.pos, e.pos);
      if (d > bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }

  lowestHpAlly(u) {
    let best = null;
    for (const a of this.alliesOf(u)) if (!best || a.hp / a.maxHp < best.hp / best.maxHp) best = a;
    return best;
  }

  byUid(uid) {
    return this.units.find((x) => x.uid === uid);
  }

  nearestFree(pos, maxRadius = 8) {
    const { rows, cols } = this.cfg;
    for (let r = 0; r <= maxRadius; r++) {
      for (const p of Hex.within(pos, r, rows, cols)) {
        if (Hex.distance(p, pos) === r && !this.occupied.has(Hex.key(p))) return p;
      }
    }
    return null;
  }

  moveTo(u, pos, kind = 'walk') {
    this.occupied.delete(Hex.key(u.pos));
    u.pos = { row: pos.row, col: pos.col };
    this.occupied.set(Hex.key(u.pos), u.uid);
    this.emit('MOVE', { uid: u.uid, row: pos.row, col: pos.col, kind });
  }

  // Premier pas d'un plus court chemin (BFS) vers une case à portée de la cible.
  stepToward(u, target) {
    const { rows, cols } = this.cfg;
    const goal = (p) => Hex.distance(p, target.pos) <= u.range;
    const startK = Hex.key(u.pos);
    const prev = new Map([[startK, null]]);
    const queue = [u.pos];
    let found = null;
    while (queue.length) {
      const cur = queue.shift();
      if (cur !== u.pos && goal(cur)) {
        found = cur;
        break;
      }
      for (const n of Hex.neighbors(cur, rows, cols)) {
        const k = Hex.key(n);
        if (prev.has(k) || this.occupied.has(k)) continue;
        prev.set(k, cur);
        queue.push(n);
      }
    }
    if (!found) {
      // Pas de chemin : on se rapproche si possible.
      let best = null;
      let bestD = Hex.distance(u.pos, target.pos);
      for (const n of Hex.neighbors(u.pos, rows, cols)) {
        if (this.occupied.has(Hex.key(n))) continue;
        const d = Hex.distance(n, target.pos);
        if (d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    }
    let step = found;
    while (prev.get(Hex.key(step)) && Hex.key(prev.get(Hex.key(step))) !== startK) step = prev.get(Hex.key(step));
    return step;
  }

  // --- Soins, boucliers, statuts -------------------------------------------

  heal(u, amount, src = null) {
    if (!u.alive || amount <= 0) return 0;
    let a = amount;
    if (u.antiheal) a *= 1 - u.antiheal.pct;
    if (this.overtime) a *= 1 - this.ot.heal_shield_reduction;
    const real = Math.min(u.maxHp - u.hp, a);
    if (real <= 0) return 0;
    u.hp += real;
    if (src) src.healed += real;
    this.emit('HEAL', { uid: u.uid, src: src ? src.uid : null, amount: Math.round(real), hp: Math.round(u.hp) });
    return real;
  }

  shield(u, amount, seconds, src = null, tag = null) {
    if (!u.alive || amount <= 0) return null;
    let a = amount;
    if (this.overtime) a *= 1 - this.ot.heal_shield_reduction;
    const s = { amount: a, ticks: Math.round(seconds * this.ticksPerSec()), tag };
    u.shields.push(s);
    if (src) src.healed += a;
    this.emit('SHIELD', { uid: u.uid, src: src ? src.uid : null, amount: Math.round(a), total: Math.round(this.shieldTotal(u)) });
    return s;
  }

  applyStatus(u, status, src) {
    if (!status || status.type === 'none' || !u.alive) return;
    const ticks = Math.round(status.duration_sec * this.ticksPerSec());
    if (ticks <= 0) return;
    if ((status.type === 'stun' || status.type === 'slow') && u.ccImmune > 0) return;
    if (status.type === 'stun') u.stun = Math.max(u.stun, ticks);
    else if (status.type === 'slow') u.slow = Math.max(u.slow, ticks);
    else if (status.type === 'burn') {
      u.burn = { ticks, perSec: this.cfg.burn_hp_pct_per_sec * u.maxHp, src: src ? src.uid : null };
    }
    this.emit('STATUS', { uid: u.uid, status: status.type, duration: status.duration_sec });
  }

  // --- Dégâts ----------------------------------------------------------------

  dealDamage(src, tgt, raw, type, opts = {}) {
    if (!tgt.alive || raw <= 0) return 0;
    if (tgt.untargetable > 0 && tgt.st.invulnerable) return 0;
    let dmg = raw;
    let crit = false;

    if (src && src.alive !== undefined) {
      let amp = src.ampStatic;
      for (const b of src.ampBuffs) amp += b.pct;
      const vsHigh = this.hasEffect(src, 'damage_amp_vs_high_hp');
      if (vsHigh && tgt.maxHp > vsHigh.params.hp_threshold) amp += vsHigh.params.amp_pct;
      dmg *= 1 + amp;

      const canCrit = opts.attack || (opts.spell && src.spellCanCrit);
      if (canCrit && type !== 'true_bonus' && this.rng.chance(src.critChance)) {
        crit = true;
        let bonus = src.critMult - 1;
        const thorns = this.hasEffect(tgt, 'thorns_crit_reduce');
        if (thorns) bonus *= 1 - thorns.params.crit_damage_reduction;
        dmg *= 1 + bonus;
      }
    }

    const pre = dmg;
    if (type === 'physical') dmg *= 100 / (100 + Math.max(0, this.armorOf(tgt)));
    else if (type === 'magic') dmg *= 100 / (100 + Math.max(0, this.mrOf(tgt)));

    const dr = this.hasEffect(tgt, 'damage_reduction_by_hp');
    if (dr) dmg *= 1 - (tgt.hp / tgt.maxHp > dr.params.hp_threshold_pct ? dr.params.high_hp_dr : dr.params.low_hp_dr);

    const hadShield = this.shieldTotal(tgt) > 0;
    let remaining = dmg;
    for (const s of tgt.shields) {
      if (remaining <= 0) break;
      const absorbed = Math.min(s.amount, remaining);
      s.amount -= absorbed;
      remaining -= absorbed;
    }
    tgt.shields = tgt.shields.filter((s) => {
      if (s.amount > 0.01) return true;
      this.onShieldEnd(tgt, s);
      return false;
    });

    tgt.hp -= remaining;
    tgt.taken += dmg;
    if (src) src.dealt += dmg;

    // Gain de mana de la cible.
    if (tgt.manaMax > 0 && !tgt.summon) {
      let gain = Math.min(this.cfg.mana_from_damage_cap, pre * this.cfg.mana_from_damage_pre + dmg * this.cfg.mana_from_damage_post);
      if (this.overtime) gain *= 1 + this.ot.mana_gen_bonus;
      tgt.mana = Math.min(tgt.manaMax * 1.5, tgt.mana + gain);
    }

    this.emit('DAMAGE', {
      src: src ? src.uid : null, uid: tgt.uid, amount: Math.round(dmg), dtype: type === 'true_bonus' ? 'true' : type,
      crit, spell: Boolean(opts.spell), hp: Math.max(0, Math.round(tgt.hp)), shield: Math.round(this.shieldTotal(tgt)),
    });

    if (src && src.alive) this.afterDealDamage(src, tgt, dmg, opts, hadShield);
    if (tgt.hp <= 0) this.kill(tgt, src);
    else this.afterTakeDamage(tgt, src, dmg, opts);
    return dmg;
  }

  afterDealDamage(src, tgt, dmg, opts, hadShield) {
    if (src.omnivamp > 0) this.heal(src, dmg * src.omnivamp, src);
    for (const e of src.effects) {
      const p = e.params;
      switch (e.id) {
        case 'omnivamp_heal_ally': {
          const amount = dmg * p.heal_pct;
          this.heal(src, amount, src);
          const ally = this.alliesOf(src, false).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
          if (ally) this.heal(ally, amount, src);
          break;
        }
        case 'damage_amp_on_shield_hit':
          if (hadShield) this.addAmpBuff(src, p.amp_pct, p.duration_sec, 'shield_hit');
          break;
        case 'apply_burn_antiheal':
          if ((p.source === 'spell' && opts.spell) || (p.source === 'attack' && opts.attack)) {
            const ticks = Math.round(p.duration_sec * this.ticksPerSec());
            tgt.burnItem = { ticks, perSec: p.burn_hp_pct_per_sec * tgt.maxHp, src: src.uid };
            if (!tgt.antiheal || tgt.antiheal.pct <= p.antiheal_pct) tgt.antiheal = { pct: p.antiheal_pct, ticks };
          }
          break;
        default:
          break;
      }
    }
  }

  afterTakeDamage(u, src, dmg, opts) {
    const ratio = u.hp / u.maxHp;
    for (const e of u.effects) {
      const p = e.params;
      switch (e.id) {
        case 'rage_below_half_hp':
          if (!u.st.rage && ratio < p.hp_threshold_pct) {
            u.st.rage = true;
            u.ad *= 1 + p.ad_pct;
            u.ap += p.ap_pct * 100;
            u.omnivamp += p.omnivamp_pct;
            this.emit('STATUS', { uid: u.uid, status: 'rage', duration: 0 });
          }
          break;
        case 'low_hp_stealth_cleanse':
          if (!u.st.stealthUsed && ratio < p.hp_threshold_pct) {
            u.st.stealthUsed = true;
            u.stun = 0;
            u.slow = 0;
            u.burn = null;
            u.burnItem = null;
            u.untargetable = Math.round(p.invuln_sec * this.ticksPerSec());
            u.st.invulnerable = true;
            u.asPct += p.bonus_as;
            for (const x of this.enemiesOf(u)) if (x.target === u.uid) x.target = null;
            this.emit('STATUS', { uid: u.uid, status: 'stealth', duration: p.invuln_sec });
          }
          break;
        case 'omnivamp_low_hp_shield':
          if (!u.st.marmiteUsed && ratio < p.hp_threshold_pct) {
            u.st.marmiteUsed = true;
            this.shield(u, p.shield_hp_pct * u.maxHp, p.duration_sec, u);
          }
          break;
        case 'low_hp_shield_resists':
          if (!u.st.thermosUsed && ratio < p.hp_threshold_pct) {
            u.st.thermosUsed = true;
            this.shield(u, p.shield_hp_pct * u.maxHp, p.duration_sec, u);
            u.armor += p.bonus_armor;
            u.mr += p.bonus_mr;
          }
          break;
        case 'titan_stacks':
          this.titanStack(u, p);
          break;
        case 'adaptive_position_bonus':
          if (u.st.front && opts.attack) u.mana = Math.min(u.manaMax * 1.5, u.mana + p.front_mana_on_hit);
          break;
        case 'thorns_crit_reduce':
          if (opts.attack && (u.st.thornsCd || 0) <= 0) {
            u.st.thornsCd = Math.round(p.cooldown_sec * this.ticksPerSec());
            const { rows, cols } = this.cfg;
            const zone = Hex.within(u.pos, p.radius_hex, rows, cols).map(Hex.key);
            for (const en of this.enemiesOf(u)) {
              if (zone.includes(Hex.key(en.pos))) this.dealDamage(u, en, p.reflect_magic_damage, 'magic', { item: true });
            }
          }
          break;
        default:
          break;
      }
    }
    void src;
    void dmg;
  }

  titanStack(u, p) {
    u.st.titan = u.st.titan || 0;
    if (u.st.titan >= p.max_stacks) return;
    u.st.titan += 1;
    u.ad += p.ad_per_stack;
    u.ap += p.ap_per_stack;
    if (u.st.titan === p.max_stacks) {
      u.armor += p.max_bonus_armor;
      u.mr += p.max_bonus_mr;
    }
  }

  addAmpBuff(u, pct, seconds, tag) {
    const ticks = Math.round(seconds * this.ticksPerSec());
    const existing = u.ampBuffs.find((b) => b.tag === tag);
    if (existing) existing.ticks = ticks;
    else u.ampBuffs.push({ pct, ticks, tag });
  }

  addTemp(u, stat, amount, seconds, tag = null) {
    const ticks = Math.round(seconds * this.ticksPerSec());
    if (tag) {
      const existing = u.temp.find((b) => b.tag === tag);
      if (existing) {
        existing.ticks = ticks;
        return;
      }
    }
    u.temp.push({ stat, amount, ticks, tag });
  }

  onShieldEnd(u, s) {
    if (s.tag === 'tupperware' && !u.st.tupperDone) {
      u.st.tupperDone = true;
      const e = this.hasEffect(u, 'start_shield_then_ap');
      if (e) u.ap += e.params.bonus_ap;
    }
  }

  kill(u, killer) {
    u.alive = false;
    u.hp = 0;
    this.occupied.delete(Hex.key(u.pos));
    this.emit('DEATH', { uid: u.uid, killer: killer ? killer.uid : null });
    for (const x of this.units) if (x.target === u.uid) x.target = null;
    if (killer && killer.alive) {
      const perf = this.hasEffect(killer, 'mana_reduction_and_refund');
      if (perf) this.addAmpBuff(killer, perf.params.kill_amp_pct, perf.params.kill_amp_sec, 'kill');
      killer.st.kills = (killer.st.kills || 0) + 1;
    }
  }

  // --- Attaques et sorts -----------------------------------------------------

  attack(u, tgt) {
    u.attacks += 1;
    const ranged = u.range > 1;
    if (ranged) this.emit('PROJECTILE', { uid: u.uid, target: tgt.uid });
    this.emit('ATTACK', { uid: u.uid, target: tgt.uid });

    let mana = this.cfg.mana_per_attack;
    const moa = this.hasEffect(u, 'mana_on_attack');
    if (moa) mana += moa.params.bonus_mana;
    if (this.overtime) mana *= 1 + this.ot.mana_gen_bonus;
    if (u.manaMax > 0 && !u.summon) u.mana = Math.min(u.manaMax * 1.5, u.mana + mana);

    this.dealDamage(u, tgt, this.adOf(u), 'physical', { attack: true });

    for (const e of u.effects) {
      const p = e.params;
      switch (e.id) {
        case 'midnight_ambush_true_dmg':
          if (u.attacks <= p.attack_count && tgt.alive) this.dealDamage(u, tgt, p.true_damage, 'true', { trait: true });
          break;
        case 'on_attack_ramp_as':
          u.st.ramp = u.st.ramp || 0;
          if (u.st.ramp < p.max_stacks) {
            u.st.ramp += 1;
            u.asPct += p.as_per_stack;
          }
          break;
        case 'titan_stacks':
          this.titanStack(u, p);
          break;
        case 'chain_lightning_shred':
          if (u.attacks % p.every_n_attacks === 0) {
            const center = tgt.alive ? tgt.pos : u.pos;
            const near = this.enemiesOf(u)
              .filter((x) => this.targetable(x))
              .sort((a, b) => Hex.distance(a.pos, center) - Hex.distance(b.pos, center))
              .slice(0, p.targets);
            for (const x of near) {
              this.dealDamage(u, x, p.magic_damage, 'magic', { item: true });
              if (x.alive) x.mrShredDebuff = { pct: p.mr_shred_pct, ticks: Math.round(p.shred_duration_sec * this.ticksPerSec()) };
            }
          }
          break;
        default:
          break;
      }
    }
  }

  spellAmount(u) {
    const s = u.spell;
    const v = s.values_by_star[Math.min(u.star, s.values_by_star.length) - 1];
    return v * (1 + ((this.apOf(u) - 100) / 100) * s.ap_ratio) + this.adOf(u) * s.ad_ratio;
  }

  enemiesAround(center, radius, side) {
    const { rows, cols } = this.cfg;
    const zone = new Set(Hex.within(center, radius, rows, cols).map(Hex.key));
    return this.units.filter((x) => x.alive && x.side !== side && zone.has(Hex.key(x.pos)) && this.targetable(x));
  }

  cast(u) {
    const s = u.spell;
    const amount = this.spellAmount(u);
    const current = this.targetable(this.byUid(u.target)) ? this.byUid(u.target) : this.nearestEnemy(u);
    const status = s.status_effect;
    let mainTarget = null;

    switch (s.type) {
      case 'single_damage':
      case 'stun':
      case 'aoe_damage': {
        mainTarget = s.target === 'farthest_enemy' ? this.farthestEnemy(u) : current;
        if (!mainTarget) break;
        this.emit('SPELL_CAST', { uid: u.uid, spell: s.name, target: mainTarget.uid, row: mainTarget.pos.row, col: mainTarget.pos.col, radius: s.target === 'area_around_target' ? s.radius_hex : 0 });
        const hit = s.target === 'area_around_target' ? this.enemiesAround(mainTarget.pos, s.radius_hex, u.side) : [mainTarget];
        for (const x of hit) {
          this.dealDamage(u, x, amount, s.damage_type, { spell: true });
          if (x.alive) this.applyStatus(x, status, u);
        }
        break;
      }
      case 'dash': {
        mainTarget = s.target === 'farthest_enemy' ? this.farthestEnemy(u) : current;
        if (!mainTarget) break;
        const { rows, cols } = this.cfg;
        const spots = Hex.neighbors(mainTarget.pos, rows, cols)
          .filter((p) => !this.occupied.has(Hex.key(p)))
          .sort((a, b) => Hex.distance(a, u.pos) - Hex.distance(b, u.pos));
        if (spots.length) this.moveTo(u, spots[0], 'dash');
        u.target = mainTarget.uid;
        this.emit('SPELL_CAST', { uid: u.uid, spell: s.name, target: mainTarget.uid, row: mainTarget.pos.row, col: mainTarget.pos.col, radius: 0 });
        this.dealDamage(u, mainTarget, amount, s.damage_type, { spell: true });
        if (mainTarget.alive) this.applyStatus(mainTarget, status, u);
        break;
      }
      case 'shield':
      case 'heal': {
        mainTarget = s.target === 'lowest_hp_ally' ? this.lowestHpAlly(u) : u;
        this.emit('SPELL_CAST', { uid: u.uid, spell: s.name, target: mainTarget.uid, row: mainTarget.pos.row, col: mainTarget.pos.col, radius: 0 });
        if (s.type === 'shield') this.shield(mainTarget, amount, this.cfg.buff_spell_duration_sec, u);
        else this.heal(mainTarget, amount, u);
        break;
      }
      case 'buff': {
        mainTarget = u;
        const dur = this.cfg.buff_spell_duration_sec;
        this.emit('SPELL_CAST', { uid: u.uid, spell: s.name, target: u.uid, row: u.pos.row, col: u.pos.col, radius: 0 });
        this.addTemp(u, 'armor', amount, dur);
        this.addTemp(u, 'mr', amount, dur);
        // Shadownou : la vitesse d'attaque suit aussi la valeur du sort (value / 100).
        if (u.champId === 'shadownou') this.addTemp(u, 'as_pct', amount / 100, dur);
        this.emit('STATUS', { uid: u.uid, status: 'buff', duration: dur });
        break;
      }
      case 'summon': {
        mainTarget = current;
        this.emit('SPELL_CAST', { uid: u.uid, spell: s.name, target: current ? current.uid : null, row: u.pos.row, col: u.pos.col, radius: 0 });
        this.summonLion(u, amount);
        if (current) this.applyStatus(current, status, u);
        break;
      }
      default:
        break;
    }

    // Réactions aux sorts : brouilleur (aura ennemie), objets du lanceur.
    for (const en of this.enemiesOf(u)) {
      const zap = this.hasEffect(en, 'aura_shred_mr_zap');
      if (zap && u.alive && Hex.distance(en.pos, u.pos) <= zap.params.radius_hex) {
        this.dealDamage(en, u, u.manaMax * zap.params.zap_per_mana_max, 'magic', { item: true });
      }
    }
    u.mana = 0;
    for (const e of u.effects) {
      if (e.id === 'on_cast_as_buff') this.addTemp(u, 'as_pct', e.params.bonus_as, e.params.duration_sec, 'sieste');
      if (e.id === 'mana_reduction_and_refund') u.mana = e.params.mana_after_cast;
    }
    void mainTarget;
  }

  summonLion(owner, hpAmount) {
    const s = owner.spell;
    const existing = this.units.find((x) => x.summon && x.alive && x.st.owner === owner.uid);
    if (existing) {
      this.heal(existing, existing.maxHp, owner);
      return;
    }
    if (owner.st.summoned) return; // un seul Lion par combat
    const pos = this.nearestFree(owner.pos, 3);
    if (!pos) return;
    owner.st.summoned = true;
    const { combat } = Data.get().balance;
    this.summonCount += 1;
    const lion = this.addUnit(
      {
        uid: owner.uid + '_lion' + this.summonCount,
        champId: 'lion_peluche',
        name: 'Lion en Peluche',
        star: owner.star,
        summon: true,
        items: [],
        traits: [],
        stats: {
          hp: s.values_by_star[owner.star - 1] * (1 + ((this.apOf(owner) - 100) / 100) * s.ap_ratio),
          ad: this.adOf(owner) * s.ad_ratio,
          ap: 100,
          armor: combat.summon.armor,
          mr: combat.summon.mr,
          attack_speed: combat.summon.attack_speed,
          as_pct: 0,
          range: combat.summon.range,
          mana_start: 0,
          mana_max: 0,
          crit_chance: 0,
          crit_mult: 1.4,
        },
        spell: null,
        effects: [],
      },
      owner.side,
      pos,
    );
    if (lion) {
      lion.st.owner = owner.uid;
      this.emit('SUMMON', { ...this.snapshot(lion), owner: owner.uid });
    }
    void hpAmount;
  }

  // --- Début de combat et effets périodiques ---------------------------------

  combatStart() {
    const { rows } = this.cfg;
    for (const u of this.units) {
      for (const e of u.effects) {
        const p = e.params;
        switch (e.id) {
          case 'tavern_toast_shield':
            this.shield(u, p.shield_amount, p.duration_sec, u);
            u.st.toast = { regen: p.regen_per_sec, ticks: Math.round(p.duration_sec * this.ticksPerSec()) };
            break;
          case 'damage_amp_flat':
            u.ampStatic += p.amp_pct;
            break;
          case 'omnivamp_low_hp_shield':
            u.omnivamp += p.omnivamp_pct;
            break;
          case 'spell_can_crit':
            u.spellCanCrit = true;
            u.critMult += p.bonus_crit_mult;
            break;
          case 'start_shield_then_ap':
            this.shield(u, p.shield_hp_pct * u.maxHp, p.duration_sec, u, 'tupperware');
            break;
          case 'cc_immune_and_ramp_as':
            u.ccImmune = Math.round(p.immune_sec * this.ticksPerSec());
            break;
          case 'aura_shred_armor':
            this.addTemp(u, 'armor', p.start_bonus_resists, p.start_duration_sec);
            this.addTemp(u, 'mr', p.start_bonus_resists, p.start_duration_sec);
            break;
          case 'adaptive_position_bonus':
            u.st.front = u.boardRow != null && u.boardRow <= 1;
            if (u.st.front) {
              u.armor += p.front_armor;
              u.mr += p.front_mr;
            } else u.ap += p.back_ap;
            break;
          case 'bonus_max_hp_pct': {
            const extra = Math.round(u.maxHp * p.hp_pct);
            u.maxHp += extra;
            u.hp += extra;
            break;
          }
          case 'mana_reduction_and_refund':
            u.manaMax = Math.max(20, u.manaMax - p.mana_max_reduction);
            break;
          case 'random_double_stats_or_vamp': {
            const doubleStats = this.rng.chance(0.5);
            u.ad += p.ad * (doubleStats ? 2 : 1);
            u.ap += p.ap * (doubleStats ? 2 : 1);
            u.omnivamp += p.omnivamp_pct * (doubleStats ? 1 : 2);
            break;
          }
          case 'random_two_combat_buffs': {
            const picks = this.rng.shuffle(p.pool).slice(0, p.pick_count);
            for (const b of picks) {
              for (const [k, v] of Object.entries(b)) {
                if (k === 'attack_speed') u.asPct += v;
                else if (k === 'hp') {
                  u.maxHp += v;
                  u.hp += v;
                } else u[k] = (u[k] || 0) + v;
              }
            }
            break;
          }
          default:
            break;
        }
      }
    }
    // Bénédiction du Créateur : alliés adjacents.
    for (const u of this.units) {
      const e = this.hasEffect(u, 'creator_blessing_adjacent');
      if (!e) continue;
      for (const a of this.alliesOf(u, false)) {
        if (Hex.distance(a.pos, u.pos) <= e.params.radius_hex) {
          a.ad *= 1 + e.params.ad_pct;
          a.ap += e.params.ap_pct * 100;
          a.asPct += e.params.attack_speed_pct;
          this.emit('STATUS', { uid: a.uid, status: 'blessed', duration: 0 });
        }
      }
    }
    // Saut des Ombres Sournoises vers la ligne arrière adverse.
    for (const u of this.units) {
      if (!this.hasEffect(u, 'assassin_backline_leap')) continue;
      const backRow = u.side === 0 ? 0 : rows - 1;
      const order = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6];
      let dest = null;
      for (const rowShift of [0, 1, 2]) {
        const row = u.side === 0 ? backRow + rowShift : backRow - rowShift;
        for (const d of order) {
          const p = { row, col: u.pos.col + d };
          if (p.col < 0 || p.col >= this.cfg.cols) continue;
          if (!this.occupied.has(Hex.key(p))) {
            dest = p;
            break;
          }
        }
        if (dest) break;
      }
      if (dest) this.moveTo(u, dest, 'leap');
    }
  }

  everyTick() {
    const tps = this.ticksPerSec();
    const onSecond = this.tick > 0 && this.tick % tps === 0;

    for (const u of this.units) {
      if (!u.alive) continue;
      if (u.stun > 0) u.stun -= 1;
      if (u.slow > 0) u.slow -= 1;
      if (u.ccImmune > 0) u.ccImmune -= 1;
      if (u.untargetable > 0) {
        u.untargetable -= 1;
        if (u.untargetable === 0) u.st.invulnerable = false;
      }
      if (u.st.thornsCd > 0) u.st.thornsCd -= 1;
      if (u.antiheal && --u.antiheal.ticks <= 0) u.antiheal = null;
      if (u.mrShredDebuff && --u.mrShredDebuff.ticks <= 0) u.mrShredDebuff = null;
      u.temp = u.temp.filter((b) => --b.ticks > 0);
      u.ampBuffs = u.ampBuffs.filter((b) => --b.ticks > 0);
      u.shields = u.shields.filter((s) => {
        if (--s.ticks > 0) return true;
        this.onShieldEnd(u, s);
        return false;
      });

      if (onSecond) {
        for (const key of ['burn', 'burnItem']) {
          const b = u[key];
          if (!b) continue;
          this.dealDamage(this.byUid(b.src) || null, u, b.perSec, 'magic', { dot: true });
          if (u[key]) {
            u[key].ticks -= tps;
            if (u[key].ticks <= 0) u[key] = null;
          }
          if (!u.alive) break;
        }
        if (!u.alive) continue;
        if (u.st.toast && u.st.toast.ticks > 0) this.heal(u, u.st.toast.regen, u);
      }
      if (u.st.toast) u.st.toast.ticks -= 1;
    }

    // Auras (réduction d'armure / RM) : la plus forte s'applique.
    for (const u of this.units) {
      u.auraMrShred = 0;
      u.auraArmorShred = 0;
    }
    for (const src of this.units) {
      if (!src.alive) continue;
      for (const e of src.effects) {
        if (e.id !== 'aura_shred_mr_zap' && e.id !== 'aura_shred_armor') continue;
        for (const en of this.enemiesOf(src)) {
          if (Hex.distance(en.pos, src.pos) > e.params.radius_hex) continue;
          if (e.id === 'aura_shred_mr_zap') en.auraMrShred = Math.max(en.auraMrShred, e.params.mr_shred_pct);
          else en.auraArmorShred = Math.max(en.auraArmorShred, e.params.armor_shred_pct);
        }
      }
    }

    // Effets périodiques.
    for (const u of this.units) {
      if (!u.alive) continue;
      for (const e of u.effects) {
        const p = e.params;
        switch (e.id) {
          case 'turbo_ramp_as':
            if (onSecond) {
              u.st.turbo = u.st.turbo || 0;
              if (u.st.turbo < p.max_stacks) {
                u.st.turbo += 1;
                u.asPct += p.as_per_sec;
              }
            }
            break;
          case 'cc_immune_and_ramp_as':
            if (this.tick > 0 && this.tick % Math.round(p.interval_sec * tps) === 0) u.asPct += p.as_per_interval;
            break;
          case 'periodic_hp_regen':
            if (this.tick > 0 && this.tick % Math.round(p.interval_sec * tps) === 0) this.heal(u, p.heal_hp_pct * u.maxHp, u);
            break;
          case 'adaptive_position_bonus':
            if (!u.st.front && this.tick > 0 && this.tick % (3 * tps) === 0) u.mana = Math.min(u.manaMax * 1.5, u.mana + p.back_mana_per_3s);
            break;
          case 'resists_per_attacker': {
            const n = this.enemiesOf(u).filter((x) => x.target === u.uid).length;
            u.st.attackerArmor = n * p.armor_per_enemy;
            u.st.attackerMr = n * p.mr_per_enemy;
            break;
          }
          case 'royal_feast_heal':
            if (!this.teamFlags[u.side].feast && this.tick === Math.round(p.delay_sec * tps)) {
              this.teamFlags[u.side].feast = true;
              for (const a of this.alliesOf(u)) this.heal(a, p.heal_amount, u);
              this.emit('STATUS', { uid: u.uid, status: 'feast', duration: 0 });
            }
            break;
          default:
            break;
        }
      }
    }
  }

  act(u) {
    if (!u.alive || u.stun > 0) return;
    if (u.moveTimer > 0) {
      u.moveTimer -= 1;
      return;
    }
    if (u.spell && u.manaMax > 0 && u.mana >= u.manaMax) {
      this.cast(u);
      return;
    }
    let tgt = this.byUid(u.target);
    if (!this.targetable(tgt)) {
      tgt = this.nearestEnemy(u);
      u.target = tgt ? tgt.uid : null;
      if (tgt) u.attackTimer = Math.max(u.attackTimer, 1);
    }
    if (!tgt) return;
    if (Hex.distance(u.pos, tgt.pos) <= u.range) {
      u.attackTimer -= 1;
      if (u.attackTimer <= 0) {
        this.attack(u, tgt);
        u.attackTimer = Math.max(1, Math.round(this.ticksPerSec() / this.attackSpeed(u)));
      }
    } else {
      // Changer pour une cible plus proche si elle existe.
      const closer = this.nearestEnemy(u);
      if (closer && closer !== tgt && Hex.distance(u.pos, closer.pos) <= u.range) {
        u.target = closer.uid;
        return;
      }
      const step = this.stepToward(u, tgt);
      if (step) {
        this.moveTo(u, step);
        u.moveTimer = this.cfg.move_ticks_per_hex - 1;
      }
    }
  }

  sideAlive(side) {
    return this.units.some((u) => u.alive && u.side === side);
  }

  run() {
    const tps = this.ticksPerSec();
    const overtimeTick = this.timers.combat * tps;
    const maxTicks = (this.timers.combat + this.timers.overtime) * tps;

    this.combatStart();
    while (this.tick < maxTicks && this.sideAlive(0) && this.sideAlive(1)) {
      this.tick += 1;
      if (!this.overtime && this.tick >= overtimeTick) {
        this.overtime = true;
        this.emit('OVERTIME', {});
      }
      this.everyTick();
      // Ordre d'action alterné entre les deux camps pour rester équitable.
      const order = this.units.slice().sort((a, b) => a.uid.localeCompare(b.uid));
      const a = order.filter((u) => u.side === 0);
      const b = order.filter((u) => u.side === 1);
      const first = this.tick % 2 === 0 ? a : b;
      const second = first === a ? b : a;
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (first[i]) this.act(first[i]);
        if (second[i]) this.act(second[i]);
      }
    }

    const alive0 = this.sideAlive(0);
    const alive1 = this.sideAlive(1);
    let winner = null;
    if (alive0 && !alive1) winner = 0;
    else if (alive1 && !alive0) winner = 1;
    this.emit('END', { winner });

    const survivors = (side) => this.units.filter((u) => u.alive && u.side === side && !u.summon);
    return {
      seed: this.seed,
      durationTicks: this.tick,
      initialUnits: this.initialUnits,
      eventLog: this.events,
      result: {
        winner,
        survivors: [survivors(0).length, survivors(1).length],
        survivorUids: [survivors(0).map((u) => u.uid), survivors(1).map((u) => u.uid)],
      },
      stats: this.units.map((u) => ({
        uid: u.uid, side: u.side, champId: u.champId, name: u.name, star: u.star, summon: u.summon,
        dealt: Math.round(u.dealt), taken: Math.round(u.taken), healed: Math.round(u.healed),
        kills: u.st.kills || 0, alive: u.alive,
      })),
    };
  }
}

function simulate({ seed, teams, options }) {
  return new Combat({ seed, teams, options }).run();
}

module.exports = { simulate, buildTeam, buildMonsters, Combat };
