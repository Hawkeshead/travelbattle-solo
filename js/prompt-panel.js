/* =========================================================
   COMPACT PROMPTS IN THE DICE PANEL (Leadership Roll, Ambush)

   Presentation only. The questions, their answers and every path that asks
   them (humanOwns, askRemote, the AI) are unchanged; this replaces the
   full-screen #overlay they used to open with a small card in the dice
   panel's slot at the top of the board:

     title (Cinzel)
     two 40 px portraits, "+" or "vs" between
     one line (Cormorant, bold) and one line of small print (IBM Plex Mono)
     two buttons side by side: medallion icon, one-word label, short caption
     "?" in the corner: the full rules text, folded away below the buttons

   While a prompt is open the units involved get a soft pulsing brass glow on
   the board (render-board.js promptGlow); the board is not dimmed. Online,
   on the phone answering for the other player, a brass bar drains along the
   bottom of the panel over the answer window, and the prompt closes when it
   runs out (the asking phone then applies its fallback, as before).

   The panel's frame and parchment (assets/ui/) are switched on only once
   both images have loaded; until then, or if they fail, the plain panel
   styling stays.
========================================================= */
import { setPromptGlow } from './render-board.js';
import { flushPendingSettle, showDice, unlockDicePanel } from './dice.js';

const UI = 'assets/ui/';
// Written out in full so check-assets.mjs can find every file.
export const PROMPT_ART = ['assets/ui/panel_frame.webp', 'assets/ui/panel_map_centre.webp', 'assets/ui/icon_save.webp',
  'assets/ui/icon_letgo.webp', 'assets/ui/icon_hold.webp', 'assets/ui/icon_advance.webp'];

/* The frame and parchment: preloaded, and the styled panel turned on only
   when both are really there. */
if(typeof Image !== 'undefined' && typeof document !== 'undefined'){
  let ok = 0;
  const need = [`${UI}panel_frame.webp`, `${UI}panel_map_centre.webp`];
  for(const src of need){
    const img = new Image();
    img.onload = () => { if(++ok === need.length) document.documentElement.classList.add('panel-art'); };
    img.src = src;
  }
  for(const src of PROMPT_ART.slice(2)){ const i = new Image(); i.src = src; }
}

/* The answer window for the other player's questions online: the asking phone
   waits this long (askRemote(..., 30000) in engine-rules.js and ui-battle.js)
   before applying its fallback. */
export const ANSWER_WINDOW_MS = 30000;

let open = null;   // { el, timers }

function parts(){
  const overlay = document.getElementById('diceOverlay');
  const panel = overlay.querySelector('.dice-panel');
  let el = panel.querySelector('.panel-prompt');
  if(!el){ el = document.createElement('div'); el.className = 'panel-prompt'; panel.appendChild(el); }
  return { overlay, panel, el };
}

/* opts: { title, portraits:[html, html], joiner, line, small, buttons:[{label, caption, icon, primary, value}],
           rulesHTML, units:[u, u], answerMs, onChoose(value), afterChoose: 'close' | 'roll' } */
export function showPanelPrompt(opts){
  closePanelPrompt(false);
  /* The same guard the roll pipeline uses (dice.js presentRollTrigger): an
     earlier fight still fading out applies its result now, and its fade timer
     is cancelled so it cannot close the panel under the question. */
  clearTimeout(showDice._fadeT);
  flushPendingSettle();
  unlockDicePanel();
  const { overlay, panel, el } = parts();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  el.innerHTML = `
    <button class="pp-help" type="button" aria-label="Rules" aria-expanded="false">?</button>
    <div class="pp-title">${esc(opts.title)}</div>
    <div class="pp-faces"><div class="dice-face pp-face">${opts.portraits[0] || ''}</div><span class="pp-join">${esc(opts.joiner)}</span><div class="dice-face pp-face">${opts.portraits[1] || ''}</div></div>
    <div class="pp-line">${esc(opts.line)}</div>
    <div class="pp-small">${esc(opts.small)}</div>
    <div class="pp-buttons">${opts.buttons.map((b, i) => `
      <button type="button" class="pp-btn ${b.primary ? 'pp-primary' : 'pp-secondary'}" data-i="${i}">
        <img src="${UI}${b.icon}.webp" alt="" onerror="this.style.display='none'">
        <span class="pp-text"><span class="pp-label">${esc(b.label)}</span><span class="pp-caption">${esc(b.caption)}</span></span>
      </button>`).join('')}</div>
    <div class="pp-rules" hidden>${opts.rulesHTML || ''}</div>
    ${opts.answerMs ? `<div class="pp-timer"><div class="pp-timer-fill"></div></div>` : ''}`;
  panel.classList.add('prompting');
  overlay.classList.add('show');
  const timers = [];
  open = { el, timers };
  setPromptGlow((opts.units || []).filter(Boolean).map(u => u.id));

  const help = el.querySelector('.pp-help'), rules = el.querySelector('.pp-rules');
  help.onclick = () => { rules.hidden = !rules.hidden; help.setAttribute('aria-expanded', String(!rules.hidden)); };
  el.querySelectorAll('.pp-btn').forEach(btn => {
    btn.onclick = () => {
      const b = opts.buttons[Number(btn.dataset.i)];
      closePanelPrompt(opts.afterChoose !== 'roll');
      if(opts.afterChoose === 'roll'){
        // Straight on into the dice roll in the same panel; if no roll arrives
        // (it always should), the panel closes itself rather than hang empty.
        panel.querySelector('.dice-groups').innerHTML = '';
        setTimeout(() => {
          if(!panel.querySelector('.dice-groups').children.length && !panel.classList.contains('prompting')) overlay.classList.remove('show');
        }, 2000);
      }
      opts.onChoose(b.value);
    };
  });
  if(opts.answerMs){
    const fill = el.querySelector('.pp-timer-fill');
    fill.style.transition = 'none'; fill.style.width = '100%';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fill.style.transition = `width ${opts.answerMs}ms linear`; fill.style.width = '0%';
    }));
    // The window has closed on the asking phone: it applies its fallback, so
    // the question goes away here too (no answer is sent).
    timers.push(setTimeout(() => closePanelPrompt(true), opts.answerMs));
  }
}

export function closePanelPrompt(hidePanel){
  if(!open) return;
  for(const t of open.timers) clearTimeout(t);
  const { overlay, panel, el } = parts();
  el.innerHTML = '';
  panel.classList.remove('prompting');
  if(hidePanel) overlay.classList.remove('show');
  setPromptGlow(null);
  open = null;
}
export const panelPromptOpen = () => !!open;
