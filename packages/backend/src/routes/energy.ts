import { Router, Request, Response } from 'express';
import { getDb } from '../db';

export const energyRouter = Router();

type Range = '24h' | '7d' | '30d';

const RANGE_CONFIG: Record<Range, { interval: string; points: number; lookback: string }> = {
  '24h': { interval: '1 hour',  points: 24,  lookback: '-24 hours' },
  '7d':  { interval: '6 hours', points: 28,  lookback: '-7 days'   },
  '30d': { interval: '1 day',   points: 30,  lookback: '-30 days'  },
};

interface DeviceRow {
  id: number;
  alias: string;
  has_emeter: number;
}

// GET /api/devices/:id/energy/history?range=24h|7d|30d
energyRouter.get('/:id/energy/history', (req: Request, res: Response) => {
  const db    = getDb();
  const range = (req.query.range as Range) ?? '24h';

  if (!RANGE_CONFIG[range]) {
    return res.status(400).json({ error: 'range must be 24h, 7d, or 30d', code: 'VALIDATION_ERROR' });
  }

  const device = db.prepare('SELECT * FROM devices WHERE id = ? OR alias = ?')
    .get(req.params.id, req.params.id) as DeviceRow | undefined;
  if (!device) return res.status(404).json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' });
  if (!device.has_emeter) return res.status(400).json({ error: 'Device does not support energy monitoring', code: 'NO_EMETER' });

  const { lookback } = RANGE_CONFIG[range];

  // SQLite: group into time buckets and average wattage per bucket
  // strftime truncation: 24h → hour bucket, 7d → 6-hour bucket (by rounding), 30d → day bucket
  const bucketExpr = range === '24h'
    ? `strftime('%Y-%m-%dT%H:00:00Z', recorded_at)`
    : range === '7d'
    ? `strftime('%Y-%m-%dT', recorded_at) || printf('%02d', (cast(strftime('%H', recorded_at) as integer) / 6) * 6) || ':00:00Z'`
    : `strftime('%Y-%m-%dT00:00:00Z', recorded_at)`;

  const rows = db.prepare(`
    SELECT
      ${bucketExpr}              AS timestamp,
      AVG(wattage)               AS wattage,
      AVG(voltage)               AS voltage,
      AVG(current)               AS current,
      COUNT(*)                   AS samples
    FROM energy_readings
    WHERE device_id = ?
      AND recorded_at >= datetime('now', ?)
      AND wattage IS NOT NULL
    GROUP BY ${bucketExpr}
    ORDER BY timestamp ASC
  `).all(device.id, lookback) as any[];

  res.json({
    deviceId: device.id,
    alias:    device.alias,
    range,
    readings: rows.map((r) => ({
      timestamp: r.timestamp,
      wattage:   r.wattage != null  ? +r.wattage.toFixed(2)  : null,
      voltage:   r.voltage != null  ? +r.voltage.toFixed(1)  : null,
      current:   r.current != null  ? +r.current.toFixed(3)  : null,
      samples:   r.samples,
    })),
  });
});
