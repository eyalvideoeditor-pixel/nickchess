import { h, $, fill, store, pct, fmtDate, toast } from './util.js';
import { getEngine } from './engine.js';
import { fetchRecentGames, fetchProfile } from './chesscom.js';
import { analyzeGame, annotateGame, buildProfile, mistakeItems, safetyItems, shuffle, fixItem } from './analysis.js';
import { Chess, moveToUci, formatEval, winChance, pvToSan, tryMove, sideToMove } from './chessutil.js';
import { Board } from './board.js';
import { Session } from './trainer.js';
import {
  WEAKNESS, DRILLS, ERROR_TYPE_LABEL, CLS_LABEL, CLS_MARK, PHASE_LABEL, RESULT_LABEL,
  TIME_CLASS_LABEL, REASON_LABEL, PUZZLE_GROUPS, catTitle, themeName, CAT_INFO,
} from './content.js';
import { curated, curatedForTheme, lichessBatch, dailyPuzzle, progress, initRating } from './puzzles.js';
import { renderReviewHome, renderReviewGame } from './review.js';
import { renderOpenings } from './openings.js';
import { renderChat } from './chat.js';
import { quip } from './quips.js';
import { nickSays, voice, voiceToggle, NICK_FULL } from './nick.js';
import { OPENINGS, OPENING_ORDER, lineProgress } from './openings-data.js';

const GAME_COUNT = 25;
const IS_PHONE = matchMedia('(max-width: 640px)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);
const DEPTHS = { fast: 12, normal: 15, deep: 18 };
const DEPTH_LABEL = { fast: 'מהיר', normal: 'רגיל', deep: 'מעמיק' };

const S = {
  username: null, timeClass: 'all', depthKey: IS_PHONE ? 'fast' : 'normal',
  games: [], profile: null, player: null,
  analyzing: false, progress: null, focus: null,
  session: null, returnTo: '#/report',
};

const view = () => $('#view');

// ---------------- persistence (compact) ----------------

function serializeGame(g) {
  const { plies, evals, ...meta } = g;
  delete meta.counts; delete meta.accuracy; delete meta.thrownWin;
  return {
    ...meta,
    m: plies.map((p) => [p.san, p.clock]),
    e: evals.map((e) => [e.cpW, e.best || '', (e.pv || []).join(' ')]),
  };
}

function deserializeGame(d) {
  const { m, e, ...meta } = d;
  const chess = new Chess(meta.initialFen);
  const plies = [];
  for (const [san, clock] of m) {
    const fenBefore = chess.fen();
    const mv = chess.move(san);
    plies.push({ san: mv.san, uci: moveToUci(mv), color: mv.color, fenBefore, fenAfter: chess.fen(), clock, capture: !!mv.captured });
  }
  const g = { ...meta, plies, evals: e.map(([cpW, best, pv]) => ({ cpW, best: best || null, pv: pv ? pv.split(' ') : [] })) };
  annotateGame(g);
  return g;
}

const gameKey = (id) => 'ct_g_' + id;
const listKey = (u, tc) => `ct_u_${u}_${tc}`;

function cachedGame(id, depth) {
  const d = store.get(gameKey(id));
  if (!d || d.depth < depth) return null;
  try { return deserializeGame(d); } catch { return null; }
}

function saveGame(g) {
  if (!store.set(gameKey(g.id), { ...serializeGame(g), savedAt: Date.now() })) {
    // storage full: drop the oldest analysed games and retry once
    const keys = store.keys('ct_g_').map((k) => [k, (store.get(k) || {}).savedAt || 0]).sort((a, b) => a[1] - b[1]);
    keys.slice(0, Math.ceil(keys.length / 3)).forEach(([k]) => store.del(k));
    store.set(gameKey(g.id), { ...serializeGame(g), savedAt: Date.now() });
  }
}

function restoreLast() {
  const last = store.get('ct_last');
  if (!last) return;
  Object.assign(S, { username: last.username, timeClass: last.timeClass || 'all', depthKey: last.depthKey || 'normal' });
  S.player = last.player || null;
  const list = store.get(listKey(last.username, S.timeClass));
  if (!list) return;
  S.games = list.ids.map((id) => cachedGame(id, 0)).filter(Boolean);
  if (S.games.length) S.profile = buildProfile(S.games);
}

// ---------------- analysis flow ----------------

async function runAnalysis(username, timeClass, depthKey) {
  if (S.analyzing) return;
  const depth = DEPTHS[depthKey];
  const prev = { username: S.username, timeClass: S.timeClass, depthKey: S.depthKey, games: S.games, profile: S.profile, player: S.player };
  Object.assign(S, { username: username.trim().toLowerCase(), timeClass, depthKey, analyzing: true, games: [], profile: null });
  S.progress = { stage: 'fetch', text: 'מתחבר ל-chess.com...', done: 0, total: 1, gameIdx: 0 };
  render();
  try {
    let player = null;
    try {
      const { profile, stats } = await fetchProfile(S.username);
      player = {
        name: profile.username || S.username, avatar: profile.avatar || null, url: profile.url,
        ratings: {
          rapid: stats.chess_rapid && stats.chess_rapid.last && stats.chess_rapid.last.rating,
          blitz: stats.chess_blitz && stats.chess_blitz.last && stats.chess_blitz.last.rating,
          bullet: stats.chess_bullet && stats.chess_bullet.last && stats.chess_bullet.last.rating,
        },
      };
    } catch (e) {
      if (e.message === 'NOT_FOUND') throw new Error('לא מצאתי משתמש בשם הזה ב-chess.com');
    }
    S.player = player;
    const games = await fetchRecentGames(S.username, {
      count: GAME_COUNT, timeClass,
      onProgress: (url) => { S.progress.text = 'מוריד משחקים — ' + url.split('/').slice(-2).reverse().join('/'); renderProgress(); },
    });
    if (!games.length) throw new Error('לא נמצאו משחקים' + (timeClass !== 'all' ? ' בקצב הזה' : ''));
    store.set('ct_last', { username: S.username, timeClass, depthKey, player });
    store.set(listKey(S.username, timeClass), { ids: games.map((g) => g.id), at: Date.now() });

    const pool = getEngine();
    S.progress = { stage: 'engine', text: 'טוען את Stockfish 18...', done: 0, total: 1, gameIdx: 0, games: games.length };
    renderProgress();
    await pool.init();

    const totalPos = games.reduce((s, g) => s + g.plies.length + 1, 0);
    const t0 = Date.now();
    let doneBase = 0;
    S.progress = { stage: 'analyze', text: '', done: 0, total: totalPos, gameIdx: 0, games: games.length, t0 };
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      S.progress.gameIdx = i;
      S.progress.text = `משחק ${i + 1} מתוך ${games.length}: נגד ${g.opp.name}`;
      const cached = cachedGame(g.id, depth);
      if (cached) {
        S.games.push(cached);
      } else {
        await analyzeGame(g, pool, depth, (d) => { S.progress.done = doneBase + d; renderProgress(); });
        saveGame(g);
        S.games.push(g);
      }
      doneBase += g.plies.length + 1;
      S.progress.done = doneBase;
      renderProgress();
    }
    S.profile = buildProfile(S.games);
    initRating(seedPuzzleRating());
    S.analyzing = false;
    S.progress = null;
    location.hash = '#/report';
    render();
  } catch (e) {
    console.error(e);
    if (!S.games.length) Object.assign(S, prev); // keep the previous report on failure
    S.analyzing = false;
    S.progress = { stage: 'error', text: e.message === 'RATE_LIMIT' ? 'chess.com מגביל בקשות כרגע. נסה שוב בעוד דקה.' : (e.message || 'שגיאה') };
    render();
  }
}

function seedPuzzleRating() {
  const r = S.profile ? S.profile.avgRating : 1200;
  return Math.max(800, Math.min(2600, (r || 1200) + 300));
}

function targetRating() {
  return progress().rating || seedPuzzleRating();
}

// What Nick (the chat coach) knows about the player
function profileText() {
  const lines = [];
  const p = progress();
  if (S.username) lines.push(`chess.com username: ${S.player ? S.player.name : S.username}`);
  if (S.player) {
    const r = Object.entries(S.player.ratings).filter(([, x]) => x).map(([k, x]) => `${k} ${x}`).join(', ');
    if (r) lines.push(`Ratings: ${r}`);
  }
  const P = S.profile;
  if (P) {
    lines.push(`Analysed last ${P.games} games${S.timeClass !== 'all' ? ` (${S.timeClass})` : ''}: ${P.results.win} wins, ${P.results.loss} losses, ${P.results.draw} draws.`);
    if (P.accuracy !== null) lines.push(`Average accuracy: ${Math.round(P.accuracy)}%.`);
    lines.push(`Per game: ${P.perGame.blunder.toFixed(1)} blunders, ${P.perGame.mistake.toFixed(1)} mistakes, ${P.perGame.inaccuracy.toFixed(1)} inaccuracies.`);
    const buckets = Object.entries(P.bucket).filter(([, b]) => b.count).sort((a, b) => b[1].share - a[1].share)
      .map(([k, b]) => `${WEAKNESS[k].title} (${k}): ${b.count} cases, ${Math.round(b.share * 100)}% of the advantage lost in mistakes`);
    if (buckets.length) lines.push('Where the lost advantage went:\n- ' + buckets.join('\n- '));
    lines.push(`Recommended first focus: ${WEAKNESS[P.ranked[0].key].title}.`);
    lines.push(`Errors by phase: opening ${P.phase.opening.errors}, middlegame ${P.phase.middlegame.errors}, endgame ${P.phase.endgame.errors}. Errors in time trouble: ${P.time.errors}, losses on time: ${P.time.timeouts}. Winning positions not converted: ${P.conversion.thrown}.`);
    const openings = {};
    for (const g of S.games) if (g.opening) openings[g.opening] = (openings[g.opening] || 0) + 1;
    const top = Object.entries(openings).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([o, c]) => `${o} (${c})`);
    if (top.length) lines.push(`Most played openings: ${top.join(', ')}.`);
  }
  if (p.rating) lines.push(`Puzzle rating on this site: ${p.rating}.`);
  const studied = OPENING_ORDER.map((k) => {
    const done = OPENINGS[k].lines.filter((l) => lineProgress(k, l.id).total > 0).length;
    return done ? `${OPENINGS[k].en} ${done}/${OPENINGS[k].lines.length} lines` : null;
  }).filter(Boolean);
  if (studied.length) lines.push(`Openings studied on the site: ${studied.join(', ')}.`);
  return lines.join('\n');
}

// ---------------- layout ----------------

// [link, label, short label for phones]
const TABS = [
  ['#/', 'ניתוח', 'ניתוח'], ['#/report', 'הדוח שלי', 'הדוח'], ['#/games', 'המשחקים', 'משחקים'],
  ['#/review', 'מנתח משחקים', 'מנתח'], ['#/train', 'אימון', 'אימון'], ['#/openings', 'פתיחות', 'פתיחות'],
  ['#/puzzles', 'חידות מובחרות', 'חידות'], ['#/chat', 'צ׳אט עם ניק 🐶', 'ניק 🐶'],
];

function renderNav() {
  const route = location.hash || '#/';
  const base = '#/' + (route.split('/')[1] || '');
  const p = progress();
  fill($('#nav'), ...TABS.map(([href, label, short]) =>
    h('a', { href, class: base === href || (href === '#/games' && base === '#/game') ? 'active' : '' },
      h('span', { class: 'l-full' }, label), h('span', { class: 'l-short' }, short))));
  fill($('#user-chip'), 
    S.username ? h('span', { class: 'uname' }, S.player && S.player.avatar ? h('img', { src: S.player.avatar, alt: '' }) : '♟', ' ', S.player ? S.player.name : S.username) : null,
    p.rating ? h('span', { class: 'prating', title: 'דירוג החידות שלך באתר' }, '🧩 ' + p.rating) : null);
}

function render() {
  renderNav();
  const route = (location.hash || '#/').slice(2).split('/');
  const name = route[0] || '';
  if (name !== 'session' && S.session) { S.session.destroy(); S.session = null; }
  const v = view();
  if (name !== 'session') voice.stop();
  v.className = 'view view-' + (name || 'home');
  if (name === '') return renderHome(v);
  if (name === 'report') return S.profile ? renderReport(v) : needAnalysis(v);
  if (name === 'games') return S.games.length ? renderGames(v) : needAnalysis(v);
  if (name === 'game') return renderGame(v, decodeURIComponent(route.slice(1).join('/')));
  if (name === 'review') {
    const ctx = { username: S.username, games: S.games, startSession };
    return route[1] ? renderReviewGame(v, decodeURIComponent(route[1]), ctx, Number(route[2]) || 0) : renderReviewHome(v, ctx);
  }
  if (name === 'openings') return renderOpenings(v, route.slice(1), { startSession });
  if (name === 'chat') return renderChat(v, { profileText: profileText() });
  if (name === 'train') return renderTrain(v);
  if (name === 'puzzles') return renderPuzzles(v);
  if (name === 'session') return S.session ? null : (location.hash = '#/');
  renderHome(v);
}

function needAnalysis(v) {
  fill(v, h('div', { class: 'card center' },
    h('h2', {}, 'עוד לא ניתחנו משחקים'),
    h('p', { class: 'muted' }, 'הכנס את שם המשתמש שלך ב-chess.com כדי שנבנה לך דוח ואימון אישי.'),
    h('a', { class: 'btn primary', href: '#/' }, 'לניתוח')));
}

// ---------------- home ----------------

function renderHome(v) {
  const input = h('input', { type: 'text', placeholder: 'שם משתמש ב-chess.com', value: S.username || '', dir: 'ltr', autocomplete: 'off', spellcheck: 'false' });
  const tc = h('select', {}, ...['all', 'blitz', 'rapid', 'bullet', 'daily'].map((k) =>
    h('option', { value: k, selected: S.timeClass === k || null }, k === 'all' ? 'כל הקצבים' : TIME_CLASS_LABEL[k])));
  const dp = h('select', {}, ...Object.keys(DEPTHS).map((k) =>
    h('option', { value: k, selected: S.depthKey === k || null }, `ניתוח ${DEPTH_LABEL[k]} (עומק ${DEPTHS[k]})`)));
  const go = (e) => {
    e.preventDefault();
    if (!input.value.trim()) { input.focus(); return; }
    runAnalysis(input.value, tc.value, dp.value);
  };
  fill(v, 
    h('section', { class: 'hero' },
      h('div', { class: 'hero-text' },
        h('h1', {}, 'האימון שמתאים ', h('span', { class: 'accent' }, 'בדיוק לך')),
        h('p', {}, `הכנס את שם המשתמש שלך ב-chess.com. Stockfish 18 ינתח כל מהלך ב-${GAME_COUNT} המשחקים האחרונים שלך, ימצא מה הכי מפריע לך — ויבנה לך אימון מהעמדות שלך ומהחידות הכי טובות שיש.`),
        h('form', { class: 'search', onsubmit: go },
          input,
          h('div', { class: 'row' }, tc, dp),
          h('button', { class: 'btn primary big', type: 'submit', disabled: S.analyzing || null }, S.analyzing ? 'מנתח...' : 'נתח את המשחקים שלי')),
        h('div', { id: 'progress' })),
      h('div', { class: 'hero-art' },
        h('img', { class: 'nick-full hero-nick', src: NICK_FULL, alt: 'ניק' }),
        nickSays([h('p', {}, quip('hello')), h('p', {}, 'אני אעבור על המשחקים שלך, אגיד לך מה מפריע לך, ואאמן אותך — עם קול והכל.')], { size: 'sm', className: 'hero-bubble', mood: 'happy' }))),
    h('section', { class: 'how' },
      howCard('1', 'ניתוח מנוע', 'כל מהלך שלך נבדק ומסווג: בלנדר, טעות או אי-דיוק — ולמה: כלי תלוי, טקטיקה של היריב, פספוס מט ועוד.'),
      howCard('2', 'אבחון', 'אנחנו מחשבים איזה סוג טעות עלה לך הכי הרבה — לא רק כמה טעויות, אלא כמה נקודות הן עלו.'),
      howCard('3', 'אימון ממוקד', 'תקן את הטעויות שלך, "הפוך את הלוח", תרגיל "בטוח או בלנדר?" וחידות מובחרות מ-6 מיליון החידות של Lichess.')),
    S.games.length && !S.analyzing ? h('div', { class: 'card resume' },
      h('div', {}, 'יש ניתוח שמור עבור ', h('b', { dir: 'ltr' }, S.username), ` (${S.games.length} משחקים)`),
      h('a', { class: 'btn', href: '#/report' }, 'לדוח →')) : null);
  renderProgress();
  if (!S.analyzing) input.focus();
}

function howCard(n, title, text) {
  return h('div', { class: 'card how-card' }, h('div', { class: 'num' }, n), h('h3', {}, title), h('p', {}, text));
}

function renderProgress() {
  const box = $('#progress');
  if (!box) return;
  const p = S.progress;
  if (!p) { fill(box, ); return; }
  if (p.stage === 'error') { fill(box, h('div', { class: 'msg bad' }, p.text)); return; }
  const frac = p.total ? p.done / p.total : 0;
  let eta = '';
  if (p.stage === 'analyze' && p.done > 20) {
    const sec = ((Date.now() - p.t0) / 1000) * (p.total - p.done) / p.done;
    eta = sec > 60 ? `עוד כ-${Math.round(sec / 60)} דק׳` : `עוד ${Math.max(1, Math.round(sec))} שנ׳`;
  }
  fill(box, 
    h('div', { class: 'progress' },
      h('div', { class: 'progress-text' }, h('span', {}, p.text), h('span', { class: 'muted' }, eta)),
      h('div', { class: 'bar' }, h('div', { style: { width: (frac * 100).toFixed(1) + '%' } })),
      p.stage === 'analyze' ? h('div', { class: 'muted small' }, `${p.done} / ${p.total} עמדות · ${getEngine().size} ליבות מנוע`) : null));
}

// ---------------- report ----------------

function renderReport(v) {
  const P = S.profile;
  const main = P.ranked[0];
  const W = WEAKNESS[main.key];
  const pl = S.player;
  const ratingChips = pl ? Object.entries(pl.ratings).filter(([, r]) => r).map(([k, r]) => h('span', { class: 'chip' }, `${TIME_CLASS_LABEL[k]} ${r}`)) : [];
  const shareOf = (k) => {
    if (P.bucket[k]) return P.bucket[k].share;
    if (k === 'time') return P.time.share;
    if (k === 'conversion') return P.conversion.share;
    return 0;
  };
  const buckets = Object.entries(P.bucket).map(([key, b]) => ({ key, ...b }))
    .filter((b) => b.count > 0).sort((a, b) => b.share - a.share);
  const maxShare = Math.max(...buckets.map((b) => b.share), 0.01);
  fill(v, 
    h('section', { class: 'profile card' },
      pl && pl.avatar ? h('img', { class: 'avatar', src: pl.avatar, alt: '' }) : h('div', { class: 'avatar ph' }, '♟'),
      h('div', {},
        h('h2', { dir: 'ltr', class: 'uname-big' }, pl ? pl.name : S.username),
        h('div', { class: 'chips' }, ...ratingChips,
          h('span', { class: 'chip' }, `${P.games} משחקים${S.timeClass !== 'all' ? ' · ' + TIME_CLASS_LABEL[S.timeClass] : ''}`))),
      h('div', { class: 'wld' },
        h('span', { class: 'w' }, P.results.win, h('small', {}, 'ניצחונות')),
        h('span', { class: 'd' }, P.results.draw, h('small', {}, 'תיקו')),
        h('span', { class: 'l' }, P.results.loss, h('small', {}, 'הפסדים')))),
    h('section', { class: 'tiles' },
      tile(P.accuracy !== null ? Math.round(P.accuracy) + '%' : '—', 'דיוק ממוצע'),
      tile(P.perGame.blunder.toFixed(1), 'בלנדרים למשחק', 'blunder'),
      tile(P.perGame.mistake.toFixed(1), 'טעויות למשחק', 'mistake'),
      tile(P.perGame.inaccuracy.toFixed(1), 'אי-דיוקים למשחק', 'inaccuracy'),
      tile(pct(P.blunderShare), 'מהיתרון שאיבדת — בגלל בלנדרים')),
    h('section', { class: 'card main-weak' },
      h('div', { class: 'mw-icon' }, W.icon),
      h('div', { class: 'mw-body' },
        h('div', { class: 'eyebrow' }, 'מה הכי כדאי לתקן קודם'),
        h('h2', {}, W.title),
        h('p', { class: 'mw-stat' }, weaknessStat(main.key)),
        nickSays([h('p', {}, W.why), h('p', {}, h('b', {}, 'ההרגל שצריך לבנות: '), W.habit)], { mood: 'warning' }),
        h('div', { class: 'row' },
          h('a', { class: 'btn primary big', href: '#/train', onclick: () => { S.focus = main.key; } }, 'התחל אימון ממוקד ←'),
          exampleButton(main.key)))),
    h('section', { class: 'grid2' },
      h('div', { class: 'card' },
        h('h3', {}, 'לאן הלך היתרון שלך'),
        h('p', { class: 'muted small' }, 'כל טעות ובלנדר שלך סווגו לפי הסיבה. האחוז = כמה מהיתרון שאיבדת בטעויות הלך על זה.'),
        h('div', { class: 'bars' }, ...buckets.map((b) => h('a', {
          class: 'barrow' + (b.key === main.key ? ' top' : ''), href: '#/train', onclick: () => { S.focus = b.key; },
        },
          h('span', { class: 'bl' }, WEAKNESS[b.key].icon, ' ', WEAKNESS[b.key].short),
          h('span', { class: 'bt' }, h('span', { style: { width: (b.share / maxShare * 100).toFixed(0) + '%' } })),
          h('span', { class: 'bv' }, pct(b.share)))))),
      h('div', { class: 'card' },
        h('h3', {}, 'לפי שלב במשחק'),
        h('div', { class: 'phases' }, ...['opening', 'middlegame', 'endgame'].map((ph) => {
          const d = P.phase[ph];
          return h('div', { class: 'phase' },
            h('div', { class: 'ph-v' }, pct(d.share)),
            h('div', { class: 'ph-l' }, PHASE_LABEL[ph]),
            h('div', { class: 'muted small' }, `${d.errors} טעויות · ${d.moves} מהלכים`));
        })),
        h('h3', { class: 'mt' }, 'דפוסים נוספים'),
        h('ul', { class: 'facts' },
          h('li', {}, `${P.time.errors} טעויות בלחץ זמן (${pct(P.time.share)})`, P.time.timeouts ? ` · ${P.time.timeouts} הפסדים על זמן` : ''),
          h('li', {}, `${pct(P.conversion.share)} מהיתרון שאיבדת — כשהיית במצב מנצח`),
          h('li', {}, `${P.conversion.thrown} משחקים שבהם היית במצב מנצח ולא ניצחת`)))),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'המהלכים הכי יקרים שלך'), h('a', { href: '#/games' }, 'כל המשחקים →')),
      h('div', { class: 'worst' }, ...worstMoves(6).map(worstCard))));
}

function tile(v, label, cls = '') {
  return h('div', { class: 'tile card ' + cls }, h('div', { class: 'tv' }, v), h('div', { class: 'tl' }, label));
}

function weaknessStat(key) {
  const P = S.profile;
  if (key === 'opening' || key === 'endgame') return `${P.bucket[key].count} טעויות עמדה ב${PHASE_LABEL[key]} · ${pct(P.bucket[key].share)} מהיתרון שאיבדת בטעויות`;
  if (P.bucket[key]) return `${P.bucket[key].count} מקרים ב-${P.games} משחקים · ${pct(P.bucket[key].share)} מהיתרון שאיבדת בטעויות`;
  if (key === 'time') return `${P.time.errors} טעויות בלחץ זמן · ${P.time.timeouts} הפסדים על זמן`;
  if (key === 'conversion') return `${P.conversion.thrown} משחקים מנצחים שלא נגמרו בניצחון`;
  return '';
}

function exampleButton(key) {
  const items = itemsForWeakness(key, 'fix');
  if (!items.length) return null;
  const it = items[0];
  return h('a', { class: 'btn ghost', href: `#/game/${encodeURIComponent(it.gameId)}/${it.ply}` }, 'הראה לי דוגמה מהמשחקים שלי');
}

function worstMoves(n) {
  const all = [];
  for (const g of S.games) g.plies.forEach((p, i) => { if (p.mine && p.cls === 'blunder') all.push({ g, p, i }); });
  return all.sort((a, b) => b.p.drop - a.p.drop).slice(0, n);
}

function worstCard({ g, p, i }) {
  const el = h('div', { class: 'cg-wrap board thumb' });
  setTimeout(() => {
    const b = new Board(el);
    b.set(p.fenBefore, { orientation: g.userColor, lastMove: i > 0 ? g.plies[i - 1].uci : null });
    b.arrows([{ uci: p.uci, brush: 'red' }, ...(p.best ? [{ uci: p.best, brush: 'green' }] : [])]);
    b.lock();
  });
  return h('a', { class: 'worst-card', href: `#/game/${encodeURIComponent(g.id)}/${i}` },
    h('div', { class: 'board-box', dir: 'ltr' }, el),
    h('div', { class: 'wc-text' },
      h('b', { dir: 'ltr' }, `${Math.floor(i / 2) + 1}${p.color === 'w' ? '.' : '...'} ${p.san}??`),
      h('span', { class: 'muted small' }, p.type ? ERROR_TYPE_LABEL[p.type] : ''),
      h('span', { class: 'small' }, 'עדיף: ', h('b', { dir: 'ltr' }, p.bestSan || '—'))));
}

// ---------------- games list ----------------

function renderGames(v) {
  fill(v, 
    h('div', { class: 'page-head' }, h('h2', {}, `${S.games.length} המשחקים האחרונים`),
      h('p', { class: 'muted' }, 'לחץ על משחק כדי לעבור עליו מהלך-מהלך ולתרגל כל טעות.')),
    h('div', { class: 'game-list' }, ...S.games.map((g) => h('a', { class: 'game-row card', href: '#/game/' + encodeURIComponent(g.id) },
      h('span', { class: 'res ' + g.result }, RESULT_LABEL[g.result]),
      h('span', { class: 'gr-main' },
        h('b', {}, h('span', { class: 'piece-dot ' + (g.userColor === 'w' ? 'white' : 'black') }), ' נגד ', h('bdi', {}, g.opp.name), h('span', { class: 'muted' }, ` (${g.opp.rating})`)),
        h('span', { class: 'muted small' }, `${fmtDate(g.endTime)} · ${TIME_CLASS_LABEL[g.timeClass] || g.timeClass} · ${REASON_LABEL[g.reason] || g.reason}`, g.opening ? ' · ' : '', g.opening ? h('bdi', {}, g.opening) : null)),
      h('span', { class: 'gr-stats' },
        g.accuracy !== null ? h('span', { class: 'acc' }, Math.round(g.accuracy) + '%') : null,
        g.counts.blunder ? h('span', { class: 'cnt blunder' }, g.counts.blunder + '??') : null,
        g.counts.mistake ? h('span', { class: 'cnt mistake' }, g.counts.mistake + '?') : null,
        g.counts.inaccuracy ? h('span', { class: 'cnt inaccuracy' }, g.counts.inaccuracy + '?!') : null)))));
}

// ---------------- single game viewer ----------------

function renderGame(v, path) {
  const parts = path.split('/');
  let ply = null;
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) ply = Number(parts.pop());
  const id = parts.join('/');
  const g = S.games.find((x) => x.id === id);
  if (!g) return needAnalysis(v);
  let cur = ply !== null ? ply : 0; // cur = number of plies played on the board
  let orient = g.userColor;
  const boardEl = h('div', { class: 'cg-wrap board' });
  const evalFill = h('div', { class: 'eval-fill' });
  const evalTxt = h('div', { class: 'eval-txt' });
  const info = h('div', { class: 'move-info' });
  const infoNick = nickSays(info, { className: 'viewer-nick' });
  const moves = h('div', { class: 'moves', dir: 'ltr' });
  const graph = h('div', { class: 'graph' });
  let board;

  const mineErrors = g.plies.map((p, i) => ({ p, i })).filter(({ p }) => p.mine && (p.cls === 'mistake' || p.cls === 'blunder'));

  function show(n, focusMistake = ply !== null) {
    cur = Math.max(0, Math.min(g.plies.length, n));
    const fen = cur === 0 ? g.initialFen : g.plies[cur - 1].fenAfter;
    board.set(fen, { orientation: orient, lastMove: cur > 0 ? g.plies[cur - 1].uci : null });
    const e = g.evals[cur];
    const wc = winChance(e.cpW);
    evalFill.parentElement.classList.toggle('flip', orient === 'b');
    evalFill.style.height = ((wc + 1) / 2 * 100).toFixed(1) + '%';
    evalTxt.textContent = formatEval(e.cpW);
    // describe the move that is about to be played from here, if it is one of ours with an error,
    // otherwise the move that was just played
    const next = g.plies[cur];
    const prev = cur > 0 ? g.plies[cur - 1] : null;
    const shapes = [];
    let p = null, pIdx = null;
    if (next && next.mine && next.cls !== 'good' && (focusMistake || !prev || prev.cls === 'good')) { p = next; pIdx = cur; }
    else if (prev) { p = prev; pIdx = cur - 1; }
    fill(info, );
    if (p) {
      const atBefore = pIdx === cur; // board shows the position before p
      if (atBefore && p.mine && p.cls !== 'good') {
        shapes.push({ uci: p.uci, brush: 'red' });
        if (p.best) shapes.push({ uci: p.best, brush: 'green' });
      }
      const label = p.cls !== 'good' ? CLS_LABEL[p.cls] : (p.uci === p.best ? 'המהלך הטוב ביותר' : 'מהלך טוב');
      const line = p.best ? pvToSan(p.fenBefore, g.evals[pIdx].pv, 6) : [];
      info.append(
        h('div', { class: 'mi-head ' + p.cls },
          h('b', { dir: 'ltr' }, `${Math.floor(pIdx / 2) + 1}${p.color === 'w' ? '.' : '...'} ${p.san}${CLS_MARK[p.cls] || ''}`),
          h('span', {}, label), p.type ? h('span', { class: 'chip small' }, ERROR_TYPE_LABEL[p.type]) : null,
          p.mine ? null : h('span', { class: 'muted small' }, '(היריב)')),
        p.cls !== 'good' && p.bestSan ? h('div', {}, 'המנוע ממליץ: ', h('b', { dir: 'ltr' }, p.bestSan),
          line.length > 1 ? h('span', { class: 'muted small', dir: 'ltr' }, '  ' + line.join(' ')) : null) : null,
        p.clock !== null && p.clock !== undefined ? h('div', { class: 'muted small' }, `שעון אחרי המהלך: ${fmtClock(p.clock)}${p.timeTrouble ? ' ⚠ לחץ זמן' : ''}`) : null,
        p.mine && p.cls !== 'good' ? h('div', { class: 'row' },
          h('button', { class: 'btn primary small', onclick: () => startFix(g, pIdx) }, '🔧 תקן את המהלך הזה'),
          ['hanging', 'allowedTactic', 'allowedMate'].includes(p.type) ? h('button', { class: 'btn small', onclick: () => startPunish(g, pIdx) }, '🔄 הפוך את הלוח') : null,
          !atBefore ? h('button', { class: 'btn ghost small', onclick: () => show(pIdx, true) }, 'הצג לפני המהלך') : null) : null);
    }
    board.arrows(shapes);
    if (p) infoNick.speak({ blunder: 'shocked', mistake: 'sad', inaccuracy: 'thinking' }[p.cls] || 'happy');
    moves.querySelectorAll('.mv').forEach((el) => el.classList.toggle('cur', Number(el.dataset.i) === cur - 1));
    const curEl = moves.querySelector('.mv.cur');
    if (curEl) curEl.scrollIntoView({ block: 'nearest' });
    graph.querySelector('.cursor')?.setAttribute('x1', xOf(cur));
    graph.querySelector('.cursor')?.setAttribute('x2', xOf(cur));
  }

  // move list
  for (let i = 0; i < g.plies.length; i += 2) {
    const row = h('div', { class: 'mrow' }, h('span', { class: 'mn' }, Math.floor(i / 2) + 1 + '.'));
    for (const j of [i, i + 1]) {
      const p = g.plies[j];
      if (!p) { row.append(h('span', { class: 'mv empty' })); continue; }
      row.append(h('span', { class: `mv ${p.cls} ${p.mine ? 'mine' : ''}`, 'data-i': j, onclick: () => show(j + 1, false) },
        p.san, CLS_MARK[p.cls] ? h('sup', {}, CLS_MARK[p.cls]) : null));
    }
    moves.append(row);
  }

  // eval graph
  const W = 600, H = 110, n = g.evals.length - 1 || 1;
  const xOf = (i) => (i / n * W).toFixed(1);
  const yOf = (cpW) => ((1 - (winChance(cpW) + 1) / 2) * H).toFixed(1);
  const pts = g.evals.map((e, i) => `${xOf(i)},${yOf(e.cpW)}`).join(' ');
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = `<rect width="${W}" height="${H}" class="g-bg"/>
    <polygon points="0,${H} ${pts} ${W},${H}" class="g-area"/>
    <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="g-mid"/>
    <line class="cursor" x1="0" x2="0" y1="0" y2="${H}"/>` +
    mineErrors.map(({ p, i }) => `<circle cx="${xOf(i + 1)}" cy="${yOf(g.evals[i + 1].cpW)}" r="4.5" class="g-dot ${p.cls}" data-i="${i}"/>`).join('');
  svg.addEventListener('click', (e) => {
    const dot = e.target.closest('circle');
    if (dot) return show(Number(dot.dataset.i), true);
    const r = svg.getBoundingClientRect();
    show(Math.round((e.clientX - r.left) / r.width * n), false);
  });
  graph.append(svg);

  const nav = h('div', { class: 'nav-btns', dir: 'ltr' },
    h('button', { class: 'btn small', onclick: () => show(0, false), title: 'התחלה' }, '⏮'),
    h('button', { class: 'btn small', onclick: () => show(cur - 1, false), title: 'אחורה' }, '◀'),
    h('button', { class: 'btn small', onclick: () => show(cur + 1, false), title: 'קדימה' }, '▶'),
    h('button', { class: 'btn small', onclick: () => show(g.plies.length, false), title: 'סוף' }, '⏭'),
    h('button', { class: 'btn small', onclick: () => { orient = orient === 'w' ? 'b' : 'w'; show(cur, false); }, title: 'הפוך לוח' }, '⇅'));

  fill(v, 
    h('div', { class: 'page-head row-between' },
      h('div', {},
        h('h2', {}, h('span', { class: 'res ' + g.result }, RESULT_LABEL[g.result]), ' נגד ', h('bdi', {}, g.opp.name), h('span', { class: 'muted' }, ` (${g.opp.rating})`)),
        h('div', { class: 'muted small' }, `${fmtDate(g.endTime)} · ${TIME_CLASS_LABEL[g.timeClass] || ''} · ${REASON_LABEL[g.reason] || g.reason}`,
          g.opening ? ' · ' : '', g.opening ? h('bdi', {}, g.opening) : null,
          g.accuracy !== null ? ` · דיוק ${Math.round(g.accuracy)}%` : '')),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: '#/review/' + encodeURIComponent(g.id) }, '🔍 ציון לכל מהלך'),
        mineErrors.length ? h('button', { class: 'btn primary', onclick: () => startGameDrill(g) }, `תרגל את ${mineErrors.length} הטעויות במשחק`) : null,
        h('a', { class: 'btn ghost', href: g.url, target: '_blank', rel: 'noopener' }, 'chess.com ↗'))),
    h('div', { class: 'viewer' },
      h('div', { class: 'board-col' },
        h('div', { class: 'board-with-eval', dir: 'ltr' },
          h('div', { class: 'eval-bar' }, evalFill, evalTxt),
          h('div', { class: 'board-box' }, boardEl)),
        nav, graph),
      h('div', { class: 'side card' },
        infoNick,
        mineErrors.length ? h('div', { class: 'err-list' },
          h('h4', {}, 'הטעויות שלך במשחק'),
          ...mineErrors.map(({ p, i }) => h('button', { class: 'err-item ' + p.cls, onclick: () => show(i, true) },
            h('b', { dir: 'ltr' }, `${Math.floor(i / 2) + 1}${p.color === 'w' ? '.' : '...'} ${p.san}${CLS_MARK[p.cls]}`),
            h('span', {}, ERROR_TYPE_LABEL[p.type] || ''), h('span', { class: 'muted small' }, PHASE_LABEL[p.phase])))) : h('p', { class: 'muted' }, 'אין טעויות גדולות במשחק הזה 👏'),
        moves)));

  const onKey = (e) => {
    if (!document.body.contains(moves)) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'ArrowRight') { show(cur + 1, false); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { show(cur - 1, false); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);
  board = new Board(boardEl); // after the element is in the DOM, so chessground can measure it
  show(cur, ply !== null);
}

function fmtClock(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// ---------------- sessions ----------------

function startSession(opts) {
  S.returnTo = location.hash || '#/train';
  location.hash = '#/session';
  renderNav();
  const v = view();
  v.className = 'view view-session';
  S.session = new Session(v, {
    ...opts,
    onExit: () => { S.session = null; location.hash = S.returnTo; },
  });
}

function gameItems(g, filterIdx = null, mode = 'fix') {
  return mistakeItems([g], { mode }).filter((it) => filterIdx === null || it.ply === filterIdx)
    .map((it) => ({ ...it, gameUrl: g.url }));
}

function startFix(g, idx) {
  const items = g.evals[idx] && g.evals[idx].best ? [{ ...fixItem(g, idx), gameUrl: g.url }] : [];
  if (!items.length) return toast('אין מה לתרגל במהלך הזה');
  startSession({ title: 'תקן את המהלך', subtitle: `נגד ${g.opp.name}`, items, drill: 'fix' });
}

function startPunish(g, idx) {
  const items = gameItems(g, idx, 'punish');
  if (!items.length) return toast('אין מה לתרגל במהלך הזה');
  startSession({ title: 'הפוך את הלוח', subtitle: `נגד ${g.opp.name}`, items, drill: 'punish' });
}

function startGameDrill(g) {
  startSession({ title: 'הטעויות במשחק', subtitle: `נגד ${g.opp.name}`, items: gameItems(g, null, 'fix'), drill: 'fix' });
}

const TYPE_KEYS = ['hanging', 'allowedTactic', 'allowedMate', 'missedTactic', 'missedMate', 'positional'];

function itemsForWeakness(key, mode) {
  const urlOf = Object.fromEntries(S.games.map((g) => [g.id, g.url]));
  let items;
  if (key === 'positional') items = mistakeItems(S.games, { types: [key], phases: ['middlegame'], mode });
  else if (TYPE_KEYS.includes(key)) items = mistakeItems(S.games, { types: [key], mode });
  else if (key === 'opening' || key === 'endgame') items = mistakeItems(S.games, { phases: [key], types: ['positional'], mode });
  else if (key === 'time') items = mistakeItems(S.games, { mode }).filter((it) => S.games.find((g) => g.id === it.gameId).plies[it.ply].timeTrouble);
  else if (key === 'conversion') items = mistakeItems(S.games, { mode }).filter((it) => S.games.find((g) => g.id === it.gameId).plies[it.ply].winning);
  else items = mistakeItems(S.games, { mode });
  // when one type has few positions, top up with the other blunders
  if (items.length < 6 && mode !== 'fix') items = items.concat(mistakeItems(S.games, { mode }).filter((x) => !items.includes(x)));
  return items.map((it) => ({ ...it, gameUrl: urlOf[it.gameId] }));
}

// Your own blunders vs. your solid moves; when you have few blunders, Lichess puzzle set-up
// moves (each one is a real blunder that allowed a tactic) fill the "unsafe" half.
function buildSafetyItems(max = 20) {
  const own = safetyItems(S.games, 60);
  const half = Math.floor(max / 2);
  const bad = own.filter((x) => x.unsafe).slice(0, half);
  if (bad.length < half) {
    const rating = targetRating() - 200;
    const pz = shuffle(['hangingPiece', 'fork', 'trappedPiece', 'pin', 'discoveredAttack', 'skewer']
      .flatMap((t) => curatedForTheme(t, rating, 4)));
    for (const p of pz) {
      if (bad.length >= half) break;
      const r = tryMove(p.fen, p.moves[0]);
      if (!r) continue;
      bad.push({ kind: 'safe', fen: p.fen, move: p.moves[0], san: r.move.san, color: sideToMove(p.fen),
        lastMove: null, unsafe: true, refutation: p.moves[1], refutationPv: p.moves.slice(1), source: 'puzzle' });
    }
  }
  const good = own.filter((x) => !x.unsafe).slice(0, max - bad.length);
  return shuffle([...bad, ...good]);
}

function startDrill(key, drill) {
  let items;
  if (drill === 'safety') items = buildSafetyItems(20);
  else items = shuffle(itemsForWeakness(key, drill)).slice(0, 25);
  if (!items.length) return toast('אין מספיק עמדות מהמשחקים שלך לתרגיל הזה');
  startSession({ title: DRILLS[drill].title, subtitle: WEAKNESS[key] ? WEAKNESS[key].short : '', items, drill });
}

function startTheme(theme) {
  const rating = targetRating();
  const items = curatedForTheme(theme, rating, 12).map((p) => ({ ...p, kind: 'puzzle' }));
  startSession({
    title: 'חידות: ' + themeName(theme), subtitle: 'הכי מדורגות + חדשות מ-Lichess', items,
    loadMore: async () => (await lichessBatch(theme, targetRating(), 15)).map((p) => ({ ...p, kind: 'puzzle' })),
  });
}

function startCategory(cat) {
  const solved = progress().solved;
  const list = curated(cat).sort((a, b) => a.rating - b.rating);
  const items = [...list.filter((p) => !solved[p.id]), ...list.filter((p) => solved[p.id])].map((p) => ({ ...p, kind: 'puzzle' }));
  const theme = (CAT_INFO[cat] && CAT_INFO[cat].theme) || cat;
  startSession({
    title: catTitle(cat), subtitle: `${list.length} החידות הכי מדורגות`, items,
    loadMore: async () => (await lichessBatch(theme, targetRating(), 15)).map((p) => ({ ...p, kind: 'puzzle' })),
  });
}

function startDaily() {
  const W = S.profile ? WEAKNESS[S.profile.ranked[0].key] : null;
  const items = [];
  if (S.games.length && W) {
    const key = S.profile.ranked[0].key;
    items.push(...shuffle(itemsForWeakness(key, 'fix')).slice(0, 4));
    if (W.drills.includes('punish')) items.push(...shuffle(itemsForWeakness(key, 'punish')).slice(0, 3));
    if (W.drills.includes('safety')) items.push(...buildSafetyItems(4));
  }
  const themes = W ? W.themes : ['fork', 'pin', 'hangingPiece', 'mateIn2'];
  const rating = targetRating();
  themes.slice(0, 4).forEach((t) => items.push(...curatedForTheme(t, rating, 2).map((p) => ({ ...p, kind: 'puzzle' }))));
  items.push(...curatedForTheme('veryLong', rating, 1).map((p) => ({ ...p, kind: 'puzzle' })));
  startSession({ title: 'האימון היומי', subtitle: '~15 דקות', items: shuffle(items), drill: 'daily' });
}

function startFailed() {
  const items = progress().failed.slice(0, 30).map((p) => ({ ...p, kind: 'puzzle' }));
  if (!items.length) return toast('אין חידות שנכשלת בהן — כל הכבוד!');
  startSession({ title: 'חזרה על חידות שנכשלת', subtitle: 'שיטת Woodpecker', items });
}

// ---------------- training plan ----------------

function renderTrain(v) {
  const P = S.profile;
  const keys = P ? P.ranked.filter((r) => r.score > 0.005).slice(0, 4).map((r) => r.key) : [];
  if (!S.focus || (P && !WEAKNESS[S.focus])) S.focus = keys[0] || 'hanging';
  const key = S.focus;
  const W = WEAKNESS[key];
  const prog = progress();
  const counts = P ? {
    fix: itemsForWeakness(key, 'fix').length,
    punish: itemsForWeakness(key, 'punish').length,
    safety: buildSafetyItems(20).length,
  } : {};
  fill(v, 
    h('div', { class: 'page-head row-between' },
      h('div', {}, h('h2', {}, 'האימון שלך'),
        h('p', { class: 'muted' }, P ? 'מבוסס על הניתוח של המשחקים שלך. בחר בעיה ותרגל אותה.' : 'עוד לא ניתחת משחקים — אפשר להתאמן כללית, או לנתח קודם.')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary big', onclick: startDaily }, '▶ האימון היומי'),
        prog.failed.length ? h('button', { class: 'btn', onclick: startFailed }, `חזרה על ${prog.failed.length} שנכשלו`) : null)),
    P ? h('div', { class: 'focus-tabs' }, ...keys.map((k, i) => h('button', {
      class: 'ftab' + (k === key ? ' active' : ''), onclick: () => { S.focus = k; render(); },
    }, h('span', {}, WEAKNESS[k].icon), ' ', WEAKNESS[k].short, i === 0 ? h('span', { class: 'badge' }, 'מס׳ 1') : null))) : null,
    !P ? h('div', { class: 'focus-tabs' }, ...Object.keys(WEAKNESS).map((k) => h('button', {
      class: 'ftab' + (k === key ? ' active' : ''), onclick: () => { S.focus = k; render(); },
    }, WEAKNESS[k].icon, ' ', WEAKNESS[k].short))) : null,
    h('section', { class: 'card plan' },
      h('div', { class: 'plan-head' }, h('span', { class: 'mw-icon' }, W.icon),
        h('div', {}, h('h3', {}, W.title), P ? h('div', { class: 'muted' }, weaknessStat(key)) : null)),
      nickSays([h('p', {}, W.why), h('p', {}, h('b', {}, 'ההרגל: '), W.habit)], { mood: 'proud' })),
    P ? h('section', {},
      h('h3', { class: 'sec-title' }, 'תרגילים מהמשחקים שלך'),
      h('div', { class: 'drills' }, ...W.drills.map((d) => drillCard(key, d, counts[d] || 0, prog.drills[d])))) : null,
    h('section', {},
      h('h3', { class: 'sec-title' }, 'חידות לפי נושא'),
      h('p', { class: 'muted small' }, `החידות הכי מדורגות במאגר Lichess, סביב הרמה שלך (${targetRating()}), ואחריהן חידות חדשות ללא הגבלה.`),
      h('div', { class: 'theme-grid' }, ...W.themes.map((t) => {
        const s = prog.themes[t];
        return h('button', { class: 'theme-card card', onclick: () => startTheme(t) },
          h('b', {}, themeName(t)),
          h('span', { class: 'muted small' }, s ? `${s.ok}/${s.total} נפתרו` : 'התחל'));
      }))),
    key === 'hanging' || key === 'allowedTactic' || key === 'allowedMate' ? researchNotes() : null);
}

function drillCard(key, drill, count, stat) {
  const D = DRILLS[drill];
  return h('div', { class: 'drill card' },
    h('div', { class: 'd-icon' }, D.icon),
    h('h4', {}, D.title),
    h('p', { class: 'muted small' }, D.desc),
    h('div', { class: 'd-foot' },
      h('span', { class: 'small muted' }, `${count} עמדות`, stat ? ` · ${stat.ok}/${stat.total} הצלחות` : ''),
      h('button', { class: 'btn primary small', disabled: !count || null, onclick: () => startDrill(key, drill) }, 'התחל')));
}

function researchNotes() {
  const src = [
    ['How Do You Stop Blundering? (Lichess)', 'https://lichess.org/@/CheckRaiseMate/blog/how-do-you-stop-blundering/UOFOoIir'],
    ['What the Fork is a Blunder Check? (Lichess)', 'https://lichess.org/@/TheOnoZone/blog/what-the-fork-is-a-blunder-check/NATnH2B5'],
    ['7 Tips to Cure Chess Blunders', 'https://thechessworld.com/articles/training-techniques/7-tips-to-cure-chess-blunders/'],
    ['how do you stop blundering (Zwischenzug)', 'https://zwischenzug.substack.com/p/how-do-you-stop-blundering'],
  ];
  return h('section', { class: 'card research' },
    h('h3', {}, 'איך מתאמנים נגד בלנדרים? (מה המאמנים ממליצים)'),
    h('ol', {},
      h('li', {}, h('b', {}, 'בדיקת בלנדר לפני כל מהלך. '), 'דמיין שהמהלך כבר שוחק ובדוק רק את השחים והאכילות של היריב. זה לוקח כמה שניות ותופס את רוב הבלנדרים. ', h('i', {}, 'מצב בדיקת בלנדר'), ' באתר מכריח אותך לעצור ולאשר כל מהלך עד שזה נהיה הרגל.'),
      h('li', {}, h('b', {}, 'מה השתנה במהלך האחרון של היריב? '), 'כל מהלך תוקף משהו, מפסיק להגן על משהו, או שניהם. שאל את זה אחרי כל מהלך שלו.'),
      h('li', {}, h('b', {}, 'להפוך את הלוח. '), 'לפתור עמדות מהצד של היריב — למצוא את המהלך החזק שלו. זה בונה זיהוי מהיר של איומים (התרגיל "הפוך את הלוח").'),
      h('li', {}, h('b', {}, 'חידות כל יום, 15–20 דקות. '), 'הרבה בלנדרים הם מוטיבים טקטיים שלא זיהית. חידות "כלי תלוי" ו"מהלך הגנה" מאמנות בדיוק את זה.'),
      h('li', {}, h('b', {}, 'להאט. '), 'במשחקי אימון קח לפחות כמה שניות על כל מהלך, גם הפשוטים. רוב הבלנדרים הם מהלכים "אוטומטיים".'),
      h('li', {}, h('b', {}, 'לנתח כל משחק. '), 'מצא את הרגע הראשון שבו החשיבה שלך השתבשה, לא רק את המהלך שהפסיד חומר.')),
    h('p', { class: 'muted small' }, 'הערה: אלה המלצות של מאמנים ובלוגרים, לא מחקר מבוקר — אבל הן עקביות מאוד בין המקורות.'),
    h('div', { class: 'sources' }, 'מקורות: ', ...src.map(([t, u]) => h('a', { href: u, target: '_blank', rel: 'noopener' }, t))));
}

// ---------------- puzzles library ----------------

function renderPuzzles(v) {
  const prog = progress();
  fill(v, 
    h('div', { class: 'page-head row-between' },
      h('div', {},
        h('h2', {}, 'החידות הכי טובות שיש'),
        h('p', { class: 'muted' }, 'נבחרו מתוך 6 מיליון החידות של Lichess: רק חידות שאלפי שחקנים פתרו, ושלפחות 90% מהם דירגו לטובה. כל החידות מגיעות ממשחקים אמיתיים.')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => {
          try { const p = await dailyPuzzle(); startSession({ title: 'החידה היומית של Lichess', items: [{ ...p, kind: 'puzzle' }] }); }
          catch { toast('לא הצלחתי לטעון את החידה היומית'); }
        } }, '📅 החידה היומית'),
        prog.failed.length ? h('button', { class: 'btn', onclick: startFailed }, `חזרה על ${prog.failed.length} שנכשלו`) : null)),
    nickSays('טיפ ממני: בחידות הארוכות אל תזיז כלום עד שחישבת את כל הקו בראש. ככה בונים חישוב — לא בניחושים. ואם נכשלת, החידה תחזור אליך עד שתזכור אותה בעל פה.'),
    ...PUZZLE_GROUPS.map((gr, gi) => h('section', { class: 'pgroup' + (gi === 0 ? ' featured' : '') },
      h('h3', { class: 'sec-title' }, gr.title), h('p', { class: 'muted small' }, gr.desc),
      h('div', { class: 'cat-grid' }, ...gr.cats.filter((c) => window.TOP_PUZZLES && window.TOP_PUZZLES[c]).map((c) => {
        const list = window.TOP_PUZZLES[c];
        const done = list.filter((p) => prog.solved[p.id]).length;
        const rs = list.map((p) => p.rating);
        return h('button', { class: 'cat-card card', onclick: () => startCategory(c) },
          h('b', {}, catTitle(c)),
          h('span', { class: 'muted small' }, 'דירוג ', h('bdi', {}, `${Math.min(...rs)}–${Math.max(...rs)}`)),
          h('span', { class: 'cat-bar' }, h('span', { style: { width: (done / list.length * 100) + '%' } })),
          h('span', { class: 'small' }, `${done} / ${list.length}`));
      })))));
}

// ---------------- boot ----------------

restoreLast();
$('#voice-slot').append(voiceToggle());
window.addEventListener('hashchange', () => { if (location.hash !== '#/session') render(); });
window.addEventListener('ct-progress', renderNav);
if (location.hash === '#/session') location.hash = '#/';
render();
