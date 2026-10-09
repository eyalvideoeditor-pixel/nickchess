import {
  Chess, toWhiteCp, winChance, materialBalance, settledMaterial, phaseOf, sanOf, tryMove,
} from './chessutil.js';

// ---------- engine pass ----------

function terminalEval(fen) {
  let c;
  try { c = new Chess(fen); } catch { return null; }
  if (c.isCheckmate()) return { cpW: c.turn() === 'w' ? -10000 : 10000, best: null, pv: [] };
  if (c.isDraw() || c.isStalemate()) return { cpW: 0, best: null, pv: [] };
  return null;
}

// Evaluates every position of a game. evals[i] = position before ply i (evals[n] = final).
export async function analyzeGame(game, pool, depth, onStep) {
  const fens = game.plies.map((p) => p.fenBefore);
  fens.push(game.plies.length ? game.plies[game.plies.length - 1].fenAfter : game.initialFen);
  let done = 0;
  const evals = await Promise.all(fens.map(async (fen) => {
    const t = terminalEval(fen);
    if (t) { done++; onStep && onStep(done, fens.length); return t; }
    const r = await pool.evaluate(fen, { depth });
    done++; onStep && onStep(done, fens.length);
    return { cpW: toWhiteCp(r, fen), best: r.best, pv: r.pv.slice(0, 8) };
  }));
  game.evals = evals;
  game.depth = depth;
  annotateGame(game);
  return game;
}

// ---------- move classification ----------

const userWc = (cpW, color) => winChance(color === 'w' ? cpW : -cpW);
const mateFor = (cpW, color) => (color === 'w' ? cpW : -cpW) >= 9000;
const mateAgainst = (cpW, color) => (color === 'w' ? cpW : -cpW) <= -9000;

export function classify(drop) {
  if (drop >= 0.3) return 'blunder';
  if (drop >= 0.2) return 'mistake';
  if (drop >= 0.1) return 'inaccuracy';
  return 'good';
}

function moveAccuracy(wcBefore, wcAfter) {
  const wpB = 50 + 50 * wcBefore, wpA = 50 + 50 * wcAfter;
  const a = 103.1668 * Math.exp(-0.04354 * Math.max(0, wpB - wpA)) - 3.1669;
  return Math.max(0, Math.min(100, a));
}

export function annotateGame(game) {
  const { plies, evals, userColor } = game;
  const accs = [];
  const timeTroubleAt = (p) => {
    if (p.clock === null || !game.baseTime) return false;
    const limit = game.timeClass === 'bullet' ? 8 : Math.max(20, game.baseTime * 0.1);
    return p.clock < limit;
  };
  plies.forEach((p, i) => {
    const before = evals[i], after = evals[i + 1];
    const col = p.color;
    const wcB = userWc(before.cpW, col);
    const wcA = userWc(after.cpW, col);
    let drop = p.uci === before.best ? 0 : Math.max(0, wcB - wcA);
    p.wcBefore = wcB; p.wcAfter = wcA; p.drop = drop;
    p.cls = classify(drop);
    p.best = before.best;
    p.bestSan = before.best ? sanOf(p.fenBefore, before.best) : null;
    p.phase = phaseOf(p.fenBefore, i);
    if (col !== userColor) return;
    accs.push(moveAccuracy(wcB, wcA));
    p.mine = true;
    p.timeTrouble = timeTroubleAt(p);
    p.winning = wcB >= 0.5;
    p.losing = wcB <= -0.5;
    if (p.cls === 'mistake' || p.cls === 'blunder') p.type = errorType(p, before, after, col);
    else if (mateFor(before.cpW, col) && !mateFor(after.cpW, col) && before.best) p.type = 'missedMate';
  });
  game.accuracy = accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null;
  const mine = plies.filter((p) => p.mine);
  game.counts = {
    blunder: mine.filter((p) => p.cls === 'blunder').length,
    mistake: mine.filter((p) => p.cls === 'mistake').length,
    inaccuracy: mine.filter((p) => p.cls === 'inaccuracy').length,
  };
  // was the user clearly winning at some point but did not win?
  game.thrownWin = game.result !== 'win' && evals.some((e) => userWc(e.cpW, userColor) >= 0.6);
}

export function errorType(p, before, after, col) {
  if (mateAgainst(after.cpW, col) && !mateAgainst(before.cpW, col)) return 'allowedMate';
  if (mateFor(before.cpW, col) && !mateFor(after.cpW, col)) return 'missedMate';
  const matNow = materialBalance(p.fenBefore, col);
  const afterLine = settledMaterial(p.fenAfter, after.pv || [], col, 6);
  const lost = matNow - afterLine;
  if (lost >= 2) {
    const reply = after.best;
    const r = reply ? tryMove(p.fenAfter, reply) : null;
    // the punishment starts with a plain capture -> something was left en prise
    return r && r.move.captured ? 'hanging' : 'allowedTactic';
  }
  const bestLine = settledMaterial(p.fenBefore, before.pv || [], col, 7);
  if (bestLine - matNow >= 2) return 'missedTactic';
  return 'positional';
}

// ---------- profile across games ----------

export const WEAKNESS_KEYS = [
  'hanging', 'allowedTactic', 'allowedMate', 'missedTactic', 'missedMate', 'positional',
  'opening', 'endgame', 'time', 'conversion',
];

export function buildProfile(games) {
  const done = games.filter((g) => g.evals);
  const mine = done.flatMap((g) => g.plies.map((p, i) => ({ ...p, game: g, ply: i })).filter((p) => p.mine));
  const errors = mine.filter((p) => p.cls === 'mistake' || p.cls === 'blunder');
  const totalLoss = mine.reduce((s, p) => s + p.drop, 0) || 1e-9;
  const lossOf = (arr) => arr.reduce((s, p) => s + p.drop, 0);
  const n = done.length || 1;

  // every costly move is attributed to exactly one primary weakness
  const typed = mine.filter((p) => p.type); // mistakes/blunders + missed mates
  const errLoss = lossOf(typed) || 1e-9;
  const primaryOf = (p) => (p.type !== 'positional' ? p.type
    : p.phase === 'opening' ? 'opening' : p.phase === 'endgame' ? 'endgame' : 'positional');
  const bucket = {};
  for (const k of ['hanging', 'allowedTactic', 'allowedMate', 'missedTactic', 'missedMate', 'positional', 'opening', 'endgame']) {
    const list = typed.filter((p) => primaryOf(p) === k);
    bucket[k] = { count: list.length, loss: lossOf(list), share: lossOf(list) / errLoss, list };
  }
  const byType = {};
  for (const k of ['hanging', 'allowedTactic', 'allowedMate', 'missedTactic', 'missedMate', 'positional']) {
    const list = typed.filter((p) => p.type === k);
    byType[k] = { count: list.length, loss: lossOf(list), share: lossOf(list) / errLoss, list };
  }

  const phase = {};
  for (const ph of ['opening', 'middlegame', 'endgame']) {
    const list = mine.filter((p) => p.phase === ph);
    const errs = errors.filter((p) => p.phase === ph);
    phase[ph] = { moves: list.length, errors: errs.length, loss: lossOf(list), share: lossOf(list) / totalLoss, list: errs,
      errRate: list.length ? errs.length / list.length : 0 };
  }

  const ttErr = typed.filter((p) => p.timeTrouble);
  const timeouts = done.filter((g) => g.result === 'loss' && g.reason === 'timeout').length;
  const time = { errors: ttErr.length, loss: lossOf(ttErr), share: lossOf(ttErr) / errLoss, timeouts, list: ttErr };

  const winErr = typed.filter((p) => p.winning);
  const thrown = done.filter((g) => g.thrownWin);
  const conversion = { errors: winErr.length, loss: lossOf(winErr), share: lossOf(winErr) / errLoss, thrown: thrown.length, list: winErr };

  const results = { win: 0, loss: 0, draw: 0 };
  done.forEach((g) => results[g.result]++);
  const accs = done.map((g) => g.accuracy).filter((a) => a !== null);

  // Severity = share of the advantage lost in mistakes, lightly weighted: hanging pieces and
  // allowed mates are the most "trainable"; time and conversion are overlays on top of the
  // other buckets, so they only count above a baseline.
  const sev = {
    hanging: bucket.hanging.share * 1.15,
    allowedTactic: bucket.allowedTactic.share,
    allowedMate: bucket.allowedMate.share * 1.1,
    missedTactic: bucket.missedTactic.share,
    missedMate: bucket.missedMate.share * 0.9,
    positional: bucket.positional.share * 0.7,
    opening: bucket.opening.share * 0.9,
    endgame: bucket.endgame.share * 0.9,
    time: Math.max(0, time.share - 0.15) + timeouts / n * 0.6,
    conversion: Math.max(0, conversion.share - 0.2) * 0.8 + thrown.length / n * 0.4,
  };
  const ranked = WEAKNESS_KEYS
    .map((k) => ({ key: k, score: sev[k] }))
    .sort((a, b) => b.score - a.score);

  const blunderTypes = ['hanging', 'allowedTactic', 'allowedMate'];
  return {
    games: done.length,
    results,
    accuracy: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null,
    perGame: {
      blunder: mine.filter((p) => p.cls === 'blunder').length / n,
      mistake: mine.filter((p) => p.cls === 'mistake').length / n,
      inaccuracy: mine.filter((p) => p.cls === 'inaccuracy').length / n,
    },
    blunderShare: blunderTypes.reduce((s, k) => s + byType[k].share, 0),
    bucket, byType, phase, time, conversion, ranked,
    errors,
    avgRating: Math.round(done.reduce((s, g) => s + (g.me.rating || 0), 0) / n),
  };
}

// "Find a better move than the one you played" for any ply of a game.
export function fixItem(g, i) {
  const p = g.plies[i], before = g.evals[i];
  return {
    kind: 'find', mode: 'fix', fen: p.fenBefore, best: before.best, bestPv: before.pv,
    avoid: p.uci, playedSan: p.san, color: p.color, type: p.type, cls: p.cls,
    gameId: g.id, ply: i, opp: g.opp.name, moveNo: Math.floor(i / 2) + 1,
    lastMove: i > 0 ? g.plies[i - 1].uci : null,
  };
}

// Mistakes from your own games, shaped for the training session.
export function mistakeItems(games, { types = null, phases = null, mode = 'fix' } = {}) {
  const items = [];
  for (const g of games) {
    if (!g.evals) continue;
    g.plies.forEach((p, i) => {
      if (!p.mine || !(p.cls === 'mistake' || p.cls === 'blunder' || p.type === 'missedMate')) return;
      if (types && !types.includes(p.type)) return;
      if (phases && !phases.includes(p.phase)) return;
      const after = g.evals[i + 1];
      const before = g.evals[i];
      if (mode === 'fix' && before.best) items.push(fixItem(g, i));
      if (mode === 'punish' && after.best && p.type !== 'missedMate' && p.type !== 'missedTactic' && p.type !== 'positional') {
        items.push({
          kind: 'find', mode: 'punish', fen: p.fenAfter, best: after.best, bestPv: after.pv,
          avoid: null, playedSan: p.san, color: p.color === 'w' ? 'b' : 'w', type: p.type, cls: p.cls,
          gameId: g.id, ply: i, opp: g.opp.name, moveNo: Math.floor(i / 2) + 1, lastMove: p.uci,
        });
      }
    });
  }
  return items;
}

// "Safe or blunder?" judgement items: your real blunders vs. your solid moves.
export function safetyItems(games, max = 20) {
  const bad = [], good = [];
  for (const g of games) {
    if (!g.evals) continue;
    g.plies.forEach((p, i) => {
      if (!p.mine) return;
      const after = g.evals[i + 1];
      const base = { kind: 'safe', fen: p.fenBefore, move: p.uci, san: p.san, color: p.color,
        lastMove: i > 0 ? g.plies[i - 1].uci : null, opp: g.opp.name, moveNo: Math.floor(i / 2) + 1 };
      if ((p.cls === 'blunder' || p.cls === 'mistake') && ['hanging', 'allowedTactic', 'allowedMate'].includes(p.type) && after.best) {
        bad.push({ ...base, unsafe: true, refutation: after.best, refutationPv: after.pv, type: p.type,
          bestSan: p.bestSan });
      } else if (p.drop < 0.03 && i > 10 && !p.capture) {
        good.push({ ...base, unsafe: false });
      }
    });
  }
  shuffle(bad); shuffle(good);
  const nb = Math.min(bad.length, Math.ceil(max / 2));
  const out = [...bad.slice(0, nb), ...good.slice(0, max - nb)];
  return shuffle(out);
}

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
