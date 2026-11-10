// Capture the homepage notch demo as frames, so the README can show the product moving
// instead of asking a reader to imagine it.
//
// The page tells one story (?capture=1 holds it): a request lands, the comment field opens,
// a line is typed and sent, and the notch moves to the next request. The recorder starts
// that story itself, so the frames are the same every time.
//
// Sampling runs as fast as the browser can screenshot, and the encoder is handed the
// measured interval, so the GIF plays at the pace the page actually moved. A fixed delay
// with slow screenshots is what made the last one both jerky and too quick.
//
//   node scripts/capture-demo.mjs [out-dir] [seconds] [url]
import { chromium } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/psh-frames";
const SECONDS = Number(process.argv[3] ?? 9);
const URL = process.argv[4] ?? "https://psh.now/?capture=1";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Microsoft Edge is installed on this Mac; the bundled headless shell is not.
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({
  viewport: { width: 1200, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
});
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__pshDemo, null, { timeout: 20000 });
await page.waitForTimeout(1200);

// The mock sits below the fold; reveal it the way a reader would, by scrolling to it.
const desk = page.locator(".desk").first();
await desk.scrollIntoViewIfNeeded();
await page.waitForTimeout(800);

// Park the pointer off the notch: hovering stops the story and shows the list instead.
await page.mouse.move(5, 5);

const box = await desk.boundingBox();
if (!box) throw new Error("the notch mock is not on the page");
// The desk is 16:9 with the notch strip at the top; a full-width clip leaves most of the
// frame as empty desktop, so the shot is cropped to a band around the notch and the card.
const width = Math.min(Math.floor(box.width), 960);
const clip = {
  x: Math.max(0, Math.floor(box.x + (box.width - width) / 2)),
  y: Math.max(0, Math.floor(box.y)),
  width,
  height: Math.min(Math.floor(box.height), 400),
};
console.log(`clip ${clip.width}x${clip.height} at ${clip.x},${clip.y}`);

await page.evaluate(() => window.__pshDemo.start());

const started = Date.now();
let frames = 0;
while ((Date.now() - started) / 1000 < SECONDS) {
  const name = `${OUT}/frame-${String(frames).padStart(3, "0")}.png`;
  await page.screenshot({ path: name, clip });
  frames += 1;
}

const elapsed = ((Date.now() - started) / 1000);
const comment = await page.evaluate(() => window.__pshDemo.comment);
await browser.close();
const delay = elapsed / frames;
writeFileSync(`${OUT}/timing.json`, JSON.stringify({ frames, seconds: elapsed, delay }, null, 2) + "\n");
console.log(`wrote ${frames} frames over ${elapsed.toFixed(2)}s, ${(delay * 1000).toFixed(0)}ms apart, to ${OUT}`);
console.log(`comment typed: ${comment}`);
console.log(`encode with: swift scripts/gif.swift ${OUT} assets/demo.gif ${delay.toFixed(3)}`);
