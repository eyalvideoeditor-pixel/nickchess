import { Chess, moveToUci } from './chessutil.js';

const API = 'https://api.chess.com/pub/player/';

async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 404) throw new Error('NOT_FOUND');
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

export async function fetchProfile(username) {
  const u = username.trim().toLowerCase();
  const [profile, stats] = await Promise.all([
    getJson(API + encodeURIComponent(u)),
    getJson(API + encodeURIComponent(u) + '/stats').catch(() => ({})),
  ]);
  return { profile, stats };
}

// Latest `count` standard-chess games, newest first.
export async function fetchRecentGames(username, { count = 25, timeClass = 'all', onProgress } = {}) {
  const u = username.trim().toLowerCase();
  const { archives = [] } = await getJson(API + encodeURIComponent(u) + '/games/archives');
  const games = [];
  for (let i = archives.length - 1; i >= 0 && games.length < count; i--) {
    if (onProgress) onProgress(archives[i]);
    const month = await getJson(archives[i]);
    const list = (month.games || [])
      .filter((g) => g.rules === 'chess' && g.pgn)
      .filter((g) => timeClass === 'all' || g.time_class === timeClass)
      .sort((a, b) => b.end_time - a.end_time);
    for (const g of list) {
      if (games.length >= count) break;
      games.push(g);
    }
    if (archives.length - i >= 24) break; // two years back is enough
  }
  return games.map((g) => parseGame(g, u)).filter(Boolean);
}

const WIN = 'win';
const DRAWS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

function parseClock(str) {
  const m = str.match(/\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// "[White \"x\"]" headers + movetext with {[%clk]} comments
export function parsePgn(pgn) {
  const headers = {};
  for (const m of pgn.matchAll(/^\[(\w+)\s+"([^"]*)"\]\s*$/gm)) headers[m[1]] = m[2];
  const body = pgn.replace(/^\[.*\]\s*$/gm, '').trim();
  const tokens = [];
  const re = /\{([^}]*)\}|(\d+\.(?:\.\.)?)|(1-0|0-1|1\/2-1\/2|\*)|(\$\d+)|([^\s{}]+)/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) {
      if (tokens.length) {
        const c = parseClock(m[1]);
        if (c !== null) tokens[tokens.length - 1].clock = c;
      }
    } else if (m[5]) {
      tokens.push({ san: m[5].replace(/[!?]+$/, '') });
    }
  }
  return { headers, tokens };
}

function openingName(headers) {
  const url = headers.ECOUrl || '';
  const slug = url.split('/openings/')[1];
  if (!slug) return headers.ECO || '';
  return decodeURIComponent(slug).replace(/-\d+\..*$/, '').replace(/-/g, ' ');
}

function playTokens(startFen, tokens) {
  const chess = startFen ? new Chess(startFen) : new Chess();
  const initialFen = chess.fen();
  const plies = [];
  for (const t of tokens) {
    const fenBefore = chess.fen();
    let mv;
    try { mv = chess.move(t.san); } catch { mv = null; }
    if (!mv) break;
    plies.push({
      san: mv.san, uci: moveToUci(mv), color: mv.color,
      fenBefore, fenAfter: chess.fen(), clock: t.clock ?? null,
      capture: !!mv.captured,
    });
  }
  return { initialFen, plies };
}

export function parseGame(g, username) {
  try {
    const { headers, tokens } = parsePgn(g.pgn);
    const startFen = headers.SetUp === '1' && headers.FEN ? headers.FEN : (g.initial_setup || undefined);
    const { initialFen, plies } = playTokens(startFen, tokens);
    const white = g.white, black = g.black;
    const userColor = white.username.toLowerCase() === username ? 'w' : 'b';
    const me = userColor === 'w' ? white : black;
    const opp = userColor === 'w' ? black : white;
    const result = me.result === WIN ? 'win' : DRAWS.has(me.result) ? 'draw' : 'loss';
    const tc = String(g.time_control || '');
    const base = tc.includes('/') ? null : Number(tc.split('+')[0]) || null;
    return {
      id: g.uuid || g.url,
      url: g.url,
      endTime: g.end_time,
      timeClass: g.time_class,
      timeControl: tc,
      baseTime: base,
      rated: g.rated,
      userColor,
      me: { name: me.username, rating: me.rating, result: me.result },
      opp: { name: opp.username, rating: opp.rating, result: opp.result },
      result,
      reason: result === 'win' ? opp.result : me.result,
      opening: openingName(headers),
      initialFen,
      plies,
      accuracies: g.accuracies || null,
    };
  } catch (e) {
    console.warn('could not parse game', g.url, e);
    return null;
  }
}

// ---------- single games: pasted PGN, Lichess link, chess.com link ----------

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function pgnDateToSec(d) {
  const m = (d || '').match(/(\d{4})\.(\d{2})\.(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000 : null;
}

function gameFromParts({ headers, tokens }, { username = null, id = null, url = null } = {}) {
  if (headers.Variant && !/^standard$/i.test(headers.Variant)) throw new Error('VARIANT');
  const startFen = headers.SetUp === '1' && headers.FEN ? headers.FEN : undefined;
  const { initialFen, plies } = playTokens(startFen, tokens);
  if (!plies.length) throw new Error('NO_MOVES');
  const W = { name: headers.White || 'לבן', rating: Number(headers.WhiteElo) || null };
  const B = { name: headers.Black || 'שחור', rating: Number(headers.BlackElo) || null };
  const u = (username || '').toLowerCase();
  const userColor = u && B.name.toLowerCase() === u ? 'b' : 'w';
  const r = headers.Result;
  const whiteRes = r === '1-0' ? 'win' : r === '0-1' ? 'loss' : r === '1/2-1/2' ? 'draw' : null;
  const flip = { win: 'loss', loss: 'win', draw: 'draw' };
  const tc = headers.TimeControl || '';
  return {
    id: id || 'pgn-' + hashStr(plies.map((p) => p.uci).join('')),
    url: url || headers.Link || headers.Site && /^https?:/.test(headers.Site) && headers.Site || null,
    endTime: pgnDateToSec(headers.UTCDate || headers.EndDate || headers.Date),
    timeClass: null,
    timeControl: tc,
    baseTime: tc && !tc.includes('/') ? Number(tc.split('+')[0]) || null : null,
    userColor,
    me: userColor === 'w' ? W : B,
    opp: userColor === 'w' ? B : W,
    result: whiteRes ? (userColor === 'w' ? whiteRes : flip[whiteRes]) : null,
    resultText: r || '*',
    reason: headers.Termination || '',
    opening: headers.Opening || openingName(headers),
    initialFen,
    plies,
  };
}

export function gameFromPgn(pgn, opts) {
  return gameFromParts(parsePgn(pgn), opts);
}

export function parseGameLink(text) {
  const t = (text || '').trim();
  let m = t.match(/chess\.com\/(?:analysis\/)?(?:game\/)?(live|daily)(?:\/game)?\/(\d+)/i);
  if (m) return { site: 'chesscom', type: m[1].toLowerCase(), id: m[2] };
  m = t.match(/chess\.com\/(?:analysis\/)?game\/(\d+)/i);
  if (m) return { site: 'chesscom', type: 'live', id: m[1] };
  m = t.match(/lichess\.org\/([a-zA-Z0-9]{8})/);
  if (m) return { site: 'lichess', id: m[1] };
  return null;
}

// chess.com's compact move encoding (two characters per move)
const TCN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=';
export function decodeTcn(str) {
  const out = [];
  for (let i = 0; i + 1 < str.length; i += 2) {
    const from = TCN.indexOf(str[i]);
    let to = TCN.indexOf(str[i + 1]);
    let promotion;
    if (to > 63) {
      promotion = 'qnrbkp'[Math.floor((to - 64) / 3)];
      to = from + (from < 16 ? -8 : 8) + ((to - 1) % 3) - 1;
    }
    out.push({ from: TCN[from % 8] + (Math.floor(from / 8) + 1), to: TCN[to % 8] + (Math.floor(to / 8) + 1), promotion });
  }
  return out;
}

function gameFromTcn(cg, link, username) {
  const h = cg.pgnHeaders || {};
  const headers = {};
  for (const [k, v] of Object.entries(h)) headers[k] = String(v);
  const chess = headers.FEN ? new Chess(headers.FEN) : new Chess();
  const tokens = [];
  for (const mv of decodeTcn(cg.moveList || '')) {
    try { tokens.push({ san: chess.move(mv).san }); } catch { break; }
  }
  return gameFromParts({ headers, tokens }, { username, id: `cc-${link.type}-${link.id}`, url: `https://www.chess.com/game/${link.type}/${link.id}` });
}

export async function fetchGameByLink(link, username) {
  if (link.site === 'lichess') {
    // the single-game export now needs a login; the batch export by ids still works anonymously
    const res = await fetch('https://lichess.org/api/games/export/_ids?clocks=true&evals=false&opening=true',
      { method: 'POST', headers: { Accept: 'application/x-chess-pgn' }, body: link.id });
    if (res.status === 429) throw new Error('RATE_LIMIT');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const pgn = (await res.text()).trim();
    if (!pgn) throw new Error('NOT_FOUND');
    return gameFromPgn(pgn, { username, id: 'li-' + link.id, url: 'https://lichess.org/' + link.id });
  }
  const res = await fetch(`api/chesscom-game?type=${link.type}&id=${link.id}`);
  if (res.status === 404) throw new Error('NOT_FOUND');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const cg = (await res.json()).game;
  if (!cg) throw new Error('NOT_FOUND');
  if (cg.type && cg.type !== 'chess') throw new Error('VARIANT');
  const h = cg.pgnHeaders || {};
  const players = [h.White, h.Black].filter(Boolean).map((p) => String(p).toLowerCase());
  const persp = username && players.includes(username.toLowerCase()) ? username.toLowerCase() : players[0];
  // the public archive has the full PGN with clocks; the move list is the fallback
  const months = [...new Set([h.EndDate, h.Date].filter(Boolean).map((d) => String(d).split('.').slice(0, 2).join('/')))];
  for (const player of players) {
    for (const ym of months) {
      try {
        const month = await getJson(`${API}${encodeURIComponent(player)}/games/${ym}`);
        const found = (month.games || []).find((x) => x.url && x.url.endsWith('/' + link.id));
        if (found) {
          const g = parseGame(found, persp);
          if (g) return g;
        }
      } catch { /* try the next archive */ }
    }
  }
  return gameFromTcn(cg, link, persp);
}
