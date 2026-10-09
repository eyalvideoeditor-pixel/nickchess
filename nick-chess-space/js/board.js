import { Chessground } from 'chessground';
import { Chess, legalDests, colorName, uciToMove } from './chessutil.js';
import { store } from './util.js';

// chessground + chess.js glued together: legal moves only, promotion handled.
export class Board {
  constructor(el, { onMove } = {}) {
    this.el = el;
    this.onMove = onMove;
    this.chess = new Chess();
    this.promotionFor = null; // (from, to) => 'q' | 'n' | ...
    this.cg = Chessground(el, {
      coordinates: true,
      animation: { enabled: !store.get('ct_noanim'), duration: 220 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, showDests: true, events: { after: (o, d) => this._userMove(o, d) } },
      premovable: { enabled: false },
      draggable: { showGhost: true },
      drawable: { enabled: true, visible: true },
    });
  }

  // interactive: 'w' | 'b' | null (who may move)
  set(fen, { orientation, lastMove, interactive = null } = {}) {
    this.chess = new Chess(fen);
    const turn = colorName(this.chess.turn());
    this.cg.set({
      fen,
      orientation: orientation ? colorName(orientation) : this.cg.state.orientation,
      turnColor: turn,
      lastMove: lastMove ? [lastMove.slice(0, 2), lastMove.slice(2, 4)] : undefined,
      check: this.chess.inCheck() ? turn : false,
      movable: {
        color: interactive ? colorName(interactive) : undefined,
        dests: interactive && interactive === this.chess.turn() ? legalDests(this.chess) : new Map(),
      },
    });
    this.cg.setAutoShapes([]);
    this.cg.setShapes([]);
  }

  fen() { return this.chess.fen(); }

  lock() { this.cg.set({ movable: { color: undefined, dests: new Map() } }); }

  // play a move programmatically (opponent / replay)
  play(uci, { interactive = null } = {}) {
    const m = this.chess.move(uciToMove(uci));
    const turn = colorName(this.chess.turn());
    this.cg.move(m.from, m.to);
    if (m.promotion || m.flags.includes('e') || m.flags.includes('k') || m.flags.includes('q')) {
      this.cg.set({ fen: this.chess.fen() });
    }
    this.cg.set({
      turnColor: turn,
      lastMove: [m.from, m.to],
      check: this.chess.inCheck() ? turn : false,
      movable: {
        color: interactive ? colorName(interactive) : undefined,
        dests: interactive && interactive === this.chess.turn() ? legalDests(this.chess) : new Map(),
      },
    });
    return m;
  }

  arrows(list) {
    // list: [{uci, brush}] or [{square, brush}]
    this.cg.setAutoShapes(list.map((s) => s.uci
      ? { orig: s.uci.slice(0, 2), dest: s.uci.slice(2, 4), brush: s.brush || 'green' }
      : { orig: s.square, brush: s.brush || 'green' }));
  }

  _userMove(from, to) {
    const piece = this.chess.get(from);
    let promotion;
    if (piece && piece.type === 'p' && (to[1] === '8' || to[1] === '1')) {
      promotion = (this.promotionFor && this.promotionFor(from, to)) || 'q';
    }
    let m;
    try { m = this.chess.move({ from, to, promotion }); } catch { m = null; }
    if (!m) { this.cg.set({ fen: this.chess.fen() }); return; }
    if (m.promotion || m.flags.includes('e') || m.flags.includes('k') || m.flags.includes('q')) {
      this.cg.set({ fen: this.chess.fen() });
    }
    const turn = colorName(this.chess.turn());
    this.cg.set({ turnColor: turn, check: this.chess.inCheck() ? turn : false, movable: { dests: new Map() } });
    if (this.onMove) this.onMove(m.from + m.to + (m.promotion || ''), m);
  }

  // undo the last (user) move, back to a fen
  reset(fen, opts) { this.set(fen, opts); }

  destroy() { this.cg.destroy(); }
}
