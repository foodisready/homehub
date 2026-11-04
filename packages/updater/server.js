'use strict';
/**
 * HomeHub's updater: switches HomeHub to a given release, newer or older.
 *
 * It's the only HomeHub service with the Docker socket. It answers on
 * 127.0.0.1 only, and only to requests carrying the update token that the
 * backend made in the data volume. It does one thing: fetch that release's
 * docker-compose.yml and images, record the version in .env as HOMEHUB_TAG,
 * and bring HomeHub's services up with them, creating any the release adds.
 * Nothing outside HomeHub's compose project is touched, and it doesn't
 * recreate itself: the installer updates the updater.
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
/** Where each release's docker-compose.yml is: <RAW>/<version>/docker-compose.yml. */
const RAW = (process.env.HOMEHUB_RAW_URL || 'https://raw.githubusercontent.com/foodisready/homehub').replace(/\/+$/, '');
const SELF = 'updater';
/** Marks a HOMEHUB_TAG the updater wrote, so the installer knows it may replace it. */
const MARK = "# Chosen in HomeHub (Update or Go back). The installer replaces it with the newest release.";
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

/**
 * .env text with HOMEHUB_TAG set to `version`, everything else kept. A new
 * line gets MARK above it; one someone set by hand is changed in place.
 */
function withTag(text, version) {
  const lines = text ? text.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let found = false;
  const out = lines.map((l) => {
    if (/^\s*HOMEHUB_TAG\s*=/.test(l)) { found = true; return `HOMEHUB_TAG=${version}`; }
    return l;
  });
  if (!found) out.push(MARK, `HOMEHUB_TAG=${version}`);
  return out.join('\n') + '\n';
}

function currentTag(text) {
  const m = /^\s*HOMEHUB_TAG\s*=\s*(\S+)/m.exec(text || '');
  return m ? m[1].replace(/^["']|["']$/g, '') : 'latest';
}

function readEnv() {
  try { return fs.readFileSync(path.join(PROJECT, '.env'), 'utf8'); } catch { return ''; }
}

/** Writes a file in the project folder in one step, owned like the folder so its owner can still edit it. */
function writeProjectFile(name, text) {
  const file = path.join(PROJECT, name);
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
const writeEnv = (text) => writeProjectFile('.env', text);

/** A release's docker-compose.yml, from GitHub. */
async function fetchCompose(version, get = fetch) {
  const r = await get(`${RAW}/${version}/docker-compose.yml`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`docker-compose.yml for ${version} couldn't be downloaded (HTTP ${r.status})`);
  const text = await r.text();
  if (!/^services:/m.test(text)) throw new Error(`docker-compose.yml for ${version} isn't a compose file`);
  return text;
}

/** Runs docker compose for HomeHub's project; resolves with its exit code and output. */
function compose(args, version, file = 'docker-compose.yml') {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', '-p', PROJECT_NAME, '-f', path.join(PROJECT, file), '--project-directory', PROJECT, ...args], {
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

async function switchTo(version, run = compose, get = fetch) {
  const from = currentTag(readEnv());
  const started = new Date().toISOString();
  const finish = (ok, step, output) => {
    state.last = { version, from, ok, step, started, finished: new Date().toISOString(), log: tail(output) };
    state.busy = false;
    console.log(`${ok ? 'switched' : 'failed to switch'} to ${version} (${step})`);
  };
  console.log(`switching from ${from} to ${version}`);
  const NEXT = 'docker-compose.yml.next';
  const drop = () => { try { fs.unlinkSync(path.join(PROJECT, NEXT)); } catch { /* gone */ } };

  // Download everything first: if any of it can't be had, nothing has changed.
  try {
    writeProjectFile(NEXT, await fetchCompose(version, get));
  } catch (err) {
    return finish(false, 'download', String(err.message));
  }
  const check = await run(['config', '--quiet'], version, NEXT);
  if (check.code !== 0) { drop(); return finish(false, 'download', check.output); }
  const listed = await run(['config', '--services'], version, NEXT);
  const services = listed.output.split('\n').map((l) => l.trim()).filter((l) => /^[a-z0-9][a-z0-9_-]*$/.test(l) && l !== SELF);
  if (listed.code !== 0 || !SERVICES.every((s) => services.includes(s))) {
    drop();
    return finish(false, 'download', listed.output || 'The release is missing HomeHub services');
  }
  const pull = await run(['pull', '--quiet', ...services], version, NEXT);
  if (pull.code !== 0) { drop(); return finish(false, 'download', pull.output); }

  // Then switch: the compose file and the version together, keeping the old file.
  try {
    const current = path.join(PROJECT, 'docker-compose.yml');
    if (fs.existsSync(current)) fs.copyFileSync(current, `${current}.previous`);
    fs.renameSync(path.join(PROJECT, NEXT), current);
    writeEnv(withTag(readEnv(), version));
  } catch (err) {
    drop();
    return finish(false, 'save', String(err.message));
  }
  // Every service but this one: new ones are created, unchanged ones left running.
  const up = await run(['up', '-d', '--no-deps', ...services], version);
  finish(up.code === 0, up.code === 0 ? 'done' : 'restart', up.output);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function handler(run = compose, get = fetch) {
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
        switchTo(version, run, get).catch((err) => {
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

module.exports = { withTag, currentTag, handler, switchTo, state, SERVICES, MARK };
