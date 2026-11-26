// Rendu Canvas 2D : grille hexagonale (odd-r), banc, unités, replay animé du combat.
const SQRT3 = Math.sqrt(3);
const COST_COLORS = { 1: '#9aa0a6', 2: '#39b45a', 3: '#3a86e0', 4: '#a659e0', 5: '#f0b429' };
const DTYPE_COLORS = { physical: '#ff9a4d', magic: '#6fb0ff', true: '#ffffff' };
const ARENA_ROWS = 8;
const COLS = 7;
const BENCH = 9;

export class Renderer {
  constructor(canvas, content) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.content = content;
    this.images = new Map();
    this.mode = 'planning'; // planning : 4 rangées du joueur ; combat : arène complète
    this.flip = false; // vue retournée quand le joueur est « away » dans le replay
    this.units = []; // unités à dessiner (préparation)
    this.replay = null;
    this.effects = [];
    this.drag = null;
    this.hover = null;
    this.highlightUid = null;
    this.leftInset = 48;
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(10, r.width);
    this.h = Math.max(10, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.layout();
  }

  layout() {
    const rows = this.mode === 'combat' ? ARENA_ROWS : 4;
    this.rowStart = this.mode === 'combat' ? 0 : 4;
    const availW = this.w - this.leftInset - 8;
    const benchFactor = 2.0; // hauteur du banc en multiples de la taille d'hex
    const availH = this.h - 8;
    // Hauteur grille = rows*1.5*s + 0.5*s ; largeur = (cols + 0.5) * √3 * s
    const topPad = 0.6; // place pour les étoiles et barres de la première rangée
    const sByH = availH / (rows * 1.5 + 0.5 + benchFactor + 0.3 + topPad);
    const sByW = availW / ((COLS + 0.5) * SQRT3);
    const s = Math.max(8, Math.min(sByH, sByW));
    this.size = s;
    this.hexW = SQRT3 * s;
    this.gridW = (COLS + 0.5) * this.hexW;
    this.gridH = rows * 1.5 * s + 0.5 * s;
    const totalH = this.gridH + (benchFactor + 0.3 + topPad) * s;
    this.ox = this.leftInset + (availW - this.gridW) / 2;
    this.oy = 4 + (availH - totalH) / 2 + topPad * s;
    // Banc : 9 cases sous la grille, centrées.
    const benchCell = Math.min(this.hexW * 1.0, (availW - 8) / BENCH);
    this.bench = {
      cell: benchCell,
      x: this.leftInset + (availW - benchCell * BENCH) / 2,
      y: this.oy + this.gridH + 0.3 * s,
      h: Math.min(benchFactor * s, benchCell),
    };
  }

  setMode(mode, flip = false) {
    if (mode !== this.mode || flip !== this.flip) {
      this.mode = mode;
      this.flip = flip;
      this.layout();
    }
  }

  // Centre en pixels d'une case de l'arène (rangée 0 à 7).
  center(row, col) {
    let x = this.ox + col * this.hexW + (row & 1 ? this.hexW / 2 : 0) + this.hexW / 2;
    let y = this.oy + (row - this.rowStart) * 1.5 * this.size + this.size;
    if (this.flip && this.mode === 'combat') {
      x = this.ox + this.gridW - (x - this.ox);
      y = this.oy + this.gridH - (y - this.oy);
    }
    return { x, y };
  }

  benchCenter(slot) {
    return { x: this.bench.x + this.bench.cell * (slot + 0.5), y: this.bench.y + this.bench.h / 2 };
  }

  // Case sous le pointeur (plateau du joueur en coordonnées de plateau 0-3, ou banc).
  pick(px, py) {
    if (py >= this.bench.y && py <= this.bench.y + this.bench.h) {
      const slot = Math.floor((px - this.bench.x) / this.bench.cell);
      if (slot >= 0 && slot < BENCH) return { zone: 'bench', slot };
    }
    let best = null;
    let bestD = Infinity;
    const rows = this.mode === 'combat' ? [4, 5, 6, 7] : [4, 5, 6, 7];
    for (const r of rows) {
      for (let c = 0; c < COLS; c++) {
        const p = this.center(r, c);
        const d = (p.x - px) ** 2 + (p.y - py) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { zone: 'board', row: r - 4, col: c };
        }
      }
    }
    if (best && bestD <= (this.size * 0.95) ** 2) return best;
    return null;
  }

  image(champId) {
    if (this.images.has(champId)) return this.images.get(champId);
    const champ = this.content.championById[champId];
    const entry = { img: new Image(), ok: false };
    entry.img.onload = () => (entry.ok = true);
    entry.img.onerror = () => (entry.ok = false);
    if (champ) entry.img.src = champ.assets.portrait_path;
    this.images.set(champId, entry);
    return entry;
  }

  // --- Dessin -----------------------------------------------------------------

  hexPath(x, y, s) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      const px = x + s * Math.cos(a);
      const py = y + s * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  drawGrid(dropTarget) {
    const ctx = this.ctx;
    const rows = this.mode === 'combat' ? ARENA_ROWS : 4;
    for (let i = 0; i < rows; i++) {
      const r = this.rowStart + i;
      for (let c = 0; c < COLS; c++) {
        const { x, y } = this.center(r, c);
        // Moitié du joueur : en bas de l'écran (rangées 4-7, ou 0-3 quand la vue est retournée).
        const mine = this.mode === 'combat' && this.flip ? r < 4 : r >= 4;
        this.hexPath(x, y, this.size * 0.96);
        ctx.fillStyle = mine ? 'rgba(227,163,59,0.07)' : 'rgba(224,87,79,0.06)';
        if (dropTarget && dropTarget.zone === 'board' && dropTarget.row === r - 4 && dropTarget.col === c) ctx.fillStyle = 'rgba(227,163,59,0.35)';
        ctx.fill();
        ctx.strokeStyle = mine ? 'rgba(227,163,59,0.25)' : 'rgba(224,87,79,0.22)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    // Banc
    for (let s = 0; s < BENCH; s++) {
      const x = this.bench.x + s * this.bench.cell + 2;
      const w = this.bench.cell - 4;
      ctx.fillStyle = dropTarget && dropTarget.zone === 'bench' && dropTarget.slot === s ? 'rgba(227,163,59,0.35)' : 'rgba(255,255,255,0.04)';
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      roundRect(ctx, x, this.bench.y, w, this.bench.h, 6);
      ctx.fill();
      ctx.stroke();
    }
  }

  drawUnit(u, x, y, opts = {}) {
    const ctx = this.ctx;
    const champ = this.content.championById[u.champId];
    const monster = this.content.monsters && this.content.monsters[u.champId];
    const r = this.size * (opts.small ? 0.62 : 0.72);
    const cost = champ ? champ.cost : 1;
    const ring = u.summon ? '#d8b4fe' : monster ? '#7a6a5a' : COST_COLORS[cost];

    ctx.save();
    if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
    // Portrait (ou initiales si l'image n'existe pas encore)
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#2a231d';
    ctx.fill();
    const im = champ ? this.image(u.champId) : null;
    if (im && im.ok) {
      ctx.save();
      ctx.clip();
      ctx.drawImage(im.img, x - r, y - r, r * 2, r * 2);
      ctx.restore();
    } else {
      const name = u.name || (champ ? champ.name : monster ? monster.name : u.champId);
      ctx.fillStyle = '#f1e6d6';
      ctx.font = `800 ${Math.round(r * 0.75)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials(name), x, y + 1);
    }
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.strokeStyle = this.highlightUid === u.uid ? '#ffffff' : ring;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();

    // Étoiles
    if (u.star > 1 || opts.showStars) {
      ctx.font = `${Math.round(r * 0.5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = u.star === 3 ? '#f0c048' : u.star === 2 ? '#b9c2cc' : '#b7773c';
      ctx.fillText('★'.repeat(u.star), x, y - r - r * 0.55);
    }

    // Barres PV / bouclier / mana
    if (opts.bars) {
      const bw = r * 2.1;
      const bx = x - bw / 2;
      const by = y - r - r * 0.32;
      const hpPct = Math.max(0, Math.min(1, u.hp / u.maxHp));
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(bx - 1, by - 1, bw + 2, r * 0.28 + 2);
      ctx.fillStyle = opts.enemy ? '#e0574f' : '#5fbf6a';
      ctx.fillRect(bx, by, bw * hpPct, r * 0.2);
      if (u.shield > 0) {
        const sp = Math.min(1, u.shield / u.maxHp);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(bx + bw * hpPct, by, Math.min(bw * (1 - hpPct), bw * sp), r * 0.2);
      }
      if (u.manaMax > 0) {
        ctx.fillStyle = '#4c8df0';
        ctx.fillRect(bx, by + r * 0.2, bw * Math.max(0, Math.min(1, u.mana / u.manaMax)), r * 0.08);
      }
    }

    // Objets portés
    if (u.items && u.items.length) {
      const s = r * 0.5;
      const total = u.items.length * s + (u.items.length - 1) * 2;
      u.items.forEach((id, i) => {
        const ix = x - total / 2 + i * (s + 2);
        const iy = y + r - s * 0.35;
        ctx.fillStyle = '#14110f';
        ctx.strokeStyle = itemColor(this.content, id);
        ctx.lineWidth = 1.5;
        roundRect(ctx, ix, iy, s, s, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#f1e6d6';
        ctx.font = `700 ${Math.round(s * 0.55)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(itemLetters(this.content, id), ix + s / 2, iy + s / 2 + 1);
      });
    }
    if (opts.stunned) {
      ctx.font = `${Math.round(r * 0.7)}px system-ui`;
      ctx.fillText('💫', x + r * 0.7, y - r * 0.6);
    }
    ctx.restore();
  }

  // Préparation : unités du joueur (plateau + banc).
  drawPlanning(units) {
    for (const u of units) {
      if (this.drag && this.drag.uid === u.uid) continue;
      if (u.zone === 'board') {
        const p = this.center(4 + u.row, u.col);
        this.drawUnit(u, p.x, p.y, { showStars: true });
      } else if (u.zone === 'bench') {
        const p = this.benchCenter(u.slot);
        this.drawUnit(u, p.x, p.y, { small: true, showStars: true });
      }
    }
  }

  drawBench(units) {
    for (const u of units) {
      if (u.zone !== 'bench' || (this.drag && this.drag.uid === u.uid)) continue;
      const p = this.benchCenter(u.slot);
      this.drawUnit(u, p.x, p.y, { small: true, showStars: true });
    }
  }

  frame({ units, dropTarget }) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    this.drawGrid(dropTarget);
    if (this.mode === 'combat' && this.replay) {
      this.replay.update(performance.now());
      this.drawReplay();
      if (units) this.drawBench(units);
    } else if (units) {
      this.drawPlanning(units);
    }
    this.drawEffects();
    if (this.drag && this.drag.unit) {
      this.drawUnit(this.drag.unit, this.drag.x, this.drag.y, { alpha: 0.85, showStars: true });
    }
  }

  // --- Replay -------------------------------------------------------------------

  startReplay(payload) {
    this.replay = new ReplayPlayer(payload, this);
    this.effects = [];
    this.setMode('combat', payload.viewerSide === 1);
  }

  stopReplay() {
    this.replay = null;
    this.effects = [];
  }

  drawReplay() {
    const rp = this.replay;
    const sorted = [...rp.units.values()].filter((u) => u.alive).sort((a, b) => a.y - b.y);
    for (const u of sorted) {
      const p = this.unitPixel(u);
      this.drawUnit(u, p.x, p.y, { bars: true, enemy: u.side !== rp.viewerSide, stunned: u.stunnedUntil > rp.tick });
    }
    if (rp.overtime) {
      const ctx = this.ctx;
      ctx.fillStyle = 'rgba(224,87,79,0.9)';
      ctx.font = `800 ${Math.round(this.size * 0.5)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText('PROLONGATION', this.ox + this.gridW / 2, this.oy + this.gridH / 2);
    }
  }

  unitPixel(u) {
    const rp = this.replay;
    const a = this.center(u.fromRow, u.fromCol);
    const b = this.center(u.row, u.col);
    const k = u.moveDur > 0 ? Math.max(0, Math.min(1, (rp.tickF - u.moveStart) / u.moveDur)) : 1;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }

  addEffect(e) {
    if (this.effects.length > 120) this.effects.shift();
    this.effects.push({ ...e, born: performance.now() });
  }

  drawEffects() {
    const ctx = this.ctx;
    const now = performance.now();
    this.effects = this.effects.filter((e) => now - e.born < e.life);
    for (const e of this.effects) {
      const k = (now - e.born) / e.life;
      ctx.save();
      if (e.kind === 'text') {
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = e.color;
        ctx.font = `800 ${Math.round(this.size * (e.big ? 0.55 : 0.42))}px system-ui`;
        ctx.textAlign = 'center';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 3;
        const y = e.y - k * this.size * 0.9;
        ctx.strokeText(e.text, e.x, y);
        ctx.fillText(e.text, e.x, y);
      } else if (e.kind === 'projectile') {
        const x = e.x1 + (e.x2 - e.x1) * k;
        const y = e.y1 + (e.y2 - e.y1) * k;
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.arc(x, y, this.size * 0.12, 0, Math.PI * 2);
        ctx.fill();
      } else if (e.kind === 'ring') {
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r * (0.4 + 0.6 * k), 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.kind === 'label') {
        ctx.globalAlpha = 1 - k * k;
        ctx.fillStyle = '#f5c66b';
        ctx.font = `700 ${Math.round(this.size * 0.36)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.fillText(e.text, e.x, e.y - this.size * 1.1);
      }
      ctx.restore();
    }
  }
}

// Rejoue le journal d'événements du serveur au rythme réel (ticks de 100 ms).
export class ReplayPlayer {
  constructor(payload, renderer) {
    this.p = payload;
    this.r = renderer;
    this.viewerSide = payload.viewerSide || 0;
    this.start = performance.now();
    this.tick = 0;
    this.tickF = 0;
    this.index = 0;
    this.overtime = false;
    this.done = false;
    this.units = new Map();
    this.stats = new Map();
    for (const u of payload.initialUnits) this.addUnit(u);
  }

  addUnit(u) {
    this.units.set(u.uid, {
      ...u,
      fromRow: u.row, fromCol: u.col, moveStart: 0, moveDur: 0,
      alive: true, shield: 0, stunnedUntil: 0,
    });
    this.stats.set(u.uid, { uid: u.uid, name: u.name, side: u.side, champId: u.champId, dealt: 0, taken: 0, healed: 0 });
  }

  update(now) {
    this.tickF = (now - this.start) / 100;
    this.tick = Math.floor(this.tickF);
    const log = this.p.eventLog;
    while (this.index < log.length && log[this.index].t <= this.tick) {
      this.apply(log[this.index]);
      this.index += 1;
    }
    if (this.index >= log.length) this.done = true;
  }

  pixelOf(uid) {
    const u = this.units.get(uid);
    return u ? this.r.unitPixel(u) : null;
  }

  apply(e) {
    const u = this.units.get(e.uid);
    switch (e.type) {
      case 'MOVE':
        if (!u) break;
        u.fromRow = u.row;
        u.fromCol = u.col;
        u.row = e.row;
        u.col = e.col;
        u.moveStart = e.t;
        u.moveDur = e.kind === 'walk' ? 5 : 2;
        break;
      case 'ATTACK':
        if (u) u.mana = e.mana;
        break;
      case 'PROJECTILE': {
        const a = this.pixelOf(e.uid);
        const b = this.pixelOf(e.target);
        if (a && b) this.r.addEffect({ kind: 'projectile', x1: a.x, y1: a.y, x2: b.x, y2: b.y, life: 220, color: u && u.side === this.viewerSide ? '#f5c66b' : '#ff8a80' });
        break;
      }
      case 'DAMAGE': {
        if (!u) break;
        u.hp = e.hp;
        u.shield = e.shield;
        if (e.mana != null) u.mana = e.mana;
        const st = this.stats.get(e.src);
        if (st) st.dealt += e.amount;
        const tg = this.stats.get(e.uid);
        if (tg) tg.taken += e.amount;
        const p = this.pixelOf(e.uid);
        if (p && e.amount > 0) {
          this.r.addEffect({ kind: 'text', x: p.x + (Math.random() - 0.5) * this.r.size * 0.6, y: p.y - this.r.size * 0.3, text: String(e.amount) + (e.crit ? '!' : ''), color: DTYPE_COLORS[e.dtype] || '#fff', big: e.crit || e.spell, life: 700 });
        }
        break;
      }
      case 'HEAL': {
        if (!u) break;
        u.hp = e.hp;
        const st = this.stats.get(e.src);
        if (st) st.healed += e.amount;
        const p = this.pixelOf(e.uid);
        if (p && e.amount >= 5) this.r.addEffect({ kind: 'text', x: p.x, y: p.y - this.r.size * 0.3, text: '+' + e.amount, color: '#5fbf6a', life: 700 });
        break;
      }
      case 'SHIELD': {
        if (!u) break;
        u.shield = e.total;
        const st = this.stats.get(e.src);
        if (st) st.healed += e.amount;
        break;
      }
      case 'MANA':
        if (u) u.mana = e.mana;
        break;
      case 'MAXHP':
        if (u) {
          u.maxHp = e.maxHp;
          u.hp = e.hp;
        }
        break;
      case 'SPELL_CAST': {
        if (u) u.mana = 0;
        const p = this.pixelOf(e.uid);
        if (p) this.r.addEffect({ kind: 'label', x: p.x, y: p.y, text: e.spell, life: 1100 });
        const c = this.r.center(e.row, e.col);
        this.r.addEffect({ kind: 'ring', x: c.x, y: c.y, r: this.r.size * (1 + (e.radius || 0) * 1.6), color: '#b48cff', life: 500 });
        break;
      }
      case 'STATUS':
        if (u && e.status === 'stun') u.stunnedUntil = e.t + e.duration * 10;
        break;
      case 'SUMMON':
        this.addUnit(e);
        break;
      case 'DEATH':
        if (u) u.alive = false;
        break;
      case 'OVERTIME':
        this.overtime = true;
        break;
      default:
        break;
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function initials(name) {
  const clean = String(name).split(',')[0].replace(/[^\p{L}\s-]/gu, ' ').trim();
  const parts = clean.split(/[\s-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function itemLetters(content, id) {
  const it = content.itemById[id];
  if (!it) return '?';
  if (it.effect_id === 'grant_trait') return '◆';
  return initials(it.name.replace(/^(Le |La |Les |L')/, ''));
}

export function itemColor(content, id) {
  const it = content.itemById[id];
  if (!it) return '#888';
  if (content.componentById[id]) return '#a8998a';
  if (it.effect_id === 'grant_trait') return '#d27cff';
  return '#e3a33b';
}
