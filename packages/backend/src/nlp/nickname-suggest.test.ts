import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { learnOwners, readName, suggestNicknames, type SuggestDevice } from './nickname-suggest';

const HOME: SuggestDevice[] = [
  { id: 1, alias: "Brenden's left bedside lamp", nicknames: ["Brenden's room lights", '卓希房燈', '着氣燈'] },
  { id: 2, alias: 'My office lamp', nicknames: ['寫字樓燈', '文房燈', 'đèn văn phòng'] },
  { id: 3, alias: 'Kitchen lights', nicknames: ['廚房燈'] },
  { id: 4, alias: "Ethan's bedside lamp", nicknames: ["Ethan's room lights"] },
  { id: 5, alias: 'Living room statue', nicknames: ['living room lights', '客廳燈'] },
  { id: 6, alias: 'hallway lamp', nicknames: ['走廊燈'] },
  { id: 7, alias: 'Garage Left', nicknames: ['Garage doors'], driverType: 'meross' },
  { id: 8, alias: 'Woman statue', nicknames: [] },
  { id: 9, alias: 'Front Door', nicknames: [], driverType: 'wyze' },
  { id: 10, alias: 'Desk lamp', nicknames: [], room: 'Office' },
  { id: 11, alias: 'Little breakfast lamp', nicknames: [], room: 'Breakfast area' },
  { id: 12, alias: 'office corner lamp', nicknames: [] },
  { id: 13, alias: 'Kitchen counter lights', nicknames: ['counter lights', 'countertop lights'] },
  { id: 14, alias: 'Media long lamp', nicknames: [] },
  { id: 15, alias: 'Kitchen Island camera', nicknames: [], driverType: 'wyze' },
];
const owners = learnOwners(HOME);
const texts = (id: number, langs: Array<'vi' | 'yue' | 'zh'> = ['vi', 'yue']) =>
  suggestNicknames(HOME.find((d) => d.id === id)!, langs, owners).map((s) => (s.needsName ? `${s.needsName}?${s.text}` : s.text));

describe('nickname suggestions', () => {
  it('reads an English name into its parts, and gives up on unknown words', () => {
    const r = readName("Brenden's left bedside lamp")!;
    assert.equal(r.owner, 'Brenden');
    assert.deepEqual([r.pos?.yue, r.thing?.yue], ['左邊', '床頭燈']);
    assert.equal(readName('Woman statue'), null);
    assert.equal(readName('廚房燈'), null);
  });

  it('suggests the names missing in each language', () => {
    assert.deepEqual(texts(3), ['đèn bếp', 'đèn nhà bếp']);         // 廚房燈 is already there
    assert.deepEqual(texts(6), ['đèn hành lang']);
    assert.deepEqual(texts(5), ['đèn phòng khách']);
    assert.deepEqual(texts(2), ['đèn phòng làm việc', '書房燈']);
    assert.deepEqual(texts(10), ['đèn bàn phòng làm việc', 'đèn bàn văn phòng', '書房枱燈']);
  });

  it('knows counters, breakfast areas and media rooms, and corner, little and long lamps', () => {
    assert.deepEqual(texts(11), ['đèn nhỏ góc ăn sáng', '早餐區細燈']);
    assert.deepEqual(texts(12), ['đèn góc phòng làm việc', 'đèn góc văn phòng', '書房角落燈']);
    assert.deepEqual(texts(13), ['đèn quầy bếp', '廚房枱面燈', '枱面燈']);
    assert.deepEqual(texts(14), ['đèn dài phòng giải trí', '影音室長燈']);
    assert.deepEqual(texts(15), []);
  });

  it('only in the languages asked for', () => {
    assert.deepEqual(texts(3, ['yue']), []);
    assert.deepEqual(texts(6, []), []);
  });

  it("learns a person's Chinese name from nicknames already given", () => {
    assert.equal(owners.get('brenden'), '卓希');
    assert.deepEqual(texts(1), ['đèn ngủ bên trái Brenden', '卓希左邊床頭燈', 'đèn phòng Brenden']);
  });

  it("leaves a person's Chinese name to be typed when it isn't known", () => {
    assert.deepEqual(texts(4), ['đèn ngủ Ethan', 'Ethan?床頭燈', 'đèn phòng Ethan', 'Ethan?房燈']);
  });

  it('suggests Mandarin in simplified characters, unless the Cantonese name is the same words', () => {
    // 厨房灯 is 廚房燈 in the other script: voice hears it either way.
    assert.deepEqual(texts(3, ['zh']), []);
    assert.deepEqual(texts(2, ['zh']), ['书房灯']);
    assert.deepEqual(texts(2, ['yue', 'zh']), ['書房燈'], 'one of the two is enough');
    assert.deepEqual(texts(10, ['zh']), ['书房台灯']);
    assert.deepEqual(texts(7, ['zh']), ['左边车库门', '车库门']);
    assert.deepEqual(texts(7, ['yue', 'zh']), ['左邊車房門', '左边车库门', '車房門', '车库门'], 'different words: both');
    assert.deepEqual(texts(1, ['zh']), ['卓希左边床头灯', '卓希房间灯']);
    assert.deepEqual(texts(4, ['zh']), ['Ethan?床头灯', 'Ethan?房间灯']);
    assert.deepEqual(texts(11, ['zh']), ['早餐区小灯']);
  });

  it('calls a garage opener a garage door, and skips cameras and unknown words', () => {
    assert.deepEqual(texts(7), ['cửa ga-ra bên trái', 'cửa nhà xe bên trái', '左邊車房門', 'cửa ga-ra', 'cửa nhà xe', '車房門']);
    // In a room called Garage, still not "garage garage door".
    const inGarage = { id: 16, alias: 'Garage Left', nicknames: [], room: 'Garage', driverType: 'meross' };
    assert.deepEqual(suggestNicknames(inGarage, ['vi', 'yue', 'zh']).map((s) => s.text),
      ['cửa ga-ra bên trái', 'cửa nhà xe bên trái', '左邊車房門', '左边车库门']);
    assert.deepEqual(texts(8), []);
    assert.deepEqual(texts(9), []);
  });
});
