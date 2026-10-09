// All Hebrew copy: weaknesses, training plans, puzzle categories and Lichess theme names.

export const WEAKNESS = {
  hanging: {
    title: 'השארת כלים תלויים',
    short: 'בלנדרים — כלים תלויים',
    icon: '♞',
    why: 'אחרי המהלך שלך היריב פשוט אכל חומר. זה הבלנדר הקלאסי: לא בדקת מה המהלך שלך משאיר בלי הגנה.',
    habit: 'בדיקת בלנדר לפני כל מהלך: דמיין שהמהלך כבר שוחק, ובדוק רק את השחים והאכילות של היריב. כל כלי שזז — מה הוא הפסיק להגן?',
    drills: ['safety', 'punish', 'fix'],
    themes: ['hangingPiece', 'trappedPiece', 'defensiveMove', 'fork'],
  },
  allowedTactic: {
    title: 'לא רואה את הטקטיקה של היריב',
    short: 'בלנדרים — איומים שפספסת',
    icon: '⚔',
    why: 'היריב מצא מזלג, ריתוק או התקפה כפולה שלא ראית מראש. הבעיה היא לא חוסר ידע — היא שאתה לא מסתכל על הלוח מהצד של היריב.',
    habit: 'אחרי כל מהלך של היריב שאל: "מה הוא רוצה עכשיו?" מה המהלך שלו תוקף, ומה הוא פתח. לפני שאתה זז — מה הכי טוב שהוא יכול לעשות נגד המהלך שלך?',
    drills: ['punish', 'safety', 'fix'],
    themes: ['defensiveMove', 'fork', 'pin', 'skewer', 'discoveredAttack', 'intermezzo'],
  },
  allowedMate: {
    title: 'מתעלם מאיומי מט',
    short: 'בלנדרים — איומי מט',
    icon: '♚',
    why: 'נתת ליריב מט (או מט מאולץ). בדרך כלל זה קורה כשהמלך חשוף או כששורת הבסיס חלשה ולא שמת לב לשחים.',
    habit: 'לפני כל מהלך: עבור על כל השחים האפשריים של היריב — גם השחים ה"מטופשים". מלך עם מעט משבצות בריחה = סכנה.',
    drills: ['punish', 'safety'],
    themes: ['defensiveMove', 'backRankMate', 'mateIn2', 'exposedKing'],
  },
  missedTactic: {
    title: 'מפספס הזדמנויות טקטיות',
    short: 'פספוס טקטיקות',
    icon: '⚡',
    why: 'היה לך מהלך שזוכה בחומר — ולא מצאת אותו. ראיית דפוסים טקטיים (מזלג, ריתוק, הסטה) נבנית מחידות רבות.',
    habit: 'בכל מהלך שלך, לפני שאתה בוחר תוכנית: בדוק את כל השחים, האכילות והאיומים שלך (CCT). קודם הכוחני, אחר כך השקט.',
    drills: ['fix'],
    themes: ['fork', 'pin', 'skewer', 'discoveredAttack', 'deflection', 'attraction', 'sacrifice'],
  },
  missedMate: {
    title: 'מפספס מט',
    short: 'פספוס מט',
    icon: '♛',
    why: 'היה לך מט מאולץ ולא ראית אותו. דפוסי מט חוזרים על עצמם — ככל שתראה יותר מהם, כך תזהה אותם מהר יותר.',
    habit: 'כשהמלך של היריב חשוף — עצור ובדוק כל שח אפשרי, גם הקרבות. שחים הם המהלכים הכי מאולצים שיש.',
    drills: ['fix'],
    themes: ['mateIn2', 'mateIn3', 'backRankMate', 'smotheredMate', 'kingsideAttack', 'mateIn4'],
  },
  positional: {
    title: 'טעויות תוכנית ועמדה',
    short: 'טעויות עמדה',
    icon: '♜',
    why: 'איבדת יתרון בלי לאבד חומר מיד — כלים במשבצות לא טובות, חילופים שגויים או מהלכים חסרי מטרה.',
    habit: 'לפני כל מהלך שאל: מה הכלי הכי גרוע שלי? איך אני משפר אותו? ומה התוכנית של היריב?',
    drills: ['fix'],
    themes: ['quietMove', 'advantage', 'zugzwang', 'clearance'],
  },
  opening: {
    title: 'בעיות בפתיחה',
    short: 'פתיחה',
    icon: '♙',
    why: 'אתה יוצא מהפתיחה בעמדה גרועה — לא בגלל כלי תלוי, אלא בגלל מהלכים לא עקרוניים כבר ב-10 המהלכים הראשונים.',
    habit: 'עקרונות: פתח כלים מהר, שלוט במרכז, הצרח מוקדם, אל תזיז את המלכה מוקדם מדי ואל תזיז אותו כלי פעמיים בלי סיבה.',
    drills: ['fix'],
    themes: ['opening', 'hangingPiece', 'fork'],
  },
  endgame: {
    title: 'בעיות בסיום',
    short: 'סיומים',
    icon: '♔',
    why: 'בסיום אתה מאבד יתרון גם בלי בלנדרים — שם הטכניקה מכריעה וכל טעות קטנה עולה בחצי נקודה.',
    habit: 'בסיום: הפעל את המלך, דחוף רגלים חופשיים, ובסיומי צריח — צריח מאחורי הרגלי החופשי.',
    drills: ['fix'],
    themes: ['endgame', 'rookEndgame', 'pawnEndgame', 'zugzwang', 'advancedPawn', 'promotion'],
  },
  time: {
    title: 'ניהול זמן',
    short: 'לחץ זמן',
    icon: '⏱',
    why: 'הרבה מהטעויות שלך (או ההפסדים) קורות כשנגמר לך הזמן.',
    habit: 'חלק את הזמן: אל תשקיע יותר מ-10% מהשעון על מהלך אחד. במהלכים פשוטים — שחק מהר, ושמור זמן לרגעים המסובכים.',
    drills: ['fix'],
    themes: ['mateIn1', 'mateIn2', 'hangingPiece', 'fork'],
  },
  conversion: {
    title: 'מימוש יתרון',
    short: 'מימוש יתרון',
    icon: '🏆',
    why: 'היית במצב מנצח — ולא ניצחת. כשמובילים, הסכנה הכי גדולה היא התקפת נגד של היריב.',
    habit: 'כשאתה מוביל: פשט (החלף כלים, לא רגלים), מנע את המשחק הנגדי של היריב, ובדוק כל מהלך פעמיים.',
    drills: ['fix', 'safety'],
    themes: ['crushing', 'endgame', 'advancedPawn', 'defensiveMove'],
  },
};

export const DRILLS = {
  fix: {
    title: 'תקן את הטעויות שלך',
    desc: 'העמדות האמיתיות מהמשחקים שלך, רגע לפני הטעות. מצא מהלך טוב יותר (המנוע בודק כל מהלך שתנסה).',
    icon: '🔧',
  },
  punish: {
    title: 'הפוך את הלוח',
    desc: 'העמדה אחרי הבלנדר שלך — הפעם אתה היריב. מצא איך להעניש את המהלך שלך. כך לומדים לראות איומים מהצד השני.',
    icon: '🔄',
  },
  safety: {
    title: 'בטוח או בלנדר?',
    desc: 'מוצג מהלך מהמשחקים שלך. החלט מהר אם הוא בטוח — לפני שהוא משוחק. זה אימון ישיר של "בדיקת הבלנדר".',
    icon: '🛡',
  },
};

export const ERROR_TYPE_LABEL = {
  hanging: 'כלי תלוי',
  allowedTactic: 'טקטיקה של היריב',
  allowedMate: 'איום מט',
  missedTactic: 'פספוס טקטיקה',
  missedMate: 'פספוס מט',
  positional: 'טעות עמדה',
};

export const CLS_LABEL = { blunder: 'בלנדר', mistake: 'טעות', inaccuracy: 'אי-דיוק', good: 'טוב' };
export const CLS_MARK = { blunder: '??', mistake: '?', inaccuracy: '?!' };
export const PHASE_LABEL = { opening: 'פתיחה', middlegame: 'משחק אמצע', endgame: 'סיום' };
export const RESULT_LABEL = { win: 'ניצחון', loss: 'הפסד', draw: 'תיקו' };
export const TIME_CLASS_LABEL = { bullet: 'בולט', blitz: 'בליץ', rapid: 'רפיד', daily: 'יומי' };

export const REASON_LABEL = {
  checkmated: 'מט', resigned: 'כניעה', timeout: 'זמן', abandoned: 'נטישה', agreed: 'הסכמה',
  repetition: 'חזרה', stalemate: 'פט', insufficient: 'חוסר חומר', '50move': '50 מהלכים',
  timevsinsufficient: 'זמן מול חוסר חומר', win: 'ניצחון',
};

// Curated categories (keys of window.TOP_PUZZLES)
export const PUZZLE_GROUPS = [
  {
    title: 'חידות ארוכות שמאמצות את המוח',
    desc: 'פתרונות של 4 מהלכים ויותר — אימון חישוב אמיתי.',
    cats: ['veryLong_hard', 'veryLong_mid', 'veryLong_easy', 'long', 'mateIn5', 'mateIn4', 'mateIn3'],
  },
  {
    title: 'מתוך משחקים של רבי-אמנים',
    desc: 'עמדות ממשחקים אמיתיים של שחקני-על.',
    cats: ['superGM', 'masterVsMaster'],
  },
  {
    title: 'נגד בלנדרים',
    desc: 'לזהות כלים תלויים, כלים לכודים ולמצוא את מהלך ההגנה.',
    cats: ['hangingPiece', 'defensiveMove', 'trappedPiece'],
  },
  {
    title: 'מוטיבים טקטיים',
    desc: 'הדפוסים שמכריעים משחקים.',
    cats: ['fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'sacrifice', 'deflection', 'attraction',
      'intermezzo', 'quietMove', 'clearance', 'interference', 'xRayAttack', 'capturingDefender', 'zugzwang'],
  },
  {
    title: 'מטים',
    desc: 'דפוסי מט קלאסיים והתקפה על המלך.',
    cats: ['mateIn1', 'mateIn2', 'backRankMate', 'smotheredMate', 'kingsideAttack', 'exposedKing'],
  },
  {
    title: 'שלבי המשחק',
    desc: 'פתיחה, אמצע וסיום.',
    cats: ['opening', 'middlegame', 'endgame', 'rookEndgame', 'pawnEndgame', 'advancedPawn', 'promotion', 'crushing'],
  },
];

export const CAT_INFO = {
  veryLong_hard: { title: 'ארוכות — קשות מאוד', theme: 'veryLong', hint: 'דירוג 2000+' },
  veryLong_mid: { title: 'ארוכות — מאתגרות', theme: 'veryLong', hint: 'דירוג 1500–2000' },
  veryLong_easy: { title: 'ארוכות — למתחילים', theme: 'veryLong', hint: 'עד 1500' },
  long: { title: '3 מהלכים', theme: 'long' },
  mateIn3: { title: 'מט ב-3', theme: 'mateIn3' },
  mateIn4: { title: 'מט ב-4', theme: 'mateIn4' },
  mateIn5: { title: 'מט ב-5 ויותר', theme: 'mateIn5' },
  superGM: { title: 'משחקי-על', theme: 'superGM', hint: 'שחקנים 2700+' },
  masterVsMaster: { title: 'מאסטר נגד מאסטר', theme: 'masterVsMaster' },
};

export const THEME_HE = {
  advancedPawn: 'רגלי מתקדם', advantage: 'יתרון', anastasiaMate: 'מט אנסטסיה', arabianMate: 'מט ערבי',
  attackingF2F7: 'התקפה על f2/f7', attraction: 'משיכה', backRankMate: 'מט שורה אחורית', bishopEndgame: 'סיום רצים',
  bodenMate: 'מט בודן', capturingDefender: 'אכילת המגן', castling: 'הצרחה', clearance: 'פינוי', crushing: 'מכריע',
  defensiveMove: 'מהלך הגנה', deflection: 'הסטה', discoveredAttack: 'התקפה נחשפת', doubleBishopMate: 'מט שני רצים',
  doubleCheck: 'שח כפול', dovetailMate: 'מט זנב-יונה', endgame: 'סיום', enPassant: 'הכאה דרך הילוכו',
  equality: 'השוואה', exposedKing: 'מלך חשוף', fork: 'מזלג', hangingPiece: 'כלי תלוי', hookMate: 'מט וו',
  interference: 'הפרעה', intermezzo: 'מהלך ביניים', killBoxMate: 'מט קופסה', kingsideAttack: 'התקפת אגף המלך',
  knightEndgame: 'סיום פרשים', long: '3 מהלכים', master: 'משחק מאסטר', masterVsMaster: 'מאסטר נגד מאסטר',
  mate: 'מט', mateIn1: 'מט ב-1', mateIn2: 'מט ב-2', mateIn3: 'מט ב-3', mateIn4: 'מט ב-4', mateIn5: 'מט ב-5+',
  middlegame: 'משחק אמצע', oneMove: 'מהלך אחד', opening: 'פתיחה', pawnEndgame: 'סיום רגלים', pin: 'ריתוק',
  promotion: 'הכתרה', queenEndgame: 'סיום מלכות', queenRookEndgame: 'סיום מלכה וצריח', queensideAttack: 'התקפת אגף המלכה',
  quietMove: 'מהלך שקט', rookEndgame: 'סיום צריחים', sacrifice: 'הקרבה', short: '2 מהלכים', skewer: 'שיפוד',
  smotheredMate: 'מט חנוק', superGM: 'משחק-על', trappedPiece: 'כלי לכוד', underPromotion: 'הכתרה חלקית',
  veryLong: 'ארוכה מאוד', xRayAttack: 'רנטגן', zugzwang: 'צוגצוונג', vukovicMate: 'מט ווקוביץ׳',
  balestraMate: 'מט בלסטרה', blindSwineMate: 'מט חזירים עיוורים', cornerMate: 'מט פינה', epauletteMate: 'מט כותפות',
  morphysMate: 'מט מורפי', operaMate: 'מט אופרה', pillsburysMate: 'מט פילסברי', triangleMate: 'מט משולש',
  swallowstailMate: 'מט זנב סנונית', railroadMate: 'מט מסילה',
};

export function themeName(t) { return THEME_HE[t] || t; }
export function catTitle(cat) { return (CAT_INFO[cat] && CAT_INFO[cat].title) || themeName(cat); }

// ---------- game review (chess.com-style move ratings, with our own names) ----------
// order = how they are listed in the summary table
export const REVIEW = {
  brilliant: { label: 'שבותה', sym: '!!', color: '#1baaa6', desc: 'מהלך מבריק: הקרבה שהיא גם המהלך הכי טוב' },
  great: { label: 'ניק', sym: '!', color: '#5c8bb0', desc: 'המהלך היחיד שעובד — כל השאר גרועים בהרבה' },
  best: { label: 'זה הכי טוב', sym: '★', color: '#81b64c', desc: 'המהלך של המנוע' },
  excellent: { label: 'זה מגניב', sym: '👍', color: '#81b64c', desc: 'כמעט כמו המהלך הכי טוב' },
  good: { label: 'לא רע', sym: '✓', color: '#95b776', desc: 'מהלך סביר, יש קצת יותר טוב' },
  book: { label: 'למדת חבוב', sym: '📖', color: '#a88764', desc: 'מהלך פתיחה מוכר מהתאוריה' },
  inaccuracy: { label: 'לא ככה', sym: '?!', color: '#f7c045', desc: 'לא מדויק — איבדת קצת' },
  mistake: { label: 'אידיוט', sym: '?', color: '#ffa459', desc: 'טעות — איבדת הרבה' },
  miss: { label: 'יא עיוור', sym: '✗', color: '#ff7769', desc: 'היריב טעה ולא ניצלת את זה' },
  blunder: { label: 'אוטיסט', sym: '??', color: '#fa412d', desc: 'בלנדר — הפסדת את העמדה' },
};
export const REVIEW_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
