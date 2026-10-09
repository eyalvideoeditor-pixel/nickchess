// Game review: every move of both players gets a chess.com-style rating (with our own names)
// and a short comment explaining it.
import { h, fill, store, fmtDate, toast } from './util.js';
import { Board } from './board.js';
import { getEngine } from './engine.js';
import {
  Chess, toWhiteCp, winChance, PIECE_VALUE, tryMove, sanOf, pvToSan, formatEval, moveToUci, nullMoveFen,
} from './chessutil.js';
import { nickSays } from './nick.js';
import { maybeQuip } from './quips.js';
import { errorType } from './analysis.js';
import { REVIEW, REVIEW_ORDER } from './content.js';
import { fetchRecentGames, gameFromPgn, parseGameLink, fetchGameByLink } from './chesscom.js';

const DEPTH = 16;
const LIST_KEY = 'ct_reviews';
const memory = new Map(); // id -> game (games opened this session)

// ---------------- opening book (loaded on first use) ----------------

let openingsReady = null;
function loadOpenings() {
  if (window.OPENINGS) return Promise.resolve();
  if (!openingsReady) {
    openingsReady = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'data/openings.js';
      s.onload = resolve; s.onerror = resolve;
      document.head.append(s);
    });
  }
  return openingsReady;
}
const bookKey = (fen) => fen.split(' ').slice(0, 3).join(' ');

// ---------------- helpers ----------------

const ep = (cpW, color) => (winChance(color === 'w' ? cpW : -cpW) + 1) / 2;
const mateFor = (cpW, color) => (color === 'w' ? cpW : -cpW) >= 9000;
const whiteOf = (g) => (g.userColor === 'w' ? g.me : g.opp);
const blackOf = (g) => (g.userColor === 'w' ? g.opp : g.me);
const moveNo = (i) => `${Math.floor(i / 2) + 1}${i % 2 === 0 ? '.' : '...'}`;

function resultText(g) {
  if (g.resultText) return g.resultText;
  if (!g.result) return '*';
  if (g.result === 'draw') return '½-½';
  const whiteWon = (g.result === 'win') === (g.userColor === 'w');
  return whiteWon ? '1-0' : '0-1';
}

function moveAccuracy(epBefore, epAfter) {
  const a = 103.1668 * Math.exp(-0.04354 * Math.max(0, (epBefore - epAfter) * 100)) - 3.1669;
  return Math.max(0, Math.min(100, a));
}

// ---------------- persistence ----------------

function compactGame(g) {
  const keep = ['id', 'url', 'endTime', 'timeClass', 'timeControl', 'baseTime', 'userColor', 'me', 'opp',
    'result', 'resultText', 'reason', 'opening', 'initialFen'];
  const out = {};
  for (const k of keep) out[k] = g[k];
  out.m = g.plies.map((p) => [p.san, p.clock ?? null]);
  return out;
}

function restoreGame(d) {
  const { m, ...meta } = d;
  const chess = new Chess(meta.initialFen);
  const plies = m.map(([san, clock]) => {
    const fenBefore = chess.fen();
    const mv = chess.move(san);
    return { san: mv.san, uci: moveToUci(mv), color: mv.color, fenBefore, fenAfter: chess.fen(), clock, capture: !!mv.captured };
  });
  return { ...meta, plies };
}

function saveReview(g) {
  const data = {
    depth: g.rvDepth, game: compactGame(g),
    e: g.rvEvals.map((e) => [e.cpW, e.best || '', (e.pv || []).slice(0, 6).join(' '), e.second || '', e.secondCpW ?? null, e.legal]),
  };
  const list = (store.get(LIST_KEY) || []).filter((x) => x.id !== g.id);
  list.unshift({ id: g.id, white: whiteOf(g).name, black: blackOf(g).name, res: resultText(g), date: g.endTime, at: Date.now() });
  for (const old of list.slice(30)) store.del('ct_rv_' + old.id);
  store.set(LIST_KEY, list.slice(0, 30));
  store.set('ct_rv_' + g.id, data);
}

function loadReview(id) {
  const d = store.get('ct_rv_' + id);
  if (!d) return null;
  try {
    const g = restoreGame(d.game);
    g.rvDepth = d.depth;
    g.rvEvals = d.e.map(([cpW, best, pv, second, secondCpW, legal]) => ({
      cpW, best: best || null, pv: pv ? pv.split(' ') : [], second: second || null, secondCpW, legal,
    }));
    return g;
  } catch { return null; }
}

// ---------------- engine pass ----------------

export async function reviewGame(g, onStep) {
  await loadOpenings();
  const pool = getEngine();
  await pool.init();
  const fens = [...g.plies.map((p) => p.fenBefore), g.plies[g.plies.length - 1].fenAfter];
  let done = 0;
  g.rvEvals = await Promise.all(fens.map(async (fen) => {
    const c = new Chess(fen);
    const legal = c.moves().length;
    let res;
    if (c.isCheckmate()) res = { cpW: c.turn() === 'w' ? -10000 : 10000, best: null, pv: [], legal };
    else if (c.isDraw()) res = { cpW: 0, best: null, pv: [], legal };
    else {
      const r = await pool.evaluate(fen, { depth: DEPTH, multipv: legal > 1 ? 2 : 1 });
      const l2 = r.lines[1];
      res = {
        cpW: toWhiteCp(r, fen), best: r.best, pv: r.pv.slice(0, 8), legal,
        second: l2 && l2.pv[0] ? l2.pv[0] : null, secondCpW: l2 ? toWhiteCp(l2, fen) : null,
      };
    }
    done++;
    if (onStep) onStep(done, fens.length);
    return res;
  }));
  g.rvDepth = DEPTH;
  classifyReview(g);
  saveReview(g);
  return g;
}

// ---------------- classification ----------------

// Gives up material: after the move the opponent can win >= 2 points more than the move took.
function isSacrifice(p) {
  const took = tryMove(p.fenBefore, p.uci);
  const tookValue = took && took.move.captured ? PIECE_VALUE[took.move.captured] : 0;
  const c = new Chess(p.fenAfter);
  let worst = 0;
  for (const m of c.moves({ verbose: true })) {
    if (!m.captured || PIECE_VALUE[m.captured] < 3) continue;
    const c2 = new Chess(c.fen());
    c2.move(m);
    const recapture = c2.moves({ verbose: true }).some((x) => x.to === m.to && x.captured);
    const gain = PIECE_VALUE[m.captured] - (recapture ? PIECE_VALUE[m.piece] : 0);
    if (gain > worst) worst = gain;
  }
  return worst - tookValue >= 2;
}

export function classifyReview(g) {
  const books = window.OPENINGS || {};
  const E = g.rvEvals;
  let opening = '';
  g.plies.forEach((p, i) => {
    const before = E[i], after = E[i + 1];
    const col = p.color;
    const epB = ep(before.cpW, col), epA = ep(after.cpW, col);
    const isBest = !!before.best && p.uci === before.best;
    const loss = isBest ? 0 : Math.max(0, epB - epA);
    const rv = { epB, epA, loss, acc: moveAccuracy(epB, epA) };
    p.rv = rv;

    // book = the position after the move is on a known opening line (transpositions count too)
    const key = bookKey(p.fenAfter);
    if (i < 30 && Object.prototype.hasOwnProperty.call(books, key)) {
      if (books[key]) opening = books[key];
      rv.cls = 'book'; rv.opening = opening;
      return;
    }

    let cls;
    if (before.legal === 1) cls = 'best';
    else if (loss >= 0.20) cls = 'blunder';
    else if (loss >= 0.10) cls = 'mistake';
    else if (loss >= 0.05) cls = 'inaccuracy';
    else if (loss > 0.02) cls = 'good';
    else if (isBest || loss < 0.003) cls = 'best';
    else cls = 'excellent';

    // Miss: the opponent just erred and you handed the gift back
    if ((cls === 'mistake' || cls === 'blunder') && i > 0) {
      const prev = g.plies[i - 1].rv;
      const epBeforeGift = ep(E[i - 1].cpW, col);
      if (prev && prev.loss >= 0.10 && epA >= epBeforeGift - 0.05) cls = 'miss';
    }
    // a mate on the board that you walked past
    if (['good', 'inaccuracy', 'mistake'].includes(cls) && mateFor(before.cpW, col) && !mateFor(after.cpW, col)) {
      cls = 'miss'; rv.missedMate = true;
    }

    // Great: the only move that holds (second-best is far worse); not an obvious recapture
    if (cls === 'best' && before.legal > 1 && before.secondCpW !== null && before.secondCpW !== undefined) {
      const gap = epB - ep(before.secondCpW, col);
      const prevPly = g.plies[i - 1];
      const recapture = prevPly && prevPly.capture && p.capture && prevPly.uci.slice(2, 4) === p.uci.slice(2, 4);
      if (gap >= 0.2 && !recapture && !p.san.includes('#')) {
        cls = 'great';
        rv.secondSan = before.second ? sanOf(p.fenBefore, before.second) : null;
      }
    }

    // Brilliant: a real sacrifice that is (nearly) the best move, in a position that was not already
    // won anyway -- or a sacrifice that forces a mate no quiet move would give
    const secondIsMate = before.secondCpW !== null && before.secondCpW !== undefined && mateFor(before.secondCpW, col);
    const notWonAnyway = epB < 0.97 || (mateFor(after.cpW, col) && !secondIsMate);
    if ((cls === 'best' || cls === 'great' || cls === 'excellent') && epA >= 0.5 && notWonAnyway && isSacrifice(p)) {
      cls = 'brilliant';
    }

    if (['blunder', 'mistake', 'miss', 'inaccuracy'].includes(cls)) rv.type = errorType(p, before, after, col);
    rv.cls = cls;
  });

  const sum = { w: { counts: {}, accs: [] }, b: { counts: {}, accs: [] } };
  for (const p of g.plies) {
    const s = sum[p.color];
    s.counts[p.rv.cls] = (s.counts[p.rv.cls] || 0) + 1;
    s.accs.push(p.rv.acc);
  }
  for (const c of ['w', 'b']) {
    const a = sum[c].accs;
    sum[c].acc = a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  }
  g.rvSummary = sum;
}

// ---------------- comments ----------------

const PIECE_HE = { p: 'רגלי', n: 'פרש', b: 'רץ', r: 'צריח', q: 'מלכה', k: 'מלך' };
const PIECE_DEF = { p: 'הרגלי', n: 'הפרש', b: 'הרץ', r: 'הצריח', q: 'המלכה', k: 'המלך' };

// What the move does on the board, in words: captures, checks, development, threats, forks...
function moveFeatures(p, i) {
  const r = tryMove(p.fenBefore, p.uci);
  if (!r) return [];
  const m = r.move;
  const out = [];
  if (m.san.startsWith('O-O')) out.push('מצריח — המלך נכנס למחסה והצריח מצטרף למשחק');
  if (m.promotion) out.push(`מכתיר ל${PIECE_HE[m.promotion]}`);
  if (m.captured) out.push(`אוכל את ${PIECE_DEF[m.captured]}`);
  if (m.san.includes('#')) out.push('נותן מט');
  else if (m.san.includes('+')) out.push('נותן שח');
  const home = m.color === 'w' ? '1' : '8';
  if (i < 24 && 'nb'.includes(m.piece) && m.from[1] === home) out.push('מפתח כלי חדש');
  if (i < 14 && m.piece === 'p' && ['e4', 'd4', 'e5', 'd5', 'c4', 'c5'].includes(m.to)) out.push('תופס את המרכז');
  // threats from the piece that just moved (look as if it could move again)
  if (!m.san.includes('#')) {
    try {
      const c = new Chess(nullMoveFen(p.fenAfter));
      const hits = c.moves({ square: m.to, verbose: true }).filter((x) => x.captured && x.captured !== 'p');
      const targets = [];
      for (const x of hits) {
        const c2 = new Chess(c.fen());
        c2.move(x);
        const defended = c2.moves({ verbose: true }).some((y) => y.to === x.to);
        const worth = PIECE_VALUE[x.captured] > PIECE_VALUE[m.piece] || !defended;
        if (worth) targets.push(`${PIECE_DEF[x.captured]} ב-${x.to}`);
      }
      const check = m.san.includes('+');
      if ((check && targets.length) || targets.length >= 2) out.push(`מזלג! ${check ? 'שח ו' : ''}תוקף את ${targets.slice(0, 2).join(' ואת ')}`);
      else if (targets.length === 1) out.push(`מאיים על ${targets[0]}`);
    } catch { /* null-move positions that chess.js refuses */ }
  }
  return out;
}

function positionWords(cpW) {
  const side = cpW > 0 ? 'ללבן' : 'לשחור';
  const a = Math.abs(cpW);
  if (a >= 9000) {
    const n = Math.round((10000 - a) / 10);
    if (n <= 0) return 'המשחק נגמר במט';
    return n === 1 ? `${side} יש מט במהלך אחד` : `${side} יש מט בעוד ${n} מהלכים`;
  }
  if (a < 60) return 'העמדה שקולה';
  if (a < 150) return `${side} יתרון קטן`;
  if (a < 400) return `${side} יתרון ברור`;
  return `${side} עמדה מנצחת`;
}

const REVIEW_MOOD = {
  brilliant: 'proud', great: 'excited', best: 'happy', excellent: 'happy', good: 'calm', book: 'calm',
  inaccuracy: 'thinking', mistake: 'sad', miss: 'hungry', blunder: 'shocked',
};

const OPENERS = {
  brilliant: ['הב הב!! שבותה!', 'וואו! מהלך של אלופים — שבותה!'],
  great: ['ניק! מהלך כזה מגיע לו עצם.', 'ניק! מצאת את המהלך היחיד.'],
  best: ['זה הכי טוב!', 'זה הכי טוב — בדיוק מה שאני הייתי משחק.'],
  excellent: ['זה מגניב.', 'זה מגניב, כמעט מושלם.'],
  good: ['לא רע.', 'לא רע בכלל.'],
  book: ['למדת חבוב!', 'למדת חבוב — תאוריה.'],
  inaccuracy: ['לא ככה...', 'לא ככה, חבר.'],
  mistake: ['אידיוט!', 'אידיוט... זה עלה ביוקר.'],
  miss: ['יא עיוור!', 'יא עיוור! היה שם משהו.'],
  blunder: ['אוטיסט!!', 'אוטיסט!! הב הב, מה עשית?'],
};

// What Nick says about move i: verdict, what the move does, why, and what happened
function comment(g, i) {
  const p = g.plies[i], rv = p.rv;
  const before = g.rvEvals[i], after = g.rvEvals[i + 1];
  const bestSan = before.best ? sanOf(p.fenBefore, before.best) : null;
  const bestLine = before.best ? pvToSan(p.fenBefore, before.pv, 5).join(' ') : '';
  const replySan = after.best ? sanOf(p.fenAfter, after.best) : null;
  const replyLine = after.best ? pvToSan(p.fenAfter, after.pv, 5).join(' ') : '';
  const prev = i > 0 ? g.plies[i - 1] : null;
  const who = p.color === 'w' ? 'הלבן' : 'השחור';
  const opener = OPENERS[rv.cls][i % OPENERS[rv.cls].length];
  const feats = moveFeatures(p, i);
  const does = feats.length ? `${p.san} ${feats.join(', ')}.` : '';
  const out = [opener];
  const why = () => {
    if (rv.type === 'hanging' && replySan) return `הבעיה: אחרי ${p.san} היריב פשוט אוכל — ${replySan}.`;
    if (rv.type === 'allowedTactic' && replySan) return `הבעיה: זה נותן ליריב את ${replySan}, והוא זוכה בחומר.`;
    if (rv.type === 'allowedMate') return `הבעיה: זה מאפשר מט! ${replyLine}`;
    if (rv.type === 'missedMate') return `היה לך מט: ${bestLine}`;
    if (rv.type === 'missedTactic' && bestSan) return `${bestSan} היה זוכה בחומר.`;
    return `העמדה של ${who} נהייתה גרועה בהרבה.`;
  };
  switch (rv.cls) {
    case 'brilliant':
      out.push(`${p.san} נותן חומר — ובכל זאת זה בדיוק המהלך הנכון${feats.length ? ': ' + feats.join(', ') : ''}.`);
      break;
    case 'great':
      out.push(`זה המהלך היחיד שמחזיק את העמדה.${rv.secondSan ? ` האפשרות הבאה, ${rv.secondSan}, גרועה בהרבה.` : ''} ${does}`);
      break;
    case 'best':
      out.push(before.legal === 1 ? 'מהלך כפוי — לא הייתה ברירה.' : `${does || 'בדיוק המהלך של המנוע.'}`);
      break;
    case 'excellent':
      out.push(`${does} המנוע מעדיף טיפה את ${bestSan}, אבל זה כמעט אותו דבר.`);
      break;
    case 'good':
      out.push(`${does} מהלך סביר, אבל ${bestSan} היה קצת יותר חזק.`);
      break;
    case 'book':
      out.push(rv.opening ? `מהלך מוכר מהתאוריה: ${rv.opening}.` : 'מהלך פתיחה מוכר.');
      if (does) out.push(does);
      break;
    case 'inaccuracy':
      out.push(`${does} לא מדויק — ${bestSan} היה טוב יותר.`);
      break;
    case 'mistake':
      out.push(why(), `עדיף היה ${bestSan}.`);
      break;
    case 'miss':
      if (rv.missedMate || mateFor(before.cpW, p.color)) out.push(`היה מט על הלוח: ${bestLine} — ופספסת אותו.`);
      else out.push(`היריב טעה ב-${prev ? prev.san : 'מהלך הקודם'}, ו-${bestSan} היה מעניש אותו. פספסת את ההזדמנות.`);
      break;
    case 'blunder':
      out.push(why(), `עדיף היה ${bestSan}.`);
      break;
    default:
  }
  // a dog line now and then (Nick and his sausages)
  const QUIP_KIND = { brilliant: 'great', great: 'great', best: 'great', excellent: 'good', good: 'good',
    inaccuracy: 'bad', mistake: 'bad', blunder: 'bad', miss: 'hungry' };
  const extra = QUIP_KIND[rv.cls] ? maybeQuip(QUIP_KIND[rv.cls], rv.cls === 'best' ? 0.3 : 0.55) : '';
  if (extra) out.push(extra);
  // what happened: the position before vs. after, in words
  const wBefore = positionWords(before.cpW), wAfter = positionWords(after.cpW);
  out.push(wBefore === wAfter ? `המצב: ${wAfter}.` : `לפני המהלך: ${wBefore}. עכשיו: ${wAfter}.`);
  return out.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// ---------------- UI: home ----------------

export function renderReviewHome(v, ctx) {
  const linkInput = h('input', { type: 'text', dir: 'ltr', placeholder: 'https://www.chess.com/game/live/...  או  https://lichess.org/...' });
  const pgnArea = h('textarea', { dir: 'ltr', rows: 6, placeholder: '[Event "..."]\n1. e4 e5 2. Nf3 ...' });
  const userInput = h('input', { type: 'text', dir: 'ltr', placeholder: 'שם משתמש ב-chess.com', value: ctx.username || '' });
  const status = h('div', { class: 'review-status' });
  const recentBox = h('div', { class: 'game-list' });

  const openGame = (g) => {
    memory.set(g.id, g);
    location.hash = '#/review/' + encodeURIComponent(g.id);
  };
  const fail = (e) => {
    const msg = {
      NOT_FOUND: 'לא מצאתי את המשחק.', VARIANT: 'אפשר לנתח רק שחמט רגיל (לא 960 או וריאנטים).',
      NO_MOVES: 'לא מצאתי מהלכים ב-PGN.', RATE_LIMIT: 'השרת מגביל בקשות — נסה שוב בעוד דקה.',
    }[e.message] || 'משהו השתבש: ' + e.message;
    fill(status, h('div', { class: 'msg bad' }, msg));
  };

  const byLink = async (e) => {
    e.preventDefault();
    const link = parseGameLink(linkInput.value);
    if (!link) return fill(status, h('div', { class: 'msg bad' }, 'זה לא נראה כמו קישור למשחק ב-chess.com או ב-Lichess.'));
    fill(status, h('div', { class: 'loading' }, 'מביא את המשחק...'));
    try { openGame(await fetchGameByLink(link, ctx.username)); } catch (err) { fail(err); }
  };
  const byPgn = (e) => {
    e.preventDefault();
    try { openGame(gameFromPgn(pgnArea.value, { username: ctx.username })); } catch (err) { fail(err); }
  };
  const listGames = (games) => fill(recentBox, games.map((g) => h('button', { class: 'game-row card', onclick: () => openGame(g) },
    h('span', { class: 'res ' + g.result }, { win: 'ניצחון', loss: 'הפסד', draw: 'תיקו' }[g.result] || ''),
    h('span', { class: 'gr-main' },
      h('b', {}, h('bdi', {}, whiteOf(g).name), ' – ', h('bdi', {}, blackOf(g).name)),
      h('span', { class: 'muted small' }, fmtDate(g.endTime), g.opening ? ' · ' : '', g.opening ? h('bdi', {}, g.opening) : null)),
    store.get('ct_rv_' + g.id) ? h('span', { class: 'chip small' }, 'נותח') : null)));
  const byUser = async (e) => {
    e.preventDefault();
    const u = userInput.value.trim().toLowerCase();
    if (!u) return;
    if (ctx.games.length && ctx.username === u) return listGames(ctx.games);
    fill(recentBox, h('div', { class: 'loading' }, 'מביא משחקים...'));
    try { listGames(await fetchRecentGames(u, { count: 25 })); } catch (err) {
      fill(recentBox, h('div', { class: 'msg bad' }, err.message === 'NOT_FOUND' ? 'לא מצאתי משתמש כזה.' : 'לא הצלחתי להביא משחקים.'));
    }
  };

  const saved = store.get(LIST_KEY) || [];
  fill(v,
    h('div', { class: 'page-head' },
      h('h2', {}, 'מנתח משחקים'),
      h('p', { class: 'muted' }, 'כל מהלך — של שני השחקנים — מקבל ציון לפי שיטת הדירוג של chess.com, עם הסבר קצר. רק עם שמות טובים יותר:')),
    h('div', { class: 'legend' }, REVIEW_ORDER.map((k) => h('span', { class: 'legend-item', title: REVIEW[k].desc }, icon(k), REVIEW[k].label))),
    h('div', { class: 'grid2 review-inputs' },
      h('form', { class: 'card', onsubmit: byLink },
        h('h3', {}, 'קישור למשחק'),
        h('p', { class: 'muted small' }, 'משחק מ-chess.com (live או daily) או מ-Lichess.'),
        linkInput,
        h('button', { class: 'btn primary', type: 'submit' }, 'נתח את המשחק')),
      h('form', { class: 'card', onsubmit: byPgn },
        h('h3', {}, 'או הדבק PGN'),
        pgnArea,
        h('button', { class: 'btn primary', type: 'submit' }, 'נתח'))),
    status,
    h('section', { class: 'card' },
      h('form', { class: 'row', onsubmit: byUser },
        h('h3', { style: { margin: 0 } }, 'המשחקים האחרונים של'), userInput,
        h('button', { class: 'btn', type: 'submit' }, 'הצג')),
      recentBox),
    saved.length ? h('section', { class: 'card' },
      h('h3', {}, 'ניתוחים אחרונים'),
      h('div', { class: 'game-list' }, saved.map((s) => h('a', { class: 'game-row card', href: '#/review/' + encodeURIComponent(s.id) },
        h('span', { class: 'chip small' }, s.res),
        h('span', { class: 'gr-main' }, h('b', {}, h('bdi', {}, s.white), ' – ', h('bdi', {}, s.black)),
          h('span', { class: 'muted small' }, s.date ? fmtDate(s.date) : '')))))) : null);
  if (ctx.games.length) listGames(ctx.games);
}

function icon(cls, big = false) {
  const R = REVIEW[cls];
  return h('i', { class: 'rv-ic' + (big ? ' big' : ''), style: { background: R.color }, title: R.label }, R.sym);
}

// ---------------- UI: one game ----------------

export async function renderReviewGame(v, id, ctx, startPly = 0) {
  let g = memory.get(id) || ctx.games.find((x) => x.id === id) || null;
  const saved = loadReview(id);
  if (saved && (!g || saved.rvDepth >= DEPTH)) g = saved;
  if (!g) {
    fill(v, h('div', { class: 'card center' }, h('h2', {}, 'המשחק לא נמצא'), h('a', { class: 'btn primary', href: '#/review' }, 'למנתח המשחקים')));
    return;
  }
  if (!g.rvEvals || g.rvDepth < DEPTH) {
    const bar = h('div', {});
    const txt = h('span', {}, 'מכין את המנוע...');
    fill(v, h('div', { class: 'card center review-progress' },
      h('h2', {}, h('bdi', {}, whiteOf(g).name), ' – ', h('bdi', {}, blackOf(g).name)),
      h('p', { class: 'muted' }, `Stockfish 18 בודק כל מהלך (עומק ${DEPTH}, שתי האפשרויות הכי טובות בכל עמדה)`),
      h('div', { class: 'progress' }, h('div', { class: 'progress-text' }, txt), h('div', { class: 'bar' }, bar))));
    try {
      await reviewGame(g, (d, n) => { txt.textContent = `${d} / ${n} עמדות`; bar.style.width = (d / n * 100).toFixed(1) + '%'; });
    } catch (e) {
      console.error(e);
      fill(v, h('div', { class: 'card center' }, h('div', { class: 'msg bad' }, 'הניתוח נכשל: ' + e.message)));
      return;
    }
    if (!location.hash.startsWith('#/review/')) return; // user navigated away meanwhile
  } else {
    await loadOpenings();
    classifyReview(g);
  }
  memory.set(g.id, g);
  drawGame(v, g, ctx, startPly);
}

function drawGame(v, g, ctx, startPly) {
  let cur = 0;
  let orient = g.userColor;
  let showBest = false;
  const n = g.plies.length;
  const boardEl = h('div', { class: 'cg-wrap board' });
  const badge = h('div', { class: 'rv-badge hidden' });
  const evalFill = h('div', { class: 'eval-fill' });
  const evalTxt = h('div', { class: 'eval-txt' });
  const evalBar = h('div', { class: 'eval-bar' }, evalFill, evalTxt);
  const nick = nickSays('', { className: 'review-nick' });
  const coachHead = h('div', { class: 'coach-head' });
  const coachBtns = h('div', { class: 'row' });
  const coach = h('div', { class: 'coach' }, coachHead, nick, coachBtns);
  const moves = h('div', { class: 'moves rv-moves', dir: 'ltr' });
  const graph = h('div', { class: 'graph' });
  let board;

  const W = whiteOf(g), B = blackOf(g), S = g.rvSummary;
  const summary = h('div', { class: 'rv-summary' },
    h('div', { class: 'rv-row head' }, h('span', {}), h('b', { dir: 'auto' }, W.name), h('b', { dir: 'auto' }, B.name)),
    h('div', { class: 'rv-row acc' }, h('span', {}, 'דיוק'),
      h('span', { class: 'acc-box w' }, S.w.acc !== null ? S.w.acc.toFixed(1) : '—'),
      h('span', { class: 'acc-box b' }, S.b.acc !== null ? S.b.acc.toFixed(1) : '—')),
    REVIEW_ORDER.map((k) => h('div', { class: 'rv-row' },
      h('span', { class: 'rv-name' }, icon(k), REVIEW[k].label),
      h('span', { class: 'rv-cnt', style: { color: REVIEW[k].color } }, S.w.counts[k] || 0),
      h('span', { class: 'rv-cnt', style: { color: REVIEW[k].color } }, S.b.counts[k] || 0))));

  const fixItems = (indices) => indices.filter((i) => g.rvEvals[i].best).map((i) => {
    const p = g.plies[i];
    return {
      kind: 'find', mode: 'fix', fen: p.fenBefore, best: g.rvEvals[i].best, bestPv: g.rvEvals[i].pv,
      avoid: p.uci, playedSan: p.san, color: p.color, type: p.rv.type, cls: p.rv.cls,
      gameId: g.id, ply: i, opp: (p.color === 'w' ? B : W).name, moveNo: Math.floor(i / 2) + 1,
      lastMove: i > 0 ? g.plies[i - 1].uci : null, gameUrl: g.url,
    };
  });
  const badOf = (color) => g.plies.map((p, i) => i).filter((i) => g.plies[i].color === color
    && ['blunder', 'mistake', 'miss'].includes(g.plies[i].rv.cls));

  function placeBadge(p) {
    if (!p) { badge.classList.add('hidden'); return; }
    const R = REVIEW[p.rv.cls];
    const sq = p.uci.slice(2, 4);
    let f = sq.charCodeAt(0) - 97, r = 8 - Number(sq[1]);
    if (orient === 'b') { f = 7 - f; r = 7 - r; }
    badge.classList.remove('hidden');
    badge.style.left = ((f + 1) * 12.5) + '%';
    badge.style.top = (r * 12.5) + '%';
    badge.style.background = R.color;
    badge.textContent = R.sym;
  }

  function show(k, speak = true) {
    cur = Math.max(0, Math.min(n, k));
    // remember the move in the URL (so coming back from a drill lands on the same move)
    history.replaceState(null, '', `#/review/${encodeURIComponent(g.id)}/${cur}`);
    const p = cur > 0 ? g.plies[cur - 1] : null;
    const showingBest = showBest && p && p.rv.cls !== 'best' && p.rv.cls !== 'book' && g.rvEvals[cur - 1].best;
    const fen = showingBest ? p.fenBefore : (p ? p.fenAfter : g.initialFen);
    board.set(fen, { orientation: orient, lastMove: showingBest ? null : (p ? p.uci : null) });
    if (showingBest) {
      board.arrows([{ uci: p.uci, brush: 'red' }, { uci: g.rvEvals[cur - 1].best, brush: 'green' }]);
      placeBadge(null);
    } else placeBadge(p);
    const e = g.rvEvals[showingBest ? cur - 1 : cur];
    evalFill.style.height = ((winChance(e.cpW) + 1) / 2 * 100).toFixed(1) + '%';
    evalTxt.textContent = formatEval(e.cpW);
    evalBar.classList.toggle('flip', orient === 'b');

    if (!p) {
      fill(coachHead, h('b', {}, 'סיכום המשחק'));
      nick.setContent([
        h('p', {}, `היי, אני ניק! עברתי על כל ${n} המהלכים של המשחק.`),
        h('p', {}, 'לחץ ▶ (או חץ ימינה) ואני אגיד לך מה אני חושב על כל מהלך — למה הוא טוב, למה הוא גרוע, ומה קרה.'),
      ], speak, 'happy');
      fill(coachBtns);
    } else {
      const R = REVIEW[p.rv.cls];
      const before = g.rvEvals[cur - 1], after = g.rvEvals[cur];
      const canFix = ['blunder', 'mistake', 'miss', 'inaccuracy'].includes(p.rv.cls) && before.best;
      fill(coachHead, icon(p.rv.cls, true),
        h('div', {},
          h('div', { class: 'coach-move', dir: 'ltr' }, `${moveNo(cur - 1)} ${p.san}`),
          h('div', { class: 'coach-label', style: { color: R.color } }, R.label)));
      nick.setContent([
        ...comment(g, cur - 1).map((t) => h('p', {}, t)),
        h('div', { class: 'muted small no-speak', dir: 'rtl' }, 'הערכה: ', h('bdi', {}, formatEval(before.cpW)), ' ← ', h('bdi', {}, formatEval(after.cpW))),
      ], speak, REVIEW_MOOD[p.rv.cls] || 'calm');
      fill(coachBtns,
        canFix || (p.rv.cls === 'good' || p.rv.cls === 'excellent') ? h('button', {
          class: 'btn small' + (showingBest ? ' primary' : ''), onclick: () => { showBest = !showBest; show(cur, false); },
        }, showingBest ? 'חזרה למהלך' : 'הראה את הכי טוב') : null,
        canFix ? h('button', { class: 'btn small', onclick: () => ctx.startSession({
          title: 'נסה שוב', subtitle: `${moveNo(cur - 1)} ${p.san}`, items: fixItems([cur - 1]), drill: 'fix',
        }) }, '🔧 נסה שוב') : null);
    }
    moves.querySelectorAll('.mv').forEach((el) => el.classList.toggle('cur', Number(el.dataset.i) === cur - 1));
    const curEl = moves.querySelector('.mv.cur');
    if (curEl) curEl.scrollIntoView({ block: 'nearest' });
    const cursor = graph.querySelector('.cursor');
    if (cursor) { cursor.setAttribute('x1', xOf(cur)); cursor.setAttribute('x2', xOf(cur)); }
  }

  // move list
  for (let i = 0; i < n; i += 2) {
    const row = h('div', { class: 'mrow' }, h('span', { class: 'mn' }, Math.floor(i / 2) + 1 + '.'));
    for (const j of [i, i + 1]) {
      const p = g.plies[j];
      if (!p) { row.append(h('span', { class: 'mv empty' })); continue; }
      row.append(h('span', { class: 'mv rv-' + p.rv.cls, 'data-i': j, onclick: () => { showBest = false; show(j + 1); } },
        icon(p.rv.cls), p.san));
    }
    moves.append(row);
  }

  // eval graph with the notable moves marked
  const GW = 600, GH = 110, span = n || 1;
  const xOf = (i) => (i / span * GW).toFixed(1);
  const yOf = (cpW) => ((1 - (winChance(cpW) + 1) / 2) * GH).toFixed(1);
  const pts = g.rvEvals.map((e, i) => `${xOf(i)},${yOf(e.cpW)}`).join(' ');
  const notable = ['brilliant', 'great', 'miss', 'mistake', 'blunder'];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${GW} ${GH}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = `<rect width="${GW}" height="${GH}" class="g-bg"/>
    <polygon points="0,${GH} ${pts} ${GW},${GH}" class="g-area"/>
    <line x1="0" x2="${GW}" y1="${GH / 2}" y2="${GH / 2}" class="g-mid"/>
    <line class="cursor" x1="0" x2="0" y1="0" y2="${GH}"/>` +
    g.plies.map((p, i) => (notable.includes(p.rv.cls)
      ? `<circle cx="${xOf(i + 1)}" cy="${yOf(g.rvEvals[i + 1].cpW)}" r="4.5" fill="${REVIEW[p.rv.cls].color}" class="g-dot" data-i="${i}"/>` : '')).join('');
  svg.addEventListener('click', (e) => {
    showBest = false;
    const dot = e.target.closest('circle');
    if (dot) return show(Number(dot.dataset.i) + 1);
    const r = svg.getBoundingClientRect();
    show(Math.round((e.clientX - r.left) / r.width * span));
  });
  graph.append(svg);

  const step = (d) => { showBest = false; show(cur + d); };
  const nav = h('div', { class: 'nav-btns', dir: 'ltr' },
    h('button', { class: 'btn small', onclick: () => { showBest = false; show(0); } }, '⏮'),
    h('button', { class: 'btn small', onclick: () => step(-1) }, '◀'),
    h('button', { class: 'btn small', onclick: () => step(1) }, '▶'),
    h('button', { class: 'btn small', onclick: () => { showBest = false; show(n); } }, '⏭'),
    h('button', { class: 'btn small', title: 'הפוך לוח', onclick: () => { orient = orient === 'w' ? 'b' : 'w'; show(cur, false); } }, '⇅'));

  // whose mistakes to drill: yours if you are one of the players, otherwise offer both sides
  const known = ctx.username && [W.name, B.name].some((x) => x.toLowerCase() === ctx.username);
  const drillSides = (known ? [g.userColor] : ['w', 'b']).map((c) => ({ c, idx: badOf(c), name: (c === 'w' ? W : B).name }))
    .filter((s) => s.idx.length);
  fill(v,
    h('div', { class: 'page-head row-between' },
      h('div', {},
        h('h2', {}, h('bdi', {}, W.name), W.rating ? h('span', { class: 'muted' }, ` (${W.rating})`) : null,
          ' – ', h('bdi', {}, B.name), B.rating ? h('span', { class: 'muted' }, ` (${B.rating})`) : null,
          h('span', { class: 'chip' }, resultText(g))),
        h('div', { class: 'muted small' }, g.endTime ? fmtDate(g.endTime) : '', g.opening ? ' · ' : '', g.opening ? h('bdi', {}, g.opening) : null)),
      h('div', { class: 'row' },
        drillSides.map((s) => h('button', { class: 'btn' + (known ? ' primary' : ''), onclick: () => ctx.startSession({
          title: 'תקן את הטעויות', subtitle: s.name, items: fixItems(s.idx), drill: 'fix',
        }) }, `🔧 ${s.idx.length} הטעויות של `, h('bdi', {}, s.name))),
        g.url ? h('a', { class: 'btn ghost', href: g.url, target: '_blank', rel: 'noopener' }, 'למשחק המקורי ↗') : null,
        h('a', { class: 'btn ghost', href: '#/review' }, 'משחק אחר'))),
    h('div', { class: 'viewer review' },
      h('div', { class: 'board-col' },
        h('div', { class: 'board-with-eval', dir: 'ltr' }, evalBar, h('div', { class: 'board-box' }, boardEl, badge)),
        nav, graph),
      h('div', { class: 'side card' }, coach, summary, moves)));

  const onKey = (e) => {
    if (!document.body.contains(moves)) { document.removeEventListener('keydown', onKey); return; }
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);
  board = new Board(boardEl);
  show(startPly, startPly > 0);
}
