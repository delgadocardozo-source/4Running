const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cache = {};
const localStorage = { getItem: key => cache[key] || null, setItem: (key, value) => { cache[key] = String(value); }, removeItem: key => { delete cache[key]; } };
const context = { window: {}, localStorage, structuredClone, console, Date, Math, JSON };
vm.createContext(context);
for (const file of ['adaptive-engine.js', 'coach-engine.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
const A = context.window.PaceAdaptive, C = context.window.PaceCoach;
const settings = { walkSpeed: 5, runSpeed: 7.5, coolSpeed: 4.5 };
const start = '2026-11-12';
A.setClock(() => new Date(start + 'T10:00:00'));
const intake = { continuousAbility: '1min', assessment: 'later', availableMinutes: 30, sessionsPerWeek: 3 };
const makePlan = patch => A.buildPlanFromIntake({ ...intake, ...patch }, settings);
const log = patch => ({ id: 'latest', date: start, createdAt: start + 'T10:00:00Z', type: 'Exterior', source: 'manual', rpe: 4, pain: false, execution: 'completed', prescriptionCompleted: true, maxRunBlockSec: 60, elapsedSec: 1200, ...patch });
const plain = value => JSON.parse(JSON.stringify(value));

// One deterioration/confidence implementation serves both decision and displayed trend.
{
  const p = makePlan();
  const logs = [log({ id: 'old', date: '2026-11-08', rpe: 6, maxRunBlockSec: 180 }), log({ id: 'middle', date: '2026-11-10', rpe: 6, maxRunBlockSec: 100 }), log({ id: 'new', rpe: 6, maxRunBlockSec: 60 })];
  assert.equal(A.trendFavorable(logs, p).ok, false);
  assert.equal(C.recentTrendFavorable(logs, p).ok, false);
  assert.match(A.trendFavorable(logs, p).reason, /Deterioro/);
  assert.equal(A.decideAdaptive(logs[2], logs.slice(0, 2), p).progression, 'repeat');
  const missingBlocks = log({ source: 'timer' });
  assert.equal(A.deriveProfile([missingBlocks], p).confidence, 'baja');
  assert.equal(A.decideAdaptive(missingBlocks, [], p).progression, 'repeat');
  const observed = log({ source: 'timer', elapsedSec: 60, blocks: [{ type: 'run', actualSeconds: 60, prescribedSeconds: 60, runSeconds: 60 }] });
  assert.equal(A.decideAdaptive(observed, [], p).progression, 'advance', 'a first coherent observed attempt can progress');
  assert.equal(A.deriveProfile([observed], p).confidence, 'media');
}
// A long pause cannot be bypassed by the effort-six branch.
{
  const p = makePlan();
  const prior = [log({ id: 'p1', date: '2026-10-20', rpe: 5 }), log({ id: 'p2', date: '2026-10-18', rpe: 5 })];
  for (const rpe of [4, 6]) {
    const result = A.decideAdaptive(log({ rpe }), prior, p);
    assert.equal(result.progression, 'repeat'); assert.ok(result.reasonCode.includes('PAUSE_REASSESS'));
  }
  assert.equal(A.decideAdaptive(log({ rpe: 6, worseningDuringRun: true }), prior, p).progression, 'recovery');
}
// Coherence/range checks prevent invented capacity from becoming progression evidence.
{
  const p = makePlan();
  for (const maxRunBlockSec of [-1, 15000, NaN, Infinity, 1300]) assert.equal(A.decideAdaptive(log({ maxRunBlockSec }), [], p).progression, 'repeat');
  const inconsistent = log({ source: 'timer', maxRunBlockSec: 60, elapsedSec: 60, blocks: [{ type: 'run', actualSeconds: 60, prescribedSeconds: 60, runSeconds: 30 }] });
  assert.equal(A.evidenceForLog(inconsistent).sufficient, false);
  assert.equal(A.decideAdaptive(inconsistent, [], p).progression, 'repeat');
}
// Completing accumulated dose across visits does not demonstrate the prescribed continuous block.
{
  const p = makePlan();
  const accumulated = log({ source: 'timer', elapsedSec: 70, maxRunBlockSec: 40, blocks: [{ type: 'run', actualSeconds: 70, prescribedSeconds: 60, runSeconds: 70, longestRunSeconds: 40 }] });
  assert.equal(A.observedCompletion(accumulated), true, 'dose completion and continuous tolerance are distinct');
  assert.equal(A.evidenceForLog(accumulated).sufficient, true, 'measured accumulated record remains valid evidence');
  for (const rpe of [4, 6]) {
    const decision = A.decideAdaptive({ ...accumulated, rpe }, [], p);
    assert.equal(decision.progression, 'repeat');
    assert.ok(decision.reasonCode.includes('CONTINUOUS_NOT_CONFIRMED'));
    assert.match(decision.reason, /tiempo acumulado.*sin interrupción/);
  }
  const continuous = { ...accumulated, maxRunBlockSec: 60, blocks: [{ type: 'run', actualSeconds: 70, prescribedSeconds: 60, runSeconds: 70, longestRunSeconds: 60 }] };
  assert.equal(A.decideAdaptive(continuous, [], p).progression, 'advance', 'extra accumulated time does not block a fully observed prescribed continuous segment');
}
// Actual timestamps, not random UUID lexical order, choose same-day attempts.
{
  const logs = [log({ id: 'z-old', createdAt: start + 'T08:00:00Z' }), log({ id: '0-new', createdAt: start + 'T12:00:00Z' }), log({ id: 'm-middle', createdAt: start + 'T10:00:00Z' })];
  assert.deepEqual(plain(A.validTrainingLogs(logs).map(x => x.id)), ['0-new', 'm-middle', 'z-old']);
  assert.deepEqual(plain(C.validTrainingAttempts(logs).map(x => x.id)), ['0-new', 'm-middle', 'z-old']);
}
// Fixed weekly cadence delivers exactly the chosen count and respects recovery days.
for (const frequency of [2, 3]) {
  const p = makePlan({ sessionsPerWeek: frequency });
  p.sessions = [];
  for (let i = 0; i < 16; i++) p.sessions.push(A.makeRunItem(p, A.initialPrescription(p.intake)));
  A.allocateScheduleDates(p, p.params);
  const dates = p.sessions.map(s => s.scheduledDate);
  for (let day = 0; day < 21; day++) {
    const from = A.addDaysISO(start, day), to = A.addDaysISO(from, 7);
    assert.equal(dates.filter(date => date >= from && date < to).length, frequency, `${frequency} per seven days starting ${from}`);
  }
  for (let i = 1; i < dates.length; i++) assert.ok((new Date(dates[i]) - new Date(dates[i - 1])) / 86400000 >= 2);
  A.allocateScheduleDates(p, p.params);
  assert.deepEqual(plain(p.sessions.map(s => s.scheduledDate)), plain(dates), 'calendar reopening is stable');
}
{
  const unresolved = makePlan({ sessionsPerWeek: 4 });
  assert.equal(unresolved.requestedSessionsPerWeek, 4);
  assert.equal(unresolved.effectiveSessionsPerWeek, 3);
  assert.equal(unresolved.scheduleRequiresConfirmation, true);
  assert.match(unresolved.scheduleNotice, /4.*3/);
  const accepted = makePlan({ requestedSessionsPerWeek: 4, sessionsPerWeek: 3, frequencyConfirmed: true });
  assert.equal(accepted.scheduleRequiresConfirmation, false);
  assert.equal(accepted.requestedSessionsPerWeek, 4);
}
// Restoring and manual load adjustment retain assessment choice, budget, and safety gate.
{
  const p = makePlan({ continuousAbility: 'none', assessment: 'later', availableMinutes: 15 });
  const restored = A.restoreFocusSession(p, [], settings);
  const run = C.getFocusSession(restored.plan);
  assert.equal(run.structure.runSeconds, 0);
  assert.ok(A.metrics(run.structure).totalSec <= 900);
  const adjusted = A.recalibrateLoad(p, [], settings, 'harder');
  assert.equal(C.getFocusSession(adjusted.plan).structure.runSeconds, 0, 'walking is not converted to jogging via generic adjustment');
  p.sessions[0].blockedUntilRest = true;
  assert.equal(A.restoreFocusSession(p, [], settings).changed, false);
  assert.equal(A.recalibrateLoad(p, [], settings, 'harder').changed, false);
  C.rescheduleFocus(p, '2026-11-20');
  assert.ok(C.getFocusSession(p).gateForId);
}
// Restore keeps earned running capability when supported, while still limiting total time.
{
  const p = makePlan();
  p.sessions[0].status = 'completed';
  p.sessions[0].structure = A.structureFromClassic({ warmSeconds: 300, coolSeconds: 300, runSeconds: 900, walkSeconds: 0, reps: 1 });
  const earned = log({ id: 'earned', planSessionId: p.sessions[0].id, maxRunBlockSec: 900, elapsedSec: 1500 });
  const pending = p.sessions.find(s => s.kind === 'run' && s.status === 'pending');
  pending.structure = A.structureFromClassic({ warmSeconds: 300, coolSeconds: 300, runSeconds: 30, walkSeconds: 90, reps: 4 });
  const restored = A.restoreFocusSession(p, [earned], settings);
  assert.ok(restored.plan.sessions.find(s => s.id === pending.id).structure.runSeconds >= 900);
  assert.ok(A.metrics(restored.plan.sessions.find(s => s.id === pending.id).structure).totalSec <= 1800);
}
// Corrections audit the old decision and revise only prescriptions without attempts.
{
  const p = makePlan();
  const initial = p.sessions[0];
  const originalStructure = plain(initial.structure);
  const done = log({ id: 'completed', planSessionId: initial.id, prescriptionSnapshot: originalStructure });
  const logs = [done];
  C.confirmNextSession(p, done, logs);
  C.savePlan(p); C.saveLogs(logs);
  const oldDecision = { action: done.action, progression: done.progression, reason: done.decisionReason };
  const edited = C.updateStoredLog(logs, done.id, { rpe: 9 }, { plan: p, settings });
  assert.equal(edited.ok, true);
  assert.equal(edited.updated.rpe, 9);
  assert.equal(edited.updated.action, oldDecision.action);
  assert.equal(edited.updated.progression, oldDecision.progression);
  assert.equal(edited.updated.decisionReason, oldDecision.reason);
  assert.equal(edited.updated.originalDecision.action, oldDecision.action);
  assert.equal(edited.updated.editHistory.length, 1);
  assert.deepEqual(plain(edited.plan.sessions.find(s => s.id === initial.id).structure), originalStructure);
  assert.equal(edited.plan.sessions.find(s => s.id === initial.id).status, 'completed');
  assert.equal(edited.review.action, 'repeat');
  const future = edited.plan.sessions.find(s => s.kind === 'run' && ['pending', 'rescheduled'].includes(s.status));
  assert.deepEqual(plain(future.structure), originalStructure);
  assert.equal(C.updateStoredLog(edited.logs, done.id, { maxRunBlockSec: -1 }, { plan: edited.plan, settings }).ok, false);
  const warning = C.updateStoredLog(edited.logs, done.id, { worseningDuringRun: true }, { plan: edited.plan, settings });
  assert.equal(warning.review.action, 'recovery'); assert.ok(C.getFocusSession(warning.plan).kind === 'rest');
}
// Replacing a previously attempted pending prescription terminates and preserves the old attempt.
{
  const p = makePlan();
  const done = log({ id: 'repeat-edited', planSessionId: p.sessions[0].id, rpe: 9, prescriptionSnapshot: { structure: plain(p.sessions[0].structure) } });
  C.confirmNextSession(p, done, [done]);
  const oldId = p.sessions[0].id;
  const corrected = C.updateStoredLog([done], done.id, { rpe: 4 }, { plan: p, settings });
  assert.equal(corrected.plan.sessions.find(s => s.id === oldId).status, 'archived');
  assert.equal(corrected.plan.sessions.find(s => s.id === oldId).attempts.length, 1);
  assert.ok(corrected.plan.sessions.length < 12, 'forward review terminates rather than recursively replacing new sessions');
  assert.ok(C.getFocusSession(corrected.plan));
}
// Completed walks offer an explicit, budgeted transition instead of changing capacity silently.
{
  const p = makePlan({ continuousAbility: 'unknown', assessment: 'later', availableMinutes: 15 });
  const walk = log({ id: 'walk', planSessionId: p.sessions[0].id, source: 'timer', elapsedSec: 900, maxRunBlockSec: 0, runSeconds: 0, walkSeconds: 900, rpe: 3, talkTest: 'yes', blocks: [ { type: 'warm', prescribedSeconds: 300, actualSeconds: 300, runSeconds: 0 }, { type: 'walk', prescribedSeconds: 300, actualSeconds: 300, runSeconds: 0 }, { type: 'cool', prescribedSeconds: 300, actualSeconds: 300, runSeconds: 0 } ] });
  C.confirmNextSession(p, walk, [walk]);
  const before = JSON.stringify(p);
  const offered = C.requestWalkToJog(p, [walk], settings, { confirmed: false });
  assert.equal(offered.eligible, true); assert.equal(offered.changed, false); assert.equal(JSON.stringify(p), before);
  const chosen = C.requestWalkToJog(p, [walk], settings, { confirmed: true });
  assert.equal(chosen.changed, true);
  assert.ok(chosen.plan.sessions.some(s => s.id === walk.planSessionId && s.status === 'archived' && s.attempts.length === 1));
  assert.equal(C.getFocusSession(chosen.plan).structure.runSeconds, 30);
  assert.ok(A.metrics(C.getFocusSession(chosen.plan).structure).totalSec <= 900);
  assert.equal(C.requestWalkToJog(p, [{ ...walk, talkTest: 'no' }], settings, { confirmed: true }).eligible, false);
  p.sessions[0].blockedUntilRest = true;
  assert.equal(C.requestWalkToJog(p, [walk], settings, { confirmed: true }).eligible, false);
}
// An obsolete active snapshot must never advance the newly selected focus.
{
  const p = makePlan();
  const before = JSON.stringify(p);
  const restoredAttempt = log({ id: 'obsolete', planSessionId: 'deleted-prescription', prescriptionSnapshot: { runSeconds: 30 } });
  const result = C.confirmNextSession(p, restoredAttempt, [restoredAttempt]);
  assert.equal(result.action, 'record_only'); assert.equal(result.advanced, false); assert.equal(JSON.stringify(p), before);
  assert.deepEqual(restoredAttempt.prescriptionSnapshot, { runSeconds: 30 });
}
// Concurrent independent saves merge the immediate local cache by session ID.
{
  localStorage.removeItem('pace01.logs.v3');
  C.saveLogs([log({ id: 'tab-a' })]); C.saveLogs([log({ id: 'tab-b' })]);
  assert.equal(C.loadLogs().length, 2);
}
console.log('PASS training regressions: shared trend/confidence, safe evidence, pause, chronology, weekly cadence, budgeted adjustments, audited corrections, opt-in walking transition, obsolete sessions and merged cache.');
