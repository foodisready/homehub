/**
 * Tries every deviceId/key combo against every Tuya IP to find correct mappings.
 * Run: node scripts/tuya-match.js
 */
const TuyAPI = require('tuyapi');
const Database = require('better-sqlite3');

const db = new Database('./data/db.sqlite');
const rows = db.prepare("SELECT id, alias, ip, driver_config FROM devices WHERE driver_type='tuya'").all();

const devices = rows.map(r => ({
  dbId:   r.id,
  alias:  r.alias,
  ip:     r.ip,
  ...JSON.parse(r.driver_config || '{}'),
}));

const ips      = [...new Set(devices.map(d => d.ip))];
const baseConfigs = devices.map(d => ({ deviceId: d.deviceId, key: d.key }));
// Test each config with both v3.3 and v3.4
const configs  = baseConfigs.flatMap(c => [
  { ...c, version: '3.3' },
  { ...c, version: '3.4' },
]);

async function tryCombo(ip, { deviceId, key, version }) {
  return new Promise((resolve) => {
    const device = new TuyAPI({ id: deviceId, key, ip, issueGetOnConnect: false, version });
    device.on('error', () => {});
    const timer = setTimeout(() => { try { device.disconnect(); } catch {} resolve(false); }, 4000);
    device.connect()
      .then(() => device.get({ dps: '1' }))
      .then((val) => {
        clearTimeout(timer);
        try { device.disconnect(); } catch {}
        resolve(val);
      })
      .catch(() => {
        clearTimeout(timer);
        try { device.disconnect(); } catch {}
        resolve(false);
      });
  });
}

(async () => {
  console.log('Testing all IP × deviceId/key combinations...\n');
  for (const ip of ips) {
    for (const cfg of configs) {
      const result = await tryCombo(ip, cfg);
      const ok = result !== false;
      console.log(`${ip}  +  ${cfg.deviceId.slice(0, 16)}…  key=${cfg.key}  →  ${ok ? `✓ state=${result}` : '✗ timeout/fail'}`);
    }
    console.log();
  }
})();
