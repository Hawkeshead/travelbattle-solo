/* =========================================================
   THE SPYGLASS'S WORDS FOR THE AI'S SCORE TERMS (approved 16 Oct 2026)

   Every term the AI adds into a square's score (js/ai-strategy.js, the
   `parts` of each candidate), with the plain label the factor strip shows and
   its icon. Terms that mean the same thing to a player share a label, and the
   strip adds them together. The tie-breaker (a tiny random nudge) is never
   shown. No technical names reach the screen.

   The icons are flat placeholders, line drawings in the current text colour,
   for the thematic art pass to replace.
========================================================= */
const T = (label, icon) => ({ label, icon });
const TERMS = {
  // Every unit
  baseState: T('Overall position', 'scales'),
  threat: T('Enemy can reach it', 'crosshair'),
  advancePull: T('Closer to the enemy', 'arrowFwd'),
  roadSeek: T('On a road', 'road'),
  missionPull: T("Brigade's order", 'pennant'),
  lookahead: T('Risky next turn', 'hourglass'),
  jitter: null,
  // Command
  cohesionLoss: T("Leaves the Brigadier's command", 'chainBroken'),
  lineAhead: T('Too far ahead of the line', 'chainBroken'),
  crossing: T('Heads for a bridge or ford', 'chainBroken'),
  strandOwnMen: T('Would leave his own men out of command', 'chainBroken'),
  pounce: T('Strikes an enemy that is turned around', 'chainBroken'),
  stayStackedUnderGuns: T('Column standing under enemy guns', 'chainBroken'),
  lineAlone: T('Alone near the enemy', 'chainBroken'),
  cohesionDrift: T("Leaves the Brigadier's command", 'chainBroken'),
  cohesionGain: T('Keeps the Brigade in command', 'chain'),
  brigadierTrail: T('Brigadier keeps behind his men', 'footprints'),
  brigadierContact: T('Brigadier next to the enemy', 'brigWarn'),
  freeStrandedUnit: T('Goes to free cut-off men', 'hand'),
  collectStrandedGun: T('Fetches a stranded gun', 'handGun'),
  orphanFallback: T('Finds a new Brigade', 'pennantArrow'),
  // Guns
  gunPositioning: T('Gun moving off its ground', 'cannonArrow'),
  gunVantage: T('Better field of fire', 'telescope'),
  gunSeekVantage: T('Better field of fire', 'telescope'),
  gunExposure: T('Gun too exposed', 'shieldCrack'),
  gunGoodGround: T('Gun on good ground', 'hill'),
  gunHasShot: T('Gun already has a shot', 'roundshot'),
  gunSiting: T('Gun heads for its firing position', 'cannonFlag'),
  screensGun: T('Guards a friendly gun', 'shieldGun'),
  // Fighting
  engage: T('Good fight from here', 'sabres'),
  disengage: T('Lost too many fights', 'whiteFlag'),
  brigadeKillValue: T('Could break an enemy Brigade', 'tornBanner'),
  finishing: T('Finishing a beaten enemy', 'tornBannerArrow'),
  killPull: T('Finishing a beaten enemy', 'tornBannerArrow'),
  vulnerablePull: T('Weak enemy to hit', 'target'),
  soloAttackPenalty: T('Attacking alone', 'loneFigure'),
  chargeBonus: T('Can charge', 'sabre'),
  loneCharge: T('Charging unsupported', 'sabreWarn'),
  vipCapture: T('Captures or cuts off a Brigadier', 'hat'),
  brigadierSever: T('Captures or cuts off a Brigadier', 'hat'),
  comboTarget: T('Planned two-unit attack', 'twoArrows'),
  answerGuns: T('Goes for the guns shelling it', 'cannonTarget'),
  convergeOnContact: T('Joins the fighting', 'converge'),
  stallBreak: T('Stop waiting, push on', 'hourglassArrow'),
  // Danger and ground
  enemyGunArc: T('Under enemy guns', 'cannonArc'),
  zeroedSquare: T('Enemy guns are ranged on it', 'medallion'),
  stackUnderGuns: T('Column under enemy guns', 'stackCannon'),
  formColumn: T('Forms a column', 'stack'),
  terrainSeek: T('Cover or high ground', 'treesHill'),
  ambushMemory: T('Recent ambush nearby', 'eyeTrees'),
  mutualSupport: T('Friends beside it', 'twoFigures'),
  groundDenial: T('Holds a road or a gap', 'gate'),
  retreatToSupport: T('Falls back to friends', 'arrowBack'),
  scenario: T('Operation objective', 'mapPin'),
  // Cavalry
  cavalryConcentration: T('Cavalry gathers together', 'horseshoes'),
  cavalryMass: T('Horse support nearby', 'twoHorseshoes'),
  cavalryPair: T('Horse support nearby', 'twoHorseshoes'),
  heavyPair: T('Heavy cavalry in pairs', 'twoHorses'),
  squareTrap: T('Enemy square nearby', 'squareOutline'),
  cavStepBack: T('Stepping back after a winning charge', 'arrowBack'),
  squareHunt: T('Enemy square nearby', 'squareOutline'),
  boggedGun: T('Enemy gun stuck in a field', 'wheelMud'),
  gunRaid: T('Raid an enemy gun', 'horseCannon'),
  // Off in the shipped AI (weight 0), labelled in case it is switched on
  intent: T('Sticks to its job', 'pin'),
};
/* The label and icon for a term; null for the tie-breaker. An unknown term (a
   new one added to the AI later) shows as "Other" rather than its code name. */
export function termOf(key){
  if(key in TERMS) return TERMS[key];
  return T('Other', 'dot');
}
export const TERM_KEYS = Object.keys(TERMS);

/* ---------- placeholder icons: 16 x 16 line drawings ---------- */
const cannon = (x = 0, y = 0) => `<g transform="translate(${x} ${y})"><path d="M2 9l8-3 1 2-8 3z"/><circle cx="5" cy="11.5" r="2"/></g>`;
const arrow = (x1, y1, x2, y2) => {
  const a = Math.atan2(y2 - y1, x2 - x1), h = 3;
  const p = (ang) => `${(x2 - h * Math.cos(a + ang)).toFixed(1)} ${(y2 - h * Math.sin(a + ang)).toFixed(1)}`;
  return `<path d="M${x1} ${y1}L${x2} ${y2}M${p(0.5)}L${x2} ${y2}L${p(-0.5)}"/>`;
};
const flagP = (x = 0, y = 0) => `<g transform="translate(${x} ${y})"><path d="M4 14V2"/><path d="M4 2.5l7 2.5-7 2.5" fill="currentColor"/></g>`;
const figure = (x = 0) => `<g transform="translate(${x} 0)"><circle cx="5" cy="4" r="1.6"/><path d="M5 6v4M3 8h4M5 10l-1.6 4M5 10l1.6 4"/></g>`;
const shoe = (x = 0, y = 0) => `<path transform="translate(${x} ${y})" d="M2 9V5a3 3 0 0 1 6 0v4"/>`;
const warn = `<path d="M12 1.5l3 5h-6z" fill="currentColor" stroke="none"/>`;
const banner = `<path d="M3 15V2M3 2.5h9l-2 3 2 3H3"/><path d="M7 2.5l1.5 2.2-1 1.2 1.6 2.6"/>`;
const sabreP = (flip) => `<path transform="${flip ? 'translate(16 0) scale(-1 1)' : ''}" d="M3 13C6 9 9 6 13 3M2.5 11.5l3 3"/>`;
const ICONS = {
  scales: `<path d="M8 2v12M4 14h8M2.5 5h11"/><path d="M2.5 5L1 9h3zM13.5 5L12 9h3z"/>`,
  crosshair: `<circle cx="8" cy="8" r="5"/><path d="M8 1v4M8 11v4M1 8h4M11 8h4"/>`,
  arrowFwd: arrow(2, 13, 13, 3),
  road: `<path d="M5 15L7 1M11 15L9 1M8 3v2M8 8v2M8 13v1"/>`,
  pennant: flagP(),
  hourglass: `<path d="M4 2h8M4 14h8M5 2c0 4 6 4 6 6s-6 2-6 6M11 2c0 4-6 4-6 6s6 2 6 6"/>`,
  chainBroken: `<rect x="1.5" y="6" width="6" height="4" rx="2"/><rect x="9" y="6" width="5.5" height="4" rx="2"/><path d="M8 3v2M8 11v2"/>`,
  chain: `<rect x="1.5" y="6" width="7" height="4" rx="2"/><rect x="7.5" y="6" width="7" height="4" rx="2"/>`,
  footprints: `<ellipse cx="5" cy="11" rx="1.6" ry="2.4"/><ellipse cx="11" cy="5" rx="1.6" ry="2.4"/>`,
  brigWarn: `${figure(0)}${warn}`,
  hand: `<path d="M4 14V8M4 8V4.5a1 1 0 0 1 2 0V8M6 7V3.5a1 1 0 0 1 2 0V8M8 7.5V4a1 1 0 0 1 2 0v5M10 9l1.5-2a1 1 0 0 1 1.6 1.2L10 14H4"/>`,
  handGun: `<path d="M2 14V9a1 1 0 0 1 2 0v2M4 11V8a1 1 0 0 1 2 0v6"/>${cannon(5, -1)}`,
  pennantArrow: `${flagP(-1, 0)}${arrow(9, 12, 15, 12)}`,
  cannonArrow: `${cannon(0, 1)}${arrow(9, 13, 15, 13)}`,
  telescope: `<path d="M2 11l10-5 1.5 3-10 5zM12 6l2-1 1 2-2 1M7 12.5L5.5 15M8 12l2 3"/>`,
  shieldCrack: `<path d="M8 1.5l5.5 2v4.5c0 3-2.5 5.5-5.5 6.5C5 13.5 2.5 11 2.5 8V3.5z"/><path d="M8 4L7 7l2 2-1 3"/>`,
  hill: `<path d="M1 14c2-6 5-9 7-9s5 3 7 9z"/>`,
  roundshot: `<circle cx="8" cy="8" r="5" fill="currentColor"/>`,
  cannonFlag: `${cannon(0, 2)}${flagP(5, -1)}`,
  shieldGun: `<path d="M5 1.5l4 1.5v3.5C9 9 7 11 5 11.5 3 11 1 9 1 6.5V3z"/>${cannon(6, 2)}`,
  sabres: `${sabreP(false)}${sabreP(true)}`,
  sabre: sabreP(false),
  sabreWarn: `${sabreP(false)}${warn}`,
  whiteFlag: `<path d="M4 15V2"/><path d="M4 2.5h9v6H4" fill="currentColor" fill-opacity=".35"/>`,
  tornBanner: banner,
  tornBannerArrow: `${banner}${arrow(9, 13, 15, 13)}`,
  target: `<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r=".8" fill="currentColor"/>`,
  loneFigure: figure(3),
  hat: `<path d="M1 11c2-5 12-5 14 0zM5 7.5c1-2 5-2 6 0"/><circle cx="12" cy="6" r="1" fill="currentColor"/>`,
  twoArrows: `${arrow(2, 3, 12, 8)}${arrow(2, 13, 12, 8)}`,
  cannonTarget: `<circle cx="8" cy="8" r="7"/>${cannon(1, -1)}`,
  converge: `${arrow(1, 2, 7, 7)}${arrow(15, 2, 9, 7)}${arrow(8, 15, 8, 10)}`,
  hourglassArrow: `<path d="M2 2h6M2 14h6M3 2c0 4 4 4 4 6s-4 2-4 6M7 2c0 4-4 4-4 6s4 2 4 6"/>${arrow(10, 8, 15, 8)}`,
  cannonArc: `${cannon(0, 2)}<path d="M9 13a7 7 0 0 0 0-11" stroke-dasharray="2 1.5"/>`,
  medallion: `<circle cx="8" cy="8" r="6"/><path d="M8 3v10M3 8h10"/><circle cx="8" cy="8" r="2"/>`,
  stackCannon: `<rect x="1" y="3" width="7" height="3"/><rect x="1" y="7" width="7" height="3"/>${cannon(7, 2)}`,
  stack: `<rect x="3" y="2.5" width="10" height="4"/><rect x="3" y="9" width="10" height="4"/>`,
  treesHill: `<path d="M1 14c2-4 4-6 7-6s5 2 7 6z"/><path d="M5 8l2-5 2 5z" fill="currentColor"/>`,
  eyeTrees: `<path d="M1 9c2-3 4-4 7-4s5 1 7 4c-2 3-4 4-7 4s-5-1-7-4z"/><circle cx="8" cy="9" r="1.8" fill="currentColor"/><path d="M3 4l1.5-3L6 4z"/>`,
  twoFigures: `${figure(-1)}${figure(6)}`,
  gate: `<path d="M2 15V3M14 15V3M2 6h12M2 11h12M5 6v5M8 6v5M11 6v5"/>`,
  arrowBack: `${arrow(14, 3, 4, 13)}<circle cx="3" cy="13" r="1.4" fill="currentColor"/>`,
  mapPin: `<path d="M8 15s5-5 5-8.5a5 5 0 0 0-10 0C3 10 8 15 8 15z"/><circle cx="8" cy="6.5" r="1.8"/>`,
  horseshoes: `${shoe(0, 2)}${shoe(6, 2)}${arrow(4, 15, 8, 12)}`,
  twoHorseshoes: `${shoe(0, 3)}${shoe(6, 3)}`,
  twoHorses: `<path d="M2 14V8l2-4 2 1-1 3h1v6M9 14V8l2-4 2 1-1 3h1v6"/>`,
  squareOutline: `<rect x="3" y="3" width="10" height="10"/><rect x="6" y="6" width="4" height="4" fill="currentColor" fill-opacity=".4"/>`,
  wheelMud: `<circle cx="8" cy="7" r="4.5"/><path d="M8 2.5v9M3.5 7h9M1 13c3-1.5 11-1.5 14 0"/>`,
  horseCannon: `<path d="M1 14V9l1.5-3 1.5.8-.6 2h.6v5"/>${cannon(6, 1)}`,
  pin: `<path d="M8 15V9M5 2h6l-1 4 2 3H4l2-3z"/>`,
  dot: `<circle cx="8" cy="8" r="2.5" fill="currentColor"/>`,
};
export function iconSvg(name){
  return `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.dot}</svg>`;
}
export const ICON_NAMES = Object.keys(ICONS);
