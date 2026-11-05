/**
 * What the scheduler sends the backend when a schedule runs, against an
 * in-memory database and a fake backend.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Database from 'better-sqlite3';

const received: Record<string, unknown>[] = [];
const backend = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    received.push({ path: req.url, key: req.headers['x-internal-key'], ...JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

let db: Database.Database;
let service: import('./scheduler.service').SchedulerService;

describe('Running a schedule', () => {
  before(async () => {
    await new Promise<void>((ok) => backend.listen(0, '127.0.0.1', ok));
    process.env.BACKEND_URL = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
    process.env.INTERNAL_API_KEY = 'test-key';
    db = new Database(':memory:');
    db.exec(`CREATE TABLE schedules (
      id INTEGER PRIMARY KEY, device_id INTEGER, label TEXT, trigger_type TEXT, cron_expression TEXT,
      solar_event TEXT, solar_offset_minutes INTEGER DEFAULT 0, duration_minutes INTEGER,
      stay_on_minutes INTEGER, state INTEGER, enabled INTEGER DEFAULT 1)`);
    const { SchedulerService } = await import('./scheduler.service');
    service = new SchedulerService(db);
  });

  after(() => {
    backend.close();
    db.close();
  });

  const run = (id: number) => {
    const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
    return (service as unknown as { execute(r: unknown): Promise<void> }).execute(row);
  };

  it('sends a Turn ON schedule\'s "Turn off after" along', async () => {
    db.prepare("INSERT INTO schedules (id, device_id, label, trigger_type, solar_event, stay_on_minutes, state) VALUES (1, 7, 'Porch at sunset', 'solar', 'sunset', 180, 1)").run();
    await run(1);
    assert.deepEqual(received.pop(), { path: '/internal/devices/7/execute', key: 'test-key', state: true, label: 'Porch at sunset', stayOnMinutes: 180 });
  });

  it('sends none for a schedule without one, or a Turn OFF', async () => {
    db.prepare("INSERT INTO schedules (id, device_id, label, trigger_type, cron_expression, state) VALUES (2, 7, 'On at 6', 'cron', '0 18 * * *', 1)").run();
    db.prepare("INSERT INTO schedules (id, device_id, label, trigger_type, cron_expression, stay_on_minutes, state) VALUES (3, 7, 'Off at 11', 'cron', '0 23 * * *', 60, 0)").run();
    await run(2);
    assert.deepEqual(received.pop(), { path: '/internal/devices/7/execute', key: 'test-key', state: true, label: 'On at 6' });
    await run(3);
    assert.deepEqual(received.pop(), { path: '/internal/devices/7/execute', key: 'test-key', state: false, label: 'Off at 11' });
  });

  it('skips a schedule turned off since it was loaded', async () => {
    db.prepare('UPDATE schedules SET enabled = 0 WHERE id = 1').run();
    await run(1);
    assert.equal(received.length, 0);
  });
});
