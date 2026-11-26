'use strict';
// Horloge simulée : les minuteurs s'exécutent instantanément, dans l'ordre chronologique.
class FakeClock {
  constructor() {
    this.t = 0;
    this.queue = [];
    this.seq = 0;
  }
  now() {
    return this.t;
  }
  setTimeout(fn, ms) {
    const h = { at: this.t + ms, fn, id: ++this.seq, cancelled: false };
    this.queue.push(h);
    return h;
  }
  clearTimeout(h) {
    if (h) h.cancelled = true;
  }
  // Exécute les minuteurs jusqu'à ce que la condition soit vraie (ou plus rien à faire).
  runUntil(cond, maxSteps = 200000) {
    let steps = 0;
    while (!cond() && steps++ < maxSteps) {
      this.queue = this.queue.filter((h) => !h.cancelled);
      if (!this.queue.length) return false;
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const h = this.queue.shift();
      this.t = Math.max(this.t, h.at);
      h.fn();
    }
    return cond();
  }
}
module.exports = FakeClock;
