/* THE AI DECISION TRACE IS READ-ONLY (js/ai-trace.js, the Spyglass overlay).

   The trace records what the AI weighed so the Spyglass can draw it. It must
   never change a game: these check the trace module on its own, and the way
   ai-strategy is wired to it.

   Like the rest of the suite this runs without a browser, so it does not play
   a match (importing ai-strategy pulls in the whole DOM chain). The match-level
   proof, one fixed-seed match played with the trace off and on and compared
   move for move and in its whole final state, is tools/sim/spyglass-check.mjs. */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import * as trace from '../js/ai-trace.js';

const traceSrc = fs.readFileSync(new URL('../js/ai-trace.js', import.meta.url), 'utf8');
const aiSrc = fs.readFileSync(new URL('../js/ai-strategy.js', import.meta.url), 'utf8');

/* A small stand-in for the game state and an AI decision, frozen all the way
   down: any write the trace made to what it is given would throw. */
const deepFreeze = o => { if(o && typeof o === 'object' && !Object.isFrozen(o)){ Object.freeze(o); for(const v of Object.values(o)) deepFreeze(v); } return o; };
const fakeState = () => deepFreeze({ turnNumber: 3, units: [{ id: 'u1', side: 'blue', x: 4, y: 2, brigadeId: 0 }], moved: [] });
const decision = () => deepFreeze({ unitId: 'u1', side: 'blue', brigadeId: 0, phase: 'move', action: 'move',
  from: { x: 4, y: 2 }, to: { x: 4, y: 3 }, target: null,
  candidates: [{ x: 4, y: 2, score: 1.1, stay: true }, { x: 4, y: 3, score: 1.6, stay: false }],
  chosen: { x: 4, y: 3, score: 1.6, terms: { advancePull: -1.4, threat: -0.3 } },
  runnerUp: { x: 4, y: 2, score: 1.1, terms: { advancePull: -1.75, threat: -0.1 } } });

test('the trace module touches nothing in the game: it imports nothing at all', () => {
  assert.ok(!/^\s*import\s/m.test(traceSrc), 'ai-trace.js must stay a leaf module with no imports');
  assert.ok(!/\bstate\b\s*[.[]/.test(traceSrc), 'ai-trace.js must not reach the game state');
});

test('with capture off (the default) nothing is recorded', () => {
  trace.resetTrace(); trace.setTraceCapture(false);
  trace.traceTurn(3, 'blue', [{ id: 0, order: 'Assault' }]);
  trace.traceDecision(decision());
  assert.strictEqual(trace.currentTrace(), null);
  assert.deepStrictEqual(trace.traceStats(), { turns: 0, brigades: 0, decisions: 0, candidates: 0 });
});

test('capture leaves what it is given untouched, and the game state with it', () => {
  const st = fakeState(), before = JSON.stringify(st);
  trace.resetTrace(); trace.setTraceCapture(true);
  // Frozen inputs: a single write inside the trace would throw here.
  trace.traceTurn(st.turnNumber, 'blue', deepFreeze([{ id: 0, brigadier: { x: 4, y: 1 }, units: ['u1'], order: 'Assault', objective: { x: 4, y: 8 } }]));
  trace.traceDecision(decision());
  const seen = [];
  const off = trace.onTrace((kind, item) => { seen.push(kind); item.scribble = true; });   // a listener that misbehaves
  trace.traceDecision(decision());   // its write to the frozen decision throws inside the trace and is swallowed
  off();
  assert.strictEqual(JSON.stringify(st), before);
  assert.deepStrictEqual(trace.traceStats(), { turns: 1, brigades: 1, decisions: 2, candidates: 4 });
  assert.deepStrictEqual(seen, ['decision']);
  trace.setTraceCapture(false); trace.resetTrace();
});

test('the pause gate runs the next step at once when nothing has set it', () => {
  trace.setStepGate(null);
  let ran = 0; trace.stepGate(() => ran++);
  assert.strictEqual(ran, 1);
  let held = null; trace.setStepGate(next => { held = next; });
  trace.stepGate(() => ran++);
  assert.strictEqual(ran, 1); held(); assert.strictEqual(ran, 2);
  trace.setStepGate(null);
});

test('the AI only writes to the trace, never reads it back', () => {
  const m = aiSrc.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/ai-trace\.js'/);
  assert.ok(m, 'ai-strategy imports the trace');
  const names = m[1].split(',').map(s => s.trim()).filter(Boolean).sort();
  assert.deepStrictEqual(names, ['stepGate', 'traceDecision', 'traceOn', 'traceTurn']);
  for(const reader of ['currentTrace', 'lastTrace', 'onTrace', 'traceStats']) assert.ok(!aiSrc.includes(reader + '('), `ai-strategy must not call ${reader}`);
});

test('the trace never draws from the seeded random stream or fills an AI cache', () => {
  const block = aiSrc.slice(aiSrc.indexOf('THE DECISION TRACE (js/ai-trace.js'), aiSrc.indexOf('export function aiDoMovePhase('));
  assert.ok(block.length > 500, 'trace block found');
  assert.ok(!/seededRandom\s*\(/.test(block), 'no random draws in the trace');
  for(const filler of ['getDefensiveRallyPoint(', 'shelterDestination(', 'preserveDestination(', 'gunSiteFor(', 'gunsFirstMul(', 'missionMoveBonus('])
    assert.ok(!block.includes(filler), `the trace must read ${filler.slice(0, -1)}'s cache, not call it`);
  assert.ok(!/state\.[A-Za-z_]+\s*=[^=]/.test(block), 'the trace assigns nothing on state');
});
