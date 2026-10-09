import { Chess, moveToUci } from './chessutil.js';
import { CAT_INFO } from './content.js';
import { store } from './util.js';
import { shuffle } from './analysis.js';

// ---- normalisation: every puzzle becomes { id, fen, moves[], rating, themes, game } ----
// moves[0] is the opponent's move that sets the puzzle up; the solver plays moves[1], [3], ...

function fromDb(p) {
  return { id: p.id, fen: p.fen, moves: p.moves.split(' '), rating: p.rating, themes: p.themes,
    pop: p.pop, plays: p.plays, game: 'https://lichess.org/' + p.game, source: 'top' };
}

function fromApi(data) {
  const chess = new Chess();
  const sans = data.game.pgn.split(' ');
  let last = null;
  sans.forEach((san, i) => {
    if (i === sans.length - 1) {
      const fen = chess.fen();
      last = { fen, mv: chess.move(san) };
    } else chess.move(san);
  });
  return {
    id: data.puzzle.id, fen: last.fen, moves: [moveToUci(last.mv), ...data.puzzle.solution],
    rating: data.puzzle.rating, themes: data.puzzle.themes, plays: data.puzzle.plays,
    game: `https://lichess.org/${data.game.id}`, source: 'lichess',
  };
}

export function curated(cat) {
  const all = (window.TOP_PUZZLES && window.TOP_PUZZLES[cat]) || [];
  return all.map(fromDb);
}

// Puzzles for a theme, preferring the curated top list near the player's level.
export function curatedForTheme(theme, rating, n = 10) {
  const list = [];
  for (const [cat, arr] of Object.entries(window.TOP_PUZZLES || {})) {
    const info = CAT_INFO[cat];
    const catTheme = info ? info.theme : cat;
    if (catTheme !== theme && cat !== theme) continue;
    list.push(...arr.map(fromDb));
  }
  const seen = new Set();
  const uniq = list.filter((p) => !seen.has(p.id) && seen.add(p.id));
  const solved = progress().solved;
  const fresh = uniq.filter((p) => !solved[p.id]);
  const pool = fresh.length >= n ? fresh : uniq;
  if (rating) {
    const near = pool.filter((p) => p.rating >= rating - 250 && p.rating <= rating + 450);
    if (near.length >= n) return shuffle(near).slice(0, n);
  }
  return shuffle(pool).slice(0, n);
}

// anonymous Lichess requests are relative to a 1500 puzzle rating
function difficultyFor(target) {
  const d = target - 1500;
  if (d <= -450) return 'easiest';
  if (d <= -150) return 'easier';
  if (d < 150) return 'normal';
  if (d < 450) return 'harder';
  return 'hardest';
}

// Fresh puzzles straight from the Lichess API (anonymous).
export async function lichessBatch(angle, targetRating, nb = 15) {
  const diff = difficultyFor(targetRating || 1500);
  const res = await fetch(`https://lichess.org/api/puzzle/batch/${encodeURIComponent(angle)}?nb=${nb}&difficulty=${diff}`);
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return (data.puzzles || []).map(fromApi);
}

export async function dailyPuzzle() {
  const res = await fetch('https://lichess.org/api/puzzle/daily');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return fromApi(await res.json());
}

// ---- local progress: puzzle rating + solved/failed history ----

const KEY = 'ct_progress_v1';

export function progress() {
  const p = store.get(KEY) || {};
  return {
    rating: p.rating || null,
    solved: p.solved || {},     // id -> { ok, t }
    failed: p.failed || [],     // puzzle objects to repeat
    themes: p.themes || {},     // theme -> { ok, total }
    drills: p.drills || {},     // drill -> { ok, total }
    streak: p.streak || 0,
    days: p.days || {},         // yyyy-mm-dd -> count
  };
}

function save(p) { store.set(KEY, p); }

export function initRating(r) {
  const p = progress();
  if (!p.rating && r) { p.rating = Math.round(r); save(p); }
}

export function recordPuzzle(puzzle, ok) {
  const p = progress();
  const r = p.rating || 1500;
  if (puzzle.rating && !p.solved[puzzle.id]) {
    const exp = 1 / (1 + Math.pow(10, (puzzle.rating - r) / 400));
    p.rating = Math.round(r + 24 * ((ok ? 1 : 0) - exp));
  }
  p.solved[puzzle.id] = { ok, t: Date.now() };
  for (const t of puzzle.themes || []) {
    const s = p.themes[t] || { ok: 0, total: 0 };
    s.total++; if (ok) s.ok++;
    p.themes[t] = s;
  }
  p.failed = p.failed.filter((f) => f.id !== puzzle.id);
  if (!ok) p.failed.unshift({ id: puzzle.id, fen: puzzle.fen, moves: puzzle.moves, rating: puzzle.rating,
    themes: puzzle.themes, game: puzzle.game, source: puzzle.source });
  p.failed = p.failed.slice(0, 200);
  p.streak = ok ? p.streak + 1 : 0;
  bumpDay(p);
  save(p);
  return p;
}

export function recordDrill(drill, ok) {
  const p = progress();
  const s = p.drills[drill] || { ok: 0, total: 0 };
  s.total++; if (ok) s.ok++;
  p.drills[drill] = s;
  bumpDay(p);
  save(p);
}

function bumpDay(p) {
  const d = new Date().toISOString().slice(0, 10);
  p.days[d] = (p.days[d] || 0) + 1;
}

export function todayCount() {
  return progress().days[new Date().toISOString().slice(0, 10)] || 0;
}
