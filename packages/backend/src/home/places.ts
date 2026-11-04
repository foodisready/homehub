import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/**
 * Finds a town by name, for "Where's your home?" in first-run setup and
 * Settings → Home. The town list ships with HomeHub (assets/places.tsv.gz,
 * built by scripts/build-places.js from GeoNames, CC BY 4.0), so a search
 * never leaves the house.
 */

export interface Place {
  name: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
  /** "Springfield, Illinois, United States" */
  label: string;
}

interface Entry extends Place { key: string; keyAscii: string; population: number }

const FILE = path.join(__dirname, '..', '..', 'assets', 'places.tsv.gz');

let entries: Entry[] | null = null;

/** Lower case, without accents or punctuation, so "Sao Paulo" finds "São Paulo". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function load(): Entry[] {
  if (entries) return entries;
  const text = zlib.gunzipSync(fs.readFileSync(FILE)).toString('utf8');
  entries = text.split('\n').filter(Boolean).map((line) => {
    const [name, ascii, region, country, lat, lon, timezone, pop] = line.split('\t');
    return {
      name, region, country, timezone,
      latitude: Number(lat), longitude: Number(lon), population: Number(pop) || 0,
      label: [name, region !== name ? region : '', country].filter(Boolean).join(', '),
      key: fold(name), keyAscii: fold(ascii || name),
    };
  });
  return entries;
}

const pub = ({ name, region, country, latitude, longitude, timezone, label }: Entry): Place =>
  ({ name, region, country, latitude, longitude, timezone, label });

/** US state abbreviations, so "Springfield, IL" works as people write it. */
const US_STATES: Record<string, string> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut',
  de: 'delaware', dc: 'washington d c', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois',
  in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
  ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana',
  ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york',
  nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
  ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah',
  vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
  us: 'united states', usa: 'united states', uk: 'united kingdom',
};

/**
 * Towns matching what was typed, best first: whole-name matches before
 * prefixes, then towns in the browser's time zone, then bigger towns. Text
 * after a comma narrows by region or country: "Portland, Maine".
 */
export function searchPlaces(query: string, { timezone, limit = 8 }: { timezone?: string; limit?: number } = {}): Place[] {
  const [townPart, ...rest] = query.split(',');
  const town = fold(townPart ?? '');
  if (town.length < 2) return [];
  const narrow = rest.map(fold).filter(Boolean).map((w) => US_STATES[w] ?? w);

  const scored: { e: Entry; score: number }[] = [];
  for (const e of load()) {
    const exact = e.key === town || e.keyAscii === town;
    if (!exact && !e.key.startsWith(town) && !e.keyAscii.startsWith(town)) continue;
    if (narrow.length) {
      const where = fold(`${e.region} ${e.country}`);
      if (!narrow.every((w) => where.includes(w))) continue;
    }
    // Entries are biggest first, so a stable sort keeps size as the last tie-break.
    scored.push({ e, score: (exact ? 2 : 0) + (timezone && e.timezone === timezone ? 1 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ e }) => pub(e));
}

/** The biggest town in a time zone: a first guess at where the home is. */
export function biggestPlaceIn(timezone: string): Place | null {
  const e = load().find((p) => p.timezone === timezone);
  return e ? pub(e) : null;
}
