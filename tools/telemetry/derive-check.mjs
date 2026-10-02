/* =========================================================
   DERIVED MEASURES AGAINST THE EXPORT (telemetry build spec, step 4)

   For each record file written by recorder-check.mjs (--child SEED on), the
   counts the record derived must equal the ones the match export's summary
   section prints: casualties per side, fights, artillery shots and hits,
   volleys, and bonuses per side. It reads files; it plays nothing.

   Usage: node tools/telemetry/derive-check.mjs SEED [SEED ...]
========================================================= */
import fs from 'node:fs';
const seeds = process.argv.slice(2).map(Number).filter(Boolean);
let bad = 0;
for (const seed of seeds) {
  const f = `/tmp/fc-reccheck-${seed}-on.json`;
  if (!fs.existsSync(f)) { console.log(`seed ${seed}: no record file`); bad++; continue; }
  const { record: rec } = JSON.parse(fs.readFileSync(f, 'utf8'));
  const t = (rec && rec.text && rec.text.exportText) || '';
  const sec = t.slice(t.indexOf('=== SECTION 5'), t.indexOf('=== SECTION 6'));
  const num = (re) => { const m = sec.match(re); return m ? Number(m[1]) : null; };
  const bonus = side => [...sec.matchAll(new RegExp(`^\\s+(\\d+)\\s+${side} \\|`, 'gm'))].reduce((n, m) => n + Number(m[1]), 0);
  const fromExport = {
    casualties_b: num(/Britain: (\d+) lost/), casualties_f: num(/France: (\d+) lost/),
    fights: num(/Combat: (\d+) fights/), art_shots: num(/fights, (\d+) artillery shots/), art_hits: num(/shots \((\d+) hit/),
    volleys: num(/volleys: (\d+) fired/) ?? 0, bonus_b: bonus('Britain'), bonus_f: bonus('France'),
  };
  const d = rec.derived || {};
  const diffs = Object.entries(fromExport).filter(([k, v]) => v !== d[k]).map(([k, v]) => `${k} export ${v} record ${d[k]}`);
  if (!rec.text.exportText) diffs.push('no export text in the record');
  console.log(`seed ${seed}: ${diffs.length ? 'DIFFERENT: ' + diffs.join('; ') : 'all equal'}  (${JSON.stringify(fromExport)})` +
    `  terms ${rec.terms.length}, missed ${d.missed_opp_count}, flags ${d.flag_count}, faults ${d.recorder_faults || 0}`);
  if (diffs.length) bad++;
}
process.exit(bad ? 1 : 0);
