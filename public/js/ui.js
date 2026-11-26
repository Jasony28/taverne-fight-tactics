// Interface : écrans, HUD, boutique, glisser-déposer, raccourcis, scouting, DPS meter.
import { Network } from './network.js';
import { Renderer, initials, itemLetters, itemColor } from './renderer.js';

const $ = (sel) => document.querySelector(sel);
const PHASE_NAMES = { lobby: 'Salon', planning: 'Préparation', lock: 'Verrouillage', combat: 'Combat', resolution: 'Résolution', carousel: 'Carrousel', finished: 'Terminé' };
const ROUND_TYPES = { pvp: 'PvP', pve: 'PvE', pve_boss: 'Boss', carousel: 'Carrousel' };
const TIER_NAMES = { silver: 'Argent', gold: 'Or', prismatic: 'Prismatique' };
const ROLE_NAMES = { tank: 'Tank', fighter: 'Combattant', marksman: 'Tireur', mage: 'Mage', assassin: 'Assassin', support: 'Soutien' };

const app = {
  content: null,
  net: null,
  renderer: null,
  playerId: null,
  lobby: null,
  state: null,
  phase: null,
  phaseDeadline: 0, // performance.now() à laquelle la phase se termine
  phaseTotal: 1,
  myReplay: null,
  scout: null, // { playerId, board, replay }
  drag: null,
  hoverCell: null,
  selectedUid: null,
  augmentHidden: false,
  lastResolutionShown: null,
};

// ---------------------------------------------------------------- Démarrage

async function boot() {
  const res = await fetch('/api/content');
  const c = await res.json();
  const byId = (l) => Object.fromEntries(l.map((x) => [x.id, x]));
  app.content = {
    ...c,
    championById: byId(c.champions),
    traitById: byId(c.traits),
    augmentById: byId(c.augments),
    componentById: byId(c.items.components),
    itemById: { ...byId(c.items.components), ...byId(c.items.combined) },
  };
  app.renderer = new Renderer($('#board'), app.content);
  app.net = new Network();
  $('#input-name').value = app.net.savedName;
  bindNetwork();
  bindHome();
  bindGame();
  window.addEventListener('resize', () => app.renderer.resize());
  new ResizeObserver(() => app.renderer.resize()).observe($('#board-wrap'));
  requestAnimationFrame(loop);
  setInterval(updateTimer, 200);
  // Accès de débogage (console du navigateur, tests automatisés).
  window.__state = () => app.state;
  window.__renderer = app.renderer;
}

function show(screen) {
  for (const el of document.querySelectorAll('.screen')) el.classList.toggle('active', el.id === 'screen-' + screen);
  if (screen === 'game') requestAnimationFrame(() => app.renderer.resize());
}

async function goFullscreenLandscape() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
  } catch {
    /* refusé par le navigateur */
  }
  try {
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
  } catch {
    /* verrouillage non supporté (iOS, ordinateur) : l'écran « tourne ton téléphone » prend le relais */
  }
}

// ---------------------------------------------------------------- Réseau

function bindNetwork() {
  const net = app.net;
  net.on('room:joined', (d) => {
    app.playerId = d.playerId;
    app.lobby = d.lobby;
    if (d.lobby.status === 'lobby') {
      show('lobby');
      renderLobby();
    } else show('game');
  });
  net.on('session:none', () => show('home'));
  net.on('room:left', () => {
    app.state = null;
    show('home');
  });
  net.on('room:lobby', (l) => {
    app.lobby = l;
    if (l.status === 'lobby') renderLobby();
    else show('game');
  });
  net.on('game:phase_change', (info) => onPhase(info));
  net.on('game:state_sync', (s) => {
    app.state = s;
    if (s.status !== 'lobby' && !$('#screen-game').classList.contains('active')) show('game');
    if (s.phase) onPhase(s.phase, true);
    renderHud();
  });
  net.on('game:combat_replay', (r) => {
    app.myReplay = r;
    if (!app.scout || !app.scout.replay) app.renderer.startReplay(r);
    $('#unit-card').classList.add('hidden');
  });
  net.on('game:scout', (s) => {
    app.scout = { playerId: s.board.playerId, board: s.board, replay: s.replay };
    if (s.replay) app.renderer.startReplay(s.replay);
    else if (app.phase && app.phase.phase !== 'combat') app.renderer.stopReplay();
    renderHud();
  });
  net.on('game:carousel', () => renderHud());
  net.on('game:over', (o) => showGameOver(o));
  net.on('game:eliminated', (e) => {
    if (e.playerId === app.playerId) toast(`Éliminé — ${e.placement}ᵉ place`, 'loss', 2500);
  });
  net.on('game:takeover', (e) => {
    if (e.playerId === app.playerId) toast('Un bot a joué pour toi pendant ton absence', '', 2500);
  });
  net.on('error:action_rejected', (e) => {
    if (!$('#screen-game').classList.contains('active')) $('#home-error').textContent = e.message;
    else toast(e.message, 'loss', 1400);
  });
  net.on('net:disconnected', () => toast('Connexion perdue… reconnexion', 'loss', 2000));
}

function onPhase(info, fromSync = false) {
  const prev = app.phase;
  const changed = !prev || prev.phase !== info.phase || prev.label !== info.label;
  app.phase = info;
  const remaining = Math.max(0, info.endsAtTimestamp - info.serverNow);
  if (!fromSync || changed) {
    app.phaseDeadline = performance.now() + remaining;
    app.phaseTotal = Math.max(remaining, 1);
  }
  if (!changed) return;
  if (info.phase === 'planning' || info.phase === 'carousel') {
    app.renderer.stopReplay();
    app.myReplay = null;
    app.scout = null;
    app.augmentHidden = false;
  }
  if (info.phase === 'resolution' && app.state) showResultToast();
  renderTopbar();
}

// ---------------------------------------------------------------- Accueil & salon

function bindHome() {
  const name = () => {
    const n = $('#input-name').value.trim() || 'Aventurier';
    app.net.saveName(n);
    return n;
  };
  $('#btn-create').onclick = () => {
    $('#home-error').textContent = '';
    goFullscreenLandscape();
    app.net.send('room:create', { playerName: name() });
  };
  const join = () => {
    const code = $('#input-code').value.trim().toUpperCase();
    if (code.length !== 4) {
      $('#home-error').textContent = 'Le code fait 4 caractères.';
      return;
    }
    goFullscreenLandscape();
    app.net.send('room:join', { playerName: name(), roomCode: code });
  };
  $('#btn-join').onclick = join;
  $('#input-code').addEventListener('keydown', (e) => e.key === 'Enter' && join());
  $('#btn-ready').onclick = () => {
    const me = app.lobby && app.lobby.players.find((p) => p.id === app.playerId);
    app.net.send('room:ready', { ready: !(me && me.ready) });
  };
  $('#btn-start').onclick = () => app.net.send('room:start', { botDifficulty: $('#select-difficulty').value });
  $('#btn-leave').onclick = () => app.net.send('room:leave');
  $('#btn-copy-code').onclick = () => {
    const code = app.lobby ? app.lobby.roomCode : '';
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
    toastHome('Code copié : ' + code);
  };
  $('#btn-rotate-fullscreen').onclick = goFullscreenLandscape;
}

function toastHome(msg) {
  $('#home-error').textContent = msg;
}

function renderLobby() {
  const l = app.lobby;
  $('#lobby-code').textContent = l.roomCode;
  const isHost = l.hostId === app.playerId;
  const ul = $('#lobby-players');
  ul.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const p = l.players[i];
    const li = document.createElement('li');
    if (p) {
      li.innerHTML = `<strong></strong><span class="${p.id === l.hostId ? 'host' : 'ready'}"></span>`;
      li.querySelector('strong').textContent = p.name + (p.id === app.playerId ? ' (toi)' : '');
      li.querySelector('span').textContent = p.id === l.hostId ? 'Hôte' : p.ready ? 'Prêt' : '';
    } else {
      li.className = 'empty';
      li.textContent = 'Bot (place libre)';
    }
    ul.appendChild(li);
  }
  $('#btn-start').disabled = !isHost;
  $('#select-difficulty').disabled = !isHost;
  const me = l.players.find((p) => p.id === app.playerId);
  $('#btn-ready').textContent = me && me.ready ? 'Pas prêt' : 'Prêt';
  $('#btn-ready').classList.toggle('hidden', isHost);
}

// ---------------------------------------------------------------- Jeu : HUD

// Ne reconstruit un bloc du DOM que si ses données ont changé (sinon un clic en cours serait perdu).
const renderKeys = {};
function changed(name, data) {
  const key = JSON.stringify(data);
  if (renderKeys[name] === key) return false;
  renderKeys[name] = key;
  return true;
}

function renderHud() {
  if (!app.state) return;
  renderTopbar();
  renderTraits();
  renderDps();
  renderPlayers();
  renderShop();
  renderItems();
  renderAugments();
  renderCarousel();
  renderScoutBanner();
}

function renderTopbar() {
  const ph = app.phase;
  if (!ph) return;
  $('#stage-label').textContent = ph.label;
  $('#phase-label').textContent = `${PHASE_NAMES[ph.phase] || ph.phase} · ${ROUND_TYPES[ph.roundType] || ''}`;
  const up = $('#upcoming');
  up.innerHTML = '';
  for (const r of ph.upcoming || []) {
    const s = document.createElement('span');
    s.className = r.type;
    s.textContent = `${r.label} ${ROUND_TYPES[r.type]}`;
    up.appendChild(s);
  }
}

function updateTimer() {
  const left = Math.max(0, app.phaseDeadline - performance.now());
  const pct = app.phaseTotal ? (left / app.phaseTotal) * 100 : 0;
  $('#timer-fill').style.width = pct + '%';
  $('#timer-text').textContent = app.phase && app.phase.phase !== 'finished' ? Math.ceil(left / 1000) + ' s' : '';
}

function tierClass(t) {
  if (!t.active) return 'inactive';
  const def = app.content.traitById[t.id];
  if (def && def.breakpoints.length === 1) return 'prismatic';
  if (t.activeIndex >= t.breakpoints.length - 1) return 'gold';
  return t.activeIndex >= 1 ? 'silver' : 'bronze';
}

function viewedBoard() {
  if (app.scout && app.scout.board) return app.scout.board;
  return app.state ? { units: app.state.self.units, traits: app.state.self.traits } : { units: [], traits: [] };
}

function renderTraits() {
  if (!changed('traits', viewedBoard().traits)) return;
  const box = $('#tab-traits');
  box.innerHTML = '';
  const traits = viewedBoard().traits || [];
  if (!traits.length) box.innerHTML = '<p class="hint">Place des unités sur le plateau pour activer des synergies.</p>';
  for (const t of traits) {
    const def = app.content.traitById[t.id];
    const next = t.breakpoints.find((b) => b > t.count) || t.breakpoints[t.breakpoints.length - 1];
    const div = document.createElement('div');
    div.className = 'trait ' + tierClass(t);
    div.title = def ? `${def.name}\n${def.description}\nPaliers : ${t.breakpoints.join(' / ')}` : t.id;
    div.innerHTML = `<span class="count">${t.count}/${next}</span><span class="name"></span><span class="bps">${t.breakpoints.join('·')}</span>`;
    div.querySelector('.name').textContent = def ? def.name.replace(/^(L'|Le |La |Les )/, '') : t.id;
    box.appendChild(div);
  }
}

function renderDps() {
  const box = $('#tab-dps');
  const rp = app.renderer.replay;
  let rows;
  if (rp) rows = [...rp.stats.values()].filter((s) => s.side === rp.viewerSide);
  else rows = (app.state && app.state.self.dps) || [];
  rows = rows.slice().sort((a, b) => b.dealt - a.dealt);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.dealt, r.taken, r.healed)));
  box.innerHTML = rows.length ? '' : '<p class="hint">Les dégâts du dernier combat s\'affichent ici.</p>';
  for (const r of rows) {
    const div = document.createElement('div');
    div.className = 'dps-row';
    div.innerHTML = `<div class="label"><span></span><span>${r.dealt}</span></div>
      <div class="bar" style="width:${(r.dealt / max) * 100}%"></div>
      <div class="bar taken" style="width:${(r.taken / max) * 100}%"></div>
      <div class="bar healed" style="width:${(r.healed / max) * 100}%"></div>`;
    div.querySelector('.label span').textContent = (r.name || '').split(',')[0];
    box.appendChild(div);
  }
}

function renderPlayers() {
  if (!changed('players', [app.state.players, app.scout && app.scout.playerId])) return;
  const ol = $('#players-list');
  ol.innerHTML = '';
  for (const p of app.state.players) {
    const li = document.createElement('li');
    li.className = (p.id === app.playerId ? 'me ' : '') + (!p.alive ? 'dead ' : '') + (app.scout && app.scout.playerId === p.id ? 'scouted' : '');
    const streak = p.streak > 1 ? `<span class="streak-w">🔥${p.streak}</span>` : p.streak < -1 ? `<span class="streak-l">❄${-p.streak}</span>` : '';
    li.innerHTML = `<span class="pname"></span><span class="php">${p.alive ? p.hp : '#' + p.placement}</span>
      <span class="meta">${p.isBot ? '<span class="badge">Bot</span>' : p.botControlled ? '<span class="badge">Absent</span>' : ''}<span>Niv ${p.level}</span>${streak}</span>
      <div class="hpbar"><div style="width:${Math.max(0, p.hp)}%"></div></div>`;
    li.querySelector('.pname').textContent = p.name;
    li.onclick = () => {
      if (p.id === app.playerId) return stopScout();
      app.net.send('action:scout_player', { targetPlayerId: p.id });
    };
    ol.appendChild(li);
  }
}

function stopScout() {
  app.scout = null;
  if (app.phase && app.phase.phase === 'combat' && app.myReplay) app.renderer.startReplay(app.myReplay);
  else app.renderer.stopReplay();
  renderHud();
}

function renderScoutBanner() {
  const b = $('#scout-banner');
  if (app.scout) {
    const p = app.state.players.find((x) => x.id === app.scout.playerId);
    $('#scout-name').textContent = 'Plateau de ' + (p ? p.name : '?');
    b.classList.remove('hidden');
  } else b.classList.add('hidden');
}

function ownedCount(champId) {
  return app.state.self.units.filter((u) => u.champId === champId && u.star === 1).length;
}

function renderShop() {
  const s = app.state.self;
  $('#gold').textContent = s.gold;
  $('#interest').textContent = `+${Math.min(5, Math.floor(s.gold / 10))}`;
  $('#level-text').textContent = 'Niv. ' + s.level;
  $('#xp-text').textContent = s.xpToNext ? `${s.xp}/${s.xpToNext} XP · ${countBoard()}/${s.maxUnits} unités` : `MAX · ${countBoard()}/${s.maxUnits}`;
  $('#xp-fill').style.width = s.xpToNext ? (s.xp / s.xpToNext) * 100 + '%' : '100%';
  $('#reroll-cost').textContent = s.freeRerolls > 0 ? `gratuit (${s.freeRerolls})` : s.rerollCost + ' PO';
  $('#btn-lock').textContent = s.shopLocked ? '🔒' : '🔓';
  $('#btn-lock').classList.toggle('locked', s.shopLocked);
  $('#odds').innerHTML = s.odds.map((o, i) => `<span class="ctext-${i + 1}">${Math.round(o * 100)}%</span>`).join('');

  if (!changed('shop', [s.shop, s.gold, s.units.map((u) => u.champId + u.star)])) return;
  const shop = $('#shop');
  shop.innerHTML = '';
  s.shop.forEach((champId, i) => {
    const card = document.createElement('div');
    if (!champId) {
      card.className = 'card empty';
      shop.appendChild(card);
      return;
    }
    const c = app.content.championById[champId];
    card.className = `card cost-${c.cost}` + (s.gold < c.cost ? ' cant' : '');
    const traits = c.traits.map((t) => (app.content.traitById[t] ? app.content.traitById[t].name.replace(/^(L'|Le |La |Les )/, '') : t)).join(' · ');
    const owned = ownedCount(champId);
    card.innerHTML = `<div class="art"></div>${owned ? `<span class="pair">${owned >= 2 ? '★★ !' : 'x' + (owned + 1)}</span>` : ''}
      <span class="ccost">${c.cost}</span>
      <div class="info"><div class="cname"></div><div class="ctraits"></div></div>`;
    setArt(card.querySelector('.art'), c);
    card.querySelector('.cname').textContent = c.name.split(',')[0];
    card.querySelector('.ctraits').textContent = traits;
    card.onclick = () => app.net.send('action:buy_unit', { shopSlotIndex: i });
    shop.appendChild(card);
  });
}

// Portraits : chaque image n'est demandée qu'une fois (les absentes sont remplacées par les initiales).
const portraitCache = new Map(); // champId -> Promise<boolean>
function portraitAvailable(champ) {
  if (!portraitCache.has(champ.id)) {
    portraitCache.set(
      champ.id,
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = champ.assets.portrait_path;
      }),
    );
  }
  return portraitCache.get(champ.id);
}

function setArt(el, champ) {
  el.classList.add('fallback');
  el.textContent = initials(champ.name);
  portraitAvailable(champ).then((ok) => {
    if (!ok) return;
    el.classList.remove('fallback');
    el.textContent = '';
    el.style.backgroundImage = `url("${champ.assets.portrait_path}")`;
  });
}

function countBoard() {
  return app.state.self.units.filter((u) => u.zone === 'board').length;
}

function renderItems() {
  if (!changed('items', [app.scout ? null : app.state.self.itemBench])) return;
  const bar = $('#items-bar');
  bar.innerHTML = '';
  const items = app.scout ? [] : app.state.self.itemBench;
  items.forEach((id, idx) => {
    const it = app.content.itemById[id];
    const chip = document.createElement('div');
    const kind = app.content.componentById[id] ? 'component' : it && it.effect_id === 'grant_trait' ? 'emblem' : 'combined';
    chip.className = 'item-chip ' + kind;
    chip.style.borderColor = itemColor(app.content, id);
    chip.textContent = itemLetters(app.content, id);
    chip.title = it ? `${it.name}\n${describeStats(it.stats)}${it.description ? '\n' + it.description : ''}` : id;
    chip.addEventListener('pointerdown', (e) => startItemDrag(e, idx, id));
    bar.appendChild(chip);
  });
}

function describeStats(stats = {}) {
  const names = { ad: 'AD', ap: 'AP', attack_speed: 'Vit. att.', armor: 'Armure', mr: 'RM', hp: 'PV', mana_start: 'Mana', crit_chance: 'Crit.' };
  return Object.entries(stats)
    .map(([k, v]) => `+${k === 'attack_speed' || k === 'crit_chance' ? Math.round(v * 100) + '%' : v} ${names[k] || k}`)
    .join(', ');
}

function renderAugments() {
  const c = app.state.self.augmentChoices;
  const planning = app.phase && app.phase.phase === 'planning';
  const show = Boolean(c) && planning && !app.scout;
  $('#augment-modal').classList.toggle('hidden', !show || app.augmentHidden);
  $('#btn-augment-show').classList.toggle('hidden', !show || !app.augmentHidden);
  if (!c || !changed('augments', c)) return;
  $('#augment-tier').textContent = TIER_NAMES[c.tier] || c.tier;
  const box = $('#augment-options');
  box.innerHTML = '';
  c.options.forEach((id, i) => {
    const a = app.content.augmentById[id];
    const div = document.createElement('div');
    div.className = 'augment ' + a.tier;
    div.innerHTML = `<h3></h3><p></p><div class="row"><button class="btn primary small">Choisir</button><button class="btn small" ${c.rerolled[i] ? 'disabled' : ''}>↻ Relancer</button></div>`;
    div.querySelector('h3').textContent = a.name;
    div.querySelector('p').textContent = a.description;
    const [pick, reroll] = div.querySelectorAll('button');
    pick.onclick = () => app.net.send('action:pick_augment', { augmentId: id });
    reroll.onclick = () => app.net.send('action:reroll_augment', { slotIndex: i });
    box.appendChild(div);
  });
}

function renderCarousel() {
  const c = app.state.carousel;
  const modal = $('#carousel-modal');
  if (!c || !app.phase || app.phase.phase !== 'carousel') {
    modal.classList.add('hidden');
    return;
  }
  modal.classList.remove('hidden');
  if (!changed('carousel', [c.slots, c.currentWave])) return;
  const myTurn = c.currentWave.includes(app.playerId);
  const picked = c.slots.some((s) => s.takenBy === app.playerId);
  const names = c.currentWave.map((id) => (app.state.players.find((p) => p.id === id) || {}).name).join(' et ');
  $('#carousel-turn').textContent = picked ? '— champion choisi !' : myTurn ? '— à toi de choisir !' : `— au tour de ${names}`;
  const box = $('#carousel-slots');
  box.innerHTML = '';
  c.slots.forEach((s, i) => {
    const ch = app.content.championById[s.champId];
    const it = app.content.itemById[s.item];
    const card = document.createElement('div');
    card.className = `card cost-${ch.cost}` + (s.takenBy ? ' taken' : '');
    card.innerHTML = `<div class="art"></div><span class="citem"></span><span class="ccost">${ch.cost}</span><div class="info"><div class="cname"></div><div class="ctraits"></div></div>`;
    setArt(card.querySelector('.art'), ch);
    card.querySelector('.citem').textContent = itemLetters(app.content, s.item);
    card.querySelector('.citem').title = it ? it.name : '';
    card.querySelector('.cname').textContent = ch.name.split(',')[0];
    card.querySelector('.ctraits').textContent = s.takenBy ? 'Pris par ' + ((app.state.players.find((p) => p.id === s.takenBy) || {}).name || '?') : it ? it.name : '';
    if (!s.takenBy && myTurn && !picked) card.onclick = () => app.net.send('action:pick_carousel', { carouselSlotIndex: i });
    box.appendChild(card);
  });
}

// ---------------------------------------------------------------- Messages

let toastTimer = null;
function toast(html, cls = '', ms = 1800) {
  const t = $('#toast');
  t.className = 'toast ' + cls;
  t.innerHTML = html;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function showResultToast() {
  const r = app.state.self.lastCombat;
  if (!r || app.lastResolutionShown === app.phase.label) return;
  app.lastResolutionShown = app.phase.label;
  const loot = (r.loot || [])
    .map((l) => (l.type === 'gold' ? `+${l.amount} PO` : l.type === 'item' ? app.content.itemById[l.id].name : app.content.championById[l.id].name.split(',')[0]))
    .join(', ');
  if (r.won) toast(`Victoire !${loot ? `<small>Butin : ${escapeHtml(loot)}</small>` : ''}`, 'win', 2200);
  else if (r.draw) toast(`Égalité — −${r.damage} PV`, 'loss', 2200);
  else toast(`Défaite — −${r.damage} PV${loot ? `<small>Butin : ${escapeHtml(loot)}</small>` : ''}`, 'loss', 2200);
}

function showGameOver(o) {
  $('#over-modal').classList.remove('hidden');
  const mine = o.ranking.find((r) => r.id === app.playerId);
  $('#over-title').textContent = mine ? (mine.placement === 1 ? 'Victoire ! Tu es 1er' : `Partie terminée — ${mine.placement}ᵉ`) : 'Partie terminée';
  const ol = $('#over-ranking');
  ol.innerHTML = '';
  for (const r of o.ranking) {
    const li = document.createElement('li');
    li.className = r.id === app.playerId ? 'me' : '';
    li.textContent = `${r.name}${r.isBot ? ' (bot)' : ''}`;
    ol.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------- Fiche d'unité

function showUnitCard(u) {
  const card = $('#unit-card');
  const c = app.content.championById[u.champId];
  if (!c) {
    card.classList.add('hidden');
    return;
  }
  const mult = app.content.balance.star_multiplier[String(u.star)] || 1;
  const st = c.stats;
  const traits = c.traits.map((t) => app.content.traitById[t].name).join(' · ');
  const items = (u.items || []).map((id) => app.content.itemById[id]).filter(Boolean);
  const sp = c.spell;
  const val = sp.values_by_star[Math.min(u.star, 3) - 1];
  card.innerHTML = `<button class="close" aria-label="Fermer">×</button>
    <h3></h3><div class="sub"><span class="ctext-${c.cost}">Coût ${c.cost}</span> · ${'★'.repeat(u.star)} · ${ROLE_NAMES[c.role] || c.role}</div>
    <div class="sub traits"></div>
    <div class="stats">
      <span>PV ${Math.round(st.hp * mult)}</span><span>AD ${Math.round(st.ad * mult)}</span><span>AP ${st.ap}</span>
      <span>Arm. ${st.armor}</span><span>RM ${st.mr}</span><span>Vit. ${st.attack_speed}</span>
      <span>Portée ${st.range}</span><span>Mana ${st.mana_start}/${st.mana_max}</span><span>Crit ${Math.round(st.crit_chance * 100)}%</span>
    </div>
    <div class="spell"><strong></strong> <small>(${val})</small><div class="desc"></div></div>
    <div class="items"></div>`;
  card.querySelector('h3').textContent = c.name;
  card.querySelector('.traits').textContent = traits;
  card.querySelector('.spell strong').textContent = sp.name;
  card.querySelector('.spell .desc').textContent = sp.description;
  const ib = card.querySelector('.items');
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = `${it.name} — ${it.description || describeStats(it.stats)}`;
    ib.appendChild(d);
  }
  card.querySelector('.close').onclick = () => {
    card.classList.add('hidden');
    app.selectedUid = null;
    app.renderer.highlightUid = null;
  };
  card.classList.remove('hidden');
}

// ---------------------------------------------------------------- Plateau & glisser-déposer

function myUnits() {
  return app.state ? app.state.self.units : [];
}

function unitAtCell(units, cell) {
  if (!cell) return null;
  if (cell.zone === 'bench') return units.find((u) => u.zone === 'bench' && u.slot === cell.slot);
  return units.find((u) => u.zone === 'board' && u.row === cell.row && u.col === cell.col);
}

function canvasPoint(e) {
  const r = $('#board').getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function canDragUnit(u) {
  if (!u || app.scout || !app.state || !app.state.self.alive) return false;
  const ph = app.phase ? app.phase.phase : '';
  if (u.zone === 'board') return ph === 'planning';
  return ph !== 'finished';
}

function bindGame() {
  const canvas = $('#board');
  canvas.addEventListener('pointerdown', (e) => {
    const pt = canvasPoint(e);
    const cell = app.renderer.pick(pt.x, pt.y);
    const units = app.scout ? app.scout.board.units : myUnits();
    const showingReplay = app.renderer.mode === 'combat' && app.renderer.replay;
    const u = cell && !(showingReplay && cell.zone === 'board') ? unitAtCell(units, cell) : null;
    if (!u) {
      $('#unit-card').classList.add('hidden');
      app.renderer.highlightUid = null;
      return;
    }
    app.drag = { uid: u.uid, unit: u, startX: pt.x, startY: pt.y, x: pt.x, y: pt.y, active: false, canDrag: canDragUnit(u) };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const pt = canvasPoint(e);
    app.hoverCell = app.renderer.pick(pt.x, pt.y);
    const d = app.drag;
    if (!d) return;
    d.x = pt.x;
    d.y = pt.y;
    if (!d.active && d.canDrag && Math.hypot(pt.x - d.startX, pt.y - d.startY) > 6) {
      d.active = true;
      app.renderer.drag = d;
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = app.drag;
    app.drag = null;
    app.renderer.drag = null;
    if (!d) return;
    if (!d.active) {
      app.selectedUid = d.uid;
      app.renderer.highlightUid = d.uid;
      showUnitCard(d.unit);
      return;
    }
    // Lâché sur la boutique : vente.
    const over = document.elementFromPoint(e.clientX, e.clientY);
    if (over && over.closest('#shopbar')) {
      app.net.send('action:sell_unit', { unitInstanceId: d.uid });
      return;
    }
    const pt = canvasPoint(e);
    const cell = app.renderer.pick(pt.x, pt.y);
    if (!cell) return;
    app.net.send('action:move_unit', {
      unitInstanceId: d.uid,
      targetZone: cell.zone,
      row: cell.zone === 'board' ? cell.row : null,
      col: cell.zone === 'board' ? cell.col : cell.slot,
    });
  });
  canvas.addEventListener('pointercancel', () => {
    app.drag = null;
    app.renderer.drag = null;
  });
  canvas.addEventListener('pointerleave', () => (app.hoverCell = null));

  $('#btn-xp').onclick = () => app.net.send('action:buy_xp');
  $('#btn-reroll').onclick = () => app.net.send('action:reroll');
  $('#btn-lock').onclick = () => app.net.send('action:lock_shop');
  $('#btn-fullscreen').onclick = goFullscreenLandscape;
  $('#btn-scout-back').onclick = stopScout;
  $('#btn-augment-hide').onclick = () => {
    app.augmentHidden = true;
    renderAugments();
  };
  $('#btn-augment-show').onclick = () => {
    app.augmentHidden = false;
    renderAugments();
  };
  $('#btn-over-home').onclick = () => {
    $('#over-modal').classList.add('hidden');
    app.net.send('room:leave');
    show('home');
  };
  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
      for (const b of document.querySelectorAll('.tab-body')) b.classList.toggle('active', b.id === 'tab-' + tab.dataset.tab);
    };
  }

  // Raccourcis clavier : D actualiser, F XP, E vendre sous le curseur, W déployer/rappeler.
  window.addEventListener('keydown', (e) => {
    if (!$('#screen-game').classList.contains('active') || e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'd') app.net.send('action:reroll');
    else if (k === 'f') app.net.send('action:buy_xp');
    else if (k === 'e' || k === 'w') {
      const u = unitAtCell(myUnits(), app.hoverCell);
      if (!u || app.scout) return;
      if (k === 'e') app.net.send('action:sell_unit', { unitInstanceId: u.uid });
      else deployOrRecall(u);
    } else if (k === 'escape') {
      $('#unit-card').classList.add('hidden');
      stopScout();
    }
  });
}

function deployOrRecall(u) {
  if (u.zone === 'board') {
    const used = new Set(myUnits().filter((x) => x.zone === 'bench').map((x) => x.slot));
    for (let s = 0; s < 9; s++) {
      if (!used.has(s)) return app.net.send('action:move_unit', { unitInstanceId: u.uid, targetZone: 'bench', col: s });
    }
  } else {
    const range = app.content.championById[u.champId].stats.range;
    const taken = new Set(myUnits().filter((x) => x.zone === 'board').map((x) => x.row * 10 + x.col));
    const rows = range <= 1 ? [0, 1, 2, 3] : range === 2 ? [1, 2, 0, 3] : [3, 2, 1, 0];
    const cols = [3, 2, 4, 1, 5, 0, 6];
    for (const r of rows) {
      for (const c of cols) {
        if (!taken.has(r * 10 + c)) return app.net.send('action:move_unit', { unitInstanceId: u.uid, targetZone: 'board', row: r, col: c });
      }
    }
  }
}

// Glisser un objet de l'inventaire vers une unité.
function startItemDrag(e, index, itemId) {
  e.preventDefault();
  if (app.scout) return;
  const ghost = document.createElement('div');
  ghost.className = 'item-chip';
  ghost.textContent = itemLetters(app.content, itemId);
  ghost.style.cssText = `position:fixed;width:34px;height:34px;z-index:100;pointer-events:none;border-color:${itemColor(app.content, itemId)}`;
  document.body.appendChild(ghost);
  const move = (ev) => {
    ghost.style.left = ev.clientX - 17 + 'px';
    ghost.style.top = ev.clientY - 17 + 'px';
    const pt = canvasPoint(ev);
    app.hoverCell = app.renderer.pick(pt.x, pt.y);
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    ghost.remove();
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!over || over.id !== 'board') {
      const it = app.content.itemById[itemId];
      if (it) toast(`${escapeHtml(it.name)}<small>${escapeHtml(it.description || describeStats(it.stats))}</small>`, '', 2600);
      return;
    }
    const pt = canvasPoint(ev);
    const u = unitAtCell(myUnits(), app.renderer.pick(pt.x, pt.y));
    if (u) app.net.send('action:equip_item', { itemIndex: index, unitInstanceId: u.uid });
  };
  move(e);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ---------------------------------------------------------------- Boucle de rendu

let lastDps = 0;
function loop(now) {
  if (app.renderer && $('#screen-game').classList.contains('active')) {
    const r = app.renderer;
    const inCombat = app.phase && (app.phase.phase === 'combat' || app.phase.phase === 'resolution') && r.replay;
    if (!inCombat) r.setMode('planning');
    const units = app.scout && !app.scout.replay ? app.scout.board.units : myUnits();
    const dropTarget = app.drag && app.drag.active ? r.pick(app.drag.x, app.drag.y) : null;
    r.frame({ units: app.scout ? (app.scout.replay ? [] : units) : units, dropTarget });
    if (r.replay && now - lastDps > 500) {
      lastDps = now;
      renderDps();
    }
  }
  requestAnimationFrame(loop);
}

boot();
