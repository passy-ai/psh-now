// Capture the homepage's notch mock as frames, so the README can show the product moving
// instead of asking a reader to imagine it.
import { chromium } from "playwright";
import { mkdirSync, rmSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/psh-frames";
const FRAMES = Number(process.argv[3] ?? 40);
const EVERY = Number(process.argv[4] ?? 80);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Microsoft Edge is installed on this Mac; the bundled headless shell is not.
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({
  viewport: { width: 1200, height: 800 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
await page.goto("https://psh.now", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(1500);

// The mock sits below the fold; reveal it the way a reader would, by scrolling to it.
const desk = page.locator(".desk").first();
await desk.scrollIntoViewIfNeeded();
await page.waitForTimeout(1200);

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

for (let i = 0; i < FRAMES; i++) {
  const name = `${OUT}/frame-${String(i).padStart(3, "0")}.png`;
  await page.screenshot({ path: name, clip });
  await page.waitForTimeout(EVERY);
}
await browser.close();
console.log(`wrote ${FRAMES} frames to ${OUT}`);
