'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-updater-'));
process.env.PROJECT_DIR = DIR;
process.env.UPDATER_TOKEN = 'secret-token';
const { withTag, currentTag, handler, state, SERVICES, MARK } = require('./server');

describe('.env', () => {
  it('sets HOMEHUB_TAG and keeps everything else', () => {
    assert.equal(withTag('', 'v1.2.3'), `${MARK}\nHOMEHUB_TAG=v1.2.3\n`);
    assert.equal(withTag('A=1\nHOMEHUB_TAG=v1.0.0\n# note\n', 'v1.2.3'), 'A=1\nHOMEHUB_TAG=v1.2.3\n# note\n', 'one set by hand is changed in place');
    assert.equal(withTag(`A=1\n${MARK}\nHOMEHUB_TAG=v1.0.0\n`, 'v2.0.0'), `A=1\n${MARK}\nHOMEHUB_TAG=v2.0.0\n`);
  });
  it('reads the current tag', () => {
    assert.equal(currentTag(''), 'latest');
    assert.equal(currentTag('X=1\nHOMEHUB_TAG="v0.1.9"\n'), 'v0.1.9');
  });
});

describe('API', () => {
  let server, base, calls, failPull, composeText, fetched;
  const NEW = 'name: homehub\nservices:\n  backend: {}\n';
  const fakeCompose = async (args, version, file = 'docker-compose.yml') => {
    calls.push({ args, version, file });
    if (args[0] === 'config' && args[1] === '--services') return { code: 0, output: 'ollama\nbackend\nfrontend\nmcp-server\nscheduler\nupdater\nwatchtower\nnew-thing\n' };
    if (args[0] === 'pull' && failPull) return { code: 1, output: 'manifest unknown' };
    return { code: 0, output: 'ok' };
  };
  const fakeGet = async (url) => { fetched = url; return new Response(composeText, { status: composeText ? 200 : 404 }); };
  const req = (method, p, body, auth = 'Bearer secret-token') => new Promise((resolve, reject) => {
    const r = http.request(base + p, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
  const settle = async () => { for (let i = 0; i < 50 && state.busy; i++) await new Promise((r) => setTimeout(r, 10)); };

  before(async () => {
    server = http.createServer(handler(fakeCompose, fakeGet));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.close(); fs.rmSync(DIR, { recursive: true, force: true }); });
  beforeEach(() => {
    calls = []; failPull = false; state.last = null; composeText = NEW; fetched = null;
    fs.writeFileSync(path.join(DIR, '.env'), 'TZ=America/New_York\n');
    fs.writeFileSync(path.join(DIR, 'docker-compose.yml'), 'name: homehub\nservices: {old: {}}\n');
  });

  it('answers health without a token, and nothing else', async () => {
    assert.equal((await req('GET', '/health', undefined, '')).status, 200);
    assert.equal((await req('GET', '/status', undefined, '')).status, 401);
    assert.equal((await req('POST', '/switch', { version: 'v1.0.0' }, 'Bearer wrong')).status, 401);
    assert.equal(calls.length, 0);
  });

  it('refuses anything but a release version', async () => {
    for (const version of ['latest', 'v1.0', '1.0.0', 'v1.0.0; rm -rf /', '']) {
      assert.equal((await req('POST', '/switch', { version })).status, 400, version);
    }
    assert.equal((await req('POST', '/switch', 'not json')).status, 400);
    assert.equal(calls.length, 0);
  });

  it('fetches the release, records the version, then brings up its services but itself', async () => {
    const r = await req('POST', '/switch', { version: 'v0.1.12' });
    assert.equal(r.status, 202);
    await settle();
    assert.equal(fetched, 'https://raw.githubusercontent.com/foodisready/homehub/v0.1.12/docker-compose.yml');
    assert.deepEqual(calls.map((c) => c.args.slice(0, 2).join(' ')), ['config --quiet', 'config --services', 'pull --quiet', 'up -d']);
    assert.ok(calls.slice(0, 3).every((c) => c.file === 'docker-compose.yml.next'), 'checked before it replaces anything');
    assert.ok(calls.every((c) => c.version === 'v0.1.12'));
    const services = ['ollama', 'backend', 'frontend', 'mcp-server', 'scheduler', 'watchtower', 'new-thing'];
    assert.deepEqual(calls[3].args, ['up', '-d', '--no-deps', ...services], 'a new service is created; the updater is left alone');
    assert.equal(fs.readFileSync(path.join(DIR, 'docker-compose.yml'), 'utf8'), NEW);
    assert.match(fs.readFileSync(path.join(DIR, 'docker-compose.yml.previous'), 'utf8'), /old/);
    assert.ok(!fs.existsSync(path.join(DIR, 'docker-compose.yml.next')));
    assert.equal(fs.readFileSync(path.join(DIR, '.env'), 'utf8'), `TZ=America/New_York\n${MARK}\nHOMEHUB_TAG=v0.1.12\n`);
    const s = await req('GET', '/status');
    assert.equal(s.body.current, 'v0.1.12');
    assert.equal(s.body.last.ok, true);
    assert.equal(s.body.last.from, 'latest');
  });

  it('changes nothing when the release\'s compose file can\'t be had', async () => {
    composeText = '';
    await req('POST', '/switch', { version: 'v9.9.9' });
    await settle();
    assert.equal(calls.length, 0);
    assert.equal(state.last.step, 'download');
    assert.match(fs.readFileSync(path.join(DIR, 'docker-compose.yml'), 'utf8'), /old/);
  });

  it('changes nothing when the version can\'t be downloaded', async () => {
    failPull = true;
    await req('POST', '/switch', { version: 'v9.9.9' });
    await settle();
    assert.deepEqual(calls.map((c) => c.args[0]), ['config', 'config', 'pull']);
    assert.equal(fs.readFileSync(path.join(DIR, '.env'), 'utf8'), 'TZ=America/New_York\n');
    assert.match(fs.readFileSync(path.join(DIR, 'docker-compose.yml'), 'utf8'), /old/);
    assert.ok(!fs.existsSync(path.join(DIR, 'docker-compose.yml.next')));
    const s = await req('GET', '/status');
    assert.equal(s.body.last.ok, false);
    assert.equal(s.body.last.step, 'download');
    assert.match(s.body.last.log, /manifest unknown/);
  });
});
