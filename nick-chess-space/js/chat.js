// "Chat with Nick": questions about getting better at chess, answered by Claude through server.py.
import { h, fill, store } from './util.js';
import { nickSays, voice, voiceOptions, fullPic, NICK_FULL, NICK_HEAD } from './nick.js';

const HISTORY_KEY = 'ct_chat_v1';
const SUGGESTIONS = [
  'איך אני מפסיק לעשות בלנדרים?',
  'תן לי תוכנית אימון לשבוע הקרוב',
  'מה הבעיה הכי גדולה שלי לפי הניתוח?',
  'איך מתאמנים על חישוב?',
  'מה התוכנית במערך לונדון?',
  'איך משחקים סיומי צריחים?',
];
const ERRORS = {
  auth: 'המפתח לא עובד. בדוק שהעתקת את כולו, או הדבק מפתח חדש.',
  rate: 'הגעת למגבלת השאלות (במסלול החינמי יש מכסה לדקה וליום). נסה שוב בעוד דקה.',
  net: 'אין חיבור ל-Claude כרגע. בדוק את האינטרנט ונסה שוב.',
  refusal: 'על זה אני לא יכול לענות. בוא נחזור לשחמט! 🐶',
  billing: 'אין קרדיט בחשבון Claude. אפשר לטעון קרדיט — או לעבור למפתח חינמי של Google Gemini (הוראות למעלה).',
  api: 'השרת של ה-AI עמוס כרגע. נסה שוב בעוד רגע.',
  limit: 'שאלת הרבה בשעה האחרונה 🐶 באתר הזה יש מגבלה של שאלות לשעה — נסה שוב קצת יותר מאוחר.',
};

function loadHistory() { return store.get(HISTORY_KEY) || []; }
function saveHistory(list) { store.set(HISTORY_KEY, list.slice(-40)); }

// minimal formatting for Nick's answers: paragraphs, "- " lists, **bold**
function renderAnswer(text) {
  const out = [];
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const item = line.match(/^[-*•]\s+(.*)$/) || line.match(/^\d+[.)]\s+(.*)$/);
    const content = inline(item ? item[1] : line);
    if (item) {
      if (!list) { list = h('ul', {}); out.push(list); }
      list.append(h('li', {}, content));
    } else {
      list = null;
      out.push(h('p', {}, content));
    }
  }
  return out;
}
function inline(s) {
  return s.replace(/^#+\s*/, '').split(/(\*\*[^*]+\*\*)/g).filter(Boolean)
    .map((part) => (/^\*\*.*\*\*$/.test(part) ? h('b', {}, part.slice(2, -2)) : document.createTextNode(part)));
}

export async function renderChat(v, ctx) {
  const history = loadHistory();
  const log = h('div', { class: 'chat-log' });
  const input = h('textarea', { rows: 2, placeholder: 'שאל את ניק כל דבר על שחמט...' });
  const sendBtn = h('button', { class: 'btn primary', type: 'submit' }, 'שלח');
  const setup = h('div', {});
  const statusLine = h('span', {});
  let busy = false;

  const userMsg = (text) => h('div', { class: 'chat-msg user' }, h('div', { class: 'chat-bubble' }, text));
  let turn = 0;
  const sideImg = h('img', { class: 'nick-full', src: NICK_FULL, alt: 'ניק' });
  const showMood = (mood) => { sideImg.src = fullPic(mood); };
  const nickMsg = (content, mood = 'calm') => { showMood(mood); return nickSays(content, { className: 'chat-nick', mood }); };

  function redraw() {
    fill(log,
      nickMsg([h('p', {}, 'הב! אני ניק. שאל אותי כל דבר על שחמט — איך להשתפר, מה לתרגל, מה לשחק בפתיחה.'),
        ctx.profileText ? h('p', { class: 'small muted' }, 'אני רואה את הניתוח של המשחקים שלך, אז התשובות יהיו מותאמות אליך.') : null]),
      history.map((m, i) => (m.role === 'user' ? userMsg(m.content) : nickMsg(renderAnswer(m.content), i % 4 === 1 ? 'happy' : 'calm'))));
    log.scrollTop = log.scrollHeight;
  }

  async function ask(question) {
    const q = question.trim();
    if (!q || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = '';
    history.push({ role: 'user', content: q });
    saveHistory(history);
    log.append(userMsg(q));
    const answer = nickMsg(h('p', { class: 'typing' }, 'ניק חושב'), 'thinking');
    log.append(answer);
    log.scrollTop = log.scrollHeight;
    let text = '';
    let err = null;
    try {
      const res = await fetch('api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, context: ctx.profileText || '' }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        err = j.error === 'key' || j.error === 'sdk' ? 'setup' : j.error === 'limit' ? 'limit' : 'net';
      } else {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += dec.decode(value, { stream: true });
          const shown = text.replace(/\[\[ERR:[^\]]*\]\]$/, '');
          if (shown) answer.setContent(renderAnswer(shown), false);
          log.scrollTop = log.scrollHeight;
        }
      }
    } catch { err = 'net'; }
    const m = text.match(/\[\[ERR:([a-z]+)[^\]]*\]\]/);
    if (m) { err = m[1]; text = text.replace(m[0], '').trim(); }
    if (err === 'setup') {
      history.pop();
      saveHistory(history);
      answer.remove();
      log.lastChild?.remove();
      await checkStatus();
    } else if (err && !text) {
      history.pop();
      saveHistory(history);
      const code = (m && m[0].match(/:(\d+)/)) ? ` (קוד ${m[0].match(/:(\d+)/)[1]})` : '';
      answer.setContent(h('p', {}, (ERRORS[err] || ERRORS.net) + (err === 'api' ? code : '')), true, 'sad');
      showMood('sad');
      if (err === 'billing' || err === 'auth') checkStatus(true, ERRORS[err]);
    } else {
      history.push({ role: 'assistant', content: text });
      saveHistory(history);
      const cut = err ? h('p', { class: 'muted small no-speak' }, '(התשובה נקטעה באמצע — אפשר לשאול שוב)') : null;
      const mood = err ? 'sad' : ['happy', 'calm', 'funny', 'proud', 'calm'][turn++ % 5];
      answer.setContent([...renderAnswer(text), cut], true, mood);
      showMood(mood);
    }
    busy = false;
    sendBtn.disabled = false;
    input.focus();
  }

  const PROVIDER_NAME = { gemini: 'Google Gemini', claude: 'Claude', pollinations: 'Pollinations (חינם, בלי מפתח)' };

  // force = open the settings even when a key is already saved
  async function checkStatus(force = false, note = null) {
    let st;
    try { st = await (await fetch('api/chat/status')).json(); } catch { st = { ready: false, reason: 'server' }; }
    fill(statusLine, st.ready ? h('span', { class: 'chip small' }, '🧠 ', PROVIDER_NAME[st.provider]) : null);
    if (st.ready && !force) { fill(setup); return true; }
    if (st.public) {
      fill(setup, st.ready ? null : h('div', { class: 'card chat-setup' },
        h('h3', {}, 'הצ׳אט עם ניק כבוי באתר הזה'),
        h('p', {}, 'בעל האתר עוד לא חיבר מוח ל-AI. כל שאר האתר עובד כרגיל.')));
      return st.ready;
    }
    if (st.reason === 'server') {
      fill(setup, h('div', { class: 'card chat-setup' }, h('h3', {}, 'השרת לא עונה'), h('p', {}, 'ודא ש-start.bat פתוח ורץ.')));
      return false;
    }
    const keyInput = h('input', { type: 'password', dir: 'ltr', placeholder: 'הדבק כאן את המפתח', autocomplete: 'off' });
    const msg = h('div', {});
    const post = (body) => fetch('api/chat/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const save = async (e) => {
      e.preventDefault();
      const r = await post({ key: keyInput.value });
      if (r.ok) {
        const j = await r.json();
        fill(msg, h('div', { class: 'msg good' }, `נשמר! ניק עונה עכשיו דרך ${PROVIDER_NAME[j.provider]}.`));
        keyInput.value = '';
        setTimeout(() => checkStatus(), 900);
      } else fill(msg, h('div', { class: 'msg bad' }, 'זה לא נראה כמו מפתח. בדוק שהעתקת את כולו.'));
    };
    const pv = st.providers || {};
    const avail = ['pollinations', 'gemini', 'claude'].filter((k) => pv[k]);
    const switcher = avail.length > 1 ? h('div', { class: 'row' }, 'עונה דרך:',
      avail.map((k) => h('button', {
        class: 'btn small' + (st.provider === k ? ' primary' : ''),
        onclick: async () => { await post({ provider: k }); checkStatus(true); },
      }, PROVIDER_NAME[k]))) : null;
    fill(setup, h('div', { class: 'card chat-setup' },
      note ? h('div', { class: 'msg bad' }, note) : null,
      h('h3', {}, 'מאיפה ניק מקבל את המוח?'),
      switcher,
      h('div', { class: 'provider-opt recommended' },
        h('b', {}, '⭐ בחינם — Google Gemini (מומלץ)'),
        h('ol', {},
          h('li', {}, 'היכנס ל-', h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'aistudio.google.com/apikey'), ' עם חשבון Google.'),
          h('li', {}, 'לחץ Create API key (לא צריך כרטיס אשראי).'),
          h('li', {}, 'העתק את המפתח והדבק אותו למטה.')),
        h('p', { class: 'muted small' }, 'במסלול החינמי יש מגבלה של כמה שאלות בדקה, ו-Google עשויה להשתמש בשיחות כדי לשפר את המוצרים שלה.')),
      h('div', { class: 'provider-opt' },
        h('b', {}, 'בתשלום — Claude'),
        h('p', { class: 'small' }, 'מפתח מ-', h('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', rel: 'noopener' }, 'console.anthropic.com'),
          ' (מתחיל ב-sk-ant-). צריך לטעון קרדיט, בערך סנט לשאלה.')),
      h('form', { class: 'row', onsubmit: save }, keyInput, h('button', { class: 'btn primary', type: 'submit' }, 'שמור')),
      msg,
      h('p', { class: 'muted small' }, 'האתר מזהה לבד איזה מפתח הדבקת. המפתח נשמר רק במחשב שלך (בקובץ .secrets.json בתיקיית האתר).'),
      st.ready ? h('button', { class: 'btn ghost small', onclick: () => fill(setup) }, 'סגור') : null));
    return false;
  }

  // voice settings
  const voiceBox = h('div', { class: 'voice-box' });
  const sideNick = nickSays('לחץ על מצב רוח ותשמע אותי.', { size: 'sm', mood: 'happy' });
  function drawVoice() {
    const opts = voiceOptions();
    const sel = h('select', { onchange: (e) => { voice.setVoice(e.target.value); voice.speak('הב! ככה אני נשמע עכשיו.', null, 'happy'); } },
      opts.map((x) => h('option', { value: x.id, selected: x.id === voice.voiceId || null }, x.label)));
    const moods = [['happy', 'שמח', 'יש! פתרת את החידה, אתה אלוף!'], ['sad', 'עצוב', 'אוי... השארת את המלכה תלויה.'],
      ['shocked', 'מופתע', 'מה?! נתת מט במהלך אחד?'], ['angry', 'עצבני', 'עוד פעם השארת את הפרש תלוי?!'],
      ['thinking', 'סקרן', 'רגע, תן לי לבדוק את העמדה הזאת מקרוב.'], ['funny', 'מצחיק', 'הב הב! ראית איך הוא נפל במלכודת?'],
      ['hungry', 'רעב', 'היריב השאיר צריח על הלוח ולא אכלת אותו? אני רעב רק מלראות את זה.'], ['tired', 'עייף', 'אתה חושב כבר הרבה זמן... אני הולך לנמנם.'],
      ['facepalm', 'מתוסכל', 'יא עיוור... זה היה מט בשניים.'], ['proud', 'מגניב', 'שבותה! מהלך של אלופים.']];
    fill(voiceBox,
      h('h3', {}, '🔊 הקול של ניק'),
      !opts.length ? [h('p', { class: 'small' }, 'לא נמצא קול עברי, אז ניק לא יכול להקריא.'),
        h('p', { class: 'muted small' }, 'הפעל מחדש את start.bat (הוא מתקין את הקול הטבעי לבד), או פתח את האתר ב-Microsoft Edge.')]
        : [sel,
          h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: voice.enabled || null, onchange: (e) => { voice.enabled = e.target.checked; } }),
            h('span', { class: 'slider' }), ' ניק מקריא את הטקסטים באתר'),
          h('div', { class: 'small muted' }, 'נסה את הקול בכל מצב רוח:'),
          h('div', { class: 'row mood-test' }, moods.map(([m, label, line]) => h('button', {
            class: 'btn small', onclick: () => { sideNick.setContent(line, true, m); showMood(m); },
          }, label)))]);
  }
  window.addEventListener('ct-voices', drawVoice);

  const form = h('form', { class: 'chat-input', onsubmit: (e) => { e.preventDefault(); ask(input.value); } }, input, sendBtn);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); } });

  fill(v,
    h('div', { class: 'page-head row-between' },
      h('div', {}, h('h2', {}, 'צ׳אט עם ניק'), h('p', { class: 'muted' }, 'מאמן AI שעונה על כל שאלה על שחמט — ומכיר את הניתוח של המשחקים שלך.')),
      h('div', { class: 'row' }, statusLine,
        h('button', { class: 'btn ghost', onclick: () => checkStatus(true) }, '⚙ הגדרות AI'),
        h('button', { class: 'btn ghost', onclick: () => { history.length = 0; saveHistory(history); voice.stop(); redraw(); } }, 'שיחה חדשה'))),
    h('div', { class: 'chat-layout' },
      h('div', { class: 'card chat-card' }, setup, log,
        h('div', { class: 'chips chat-sugg' }, SUGGESTIONS.map((s) => h('button', { class: 'chip', onclick: () => ask(s) }, s))),
        form),
      h('aside', { class: 'card chat-side' },
        sideImg,
        h('p', { class: 'small muted center' }, 'ניק. כלב. מאמן שחמט. ידיים של בן אדם — אל תשאל.'),
        voiceBox, sideNick)));
  redraw();
  drawVoice();
  await checkStatus();
}

export { NICK_HEAD };
