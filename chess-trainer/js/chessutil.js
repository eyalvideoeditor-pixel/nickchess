import { Chess } from 'chess.js';

export { Chess };

export const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined };
}

export function moveToUci(m) {
  return m.from + m.to + (m.promotion || '');
}

// Map<square, square[]> of legal destinations, as chessground expects
export function legalDests(chess) {
  const dests = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

export function colorName(c) { return c === 'w' ? 'white' : 'black'; }

export function sideToMove(fen) { return fen.split(' ')[1]; }

export function tryMove(fen, uci) {
  try {
    const c = new Chess(fen);
    const m = c.move(uciToMove(uci));
    return m ? { chess: c, move: m } : null;
  } catch { return null; }
}

export function sanOf(fen, uci) {
  const r = tryMove(fen, uci);
  return r ? r.move.san : uci;
}

// Converts a UCI line to SAN list from the given FEN.
export function pvToSan(fen, pv, max = 8) {
  const out = [];
  let c;
  try { c = new Chess(fen); } catch { return out; }
  for (const u of pv.slice(0, max)) {
    try {
      const m = c.move(uciToMove(u));
      if (!m) break;
      out.push(m.san);
    } catch { break; }
  }
  return out;
}

// Material from the given colour's point of view (own - opponent), in pawns.
export function materialBalance(fen, color) {
  const board = fen.split(' ')[0];
  let w = 0, b = 0;
  for (const ch of board) {
    const v = PIECE_VALUE[ch.toLowerCase()];
    if (v === undefined) continue;
    if (ch === ch.toUpperCase()) w += v; else b += v;
  }
  return color === 'w' ? w - b : b - w;
}

export function nonPawnMaterial(fen) {
  const board = fen.split(' ')[0];
  let t = 0;
  for (const ch of board) {
    const l = ch.toLowerCase();
    if ('nbrq'.includes(l)) t += PIECE_VALUE[l];
  }
  return t;
}

// Play a principal variation and read the material once the exchanges settle.
export function settledMaterial(fen, pv, color, maxPlies = 6) {
  let c;
  try { c = new Chess(fen); } catch { return materialBalance(fen, color); }
  let value = materialBalance(fen, color);
  const moves = pv.slice(0, maxPlies);
  for (let i = 0; i < moves.length; i++) {
    let m;
    try { m = c.move(uciToMove(moves[i])); } catch { break; }
    if (!m) break;
    value = materialBalance(c.fen(), color);
    if (i >= 1) {
      const next = moves[i + 1];
      if (!next) break;
      const nm = tryMove(c.fen(), next);
      if (!nm || !nm.move.captured) break; // quiet: material has settled
    }
  }
  return value;
}

export function phaseOf(fen, ply) {
  if (nonPawnMaterial(fen) <= 26) return 'endgame';
  if (ply < 20) return 'opening';
  return 'middlegame';
}

// Lichess winning-chances curve, in [-1, 1].
export function winChance(cp) {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 2 / (1 + Math.exp(-0.00368208 * c)) - 1;
}

// Engine score (side to move) -> centipawns from White's view, mates mapped to +-1000+
export function toWhiteCp(score, fen) {
  const sign = sideToMove(fen) === 'w' ? 1 : -1;
  if (score.mate !== null && score.mate !== undefined) {
    const m = score.mate;
    const v = m > 0 ? 10000 - m * 10 : m < 0 ? -10000 - m * 10 : -10000;
    return sign * v;
  }
  return sign * (score.cp || 0);
}

export function formatEval(cpWhite) {
  if (Math.abs(cpWhite) >= 9000) {
    const n = Math.round((10000 - Math.abs(cpWhite)) / 10);
    if (n <= 0) return '#';
    return (cpWhite > 0 ? '+' : '-') + 'M' + n;
  }
  const p = cpWhite / 100;
  return (p > 0 ? '+' : '') + p.toFixed(1);
}

// FEN with the other side to move (a "null move"), used to ask "what is the threat?"
export function nullMoveFen(fen) {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  return parts.join(' ');
}

export function isCapture(fen, uci) {
  const r = tryMove(fen, uci);
  return !!(r && r.move.captured);
}
