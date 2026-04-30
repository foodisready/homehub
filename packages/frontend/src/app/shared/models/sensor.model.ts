export type AlertLevel = 0 | 1 | 2 | 3;

export interface Sensor {
  id:                  number;
  sensorId:            string;
  type:                string;
  alias:               string;
  config:              Record<string, unknown> | null;
  firstSeenMac:        string | null;
  lastSeenAt:          string | null;
  lastRssi:            number | null;
  lastUptimeSec:       number | null;
  lastSignalQuality:   number | null;
  firmwareVersion:     string | null;
  pendingState:        'idle' | 'flowing';
  snoozedUntil:        string | null;
  staleSince:          string | null;
  createdAt:           string;
}

export type ShutoffStatus = 'not_fired' | 'fired' | 'verified' | 'failed';

export interface FlowEvent {
  id:                  number;
  sensorId:            number;
  startTime:           string;
  endTime:             string | null;
  peakRate:            number;
  avgRate:             number | null;
  totalM3:             number | null;
  status:              'active' | 'closed';
  alertLevel:          AlertLevel;
  shutoffStatus:       ShutoffStatus;
  shutoffFiredAt:      string | null;
  shutoffCompletedAt:  string | null;
}

export interface FlowReading {
  id:             number;
  sensorId:       number;
  rateM3h:        number;
  totalM3:        number | null;
  signalQuality:  number | null;
  recordedAt:     string;
}

export interface ConsumptionBucket {
  bucket:     string;
  m3:         number;
  gallons:    number;
  eventCount: number;
}
