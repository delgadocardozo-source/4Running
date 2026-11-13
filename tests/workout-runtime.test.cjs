const assert = require('node:assert/strict');
const { WorkoutRuntime } = require('../workout-runtime.js');

const block = (type, seconds, speed = type === 'run' ? 9 : 5) => ({ type, seconds, speed });
let cases = 0;
function test(name, run) {
  run(); cases += 1; console.log(`ok ${name}`);
}
function approximately(actual, expected) { assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} should equal ${expected}`); }
function clock() { let at = 0; return { now: () => at, set: value => { at = value; return at; } }; }

test('authoritative wall clock catches up through every phase and ends exactly', () => {
  const c = clock(); const runtime = new WorkoutRuntime([block('warm', 5), block('run', 10), block('walk', 5), block('cool', 5)], { now: c.now });
  assert.equal(runtime.state().started, false);
  runtime.start();
  const middle = runtime.sync(c.set(17000));
  assert.equal(middle.index, 2); assert.equal(middle.currentType, 'walk'); assert.equal(middle.remainingMs, 3000);
  assert.deepEqual(middle.transitions.map(change => change.at), [5000, 15000]);
  const done = runtime.sync(c.set(80000));
  assert.equal(done.finished, true); assert.equal(done.running, false); assert.equal(done.elapsedMs, 25000);
  const summary = runtime.summary();
  assert.equal(summary.runSeconds, 10); assert.equal(summary.walkSeconds, 15); assert.equal(summary.maxRunBlockSec, 10);
  assert.equal(summary.completedBlocks, 4); assert.equal(summary.prescriptionCompleted, true);
  assert.equal(runtime.resume().finished, true, 'resume never restarts a finished workout');
});

test('visiting the same block twice records 40+30 seconds and a longest run of 40', () => {
  const c = clock(); const runtime = new WorkoutRuntime([block('run', 60), block('walk', 60)], { now: c.now });
  runtime.resume(); runtime.goToBlock(0, c.set(40000)); runtime.pause(c.set(70000));
  const summary = runtime.summary();
  assert.equal(summary.runSeconds, 70); assert.equal(summary.maxRunBlockSec, 40);
  assert.equal(summary.blocks[0].longestRunSeconds, 40);
  assert.equal(summary.blocks[0].actualSeconds, 70); assert.equal(summary.blocks[0].completed, true);
  assert.equal(summary.ledger.length, 2); assert.equal(summary.ledger[0].endedAt, 40000);
  assert.equal(summary.prescriptionCompleted, false, 'the unvisited walk remains incomplete');
});

test('pause excludes paused time and splits continuous running while fulfilling prescription', () => {
  const c = clock(); const runtime = new WorkoutRuntime([block('run', 60)], { now: c.now });
  runtime.start(); runtime.pause(c.set(40000));
  assert.equal(runtime.state(c.set(100000)).elapsedMs, 40000);
  runtime.resume(); runtime.update(c.set(120000));
  const summary = runtime.summary();
  assert.equal(summary.runSeconds, 60); assert.equal(summary.maxRunBlockSec, 40);
  assert.equal(summary.blocks[0].longestRunSeconds, 40);
  assert.equal(summary.prescriptionCompleted, true); assert.equal(summary.ledger[0].segments.length, 2);
});

test('run-to-walk conversion preserves original prescription and records actual activities', () => {
  const c = clock(); const runtime = new WorkoutRuntime([block('run', 60, 9), block('walk', 30, 5)], { now: c.now });
  runtime.resume(); const converted = runtime.convertToWalk(c.set(20000));
  assert.equal(converted.type, 'walk'); assert.equal(runtime.blocks[0].type, 'run'); assert.equal(converted.remainingMs, 40000);
  runtime.update(c.set(90000));
  const summary = runtime.summary();
  assert.equal(summary.runSeconds, 20); assert.equal(summary.walkSeconds, 70); assert.equal(summary.maxRunBlockSec, 20);
  assert.equal(summary.blocks[0].convertedToWalk, true); assert.equal(summary.blocks[0].completed, false);
  assert.equal(summary.blocks[0].fulfilledSeconds, 20); assert.equal(summary.prescriptionCompleted, false);
  approximately(summary.distanceKm, (20 * 9 + 70 * 5) / 3600);
});

test('changing speed keeps historical distance and does not split continuous running', () => {
  const c = clock(); const runtime = new WorkoutRuntime([block('run', 60, 6)], { now: c.now });
  runtime.start(); runtime.setSpeeds({ run: 12 }, c.set(30000)); runtime.pause(c.set(60000));
  const summary = runtime.summary();
  approximately(summary.distanceKm, 0.15); assert.equal(summary.maxRunBlockSec, 60);
  assert.deepEqual(summary.ledger[0].segments.map(segment => segment.speedKmh), [6, 12]);
  assert.equal(summary.ledger[0].segments[0].continuityId, summary.ledger[0].segments[1].continuityId);
});

test('running snapshot restores elapsed wall time, phase and ledger without duplication', () => {
  const c = clock(); const runtime = new WorkoutRuntime([block('warm', 5), block('run', 60), block('walk', 10)], { now: c.now });
  runtime.start(); const snapshot = JSON.parse(JSON.stringify(runtime.snapshot(c.set(25000))));
  const restored = WorkoutRuntime.restore(snapshot, { now: () => 50000 });
  assert.equal(restored.state().index, 1); assert.equal(restored.state().remainingMs, 15000);
  assert.equal(restored.summary().runSeconds, 45); assert.equal(restored.summary().maxRunBlockSec, 45);
  assert.equal(restored.summary().walkSeconds, 5);
  assert.equal(restored.summary().ledger[1].segments.length, 1, 'restoring a running phase keeps the same visit');
  const second = WorkoutRuntime.restore(restored.snapshot(), { now: () => 80000 });
  assert.equal(second.state().finished, true); assert.equal(second.summary().runSeconds, 60); assert.equal(second.summary().walkSeconds, 15);
});

test('paused snapshot restores without accruing time during reload and later resume starts a new run segment', () => {
  const c = clock(); const runtime = new WorkoutRuntime([block('run', 60)], { now: c.now });
  runtime.start(); runtime.pause(c.set(25000));
  const snapshot = JSON.parse(JSON.stringify(runtime.snapshot()));
  const restored = WorkoutRuntime.restore(snapshot, { now: () => 100000 });
  assert.equal(restored.state().running, false); assert.equal(restored.state().elapsedMs, 25000); assert.equal(restored.state().remainingMs, 35000);
  restored.resume(100000); restored.pause(135000);
  assert.equal(restored.summary(135000).runSeconds, 60); assert.equal(restored.summary(135000).maxRunBlockSec, 35);
});

test('finished snapshot remains available for closure after reload', () => {
  const runtime = new WorkoutRuntime([block('run', 10)], { now: () => 0 }); runtime.resume(0);
  const snapshot = runtime.snapshot(10000);
  const restored = WorkoutRuntime.restore(JSON.parse(JSON.stringify(snapshot)), { now: () => 999999 });
  assert.equal(restored.state().finished, true); assert.equal(restored.state().elapsedMs, 10000);
  assert.equal(restored.summary().prescriptionCompleted, true); assert.equal(restored.resume().finished, true);
});

test('extras preserve the original dose and walking an extra does not erase fulfilled running', () => {
  const c = clock(); const runtime = new WorkoutRuntime([block('run', 60), block('cool', 10)], { now: c.now });
  runtime.start(); runtime.adjustBudget(30, c.set(20000));
  assert.equal(runtime.blocks[0].prescribedSeconds, 60); assert.equal(runtime.blocks[0].extraSeconds, 30);
  runtime.convertToWalk(c.set(65000)); runtime.pause(c.set(70000));
  const summary = runtime.summary();
  assert.equal(summary.runSeconds, 65); assert.equal(summary.walkSeconds, 5);
  assert.equal(summary.blocks[0].completed, true); assert.equal(summary.blocks[0].hadWalkConversion, true);
  assert.equal(summary.blocks[0].convertedToWalk, false, 'only the extra was converted, prescription is fulfilled');
});

test('shortening a phase never lowers its original prescription to pretend compliance', () => {
  const runtime = new WorkoutRuntime([block('run', 60)], { now: () => 0 });
  runtime.start(0); runtime.adjustBudget(-30, 20000); runtime.sync(30000);
  assert.equal(runtime.state(30000).finished, true); assert.equal(runtime.summary(30000).runSeconds, 30);
  assert.equal(runtime.summary(30000).prescriptionCompleted, false); assert.equal(runtime.blocks[0].prescribedSeconds, 60);
});

test('consecutive run phases remain uninterrupted unless navigation or pause intervenes', () => {
  const runtime = new WorkoutRuntime([block('run', 10), block('run', 20)], { now: () => 0 });
  runtime.start(0); runtime.sync(30000); assert.equal(runtime.summary(30000).maxRunBlockSec, 30);
});

test('returned blocks and snapshots cannot mutate runtime internals', () => {
  const runtime = new WorkoutRuntime([block('run', 60)], { now: () => 0 });
  runtime.blocks[0].seconds = 1;
  const snapshot = runtime.snapshot(); snapshot.blocks[0].prescribedSeconds = 1;
  assert.equal(runtime.blocks[0].prescribedSeconds, 60);
  assert.throws(() => WorkoutRuntime.restore({ version: 900 }), /Unsupported/);
  assert.throws(() => runtime.goToBlock(10), /outside/);
});

test('a converted running snapshot restores the walking phase and original run dose', () => {
  const runtime = new WorkoutRuntime([block('run', 60), block('cool', 5)], { now: () => 0 });
  runtime.start(0); runtime.convertToWalk(20000);
  const restored = WorkoutRuntime.restore(runtime.snapshot(25000), { now: () => 35000 });
  assert.equal(restored.state().currentType, 'walk'); assert.equal(restored.blocks[0].type, 'run');
  assert.equal(restored.state().remainingMs, 25000);
  assert.equal(restored.summary().runSeconds, 20); assert.equal(restored.summary().walkSeconds, 15);
  assert.equal(restored.summary().prescriptionCompleted, false);
});

test('the standalone browser script exposes the same runtime without require', () => {
  const vm = require('node:vm'); const fs = require('node:fs');
  const browser = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../workout-runtime.js'), 'utf8'), browser);
  assert.equal(typeof browser.WorkoutRuntime, 'function');
  const runtime = new browser.WorkoutRuntime([block('run', 10)], { now: () => 0 });
  runtime.start(0); assert.equal(runtime.summary(10000).runSeconds, 10);
});

console.log(`PASS: ${cases} durable workout runtime scenarios.`);
