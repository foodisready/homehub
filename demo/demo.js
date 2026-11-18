/**
 * The demo page: a clock that runs the kitchen's day, the lights, chat, schedules and activity.
 * Nothing leaves the browser; reloading starts over.
 */
import { parseCommand, replyText, clock } from './commands.js';
import {
  LIGHTS, lightById, SCENES, SCHEDULES, SUNRISE, SUNSET, MOTION_MINUTES,
  applyChanges, watts, minuteOfDay, scheduleMinute, scheduleChanges, daylight, replayTo, plan, motionTurnsOn,
} from './home.js';
import { sceneSVG } from './scene.js';

const $ = (sel) => document.querySelector(sel);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (m) => clock('en', m);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const SCENE_LABELS = { cooking: 'Cooking', dinner: 'Dinner', nightlight: 'Night light', goodnight: 'Goodnight' };
const SHORT = { ceiling: 'ceiling', counter: 'under-cabinet', pendants: 'pendants' };
const SOURCE_LABELS = { schedule: 'Schedule', chat: 'Chat', motion: 'Motion', you: 'You', timer: 'Timer' };
const HTML_LANG = { en: 'en', vi: 'vi', yue: 'zh-HK', zh: 'zh-CN' };
const SUGGESTIONS = [
  ['en', 'Turn on the kitchen lights'], ['en', 'Dim the pendants to 30%'], ['yue', '開吊燈十分鐘'], ['zh', '打开顶灯'],
  ['vi', 'Bật đèn dưới tủ'], ['en', 'Ceiling lights on for 10 minutes'], ['yue', '熄晒啲燈'], ['zh', '晚上七点吃饭'],
  ['vi', 'Tắt đèn bếp 15 phút nữa'], ['en', 'Goodnight at 11 pm'], ['en', 'Cooking'], ['en', "What's on?"],
];

/* ── State ─────────────────────────────────────────────── */

const START = 17 * 60 + 20;          // 5:20 pm: half an hour before sunset
const schedules = SCHEDULES.map((s) => ({ ...s, enabled: true }));
let t = START;                        // minutes since midnight of day one
let speed = 120;                      // simulated seconds per real second
let playing = !reduceMotion;
let { lights, wh } = replayTo(START, schedules);
let timers = [];                      // { id, at, changes, source, label }
let timerSeq = 1;
let motionTimer = null;
let pending = null;                   // lights an "on or off?" was about
let dragging = false;
const activity = [];
let unread = 0;

/* ── Scene ─────────────────────────────────────────────── */

$('#scene').innerHTML = sceneSVG();
const svg = $('#scene svg');
const node = (id) => svg.getElementById(id);
const S = {
  darkness: node('darkness'), day: node('mask-day'), skyTop: node('sky-top'), skyBot: node('sky-bot'),
  sun: node('sun'), moon: node('moon'), stars: node('stars'), hills: node('hills'), trees: node('trees'), ground: node('ground'),
  reflect: node('reflect'), clockH: node('clock-h'), clockM: node('clock-m'), person: node('person'), led: node('sensor-led'),
  desc: node('scene-desc'),
};
const FX = Object.fromEntries(LIGHTS.map((l) => [l.id, ['mask', 'glow', 'fix'].map((p) => node(`${p}-${l.id}`))]));

// Tap a light in the picture to switch it.
const hits = document.createElementNS('http://www.w3.org/2000/svg', 'g');
hits.setAttribute('aria-hidden', 'true');
hits.innerHTML = `
  <polygon data-light="ceiling" points="0,0 1200,0 1062,76 138,76"><title>Ceiling lights</title></polygon>
  ${[[150, 482], [718, 1050]].map(([a, b]) => `<rect data-light="counter" x="${a}" y="330" width="${b - a}" height="56"><title>Under-cabinet lights</title></rect>`).join('')}
  ${[420, 600, 780].map((x) => `<rect data-light="pendants" x="${x - 44}" y="380" width="88" height="62"><title>Island pendants</title></rect>`).join('')}`;
for (const h of hits.children) {
  h.setAttribute('fill', 'transparent');
  h.style.cursor = 'pointer';
  h.addEventListener('click', () => toggle(h.dataset.light));
}
svg.appendChild(hits);

const intensity = (l) => {
  const s = lights[l.id];
  return s.on ? (l.dimmable ? Math.pow(s.level / 100, 0.6) : 1) : 0;
};

function hex(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function mix(a, b, k) {
  const A = hex(a), B = hex(b), x = Math.min(1, Math.max(0, k));
  return `#${A.map((v, i) => Math.round(v + (B[i] - v) * x).toString(16).padStart(2, '0')).join('')}`;
}

let shownMinute = -1;
function renderTime() {
  const m = minuteOfDay(t), d = daylight(t);
  S.darkness.setAttribute('opacity', (0.86 * Math.pow(1 - d, 1.15)).toFixed(3));
  S.day.setAttribute('opacity', d.toFixed(3));

  const tw = m < 720 ? ['#3a4f8f', '#f6b98a'] : ['#2c3d78', '#f2a16a'];
  const [top, bot] = d < 0.5
    ? [mix('#070d1f', tw[0], d / 0.5), mix('#16224a', tw[1], d / 0.5)]
    : [mix(tw[0], '#4f9be0', (d - 0.5) / 0.5), mix(tw[1], '#bfe0fb', (d - 0.5) / 0.5)];
  S.skyTop.setAttribute('stop-color', top);
  S.skyBot.setAttribute('stop-color', bot);
  S.stars.setAttribute('opacity', Math.pow(1 - d, 3).toFixed(3));
  S.moon.setAttribute('opacity', Math.pow(1 - d, 2).toFixed(3));
  S.sun.setAttribute('transform', `translate(${m < 720 ? 535 : 668} ${(430 - 260 * d).toFixed(1)})`);
  for (const c of S.sun.children) c.setAttribute('fill', mix('#ff7a3d', '#ffe08a', d));
  S.hills.setAttribute('fill', mix('#121a33', '#6f9a6a', d));
  S.trees.setAttribute('fill', mix('#0a1122', '#3f6e45', d));
  S.ground.setAttribute('fill', mix('#0d1528', '#557f4f', d));
  const inside = Math.min(1, LIGHTS.reduce((s, l) => s + intensity(l), 0) / 2);
  S.reflect.setAttribute('opacity', ((1 - d) * inside).toFixed(3));
  S.clockH.setAttribute('transform', `rotate(${((m / 60) % 12) * 30})`);
  S.clockM.setAttribute('transform', `rotate(${(m % 60) * 6})`);

  const whole = Math.floor(m);
  if (whole === shownMinute) return;
  shownMinute = whole;
  $('#timeChip').textContent = fmt(whole);
  $('#clockBig').textContent = fmt(whole);
  $('#clockSub').textContent = whole >= SUNRISE && whole < SUNSET ? `Sunset at ${fmt(SUNSET)}` : `Sunrise at ${fmt(SUNRISE)}`;
  if (!dragging) $('#scrub').value = whole;
  renderEnergy();
  if (whole % 15 === 0) describeScene();
}

function renderEnergy() {
  const w = Math.round(watts(lights));
  $('#wattChip').textContent = `${w} W`;
  $('#energy').textContent = `${w} W now · ${(wh / 1000).toFixed(2)} kWh today`;
}

function describeScene() {
  const m = minuteOfDay(t), d = daylight(t);
  const outside = d > 0.7 ? 'daylight outside' : d > 0.15 ? 'dusk outside' : 'dark outside';
  const each = LIGHTS.map((l) => {
    const s = lights[l.id];
    return `${l.name.toLowerCase()} ${!s.on ? 'off' : l.dimmable && s.level < 100 ? `at ${s.level}%` : 'on'}`;
  });
  S.desc.textContent = `The kitchen at ${fmt(m)}, ${outside}. ${cap(each.join(', '))}.`;
}

/* ── Lights ────────────────────────────────────────────── */

const cards = {};
function buildCards() {
  const list = $('#lightList');
  for (const l of LIGHTS) {
    const card = document.createElement('div');
    card.className = 'light';
    card.innerHTML = `
      <div class="light-head">
        <span class="bulb" aria-hidden="true"></span>
        <div class="light-text"><div class="light-name"></div><div class="muted small"><span class="detail"></span> · <span class="state"></span></div></div>
        <button type="button" class="switch" role="switch" aria-checked="false"></button>
      </div>
      ${l.dimmable
        ? `<div class="level-row"><input type="range" min="5" max="100" step="5"><output></output></div>`
        : `<div class="no-dim">On or off, no dimming</div>`}`;
    card.querySelector('.light-name').textContent = l.name;
    card.querySelector('.detail').textContent = l.detail;
    const sw = card.querySelector('.switch');
    sw.setAttribute('aria-label', l.name);
    sw.addEventListener('click', () => toggle(l.id));
    const range = card.querySelector('input[type="range"]');
    if (range) {
      range.setAttribute('aria-label', `${l.name} brightness`);
      range.addEventListener('input', () => {
        lights = applyChanges(lights, { [l.id]: { on: true, level: +range.value } });
        renderLights();
      });
      range.addEventListener('change', () => log('you', `${l.name} ${range.value}%`));
    }
    list.appendChild(card);
    cards[l.id] = { card, sw, range, out: card.querySelector('output'), state: card.querySelector('.state') };
  }

  const scenes = $('#sceneButtons');
  for (const [id, label] of Object.entries(SCENE_LABELS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill';
    b.textContent = label;
    b.addEventListener('click', () => setLights(applyChanges(lights, SCENES[id]), 'you', `Ran ${label}`));
    scenes.appendChild(b);
  }
}

function renderLights() {
  for (const l of LIGHTS) {
    const s = lights[l.id], I = intensity(l);
    for (const el of FX[l.id]) el.style.opacity = I.toFixed(3);
    const c = cards[l.id];
    c.card.classList.toggle('on', s.on);
    c.sw.setAttribute('aria-checked', String(s.on));
    c.state.textContent = !s.on ? 'Off' : l.dimmable ? `On, ${s.level}%` : 'On';
    if (c.range) {
      if (document.activeElement !== c.range) c.range.value = s.level;
      c.out.textContent = `${s.level}%`;
    }
  }
  renderEnergy();
  describeScene();
}

function setLights(next, source, text) {
  lights = next;
  renderLights();
  if (text) log(source, text);
}

function toggle(id) {
  const l = lightById(id);
  const on = !lights[id].on;
  if (id === 'counter') cancelTimer(motionTimer);
  setLights(applyChanges(lights, { [id]: { on } }), 'you', `${l.name} ${on ? 'on' : 'off'}`);
}

/** "Ceiling 35%, under-cabinet on, pendants 70%", or "All lights off". */
function describe(changes) {
  if (LIGHTS.every((l) => changes[l.id]?.on === false)) return 'all lights off';
  return LIGHTS.filter((l) => changes[l.id]).map((l) => {
    const c = changes[l.id];
    if (c.on === false) return `${SHORT[l.id]} off`;
    if (l.dimmable && c.level != null && c.level < 100) return `${SHORT[l.id]} ${c.level}%`;
    return `${SHORT[l.id]} on`;
  }).join(', ');
}

/* ── Clock and events ──────────────────────────────────── */

function addTimer(timer) {
  const tm = { id: timerSeq++, ...timer };
  timers.push(tm);
  renderTimers();
  renderMarks();
  return tm;
}

function cancelTimer(tm) {
  if (!tm) return;
  timers = timers.filter((x) => x !== tm);
  if (tm === motionTimer) motionTimer = null;
  renderTimers();
  renderMarks();
}

/** Moves the clock on by `dMin` minutes, doing whatever falls due on the way, in order. */
function advance(dMin) {
  const from = t, to = t + dMin;
  const due = [];
  for (let day = Math.floor(from / 1440); day <= Math.floor(to / 1440); day++) {
    for (const s of schedules) {
      if (!s.enabled) continue;
      const at = day * 1440 + scheduleMinute(s);
      if (at > from && at <= to) due.push({ at, schedule: s });
    }
  }
  for (const tm of timers) if (tm.at > from && tm.at <= to) due.push({ at: tm.at, timer: tm });
  due.sort((a, b) => a.at - b.at);

  let cur = from;
  for (const e of due) {
    integrate(cur, e.at);
    cur = t = e.at;
    if (e.schedule) {
      const changes = scheduleChanges(e.schedule);
      setLights(applyChanges(lights, changes), 'schedule', `${e.schedule.label}: ${describe(changes)}`);
    } else {
      cancelTimer(e.timer);
      setLights(applyChanges(lights, e.timer.changes), e.timer.source, e.timer.label);
    }
  }
  integrate(cur, to);
  t = to;
}

/** Adds the energy used from a to b, starting a new day's count at midnight. */
function integrate(a, b) {
  let x = a;
  while (x < b) {
    const midnight = (Math.floor(x / 1440) + 1) * 1440;
    const end = Math.min(b, midnight);
    wh += (watts(lights) * (end - x)) / 60;
    if (end === midnight) wh = 0;
    x = end;
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (playing && !dragging) advance((dt * speed) / 60);
  renderTime();
  requestAnimationFrame(frame);
}

function setPlaying(p) {
  playing = p;
  const b = $('#play');
  b.classList.toggle('paused', !p);
  b.setAttribute('aria-label', p ? 'Pause the clock' : 'Run the clock');
}

function setSpeed(v) {
  speed = v;
  for (const b of document.querySelectorAll('#speeds button')) b.setAttribute('aria-checked', String(+b.dataset.speed === v));
}

let lastJump = null;
function jumpTo(minute) {
  const day = Math.floor(t / 1440);
  t = day * 1440 + minute;
  ({ lights, wh } = replayTo(minute, schedules));
  timers = [];
  motionTimer = null;
  pending = null;
  renderLights();
  renderTimers();
  renderMarks();
  renderTime();
}

/* ── Motion ────────────────────────────────────────────── */

let personTimeout;
function motion() {
  S.person.style.opacity = '1';
  S.led.style.opacity = '1';
  clearTimeout(personTimeout);
  personTimeout = setTimeout(() => { S.person.style.opacity = '0'; S.led.style.opacity = '0'; }, 1800);

  if (motionTimer) {
    motionTimer.at = t + MOTION_MINUTES;
    renderTimers();
    renderMarks();
    log('motion', `Still someone there: under-cabinet stays on ${MOTION_MINUTES} more minutes`);
    return;
  }
  if (!motionTurnsOn(lights, t)) {
    log('motion', daylight(t) >= 0.35 ? 'Someone came in. It’s light out, so the lights stay off' : 'Someone came in. The lights are already on');
    return;
  }
  setLights(applyChanges(lights, { counter: { on: true } }), 'motion', `Someone came in: under-cabinet on for ${MOTION_MINUTES} minutes`);
  motionTimer = addTimer({
    at: t + MOTION_MINUTES, changes: { counter: { on: false } }, source: 'motion',
    label: `No motion for ${MOTION_MINUTES} minutes: under-cabinet off`, what: 'Under-cabinet off (motion)',
  });
}

/* ── Activity and toast ────────────────────────────────── */

function srcTag(source) {
  const s = document.createElement('span');
  s.className = `src src-${source}`;
  s.textContent = SOURCE_LABELS[source];
  return s;
}

let toastTimeout;
function log(source, text, { replaceRecent = false } = {}) {
  // Arrow keys on the time slider jump a minute at a time: one line for a run of jumps.
  const entry = { t, source, text, at: Date.now(), replaceable: replaceRecent };
  const replace = replaceRecent && activity[0]?.replaceable && entry.at - activity[0].at < 2500;
  if (replace) activity[0] = entry;
  else activity.unshift(entry);
  activity.length = Math.min(activity.length, 100);
  if (activeTab !== 'activity' && !replace) unread = Math.min(99, unread + 1);
  renderActivity();

  const toast = $('#toast');
  toast.replaceChildren(srcTag(source), document.createTextNode(text));
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2800);
}

function renderActivity() {
  const badge = $('#unread');
  badge.hidden = unread === 0;
  badge.textContent = unread;
  if (activeTab !== 'activity') return;
  $('#activity').replaceChildren(...activity.map((a) => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = fmt(minuteOfDay(a.t));
    const text = document.createElement('span');
    text.textContent = cap(a.text);
    li.append(time, srcTag(a.source), text);
    return li;
  }));
}

/* ── Schedules and timers ──────────────────────────────── */

const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function renderSchedules() {
  $('#schedList').replaceChildren(...schedules.map((s) => {
    const li = document.createElement('li');
    li.className = `sched${s.enabled ? '' : ' off'}`;
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'switch sm';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(s.enabled));
    sw.setAttribute('aria-label', `${s.label} schedule`);
    sw.addEventListener('click', () => {
      s.enabled = !s.enabled;
      renderSchedules();
      renderMarks();
    });
    const text = document.createElement('div');
    text.className = 'sched-text';
    const name = document.createElement('div');
    name.className = 'sched-name';
    name.textContent = s.label;
    const what = document.createElement('div');
    what.className = 'sched-what';
    what.textContent = cap(s.scene ? `${SCENE_LABELS[s.scene]} scene: ${describe(SCENES[s.scene])}` : describe(s.changes));
    text.append(name, what);

    let when;
    if (typeof s.at === 'number') {
      when = document.createElement('input');
      when.type = 'time';
      when.value = toHHMM(s.at);
      when.setAttribute('aria-label', `${s.label} time`);
      when.addEventListener('change', () => {
        const [h, m] = when.value.split(':').map(Number);
        if (Number.isFinite(h) && Number.isFinite(m)) { s.at = h * 60 + m; renderMarks(); }
      });
    } else {
      when = document.createElement('div');
      when.className = 'sun-time';
      const sun = s.at.sun === 'sunrise' ? 'sunrise' : 'sunset';
      when.textContent = `${s.at.offset ? `${s.at.offset} min after ${sun}` : cap(sun)} · ${fmt(scheduleMinute(s))}`;
    }
    li.append(sw, text, when);
    return li;
  }));
}

function renderTimers() {
  const list = $('#timerList');
  if (!timers.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None. Try “turn off the lights in 15 minutes” or “dinner at 7 pm” in Chat.';
    list.replaceChildren(li);
    return;
  }
  const today = Math.floor(t / 1440);
  list.replaceChildren(...[...timers].sort((a, b) => a.at - b.at).map((tm) => {
    const li = document.createElement('li');
    li.className = 'sched';
    li.style.gridTemplateColumns = '1fr auto';
    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'sched-name';
    name.textContent = `${fmt(minuteOfDay(tm.at))}${Math.floor(tm.at / 1440) > today ? ' tomorrow' : ''}`;
    const what = document.createElement('div');
    what.className = 'sched-what';
    what.textContent = tm.what;
    text.append(name, what);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'x-btn';
    x.textContent = 'Cancel';
    x.setAttribute('aria-label', `Cancel: ${tm.what} at ${fmt(minuteOfDay(tm.at))}`);
    x.addEventListener('click', () => { cancelTimer(tm); log('you', `Cancelled: ${tm.what}`); });
    li.append(text, x);
    return li;
  }));
}

function renderMarks() {
  const pct = (m) => `${((m / 1440) * 100).toFixed(2)}%`;
  const today = Math.floor(t / 1440);
  const marks = [
    ...[SUNRISE, SUNSET].map((m) => ({ m, cls: 'sun', title: m === SUNRISE ? 'Sunrise' : 'Sunset' })),
    ...schedules.map((s) => ({ m: scheduleMinute(s), cls: s.enabled ? '' : 'off', title: s.label })),
    ...timers.filter((tm) => Math.floor(tm.at / 1440) === today).map((tm) => ({ m: minuteOfDay(tm.at), cls: 'timer', title: tm.what })),
  ];
  $('#marks').replaceChildren(...marks.map(({ m, cls, title }) => {
    const d = document.createElement('span');
    d.className = `mark ${cls}`;
    d.style.left = pct(m);
    d.title = `${title}, ${fmt(m)}`;
    return d;
  }));
}

function paintTrack() {
  const stops = [];
  for (let m = 0; m <= 1440; m += 15) {
    const d = daylight(m);
    const dusk = 1 - Math.abs(2 * d - 1);
    stops.push(`${mix(mix('#16203a', '#5d84bd', d), '#c9774f', 0.55 * dusk)} ${((m / 1440) * 100).toFixed(2)}%`);
  }
  $('#track').style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
}

/* ── Chat ──────────────────────────────────────────────── */

function addMsg(who, text, lang) {
  const li = document.createElement('li');
  li.className = `msg ${who}`;
  li.lang = HTML_LANG[lang] || 'en';
  li.textContent = text;
  const when = document.createElement('span');
  when.className = 'when';
  when.lang = 'en';
  when.textContent = fmt(minuteOfDay(t));
  li.appendChild(when);
  const list = $('#messages');
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
}

function send(raw) {
  const text = raw.trim();
  if (!text) return;
  const r = parseCommand(text);
  addMsg('me', text, r.lang);
  const p = plan(r, lights, t, pending);
  pending = p.pending ?? null;

  if (p.now) {
    if (r.targets.includes('counter') || r.targets.length === 0) cancelTimer(motionTimer);
    setLights(applyChanges(lights, p.now), 'chat', `“${text}”: ${p.scene ? `ran ${SCENE_LABELS[p.scene]}` : describe(p.now)}`);
  }
  for (const l of p.later ?? []) {
    const what = l.scene ? `Run ${SCENE_LABELS[l.scene]}` : cap(describe(l.changes));
    addTimer({
      at: l.at, changes: l.changes, source: 'timer', what: l.restore ? `${what} (timer ends)` : `${what} (asked in chat)`,
      label: l.restore ? `Timer ended: ${describe(l.changes)}` : `As asked in chat: ${l.scene ? `ran ${SCENE_LABELS[l.scene]}` : describe(l.changes)}`,
    });
    if (!l.restore) log('chat', `“${text}”: will ${l.scene ? `run ${SCENE_LABELS[l.scene]}` : describe(l.changes)} at ${fmt(minuteOfDay(l.at))}`);
  }
  const reply = replyText(r.lang, p.reply);
  setTimeout(() => addMsg('hub', reply, r.lang), reduceMotion ? 0 : 300);
}

function buildChat() {
  addMsg('hub', 'Hi, I’m HomeHub. Tell me what to do with the kitchen lights, in English, 廣東話, 普通话 or Tiếng Việt. You can add a time too: “for 10 minutes”, “in 15 minutes” or “at 7 pm”.', 'en');
  const box = $('#suggest');
  for (const [lang, text] of SUGGESTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.lang = HTML_LANG[lang];
    b.textContent = text;
    b.addEventListener('click', () => send(text));
    box.appendChild(b);
  }
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#say');
    send(input.value);
    input.value = '';
  });
}

/* ── Tabs ──────────────────────────────────────────────── */

let activeTab = 'chat';
function selectTab(name, focus = false) {
  activeTab = name;
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const on = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
    $(`#${tab.getAttribute('aria-controls')}`).hidden = !on;
  }
  if (name === 'activity') unread = 0;
  renderActivity();
}

function buildTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab.id.slice(4)));
    tab.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      selectTab(tabs[(i + step + tabs.length) % tabs.length].id.slice(4), true);
    });
  });
}

/* ── Start ─────────────────────────────────────────────── */

buildCards();
buildChat();
buildTabs();
renderSchedules();
renderTimers();
paintTrack();
renderMarks();
renderLights();
setPlaying(playing);
setSpeed(speed);

$('#play').addEventListener('click', () => setPlaying(!playing));
for (const b of document.querySelectorAll('#speeds button')) b.addEventListener('click', () => setSpeed(+b.dataset.speed));
$('#motionBtn').addEventListener('click', motion);
const scrub = $('#scrub');
scrub.addEventListener('input', () => { dragging = true; jumpTo(+scrub.value); });
scrub.addEventListener('change', () => {
  dragging = false;
  log('you', `Jumped to ${fmt(+scrub.value)}. The lights are as the schedules would leave them`, { replaceRecent: true });
});
// Let go outside the slider (touch) still ends the drag.
for (const ev of ['pointerup', 'pointercancel', 'blur']) scrub.addEventListener(ev, () => { dragging = false; });

log('schedule', `It’s ${fmt(START)}. The lights are as the schedules left them`);
requestAnimationFrame(frame);
