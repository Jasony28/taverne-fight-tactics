'use strict';
const EventEmitter = require('events');
const Data = require('./Data');
const Rng = require('./Rng');
const P = require('./Player');
const ShopManager = require('./ShopManager');
const ItemManager = require('./ItemManager');
const TraitManager = require('./TraitManager');
const Combat = require('./CombatSimulator');
const BotAI = require('./BotAI');

const BOT_NAMES = ['Bot Gérard', 'Bot Ginette', 'Bot Raymond', 'Bot Josiane', 'Bot Marcel', 'Bot Huguette', 'Bot Lucien', 'Bot Paulette'];
const MAX_PLAYERS = 8;

// Horloge réelle par défaut ; les tests injectent une horloge accélérée.
const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

class GameRoom extends EventEmitter {
  constructor({ code, seed = Date.now(), clock = realClock, timeScale = 1 }) {
    super();
    this.code = code;
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.clock = clock;
    this.timeScale = timeScale;
    this.players = [];
    this.hostId = null;
    this.botDifficulty = 'normal';
    this.status = 'lobby'; // lobby | playing | finished
    this.stage = 1;
    this.round = 1;
    this.phase = 'lobby';
    this.phaseEndsAt = null;
    this.timers = [];
    this.matches = []; // combats de la manche en cours
    this.carousel = null;
    this.combatCounter = 0;
    this.eliminationOrder = [];
    this.lastResults = {};
  }

  // ------------------------------------------------------------------ Salon

  addHuman({ id, name, sessionId }) {
    if (this.status !== 'lobby') return { ok: false, error: 'GAME_ALREADY_STARTED' };
    if (this.players.length >= MAX_PLAYERS) return { ok: false, error: 'ROOM_FULL' };
    const player = P.createPlayer({ id, name: String(name || 'Joueur').slice(0, 20), sessionId });
    player.ready = false;
    this.players.push(player);
    if (!this.hostId) this.hostId = id;
    this.emitLobby();
    return { ok: true, player };
  }

  removeFromLobby(id) {
    if (this.status !== 'lobby') return;
    this.players = this.players.filter((p) => p.id !== id);
    if (this.hostId === id) this.hostId = this.players[0] ? this.players[0].id : null;
    this.emitLobby();
  }

  setReady(id, ready) {
    const p = this.getPlayer(id);
    if (p) p.ready = Boolean(ready);
    this.emitLobby();
  }

  lobbyState() {
    return {
      roomCode: this.code,
      hostId: this.hostId,
      botDifficulty: this.botDifficulty,
      status: this.status,
      players: this.players.map((p) => ({ id: p.id, name: p.name, ready: Boolean(p.ready), isBot: p.isBot, connected: p.connected })),
    };
  }

  emitLobby() {
    this.emit('lobby', this.lobbyState());
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  alivePlayers() {
    return this.players.filter((p) => p.alive);
  }

  // ------------------------------------------------------------- Lancement

  start(requesterId, botDifficulty = 'normal') {
    if (this.status !== 'lobby') return { ok: false, error: 'GAME_ALREADY_STARTED' };
    if (requesterId !== null && requesterId !== this.hostId) return { ok: false, error: 'NOT_HOST' };
    const { balance } = Data.get();
    this.botDifficulty = balance.bots.difficulty[botDifficulty] ? botDifficulty : 'normal';
    let i = 0;
    while (this.players.length < MAX_PLAYERS) {
      this.players.push(
        P.createPlayer({ id: 'bot' + (i + 1), name: BOT_NAMES[i % BOT_NAMES.length], isBot: true, botDifficulty: this.botDifficulty }),
      );
      i += 1;
    }
    this.status = 'playing';
    this.shop = new ShopManager(this.rng);
    for (const p of this.players) this.shop.refresh(p);
    this.emitLobby();
    this.startRound();
    return { ok: true };
  }

  // --------------------------------------------------------------- Minuteurs

  schedule(sec, fn) {
    const h = this.clock.setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== h);
      if (this.status === 'playing') fn();
    }, (sec * 1000) / this.timeScale);
    this.timers.push(h);
    return h;
  }

  clearTimers() {
    for (const h of this.timers) this.clock.clearTimeout(h);
    this.timers = [];
  }

  setPhase(phase, durationSec) {
    this.phase = phase;
    this.phaseEndsAt = this.clock.now() + (durationSec * 1000) / this.timeScale;
    this.emit('phase', this.phaseInfo());
  }

  phaseInfo() {
    return {
      stage: this.stage,
      round: this.round,
      label: this.label(),
      roundType: this.roundType(),
      phase: this.phase,
      endsAtTimestamp: this.phaseEndsAt,
      upcoming: this.upcomingRounds(),
    };
  }

  label(stage = this.stage, round = this.round) {
    return stage + '-' + round;
  }

  roundsInStage(stage) {
    const { stages } = Data.get().balance;
    return (stage === 1 ? stages.stage1_rounds : stages.default_rounds).length;
  }

  roundType(stage = this.stage, round = this.round) {
    const { stages } = Data.get().balance;
    const list = stage === 1 ? stages.stage1_rounds : stages.default_rounds;
    return list[round - 1];
  }

  upcomingRounds() {
    const out = [];
    let s = this.stage;
    let r = this.round;
    for (let i = 0; i < 4; i++) {
      r += 1;
      if (r > this.roundsInStage(s)) {
        s += 1;
        r = 1;
      }
      out.push({ label: this.label(s, r), type: this.roundType(s, r) });
    }
    return out;
  }

  // ---------------------------------------------------------------- Manches

  startRound() {
    if (this.roundType() === 'carousel') this.startCarousel();
    else this.startPlanning();
  }

  startPlanning() {
    const { balance } = Data.get();
    const label = this.label();
    const isFirstPlanning = label === '1-2';

    for (const p of this.alivePlayers()) {
      this.giveIncome(p, isFirstPlanning);
      p.freeRerolls = p.freeRerollsPerRound;
      if (p.xpPerRound) P.addXp(p, p.xpPerRound);
      this.shop.flushPending(p);
    }

    const tier = balance.stages.augment_rounds[label];
    if (tier) for (const p of this.alivePlayers()) this.offerAugments(p, tier);

    this.setPhase('planning', balance.timers_sec.planning);
    for (const p of this.alivePlayers()) {
      if (!p.botControlled) continue;
      for (const t of balance.bot_decision_times_sec) this.schedule(t, () => this.runBot(p, t));
    }
    this.schedule(balance.timers_sec.planning, () => this.lock());
    this.broadcastState();
  }

  giveIncome(p, isFirst) {
    const { income } = Data.get().balance;
    const label = this.label();
    const passive = income.passive_by_round[label] != null ? income.passive_by_round[label] : this.stage >= 2 ? income.passive_default : 0;
    const interest = isFirst ? 0 : Math.min(income.interest_max, Math.floor(p.gold / 10) * income.interest_per_10);
    let streakGold = 0;
    for (const s of income.streak) if (Math.abs(p.streak) >= s.min) streakGold = s.gold;
    let augGold = 0;
    p.goldPerRound = p.goldPerRound.filter((g) => {
      augGold += g.amount;
      if (g.roundsLeft == null) return true;
      g.roundsLeft -= 1;
      return g.roundsLeft > 0;
    });
    p.gold += passive + interest + streakGold + augGold;
    p.lastIncome = { passive, interest, streak: streakGold, augments: augGold };
  }

  runBot(p, moment) {
    if (!p.alive || !p.botControlled || this.phase !== 'planning') return;
    BotAI.decide(this, p, moment);
    this.broadcastState();
  }

  // -------------------------------------------------------------- Augments

  offerAugments(p, tier) {
    const pool = Data.get().augments.filter((a) => a.tier === tier && !p.augments.includes(a.id));
    const options = this.rng.shuffle(pool).slice(0, 3).map((a) => a.id);
    p.augmentChoices = { tier, options, rerolled: [false, false, false] };
  }

  rerollAugment(p, slotIndex) {
    const c = p.augmentChoices;
    if (!c) return { ok: false, error: 'NO_AUGMENT_CHOICE' };
    if (c.rerolled[slotIndex] !== false) return { ok: false, error: 'AUGMENT_ALREADY_REROLLED' };
    const pool = Data.get().augments.filter((a) => a.tier === c.tier && !p.augments.includes(a.id) && !c.options.includes(a.id));
    if (!pool.length) return { ok: false, error: 'AUGMENT_POOL_EMPTY' };
    c.options[slotIndex] = this.rng.pick(pool).id;
    c.rerolled[slotIndex] = true;
    return { ok: true };
  }

  pickAugment(p, augmentId) {
    const c = p.augmentChoices;
    if (!c || !c.options.includes(augmentId)) return { ok: false, error: 'AUGMENT_NOT_OFFERED' };
    p.augmentChoices = null;
    p.augments.push(augmentId);
    this.applyAugment(p, Data.get().augmentById[augmentId]);
    return { ok: true };
  }

  applyAugment(p, a) {
    const prm = a.params;
    switch (a.effect_type) {
      case 'grant_gold':
        if (prm.amount) p.gold += prm.amount;
        if (prm.amount_per_round) p.goldPerRound.push({ amount: prm.amount_per_round, roundsLeft: prm.rounds || null });
        break;
      case 'grant_xp':
        if (a.trigger === 'on_kill') break; // appliqué après chaque combat
        if (prm.amount) P.addXp(p, prm.amount);
        if (prm.amount_per_round) p.xpPerRound += prm.amount_per_round;
        break;
      case 'trait_emblem':
        for (let i = 0; i < (prm.count || 1); i++) p.itemBench.push('embleme_' + prm.trait_id);
        break;
      case 'shop_modifier':
        if (prm.reroll_cost != null) p.rerollCost = prm.reroll_cost;
        if (prm.free_rerolls_per_round) {
          p.freeRerollsPerRound += prm.free_rerolls_per_round;
          p.freeRerolls += prm.free_rerolls_per_round;
        }
        if (prm.cost_odds_bonus) {
          for (const [k, v] of Object.entries(prm.cost_odds_bonus)) p.oddsBonus[k] = (p.oddsBonus[k] || 0) + v;
        }
        break;
      default:
        break; // team_stat : appliqué à la construction de l'équipe
    }
  }

  // --------------------------------------------------------- Actions joueur

  // Point d'entrée unique pour toutes les actions (humains et bots).
  action(playerId, type, payload = {}) {
    const p = this.getPlayer(playerId);
    if (!p || !p.alive) return { ok: false, error: 'PLAYER_NOT_ACTIVE' };
    if (this.status !== 'playing') return { ok: false, error: 'GAME_NOT_RUNNING' };
    const res = this.doAction(p, type, payload || {});
    if (res.ok) this.emit('player_update', p.id);
    return res;
  }

  doAction(p, type, payload) {
    const planning = this.phase === 'planning';
    const canManage = planning || this.phase === 'carousel' || this.phase === 'combat' || this.phase === 'resolution';
    switch (type) {
      case 'buy_unit':
        if (!canManage) return { ok: false, error: 'WRONG_PHASE' };
        return this.shop.buy(p, Number(payload.shopSlotIndex));
      case 'sell_unit': {
        const u = p.units.find((x) => x.uid === payload.unitInstanceId);
        if (!u) return { ok: false, error: 'UNIT_NOT_FOUND' };
        if (u.zone === 'board' && !planning) return { ok: false, error: 'BOARD_LOCKED' };
        return this.shop.sell(p, u.uid);
      }
      case 'reroll':
        if (!canManage) return { ok: false, error: 'WRONG_PHASE' };
        return this.shop.reroll(p);
      case 'buy_xp': {
        const { shop, levels } = Data.get().balance;
        if (p.level >= levels.length) return { ok: false, error: 'MAX_LEVEL' };
        if (p.gold < shop.xp_cost) return { ok: false, error: 'NOT_ENOUGH_GOLD' };
        p.gold -= shop.xp_cost;
        P.addXp(p, shop.xp_amount);
        return { ok: true };
      }
      case 'lock_shop':
        p.shopLocked = !p.shopLocked;
        return { ok: true };
      case 'move_unit':
        return this.moveUnit(p, payload);
      case 'equip_item': {
        const u = p.units.find((x) => x.uid === payload.unitInstanceId);
        if (!u) return { ok: false, error: 'UNIT_NOT_FOUND' };
        if (u.zone === 'board' && !planning) return { ok: false, error: 'BOARD_LOCKED' };
        let idx = Number(payload.itemIndex);
        if (payload.itemInstanceId != null) idx = Number(String(payload.itemInstanceId).replace(/^i/, ''));
        return ItemManager.equip(p, idx, u);
      }
      case 'pick_augment':
        return this.pickAugment(p, payload.augmentId);
      case 'reroll_augment':
        return this.rerollAugment(p, Number(payload.slotIndex));
      case 'pick_carousel':
        return this.pickCarousel(p, Number(payload.carouselSlotIndex));
      default:
        return { ok: false, error: 'UNKNOWN_ACTION' };
    }
  }

  moveUnit(p, { unitInstanceId, targetZone, row, col }) {
    const { balance } = Data.get();
    const u = p.units.find((x) => x.uid === unitInstanceId);
    if (!u) return { ok: false, error: 'UNIT_NOT_FOUND' };
    const planning = this.phase === 'planning';
    if (!planning && (u.zone === 'board' || targetZone === 'board')) return { ok: false, error: 'BOARD_LOCKED' };
    row = Number(row);
    col = Number(col);
    if (targetZone === 'board') {
      if (!(row >= 0 && row < balance.combat.board_rows && col >= 0 && col < balance.combat.cols)) return { ok: false, error: 'INVALID_CELL' };
    } else if (targetZone === 'bench') {
      if (!(col >= 0 && col < balance.player.bench_size)) return { ok: false, error: 'INVALID_CELL' };
    } else return { ok: false, error: 'INVALID_ZONE' };

    const other = P.unitAt(p, targetZone, row, col);
    if (other === u) return { ok: true };
    // Limite d'unités sur le plateau (un échange ne change pas le nombre).
    if (targetZone === 'board' && u.zone !== 'board' && !other && P.boardUnits(p).length >= P.maxUnits(p)) {
      return { ok: false, error: 'BOARD_FULL' };
    }
    const from = { zone: u.zone, row: u.row, col: u.col, slot: u.slot };
    this.place(u, targetZone, row, col);
    if (other) this.place(other, from.zone, from.row, from.zone === 'bench' ? from.slot : from.col);
    return { ok: true };
  }

  place(u, zone, row, col) {
    u.zone = zone;
    if (zone === 'bench') {
      u.slot = col;
      u.row = null;
      u.col = null;
    } else {
      u.row = row;
      u.col = col;
      u.slot = null;
    }
  }

  // Déploiement automatique : complète le plateau avec les unités les plus chères du banc.
  autoDeploy(p) {
    const { championById, balance } = Data.get();
    while (P.boardUnits(p).length < P.maxUnits(p)) {
      const bench = P.benchUnits(p).sort(
        (a, b) => championById[b.champId].cost * b.star - championById[a.champId].cost * a.star,
      );
      if (!bench.length) break;
      const u = bench[0];
      const cell = BotAI.freeCellFor(p, championById[u.champId].stats.range, balance);
      if (!cell) break;
      this.place(u, 'board', cell.row, cell.col);
    }
    // Plateau au-dessus de la limite (ne devrait pas arriver) : on renvoie l'excédent au banc.
    while (P.boardUnits(p).length > P.maxUnits(p)) {
      const slot = P.freeBenchSlot(p);
      if (slot < 0) break;
      this.place(P.boardUnits(p)[0], 'bench', null, slot);
    }
  }

  // ---------------------------------------------------------------- Combat

  lock() {
    const { balance } = Data.get();
    this.setPhase('lock', balance.timers_sec.lock);
    for (const p of this.alivePlayers()) {
      if (p.augmentChoices) {
        const pick = p.botControlled ? BotAI.chooseAugment(this, p) : this.rng.pick(p.augmentChoices.options);
        this.pickAugment(p, pick);
      }
      this.autoDeploy(p);
    }
    this.broadcastState();
    this.schedule(balance.timers_sec.lock, () => this.runCombats());
  }

  makePairings() {
    const alive = this.alivePlayers();
    const avoidRepeats = alive.length >= 4;
    let best = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const order = this.rng.shuffle(alive);
      const pairs = [];
      for (let i = 0; i + 1 < order.length; i += 2) pairs.push([order[i], order[i + 1]]);
      const repeats = pairs.filter(([a, b]) => a.lastOpponentIds[0] === b.id || b.lastOpponentIds[0] === a.id).length;
      if (!best || repeats < best.repeats) best = { pairs, odd: order.length % 2 ? order[order.length - 1] : null, repeats };
      if (!avoidRepeats || repeats === 0) break;
    }
    return best;
  }

  runCombats() {
    const { balance, pve } = Data.get();
    const type = this.roundType();
    this.matches = [];
    const nextSeed = () => (this.seed + ++this.combatCounter * 7919) >>> 0;

    if (type === 'pve' || type === 'pve_boss') {
      const list = type === 'pve' ? pve.rounds[this.label()] : pve.rounds.boss_by_stage[String(this.stage)] || pve.rounds.boss_by_stage.default;
      for (const p of this.alivePlayers()) {
        const replay = Combat.simulate({ seed: nextSeed(), teams: [Combat.buildTeam(p), Combat.buildMonsters(list)] });
        this.matches.push({ matchId: 'c' + this.combatCounter, homeId: p.id, awayId: null, pve: true, boss: type === 'pve_boss', replay });
      }
    } else {
      const { pairs, odd } = this.makePairings();
      for (const [a, b] of pairs) {
        const replay = Combat.simulate({ seed: nextSeed(), teams: [Combat.buildTeam(a), Combat.buildTeam(b)] });
        this.matches.push({ matchId: 'c' + this.combatCounter, homeId: a.id, awayId: b.id, replay });
      }
      if (odd) {
        const others = this.alivePlayers().filter((x) => x !== odd);
        const ghostOf = this.rng.pick(others);
        const replay = Combat.simulate({ seed: nextSeed(), teams: [Combat.buildTeam(odd), Combat.buildTeam(ghostOf)] });
        this.matches.push({ matchId: 'c' + this.combatCounter, homeId: odd.id, awayId: ghostOf.id, ghost: true, replay });
      }
    }

    const longest = Math.max(1, ...this.matches.map((m) => m.replay.durationTicks));
    const durationSec = (longest * balance.combat.tick_ms) / 1000 + 1.5;
    this.setPhase('combat', durationSec);
    this.emit('combats', this.matches);
    this.schedule(durationSec, () => this.resolve());
  }

  matchFor(playerId) {
    return this.matches.find((m) => m.homeId === playerId || (m.awayId === playerId && !m.ghost));
  }

  damageFor(survivorCount) {
    const { player_damage: pd } = Data.get().balance;
    const base = pd.stage_base[String(Math.min(this.stage, 7))] || 0;
    const first = Math.min(3, survivorCount);
    const rest = Math.max(0, survivorCount - 3);
    return base + first * pd.per_unit_first_3 + rest * pd.per_unit_after;
  }

  resolve() {
    const { balance, augmentById } = Data.get();
    const hpAtStart = Object.fromEntries(this.players.map((p) => [p.id, p.hp]));
    const results = {};

    for (const m of this.matches) {
      const r = m.replay.result;
      const sides = [this.getPlayer(m.homeId), m.awayId && !m.ghost ? this.getPlayer(m.awayId) : null];
      sides.forEach((p, side) => {
        if (!p) return;
        const won = r.winner === side;
        const enemySurvivors = r.survivors[1 - side];
        const res = { won, draw: r.winner === null, opponentId: side === 0 ? m.awayId : m.homeId, pve: Boolean(m.pve), damage: 0 };
        if (!won) {
          res.damage = this.damageFor(enemySurvivors);
          p.hp -= res.damage;
        }
        if (!m.pve) {
          if (won) {
            p.gold += balance.income.pvp_win;
            p.streak = Math.max(0, p.streak) + 1;
          } else {
            p.streak = Math.min(0, p.streak) - 1;
          }
          p.lastOpponentIds = [res.opponentId];
        }
        // Statistiques (DPS meter) et augments « on_kill ».
        p.dpsLastCombat = m.replay.stats.filter((s) => s.side === side);
        const kills = p.dpsLastCombat.reduce((s, x) => s + x.kills, 0);
        for (const augId of p.augments) {
          const a = augmentById[augId];
          if (a && a.trigger === 'on_kill' && a.effect_type === 'grant_xp') P.addXp(p, kills * (a.params.amount || 0));
          if (a && a.trigger === 'on_kill' && a.effect_type === 'grant_gold') p.gold += kills * (a.params.amount || 0);
        }
        if (m.pve && side === 0) res.loot = this.giveLoot(p, m);
        results[p.id] = res;
        p.lastCombat = res;
      });
    }

    // Effets de fin de manche (Confrérie du Flemme-Feu).
    for (const p of this.alivePlayers()) {
      const traits = TraitManager.computeTraits(P.boardUnits(p));
      for (const t of traits) {
        if (t.active && t.active.effect_id === 'lazy_gold_gen') {
          p.gold += this.rng.range(t.active.effect_params.min_gold, t.active.effect_params.max_gold);
        }
      }
    }

    this.handleEliminations(hpAtStart);

    for (const p of this.alivePlayers()) {
      P.addXp(p, balance.shop.passive_xp_per_round);
      if (!p.shopLocked) this.shop.refresh(p);
      this.shop.flushPending(p);
    }
    this.lastResults = results;
    this.emit('results', results);

    if (this.alivePlayers().length <= 1) return this.finish();
    this.setPhase('resolution', balance.timers_sec.resolution);
    this.broadcastState();
    this.schedule(balance.timers_sec.resolution, () => this.nextRound());
  }

  giveLoot(p, m) {
    const { pve, champions, items } = Data.get();
    const loot = [];
    const killed = m.replay.result.survivors[1] === 0 ? m.replay.initialUnits.filter((u) => u.side === 1).length
      : m.replay.initialUnits.filter((u) => u.side === 1).length - m.replay.result.survivors[1];
    const roll = (table) => {
      const entry = table[this.rng.weighted(table.map((x) => x.weight))];
      if (entry.type === 'gold') {
        const g = this.rng.range(entry.min, entry.max);
        p.gold += g;
        loot.push({ type: 'gold', amount: g });
      } else if (entry.type === 'component') {
        const id = this.rng.pick(items.components).id;
        p.itemBench.push(id);
        loot.push({ type: 'item', id });
      } else if (entry.type === 'combined') {
        const pool = items.combined.filter((x) => !x.augment_only && x.effect_id !== 'grant_trait');
        const id = this.rng.pick(pool).id;
        p.itemBench.push(id);
        loot.push({ type: 'item', id });
      } else if (entry.type === 'champion') {
        const cands = champions.filter((c) => entry.costs.includes(c.cost) && this.shop.pool[c.id] > 0);
        if (cands.length) {
          const c = this.rng.pick(cands);
          this.shop.takeFromPool(c.id);
          this.shop.giveUnit(p, c.id, 1);
          loot.push({ type: 'champion', id: c.id });
        }
      }
    };
    for (let i = 0; i < killed; i++) roll(pve.loot.per_kill);
    if (m.boss && m.replay.result.winner === 0) roll(pve.loot.boss_bonus);
    return loot;
  }

  handleEliminations(hpAtStart) {
    const dead = this.alivePlayers().filter((p) => p.hp <= 0);
    if (!dead.length) return;
    // Classement : PV les moins négatifs devant, puis PV de début de manche les plus hauts.
    dead.sort((a, b) => b.hp - a.hp || hpAtStart[b.id] - hpAtStart[a.id]);
    const aliveAfter = this.alivePlayers().length - dead.length;
    dead.forEach((p, i) => {
      p.alive = false;
      p.placement = aliveAfter + i + 1;
      p.eliminatedRound = this.label();
      this.shop.returnAll(p);
      this.eliminationOrder.push(p.id);
      this.emit('eliminated', { playerId: p.id, placement: p.placement });
    });
  }

  nextRound() {
    this.round += 1;
    if (this.round > this.roundsInStage(this.stage)) {
      this.stage += 1;
      this.round = 1;
    }
    this.startRound();
  }

  finish() {
    for (const p of this.alivePlayers()) p.placement = 1;
    this.status = 'finished';
    this.phase = 'finished';
    this.clearTimers();
    const ranking = this.players
      .slice()
      .sort((a, b) => a.placement - b.placement)
      .map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, placement: p.placement }));
    this.emit('phase', this.phaseInfo());
    this.emit('finished', { ranking });
    this.broadcastState();
  }

  // -------------------------------------------------------------- Carrousel

  startCarousel() {
    const { balance, champions, items } = Data.get();
    const costs = this.stage === 1 ? [1] : this.stage === 2 ? [1, 2] : this.stage === 3 ? [2, 3] : this.stage === 4 ? [3, 4] : [3, 4, 5];
    const slots = [];
    for (let i = 0; i < 9; i++) {
      const cands = champions.filter((c) => costs.includes(c.cost) && this.shop.pool[c.id] > 0);
      if (!cands.length) break;
      const c = this.rng.pick(cands);
      this.shop.takeFromPool(c.id);
      slots.push({ champId: c.id, item: this.rng.pick(items.components).id, takenBy: null });
    }
    const order = this.rng.shuffle(this.alivePlayers()).sort((a, b) => a.hp - b.hp);
    const waves = [];
    for (let i = 0; i < order.length; i += 2) waves.push(order.slice(i, i + 2).map((p) => p.id));
    this.carousel = { slots, waves, waveIndex: -1, picked: new Set() };
    this.setPhase('carousel', waves.length * balance.timers_sec.carousel_wave);
    this.nextCarouselWave();
  }

  nextCarouselWave() {
    const { balance } = Data.get();
    const c = this.carousel;
    // Choix automatique pour ceux qui n'ont pas choisi pendant la vague précédente.
    if (c.waveIndex >= 0) {
      for (const id of c.waves[c.waveIndex]) {
        if (!c.picked.has(id)) {
          const free = c.slots.map((s, i) => (s.takenBy ? -1 : i)).filter((i) => i >= 0);
          if (free.length) this.pickCarousel(this.getPlayer(id), this.rng.pick(free), true);
        }
      }
    }
    c.waveIndex += 1;
    if (c.waveIndex >= c.waves.length) return this.endCarousel();
    c.waveEndsAt = this.clock.now() + (balance.timers_sec.carousel_wave * 1000) / this.timeScale;
    this.emit('carousel', this.carouselState());
    // Les bots choisissent après un court délai.
    for (const id of c.waves[c.waveIndex]) {
      const p = this.getPlayer(id);
      if (p && p.botControlled) {
        this.schedule(1.5, () => {
          if (this.carousel === c && !c.picked.has(id)) this.pickCarousel(p, BotAI.chooseCarousel(this, p), true);
        });
      }
    }
    const wave = c.waveIndex;
    c.waveTimer = this.schedule(balance.timers_sec.carousel_wave, () => {
      if (this.carousel === c && c.waveIndex === wave) this.nextCarouselWave();
    });
    this.broadcastState();
  }

  carouselState() {
    const c = this.carousel;
    if (!c) return null;
    return {
      slots: c.slots.map((s) => ({ champId: s.champId, item: s.item, takenBy: s.takenBy })),
      currentWave: c.waves[c.waveIndex] || [],
      waves: c.waves,
      waveEndsAt: c.waveEndsAt,
    };
  }

  pickCarousel(p, slotIndex, internal = false) {
    const c = this.carousel;
    if (this.phase !== 'carousel' || !c) return { ok: false, error: 'WRONG_PHASE' };
    if (!p || !(c.waves[c.waveIndex] || []).includes(p.id)) return { ok: false, error: 'NOT_YOUR_TURN' };
    if (c.picked.has(p.id)) return { ok: false, error: 'ALREADY_PICKED' };
    const slot = c.slots[slotIndex];
    if (!slot || slot.takenBy) return { ok: false, error: 'CAROUSEL_SLOT_TAKEN' };
    slot.takenBy = p.id;
    c.picked.add(p.id);
    this.shop.giveUnit(p, slot.champId, 1, false, [slot.item]);
    this.emit('carousel', this.carouselState());
    if (!internal) this.emit('player_update', p.id);
    // Vague terminée plus tôt si tout le monde a choisi.
    if (c.waves[c.waveIndex].every((id) => c.picked.has(id))) {
      if (c.waveTimer) {
        this.clock.clearTimeout(c.waveTimer);
        this.timers = this.timers.filter((x) => x !== c.waveTimer);
      }
      const wave = c.waveIndex;
      this.schedule(0.6, () => {
        if (this.carousel === c && c.waveIndex === wave) this.nextCarouselWave();
      });
    }
    this.broadcastState();
    return { ok: true };
  }

  endCarousel() {
    for (const s of this.carousel.slots) if (!s.takenBy) this.shop.pool[s.champId] += 1;
    this.carousel = null;
    this.nextRound();
  }

  // ---------------------------------------------------- Connexions / reprise

  setConnected(id, connected) {
    const p = this.getPlayer(id);
    if (!p || p.isBot) return;
    p.connected = connected;
    if (connected) {
      p.disconnectedAt = null;
      p.botControlled = false;
    } else {
      p.disconnectedAt = this.clock.now();
      if (this.status === 'playing') {
        const { timers_sec } = Data.get().balance;
        this.clock.setTimeout(() => {
          if (!p.connected && this.status === 'playing') {
            p.botControlled = true;
            this.emit('takeover', { playerId: p.id });
            if (this.phase === 'planning') BotAI.decide(this, p, 22);
          }
        }, (timers_sec.disconnect_takeover * 1000) / this.timeScale);
      } else if (this.status === 'lobby') {
        this.removeFromLobby(id);
      }
    }
    this.broadcastState();
  }

  // ------------------------------------------------------------ État public

  broadcastState() {
    this.emit('state');
  }

  publicPlayers() {
    return this.players
      .map((p) => ({
        id: p.id, name: p.name, isBot: p.isBot, botControlled: p.botControlled, connected: p.connected,
        hp: Math.max(0, p.hp), level: p.level, streak: p.streak, alive: p.alive, placement: p.placement,
        gold: p.gold,
      }))
      .sort((a, b) => (b.alive - a.alive) || b.hp - a.hp || (a.placement || 0) - (b.placement || 0));
  }

  // Vue d'un plateau (scouting) : visible par tous.
  boardView(p) {
    return {
      playerId: p.id,
      name: p.name,
      level: p.level,
      units: p.units.map((u) => ({ uid: u.uid, champId: u.champId, star: u.star, items: u.items, zone: u.zone, row: u.row, col: u.col, slot: u.slot })),
      traits: TraitManager.computeTraits(P.boardUnits(p)),
      augments: p.augments,
      itemBench: p.itemBench,
    };
  }

  // Snapshot complet pour un joueur (game:state_sync).
  stateFor(playerId) {
    const p = this.getPlayer(playerId);
    if (!p) return null;
    const info = P.levelInfo(p.level);
    return {
      roomCode: this.code,
      status: this.status,
      phase: this.phaseInfo(),
      self: {
        id: p.id, name: p.name, hp: Math.max(0, p.hp), gold: p.gold, level: p.level, xp: p.xp, xpToNext: info.xp_to_next,
        maxUnits: info.max_units, streak: p.streak, alive: p.alive, placement: p.placement,
        units: p.units.map((u) => ({ uid: u.uid, champId: u.champId, star: u.star, items: u.items, zone: u.zone, row: u.row, col: u.col, slot: u.slot })),
        itemBench: p.itemBench,
        shop: p.shop,
        shopLocked: p.shopLocked,
        rerollCost: p.freeRerolls > 0 ? 0 : p.rerollCost,
        freeRerolls: p.freeRerolls,
        odds: this.shop ? this.shop.oddsFor(p) : info.odds,
        augments: p.augments,
        augmentChoices: p.augmentChoices,
        pendingUnits: p.pendingUnits.length,
        traits: TraitManager.computeTraits(P.boardUnits(p)),
        lastCombat: p.lastCombat,
        lastIncome: p.lastIncome || null,
        dps: p.dpsLastCombat,
        botControlled: p.botControlled,
      },
      players: this.publicPlayers(),
      carousel: this.carouselState(),
      pool: this.shop ? this.shop.pool : null,
    };
  }

  destroy() {
    this.clearTimers();
    this.status = 'finished';
    this.removeAllListeners();
  }
}

module.exports = GameRoom;
