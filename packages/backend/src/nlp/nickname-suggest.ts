/**
 * Vietnamese and Cantonese nicknames to suggest for a device, made from its
 * English names: "Kitchen lights" → đèn bếp, đèn nhà bếp, 廚房燈.
 *
 * Built from a list of household words rather than by an AI model: the small
 * models a Pi runs write Mandarin (客厅灯) for Cantonese (客廳燈), and a wrong
 * nickname switches the wrong light. A name with a word not on the list gets
 * no suggestion. People's names stay as they are in Vietnamese ("đèn phòng
 * Ethan"); in Cantonese they're learnt from nicknames already given (卓希房燈
 * on "Brenden's room lights" makes Brenden 卓希), or left for the person to
 * fill in.
 *
 * Suggestions are only offered: a person adds the ones they want.
 */

export type SuggestLanguage = 'vi' | 'yue';

export interface NicknameSuggestion {
  text: string;
  lang: SuggestLanguage;
  /** The English name it was made from. */
  from: string;
  /** For Cantonese with a person's name unknown: `text` is the rest (房燈), to be typed after their Chinese name. */
  needsName?: string;
}

export interface SuggestDevice {
  id: number;
  alias: string;
  nicknames: string[];
  room?: string | null;
  driverType?: string | null;
}

type Kind = 'place' | 'thing' | 'pos';
interface Word { en: string[]; kind: Kind; vi: string[]; yue: string }

// Longest phrases are matched first, so "garage door" wins over "garage" and "door".
const WORDS: Word[] = [
  // Places
  { en: ['kitchen'], kind: 'place', vi: ['bếp', 'nhà bếp'], yue: '廚房' },
  { en: ['living room', 'lounge', 'family room'], kind: 'place', vi: ['phòng khách'], yue: '客廳' },
  { en: ['dining room', 'dining'], kind: 'place', vi: ['phòng ăn'], yue: '飯廳' },
  { en: ['master bedroom', 'main bedroom'], kind: 'place', vi: ['phòng ngủ lớn'], yue: '主人房' },
  { en: ['guest room', 'guest bedroom'], kind: 'place', vi: ['phòng ngủ khách'], yue: '客房' },
  { en: ['bedroom'], kind: 'place', vi: ['phòng ngủ'], yue: '睡房' },
  { en: ['office', 'study'], kind: 'place', vi: ['phòng làm việc', 'văn phòng'], yue: '書房' },
  { en: ['bathroom', 'restroom', 'toilet'], kind: 'place', vi: ['phòng tắm'], yue: '浴室' },
  { en: ['hallway', 'hall', 'corridor'], kind: 'place', vi: ['hành lang'], yue: '走廊' },
  { en: ['laundry room', 'laundry'], kind: 'place', vi: ['phòng giặt'], yue: '洗衣房' },
  { en: ['basement'], kind: 'place', vi: ['tầng hầm'], yue: '地庫' },
  { en: ['attic'], kind: 'place', vi: ['gác mái'], yue: '閣樓' },
  { en: ['stairs', 'staircase', 'stairway'], kind: 'place', vi: ['cầu thang'], yue: '樓梯' },
  { en: ['entryway', 'entry', 'foyer', 'entrance'], kind: 'place', vi: ['lối vào'], yue: '玄關' },
  { en: ['balcony'], kind: 'place', vi: ['ban công'], yue: '露台' },
  { en: ['patio', 'porch', 'deck'], kind: 'place', vi: ['hiên nhà'], yue: '門口' },
  { en: ['backyard', 'back yard'], kind: 'place', vi: ['sân sau'], yue: '後院' },
  { en: ['front yard'], kind: 'place', vi: ['sân trước'], yue: '前院' },
  { en: ['garden', 'yard'], kind: 'place', vi: ['sân vườn'], yue: '花園' },
  { en: ['outdoor', 'outside'], kind: 'place', vi: ['ngoài trời'], yue: '室外' },
  { en: ['garage'], kind: 'place', vi: ['ga-ra', 'nhà xe'], yue: '車房' },
  { en: ['upstairs'], kind: 'place', vi: ['trên lầu'], yue: '樓上' },
  { en: ['downstairs'], kind: 'place', vi: ['dưới lầu'], yue: '樓下' },
  // Things
  { en: ['garage door', 'garage doors'], kind: 'thing', vi: ['cửa ga-ra', 'cửa nhà xe'], yue: '車房門' },
  { en: ['front door'], kind: 'thing', vi: ['cửa trước'], yue: '前門' },
  { en: ['back door'], kind: 'thing', vi: ['cửa sau'], yue: '後門' },
  { en: ['door', 'doors'], kind: 'thing', vi: ['cửa'], yue: '門' },
  { en: ['bedside lamp', 'bedside lamps', 'bedside light', 'bedside lights', 'nightstand lamp', 'night light', 'nightlight'], kind: 'thing', vi: ['đèn ngủ'], yue: '床頭燈' },
  { en: ['desk lamp', 'desk light', 'table lamp'], kind: 'thing', vi: ['đèn bàn'], yue: '枱燈' },
  { en: ['floor lamp'], kind: 'thing', vi: ['đèn cây'], yue: '座地燈' },
  { en: ['ceiling light', 'ceiling lights', 'ceiling lamp'], kind: 'thing', vi: ['đèn trần'], yue: '天花燈' },
  { en: ['christmas lights', 'christmas tree', 'xmas lights', 'xmas tree'], kind: 'thing', vi: ['đèn Giáng Sinh'], yue: '聖誕燈' },
  { en: ['lamp', 'lamps', 'light', 'lights', 'lighting', 'bulb', 'bulbs', 'light strip', 'strip', 'chandelier'], kind: 'thing', vi: ['đèn'], yue: '燈' },
  { en: ['air purifier', 'purifier'], kind: 'thing', vi: ['máy lọc không khí'], yue: '空氣清新機' },
  { en: ['dehumidifier'], kind: 'thing', vi: ['máy hút ẩm'], yue: '抽濕機' },
  { en: ['humidifier'], kind: 'thing', vi: ['máy tạo ẩm'], yue: '加濕機' },
  { en: ['heater', 'space heater'], kind: 'thing', vi: ['máy sưởi'], yue: '暖爐' },
  { en: ['fan', 'fans'], kind: 'thing', vi: ['quạt'], yue: '風扇' },
  { en: ['tv', 'television'], kind: 'thing', vi: ['tivi'], yue: '電視' },
  { en: ['coffee maker', 'coffee machine'], kind: 'thing', vi: ['máy pha cà phê'], yue: '咖啡機' },
  { en: ['kettle'], kind: 'thing', vi: ['ấm đun nước'], yue: '水煲' },
  // Where in the place
  { en: ['left'], kind: 'pos', vi: ['bên trái'], yue: '左邊' },
  { en: ['right'], kind: 'pos', vi: ['bên phải'], yue: '右邊' },
];

const PHRASES = WORDS.flatMap((w) => w.en.map((en) => ({ en: en.split(' '), w })))
  .sort((a, b) => b.en.length - a.en.length);
// Said or left out without changing the name.
const FILLER = new Set(['the', 'my', 'our', 'a', 'main', 'big', 'small', 'smart', 'plug', 'switch', 'outlet', 'socket']);

interface Reading { owner?: string; ownerRoom: boolean; place?: Word; thing?: Word; pos?: Word }

/** An English name read into its parts, or null when it has a word not on the list. */
export function readName(name: string): Reading | null {
  let text = name.trim().toLowerCase().replace(/[’]/g, "'");
  if (!/^[a-z0-9' -]+$/.test(text)) return null;   // not English
  const r: Reading = { ownerRoom: false };
  const owner = /^([a-z][a-z-]*)'s?\s+(.+)$/.exec(text);
  if (owner) {
    r.owner = name.trim().slice(0, owner[1].length);   // as written: "Brenden"
    text = owner[2];
  }
  const ws = text.split(/[\s-]+/).filter(Boolean);
  for (let i = 0; i < ws.length;) {
    if (r.owner && ws[i] === 'room' && !r.place) { r.ownerRoom = true; i++; continue; }
    if (FILLER.has(ws[i])) { i++; continue; }
    const hit = PHRASES.find((p) => p.en.every((w, j) => ws[i + j] === w));
    if (!hit) return null;
    const slot = hit.w.kind;
    if (r[slot]) return null;   // two places or two things: too unclear to guess
    r[slot] = hit.w;
    i += hit.en.length;
  }
  return r;
}

const GARAGE = WORDS.find((w) => w.en[0] === 'garage door')!;

/** Owners' Chinese names, from Cantonese nicknames already given: "Brenden's room lights" with 卓希房燈 → brenden: 卓希. */
export function learnOwners(devices: SuggestDevice[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const d of devices) {
    const english = [d.alias, ...d.nicknames].map(readName).filter((r): r is Reading => !!r?.owner);
    const chinese = d.nicknames.filter((n) => /\p{Script=Han}/u.test(n));
    for (const r of english) {
      const tail = (r.ownerRoom ? '房' : '') + (r.place?.yue ?? '') + (r.thing?.yue ?? '');
      if (!tail) continue;
      for (const n of chinese) {
        if (n.endsWith(tail) && n.length > tail.length) owners.set(r.owner!.toLowerCase(), n.slice(0, -tail.length));
      }
    }
  }
  return owners;
}

const key = (s: string) => s.normalize('NFC').toLowerCase().replace(/[\s-]+/g, ' ').trim();

/** Suggestions for one device, in the languages asked for, leaving out names it already has. */
export function suggestNicknames(device: SuggestDevice, languages: SuggestLanguage[], owners = new Map<string, string>()): NicknameSuggestion[] {
  if (device.driverType === 'wyze' || !languages.length) return [];
  const english = [...new Set([device.alias, ...device.nicknames])].filter((n) => /^[\x20-\x7e’]+$/.test(n));
  const have = new Set(device.nicknames.concat(device.alias).map(key));
  const out: NicknameSuggestion[] = [];
  const add = (s: NicknameSuggestion) => {
    const k = key(s.needsName ? `?${s.text}` : s.text);
    if (have.has(k) || out.some((o) => key(o.needsName ? `?${o.text}` : o.text) === k)) return;
    out.push(s);
  };

  for (const name of english) {
    const r = readName(name);
    if (!r) continue;
    // "Garage Left", on a garage door opener: a door.
    if (!r.thing && device.driverType === 'meross') r.thing = GARAGE;
    if (r.thing === GARAGE && r.place?.en[0] === 'garage') r.place = undefined;
    // From the room when the name has none: "Desk lamp" in the Office.
    if (r.thing && !r.place && !r.owner && device.room) {
      const room = readName(device.room);
      if (room && !room.thing && !room.pos) { r.place = room.place; r.owner = room.owner; r.ownerRoom = room.ownerRoom; }
    }
    if (!r.thing) continue;   // a place alone ("Kitchen") says nothing about what it is

    if (languages.includes('vi')) {
      for (const thing of r.thing.vi) {
        for (const place of r.place?.vi ?? ['']) {
          let text = [thing, place, r.pos?.vi[0] ?? ''].filter(Boolean).join(' ');
          if (r.owner) text += r.place || !r.ownerRoom && r.thing.vi[0] !== 'đèn' ? ` ${r.owner}` : ` phòng ${r.owner}`;
          add({ text, lang: 'vi', from: name });
        }
      }
    }
    if (languages.includes('yue')) {
      const rest = (r.pos?.yue ?? '') + (r.ownerRoom ? '房' : '') + (r.place?.yue ?? '') + r.thing.yue;
      if (!r.owner) add({ text: rest, lang: 'yue', from: name });
      else {
        const chinese = owners.get(r.owner.toLowerCase());
        if (chinese) add({ text: chinese + rest, lang: 'yue', from: name });
        // Unless it already has one, in Chinese, ending the same way.
        else if (!device.nicknames.some((n) => n.endsWith(rest) && n.length > rest.length)) {
          add({ text: rest, lang: 'yue', from: name, needsName: r.owner });
        }
      }
    }
  }
  return out;
}
