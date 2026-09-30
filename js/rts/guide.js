/* =========================================================
   HOW REAL-TIME WORKS: a short guide, page by page. Shown before the first
   Real-Time battle on this device, and any time from the "?" button.
   The numbers come from constants.js, so the guide never goes out of date
   when the timings are tuned.
========================================================= */
import { ARTILLERY_RELOAD_TICKS, COOLDOWN_TICKS, FORM_TICKS, LIMBER_TICKS, MATCH_CLOCK_TICKS, MELEE_ROUND_TICKS,
         ORDER_REGEN_TICKS, ROUT_TO_RALLY_TICKS, TICKS_PER_SECOND, TURNED_AROUND_TICKS, WOODS_OCCUPANCY_TICKS } from './constants.js';

const sec = t => Math.round(t / TICKS_PER_SECOND);
const SEEN_KEY = 'fc-rts-guide-seen';

const PAGES = () => [
  { title: 'Real-Time battle', body: `
    <p>The battle runs on its own clock. There are no turns: you and the enemy give orders whenever you like, and
    units carry them out at their own pace.</p>
    <p>What limits you is <b>command</b>. Every order goes through a Brigadier, and each Brigadier only has so many
    to give. Spend them well.</p>
    <p>The top of the screen shows the time left, and details of whichever unit you have selected.</p>` },
  { title: 'Moving', body: `
    <p><b>Tap one of your units, then tap a square.</b> The unit marches there square by square: infantry about
    ${sec(5 * TICKS_PER_SECOND)} s a square, cavalry and Brigadiers twice as fast, guns slower. Roads are a third faster.</p>
    <p>The <b>gold squares</b> show how far one order can take it (the same distance as one turn-based move).</p>
    <p>The <b>ring</b> round each of your units is its readiness: a thin full ring means ready; a filling arc means it
    is still moving or recovering (about ${sec(COOLDOWN_TICKS.INFANTRY)} s for infantry and guns,
    ${sec(COOLDOWN_TICKS.LIGHT_CAV)} s for cavalry, after each order).</p>` },
  { title: 'Orders and Brigadiers', body: `
    <p>The <b>dots over each Brigadier</b> are his orders: gold for ready, dark for used. Every order to one of his
    units costs one. <b>Moving the Brigadier himself is free.</b></p>
    <p>He gets a new order every <b>${sec(ORDER_REGEN_TICKS)} s</b>, and can bank up to one per unit he commands, so
    saving them up lets you move a whole Brigade at once.</p>
    <p>If an order is refused, a note says why: no orders left, still moving, not ready yet, out of range, or out of
    the chain.</p>` },
  { title: 'The chain of command', body: `
    <p>As in the turn-based game, a unit can only take an order if it is linked to its Brigadier: next to him, or next
    to another unit of his Brigade that is.</p>
    <p>A <b>red dot</b> on a unit means it is cut off. It finishes what it was doing, then waits. <b>Move the
    Brigadier back to it</b> (it costs nothing) and it can be ordered again.</p>
    <p>A good habit: move the Brigadier along behind his Brigade as it advances.</p>` },
  { title: 'Moving several at once', body: `
    <p><b>Group</b> (top right): switch it on, tap several of your units, then tap a square. They all go, each to its
    own square nearby, for one order each. If the Brigadier cannot pay for all of them, none go.</p>
    <p><b>Columns</b>: select an infantry unit, tap <b>Stack</b>, then tap a friendly infantry unit next to it. When
    the two share a square, tap <b>Form Column</b> (one order, ${sec(FORM_TICKS.COLUMN)} s). From then on they move
    together for one order and hit harder when they attack. <b>Split Column</b> separates them.</p>` },
  { title: 'Fighting', body: `
    <p><b>Fights start by themselves.</b> Any two enemy units side by side fight, a round every
    ${sec(MELEE_ROUND_TICKS)} s, until one gives way. The unit that moved into contact is the attacker. Brigadiers
    never fight.</p>
    <p>Each round uses the turn-based dice and bonuses (hills, woods, Square against cavalry, the charge and the rest).
    The result pops up over the fight:</p>
    <p>&bull; <b>Win by 1</b>: the loser is pushed back a square and <b>turned around</b> for ${sec(TURNED_AROUND_TICKS)} s
    (it cannot be ordered, and attackers get +1).<br>
    &bull; <b>Win by 2</b>: the loser <b>routs</b>. If it rallies it runs to its own edge and needs
    ${sec(ROUT_TO_RALLY_TICKS)} s to recover; if not, it is lost (the Brigadier may save it once a battle).<br>
    &bull; <b>Win by 3 or more</b>: the loser is <b>destroyed</b>.<br>
    &bull; A draw fights on. To break off, order your unit away.</p>
    <p>A unit marching past an enemy stops when it comes alongside: contact is a commitment. Units already avoid
    walking beside the enemy unless you send them there.</p>` },
  { title: 'Charges, woods and hills', body: `
    <p><b>Cavalry charge</b>: send cavalry two squares in a straight line into the enemy and it wins ties on the
    first round (not against a Square or uphill).</p>
    <p><b>Woods</b> protect a defender, but only once it has stood there ${sec(WOODS_OCCUPANCY_TICKS)} s.</p>
    <p><b>Higher ground</b> wins ties for the defender.</p>
    <p>A red pulsing ring on one of your guns means enemy cavalry is close to it.</p>` },
  { title: 'Guns', body: `
    <p><b>Select a gun, then tap an enemy</b> in range and sight. That one order locks it on: it fires straight away
    and then every <b>${sec(ARTILLERY_RELOAD_TICKS)} s</b> until the target is gone or out of sight. A dashed line
    shows what each gun is aiming at.</p>
    <p>Close up (2 squares or less) it fires canister: two dice. A gun with an enemy beside it stops firing and fights.</p>
    <p>Moving a gun drops its target, and it takes ${sec(LIMBER_TICKS)} s to limber up first.</p>` },
  { title: 'Formations', body: `
    <p>Buttons for these appear at the top when you select an infantry unit:</p>
    <p>&bull; <b>Form Square</b> (${sec(FORM_TICKS.SQUARE)} s): strong against cavalry, but it cannot move and never
    starts a fight. <b>Form Line</b> undoes it.<br>
    &bull; <b>Lay Ambush</b> (${sec(FORM_TICKS.AMBUSH)} s, in woods, alone): the unit is hidden, and when an enemy steps
    beside it, it strikes first with +1.<br>
    &bull; <b>Stack / Form Column</b>: see Moving several at once.</p>
    <p>A unit caught changing formation fights at &minus;1.</p>` },
  { title: 'Winning', body: `
    <p>An army <b>breaks</b> when two of its three Brigades have lost every unit. Break the enemy first.</p>
    <p>If nobody has broken after <b>${Math.round(MATCH_CLOCK_TICKS / TICKS_PER_SECOND / 60)} minutes</b>, points
    decide: the value of the enemy units you destroyed (Guard, cavalry and guns are worth more than line infantry).</p>
    <p>Switching apps or locking the phone <b>pauses</b> the battle.</p>
    <p>Open this guide again any time with the <b>?</b> button at the top right.</p>` },
];

let panel = null;
export function showGuide(onClose){
  if(panel) panel.remove();
  const pages = PAGES();
  let i = 0;
  panel = document.createElement('div');
  panel.id = 'rtsGuide';
  panel.style.cssText = 'position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:rgba(15,18,15,.72);padding:10px';
  document.body.appendChild(panel);
  const close = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ } panel.remove(); panel = null; if(onClose) onClose(); };
  const render = () => {
    const p = pages[i];
    panel.innerHTML = `<div style="max-width:620px;width:100%;max-height:100%;overflow:auto;background:#e8e0cb;color:#2a1e14;border-radius:6px;
      padding:14px 18px;box-shadow:0 14px 34px rgba(0,0,0,.5);font:15px/1.4 'IM Fell English',Georgia,serif">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.7">How Real-Time works &middot; ${i + 1} of ${pages.length}</div>
      <div style="font-family:'Cinzel',serif;font-size:19px;margin:2px 0 6px;color:#7a5a1e">${p.title}</div>
      <div class="rtsGuideBody">${p.body}</div>
      <div style="display:flex;gap:8px;justify-content:space-between;margin-top:10px">
        <button data-g="close" style="font:inherit;min-height:40px;padding:6px 14px;border:0;border-radius:4px;background:transparent;color:#2a1e14;text-decoration:underline;cursor:pointer">${i === pages.length - 1 ? 'Close' : 'Skip'}</button>
        <span style="display:flex;gap:8px">
          ${i > 0 ? `<button data-g="back" style="font:inherit;min-height:40px;padding:6px 16px;border:1px solid #9a8b6c;border-radius:4px;background:transparent;color:#2a1e14;cursor:pointer">Back</button>` : ''}
          <button data-g="next" style="font:inherit;min-height:40px;padding:6px 18px;border:0;border-radius:4px;background:#5b6b3a;color:#fbf6ea;cursor:pointer">${i === pages.length - 1 ? 'To battle' : 'Next'}</button>
        </span>
      </div></div>`;
    panel.querySelectorAll('.rtsGuideBody p').forEach(el => { el.style.margin = '0 0 6px'; });
    panel.querySelector('[data-g="close"]').onclick = close;
    panel.querySelector('[data-g="next"]').onclick = () => { if(i < pages.length - 1){ i++; render(); } else close(); };
    const back = panel.querySelector('[data-g="back"]'); if(back) back.onclick = () => { i--; render(); };
  };
  render();
}
export function guideSeen(){ try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } }
