// Pool of Stockfish 18 (NNUE, WASM, single-thread) workers.
// evaluate(fen) resolves with the score from the side-to-move's point of view.

class EngineWorker {
  constructor(url) {
    this.w = new Worker(url);
    this.listeners = [];
    this.w.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      for (const fn of [...this.listeners]) fn(line);
    };
  }
  send(cmd) { this.w.postMessage(cmd); }
  waitFor(prefix, onLine) {
    return new Promise((resolve) => {
      const fn = (line) => {
        if (onLine) onLine(line);
        if (line.startsWith(prefix)) {
          this.listeners = this.listeners.filter((f) => f !== fn);
          resolve(line);
        }
      };
      this.listeners.push(fn);
    });
  }
  async init() {
    const ok = this.waitFor('uciok');
    this.send('uci');
    await ok;
    this.send('setoption name Hash value 16');
    const ready = this.waitFor('readyok');
    this.send('isready');
    await ready;
  }
  async evaluate(fen, { depth = 12, movetime = 0, multipv = 1 } = {}) {
    const lines = {};
    let lastDepth = 0;
    const done = this.waitFor('bestmove', (line) => {
      if (!line.startsWith('info') || line.indexOf(' pv ') < 0) return;
      if (/ (upper|lower)bound/.test(line)) return;
      const m = line.match(/ depth (\d+).*? multipv (\d+).*? score (cp|mate) (-?\d+).*? pv (.+)$/)
        || line.match(/ depth (\d+)().*? score (cp|mate) (-?\d+).*? pv (.+)$/);
      if (!m) return;
      const idx = Number(m[2] || 1);
      lastDepth = Number(m[1]);
      lines[idx] = {
        cp: m[3] === 'cp' ? Number(m[4]) : null,
        mate: m[3] === 'mate' ? Number(m[4]) : null,
        pv: m[5].trim().split(/\s+/).slice(0, 12),
        depth: lastDepth,
      };
    });
    this.send('setoption name MultiPV value ' + multipv);
    this.send('position fen ' + fen);
    this.send(movetime ? `go movetime ${movetime}` : `go depth ${depth}`);
    const bm = await done;
    const best = bm.split(/\s+/)[1];
    const main = lines[1] || { cp: 0, mate: null, pv: [] };
    return {
      cp: main.cp, mate: main.mate,
      best: best && best !== '(none)' ? best : null,
      pv: main.pv, depth: lastDepth,
      lines: Object.keys(lines).sort((a, b) => a - b).map((k) => lines[k]),
    };
  }
  terminate() { this.w.terminate(); }
}

export class EnginePool {
  constructor(size) {
    const cores = navigator.hardwareConcurrency || 4;
    const phone = /Android|iPhone|iPad/i.test(navigator.userAgent) || (navigator.deviceMemory || 8) <= 4;
    this.size = size || Math.max(1, Math.min(phone ? 3 : 6, cores - 1));
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.ready = null;
  }
  init() {
    if (!this.ready) {
      this.ready = (async () => {
        const url = new URL('../engine/stockfish.js', import.meta.url).href;
        for (let i = 0; i < this.size; i++) this.workers.push(new EngineWorker(url));
        await Promise.all(this.workers.map((w) => w.init()));
        this.idle = [...this.workers];
      })();
    }
    return this.ready;
  }
  evaluate(fen, opts) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fen, opts, resolve, reject });
      this._pump();
    });
  }
  // drop every queued (not yet started) job
  cancelPending() {
    const q = this.queue; this.queue = [];
    for (const j of q) j.reject(new Error('cancelled'));
  }
  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      w.evaluate(job.fen, job.opts)
        .then(job.resolve, job.reject)
        .finally(() => { this.idle.push(w); this._pump(); });
    }
  }
}

let shared = null;
export function getEngine() {
  if (!shared) shared = new EnginePool();
  return shared;
}

// A separate single worker for interactive checks, so it never waits behind a big analysis queue.
let quick = null;
export function getQuickEngine() {
  if (!quick) quick = new EnginePool(1);
  return quick;
}
