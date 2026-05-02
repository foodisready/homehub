/**
 * AuraFlow leak-detection state machine.
 *
 * `evaluateFlowReading()` is a pure function: given the current sensor state,
 * the open event (if any), and a new reading, it returns a `FlowDecision`
 * describing the DB effects to apply. The route layer applies them in a
 * transaction and emits notifications/socket events on level changes.
 *
 * Pure design lets us unit-test the state machine without a database.
 */

export type AlertLevel = 0 | 1 | 2 | 3;

export interface QuietHours {
  /** 'HH:MM' in the sensor's local time (server TZ for now). */
  from:           string;
  to:             string;
  thresholdM3h:   number;
}

export interface FlowConfig {
  flowingThresholdM3h:  number;
  warnAfterMin:         number;
  criticalAfterMin:     number;
  burstRateM3h:         number;
  level1AfterMin:       number;
  minSignalQuality:     number;
  vacationMode:         boolean;
  quietHours:           QuietHours | null;
  /** Number of consecutive samples before transitioning idle→flowing or flowing→idle. */
  openDebounce:         number;
  closeDebounce:        number;
}

export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  flowingThresholdM3h: 0.006,    // ≈ 0.1 L/min
  warnAfterMin:        30,
  criticalAfterMin:    60,
  burstRateM3h:        1.5,
  level1AfterMin:      5,
  minSignalQuality:    60,
  vacationMode:        false,
  quietHours:          null,
  openDebounce:        2,
  closeDebounce:       3,
};

export interface SensorEngineState {
  /** Persisted across restarts in `sensors.pending_state`. */
  pendingState:  'idle' | 'flowing';
  /** Persisted across restarts in `sensors.pending_count`. */
  pendingCount:  number;
  /** Optional snooze window — suppresses L1/L2 only (L3 always fires). */
  snoozedUntil:  Date | null;
}

export interface ActiveFlowEvent {
  id:           number;
  startTime:    Date;
  peakRate:     number;
  alertLevel:   AlertLevel;
  totalM3Start: number | null;
}

export interface FlowReading {
  rate:           number;
  totalM3:        number | null;
  signalQuality:  number | null;
  recordedAt:     Date;
}

/** Effects the route layer applies. All optional — none means "do nothing." */
export interface FlowDecision {
  pendingStateUpdate?: { state: 'idle' | 'flowing'; count: number };
  openEvent?:          { rate: number; totalM3: number | null; alertLevel: AlertLevel; startTime: Date };
  updateEvent?:        { eventId: number; peakRate: number; alertLevel: AlertLevel; levelChanged: boolean };
  closeEvent?:         { eventId: number; endTime: Date; totalM3End: number | null };
  /** Reading was below `minSignalQuality` and was excluded from the engine. */
  rejectedSignal?:     boolean;
  /** True if any of the effects represent a level transition we should notify about. */
  shouldNotify:        boolean;
}

export interface EvaluateInput {
  config:       FlowConfig;
  state:        SensorEngineState;
  activeEvent:  ActiveFlowEvent | null;
  reading:      FlowReading;
}

export function evaluateFlowReading(input: EvaluateInput): FlowDecision {
  const { config, state, activeEvent, reading } = input;

  // ── Signal-quality gate (fix B). Reading is still stored upstream, just
  //    excluded from the engine so noise doesn't open phantom events.
  if (reading.signalQuality !== null && reading.signalQuality < config.minSignalQuality) {
    return { rejectedSignal: true, shouldNotify: false };
  }

  const isFlowing = reading.rate > config.flowingThresholdM3h;
  const decision: FlowDecision = { shouldNotify: false };

  if (isFlowing) {
    if (!activeEvent) {
      // Need `openDebounce` consecutive flowing samples to open an event.
      const next = state.pendingState === 'flowing' ? state.pendingCount + 1 : 1;
      if (next < config.openDebounce) {
        decision.pendingStateUpdate = { state: 'flowing', count: next };
        return decision;
      }

      const initialLevel = computeLevelForNewEvent(reading, config);
      decision.openEvent = {
        rate:       reading.rate,
        totalM3:    reading.totalM3,
        alertLevel: initialLevel,
        startTime:  reading.recordedAt,
      };
      decision.pendingStateUpdate = { state: 'flowing', count: 0 };
      decision.shouldNotify = initialLevel > 0;
      return decision;
    }

    // Existing event: reset close-debounce, possibly escalate level.
    const peak = Math.max(activeEvent.peakRate, reading.rate);
    const nextLevel = computeNextLevel(activeEvent, reading, config);
    const levelChanged = nextLevel > activeEvent.alertLevel;

    decision.updateEvent = {
      eventId:      activeEvent.id,
      peakRate:     peak,
      alertLevel:   nextLevel,
      levelChanged,
    };
    if (state.pendingState !== 'flowing' || state.pendingCount !== 0) {
      decision.pendingStateUpdate = { state: 'flowing', count: 0 };
    }
    decision.shouldNotify = levelChanged;
    return decision;
  }

  // ── Not flowing
  if (!activeEvent) {
    if (state.pendingState !== 'idle' || state.pendingCount !== 0) {
      decision.pendingStateUpdate = { state: 'idle', count: 0 };
    }
    return decision;
  }

  // Active event present — need `closeDebounce` consecutive idle samples to close.
  const next = state.pendingState === 'idle' ? state.pendingCount + 1 : 1;
  if (next < config.closeDebounce) {
    decision.pendingStateUpdate = { state: 'idle', count: next };
    return decision;
  }

  decision.closeEvent = {
    eventId:    activeEvent.id,
    endTime:    reading.recordedAt,
    totalM3End: reading.totalM3,
  };
  decision.pendingStateUpdate = { state: 'idle', count: 0 };
  return decision;
}

function computeLevelForNewEvent(reading: FlowReading, config: FlowConfig): AlertLevel {
  if (config.vacationMode) return 3;
  if (isInQuietHours(reading.recordedAt, config.quietHours) &&
      reading.rate > (config.quietHours?.thresholdM3h ?? 0)) {
    return 3;
  }
  if (reading.rate >= config.burstRateM3h) return 1;
  return 0;
}

function computeNextLevel(
  event: ActiveFlowEvent,
  reading: FlowReading,
  config: FlowConfig,
): AlertLevel {
  // Vacation mode and quiet-hours flow are always L3.
  if (config.vacationMode) return Math.max(event.alertLevel, 3) as AlertLevel;
  if (isInQuietHours(reading.recordedAt, config.quietHours) &&
      reading.rate > (config.quietHours?.thresholdM3h ?? 0)) {
    return Math.max(event.alertLevel, 3) as AlertLevel;
  }

  const durationMin = (reading.recordedAt.getTime() - event.startTime.getTime()) / 60_000;
  let target: AlertLevel = event.alertLevel;

  if (reading.rate >= config.burstRateM3h && target < 1)             target = 1;
  if (durationMin >= config.level1AfterMin   && target < 1)          target = 1;
  if (durationMin >= config.warnAfterMin     && target < 2)          target = 2;
  if (durationMin >= config.criticalAfterMin && target < 3)          target = 3;

  // Monotonic — never downgrade until the event closes.
  return Math.max(target, event.alertLevel) as AlertLevel;
}

function isInQuietHours(at: Date, q: QuietHours | null): boolean {
  if (!q) return false;
  const minutesSinceMidnight = at.getHours() * 60 + at.getMinutes();
  const from = parseHHMM(q.from);
  const to   = parseHHMM(q.to);
  if (from <= to) {
    return minutesSinceMidnight >= from && minutesSinceMidnight < to;
  }
  // Wraps midnight (e.g. 22:00 → 06:00)
  return minutesSinceMidnight >= from || minutesSinceMidnight < to;
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Merge a sensor's stored partial config with defaults. */
export function resolveFlowConfig(stored: Partial<FlowConfig> | null | undefined): FlowConfig {
  return { ...DEFAULT_FLOW_CONFIG, ...(stored ?? {}) };
}
