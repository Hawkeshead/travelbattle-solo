/* =========================================================
   PARAMETER SWEEP

   Every scoring weight in this AI was set by hand from single human matches,
   and the same terms keep drifting: threat to -5.00, engage to +0.42,
   soloAttackPenalty to -4.80, each a hand adjustment that overshot and was
   walked back. The simulator makes it possible to MEASURE the right value.

   One term, a list of values, a frozen opponent. For each value it runs N
   matches with sides swapped and records the win rate, then prints a table and
   writes a plot.

   Usage:
     node tools/sim/sweep.mjs ENGAGE_CLAMP 2,2.5,3,3.5,4,4.5,5,5.5,6 \
       --vs alexander --matches 50 --out sweeps/engage

   THE RULES THIS ENFORCES, because each one has a way of being broken quietly:
     ONE TERM ONLY. Two at once gives a result nobody can interpret, so a comma
       in the term name is refused outright.
     A FROZEN CONTROL. Never main, because main moves under the sweep and the
       comparison stops meaning anything. Refused if --vs is absent or is main.
     SEEDS RECORDED. Every value runs the same seed range from the same start,
       so any single match in the sweep can be replayed with
       run.mjs 1 --seed N --set TERM=VALUE --vs CONTROL.
     UNDECIDED MATCHES EXCLUDED from the win rate and reported separately, as
       everywhere else.

   The recommendation rule is the one from the brief: take the peak, unless the
   peak sits at an end of the range (sweep wider before trusting it) or the value
   one step below is within two points and carries fewer flags, in which case
   take the safer one.
========================================================= */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const term = args[0];
const values = String(args[1] || '').split(',').map(Number).filter(v => Number.isFinite(v));
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : fallback;
};
const control = opt('--vs', null);
const matches = Number(opt('--matches', 20));
const firstSeed = Number(opt('--seed', 1));
const outDir = resolve(HERE, '../../', opt('--out', `sweeps/${term}-${Date.now()}`));

if (!term || term.includes(',') || !values.length) {
  console.error('usage: sweep.mjs TERM v1,v2,v3 --vs <frozen baseline> [--matches N] [--out dir]');
  console.error('one term only: sweeping two at once gives an uninterpretable result');
  process.exit(2);
}
if (!control || control === 'main') {
  console.error('a sweep needs a FROZEN control (cerberus, saladin, alexander). Never main: it moves.');
  process.exit(2);
}

/* run.mjs counts SEEDS and plays each twice with the sides swapped, so half as
   many seeds as matches. */
const seeds = Math.max(1, Math.round(matches / 2));
const rows = [];
console.log(`Sweep: ${term} vs ${control}, ${seeds * 2} matches per value, sides swapped`);
console.log(`Seeds ${firstSeed} to ${firstSeed + seeds - 1}, the same range for every value.\n`);

for (const v of values) {
  const out = execFileSync(process.execPath,
    [resolve(HERE, 'run.mjs'), String(seeds), '--set', `${term}=${v}`, '--vs', control,
     '--seed', String(firstSeed)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  const num = re => { const m = out.match(re); return m ? Number(m[1]) : null; };
  const row = {
    value: v,
    win: num(/win rate\s+\d+\/\d+\s+([\d.]+)%/),
    asBritain: num(/as Britain\s+\d+\/\d+\s+([\d.]+)%/),
    asFrance: num(/as France\s+\d+\/\d+\s+([\d.]+)%/),
    decided: num(/decided\s+(\d+) of/),
    stalled: num(/stalled\s+(\d+) /),
    turns: num(/turns\s+shortest \d+\s+median (\d+)/),
  };
  rows.push(row);
  console.log(`  ${String(v).padEnd(6)} ${String(row.win ?? '-').padStart(5)}%   ` +
    `decided ${row.decided}, stalled ${row.stalled}, median ${row.turns} turns`);
}

const best = rows.reduce((a, b) => (b.win ?? -1) > (a.win ?? -1) ? b : a);
const atEnd = best.value === values[0] || best.value === values[values.length - 1];
const below = rows[rows.indexOf(best) - 1];
const safer = below && (best.win - below.win) <= 2 && (below.stalled < best.stalled);
const recommended = safer ? below : best;
const note = atEnd
  ? `Peak ${best.value} sits at the end of the range: sweep wider before trusting it.`
  : safer
    ? `Peak ${best.value} (${best.win}%), but ${below.value} is within two points with fewer undecided matches.`
    : `Peak ${best.value} (${best.win}%).`;

const table = [
  `Sweep: ${term} vs ${control}, ${seeds * 2} matches per value, sides swapped`,
  `Seeds ${firstSeed} to ${firstSeed + seeds - 1} for every value. Replay any match with:`,
  `  node tools/sim/run.mjs 1 --seed <N> --set ${term}=<value> --vs ${control}`,
  '',
  'value   winRate   asFrance   asBritain   decided   stalled   medianTurns',
  ...rows.map(r => `${String(r.value).padEnd(8)}${String(r.win ?? '-').padEnd(10)}` +
    `${String(r.asFrance ?? '-').padEnd(11)}${String(r.asBritain ?? '-').padEnd(12)}` +
    `${String(r.decided).padEnd(10)}${String(r.stalled).padEnd(10)}${r.turns ?? '-'}`),
  '',
  note,
  `Recommended: ${recommended.value}`,
  '',
  'NOT TO BE APPLIED TO MAIN ON THE STRENGTH OF ONE SWEEP. Terms interact; the',
  'set must be re-swept with the others at their new values first.',
].join('\n');

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/summary.txt`, table + '\n');

/* An SVG rather than a PNG: no dependency, opens in any browser, and stays
   readable in a diff. */
const W = 720, H = 380, PAD = 56;
const xs = values, ys = rows.map(r => r.win ?? 0);
const xAt = v => PAD + (values.indexOf(v) / Math.max(1, values.length - 1)) * (W - PAD * 2);
const yAt = p => H - PAD - ((p - 20) / 60) * (H - PAD * 2);
const line = (key, colour) => `<polyline fill="none" stroke="${colour}" stroke-width="2" points="` +
  rows.map(r => `${xAt(r.value).toFixed(1)},${yAt(r[key] ?? 0).toFixed(1)}`).join(' ') + '"/>';
writeFileSync(`${outDir}/winrate.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#fff"/>
<text x="${PAD}" y="28" font-family="sans-serif" font-size="15">${term} vs ${control} — win rate by value</text>
${[20,35,50,65,80].map(p=>`<line x1="${PAD}" y1="${yAt(p)}" x2="${W-PAD}" y2="${yAt(p)}" stroke="#ddd"/>` +
  `<text x="8" y="${yAt(p)+4}" font-family="sans-serif" font-size="11">${p}%</text>`).join('')}
<line x1="${PAD}" y1="${yAt(50)}" x2="${W-PAD}" y2="${yAt(50)}" stroke="#999" stroke-dasharray="4 3"/>
${line('win', '#1a5fb4')}${line('asFrance', '#e01b24')}${line('asBritain', '#2ec27e')}
${xs.map(v=>`<text x="${xAt(v)}" y="${H-PAD+18}" font-family="sans-serif" font-size="11" text-anchor="middle">${v}</text>`).join('')}
<text x="${W-PAD}" y="${H-14}" font-family="sans-serif" font-size="11" text-anchor="end">blue overall · red as France · green as Britain</text>
</svg>\n`);

console.log('\n' + note + `\nRecommended: ${recommended.value}`);
console.log(`\nwritten to ${outDir}/summary.txt and winrate.svg`);
