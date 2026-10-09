import { h, fill, store, toast } from './util.js';
import { Board } from './board.js';
import { getQuickEngine } from './engine.js';
import {
  Chess, sanOf, pvToSan, tryMove, toWhiteCp, winChance, sideToMove, formatEval,
} from './chessutil.js';
import { themeName, ERROR_TYPE_LABEL } from './content.js';
import { recordPuzzle, recordDrill, progress } from './puzzles.js';
import { nickSays, textOf, voice } from './nick.js';
import { recordLine } from './openings-data.js';
import { maybeQuip, quip } from './quips.js';

const BC_KEY = 'ct_blunder_check';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const colorHe = (c) => (c === 'w' ? 'הלבן' : 'השחור');

async function evalWhite(fen, depth = 13) {
  const eng = getQuickEngine();
  await eng.init();
  const c = new Chess(fen);
  if (c.isCheckmate()) return { cpW: c.turn() === 'w' ? -10000 : 10000, best: null, pv: [] };
  if (c.isDraw()) return { cpW: 0, best: null, pv: [] };
  const r = await eng.evaluate(fen, { depth });
  return { cpW: toWhiteCp(r, fen), best: r.best, pv: r.pv };
}
const povCp = (cpW, color) => (color === 'w' ? cpW : -cpW);
const wcFor = (cpW, color) => winChance(povCp(cpW, color));

/**
 * A training session over a queue of items.
 *  item.kind = 'puzzle' | 'find' | 'safe' | 'line'
 *  opts: { title, subtitle, items, loadMore?: async () => items[], drill?: string, onExit }
 */
export class Session {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.items = [...opts.items];
    this.i = 0;
    this.results = [];
    this.blunderCheck = !!store.get(BC_KEY);
    this.render();
    this.start();
  }

  render() {
    const boardEl = h('div', { class: 'cg-wrap board' });
    this.boardEl = boardEl;
    this.prompt = h('div', { class: 'prompt' });
    this.feedback = h('div', { class: 'feedback' });
    this.actions = h('div', { class: 'actions' });
    this.meta = h('div', { class: 'meta' });
    this.counter = h('span', { class: 'counter' });
    this.timer = h('span', { class: 'timer' });
    this.confirmBox = h('div', { class: 'confirm hidden' });
    // Nick says everything the player needs to know: the task, the feedback, the blunder check
    this.nick = nickSays([this.prompt, this.confirmBox, this.feedback], { className: 'session-nick' });
    const bcToggle = h('label', { class: 'switch', title: 'אחרי כל מהלך תתבקש לאשר אותו — כמו בדיקת בלנדר בזמן משחק' },
      h('input', { type: 'checkbox', checked: this.blunderCheck || null, onchange: (e) => {
        this.blunderCheck = e.target.checked; store.set(BC_KEY, this.blunderCheck);
      } }),
      h('span', { class: 'slider' }), ' מצב בדיקת בלנדר');
    fill(this.root,
      h('div', { class: 'session' },
        h('div', { class: 'board-col' }, h('div', { class: 'board-box', dir: 'ltr' }, boardEl)),
        h('div', { class: 'side card' },
          h('div', { class: 'side-head' },
            h('button', { class: 'btn ghost small', onclick: () => this.exit() }, '→ חזרה'),
            h('div', { class: 'side-title' }, h('b', {}, this.opts.title), this.opts.subtitle ? h('small', {}, this.opts.subtitle) : null),
            h('div', { class: 'side-stats' }, this.counter, this.timer)),
          this.nick, this.actions, this.meta,
          h('div', { class: 'side-foot' }, bcToggle))));
    this.board = new Board(boardEl, { onMove: (uci, m) => this._onUserMove(uci, m) });
  }

  destroy() {
    clearInterval(this._tick);
    voice.stop();
    this.item = null;
    this.board.destroy();
  }

  exit() {
    this.destroy();
    this.opts.onExit && this.opts.onExit(this.results);
  }

  async start() {
    if (!this.items.length && this.opts.loadMore) await this._more();
    if (!this.items.length) {
      fill(this.prompt, h('div', { class: 'empty' }, 'אין כאן פריטים עדיין.'));
      return;
    }
    this.load();
  }

  async _more() {
    try {
      fill(this.prompt, h('div', { class: 'loading' }, 'טוען חידות...'));
      const more = await this.opts.loadMore();
      const seen = new Set(this.items.map((x) => x.id).filter(Boolean));
      this.items.push(...more.filter((x) => !x.id || !seen.has(x.id)));
    } catch (e) {
      toast(e.message === 'RATE_LIMIT' ? 'Lichess מגביל בקשות — נסה שוב בעוד דקה' : 'לא הצלחתי לטעון חידות נוספות');
    }
  }

  updateCounter() {
    const ok = this.results.filter((r) => r.ok).length;
    const bad = this.results.length - ok;
    const total = this.items.length + (this.opts.loadMore ? '+' : '');
    fill(this.counter, 
      h('span', {}, `${Math.min(this.i + 1, this.items.length)} / ${total}`),
      h('span', { class: 'ok' }, ` ✔ ${ok}`), h('span', { class: 'bad' }, ` ✖ ${bad}`));
  }

  load() {
    const item = this.items[this.i];
    this.item = item;
    this.state = { failed: false, hinted: 0, done: false, busy: false };
    fill(this.feedback, );
    fill(this.meta, );
    this.confirmBox.classList.add('hidden');
    this.updateCounter();
    clearInterval(this._tick);
    const t0 = Date.now();
    this._tick = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      if (s >= 75 && !this.state.done && !this.state.tired) { this.state.tired = true; this.nick.setMood('tired'); if (!this.feedback.textContent) fill(this.feedback, h('div', { class: 'quip' }, quip('tired'))); }
      this.timer.textContent = ` ⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
    if (item.kind === 'puzzle') this._loadPuzzle(item);
    else if (item.kind === 'find') this._loadFind(item);
    else if (item.kind === 'safe') this._loadSafe(item);
    else if (item.kind === 'line') this._loadLine(item);
  }

  setActions(...btns) { fill(this.actions, ...btns.filter(Boolean)); }

  btn(label, fn, cls = '') { return h('button', { class: 'btn ' + cls, onclick: fn }, label); }

  nextBtn() {
    return this.btn('הבא ←', () => this.next(), 'primary');
  }

  async next() {
    if (this.i + 1 >= this.items.length) {
      if (this.opts.loadMore) {
        await this._more();
        if (this.i + 1 >= this.items.length) return this.summary();
      } else return this.summary();
    }
    this.i++;
    this.load();
  }

  finish(ok) {
    if (this.state.done) return;
    this.state.done = true;
    clearInterval(this._tick);
    if (this.state.recorded) return;
    this.state.recorded = true;
    this.results.push({ item: this.item, ok });
    this.updateCounter();
    if (this.item.kind === 'puzzle') {
      const p = recordPuzzle(this.item, ok);
      this.meta.prepend(h('div', { class: 'rating-line' }, `דירוג החידות שלך: ${p.rating}`));
    } else if (this.item.kind === 'line') recordLine(this.item.openingKey, this.item.lineId, ok);
    else recordDrill(this.opts.drill || this.item.kind, ok);
    window.dispatchEvent(new Event('ct-progress'));
  }

  summary() {
    clearInterval(this._tick);
    const ok = this.results.filter((r) => r.ok).length;
    const failed = this.results.filter((r) => !r.ok).map((r) => r.item);
    this.board.lock();
    fill(this.prompt, 
      h('div', { class: 'summary' },
        h('div', { class: 'big' }, `${ok} / ${this.results.length}`),
        h('div', {}, ok === this.results.length ? 'מושלם! 🔥' : 'סיימת את הסבב.'),
        failed.length ? h('p', { class: 'muted' }, 'שיטת "הנקר" (Woodpecker): חזרה על אותן עמדות שוב ושוב היא מה שבונה את הזיהוי האוטומטי.') : null));
    fill(this.feedback, );
    this.nick.say(textOf(this.prompt), ok === this.results.length ? 'excited' : 'proud');
    this.setActions(
      failed.length ? this.btn(`חזור על ${failed.length} שנכשלו`, () => {
        this.items = failed.map((x) => ({ ...x })); this.i = 0; this.results = []; this.load();
      }, 'primary') : null,
      this.btn('סיום', () => this.exit()));
  }

  // mood follows the kind of message unless given: good -> happy, bad -> sad, ...
  say(msg, cls = '', { speak = true, withPrompt = false, mood = null } = {}) {
    const m = mood || { good: 'happy', bad: 'sad', info: 'calm', muted: 'thinking' }[cls] || 'calm';
    const kind = cls === 'good' ? (m === 'excited' ? 'great' : 'good') : cls === 'bad' ? (m === 'hungry' ? 'hungry' : 'bad')
      : m === 'thinking' && cls !== 'muted' ? 'thinking' : null;
    const extra = kind ? maybeQuip(kind, kind === 'great' ? 0.7 : 0.4) : '';
    fill(this.feedback, h('div', { class: 'msg ' + cls }, msg, extra ? h('div', { class: 'quip' }, extra) : null));
    if (speak) this.nick.say((withPrompt ? textOf(this.prompt) : '') + textOf(this.feedback), m);
    else this.nick.setMood(m);
  }

  // ---------- blunder-check confirmation ----------
  _confirm(san) {
    return new Promise((resolve) => {
      this.confirmBox.classList.remove('hidden');
      fill(this.confirmBox, 
        h('div', { class: 'confirm-title' }, `🛑 בדיקת בלנדר — ${san}`),
        h('ul', {},
          h('li', {}, 'אילו שחים יש ליריב אחרי המהלך?'),
          h('li', {}, 'אילו אכילות יש לו? מה הכלי שזז הפסיק להגן?'),
          h('li', {}, 'מה האיום הכי חזק שלו?')),
        h('div', { class: 'row' },
          this.btn('אשר מהלך ✓', () => { this.confirmBox.classList.add('hidden'); resolve(true); }, 'primary'),
          this.btn('בטל', () => { this.confirmBox.classList.add('hidden'); resolve(false); })));
      this.nick.say(textOf(this.confirmBox), 'warning');
    });
  }

  async _onUserMove(uci, m) {
    if (this.state.busy || this.state.done) return;
    const before = this._fenBeforeUser;
    if (this.blunderCheck && this.item.kind !== 'safe' && this.item.kind !== 'line') {
      this.state.busy = true;
      const ok = await this._confirm(m.san);
      this.state.busy = false;
      if (!ok) { this._resetToUser(); return; }
    }
    if (this.item.kind === 'puzzle') this._puzzleMove(uci, m, before);
    else if (this.item.kind === 'find' || this.item.kind === 'safe') this._findMove(uci, m, before);
    else if (this.item.kind === 'line') this._lineMove(uci, m);
  }

  _resetToUser() {
    this.board.set(this._fenBeforeUser, { lastMove: this._lastMove, interactive: this._userColor });
  }

  _waitUser(color) {
    this._fenBeforeUser = this.board.fen();
    this._userColor = color;
  }

  // ---------- Lichess-style puzzle ----------
  async _loadPuzzle(p) {
    const opp = sideToMove(p.fen);
    const me = opp === 'w' ? 'b' : 'w';
    this.state.idx = 0;
    this.board.set(p.fen, { orientation: me, interactive: null });
    fill(this.prompt, 
      h('div', { class: 'turn ' + (me === 'w' ? 'white' : 'black') }, `תורך — ${colorHe(me)} משחק`),
      h('div', { class: 'muted' }, 'מצא את המהלך הטוב ביותר' + (p.moves.length > 4 ? ` (${Math.floor(p.moves.length / 2)} מהלכים)` : '')));
    this._puzzleMeta(p);
    this.setActions(this.btn('💡 רמז', () => this._puzzleHint()), this.btn('הצג פתרון', () => this._puzzleSolution()));
    await sleep(450);
    if (this.item !== p) return;
    const first = this.board.play(p.moves[0], { interactive: me });
    this._lastMove = p.moves[0];
    this.state.idx = 1;
    this._waitUser(me);
    this.say(`היריב שיחק ${first.san}`, '', { withPrompt: true, mood: 'thinking' });
  }

  _puzzleMeta(p) {
    const chips = (p.themes || []).filter((t) => !['short', 'long', 'oneMove'].includes(t) || p.themes.length < 3)
      .map((t) => h('span', { class: 'chip' }, themeName(t)));
    fill(this.meta, 
      h('div', { class: 'chips' }, chips),
      h('div', { class: 'meta-line' },
        p.rating ? h('span', {}, `דירוג חידה: ${p.rating}`) : null,
        p.pop ? h('span', {}, `👍 ${p.pop}%`) : null,
        p.plays ? h('span', {}, `${p.plays.toLocaleString('he-IL')} פתרו`) : null,
        p.game ? h('a', { href: p.game, target: '_blank', rel: 'noopener' }, 'המשחק המקורי ↗') : null));
  }

  _puzzleHint() {
    const p = this.item; if (this.state.done) return;
    const exp = p.moves[this.state.idx];
    this.state.hinted++; this.state.failed = true;
    if (this.state.hinted === 1) this.board.arrows([{ square: exp.slice(0, 2), brush: 'blue' }]);
    else this.board.arrows([{ uci: exp, brush: 'blue' }]);
  }

  async _puzzleSolution() {
    const p = this.item; if (this.state.done) return;
    this.state.failed = true; this.state.busy = true;
    this.finish(false);
    this.board.lock();
    this.setActions(this.nextBtn());
    const sans = [];
    while (this.state.idx < p.moves.length && this.item === p) {
      const m = this.board.play(p.moves[this.state.idx]);
      sans.push(m.san);
      this.state.idx++;
      await sleep(650);
    }
    this.say('הפתרון: ' + sans.join(' '), 'info');
  }

  async _puzzleMove(uci, m) {
    const p = this.item;
    const exp = p.moves[this.state.idx];
    let correct = uci === exp || (exp.length === 5 && uci.slice(0, 4) === exp.slice(0, 4) && uci.length === 5);
    if (!correct && this.board.chess.isCheckmate()) correct = true; // any mate is accepted
    if (!correct) {
      this.state.failed = true;
      this.say(`${m.san} — לא זה. נסה שוב.`, 'bad', { mood: Math.random() < 0.5 ? 'facepalm' : 'sad' });
      this.board.arrows([{ uci, brush: 'red' }]);
      await sleep(700);
      if (this.item !== p) return;
      this._resetToUser();
      return;
    }
    this.board.arrows([]);
    this.state.idx++;
    if (this.state.idx >= p.moves.length || this.board.chess.isCheckmate()) {
      this.say(this.state.failed ? 'נפתר (עם עזרה) ✔' : 'מצוין! נפתר ✔', 'good', { mood: this.state.failed ? 'happy' : 'excited' });
      this.finish(!this.state.failed);
      this.board.lock();
      this.setActions(this.nextBtn());
      return;
    }
    this.say(`${m.san} ✔ — המשך...`, 'good');
    this.board.lock();
    await sleep(420);
    if (this.item !== p) return;
    const reply = this.board.play(p.moves[this.state.idx], { interactive: this._userColor });
    this._lastMove = p.moves[this.state.idx];
    this.state.idx++;
    this._waitUser(this._userColor);
    this.say(`${m.san} ✔ — היריב: ${reply.san}. המשך!`, 'good');
  }

  // ---------- "find a better move" / "punish it" ----------
  async _loadFind(it) {
    this.board.set(it.fen, { orientation: it.color, lastMove: it.lastMove, interactive: it.color });
    this._lastMove = it.lastMove;
    this._waitUser(it.color);
    const typeLbl = it.type ? ERROR_TYPE_LABEL[it.type] : '';
    if (it.mode === 'punish') {
      fill(this.prompt, 
        h('div', { class: 'turn ' + (it.color === 'w' ? 'white' : 'black') }, `אתה היריב — ${colorHe(it.color)} משחק`),
        h('div', {}, `במשחק נגד ${it.opp} (מהלך ${it.moveNo}) שיחקת `, h('b', {}, it.playedSan), '. איך מענישים את זה?'));
    } else {
      fill(this.prompt, 
        h('div', { class: 'turn ' + (it.color === 'w' ? 'white' : 'black') }, `תורך — ${colorHe(it.color)} משחק`),
        h('div', {}, `במשחק נגד ${it.opp} (מהלך ${it.moveNo}) שיחקת כאן `, h('b', { class: 'bad-text' }, it.playedSan),
          typeLbl ? ` (${typeLbl})` : '', '. מצא מהלך טוב יותר.'));
    }
    if (it.gameUrl) fill(this.meta, h('a', { href: it.gameUrl, target: '_blank', rel: 'noopener' }, 'המשחק ב-chess.com ↗'));
    this.setActions(this.btn('💡 רמז', () => this._findHint()), this.btn('הצג פתרון', () => this._findSolution()));
    this.nick.say(textOf(this.prompt), it.mode === 'punish' ? 'angry' : 'thinking');
    // warm up the engine and cache the reference evaluation
    this._ref = evalWhite(it.fen).catch(() => null);
  }

  _findHint() {
    const it = this.item; if (this.state.done) return;
    this.state.hinted++; this.state.failed = true;
    const best = it.kind === 'safe' ? it.refutation : it.best;
    if (this.state.hinted === 1) this.board.arrows([{ square: best.slice(0, 2), brush: 'blue' }]);
    else this.board.arrows([{ uci: best, brush: 'blue' }]);
  }

  async _findSolution() {
    const it = this.item; if (this.state.done) return;
    this.finish(false);
    const best = it.kind === 'safe' ? it.refutation : it.best;
    const pv = it.kind === 'safe' ? it.refutationPv : it.bestPv;
    this._resetToUser();
    this.board.lock();
    this.board.arrows([{ uci: best, brush: 'green' }]);
    const line = pvToSan(this._fenBeforeUser, pv && pv[0] === best ? pv : [best], 6);
    this.say(h('span', {}, 'המהלך הנכון: ', h('b', {}, line[0] || sanOf(this._fenBeforeUser, best)),
      line.length > 1 ? h('div', { class: 'muted' }, 'ההמשך: ' + line.join(' ')) : null), 'info');
    this.setActions(this.nextBtn());
  }

  async _findMove(uci, m, fenBefore) {
    const it = this.item;
    const best = it.kind === 'safe' ? it.refutation : it.best;
    const color = this._userColor;
    if (uci === best || this.board.chess.isCheckmate()) return this._findCorrect(m, true);
    if (it.avoid && uci === it.avoid) {
      this.say('זה בדיוק המהלך ששיחקת במשחק 🙂 נסה משהו אחר.', 'bad', { mood: 'facepalm' });
      this.state.failed = true;
      await sleep(900);
      if (this.item === it) this._resetToUser();
      return;
    }
    this.state.busy = true;
    this.board.lock();
    this.say('המנוע בודק את המהלך...', 'muted', { speak: false });
    try {
      const [ref, mine] = await Promise.all([this._ref || evalWhite(fenBefore), evalWhite(this.board.fen())]);
      if (this.item !== it) return;
      const refWc = ref ? wcFor(ref.cpW, color) : 1;
      const myWc = wcFor(mine.cpW, color);
      const loss = refWc - myWc;
      this.state.busy = false;
      if (loss <= 0.06) return this._findCorrect(m, false, povCp(mine.cpW, color));
      this.state.failed = true;
      const reply = mine.best ? sanOf(this.board.fen(), mine.best) : null;
      this.say(h('span', {}, `${m.san} — לא מספיק טוב (${formatEval(povCp(mine.cpW, color))} בשבילך).`,
        reply ? h('div', {}, 'התשובה של היריב: ', h('b', {}, reply)) : null), 'bad');
      if (mine.best) this.board.arrows([{ uci: mine.best, brush: 'red' }]);
      await sleep(1600);
      if (this.item === it && !this.state.done) this._resetToUser();
    } catch (e) {
      this.state.busy = false;
      this.say('בדיקת המנוע נכשלה — נסה שוב.', 'bad');
      this._resetToUser();
    }
  }

  _findCorrect(m, exact, cpW) {
    const it = this.item;
    const best = it.kind === 'safe' ? it.refutation : it.best;
    const pv = it.kind === 'safe' ? it.refutationPv : it.bestPv;
    this.board.lock();
    this.board.arrows([]);
    const line = pvToSan(this._fenBeforeUser, pv && pv[0] === best ? pv : [best], 6);
    const text = exact
      ? (this.state.failed ? 'נכון ✔ (בניסיון חוזר)' : 'מצוין! בדיוק המהלך של המנוע ✔')
      : `גם ${m.san} מהלך טוב ✔` + (cpW !== undefined ? ` (${formatEval(cpW)})` : '');
    this.say(h('span', {}, text,
      line.length ? h('div', { class: 'muted' }, 'קו המנוע: ' + line.join(' ')) : null), 'good');
    this.finish(!this.state.failed);
    this.setActions(this.nextBtn());
  }

  // ---------- "safe or blunder?" ----------
  _loadSafe(it) {
    this.board.set(it.fen, { orientation: it.color, lastMove: it.lastMove, interactive: null });
    this._lastMove = it.lastMove;
    this.board.arrows([{ uci: it.move, brush: 'yellow' }]);
    fill(this.prompt, 
      h('div', { class: 'turn ' + (it.color === 'w' ? 'white' : 'black') }, `${colorHe(it.color)} שוקל לשחק`),
      h('div', { class: 'muted small' }, it.source === 'puzzle' ? 'מתוך משחק אמיתי ב-Lichess' : `מהמשחק שלך נגד ${it.opp} (מהלך ${it.moveNo})`),
      h('div', { class: 'candidate' }, it.san),
      h('div', { class: 'muted' }, 'עשה בדיקת בלנדר: שחים, אכילות ואיומים של היריב אחרי המהלך. האם המהלך בטוח?'));
    this.setActions(
      this.btn('✅ בטוח', () => this._safeAnswer(false), 'safe-btn'),
      this.btn('💥 בלנדר', () => this._safeAnswer(true), 'blunder-btn'));
    this.nick.say(textOf(this.prompt), 'warning');
  }

  async _safeAnswer(saysUnsafe) {
    const it = this.item;
    if (this.state.answered) return;
    this.state.answered = true;
    const correct = saysUnsafe === it.unsafe;
    const opp = it.color === 'w' ? 'b' : 'w';
    this.board.arrows([]);
    this.board.play(it.move, { interactive: correct && it.unsafe ? opp : null });
    if (!it.unsafe) {
      this.say(correct ? 'נכון — המהלך הזה בטוח ✔' : 'בעצם המהלך הזה בטוח. לא כל מהלך הוא מלכודת 🙂', correct ? 'good' : 'bad');
      this.finish(correct);
      this.setActions(this.nextBtn());
      return;
    }
    if (!correct) {
      const line = pvToSan(this.board.fen(), it.refutationPv && it.refutationPv[0] === it.refutation ? it.refutationPv : [it.refutation], 5);
      this.board.arrows([{ uci: it.refutation, brush: 'red' }]);
      this.say(h('span', { class: 'shock' }, '💥 זה בלנדר! היריב משחק ', h('b', {}, line[0]),
        line.length > 1 ? h('div', { class: 'muted' }, line.join(' ')) : null,
        it.bestSan ? h('div', {}, 'עדיף היה: ', h('b', {}, it.bestSan)) : null), 'bad', { mood: 'shocked' });
      this.finish(false);
      this.setActions(this.nextBtn());
      return;
    }
    // correct "blunder" call counts as a success; finding the refutation is the bonus round
    this.state.recorded = true;
    this.results.push({ item: it, ok: true });
    this.updateCounter();
    recordDrill(this.opts.drill || 'safety', true);
    this._lastMove = it.move;
    this._waitUser(opp);
    this.say('נכון! זה בלנדר. עכשיו הראה איך היריב מעניש — שחק את המהלך שלו.', 'good');
    this._ref = evalWhite(this.board.fen()).catch(() => null);
    this.setActions(this.btn('💡 רמז', () => this._findHint()), this.btn('הצג', () => this._findSolution()));
  }

  // ---------- opening line from memory ----------
  async _loadLine(it) {
    this.state.idx = 0;
    this.state.misses = 0;
    this.board.set(it.fen, { orientation: it.side, interactive: null });
    this._lastMove = null;
    fill(this.prompt,
      h('div', { class: 'turn ' + (it.side === 'w' ? 'white' : 'black') }, `אתה משחק ב${it.side === 'w' ? 'לבן' : 'שחור'}`),
      h('div', {}, h('b', {}, it.title)),
      h('div', { class: 'muted' }, 'שחק את המהלכים של הקו מהזיכרון — אני אגיד לך אם זה נכון ולמה.'));
    this.setActions(this.btn('💡 רמז', () => this._lineHint()), this.btn('הצג מהלך', () => this._lineShow()));
    if (sideToMove(it.fen) !== it.side) {
      await sleep(500);
      if (this.item !== it) return;
      const first = this.board.play(it.moves[0], { interactive: it.side });
      this._lastMove = it.moves[0];
      this.state.idx = 1;
      this._waitUser(it.side);
      this.say(`היריב פותח ב-${first.san}. ${it.notes[0]} עכשיו תורך.`, '', { withPrompt: true, mood: 'happy' });
    } else {
      this.board.set(it.fen, { orientation: it.side, interactive: it.side });
      this._waitUser(it.side);
      this.nick.say(textOf(this.prompt));
    }
  }

  _lineHint() {
    const it = this.item; if (this.state.done) return;
    const exp = it.moves[this.state.idx];
    this.state.hinted++; this.state.failed = true;
    if (this.state.hinted === 1) this.board.arrows([{ square: exp.slice(0, 2), brush: 'blue' }]);
    else this.board.arrows([{ uci: exp, brush: 'blue' }]);
  }

  _lineShow() {
    const it = this.item; if (this.state.done || this.state.busy) return;
    this.state.failed = true;
    const exp = it.moves[this.state.idx];
    const m = this.board.play(exp);
    this._lineMove(exp, m, true);
  }

  async _lineMove(uci, m, shown = false) {
    const it = this.item;
    const exp = it.moves[this.state.idx];
    if (uci !== exp) {
      this.state.failed = true;
      this.state.misses++;
      this.board.arrows([{ uci, brush: 'red' }]);
      this.say(this.state.misses >= 2
        ? `${m.san} — לא בקו הזה. הנה רמז: הכלי שצריך לזוז מסומן.`
        : `${m.san} — לא בקו הזה. נסה שוב, חשוב על הרעיון של הפתיחה.`, 'bad', { mood: 'facepalm' });
      await sleep(800);
      if (this.item !== it) return;
      this._resetToUser();
      if (this.state.misses >= 2) this.board.arrows([{ square: exp.slice(0, 2), brush: 'blue' }]);
      return;
    }
    this.board.arrows([]);
    const note = it.notes[this.state.idx];
    this.state.idx++;
    const mark = shown ? '' : ' ✔';
    if (this.state.idx >= it.moves.length) return this._lineDone(`${m.san}${mark} — ${note}`);
    this.state.busy = true;
    this.board.lock();
    await sleep(450);
    this.state.busy = false;
    if (this.item !== it) return;
    const reply = this.board.play(it.moves[this.state.idx], { interactive: it.side });
    const rnote = it.notes[this.state.idx];
    this._lastMove = it.moves[this.state.idx];
    this.state.idx++;
    this._waitUser(it.side);
    if (this.state.idx >= it.moves.length) return this._lineDone(`${m.san}${mark} — ${note} היריב: ${reply.san} — ${rnote}`);
    this.say(`${m.san}${mark} — ${note} היריב: ${reply.san} — ${rnote}`, shown ? 'info' : 'good');
  }

  _lineDone(text) {
    this.board.lock();
    const clean = !this.state.failed;
    this.say(`${text} ${clean ? 'סיימת את הקו בלי טעויות! 🎉' : 'סיימת את הקו. בפעם הבאה — בלי עזרה!'}`, clean ? 'good' : 'info', { mood: clean ? 'excited' : 'proud' });
    this.finish(clean);
    this.setActions(this.nextBtn());
  }
}

export function blunderCheckOn() { return !!store.get(BC_KEY); }
export { progress };
