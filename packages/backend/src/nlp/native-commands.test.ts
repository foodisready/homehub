/**
 * On and off typed in Vietnamese, Cantonese and Mandarin, against a real SQLite DB with stubbed
 * drivers and the home's own names (from the Pi, 2026-11-15: "bật đèn bếp" went to the model,
 * which answered in Chinese that it couldn't find 厨房灯).
 *
 * Modules load dynamically in before(), after DB_PATH is set, so this stays on its temp DB.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-native-test-'));

let db: Database.Database;
let native: typeof import('./native-commands');
let nlp: typeof import('./nlp.service');
const calls: { ip: string; state: boolean }[] = [];
let failing: string | null = null;

describe('commands typed in Vietnamese and Chinese', () => {
  before(async () => {
    process.env.DB_PATH = path.join(TMP, 'db.sqlite');
    process.env.OLLAMA_URL = 'http://127.0.0.1:1';
    db = (await import('../db')).getDb();
    const { getDriver } = await import('../drivers/registry');
    native = await import('./native-commands');
    nlp = await import('./nlp.service');
    for (const kind of ['kasa', 'meross'] as const) {
      getDriver(kind).setPower = async (ip: string, state: boolean) => {
        if (ip === failing) throw new Error('unreachable');
        calls.push({ ip, state });
      };
    }
    const add = db.prepare('INSERT INTO devices (alias, ip, nicknames, driver_type, is_protected) VALUES (?, ?, ?, ?, ?)');
    add.run('Kitchen lights', '10.0.0.9', JSON.stringify(['廚房燈', 'đèn bếp', 'đèn nhà bếp']), 'kasa', 0);
    add.run('Kitchen counter lights', '10.0.0.16', JSON.stringify(['counter lights', '廚房燈', 'đèn bếp', 'đèn nhà bếp']), 'kasa', 0);
    add.run('My office lamp', '10.0.0.4', JSON.stringify(['書房燈', 'đèn phòng làm việc']), 'kasa', 0);
    add.run('Woman bedside lamp', '10.0.0.34', JSON.stringify(['亞娘床頭燈', 'đèn của bà']), 'kasa', 0);
    add.run('Main Valve', '10.0.0.15', JSON.stringify(['總掣', 'van nước']), 'kasa', 1);
    add.run('Garage Left', '10.0.0.22', JSON.stringify(['車房門', 'cửa ga-ra']), 'meross', 0);
  });
  after(() => { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });
  beforeEach(() => {
    db.prepare('UPDATE devices SET override_state = NULL, override_until = NULL, timer_off_at = NULL').run();
    calls.length = 0;
    failing = null;
  });

  describe('reading the command', () => {
    const cases: Array<[string, { lang: string; state: boolean; name: string }]> = [
      ['bật đèn bếp', { lang: 'vi', state: true, name: 'đèn bếp' }],
      ['Tắt đèn của bà đi nhé!', { lang: 'vi', state: false, name: 'đèn của bà' }],
      ['làm ơn bật giúp tôi đèn phòng làm việc', { lang: 'vi', state: true, name: 'đèn phòng làm việc' }],
      ['bat den bep', { lang: 'vi', state: true, name: 'den bep' }],
      ['mở cửa ga-ra', { lang: 'vi', state: true, name: 'cửa ga-ra' }],
      ['開廚房燈', { lang: 'yue', state: true, name: '廚房燈' }],
      ['唔該熄咗亞娘床頭燈啦', { lang: 'yue', state: false, name: '亞娘床頭燈' }],
      ['閂車房門', { lang: 'yue', state: false, name: '車房門' }],
      ['打开厨房灯', { lang: 'zh', state: true, name: '厨房灯' }],
      ['把书房灯关掉吧', { lang: 'zh', state: false, name: '书房灯' }],
      ['请关闭厨房灯。', { lang: 'zh', state: false, name: '厨房灯' }],
    ];
    for (const [text, want] of cases) {
      it(`reads "${text}"`, () => {
        const got = native.parseNativeCommand(text);
        assert.deepEqual(got && { lang: got.lang, state: got.state, name: got.name }, want);
      });
    }

    const timed: Array<[string, { name: string; minutes: number }]> = [
      ['bật đèn bếp 10 phút', { name: 'đèn bếp', minutes: 10 }],
      ['bật đèn của bà trong hai mươi phút nhé', { name: 'đèn của bà', minutes: 20 }],
      ['bật đèn bếp mười lăm phút', { name: 'đèn bếp', minutes: 15 }],
      ['bật đèn bếp một tiếng', { name: 'đèn bếp', minutes: 60 }],
      ['bật đèn bếp nửa tiếng', { name: 'đèn bếp', minutes: 30 }],
      ['開廚房燈十分鐘', { name: '廚房燈', minutes: 10 }],
      ['開書房燈半個鐘啦', { name: '書房燈', minutes: 30 }],
      ['開書房燈一個半鐘', { name: '書房燈', minutes: 90 }],
      ['开厨房灯30分钟', { name: '厨房灯', minutes: 30 }],
      ['把厨房灯打开二十分钟', { name: '厨房灯', minutes: 20 }],
      ['打开书房灯两小时', { name: '书房灯', minutes: 120 }],
    ];
    for (const [text, want] of timed) {
      it(`reads how long from "${text}"`, () => {
        const got = native.parseNativeCommand(text);
        assert.deepEqual(got && { name: got.name, minutes: got.minutes }, want);
      });
    }

    // When to do it, not for how long, and "off for a while": the chat model's, as in English.
    for (const text of ['tắt đèn bếp 10 phút nữa', 'bật đèn bếp sau 10 phút', '十分鐘後熄廚房燈', '熄廚房燈十分鐘後', 'tắt đèn bếp 10 phút', '熄廚房燈十分鐘']) {
      it(`leaves "${text}" to the chat model`, () => assert.equal(native.parseNativeCommand(text), null));
    }

    it('takes a number word in a name for the name: "đèn ba" is grandma\'s, not three', () => {
      assert.equal(native.parseNativeCommand('bật đèn ba')?.minutes, undefined);
      assert.equal(native.viNumber(['hai', 'mươi', 'lăm']), 25);
      assert.equal(native.cnNumber('三十五'), 35);
    });

    for (const text of ['turn on the kitchen lights', 'bật', '開', 'what time is it', 'mấy giờ rồi?', '幾點鐘', '今日天氣點']) {
      it(`leaves "${text}" alone`, () => assert.equal(native.parseNativeCommand(text), null));
    }

    it('finds the home’s spelling without accents or in simplified characters, but only when one name fits', () => {
      const names = ['Kitchen lights', '廚房燈', 'đèn bếp', 'Đèn Bếp', 'đèn bà', 'đèn ba'];
      assert.equal(native.homeName('den bep', names), 'đèn bếp');
      assert.equal(native.homeName('厨房灯', names), '廚房燈');
      assert.equal(native.homeName('den ba', names), 'den ba');      // two names fit: left for the rules to ask
      assert.equal(native.homeName('đèn ngủ', names), 'đèn ngủ');
    });
  });

  describe('switching, and answering in the same language', () => {
    it('turns on the kitchen lights from "bật đèn bếp", in Vietnamese', async () => {
      const r = await native.runNativeCommand('bật đèn bếp');
      assert.equal(r?.response, 'Đã bật đèn bếp.');
      assert.deepEqual(calls.map((c) => c.ip).sort(), ['10.0.0.16', '10.0.0.9']);
      assert.ok(calls.every((c) => c.state));
    });

    it('reads it typed without accents, or in simplified characters', async () => {
      assert.equal((await native.runNativeCommand('tat den cua ba'))?.response, 'Đã tắt đèn của bà.');
      assert.deepEqual(calls, [{ ip: '10.0.0.34', state: false }]);
      calls.length = 0;
      assert.equal((await native.runNativeCommand('关掉厨房灯'))?.response, '已关掉厨房灯。');
      assert.equal(calls.length, 2);
    });

    it('turns a light on for a while, and says when it turns off, in the language typed', async () => {
      assert.equal((await native.runNativeCommand('bật đèn của bà 10 phút'))?.response, 'Đã bật đèn của bà trong 10 phút.');
      assert.equal((await native.runNativeCommand('開書房燈一個半鐘'))?.response, '開咗書房燈，1個鐘30分鐘之後熄。');
      assert.equal((await native.runNativeCommand('打开书房灯二十分钟'))?.response, '已打开书房灯，20分钟后关掉。');
      const timer = db.prepare('SELECT timer_off_at FROM devices WHERE alias = ?').get('My office lamp') as { timer_off_at: string | null };
      assert.ok(timer.timer_off_at, 'a timer is set, so it turns off by itself');
    });

    it('answers Cantonese in Cantonese', async () => {
      assert.equal((await native.runNativeCommand('開書房燈啦'))?.response, '開咗書房燈。');
      assert.deepEqual(calls, [{ ip: '10.0.0.4', state: true }]);
    });

    it('closes the garage door, never opens it, and says so in the language typed', async () => {
      assert.equal((await native.runNativeCommand('đóng cửa ga-ra'))?.response, 'Đang đóng cửa ga-ra.');
      assert.equal((await native.runNativeCommand('閂車房門'))?.response, '閂緊車房門。');
      assert.deepEqual(calls, [{ ip: '10.0.0.22', state: false }, { ip: '10.0.0.22', state: false }]);
      calls.length = 0;
      assert.match((await native.runNativeCommand('mở cửa ga-ra'))!.response, /^Vì an toàn/);
      assert.match((await native.runNativeCommand('開車房門'))!.response, /^為咗安全/);
      assert.match((await native.runNativeCommand('打开车房门'))!.response, /^为了安全/);
      assert.deepEqual(calls, []);
    });

    it('leaves a protected device alone', async () => {
      assert.match((await native.runNativeCommand('tắt van nước'))!.response, /^Main Valve được bảo vệ/);
      assert.match((await native.runNativeCommand('熄總掣'))!.response, /^Main Valve受保護/);
      assert.deepEqual(calls, []);
    });

    it('says which light it couldn’t reach', async () => {
      failing = '10.0.0.16';
      assert.equal((await native.runNativeCommand('bật đèn bếp'))?.response, 'Đã bật Kitchen lights. Không kết nối được Kitchen counter lights.');
    });

    it('asks which one in the same language when a name fits several', async () => {
      const r = await native.runNativeCommand('bật đèn');
      assert.match(r!.response, /^Ý bạn là cái nào: .*"My office lamp"/);
      assert.deepEqual(calls, []);
    });

    it('leaves a name the home doesn’t have to the chat model', async () => {
      assert.equal(await native.runNativeCommand('bật quạt trần'), null);
      assert.equal(await native.runNativeCommand('開冷氣'), null);
      assert.deepEqual(calls, []);
    });

    it('is what Chat does with it, without the model', async () => {
      const r = await nlp.processMessage('bật đèn bếp', []);
      assert.equal(r.response, 'Đã bật đèn bếp.');
      assert.equal(calls.length, 2);
    });

    it('says plainly, in the language typed, when the chat model can’t be reached', async () => {
      // OLLAMA_URL points nowhere: the network's own words ("fetch failed") never reach the person.
      const said = async (text: string) => {
        for await (const e of nlp.processMessageStream(text, [])) if (e.type === 'error') return e.message;
        return null;
      };
      assert.match((await said('tell me a joke'))!, /^HomeHub’s chat model isn’t answering/);
      assert.match((await said('kể chuyện cười đi'))!, /^Mô hình trò chuyện của HomeHub/);
      assert.match((await said('講個笑話嚟聽'))!, /對話模型/);
      assert.match((await said('讲个笑话吧'))!, /对话模型/);
    });

    it('switches on a timer typed in Cantonese, without the model', async () => {
      const r = await nlp.processMessage('開書房燈十分鐘', []);
      assert.equal(r.response, '開咗書房燈，10分鐘之後熄。');
    });
  });
});

describe('durationAtEnd: a length of time said with an answer', () => {
  it('reads it in every language, and only for how long, not when', () => {
    const cases: [string, number | null][] = [
      ['系啦五十分钟。', 50], ['係啦，五十分鐘', 50], ['好呀，個半鐘', 90], ['是的，三十分钟', 30], ['係', null], ['係啦十分鐘後', null],
      ['yes', null], ['yes, for two hours', 120], ['Yes please, 30 minutes.', 30], ['sure, half an hour', 30],
      ['có, ba mươi phút', 30], ['Có ạ, một tiếng', 60], ['có', null], ['Vâng, 10 phút nữa', null],
    ];
    for (const [text, minutes] of cases) assert.equal(native.durationAtEnd(text), minutes, text);
  });
});
