/**
 * Vietnamese, Cantonese and Mandarin nicknames to suggest for a device, made
 * from its English names: "Kitchen lights" → đèn bếp, đèn nhà bếp, 廚房燈, 厨房灯.
 * Mandarin is in simplified characters. Voice matches a Chinese nickname by its
 * sound in either language, so a Mandarin one that is only a Cantonese one in
 * the other script (客厅灯, 客廳燈) isn't suggested as well.
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

export type SuggestLanguage = 'vi' | 'yue' | 'zh';

export interface NicknameSuggestion {
  text: string;
  lang: SuggestLanguage;
  /** The English name it was made from. */
  from: string;
  /** For Chinese with a person's name unknown: `text` is the rest (房燈), to be typed after their Chinese name. */
  needsName?: string;
}

export interface SuggestDevice {
  id: number;
  alias: string;
  nicknames: string[];
  room?: string | null;
  driverType?: string | null;
}

type Kind = 'place' | 'thing' | 'pos' | 'mod';
interface Word { en: string[]; kind: Kind; vi: string[]; yue: string; zh: string }

// Longest phrases are matched first, so "garage door" wins over "garage" and "door".
const WORDS: Word[] = [
  // Places
  { en: ['kitchen'], kind: 'place', vi: ['bếp', 'nhà bếp'], yue: '廚房', zh: '厨房' },
  { en: ['living room', 'lounge', 'family room'], kind: 'place', vi: ['phòng khách'], yue: '客廳', zh: '客厅' },
  { en: ['dining room', 'dining'], kind: 'place', vi: ['phòng ăn'], yue: '飯廳', zh: '餐厅' },
  { en: ['master bedroom', 'main bedroom'], kind: 'place', vi: ['phòng ngủ lớn'], yue: '主人房', zh: '主卧' },
  { en: ['guest room', 'guest bedroom'], kind: 'place', vi: ['phòng ngủ khách'], yue: '客房', zh: '客房' },
  { en: ['bedroom'], kind: 'place', vi: ['phòng ngủ'], yue: '睡房', zh: '卧室' },
  { en: ['office', 'study'], kind: 'place', vi: ['phòng làm việc', 'văn phòng'], yue: '書房', zh: '书房' },
  { en: ['bathroom', 'restroom', 'toilet'], kind: 'place', vi: ['phòng tắm'], yue: '浴室', zh: '浴室' },
  { en: ['hallway', 'hall', 'corridor'], kind: 'place', vi: ['hành lang'], yue: '走廊', zh: '走廊' },
  { en: ['laundry room', 'laundry'], kind: 'place', vi: ['phòng giặt'], yue: '洗衣房', zh: '洗衣房' },
  { en: ['basement'], kind: 'place', vi: ['tầng hầm'], yue: '地庫', zh: '地下室' },
  { en: ['attic'], kind: 'place', vi: ['gác mái'], yue: '閣樓', zh: '阁楼' },
  { en: ['stairs', 'staircase', 'stairway'], kind: 'place', vi: ['cầu thang'], yue: '樓梯', zh: '楼梯' },
  { en: ['entryway', 'entry', 'foyer', 'entrance'], kind: 'place', vi: ['lối vào'], yue: '玄關', zh: '玄关' },
  { en: ['balcony'], kind: 'place', vi: ['ban công'], yue: '露台', zh: '阳台' },
  { en: ['patio', 'porch', 'deck'], kind: 'place', vi: ['hiên nhà'], yue: '門口', zh: '门廊' },
  { en: ['backyard', 'back yard'], kind: 'place', vi: ['sân sau'], yue: '後院', zh: '后院' },
  { en: ['front yard'], kind: 'place', vi: ['sân trước'], yue: '前院', zh: '前院' },
  { en: ['garden', 'yard'], kind: 'place', vi: ['sân vườn'], yue: '花園', zh: '花园' },
  { en: ['outdoor', 'outside'], kind: 'place', vi: ['ngoài trời'], yue: '室外', zh: '室外' },
  { en: ['garage'], kind: 'place', vi: ['ga-ra', 'nhà xe'], yue: '車房', zh: '车库' },
  { en: ['kitchen counter', 'kitchen counters', 'kitchen countertop', 'kitchen counter top'], kind: 'place', vi: ['quầy bếp'], yue: '廚房枱面', zh: '厨房台面' },
  { en: ['counter', 'counters', 'countertop', 'counter top'], kind: 'place', vi: ['quầy bếp'], yue: '枱面', zh: '台面' },
  { en: ['kitchen island', 'island'], kind: 'place', vi: ['đảo bếp'], yue: '廚房中島', zh: '厨房中岛' },
  { en: ['breakfast area', 'breakfast nook', 'breakfast room', 'breakfast'], kind: 'place', vi: ['góc ăn sáng'], yue: '早餐區', zh: '早餐区' },
  { en: ['media room', 'media'], kind: 'place', vi: ['phòng giải trí'], yue: '影音室', zh: '影音室' },
  { en: ['upstairs'], kind: 'place', vi: ['trên lầu'], yue: '樓上', zh: '楼上' },
  { en: ['downstairs'], kind: 'place', vi: ['dưới lầu'], yue: '樓下', zh: '楼下' },
  // Things
  { en: ['garage door', 'garage doors'], kind: 'thing', vi: ['cửa ga-ra', 'cửa nhà xe'], yue: '車房門', zh: '车库门' },
  { en: ['front door'], kind: 'thing', vi: ['cửa trước'], yue: '前門', zh: '前门' },
  { en: ['back door'], kind: 'thing', vi: ['cửa sau'], yue: '後門', zh: '后门' },
  { en: ['door', 'doors'], kind: 'thing', vi: ['cửa'], yue: '門', zh: '门' },
  { en: ['bedside lamp', 'bedside lamps', 'bedside light', 'bedside lights', 'nightstand lamp', 'night light', 'nightlight'], kind: 'thing', vi: ['đèn ngủ'], yue: '床頭燈', zh: '床头灯' },
  { en: ['desk lamp', 'desk light', 'table lamp'], kind: 'thing', vi: ['đèn bàn'], yue: '枱燈', zh: '台灯' },
  { en: ['floor lamp'], kind: 'thing', vi: ['đèn cây'], yue: '座地燈', zh: '落地灯' },
  { en: ['ceiling light', 'ceiling lights', 'ceiling lamp'], kind: 'thing', vi: ['đèn trần'], yue: '天花燈', zh: '吸顶灯' },
  { en: ['christmas lights', 'christmas tree', 'xmas lights', 'xmas tree'], kind: 'thing', vi: ['đèn Giáng Sinh'], yue: '聖誕燈', zh: '圣诞灯' },
  { en: ['lamp', 'lamps', 'light', 'lights', 'lighting', 'bulb', 'bulbs', 'light strip', 'strip', 'chandelier'], kind: 'thing', vi: ['đèn'], yue: '燈', zh: '灯' },
  { en: ['air purifier', 'purifier'], kind: 'thing', vi: ['máy lọc không khí'], yue: '空氣清新機', zh: '空气净化器' },
  { en: ['dehumidifier'], kind: 'thing', vi: ['máy hút ẩm'], yue: '抽濕機', zh: '除湿机' },
  { en: ['humidifier'], kind: 'thing', vi: ['máy tạo ẩm'], yue: '加濕機', zh: '加湿器' },
  { en: ['heater', 'space heater'], kind: 'thing', vi: ['máy sưởi'], yue: '暖爐', zh: '取暖器' },
  { en: ['fan', 'fans'], kind: 'thing', vi: ['quạt'], yue: '風扇', zh: '风扇' },
  { en: ['tv', 'television'], kind: 'thing', vi: ['tivi'], yue: '電視', zh: '电视' },
  { en: ['coffee maker', 'coffee machine'], kind: 'thing', vi: ['máy pha cà phê'], yue: '咖啡機', zh: '咖啡机' },
  { en: ['kettle'], kind: 'thing', vi: ['ấm đun nước'], yue: '水煲', zh: '电水壶' },
  // What kind of thing: "corner lamp", "little lamp"
  { en: ['corner'], kind: 'mod', vi: ['góc'], yue: '角落', zh: '角落' },
  { en: ['little', 'small', 'mini'], kind: 'mod', vi: ['nhỏ'], yue: '細', zh: '小' },
  { en: ['long', 'tall'], kind: 'mod', vi: ['dài'], yue: '長', zh: '长' },
  // Where in the place
  { en: ['left'], kind: 'pos', vi: ['bên trái'], yue: '左邊', zh: '左边' },
  { en: ['right'], kind: 'pos', vi: ['bên phải'], yue: '右邊', zh: '右边' },
];

const PHRASES = WORDS.flatMap((w) => w.en.map((en) => ({ en: en.split(' '), w })))
  .sort((a, b) => b.en.length - a.en.length);
// Said or left out without changing the name.
const FILLER = new Set(['the', 'my', 'our', 'a', 'main', 'big', 'smart', 'plug', 'switch', 'outlet', 'socket']);

interface Reading { owner?: string; ownerRoom: boolean; place?: Word; thing?: Word; pos?: Word; mod?: Word }

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

// The simplified characters in the Mandarin words above, in traditional: to tell 客厅灯 is 客廳燈.
// 台 is taken as 枱, which sounds the same: 台灯 is 枱燈.
const TRADITIONAL: Record<string, string> = Object.fromEntries([...
  '厨廚厅廳卧臥书書阁閣楼樓关關阳陽门門后後园園车車库庫台枱岛島区區头頭灯燈圣聖诞誕气氣净淨湿濕机機风風电電视視壶壺边邊长長间間顶頂',
].reduce<string[][]>((pairs, c, i, all) => (i % 2 ? pairs : [...pairs, [c, all[i + 1]]]), []));
const traditional = (s: string) => [...s].map((c) => TRADITIONAL[c] ?? c).join('');

/** The Chinese words for a name's parts after a person's name, in one language: 房燈, 房间灯. */
const chineseTail = (r: Reading, lang: 'yue' | 'zh') =>
  (r.pos?.[lang] ?? '') + (r.ownerRoom ? (lang === 'yue' ? '房' : '房间') : '') + (r.place?.[lang] ?? '') + (r.mod?.[lang] ?? '') + (r.thing?.[lang] ?? '');

/** Owners' Chinese names, from Chinese nicknames already given: "Brenden's room lights" with 卓希房燈 → brenden: 卓希. */
export function learnOwners(devices: SuggestDevice[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const d of devices) {
    const english = [d.alias, ...d.nicknames].map(readName).filter((r): r is Reading => !!r?.owner);
    const chinese = d.nicknames.filter((n) => /\p{Script=Han}/u.test(n));
    for (const r of english) {
      for (const lang of ['yue', 'zh'] as const) {
        const tail = chineseTail({ ...r, pos: undefined }, lang);
        if (!tail) continue;
        for (const n of chinese) {
          if (n.endsWith(tail) && n.length > tail.length) owners.set(r.owner!.toLowerCase(), n.slice(0, -tail.length));
        }
      }
    }
  }
  return owners;
}

// 客厅灯 and 客廳燈 are one name to voice, so one key.
const key = (s: string) => traditional(s.normalize('NFC').toLowerCase().replace(/[\s-]+/g, ' ').trim());

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
      if (room && !room.thing && !room.pos && !room.mod) { r.place = room.place; r.owner = room.owner; r.ownerRoom = room.ownerRoom; }
    }
    if (!r.thing) continue;   // a place alone ("Kitchen") says nothing about what it is

    if (languages.includes('vi')) {
      for (const thing of r.thing.vi) {
        for (const place of r.place?.vi ?? ['']) {
          let text = [thing, r.mod?.vi[0] ?? '', place, r.pos?.vi[0] ?? ''].filter(Boolean).join(' ');
          if (r.owner) text += r.place || !r.ownerRoom && r.thing.vi[0] !== 'đèn' ? ` ${r.owner}` : ` phòng ${r.owner}`;
          add({ text, lang: 'vi', from: name });
        }
      }
    }
    for (const lang of ['yue', 'zh'] as const) {
      if (!languages.includes(lang)) continue;
      const rest = chineseTail(r, lang);
      if (!r.owner) add({ text: rest, lang, from: name });
      else {
        const chinese = owners.get(r.owner.toLowerCase());
        if (chinese) add({ text: chinese + rest, lang, from: name });
        // Unless it already has one, in Chinese, ending the same way.
        else if (!device.nicknames.some((n) => key(n).endsWith(key(rest)) && n.length > rest.length)) {
          add({ text: rest, lang, from: name, needsName: r.owner });
        }
      }
    }
  }
  return out;
}
