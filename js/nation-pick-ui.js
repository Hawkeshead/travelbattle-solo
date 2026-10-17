/* =========================================================
   NATION PICKS FOR THE FOUR-ARMY GAME (17 Oct 2026, all nations)

   One row per army: its edge, then a chip for every nation its side may
   field. A nation the army cannot take beside its side's other army (the
   limits in js/nations.js: one army per nation, Russia and France up to two)
   is greyed out with the reason beside it. Used by Pass and Play
   (ui-group.js) and the online lobby (online-group.js); the caller says which
   rows this player may change and what a tap does.
========================================================= */
import { SIDES } from './data-core.js';
import { NATIONS, nationsForSide } from './nations.js';
import { NATION_FLAG } from './nation-flags.js';
import { DEFAULT_GROUP_NATIONS, groupNationProblem } from './group.js';

const ROWS = [
  { id: 'red1', side: SIDES.RED, edge: 'south' }, { id: 'red2', side: SIDES.RED, edge: 'east' },
  { id: 'blue1', side: SIDES.BLUE, edge: 'north' }, { id: 'blue2', side: SIDES.BLUE, edge: 'west' },
];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* picks: { red1: 'britain', ... } (missing ones read as the default).
   canEdit(armyId): may this player change that army's nation. */
export function groupNationRowsHtml(picks, canEdit){
  const p = { ...DEFAULT_GROUP_NATIONS, ...(picks || {}) };
  return `<div class="gnp" style="display:flex;flex-direction:column;gap:6px;margin:6px 0">${ROWS.map(r => {
    const mine = canEdit(r.id);
    const chips = nationsForSide(r.side).map(n => {
      const on = p[r.id] === n.key, why = on ? null : groupNationProblem(p, r.id, n.key);
      const off = !mine || !!why;
      return `<button type="button" data-gn="${r.id}:${n.key}" ${off ? 'disabled' : ''} title="${esc(why || n.name)}"
        style="font:inherit;font-size:12px;display:inline-flex;align-items:center;gap:4px;margin:2px;padding:2px 7px 2px 3px;border-radius:12px;
        border:2px solid ${on ? '#c8a24e' : '#b9ab8c'};background:${on ? n.colours.main : '#f6efd9'};color:${on ? '#fbf6ea' : '#2a1e14'};
        opacity:${why ? 0.4 : 1};cursor:${off ? 'default' : 'pointer'}"><span style="display:inline-block;width:18px;height:12px;line-height:0;border:1px solid rgba(0,0,0,.35)">${NATION_FLAG[n.key] || ''}</span>${esc(n.name)}</button>`;
    }).join('');
    const reasons = [...new Set(nationsForSide(r.side).map(n => p[r.id] !== n.key && groupNationProblem(p, r.id, n.key)).filter(Boolean))];
    return `<div><div style="font-size:13px;opacity:.85">${r.side === SIDES.RED ? 'Coalition' : 'Imperial'} army, ${r.edge} edge${mine ? '' : ' (chosen by its commander)'}</div>
      <div>${chips}</div>${reasons.length ? `<div style="font-size:12px;font-style:italic;opacity:.8">${esc(reasons.join('; '))}.</div>` : ''}</div>`;
  }).join('')}</div>`;
}
/* Wire the chips in root: onPick(armyId, nationKey). */
export function wireGroupNationRows(root, onPick){
  root.querySelectorAll('[data-gn]').forEach(b => b.onclick = () => {
    if(b.disabled) return;
    const [army, key] = b.dataset.gn.split(':');
    if(NATIONS[key]) onPick(army, key);
  });
}
