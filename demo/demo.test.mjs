// Run with: node --test demo/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, replyText, detectLanguage, cnNumber, viNumber, clock } from './commands.js';
import { plan, allOff, applyChanges, replayTo, resolveAt, SCHEDULES, daylight, SUNSET, watts, motionTurnsOn } from './home.js';

const pick = (r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length)));
const H = (h, m = 0) => h * 60 + m;

/** Says `text` to a kitchen at `now` and returns HomeHub's reply and the lights after. */
function say(text, { lights = allOff(), now = H(19), pending = null } = {}) {
  const r = parseCommand(text);
  const p = plan(r, lights, now, pending);
  return { r, p, reply: replyText(r.lang, p.reply), lights: p.now ? applyChanges(lights, p.now) : lights };
}

test('tells the four languages apart', () => {
  assert.equal(detectLanguage('turn on the kitchen lights'), 'en');
  assert.equal(detectLanguage('bật đèn bếp'), 'vi');
  assert.equal(detectLanguage('bat den bep'), 'vi');
  assert.equal(detectLanguage('開廚房燈'), 'yue');
  assert.equal(detectLanguage('熄晒啲燈'), 'yue');
  assert.equal(detectLanguage('打开厨房灯'), 'zh');
  assert.equal(detectLanguage('把顶灯关了'), 'zh');
});

test('numbers in words', () => {
  assert.equal(cnNumber('十五'), 15);
  assert.equal(cnNumber('二十'), 20);
  assert.equal(cnNumber('三十五'), 35);
  assert.equal(cnNumber('一百'), 100);
  assert.equal(viNumber('hai mươi'), 20);
  assert.equal(viNumber('mười lăm'), 15);
  assert.equal(viNumber('bốn mươi lăm'), 45);
  assert.equal(viNumber('năm'), 5);
});

test('English commands', () => {
  assert.deepEqual(pick(parseCommand('Turn on the kitchen lights')), { kind: 'set', lang: 'en', on: true });
  assert.deepEqual(pick(parseCommand('dim the pendants to 30%')), { kind: 'set', lang: 'en', targets: ['pendants'], on: true, level: 30 });
  assert.deepEqual(pick(parseCommand('turn off the under-cabinet lights')), { kind: 'set', lang: 'en', targets: ['counter'], on: false });
  assert.deepEqual(parseCommand('ceiling lights on for 10 minutes').when, { type: 'for', minutes: 10 });
  assert.deepEqual(parseCommand('turn off the lights in half an hour').when, { type: 'in', minutes: 30 });
  assert.deepEqual(parseCommand('turn on the pendants at 7:30 pm').when, { type: 'at', h: 7, m: 30, period: 'pm' });
  assert.deepEqual(parseCommand('set the ceiling to 40').level, 40);
  assert.deepEqual(parseCommand('make the ceiling brighter').relative, 25);
  assert.equal(parseCommand('Goodnight at 11 pm').scene, 'goodnight');
  assert.equal(parseCommand('dinner').kind, 'scene');
  assert.equal(parseCommand("what's on?").kind, 'status');
  assert.equal(parseCommand('is the ceiling on?').kind, 'status');
  assert.equal(parseCommand('open the garage').kind, 'elsewhere');
  assert.equal(parseCommand('kitchen lights').kind, 'ask');
  assert.equal(parseCommand('I want pizza').kind, 'unknown');
  // A bare "to 30 minutes" is a time, not a level.
  assert.equal(parseCommand('turn on the lights for 30 minutes').level, null);
});

test('Vietnamese commands', () => {
  assert.deepEqual(pick(parseCommand('Bật đèn bếp')), { kind: 'set', lang: 'vi', on: true });
  assert.deepEqual(pick(parseCommand('tắt đèn trần')), { kind: 'set', lang: 'vi', targets: ['ceiling'], on: false });
  assert.deepEqual(pick(parseCommand('mở đèn dưới tủ')), { kind: 'set', lang: 'vi', targets: ['counter'], on: true });
  assert.deepEqual(parseCommand('bật đèn thả 10 phút').when, { type: 'for', minutes: 10 });
  assert.deepEqual(parseCommand('bật đèn thả hai mươi phút').when, { type: 'for', minutes: 20 });
  assert.deepEqual(parseCommand('tắt đèn bếp 15 phút nữa').when, { type: 'in', minutes: 15 });
  assert.deepEqual(parseCommand('ăn tối lúc 7 giờ tối').when, { type: 'at', h: 7, m: 0, period: 'pm' });
  assert.deepEqual(parseCommand('bật đèn trần lúc 6 giờ rưỡi sáng').when, { type: 'at', h: 6, m: 30, period: 'am' });
  assert.deepEqual(parseCommand('chỉnh đèn trần 30%').level, 30);
  assert.equal(parseCommand('ăn tối').scene, 'dinner');
  assert.equal(parseCommand('chúc ngủ ngon').scene, 'goodnight');
  assert.equal(parseCommand('bật đèn ngủ').scene, 'nightlight');
  assert.equal(parseCommand('đèn nào đang bật').kind, 'status');
});

test('Cantonese commands', () => {
  assert.deepEqual(pick(parseCommand('開廚房燈')), { kind: 'set', lang: 'yue', on: true });
  assert.deepEqual(pick(parseCommand('熄天花燈')), { kind: 'set', lang: 'yue', targets: ['ceiling'], on: false });
  assert.deepEqual(pick(parseCommand('閂櫃底燈')), { kind: 'set', lang: 'yue', targets: ['counter'], on: false });
  assert.deepEqual(parseCommand('開吊燈十分鐘').when, { type: 'for', minutes: 10 });
  assert.deepEqual(parseCommand('二十分鐘之後熄燈').when, { type: 'in', minutes: 20 });
  assert.deepEqual(parseCommand('夜晚七點半食飯').when, { type: 'at', h: 7, m: 30, period: 'pm' });
  assert.deepEqual(parseCommand('七點三個字開燈').when, { type: 'at', h: 7, m: 15, period: null });
  assert.equal(parseCommand('天花燈調暗啲').relative, -25);
  assert.equal(parseCommand('天花燈光一點').when, null, '光一點 is "a bit brighter", not one o\'clock');
  assert.equal(parseCommand('天花燈調到百分之三十').level, 30);
  assert.equal(parseCommand('早唞').scene, 'goodnight');
  assert.equal(parseCommand('邊啲燈開咗').kind, 'status');
});

test('Mandarin commands', () => {
  assert.deepEqual(pick(parseCommand('打开厨房灯')), { kind: 'set', lang: 'zh', on: true });
  assert.deepEqual(pick(parseCommand('把顶灯关了')), { kind: 'set', lang: 'zh', targets: ['ceiling'], on: false });
  assert.deepEqual(pick(parseCommand('打开吊灯')), { kind: 'set', lang: 'zh', targets: ['pendants'], on: true });
  assert.deepEqual(parseCommand('吊顶灯调到40%').targets, ['ceiling'], '吊顶 is the ceiling, not the pendants');
  assert.deepEqual(parseCommand('打开橱柜灯半小时').when, { type: 'for', minutes: 30 });
  assert.deepEqual(parseCommand('晚上十一点关灯').when, { type: 'at', h: 11, m: 0, period: 'pm' });
  assert.equal(parseCommand('顶灯调亮一点').when, null);
  assert.equal(parseCommand('顶灯调亮一点').relative, 25);
  assert.equal(parseCommand('晚安').scene, 'goodnight');
});

test('replies in the language spoken, saying what changed', () => {
  assert.equal(say('Turn on the kitchen lights').reply, 'Turned on the kitchen lights.');
  assert.equal(say('dim the pendants to 30%').reply, 'Set the island pendants to 30%.');
  assert.equal(say('ceiling lights on for 10 minutes').reply, 'Turned on the ceiling lights for 10 minutes.');
  assert.equal(say('turn on the pendants at 7:30 pm', { now: H(17) }).reply, "OK. I'll turn on the island pendants at 7:30 pm.");
  assert.equal(say('bật đèn bếp').reply, 'Đã bật đèn bếp.');
  assert.equal(say('bật đèn thả 10 phút').reply, 'Đã bật đèn thả trong 10 phút.');
  assert.equal(say('ăn tối lúc 7 giờ tối', { now: H(17) }).reply, 'Được, tôi sẽ chạy cảnh Ăn tối lúc 7 giờ tối.');
  assert.equal(say('開吊燈').reply, '開咗吊燈。');
  assert.equal(say('開吊燈十分鐘').reply, '開咗吊燈，10分鐘之後熄。');
  assert.equal(say('夜晚七點半食飯', { now: H(17) }).reply, '好，夜晚7點半開「食飯」。');
  assert.equal(say('关掉顶灯').reply, '已关掉顶灯。');
  assert.equal(say('晚上十一点关灯', { now: H(20) }).reply, '好的，晚上11点关掉厨房灯。');
  assert.equal(say('turn on the ceiling and the pendants').reply, 'Turned on the ceiling lights and the island pendants.');
});

test('what a command does to the lights', () => {
  const lit = say('dinner').lights;
  assert.deepEqual(lit.ceiling, { on: true, level: 35 });
  assert.deepEqual(lit.pendants, { on: true, level: 70 });
  assert.equal(lit.counter.on, true);

  // "brighter" from 35 goes to 60; "dimmer" leaves an off light off.
  assert.deepEqual(say('make the ceiling brighter', { lights: lit }).lights.ceiling, { on: true, level: 60 });
  assert.equal(say('make the lights dimmer').lights.ceiling.on, false);

  // A level on the under-cabinet lights, which don't dim, just turns them on.
  const s = say('set the under-cabinet lights to 40%');
  assert.equal(s.lights.counter.on, true);
  assert.equal(s.reply, 'Turned on the under-cabinet lights.');

  // "for 10 minutes" puts them back as they were.
  const t = say('pendants on for 10 minutes', { now: H(20) });
  assert.deepEqual(t.p.later, [{ at: H(20, 10), changes: { pendants: { on: false } }, restore: true }]);
  // Already on: still off at the end, as "on for 10 minutes" means.
  assert.deepEqual(say('pendants on for 10 minutes', { lights: lit }).p.later[0].changes, { pendants: { on: false } });
  assert.deepEqual(say('dim the ceiling to 10% for 5 minutes', { lights: lit }).p.later[0].changes, { ceiling: { on: true, level: 35 } });
});

test('"on or off?" then the answer', () => {
  const asked = say('ceiling lights');
  assert.equal(asked.reply, 'On or off?');
  const answer = say('on', { pending: asked.p.pending });
  assert.deepEqual(answer.lights.ceiling.on, true);
  assert.equal(answer.lights.pendants.on, false);
  assert.equal(answer.reply, 'Turned on the ceiling lights.');
});

test('times of day come round next', () => {
  assert.equal(resolveAt({ h: 7, m: 30, period: 'pm' }, H(17)), H(19, 30));
  assert.equal(resolveAt({ h: 7, m: 0, period: null }, H(17)), H(19), 'seven, said at five in the afternoon, is 7 pm');
  assert.equal(resolveAt({ h: 7, m: 0, period: null }, H(20)), 1440 + H(7), 'and said at eight, tomorrow morning');
  assert.equal(resolveAt({ h: 19, m: 30, period: null }, H(20)), 1440 + H(19, 30));
  assert.equal(clock('en', H(19, 30)), '7:30 pm');
  assert.equal(clock('en', 0), '12:00 am');
  assert.equal(clock('vi', H(6, 30)), '6 giờ rưỡi sáng');
  assert.equal(clock('yue', H(23)), '夜晚11點');
  assert.equal(clock('zh', H(15, 15)), '下午3点15分');
});

test('the schedules set the lights for any time of day', () => {
  const night = replayTo(H(3), SCHEDULES).lights;
  assert.deepEqual(Object.values(night).map((l) => l.on), [false, false, false], 'after Goodnight, everything is off');
  assert.equal(night.ceiling.level, 35, 'remembering its last level for next time');
  const breakfast = replayTo(H(7), SCHEDULES).lights;
  assert.deepEqual([breakfast.ceiling, breakfast.pendants.level], [{ on: true, level: 70 }, 50]);
  assert.equal(replayTo(H(12), SCHEDULES).lights.ceiling.on, false, 'daylight turns them off');
  assert.equal(replayTo(SUNSET + 1, SCHEDULES).lights.counter.on, true);
  assert.deepEqual(replayTo(H(19), SCHEDULES).lights.ceiling, { on: true, level: 35 }, 'dinner');
  const off = SCHEDULES.map((s) => (s.id === 'dinner' ? { ...s, enabled: false } : s));
  assert.equal(replayTo(H(19), off).lights.ceiling.on, false, 'a schedule turned off does nothing');
  // Breakfast: 96 W × 70% + 24 W × 50% for 45 minutes = 59.4 Wh by daylight at 7:15.
  assert.ok(Math.abs(replayTo(H(7, 15), SCHEDULES).wh - 59.4) < 0.01);
});

test('the sun', () => {
  assert.equal(daylight(H(2)), 0);
  assert.equal(daylight(H(12)), 1);
  assert.ok(daylight(SUNSET) > 0.3 && daylight(SUNSET) < 0.7, 'twilight at sunset');
  assert.equal(daylight(1440 + H(12)), 1, 'tomorrow too');
});

test('energy and motion', () => {
  assert.equal(watts(allOff()), 0);
  const cooking = say('cooking').lights;
  assert.equal(watts(cooking), 96 + 27 + 24);
  assert.equal(motionTurnsOn(allOff(), H(2)), true, 'a dark, empty kitchen');
  assert.equal(motionTurnsOn(allOff(), H(13)), false, 'daylight');
  assert.equal(motionTurnsOn(cooking, H(2)), false, 'already lit');
});
