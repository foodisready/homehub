/**
 * Watching the computer's temperature and power, with fake readings and a
 * fake clock, and temporary /sys folders for the readers.
 * Modules load dynamically in before(), after DB_PATH is set.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-computer-watch-test-'));
const MIN = 60_000;
const T0 = Date.parse('2026-11-11T12:00:00Z');

let w: typeof import('./computer-watch');
let h: typeof import('./health');

function hwmon(root: string, alarm: string): string {
  for (const [dir, name] of [['hwmon0', 'cpu_thermal'], ['hwmon1', 'rpi_volt']]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'name'), `${name}\n`);
  }
  fs.writeFileSync(path.join(root, 'hwmon1', 'in0_lcrit_alarm'), `${alarm}\n`);
  return root;
}

function thermal(root: string, milli: string): string {
  fs.mkdirSync(path.join(root, 'thermal_zone0'), { recursive: true });
  fs.writeFileSync(path.join(root, 'thermal_zone0', 'temp'), milli);
  return root;
}

describe('Computer watch', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    w = await import('./computer-watch');
    h = await import('./health');
  });

  after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
  beforeEach(() => w.resetComputerWatch());

  it('reads a Raspberry Pi\'s power warning, and nothing elsewhere', () => {
    assert.equal(w.readLowPower(hwmon(path.join(TMP, 'pi-ok'), '0')), false);
    assert.equal(w.readLowPower(hwmon(path.join(TMP, 'pi-low'), '1')), true);
    assert.equal(w.readLowPower(path.join(TMP, 'missing')), null);
    assert.equal(w.readTemperature(thermal(path.join(TMP, 'th'), '55012')), 55.012);
    assert.equal(w.readTemperature(path.join(TMP, 'missing')), null);
  });

  it('tells admins once when it stays too hot, not for a short burst', () => {
    const sent: string[] = [];
    const notify = (title: string) => { sent.push(title); };
    let t = 82;
    const read = { temperature: () => t, lowPower: () => false };
    for (let m = 0; m < 4; m++) w.sample(T0 + m * MIN, read, notify);
    t = 70;
    w.sample(T0 + 4 * MIN, read, notify);
    assert.deepEqual(sent, [], 'four minutes, then cooler: no notification');

    t = 83;
    for (let m = 5; m <= 10; m++) w.sample(T0 + m * MIN, read, notify);
    assert.deepEqual(sent, ['HomeHub is running hot']);
    for (let m = 11; m <= 60; m++) w.sample(T0 + m * MIN, read, notify);
    assert.equal(sent.length, 1, 'not again within six hours');
    w.sample(T0 + 6 * 60 * MIN + 10 * MIN, read, notify);
    assert.equal(sent.length, 2, 'again once six hours have passed');
  });

  it('tells admins when the power runs low, and Health remembers it for a day', () => {
    const sent: string[] = [];
    let low = false;
    const read = { temperature: () => 50, lowPower: () => low };
    w.sample(T0, read, (title) => sent.push(title));
    assert.equal(w.powerReported(), true);
    low = true;
    w.sample(T0 + MIN, read, (title) => sent.push(title));
    w.sample(T0 + 2 * MIN, read, (title) => sent.push(title));
    assert.deepEqual(sent, ["HomeHub isn't getting enough power"]);

    const ok = hwmon(path.join(TMP, 'pi-ok2'), '0');
    const [p] = h.power(ok, T0 + 3 * 60 * MIN);
    assert.equal(p.level, 'warn');
    assert.match(p.detail, /ran low 3 hours ago/);
    assert.equal(h.power(ok, T0 + 25 * 60 * MIN)[0].level, 'ok', 'forgotten after a day');
    assert.equal(h.power(hwmon(path.join(TMP, 'pi-low2'), '1'), T0)[0].level, 'error');
    assert.deepEqual(h.power(path.join(TMP, 'missing'), T0), [], 'not a Pi: no Power item');
  });

  it('says how hot it got while nobody was looking', () => {
    const read = { temperature: () => 81, lowPower: () => null };
    w.sample(T0, read, () => undefined);
    const now = T0 + 2 * 60 * MIN;
    const [t] = h.temperature(thermal(path.join(TMP, 'cool'), '55000'), now);
    assert.equal(t.level, 'info');
    assert.equal(t.detail, '55 °C now. It reached 81 °C 2 hours ago, hot enough to slow itself down.');
    assert.equal(h.temperature(path.join(TMP, 'cool'), T0 + 25 * 60 * MIN)[0].detail, '55 °C', 'forgotten after a day');
  });
});
