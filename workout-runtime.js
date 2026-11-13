/* Authoritative workout clock and visit ledger. Storage and UI are deliberately external. */
(function (root, factory) {
  const WorkoutRuntime = factory();
  if (typeof module === 'object' && module.exports) module.exports = { WorkoutRuntime };
  if (root) root.WorkoutRuntime = WorkoutRuntime;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const TYPES = new Set(['warm', 'run', 'walk', 'cool']);
  const copy = value => JSON.parse(JSON.stringify(value));
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const isRun = type => type === 'run';
  const time = value => {
    if (!Number.isFinite(Number(value))) throw new TypeError('Workout time must be a finite timestamp.');
    return Number(value);
  };

  function normalizeBlock(block) {
    const type = block.prescribedType || block.type;
    if (!TYPES.has(type)) throw new TypeError('Unknown workout phase.');
    const seconds = number(block.prescribedSeconds ?? block.seconds, NaN);
    if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError('Invalid prescribed duration.');
    const extraSeconds = Math.max(-seconds, number(block.extraSeconds));
    return {
      ...copy(block), type, prescribedType: type, seconds,
      prescribedSeconds: seconds, extraSeconds,
      speed: block.speed != null && Number.isFinite(Number(block.speed)) && Number(block.speed) >= 0
        ? Number(block.speed) : null
    };
  }

  class WorkoutRuntime {
    constructor(blocks, options = {}) {
      if (!Array.isArray(blocks) || !blocks.length) throw new TypeError('A workout needs at least one block.');
      this._now = typeof options.now === 'function' ? options.now : Date.now;
      this._blocks = blocks.map(normalizeBlock);
      this._index = 0;
      this._running = false;
      this._finished = false;
      this._started = false;
      this._cursorAt = null;
      this._blockElapsedMs = 0;
      this._elapsedMs = 0;
      this._type = this._blocks[0].type;
      this._visits = [];
      this._visitId = 0;
      this._continuityId = 0;
      this._activeVisit = null;
      this._activeSegment = null;
      this._speeds = {};
    }

    static restore(snapshot, options = {}) {
      if (!snapshot || snapshot.version !== VERSION) throw new TypeError('Unsupported workout snapshot.');
      const runtime = new WorkoutRuntime(snapshot.blocks, options);
      const index = Number(snapshot.index);
      if (!Number.isInteger(index) || index < 0 || index >= runtime._blocks.length) throw new TypeError('Invalid workout index.');
      runtime._index = index;
      runtime._running = Boolean(snapshot.running);
      runtime._finished = Boolean(snapshot.finished);
      runtime._started = Boolean(snapshot.started);
      runtime._cursorAt = snapshot.cursorAt == null ? null : time(snapshot.cursorAt);
      runtime._blockElapsedMs = Math.max(0, number(snapshot.blockElapsedMs));
      runtime._elapsedMs = Math.max(0, number(snapshot.elapsedMs));
      runtime._type = TYPES.has(snapshot.currentType) ? snapshot.currentType : runtime._blocks[index].type;
      runtime._visits = copy(snapshot.visits || []);
      runtime._visitId = Math.max(0, number(snapshot.visitId));
      runtime._continuityId = Math.max(0, number(snapshot.continuityId));
      runtime._speeds = copy(snapshot.speeds || {});
      const activeVisitIndex = snapshot.activeVisitIndex;
      const activeSegmentIndex = snapshot.activeSegmentIndex;
      runtime._activeVisit = Number.isInteger(activeVisitIndex) ? runtime._visits[activeVisitIndex] : null;
      runtime._activeSegment = runtime._activeVisit && Number.isInteger(activeSegmentIndex)
        ? runtime._activeVisit.segments[activeSegmentIndex] : null;
      if (runtime._finished) runtime._running = false;
      if (runtime._running && (runtime._cursorAt == null || !runtime._activeVisit)) throw new TypeError('Incomplete running workout snapshot.');
      if (options.catchUp !== false) runtime.update(options.at ?? runtime._now());
      return runtime;
    }

    get blocks() { return this._blocks.map(copy); }

    _budgetMs(index = this._index) {
      const block = this._blocks[index];
      return Math.max(0, (block.prescribedSeconds + block.extraSeconds) * 1000);
    }

    _speed(type) {
      if (Object.prototype.hasOwnProperty.call(this._speeds, type)) return this._speeds[type];
      const original = this._blocks[this._index];
      if (type === original.type) return original.speed;
      const matching = this._blocks.find(block => block.type === type && block.speed != null);
      const walking = this._blocks.find(block => !isRun(block.type) && block.speed != null);
      return matching?.speed ?? walking?.speed ?? null;
    }

    _newVisit(at) {
      const visit = {
        id: ++this._visitId, blockIndex: this._index, prescribedType: this._blocks[this._index].type,
        startedAt: at, endedAt: null, convertedToWalk: false, segments: []
      };
      this._visits.push(visit);
      this._activeVisit = visit;
      this._activeSegment = null;
      return visit;
    }

    _newSegment(at, { preserveContinuity = false } = {}) {
      if (!this._activeVisit) this._newVisit(at);
      if (!preserveContinuity) this._continuityId += 1;
      const segment = {
        type: this._type, startAt: at, endAt: at, durationMs: 0,
        speedKmh: this._speed(this._type), continuityId: this._continuityId,
        closed: false
      };
      this._activeVisit.segments.push(segment);
      this._activeSegment = segment;
      return segment;
    }

    _closeSegment() {
      if (this._activeSegment) this._activeSegment.closed = true;
      this._activeSegment = null;
    }

    _closeVisit(at) {
      this._closeSegment();
      if (this._activeVisit) this._activeVisit.endedAt = at;
      this._activeVisit = null;
    }

    _advanceTo(at) {
      at = time(at);
      const transitions = [];
      if (!this._running) return transitions;
      // Clock rollback must not double-count time already recorded.
      if (at < this._cursorAt) return transitions;
      while (this._running) {
        const remainingMs = Math.max(0, this._budgetMs() - this._blockElapsedMs);
        const availableMs = Math.max(0, at - this._cursorAt);
        const consumedMs = Math.min(remainingMs, availableMs);
        if (consumedMs > 0) {
          if (!this._activeSegment) this._newSegment(this._cursorAt);
          this._activeSegment.endAt = this._cursorAt + consumedMs;
          this._activeSegment.durationMs += consumedMs;
          this._blockElapsedMs += consumedMs;
          this._elapsedMs += consumedMs;
          this._cursorAt += consumedMs;
        }
        if (this._blockElapsedMs + 0.000001 < this._budgetMs()) break;
        const from = this._index;
        const previousType = this._type;
        const boundary = this._cursorAt;
        this._closeVisit(boundary);
        if (this._index === this._blocks.length - 1) {
          this._finished = true;
          this._running = false;
          transitions.push({ from, to: null, at: boundary, finished: true });
          break;
        }
        this._index += 1;
        this._blockElapsedMs = 0;
        this._type = this._blocks[this._index].type;
        this._newVisit(boundary);
        this._newSegment(boundary, { preserveContinuity: isRun(previousType) && isRun(this._type) });
        transitions.push({ from, to: this._index, at: boundary, finished: false });
        if (this._cursorAt >= at && this._budgetMs() > 0) break;
      }
      return transitions;
    }

    _state(transitions = []) {
      return {
        index: this._index, currentBlockIndex: this._index,
        running: this._running, finished: this._finished, started: this._started,
        type: this._type, currentType: this._type,
        remainingMs: Math.max(0, this._budgetMs() - this._blockElapsedMs),
        blockElapsedMs: this._blockElapsedMs, elapsedMs: this._elapsedMs,
        budgetMs: this._budgetMs(), transitions
      };
    }

    update(at = this._now()) { return this._state(this._advanceTo(at)); }
    sync(at = this._now()) { return this.update(at); }
    state(at = this._now()) { return this.update(at); }

    resume(at = this._now()) {
      at = time(at);
      if (this._running) return this.update(at);
      if (this._finished) return this._state();
      if (this._cursorAt != null) at = Math.max(at, this._cursorAt);
      this._running = true;
      this._started = true;
      this._cursorAt = at;
      if (!this._activeVisit) this._newVisit(at);
      this._newSegment(at);
      return this.update(at);
    }

    start(at = this._now()) { return this.resume(at); }

    pause(at = this._now()) {
      const transitions = this._advanceTo(at);
      this._running = false;
      this._closeSegment();
      return this._state(transitions);
    }

    enterBlock(index, at = this._now()) {
      at = time(at);
      if (this._cursorAt != null) at = Math.max(at, this._cursorAt);
      if (!Number.isInteger(index) || index < 0 || index >= this._blocks.length) throw new RangeError('Workout block is outside the prescription.');
      const transitions = this._advanceTo(at);
      const from = this._index;
      const wasRunning = this._running;
      this._closeVisit(at);
      this._index = index;
      this._type = this._blocks[index].type;
      this._blockElapsedMs = 0;
      this._finished = false;
      this._cursorAt = at;
      if (this._started) this._newVisit(at);
      if (wasRunning) this._newSegment(at);
      transitions.push({ from, to: index, at, manual: true, finished: false });
      return this._state(transitions);
    }

    goToBlock(index, at = this._now()) { return this.enterBlock(index, at); }

    convertToWalk(at = this._now()) {
      at = time(at);
      if (this._cursorAt != null) at = Math.max(at, this._cursorAt);
      const transitions = this._advanceTo(at);
      if (this._type !== 'run' || this._finished) return this._state(transitions);
      this._closeSegment();
      this._type = 'walk';
      if (!this._activeVisit && this._started) this._newVisit(at);
      if (this._activeVisit) this._activeVisit.convertedToWalk = true;
      if (this._running) this._newSegment(at);
      return this._state(transitions);
    }

    setBlockExtra(index, extraSeconds, at = this._now()) {
      const transitions = this._advanceTo(at);
      if (!Number.isInteger(index) || !this._blocks[index]) throw new RangeError('Workout block is outside the prescription.');
      const block = this._blocks[index];
      block.extraSeconds = Math.max(-block.prescribedSeconds, number(extraSeconds));
      const moreTransitions = this._advanceTo(at);
      return this._state([...transitions, ...moreTransitions]);
    }

    adjustBudget(deltaSeconds, at = this._now()) {
      const transitions = this._advanceTo(at);
      const result = this.setBlockExtra(this._index, this._blocks[this._index].extraSeconds + number(deltaSeconds), at);
      result.transitions = [...transitions, ...result.transitions];
      return result;
    }

    setSpeeds(speeds, at = this._now()) {
      at = time(at);
      const transitions = this._advanceTo(at);
      const oldSpeed = this._speed(this._type);
      const nextSpeeds = { ...this._speeds };
      for (const type of TYPES) {
        if (Object.prototype.hasOwnProperty.call(speeds || {}, type)) {
          const speed = Number(speeds[type]);
          if (!Number.isFinite(speed) || speed < 0) throw new TypeError('Workout speed must be non-negative.');
          nextSpeeds[type] = speed;
        }
      }
      this._speeds = nextSpeeds;
      if (this._running && this._speed(this._type) !== oldSpeed) {
        this._closeSegment();
        this._newSegment(at, { preserveContinuity: true });
      }
      return this._state(transitions);
    }

    summary(at = this._now()) {
      this._advanceTo(at);
      const rows = this._blocks.map((block, blockIndex) => ({
        blockIndex, type: block.type, prescribedType: block.type,
        prescribedSeconds: block.prescribedSeconds, extraSeconds: block.extraSeconds,
        actualSeconds: 0, runSeconds: 0, walkSeconds: 0, fulfilledSeconds: 0, longestRunSeconds: 0,
        convertedToWalk: false, hadWalkConversion: false, completed: false
      }));
      const uninterrupted = new Map();
      const withinBlockContinuous = new Map();
      let distanceKm = 0;
      let distanceComplete = true;
      for (const visit of this._visits) {
        const row = rows[visit.blockIndex];
        row.hadWalkConversion ||= Boolean(visit.convertedToWalk);
        for (const segment of visit.segments) {
          const seconds = segment.durationMs / 1000;
          row.actualSeconds += seconds;
          if (isRun(segment.type)) {
            row.runSeconds += seconds;
            uninterrupted.set(segment.continuityId, (uninterrupted.get(segment.continuityId) || 0) + seconds);
            const continuousKey = `${visit.blockIndex}:${segment.continuityId}`;
            const blockRunSeconds = (withinBlockContinuous.get(continuousKey) || 0) + seconds;
            withinBlockContinuous.set(continuousKey, blockRunSeconds);
            row.longestRunSeconds = Math.max(row.longestRunSeconds, blockRunSeconds);
          } else row.walkSeconds += seconds;
          if (isRun(row.type) === isRun(segment.type)) row.fulfilledSeconds += seconds;
          if (segment.speedKmh == null && seconds > 0) distanceComplete = false;
          else distanceKm += seconds * (segment.speedKmh || 0) / 3600;
        }
      }
      for (const row of rows) {
        row.completed = row.fulfilledSeconds + 0.000001 >= row.prescribedSeconds;
        // A conversion after the original prescription was fulfilled does not undo completion.
        row.convertedToWalk = row.type === 'run' && row.hadWalkConversion && !row.completed;
      }
      return {
        blocks: rows, runSeconds: rows.reduce((sum, row) => sum + row.runSeconds, 0),
        walkSeconds: rows.reduce((sum, row) => sum + row.walkSeconds, 0),
        maxRunBlockSec: Math.max(0, ...uninterrupted.values()),
        completedBlocks: rows.filter(row => row.completed).length,
        prescriptionCompleted: rows.every(row => row.completed),
        elapsedMs: this._elapsedMs, elapsedSeconds: this._elapsedMs / 1000,
        distanceKm, distanceEstimated: true, distanceComplete,
        ledger: copy(this._visits)
      };
    }

    snapshot(at = this._now()) {
      this._advanceTo(at);
      return {
        version: VERSION, blocks: this.blocks, index: this._index,
        running: this._running, finished: this._finished, started: this._started,
        cursorAt: this._cursorAt, blockElapsedMs: this._blockElapsedMs, elapsedMs: this._elapsedMs,
        currentType: this._type, visits: copy(this._visits), visitId: this._visitId,
        continuityId: this._continuityId, speeds: copy(this._speeds),
        activeVisitIndex: this._activeVisit ? this._visits.indexOf(this._activeVisit) : null,
        activeSegmentIndex: this._activeVisit && this._activeSegment ? this._activeVisit.segments.indexOf(this._activeSegment) : null
      };
    }
  }

  return WorkoutRuntime;
});
