# HomeHub demo

A pretend kitchen that runs entirely in the browser, for showing what HomeHub does without a home to try it in:

- **Lights you can see.** Turn the ceiling lights, under-cabinet lights or island pendants on, off or dimmed, and the drawing of the kitchen lights up to match. Tap a light in the picture, or use the cards below it.
- **Chat in four languages.** “Dim the pendants to 30%”, “開吊燈十分鐘”, “关掉顶灯”, “bật đèn dưới tủ”. Replies come in the language spoken. Times work too: “for 10 minutes”, “in 15 minutes”, “dinner at 7 pm”.
- **Schedules.** A clock runs the day (fast, if you like) and the schedules fire as it passes them: breakfast, lights off at daylight, under-cabinet on at sunset, dinner, wind down, goodnight. Drag the timeline to jump to any time.
- **Motion.** “Someone walks in” turns on the under-cabinet lights when it's dark, then turns them off after five quiet minutes.
- **Energy.** Watts now and kWh so far today, from each light's wattage.

It is separate from the app. Nothing here is imported by `packages/`, and nothing in `packages/` is imported here. It has no build step and no dependencies, and it sends nothing anywhere. Reloading starts over.

## Run it

The page uses JavaScript modules, which browsers won't load from a `file://` address, so serve the folder:

```bash
cd demo
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Test it

```bash
cd demo
node --test
```

The tests cover reading commands in each language, the replies, timers, schedules, energy and motion.

## Files

| File | What it is |
|---|---|
| `index.html`, `demo.css` | The page, in HomeHub's colours |
| `demo.js` | The clock, the lights, chat, schedules and activity |
| `scene.js` | The kitchen drawing, and how the lights are drawn on it |
| `home.js` | The pretend kitchen: lights, scenes, schedules, the sun, what a command does |
| `commands.js` | Reading a command in English, Cantonese, Mandarin or Vietnamese, and the replies |
| `demo.test.mjs` | Tests for `commands.js` and `home.js` |

`commands.js` is a small stand-in for HomeHub's real command reader (`packages/backend/src/nlp`). It knows one room and three lights, so it is much simpler. Its reply wording follows HomeHub's.

## How the lighting works

The kitchen is drawn as it looks in daylight. A night-blue layer covers it, as strong as the hour is dark. Each light cuts holes in that layer, shaped like the light it throws (a scallop on the wall, a pool on the island), and adds a warm glow. Dimming a light makes its holes shallower. The window is always cut out, so the sky shows through. To use photos of a real room instead, keep this approach: one photo with the lights off, and one glow layer per light.

## Published on GitHub Pages

`.github/workflows/demo-pages.yml` runs the tests and publishes the page files to https://foodisready.github.io/homehub/ whenever `demo/` changes on `main`. It can also be run by hand from the Actions tab.
