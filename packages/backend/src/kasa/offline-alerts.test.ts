import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_EVERY_MS, OFFLINE_FOR_MS, OfflineAlerts } from './offline-alerts';

const MIN = 60_000;

describe('device offline notifications', () => {
  it('waits until a device has been unreachable for a while, then tells once', () => {
    const told: string[] = [];
    const a = new OfflineAlerts((_id, alias) => told.push(alias));
    a.missed(1, 'Lamp', true, 0);
    a.missed(1, 'Lamp', false, 5 * MIN);
    assert.deepEqual(told, [], 'a short blip says nothing');
    a.missed(1, 'Lamp', false, OFFLINE_FOR_MS);
    a.missed(1, 'Lamp', false, OFFLINE_FOR_MS + MIN);
    assert.deepEqual(told, ['Lamp'], 'once for the outage');
  });

  it('says nothing for a blip that recovers', () => {
    const told: string[] = [];
    const a = new OfflineAlerts((_id, alias) => told.push(alias));
    a.missed(1, 'Lamp', true, 0);
    a.reached(1);
    a.missed(1, 'Lamp', undefined, 20 * MIN);
    assert.deepEqual(told, []);
  });

  it('ignores a device already unreachable when HomeHub starts', () => {
    const told: string[] = [];
    const a = new OfflineAlerts((_id, alias) => told.push(alias));
    for (let t = 0; t <= 60 * MIN; t += MIN / 2) a.missed(2, 'Garage', undefined, t);
    assert.deepEqual(told, []);
  });

  it('tells at most once a day for a device that keeps dropping', () => {
    const told: number[] = [];
    const a = new OfflineAlerts((id) => told.push(id));
    let t = 0;
    const outage = () => { a.missed(3, 'Cam', true, t); t += OFFLINE_FOR_MS; a.missed(3, 'Cam', false, t); a.reached(3); t += MIN; };
    outage(); outage(); outage();
    assert.equal(told.length, 1);
    t = ALERT_EVERY_MS + 1;
    outage();
    assert.equal(told.length, 2, 'a day later it tells again');
  });
});
