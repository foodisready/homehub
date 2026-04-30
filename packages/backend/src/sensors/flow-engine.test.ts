import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateFlowReading,
  resolveFlowConfig,
  DEFAULT_FLOW_CONFIG,
  type ActiveFlowEvent,
  type FlowConfig,
  type FlowReading,
  type SensorEngineState,
} from './flow-engine';

const baseConfig: FlowConfig = { ...DEFAULT_FLOW_CONFIG };
const idleState: SensorEngineState = { pendingState: 'idle', pendingCount: 0, snoozedUntil: null };

function reading(rate: number, opts: Partial<FlowReading> = {}): FlowReading {
  return {
    rate,
    totalM3:       opts.totalM3       ?? null,
    signalQuality: opts.signalQuality ?? 80,
    recordedAt:    opts.recordedAt    ?? new Date('2026-04-30T12:00:00Z'),
  };
}

function activeEvent(opts: Partial<ActiveFlowEvent> = {}): ActiveFlowEvent {
  return {
    id:           opts.id ?? 1,
    startTime:    opts.startTime ?? new Date('2026-04-30T12:00:00Z'),
    peakRate:     opts.peakRate ?? 0.5,
    alertLevel:   opts.alertLevel ?? 0,
    totalM3Start: opts.totalM3Start ?? null,
  };
}

describe('evaluateFlowReading — opening events', () => {
  it('first flowing reading does not open (debounce=2)', () => {
    const d = evaluateFlowReading({
      config: baseConfig, state: idleState, activeEvent: null,
      reading: reading(0.1),
    });
    assert.equal(d.openEvent, undefined);
    assert.deepEqual(d.pendingStateUpdate, { state: 'flowing', count: 1 });
    assert.equal(d.shouldNotify, false);
  });

  it('second consecutive flowing reading opens an event at level 0', () => {
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  { ...idleState, pendingState: 'flowing', pendingCount: 1 },
      activeEvent: null,
      reading: reading(0.1),
    });
    assert.ok(d.openEvent);
    assert.equal(d.openEvent!.alertLevel, 0);
    assert.equal(d.shouldNotify, false);
    assert.deepEqual(d.pendingStateUpdate, { state: 'flowing', count: 0 });
  });

  it('burst-rate reading opens immediately at level 1', () => {
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  { ...idleState, pendingState: 'flowing', pendingCount: 1 },
      activeEvent: null,
      reading: reading(2.0),  // > burstRateM3h (1.5)
    });
    assert.ok(d.openEvent);
    assert.equal(d.openEvent!.alertLevel, 1);
    assert.equal(d.shouldNotify, true);
  });

  it('vacation mode opens at level 3 immediately', () => {
    const cfg = { ...baseConfig, vacationMode: true };
    const d = evaluateFlowReading({
      config: cfg,
      state:  { ...idleState, pendingState: 'flowing', pendingCount: 1 },
      activeEvent: null,
      reading: reading(0.05),
    });
    assert.ok(d.openEvent);
    assert.equal(d.openEvent!.alertLevel, 3);
    assert.equal(d.shouldNotify, true);
  });

  it('quiet-hours flow opens at level 3', () => {
    const cfg: FlowConfig = {
      ...baseConfig,
      quietHours: { from: '01:00', to: '05:00', thresholdM3h: 0.003 },
    };
    const at = new Date('2026-04-30T03:30:00');  // local 03:30
    const d = evaluateFlowReading({
      config: cfg,
      state:  { ...idleState, pendingState: 'flowing', pendingCount: 1 },
      activeEvent: null,
      reading: reading(0.05, { recordedAt: at }),
    });
    assert.ok(d.openEvent);
    assert.equal(d.openEvent!.alertLevel, 3);
  });
});

describe('evaluateFlowReading — escalation within an active event', () => {
  it('5+ minute duration escalates to L1', () => {
    const start = new Date('2026-04-30T12:00:00Z');
    const at    = new Date('2026-04-30T12:06:00Z');  // +6 min
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  { ...idleState, pendingState: 'flowing', pendingCount: 0 },
      activeEvent: activeEvent({ startTime: start, alertLevel: 0 }),
      reading: reading(0.2, { recordedAt: at }),
    });
    assert.equal(d.updateEvent?.alertLevel, 1);
    assert.equal(d.updateEvent?.levelChanged, true);
    assert.equal(d.shouldNotify, true);
  });

  it('30+ minute duration escalates to L2', () => {
    const start = new Date('2026-04-30T12:00:00Z');
    const at    = new Date('2026-04-30T12:31:00Z');
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  idleState,
      activeEvent: activeEvent({ startTime: start, alertLevel: 1 }),
      reading: reading(0.2, { recordedAt: at }),
    });
    assert.equal(d.updateEvent?.alertLevel, 2);
    assert.equal(d.shouldNotify, true);
  });

  it('60+ minute duration escalates to L3', () => {
    const start = new Date('2026-04-30T12:00:00Z');
    const at    = new Date('2026-04-30T13:01:00Z');
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  idleState,
      activeEvent: activeEvent({ startTime: start, alertLevel: 2 }),
      reading: reading(0.2, { recordedAt: at }),
    });
    assert.equal(d.updateEvent?.alertLevel, 3);
    assert.equal(d.shouldNotify, true);
  });

  it('alert level is monotonic — never downgrades', () => {
    const start = new Date('2026-04-30T12:00:00Z');
    const at    = new Date('2026-04-30T12:10:00Z');
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  idleState,
      activeEvent: activeEvent({ startTime: start, alertLevel: 3 }),
      reading: reading(0.05, { recordedAt: at }),  // low rate, brief duration
    });
    assert.equal(d.updateEvent?.alertLevel, 3);
    assert.equal(d.updateEvent?.levelChanged, false);
    assert.equal(d.shouldNotify, false);
  });

  it('peak rate updates to the highest seen rate', () => {
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  idleState,
      activeEvent: activeEvent({ peakRate: 0.5 }),
      reading: reading(2.5),
    });
    assert.equal(d.updateEvent?.peakRate, 2.5);
  });

  it('does not include peak update below previous peak', () => {
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  idleState,
      activeEvent: activeEvent({ peakRate: 1.0 }),
      reading: reading(0.5),
    });
    assert.equal(d.updateEvent?.peakRate, 1.0);
  });
});

describe('evaluateFlowReading — closing events', () => {
  it('one idle reading mid-event does not close (closeDebounce=3)', () => {
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  { pendingState: 'flowing', pendingCount: 0, snoozedUntil: null },
      activeEvent: activeEvent(),
      reading: reading(0.0),
    });
    assert.equal(d.closeEvent, undefined);
    assert.deepEqual(d.pendingStateUpdate, { state: 'idle', count: 1 });
  });

  it('three consecutive idle readings close the event', () => {
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  { pendingState: 'idle', pendingCount: 2, snoozedUntil: null },
      activeEvent: activeEvent(),
      reading: reading(0.0),
    });
    assert.ok(d.closeEvent);
    assert.deepEqual(d.pendingStateUpdate, { state: 'idle', count: 0 });
  });

  it('flowing reading mid-close-debounce resets the close counter', () => {
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  { pendingState: 'idle', pendingCount: 2, snoozedUntil: null },
      activeEvent: activeEvent(),
      reading: reading(0.5),
    });
    assert.equal(d.closeEvent, undefined);
    assert.ok(d.updateEvent);
    assert.deepEqual(d.pendingStateUpdate, { state: 'flowing', count: 0 });
  });
});

describe('evaluateFlowReading — signal quality gate', () => {
  it('rejects readings below minSignalQuality', () => {
    const d = evaluateFlowReading({
      config: baseConfig, state: idleState, activeEvent: null,
      reading: reading(2.0, { signalQuality: 30 }),
    });
    assert.equal(d.rejectedSignal, true);
    assert.equal(d.openEvent, undefined);
    assert.equal(d.pendingStateUpdate, undefined);
  });

  it('null signal quality is treated as acceptable (legacy/diagnostic)', () => {
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  { ...idleState, pendingState: 'flowing', pendingCount: 1 },
      activeEvent: null,
      reading: reading(0.1, { signalQuality: null }),
    });
    assert.ok(d.openEvent);
  });
});

describe('evaluateFlowReading — restart safety', () => {
  it('restart mid-event with persisted pending=flowing,0 keeps escalating normally', () => {
    const start = new Date('2026-04-30T12:00:00Z');
    const at    = new Date('2026-04-30T12:31:00Z');
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  { pendingState: 'flowing', pendingCount: 0, snoozedUntil: null },
      activeEvent: activeEvent({ startTime: start, alertLevel: 1 }),
      reading: reading(0.2, { recordedAt: at }),
    });
    assert.equal(d.updateEvent?.alertLevel, 2);
  });

  it('restart mid-open-debounce resumes from persisted pendingCount', () => {
    const d = evaluateFlowReading({
      config: baseConfig,
      state:  { pendingState: 'flowing', pendingCount: 1, snoozedUntil: null },
      activeEvent: null,
      reading: reading(0.1),
    });
    assert.ok(d.openEvent);
  });
});

describe('resolveFlowConfig', () => {
  it('returns defaults when stored is null', () => {
    assert.deepEqual(resolveFlowConfig(null), DEFAULT_FLOW_CONFIG);
  });

  it('overrides defaults with stored values', () => {
    const merged = resolveFlowConfig({ warnAfterMin: 10, vacationMode: true });
    assert.equal(merged.warnAfterMin, 10);
    assert.equal(merged.vacationMode, true);
    assert.equal(merged.criticalAfterMin, DEFAULT_FLOW_CONFIG.criticalAfterMin);
  });
});
