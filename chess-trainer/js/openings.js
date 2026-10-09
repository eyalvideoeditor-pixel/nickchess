// Opening trainer: learn a line move by move with Nick, then play it from memory (spaced repetition).
import { h, fill } from './util.js';
import { Board } from './board.js';
import { Chess, moveToUci } from './chessutil.js';
import { OPENINGS, OPENING_ORDER, lineProgress, lineStatus } from './openings-data.js';
import { nickSays } from './nick.js';
import { shuffle } from './analysis.js';

const sideHe = (c) => (c === 'w' ? 'לבן' : 'שחור');

function lineToItem(key, line) {
  const op = OPENINGS[key];
  const c = new Chess();
  const moves = [], sans = [], notes = [];
  for (const [san, note] of line.moves) {
    const m = c.move(san);
    moves.push(moveToUci(m)); sans.push(m.san); notes.push(note);
  }
  return {
    kind: 'line', fen: new Chess().fen(), moves, sans, notes, side: op.side,
    title: `${op.name}: ${line.name}`, openingKey: key, lineId: line.id,
  };
}

function lineText(line, upTo = 6) {
  return line.moves.slice(0, upTo * 2).map(([san], i) => (i % 2 === 0 ? `${i / 2 + 1}.${san}` : san)).join(' ')
    + (line.moves.length > upTo * 2 ? ' …' : '');
}

function finalFen(line) {
  const c = new Chess();
  for (const [san] of line.moves) c.move(san);
  return c.fen();
}

function dueItems() {
  const items = [];
  for (const key of OPENING_ORDER) {
    for (const line of OPENINGS[key].lines) {
      const p = lineProgress(key, line.id);
      if (p.total && p.due <= Date.now()) items.push(lineToItem(key, line));
    }
  }
  return items;
}

function thumb(fen, orientation) {
  const el = h('div', { class: 'cg-wrap board thumb' });
  setTimeout(() => { const b = new Board(el); b.set(fen, { orientation }); b.lock(); });
  return h('div', { class: 'board-box', dir: 'ltr' }, el);
}

export function renderOpenings(v, parts, ctx) {
  const key = parts[0];
  if (key && OPENINGS[key] && parts[1]) return renderLearn(v, key, parts[1], ctx);
  if (key && OPENINGS[key]) return renderOpening(v, key, ctx);
  return renderList(v, ctx);
}

// ---------------- all openings ----------------

function renderList(v, ctx) {
  const due = dueItems();
  fill(v,
    h('div', { class: 'page-head row-between' },
      h('div', {}, h('h2', {}, 'מאמן פתיחות'),
        h('p', { class: 'muted' }, 'רפרטואר קטן וחזק: שתי פתיחות ללבן עם d4/c4, אחת עם e4, והגנה מוצקה לשחור.')),
      due.length ? h('button', { class: 'btn primary', onclick: () => ctx.startSession({
        title: 'חזרה על פתיחות', subtitle: `${due.length} קווים`, items: shuffle(due), drill: 'line',
      }) }, `🔁 חזרה על ${due.length} קווים שהגיע זמנם`) : null),
    nickSays('בחר פתיחה ואני אלמד אותך את הקווים החשובים — מהלך אחרי מהלך, עם ההסבר למה. אחר כך תשחק אותם מהזיכרון, וכל קו יחזור אליך בדיוק כשצריך לחזור עליו.'),
    h('div', { class: 'opening-grid' }, OPENING_ORDER.map((key) => {
      const op = OPENINGS[key];
      const progress = op.lines.map((l) => lineProgress(key, l.id));
      const learned = progress.filter((p) => p.total > 0).length;
      const mastered = progress.filter((p) => p.level >= 4).length;
      return h('a', { class: 'opening-card card', href: `#/openings/${key}` },
        thumb(finalFen(op.lines[0]), op.side),
        h('div', { class: 'oc-body' },
          h('div', { class: 'oc-title' }, h('span', { class: 'oc-icon' }, op.icon), h('b', {}, op.name)),
          h('div', { class: 'muted small', dir: 'ltr' }, op.en),
          h('div', { class: 'chips' }, h('span', { class: 'chip small' }, `משחקים ב${sideHe(op.side)}`), h('span', { class: 'chip small' }, op.level),
            h('span', { class: 'chip small' }, `${op.lines.length} קווים`)),
          h('p', { class: 'small' }, op.intro),
          h('div', { class: 'cat-bar' }, h('span', { style: { width: (learned / op.lines.length * 100) + '%' } })),
          h('div', { class: 'small muted' }, `${learned}/${op.lines.length} נלמדו · ${mastered} בשליטה`)));
    })));
}

// ---------------- one opening ----------------

function renderOpening(v, key, ctx) {
  const op = OPENINGS[key];
  const all = op.lines.map((l) => lineToItem(key, l));
  fill(v,
    h('div', { class: 'page-head row-between' },
      h('div', {},
        h('h2', {}, op.icon, ' ', op.name, ' ', h('span', { class: 'muted', dir: 'ltr' }, `(${op.en})`)),
        h('div', { class: 'chips' }, h('span', { class: 'chip' }, `אתה משחק ב${sideHe(op.side)}`), h('span', { class: 'chip' }, op.level))),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => ctx.startSession({
          title: 'תרגול פתיחה', subtitle: op.name, items: shuffle([...all]), drill: 'line',
        }) }, '🎯 תרגל את כל הקווים'),
        h('a', { class: 'btn ghost', href: '#/openings' }, 'כל הפתיחות'))),
    nickSays([
      h('p', {}, op.intro),
      h('div', { class: 'small' }, h('b', {}, 'הרעיונות שחייבים לזכור:')),
      h('ul', { class: 'ideas' }, op.ideas.map((t) => h('li', {}, t))),
    ], { size: 'lg' }),
    h('h3', { class: 'sec-title' }, 'הקווים'),
    h('div', { class: 'line-list' }, op.lines.map((line, i) => {
      const p = lineProgress(key, line.id);
      const st = lineStatus(p);
      return h('div', { class: 'line-card card' },
        h('div', { class: 'lc-main' },
          h('div', { class: 'lc-title' }, h('b', {}, line.name), h('span', { class: 'status ' + st.cls }, st.label)),
          h('div', { class: 'muted small', dir: 'ltr' }, lineText(line)),
          h('div', { class: 'small muted' }, `${Math.ceil(line.moves.length / 2)} מהלכים`, p.total ? ` · ${p.ok}/${p.total} הצלחות` : '')),
        h('div', { class: 'row' },
          h('a', { class: 'btn small', href: `#/openings/${key}/${line.id}` }, '📖 למד'),
          h('button', { class: 'btn primary small', onclick: () => ctx.startSession({
            title: 'תרגול פתיחה', subtitle: line.name, items: [all[i]], drill: 'line',
          }) }, '🎯 תרגל')));
    })));
}

// ---------------- learn a line ----------------

function renderLearn(v, key, lineId, ctx) {
  const op = OPENINGS[key];
  const line = op.lines.find((l) => l.id === lineId);
  if (!line) return renderOpening(v, key, ctx);
  const item = lineToItem(key, line);
  const n = item.moves.length;
  const fens = [item.fen];
  { const c = new Chess(); for (const u of item.moves) { c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); fens.push(c.fen()); } }
  let cur = 0;
  const boardEl = h('div', { class: 'cg-wrap board' });
  const nick = nickSays('', { className: 'learn-nick' });
  const moves = h('div', { class: 'moves', dir: 'ltr' });
  let board;

  function show(k, speak = true) {
    cur = Math.max(0, Math.min(n, k));
    board.set(fens[cur], { orientation: op.side, lastMove: cur ? item.moves[cur - 1] : null });
    if (cur < n && cur > 0) board.arrows([]);
    if (cur === 0) {
      nick.setContent([h('p', {}, h('b', {}, line.name)),
        h('p', {}, `בוא נלמד את הקו הזה. אתה משחק ב${sideHe(op.side)}. לחץ ▶ (או חץ ימינה) כדי לראות כל מהלך ולמה משחקים אותו.`)], speak, 'happy');
    } else {
      const i = cur - 1;
      const color = i % 2 === 0 ? 'w' : 'b';
      const mine = color === op.side;
      nick.setContent([
        h('div', { class: 'learn-move' }, h('span', { dir: 'ltr' }, `${Math.floor(i / 2) + 1}${i % 2 === 0 ? '.' : '...'} ${item.sans[i]}`),
          h('span', { class: 'chip small' }, mine ? 'המהלך שלך' : 'היריב')),
        h('p', {}, item.notes[i]),
        cur === n ? h('p', {}, h('b', {}, 'זה סוף הקו! עכשיו נסה לשחק אותו מהזיכרון.')) : null,
      ], speak, cur === n ? 'excited' : mine ? 'happy' : 'thinking');
    }
    moves.querySelectorAll('.mv').forEach((el) => el.classList.toggle('cur', Number(el.dataset.i) === cur - 1));
  }

  for (let i = 0; i < n; i += 2) {
    const row = h('div', { class: 'mrow' }, h('span', { class: 'mn' }, Math.floor(i / 2) + 1 + '.'));
    for (const j of [i, i + 1]) {
      if (j >= n) { row.append(h('span', { class: 'mv empty' })); continue; }
      const mine = (j % 2 === 0 ? 'w' : 'b') === op.side;
      row.append(h('span', { class: 'mv' + (mine ? ' mine' : ''), 'data-i': j, onclick: () => show(j + 1) }, item.sans[j]));
    }
    moves.append(row);
  }

  const practice = () => ctx.startSession({ title: 'תרגול פתיחה', subtitle: line.name, items: [item], drill: 'line' });
  fill(v,
    h('div', { class: 'page-head row-between' },
      h('div', {}, h('h2', {}, op.icon, ' ', op.name), h('div', { class: 'muted' }, line.name)),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: practice }, '🎯 תרגל את הקו מהזיכרון'),
        h('a', { class: 'btn ghost', href: `#/openings/${key}` }, 'כל הקווים'))),
    h('div', { class: 'viewer' },
      h('div', { class: 'board-col' },
        h('div', { class: 'board-box', dir: 'ltr' }, boardEl),
        h('div', { class: 'nav-btns', dir: 'ltr' },
          h('button', { class: 'btn small', onclick: () => show(0) }, '⏮'),
          h('button', { class: 'btn small', onclick: () => show(cur - 1) }, '◀'),
          h('button', { class: 'btn small', onclick: () => show(cur + 1) }, '▶'),
          h('button', { class: 'btn small', onclick: () => show(n) }, '⏭'))),
      h('div', { class: 'side card' }, nick, moves)));

  const onKey = (e) => {
    if (!document.body.contains(moves)) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'ArrowRight') { show(cur + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { show(cur - 1); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);
  board = new Board(boardEl);
  show(0, false);
}
