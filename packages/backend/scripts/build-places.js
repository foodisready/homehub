#!/usr/bin/env node
/**
 * Builds assets/places.tsv.gz, the town list behind "Where's your home?" in
 * first-run setup. HomeHub searches it locally, so finding a town never sends
 * anything outside the house.
 *
 * Source: GeoNames (https://www.geonames.org), licensed CC BY 4.0. Download
 * cities15000.zip (unzipped), admin1CodesASCII.txt and countryInfo.txt from
 * https://download.geonames.org/export/dump/ into one folder, then run:
 *
 *   node scripts/build-places.js <that folder>
 *
 * Each line: name, ASCII name, region, country, latitude, longitude, time zone, population.
 * Coordinates keep two decimals (about 1 km), plenty for sunrise and sunset.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/build-places.js <geonames folder>'); process.exit(1); }

const lines = (file) => fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));

const countries = new Map(lines('countryInfo.txt').map((l) => { const f = l.split('\t'); return [f[0], f[4]]; }));
const regions = new Map(lines('admin1CodesASCII.txt').map((l) => { const f = l.split('\t'); return [f[0], f[1]]; }));
const clean = (s) => (s ?? '').replace(/[\t\n]/g, ' ').trim();

const rows = lines('cities15000.txt').map((l) => {
  const f = l.split('\t');
  return {
    name: clean(f[1]), ascii: clean(f[2]),
    region: clean(regions.get(`${f[8]}.${f[10]}`)), country: clean(countries.get(f[8]) ?? f[8]),
    lat: Number(f[4]).toFixed(2), lon: Number(f[5]).toFixed(2), tz: f[17], pop: Number(f[14]) || 0,
  };
}).filter((r) => r.name && r.tz);

// Biggest first, so the best-known town of a name comes first in search.
rows.sort((a, b) => b.pop - a.pop);
const tsv = rows.map((r) => [r.name, r.ascii === r.name ? '' : r.ascii, r.region, r.country, r.lat, r.lon, r.tz, r.pop].join('\t')).join('\n') + '\n';

const out = path.join(__dirname, '..', 'assets', 'places.tsv.gz');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zlib.gzipSync(tsv, { level: 9 }));
console.log(`${rows.length} places, ${(fs.statSync(out).size / 1024).toFixed(0)} KB → ${out}`);
