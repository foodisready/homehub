/**
 * Guesses for first-run setup, from a device's name. Each is only a starting
 * point the admin can change.
 */

export const COMMON_ROOMS = [
  'Living room', 'Kitchen', 'Dining room', 'Bedroom', 'Primary bedroom', 'Kids room', 'Office', 'Bathroom',
  'Hallway', 'Basement', 'Garage', 'Laundry', 'Den', 'Family room', 'Nursery', 'Outside',
];

const ROOM_WORDS: [RegExp, string][] = [
  [/\bliving\s*room\b|\blounge\b/i, 'Living room'],
  [/\bfamily\s*room\b/i, 'Family room'],
  [/\bkitchen\b/i, 'Kitchen'],
  [/\bdining\b/i, 'Dining room'],
  [/\b(master|primary)\s*(bed)?room\b/i, 'Primary bedroom'],
  [/\b(kids?|children'?s?|boys?|girls?)\b.*\broom\b|\bkids?\b/i, 'Kids room'],
  [/\bnursery\b|\bbaby\b/i, 'Nursery'],
  [/\bbed\s*room\b|\bbedside\b|\bnightstand\b/i, 'Bedroom'],
  [/\boffice\b|\bstudy\b|\bdesk\b/i, 'Office'],
  [/\bbath\s*room\b|\bbath\b|\bvanity\b/i, 'Bathroom'],
  [/\bhall(way)?\b|\bstairs?\b|\bentry(way)?\b|\bfoyer\b/i, 'Hallway'],
  [/\bbasement\b/i, 'Basement'],
  [/\bgarage\b/i, 'Garage'],
  [/\blaundry\b|\bwasher\b|\bdryer\b/i, 'Laundry'],
  [/\bden\b/i, 'Den'],
  [/\bporch\b|\bpatio\b|\bdeck\b|\byard\b|\bgarden\b|\bdriveway\b|\boutdoor\b|\boutside\b|\bfront\s*door\b|\bpool\b|\blandscape\b/i, 'Outside'],
];

/** "Kitchen lights" → "Kitchen". Null when the name gives no clue. */
export function guessRoom(name: string): string | null {
  for (const [pattern, room] of ROOM_WORDS) if (pattern.test(name)) return room;
  return null;
}

/** A name that's only an address or a model number, which nobody would say out loud. */
export function needsBetterName(name: string): boolean {
  const n = name.trim();
  return !n || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(n) || /^[A-Z0-9_-]{6,}$/.test(n) || /^(shelly|tuya|meross|kasa|hs\d|kp\d|ep\d)/i.test(n);
}

const LIGHT = /\blights?\b|\blamps?\b|\bbulbs?\b|\bsconces?\b|\bchandelier\b|\bstrip\b|\bpendant\b|\bstatue\b|\bstring\b|\btree\b|\bled\b/i;

export const looksLikeLight = (name: string) => LIGHT.test(name);
export const looksOutdoor = (name: string, room: string | null) => room === 'Outside' || guessRoom(name) === 'Outside';
