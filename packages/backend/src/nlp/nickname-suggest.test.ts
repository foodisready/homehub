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
];
const owners = learnOwners(HOME);
const texts = (id: number, langs: Array<'vi' | 'yue'> = ['vi', 'yue']) =>
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

  it('calls a garage opener a garage door, and skips cameras and unknown words', () => {
    assert.deepEqual(texts(7), ['cửa ga-ra bên trái', 'cửa nhà xe bên trái', '左邊車房門', 'cửa ga-ra', 'cửa nhà xe', '車房門']);
    assert.deepEqual(texts(8), []);
    assert.deepEqual(texts(9), []);
  });
});
