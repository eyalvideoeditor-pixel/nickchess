// ניק — the dog coach: a speech bubble whose look follows the mood of what he says,
// read aloud with a natural Hebrew neural voice (server.py + edge-tts), or the browser's voice as a fallback.
import { h, store } from './util.js';

const VOICE_KEY = 'ct_voice_on';
const VOICE_NAME_KEY = 'ct_voice_name';
const pic = (name) => `assets/nick-m-${name}.webp`;
export const NICK_HEAD = pic('happy');
export const NICK_FULL = 'assets/nick-m-happy-full.webp';
// the big (portrait) picture for a mood
export function fullPic(mood) {
  const m = MOODS[mood] || MOODS.calm;
  return `assets/nick-m-${m.imgs[0]}-full.webp`;
}

// ---------------- moods: which photo, which effect, how he moves, how he sounds ----------------

export const MOODS = {
  calm: { imgs: ['curious', 'happy'], fx: '', anim: 'breathe', rate: '+0%', pitch: '+0Hz' },
  happy: { imgs: ['happy', 'funny'], fx: '', anim: 'bounce', rate: '+6%', pitch: '+8Hz' },
  excited: { imgs: ['funny', 'happy'], fx: '🎉', anim: 'jump', rate: '+12%', pitch: '+14Hz' },
  proud: { imgs: ['cool'], fx: '✨', anim: 'glow', rate: '+4%', pitch: '+6Hz' },
  funny: { imgs: ['funny'], fx: '', anim: 'bounce', rate: '+10%', pitch: '+12Hz' },
  thinking: { imgs: ['curious'], fx: '', anim: 'sway', rate: '-6%', pitch: '-4Hz' },
  shocked: { imgs: ['surprised', 'angry'], fx: '', anim: 'shake', rate: '+10%', pitch: '+12Hz' },
  angry: { imgs: ['angry'], fx: '', anim: 'shake', rate: '+8%', pitch: '-2Hz' },
  sad: { imgs: ['sad'], fx: '', anim: 'droop', rate: '-12%', pitch: '-12Hz' },
  facepalm: { imgs: ['frustrated'], fx: '', anim: 'droop', rate: '-8%', pitch: '-8Hz' },
  warning: { imgs: ['curious', 'surprised'], fx: '', anim: 'wiggle', rate: '-2%', pitch: '+0Hz' },
  hungry: { imgs: ['hungry'], fx: '', anim: 'wiggle', rate: '+4%', pitch: '+4Hz' },
  tired: { imgs: ['tired'], fx: '💤', anim: 'droop', rate: '-18%', pitch: '-10Hz' },
};
let picTurn = 0;

// ---------------- voices ----------------

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
let browserVoices = [];
let neural = []; // voice ids the local server can speak
const NEURAL_LABEL = { 'he-IL-AvriNeural': 'אבי — קול טבעי (מומלץ)', 'he-IL-HilaNeural': 'הילה — קול טבעי' };

function loadVoices() {
  if (synth) browserVoices = synth.getVoices().filter((v) => /^he|^iw/i.test(v.lang));
  window.dispatchEvent(new Event('ct-voices'));
}
if (synth) {
  loadVoices();
  synth.addEventListener?.('voiceschanged', loadVoices);
}
fetch('api/tts/status').then((r) => r.json()).then((j) => { neural = j.ok ? j.voices : []; loadVoices(); }).catch(() => {});

export function hebrewVoices() { return browserVoices; }

// Current choice: "neural:<id>" or the name of a browser voice
function choice() {
  const saved = store.get(VOICE_NAME_KEY);
  const options = voiceOptions();
  return options.find((o) => o.id === saved) || options[0] || null;
}

export function voiceOptions() {
  return [
    ...neural.map((id) => ({ id: 'neural:' + id, label: NEURAL_LABEL[id] || id })),
    ...browserVoices.map((v) => ({ id: v.name, label: `${v.name} (של הדפדפן)` })),
  ];
}

// split long text into short pieces, so the first one starts playing quickly
function chunks(text, max = 220) {
  const parts = text.match(/[^.!?\n]+[.!?]*\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

let playing = { token: 0, audio: null };
let talkingEls = new Set();
const talk = (el, on) => {
  if (!el) return;
  el.classList.toggle('talking', on);
  if (on) talkingEls.add(el); else talkingEls.delete(el);
};

/**
 * Record a list of lines ahead of time: items = [{ text, mood }]. onStep(done, total).
 * Does nothing (resolves at once) when the voice is off or only the browser voice is available.
 */
export async function prefetchSpeech(items, onStep, isCancelled = () => false) {
  const c = choice();
  if (!voice.enabled || !c || !c.id.startsWith('neural:')) return false;
  const id = c.id.slice(7);
  const urls = [];
  for (const { text, mood } of items) {
    const m = MOODS[mood] || MOODS.calm;
    for (const t of chunks(speakable(text))) urls.push(ttsUrl(t, id, m));
  }
  const todo = [...new Set(urls)].filter((u) => !audioCache.has(u));
  let done = urls.length - todo.length;
  if (onStep) onStep(done, urls.length);
  let next = 0;
  const worker = async () => {
    while (next < todo.length && !isCancelled()) {
      const u = todo[next++];
      try {
        const r = await fetch(u);
        if (r.ok) audioCache.set(u, URL.createObjectURL(await r.blob()));
      } catch { /* that line will stream live instead */ }
      done++;
      if (onStep) onStep(done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return true;
}

export const voice = {
  get supported() { return !!synth || neural.length > 0; },
  get available() { return !!choice(); },
  get enabled() { const v = store.get(VOICE_KEY); return v === null ? true : !!v; },
  set enabled(on) { store.set(VOICE_KEY, !!on); if (!on) this.stop(); window.dispatchEvent(new Event('ct-voice-toggle')); },
  get voiceName() { const c = choice(); return c ? c.label : null; },
  get voiceId() { const c = choice(); return c ? c.id : null; },
  // true while Nick is still talking (used to wait before moving on)
  get busy() { return !!playing.audio || !!(synth && (synth.speaking || synth.pending)); },
  setVoice(id) { store.set(VOICE_NAME_KEY, id); },
  stop() {
    playing.token++;
    if (playing.audio) { playing.audio.pause(); playing.audio = null; }
    if (synth) synth.cancel();
    talkingEls.forEach((el) => el.classList.remove('talking'));
    talkingEls = new Set();
  },
  speak(text, avatarEl, mood = 'calm') {
    if (!this.enabled) return;
    const c = choice();
    if (!c) return;
    this.stop();
    const said = speakable(text);
    if (!said) return;
    if (c.id.startsWith('neural:')) return speakNeural(said, c.id.slice(7), MOODS[mood] || MOODS.calm, avatarEl);
    speakBrowser(said, c.id, MOODS[mood] || MOODS.calm, avatarEl);
  },
};

// recorded speech kept in memory (blob URLs), so prepared lines play instantly
const audioCache = new Map();
const ttsUrl = (t, id, m) => `api/tts?v=${encodeURIComponent(id)}&r=${encodeURIComponent(m.rate)}&p=${encodeURIComponent(m.pitch)}&t=${encodeURIComponent(t)}`;

function speakNeural(text, id, m, avatarEl) {
  const token = playing.token;
  const queue = chunks(text).map((t) => {
    const u = ttsUrl(t, id, m);
    const a = new Audio(audioCache.get(u) || u);
    a.preload = 'auto';
    return a;
  });
  const next = (i) => {
    if (token !== playing.token) return;
    if (i >= queue.length) { talk(avatarEl, false); playing.audio = null; return; }
    const a = queue[i];
    playing.audio = a;
    a.onplaying = () => talk(avatarEl, true);
    a.onended = () => next(i + 1);
    a.onerror = () => {
      if (token !== playing.token) return;
      if (i === 0) { playing.audio = null; speakBrowserFallback(text, m, avatarEl); } else next(i + 1);
    };
    a.play().catch(() => { if (token === playing.token) playing.audio = null; talk(avatarEl, false); });
  };
  next(0);
}

function speakBrowserFallback(text, m, avatarEl) {
  const v = browserVoices[0];
  if (v) speakBrowser(text, v.name, m, avatarEl);
}

function speakBrowser(text, name, m, avatarEl) {
  if (!synth) return;
  const v = browserVoices.find((x) => x.name === name);
  if (!v) return;
  const u = new SpeechSynthesisUtterance(text);
  u.voice = v;
  u.lang = v.lang;
  u.rate = 1 + parseInt(m.rate, 10) / 100;
  u.pitch = 1.1 + parseInt(m.pitch, 10) / 40;
  u.onstart = () => talk(avatarEl, true);
  u.onend = u.onerror = () => talk(avatarEl, false);
  synth.speak(u);
}

// Chess notation read aloud in Hebrew: "Nxf6+" -> "פרש אוכל באף 6, שח"
const PIECE_WORD = { K: 'מלך', Q: 'מלכה', R: 'צריח', B: 'רץ', N: 'פרש' };
const FILE_WORD = { a: 'אֵיי', b: 'בִּי', c: 'סִי', d: 'דִּי', e: 'אִי', f: 'אֶף', g: "ג'ִי", h: "אֵייץ'" };
const PROMO_WORD = { Q: 'מלכה', R: 'צריח', B: 'רץ', N: 'פרש' };

function sanWords(san) {
  if (/^O-O-O/.test(san)) return 'הצרחה ארוכה' + (san.includes('#') ? ', מט' : san.includes('+') ? ', שח' : '');
  if (/^O-O/.test(san)) return 'הצרחה קצרה' + (san.includes('#') ? ', מט' : san.includes('+') ? ', שח' : '');
  const m = san.match(/^([KQRBN])?([a-h])?([1-8])?(x)?([a-h])([1-8])(?:=([QRBN]))?([+#])?/);
  if (!m) return san;
  const [, piece, , , cap, f, r, promo, chk] = m;
  let out = piece ? PIECE_WORD[piece] : 'רגלי';
  out += cap ? ' אוכל ב' : ' ל';
  out += `${FILE_WORD[f]} ${r}`;
  if (promo) out += `, הכתרה ל${PROMO_WORD[promo]}`;
  if (chk === '+') out += ', שח';
  if (chk === '#') out += ', מט!';
  return out;
}

// Visible text of an element, sentence-separated, skipping buttons and .no-speak parts
export function textOf(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.nodeValue;
  if (node.nodeType !== 1 || node.tagName === 'BUTTON' || node.classList.contains('no-speak')) return '';
  let s = '';
  for (const c of node.childNodes) s += textOf(c);
  return /^(P|DIV|LI|H\d)$/.test(node.tagName) && s.trim() ? s.trim() + '. ' : s;
}

export function speakable(text) {
  return String(text)
    .replace(/\b\d+\.(?:\.\.)?\s*(?=[KQRBNOa-h])/g, '')
    .replace(/\b(O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)(?![\w])/g, (s) => ` ${sanWords(s)} `)
    .replace(/[★✓✗👍📖🔧🔄🛡💡⏱🔥👏✔✖🎉✨👑🤔😱💢💧🙈⚠️🐶🧠⚙🔊💤]/gu, '')
    .replace(/[←→]/g, ' ')
    .replace(/\.(\s*\.)+/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------- the character ----------------

function face(size) {
  const img = h('img', { class: 'nick-pic', src: NICK_HEAD, alt: 'ניק', title: 'ניק' });
  const fx = h('span', { class: 'nick-fx' });
  const el = h('div', { class: `nick-avatar size-${size}` }, img, fx);
  el.setMood = (mood) => {
    const m = MOODS[mood] || MOODS.calm;
    const src = pic(m.imgs[picTurn++ % m.imgs.length]);
    if (!img.src.endsWith(src)) img.src = src;
    fx.textContent = m.fx;
    el.className = `nick-avatar size-${size} mood-${mood} anim-${m.anim}`;
    void el.offsetWidth; // restart the "pop" when the mood changes
    el.classList.add('pop');
  };
  return el;
}

/**
 * Nick with a speech bubble.
 *   content: string | Node | array of them
 *   opts.mood: one of MOODS (sets the photo, effect, movement and voice)
 *   opts.speak: read it aloud now (when the voice is on)
 *   opts.size: 'sm' | 'md' | 'lg'
 */
export function nickSays(content, { speak = false, size = 'md', className = '', mood = 'calm' } = {}) {
  const avatar = face(size);
  let current = mood;
  avatar.setMood(mood);
  const bubble = h('div', { class: 'nick-bubble' }, content);
  const playBtn = h('button', { class: 'nick-play', title: 'ניק יקריא', 'aria-label': 'הקרא', onclick: () => voice.speak(textOf(bubble), avatar, current) }, '🔊');
  const el = h('div', { class: `nick nick-${size} ${className}` }, h('div', { class: 'nick-side' }, avatar, playBtn), bubble);
  el.setMood = (m) => { if (m) { current = m; avatar.setMood(m); } };
  el.speak = (m) => { el.setMood(m); voice.speak(textOf(bubble), avatar, current); };
  el.say = (text, m) => { el.setMood(m); voice.speak(text, avatar, current); };
  el.bubble = bubble;
  el.setContent = (c, again = true, m = null) => {
    bubble.replaceChildren(...[c].flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)
      .map((x) => (x instanceof Node ? x : document.createTextNode(String(x)))));
    el.setMood(m);
    if (again) el.speak();
  };
  if (speak) setTimeout(() => { if (el.isConnected) el.speak(); }, 60);
  return el;
}

// Header switch
export function voiceToggle() {
  const btn = h('button', { class: 'voice-btn', title: 'ההקראה של ניק' });
  const paint = () => {
    btn.textContent = voice.enabled ? '🔊' : '🔇';
    btn.classList.toggle('off', !voice.enabled);
    btn.title = !voice.available ? 'אין קול זמין — ראה הוראות בלשונית "צ\'אט עם ניק"'
      : voice.enabled ? `ניק מקריא (${voice.voiceName}) — לחץ להשתקה` : 'ניק בשקט — לחץ להפעלה';
  };
  btn.addEventListener('click', () => { voice.enabled = !voice.enabled; paint(); });
  window.addEventListener('ct-voices', paint);
  paint();
  return btn;
}
