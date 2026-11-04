'use strict';
/**
 * HomeHub's updater: switches HomeHub to a given release, newer or older.
 *
 * It's the only HomeHub service with the Docker socket. It answers on
 * 127.0.0.1 only, and only to requests carrying the update token that the
 * backend made in the data volume. It does one thing: download a version's
 * images, record the version in .env as HOMEHUB_TAG, and recreate HomeHub's
 * own services with it. Nothing else on the computer is touched, and it
 * doesn't recreate itself.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8081;
const HOST = process.env.HOST || '127.0.0.1';
const PROJECT = process.env.PROJECT_DIR || '/project';
/** HomeHub's compose project name, set in docker-compose.yml. */
const PROJECT_NAME = process.env.COMPOSE_PROJECT || 'homehub';
const TOKEN_FILE = process.env.TOKEN_FILE || '/homehub/secrets/WATCHTOWER_HTTP_API_TOKEN';
/** HomeHub's own services, the ones whose images follow HOMEHUB_TAG. */
const SERVICES = ['backend', 'frontend', 'scheduler', 'mcp-server'];
const VERSION = /^v\d+\.\d+\.\d+$/;
const LOG_LINES = 40;

function token() {
  if (process.env.UPDATER_TOKEN) return process.env.UPDATER_TOKEN.trim();
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

function authorized(header) {
  const want = token();
  const got = /^Bearer (.+)$/.exec(header || '')?.[1] ?? '';
  if (!want || !got) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** .env text with HOMEHUB_TAG set to `version`, everything else kept. */
function withTag(text, version) {
  const lines = text ? text.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let found = false;
  const out = lines.map((l) => {
    if (/^\s*HOMEHUB_TAG\s*=/.test(l)) { found = true; return `HOMEHUB_TAG=${version}`; }
    return l;
  });
  if (!found) out.push(`HOMEHUB_TAG=${version}`);
  return out.join('\n') + '\n';
}

function currentTag(text) {
  const m = /^\s*HOMEHUB_TAG\s*=\s*(\S+)/m.exec(text || '');
  return m ? m[1].replace(/^["']|["']$/g, '') : 'latest';
}

function readEnv() {
  try { return fs.readFileSync(path.join(PROJECT, '.env'), 'utf8'); } catch { return ''; }
}

/** Writes .env in one step, owned like the folder so its owner can still edit it. */
function writeEnv(text) {
  const file = path.join(PROJECT, '.env');
  const tmp = `${file}.updater-tmp`;
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  fs.writeFileSync(tmp, text, { mode });
  try {
    const dir = fs.statSync(PROJECT);
    fs.chownSync(tmp, dir.uid, dir.gid);
  } catch { /* not allowed: keep root's */ }
  fs.renameSync(tmp, file);
}

/** Runs docker compose for HomeHub's project; resolves with its exit code and output. */
function compose(args, version) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', '-p', PROJECT_NAME, '-f', path.join(PROJECT, 'docker-compose.yml'), '--project-directory', PROJECT, ...args], {
      env: { ...process.env, HOMEHUB_TAG: version },
    });
    let output = '';
    const keep = (d) => { output += d.toString(); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => resolve({ code: 127, output: String(err.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

const state = { busy: false, last: null };
const tail = (s) => s.trim().split('\n').slice(-LOG_LINES).join('\n');

async function switchTo(version, run = compose) {
  const from = currentTag(readEnv());
  const started = new Date().toISOString();
  const finish = (ok, step, output) => {
    state.last = { version, from, ok, step, started, finished: new Date().toISOString(), log: tail(output) };
    state.busy = false;
    console.log(`${ok ? 'switched' : 'failed to switch'} to ${version} (${step})`);
  };
  console.log(`switching from ${from} to ${version}`);
  // Download first: if this version's images can't be had, nothing has changed.
  const pull = await run(['pull', '--quiet', ...SERVICES], version);
  if (pull.code !== 0) return finish(false, 'download', pull.output);
  try {
    writeEnv(withTag(readEnv(), version));
  } catch (err) {
    return finish(false, 'save', String(err.message));
  }
  const up = await run(['up', '-d', '--no-deps', ...SERVICES], version);
  finish(up.code === 0, up.code === 0 ? 'done' : 'restart', up.output);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function handler(run = compose) {
  return (req, res) => {
    const url = new URL(req.url, 'http://updater');
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true });
    }
    if (!authorized(req.headers.authorization)) {
      return send(res, 401, { error: 'Not allowed', code: 'UNAUTHORIZED' });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return send(res, 200, { busy: state.busy, current: currentTag(readEnv()), last: state.last });
    }
    if (req.method === 'POST' && url.pathname === '/switch') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1000) req.destroy(); });
      req.on('end', () => {
        let version;
        try { version = JSON.parse(body).version; } catch { /* checked below */ }
        if (typeof version !== 'string' || !VERSION.test(version)) {
          return send(res, 400, { error: 'version must look like v1.2.3', code: 'VALIDATION_ERROR' });
        }
        if (state.busy) return send(res, 409, { error: 'A switch is already running', code: 'BUSY' });
        state.busy = true;
        send(res, 202, { started: true, version });
        switchTo(version, run).catch((err) => {
          state.busy = false;
          state.last = { version, ok: false, step: 'error', log: String(err?.message ?? err) };
        });
      });
      return;
    }
    send(res, 404, { error: 'Not found' });
  };
}

if (require.main === module) {
  http.createServer(handler()).listen(PORT, HOST, () => console.log(`HomeHub updater on ${HOST}:${PORT}`));
  process.on('SIGTERM', () => process.exit(0));
}

module.exports = { withTag, currentTag, handler, switchTo, state, SERVICES };
