/**
 * The kitchen, drawn as SVG in one-point perspective (vanishing point 600,330).
 *
 * How the lighting works: the room is drawn as it looks in daylight. Over it lies a night-blue
 * layer ("darkness") whose strength follows the sun. Each light cuts holes in that layer through
 * a mask, shaped like the light it throws (a scallop on the wall, a pool on the counter), and adds
 * a warm glow on top. A light's brightness is its group's opacity, so dimming to 40% cuts the
 * holes 40% deep. The window panes are always cut out, so the sky shows through.
 *
 * Groups the page drives, by id: mask-<light>, glow-<light>, fix-<light> for each light;
 * darkness, mask-day, sky-top, sky-bot, sun, moon, stars, hills, trees, ground, reflect,
 * clock-h, clock-m, person, sensor-led.
 */

const range = (n) => Array.from({ length: n }, (_, i) => i);

const COLORS = {
  ceiling: '#f3efe8', wall: '#ece5d9', side: '#e0d7c8', floor: '#b88a5c', plank: '#9d7247',
  cabinet: '#7f9c8c', panel: '#76917f', panelLine: '#67816f', brass: '#c8a465',
  counter: '#f4f2ed', counterEdge: '#dcd7cd', tile: '#f4f1ea', grout: '#dad3c5',
  island: '#30425a', islandPanel: '#2a3a50', trim: '#f8f6f1', hall: '#8b8f98',
};

// Where things are, in the 1200 × 760 drawing.
const UPPER = { y0: 162, y1: 364, runs: [[150, 482], [718, 1050]] };
const PANES = [[500, 213, 96, 208], [604, 213, 96, 208]];
const COUNTER_Y = 464;
const CANS = [
  ...[378.6, 526.2, 673.8, 821.4].map((x) => ({ x, y: 59.4, rx: 13, ry: 3.6, back: true })),   // near the wall
  ...[348.9, 516.3, 683.7, 851.1].map((x) => ({ x, y: 23.1, rx: 16, ry: 5, back: false })),    // over the island
];
const PUCKS = UPPER.runs.flatMap(([a, b]) => range(6).map((i) => a + ((b - a) * (i + 0.5)) / 6));
const PENDANTS = [420, 600, 780];
const SHADE_Y = 431;

function room() {
  const planks = range(21).map((i) => {
    const X = -300 + i * 90;
    const top = X + ((760 - 661) / (760 - 330)) * (600 - X);
    return `<line x1="${X}" y1="760" x2="${top.toFixed(1)}" y2="661"/>`;
  }).join('');
  return `
  <polygon points="0,0 1200,0 1062,76 138,76" fill="url(#g-ceiling)"/>
  <polygon points="0,0 138,76 138,661 0,760" fill="${COLORS.side}"/>
  <polygon points="1200,0 1062,76 1062,661 1200,760" fill="${COLORS.side}"/>
  <rect x="138" y="76" width="924" height="585" fill="${COLORS.wall}"/>
  <rect x="138" y="364" width="924" height="${COUNTER_Y - 364}" fill="url(#p-tiles)"/>
  <polygon points="138,661 1062,661 1200,760 0,760" fill="${COLORS.floor}"/>
  <g stroke="${COLORS.plank}" stroke-width="1.5" opacity=".55">${planks}</g>
  <g stroke="#000" stroke-opacity=".07" stroke-width="1.5" fill="none">
    <polyline points="0,0 138,76 1062,76 1200,0"/><line x1="138" y1="76" x2="138" y2="661"/><line x1="1062" y1="76" x2="1062" y2="661"/>
  </g>
  <!-- Doorway to the hall, on the left wall -->
  <polygon points="28,211 100,226 100,688 28,740" fill="url(#g-hall)"/>
  <polygon points="28,211 100,226 100,688 28,740" fill="none" stroke="${COLORS.trim}" stroke-width="6" stroke-linejoin="round"/>
  <!-- Motion sensor -->
  <g transform="translate(112 122) skewY(29)"><rect x="0" y="0" width="16" height="12" rx="3" fill="#fbfaf7" stroke="#cfc8bb"/><circle cx="8" cy="6" r="3.2" fill="#e7e2d8"/></g>
  <!-- Wall clock on the right wall, turned to face along it -->
  <g transform="matrix(0.415 -0.063 0 1 1130 250)">
    <circle r="31" fill="#fbfaf7" stroke="#3b3f46" stroke-width="3.5"/>
    ${range(12).map((i) => `<line x1="0" y1="-26" x2="0" y2="${i % 3 ? -23 : -20}" stroke="#3b3f46" stroke-width="${i % 3 ? 1.5 : 3}" transform="rotate(${i * 30})"/>`).join('')}
    <line id="clock-h" x1="0" y1="3" x2="0" y2="-15" stroke="#2b2f36" stroke-width="4" stroke-linecap="round"/>
    <line id="clock-m" x1="0" y1="4" x2="0" y2="-23" stroke="#2b2f36" stroke-width="2.5" stroke-linecap="round"/>
    <circle r="2.5" fill="#c0392b"/>
  </g>`;
}

function windowAndOutside() {
  const stars = [[512, 228], [530, 262], [556, 236], [585, 252], [622, 230], [640, 270], [672, 238], [690, 258], [548, 290], [612, 296], [570, 222], [686, 290]];
  return `
  <clipPath id="c-panes">${PANES.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join('')}</clipPath>
  <g clip-path="url(#c-panes)">
    <rect x="500" y="213" width="200" height="208" fill="url(#g-sky)"/>
    <g id="stars" fill="#fff">${stars.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 3 ? 1 : 1.5}"/>`).join('')}</g>
    <g id="moon"><circle cx="662" cy="252" r="22" fill="#f5f1e3" opacity=".12"/><circle cx="662" cy="252" r="10" fill="#f5f1e3"/></g>
    <g id="sun"><circle r="26" fill="#ffd27a" opacity=".25"/><circle r="13" fill="#ffd27a"/></g>
    <path id="hills" d="M500 382 Q530 362 566 372 T636 364 T700 376 L700 421 L500 421 Z" fill="#6f9a6a"/>
    <g id="trees" fill="#3f6e45">
      <ellipse cx="518" cy="392" rx="18" ry="27"/><ellipse cx="546" cy="401" rx="13" ry="19"/>
      <ellipse cx="664" cy="398" rx="15" ry="22"/><ellipse cx="688" cy="390" rx="20" ry="30"/>
    </g>
    <rect id="ground" x="500" y="408" width="200" height="13" fill="#557f4f"/>
    <rect id="reflect" x="500" y="213" width="200" height="208" fill="url(#g-reflect)" opacity="0"/>
  </g>
  <path d="M488 201 H712 V433 H488 Z M500 213 H596 V421 H500 Z M604 213 H700 V421 H604 Z" fill="${COLORS.trim}" fill-rule="evenodd"/>
  <rect x="480" y="421" width="240" height="14" rx="2" fill="#f0ece5"/>
  <rect x="484" y="435" width="232" height="4" fill="#000" opacity=".07"/>`;
}

function shaker(x, y, w, h, handle) {
  const hx = handle === 'left' ? x + 9 : handle === 'right' ? x + w - 9 : x + w / 2;
  const hy = handle === 'top' ? y + 12 : handle === 'bottom' ? y + h - 16 : y + h / 2;
  const bar = handle === 'top' || handle === 'drawer'
    ? `<rect x="${x + w / 2 - 16}" y="${handle === 'drawer' ? y + h / 2 - 2 : hy - 2}" width="32" height="4" rx="2" fill="${COLORS.brass}"/>`
    : `<rect x="${hx - 2}" y="${hy - 14}" width="4" height="28" rx="2" fill="${COLORS.brass}"/>`;
  return `<rect x="${x + 2}" y="${y + 2}" width="${w - 4}" height="${h - 4}" rx="2" fill="${COLORS.cabinet}"/>
    <rect x="${x + 11}" y="${y + 11}" width="${w - 22}" height="${h - 22}" rx="1.5" fill="${COLORS.panel}" stroke="${COLORS.panelLine}" stroke-width="1.5"/>${bar}`;
}

function cabinets() {
  const uppers = UPPER.runs.map(([a, b]) => {
    const w = (b - a) / 4;
    return range(4).map((i) => shaker(a + i * w, UPPER.y0, w, UPPER.y1 - UPPER.y0, i % 2 ? 'left' : 'right')).join('')
      + `<rect x="${a}" y="${UPPER.y1 - 5}" width="${b - a}" height="5" fill="#000" opacity=".12"/>`
      + `<rect x="${a - 4}" y="${UPPER.y0 - 8}" width="${b - a + 8}" height="9" fill="${COLORS.cabinet}"/>`;
  }).join('');

  // Lower run: eight bays from 124 to 1076.
  const xs = range(9).map((i) => 124 + i * 119);
  const top = 490, bottom = 648, h = bottom - top;
  const bay = (i) => {
    const x = xs[i], w = 119;
    switch (i) {
      case 1: return shaker(x, top, w, h, 'top');                                          // dishwasher
      case 2: return range(3).map((k) => shaker(x, top + (k * h) / 3, w, h / 3, 'drawer')).join('');
      case 6: return `<rect x="${x + 2}" y="${top + 2}" width="${w - 4}" height="${h - 4}" rx="2" fill="#3a3f46"/>
        <rect x="${x + 10}" y="${top + 8}" width="${w - 20}" height="16" rx="2" fill="#2b2f35"/>
        ${range(4).map((k) => `<circle cx="${x + 24 + k * 24}" cy="${top + 16}" r="4" fill="#9aa0a8"/>`).join('')}
        <rect x="${x + 14}" y="${top + 34}" width="${w - 28}" height="5" rx="2.5" fill="#c9ced4"/>
        <rect x="${x + 14}" y="${top + 48}" width="${w - 28}" height="${h - 64}" rx="4" fill="#15181c" stroke="#555b63" stroke-width="2"/>`;
      default: return shaker(x, top, w, h, i % 2 ? 'left' : 'right');
    }
  };
  const lowers = range(8).map(bay).join('');

  return `
  ${uppers}
  <polygon points="138,${COUNTER_Y} 1062,${COUNTER_Y} 1080,480 120,480" fill="${COLORS.counter}"/>
  <polygon points="545,467 655,467 661,478 539,478" fill="#b8bdc3"/><polygon points="551,469 649,469 653,476 547,476" fill="#9ca2a9"/>
  <polygon points="850,467 946,467 953,478 843,478" fill="#25292e"/>
  <g fill="none" stroke="#4a4f57" stroke-width="1.5"><ellipse cx="872" cy="472" rx="12" ry="3"/><ellipse cx="922" cy="472" rx="12" ry="3"/></g>
  <rect x="120" y="480" width="960" height="10" fill="${COLORS.counterEdge}"/>
  <rect x="124" y="490" width="952" height="158" fill="${COLORS.panelLine}"/>
  ${lowers}
  <rect x="130" y="648" width="940" height="20" fill="#3c3a36"/>
  <!-- On the counter -->
  <g transform="rotate(-6 201 464)"><rect x="172" y="398" width="58" height="66" rx="10" fill="#c99b68"/><circle cx="201" cy="411" r="4" fill="${COLORS.tile}"/></g>
  <path d="M268 452 Q300 478 332 452 Z" fill="#ebe6dd" stroke="#cfc8bb"/>
  <circle cx="289" cy="450" r="9" fill="#f2c94c"/><circle cx="307" cy="448" r="9" fill="#efbf3a"/><circle cx="298" cy="440" r="8" fill="#f4d060"/>
  <g stroke="#7d5f42" stroke-width="3" stroke-linecap="round"><line x1="398" y1="440" x2="393" y2="410"/><line x1="404" y1="440" x2="407" y2="404"/><line x1="410" y1="440" x2="417" y2="414"/></g>
  <rect x="391" y="438" width="24" height="26" rx="3" fill="#d8d2c6"/>
  <path d="M600 466 V430 Q600 418 612 418 Q622 418 622 428 V432" fill="none" stroke="#9aa1a9" stroke-width="5" stroke-linecap="round"/>
  <polygon points="748,440 776,440 772,464 752,464" fill="#c4704a"/>
  <g fill="#5f8f5a"><ellipse cx="755" cy="424" rx="5" ry="15" transform="rotate(-24 755 424)"/><ellipse cx="762" cy="417" rx="5" ry="18"/><ellipse cx="770" cy="425" rx="5" ry="15" transform="rotate(24 770 425)"/></g>
  <path d="M984 464 L989 436 Q1000 428 1011 436 L1016 464 Z" fill="#d95f43"/><rect x="996" y="428" width="8" height="5" rx="2" fill="#2b2f36"/>
  <path d="M1013 440 Q1028 444 1015 458" fill="none" stroke="#2b2f36" stroke-width="3"/>`;
}

function island() {
  return `
  <rect x="262" y="644" width="676" height="116" fill="${COLORS.island}"/>
  ${range(5).map((i) => `<rect x="${272 + i * 133}" y="656" width="123" height="104" rx="2" fill="${COLORS.islandPanel}"/>`).join('')}
  <polygon points="300,598 900,598 938,630 262,630" fill="${COLORS.counter}"/>
  <rect x="262" y="630" width="676" height="14" fill="${COLORS.counterEdge}"/>
  <g stroke="#5f8f5a" stroke-width="2"><line x1="478" y1="580" x2="470" y2="556"/><line x1="481" y1="580" x2="484" y2="552"/><line x1="484" y1="580" x2="494" y2="560"/></g>
  <circle cx="469" cy="555" r="5" fill="#e7a0a8"/><circle cx="485" cy="550" r="5" fill="#f2d16b"/><circle cx="495" cy="559" r="5" fill="#e7a0a8"/>
  <rect x="472" y="578" width="18" height="26" rx="3" fill="#f6f3ec" stroke="#d6cfc2"/>
  <ellipse cx="722" cy="606" rx="34" ry="8" fill="#e9e3d8"/>
  <circle cx="708" cy="600" r="9" fill="#f08a3c"/><circle cx="725" cy="597" r="9" fill="#f39a4a"/><circle cx="740" cy="601" r="8" fill="#e98035"/>`;
}

/* Lights: the holes each cuts in the darkness, and the warm glow it adds. */

const backCans = CANS.filter((c) => c.back), frontCans = CANS.filter((c) => !c.back);

function lightMasks() {
  return `
  <g id="mask-ceiling" class="fx">
    <ellipse cx="600" cy="400" rx="720" ry="430" fill="url(#g-pool)" opacity=".62"/>
    ${backCans.map((c) => `<ellipse cx="${c.x}" cy="215" rx="78" ry="175" fill="url(#g-pool)" opacity=".55"/>
      <ellipse cx="${c.x}" cy="505" rx="120" ry="95" fill="url(#g-pool)" opacity=".6"/>`).join('')}
    ${frontCans.map((c) => `<ellipse cx="${c.x}" cy="690" rx="160" ry="115" fill="url(#g-pool)" opacity=".75"/>`).join('')}
  </g>
  <g id="mask-counter" class="fx" filter="url(#f-soft)">
    <ellipse cx="600" cy="470" rx="620" ry="210" fill="url(#g-pool)" opacity=".22"/>
    ${UPPER.runs.map(([a, b]) => `<rect x="${a}" y="364" width="${b - a}" height="104" fill="url(#g-wash)"/>
      <rect x="${a - 14}" y="462" width="${b - a + 28}" height="30" fill="#000"/>
      <rect x="${a - 14}" y="490" width="${b - a + 28}" height="80" fill="url(#g-wash)" opacity=".5"/>`).join('')}
  </g>
  <g id="mask-pendants" class="fx">
    <ellipse cx="600" cy="540" rx="520" ry="300" fill="url(#g-pool)" opacity=".26"/>
    ${PENDANTS.map((x) => `<ellipse cx="${x}" cy="614" rx="125" ry="42" fill="url(#g-pool)"/>
      <ellipse cx="${x}" cy="525" rx="95" ry="115" fill="url(#g-pool)" opacity=".35"/>`).join('')}
    <rect x="262" y="640" width="676" height="120" fill="url(#g-wash)" opacity=".55"/>
  </g>`;
}

function lightGlows() {
  return `
  <g id="glow-ceiling" class="fx">
    <ellipse cx="600" cy="400" rx="720" ry="430" fill="url(#g-warm)" opacity=".16"/>
    ${backCans.map((c) => `<ellipse cx="${c.x}" cy="200" rx="66" ry="165" fill="url(#g-warm)" opacity=".34"/>
      <ellipse cx="${c.x}" cy="500" rx="110" ry="80" fill="url(#g-warm)" opacity=".28"/>`).join('')}
    ${frontCans.map((c) => `<ellipse cx="${c.x}" cy="690" rx="150" ry="100" fill="url(#g-warm)" opacity=".3"/>`).join('')}
  </g>
  <g id="glow-counter" class="fx" filter="url(#f-soft-sm)">
    ${UPPER.runs.map(([a, b]) => `<rect x="${a}" y="364" width="${b - a}" height="100" fill="url(#g-wash-warm)" opacity=".55"/>
      <rect x="${a - 10}" y="462" width="${b - a + 20}" height="22" fill="url(#g-warm-strip)" opacity=".55"/>`).join('')}
    ${PUCKS.map((x) => `<ellipse cx="${x.toFixed(1)}" cy="398" rx="26" ry="40" fill="url(#g-warm)" opacity=".6"/>`).join('')}
  </g>
  <g id="glow-pendants" class="fx">
    ${PENDANTS.map((x) => `<ellipse cx="${x}" cy="612" rx="118" ry="38" fill="url(#g-amber)" opacity=".6"/>
      <ellipse cx="${x}" cy="520" rx="80" ry="110" fill="url(#g-amber)" opacity=".18"/>`).join('')}
  </g>`;
}

function fixturesOff() {
  return `
  <g>${CANS.map((c) => `<ellipse cx="${c.x}" cy="${c.y}" rx="${c.rx + 3}" ry="${c.ry + 1.2}" fill="#fbfaf7" stroke="#d3ccbf"/>
    <ellipse cx="${c.x}" cy="${c.y}" rx="${c.rx}" ry="${c.ry}" fill="#cfcac1"/>`).join('')}</g>
  <g>${PUCKS.map((x) => `<ellipse cx="${x.toFixed(1)}" cy="${UPPER.y1 + 1.5}" rx="6.5" ry="2.3" fill="#c9cdd1"/>`).join('')}</g>`;
}

function fixturesOn() {
  return `
  <g id="fix-ceiling" class="fx">${CANS.map((c) => `<ellipse cx="${c.x}" cy="${c.y + c.ry * 1.5}" rx="${c.rx * 3}" ry="${c.ry * 5}" fill="url(#g-bloom)"/>
    <ellipse cx="${c.x}" cy="${c.y}" rx="${c.rx}" ry="${c.ry}" fill="#fffdf4"/>`).join('')}</g>
  <g id="fix-counter" class="fx">${PUCKS.map((x) => `<ellipse cx="${x.toFixed(1)}" cy="${UPPER.y1 + 4}" rx="20" ry="7" fill="url(#g-bloom)"/>
    <ellipse cx="${x.toFixed(1)}" cy="${UPPER.y1 + 1.5}" rx="6.5" ry="2.3" fill="#fffaf0"/>`).join('')}</g>`;
}

function pendants() {
  const shade = (x) => `
    <line x1="${x}" y1="0" x2="${x}" y2="${SHADE_Y - 40}" stroke="#25272b" stroke-width="1.6"/>
    <path d="M${x - 39} ${SHADE_Y} Q${x - 37} ${SHADE_Y - 40} ${x} ${SHADE_Y - 42} Q${x + 37} ${SHADE_Y - 40} ${x + 39} ${SHADE_Y} Z" fill="#23262b"/>
    <path d="M${x - 24} ${SHADE_Y - 30} Q${x - 10} ${SHADE_Y - 39} ${x + 4} ${SHADE_Y - 39}" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="${x}" cy="${SHADE_Y}" rx="39" ry="7" fill="#15171a"/>`;
  return `<g>${PENDANTS.map(shade).join('')}</g>
  <g id="fix-pendants" class="fx">${PENDANTS.map((x) => `<ellipse cx="${x}" cy="${SHADE_Y + 14}" rx="64" ry="26" fill="url(#g-bloom)"/>
    <ellipse cx="${x}" cy="${SHADE_Y}" rx="35" ry="5.5" fill="#fff1d2"/>`).join('')}</g>`;
}

function person() {
  return `<g id="person" opacity="0">
    <circle cx="64" cy="330" r="19" fill="#262c3a"/>
    <path d="M40 372 Q40 352 64 352 Q88 352 88 372 L92 520 Q92 532 84 532 L82 712 L70 712 L66 566 L62 712 L50 712 L46 532 Q36 532 36 520 Z" fill="#262c3a"/>
  </g>
  <circle id="sensor-led" cx="120" cy="132" r="5" fill="#ef4444" opacity="0"/>`;
}

function defs() {
  const pool = (id, color, stops) => `<radialGradient id="${id}">${stops.map(([o, a]) => `<stop offset="${o}" stop-color="${color}" stop-opacity="${a}"/>`).join('')}</radialGradient>`;
  return `<defs>
    ${pool('g-pool', '#000', [[0, 1], [0.5, 0.6], [1, 0]])}
    ${pool('g-warm', '#ffd59a', [[0, 0.9], [0.45, 0.35], [1, 0]])}
    ${pool('g-amber', '#ffbf72', [[0, 0.95], [0.5, 0.4], [1, 0]])}
    <radialGradient id="g-bloom"><stop offset="0" stop-color="#fff8e6" stop-opacity=".95"/><stop offset=".3" stop-color="#ffd590" stop-opacity=".45"/><stop offset="1" stop-color="#ffc06a" stop-opacity="0"/></radialGradient>
    <linearGradient id="g-wash" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#000" stop-opacity=".1"/></linearGradient>
    <linearGradient id="g-wash-warm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd59a" stop-opacity=".8"/><stop offset="1" stop-color="#ffd59a" stop-opacity="0"/></linearGradient>
    <linearGradient id="g-warm-strip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe2b4" stop-opacity=".9"/><stop offset="1" stop-color="#ffd59a" stop-opacity=".1"/></linearGradient>
    <linearGradient id="g-ceiling" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9e4dc"/><stop offset="1" stop-color="${COLORS.ceiling}"/></linearGradient>
    <linearGradient id="g-hall" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6f737c"/><stop offset="1" stop-color="${COLORS.hall}"/></linearGradient>
    <linearGradient id="g-sky" x1="0" y1="0" x2="0" y2="1"><stop id="sky-top" offset="0" stop-color="#4f9be0"/><stop id="sky-bot" offset="1" stop-color="#bfe0fb"/></linearGradient>
    <linearGradient id="g-reflect" x1="0" y1="0" x2="1" y2="1"><stop offset=".25" stop-color="#ffe7c2" stop-opacity="0"/><stop offset=".45" stop-color="#ffe7c2" stop-opacity=".22"/><stop offset=".6" stop-color="#ffe7c2" stop-opacity="0"/></linearGradient>
    <pattern id="p-tiles" width="40" height="20" patternUnits="userSpaceOnUse" patternTransform="translate(138 364)">
      <rect width="40" height="20" fill="${COLORS.tile}"/>
      <path d="M0 .5 H40 M0 10.5 H40 M20 0 V10 M0 10 V20 M40 10 V20" stroke="${COLORS.grout}" stroke-width="1"/>
    </pattern>
    <filter id="f-soft" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="f-soft-sm" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="4"/></filter>
    <mask id="m-dark" maskUnits="userSpaceOnUse" x="0" y="0" width="1200" height="760">
      <rect width="1200" height="760" fill="#fff"/>
      <g id="mask-day" opacity="0"><ellipse cx="600" cy="470" rx="320" ry="230" fill="url(#g-pool)" opacity=".7"/></g>
      ${PANES.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"/>`).join('')}
      ${lightMasks()}
    </mask>
  </defs>`;
}

export function sceneSVG() {
  return `<svg class="scene" viewBox="0 0 1200 760" role="img" aria-labelledby="scene-title scene-desc" preserveAspectRatio="xMidYMid slice">
  <title id="scene-title">The demo kitchen</title>
  <desc id="scene-desc"></desc>
  ${defs()}
  ${room()}
  ${windowAndOutside()}
  ${cabinets()}
  ${island()}
  ${fixturesOff()}
  <rect id="darkness" width="1200" height="760" fill="#0a1020" mask="url(#m-dark)" opacity="0"/>
  <g style="mix-blend-mode:screen">${lightGlows()}</g>
  ${pendants()}
  ${fixturesOn()}
  ${person()}
</svg>`;
}
