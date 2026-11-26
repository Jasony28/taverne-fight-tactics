'use strict';
// Générateur pseudo-aléatoire déterministe (mulberry32) : même graine => même suite.
class Rng {
  constructor(seed) {
    this.state = (Number(seed) >>> 0) || 0x9e3779b9;
  }
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive) {
    return Math.floor(this.next() * maxExclusive);
  }
  range(minInclusive, maxInclusive) {
    return minInclusive + this.int(maxInclusive - minInclusive + 1);
  }
  pick(list) {
    return list[this.int(list.length)];
  }
  chance(p) {
    return this.next() < p;
  }
  shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // Tire un index selon une liste de poids (somme quelconque > 0).
  weighted(weights) {
    const total = weights.reduce((s, w) => s + w, 0);
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
}

module.exports = Rng;
