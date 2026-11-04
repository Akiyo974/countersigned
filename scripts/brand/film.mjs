// Films scripts/brand/video.html (which drives the real site in an iframe) into docs/assets/countersigned.mp4.
// Frames come from Chrome's screencast with their real timestamps, then ffmpeg rebuilds a constant 30 fps video.
//
//   python3 -m http.server 8765 &   (repository root)
//   node scripts/brand/film.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8765";
const OUT = process.env.OUT ?? "docs/assets/countersigned.mp4";
const W = 1080, H = 1350;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto(`${BASE}/scripts/brand/video.html`, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => document.querySelector("#site").contentDocument?.querySelector("[data-sign-for-me]"));
await page.waitForTimeout(1500);

const dir = mkdtempSync(join(tmpdir(), "cs-film-"));
const frames = [];
const cdp = await page.context().newCDPSession(page);
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
  writeFileSync(file, Buffer.from(data, "base64"));
  frames.push({ file, t: metadata.timestamp });
  await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
await page.waitForTimeout(400);
await page.evaluate(() => window.play());
await page.waitForFunction(() => window.done, null, { timeout: 120_000, polling: 200 });
await cdp.send("Page.stopScreencast");
const end = Date.now() / 1000;
await browser.close();

// Concat list with real durations: each frame lasts until the next one arrived.
let list = "";
for (let i = 0; i < frames.length; i++) {
  const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(frames[i].t + 0.5, end);
  list += `file '${frames[i].file}'\nduration ${(next - frames[i].t).toFixed(4)}\n`;
}
list += `file '${frames.at(-1).file}'\n`;
writeFileSync(join(dir, "list.txt"), list);

const tmp = OUT.replace(/\.mp4$/, ".part.mp4");
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"),
  "-vf", `scale=${W}:${H}:flags=lanczos,fps=30,format=yuv420p`,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", "-pix_fmt", "yuv420p", tmp,
], { stdio: "inherit" });
renameSync(tmp, OUT);
rmSync(dir, { recursive: true, force: true });
console.log(`${OUT}: ${frames.length} frames captured`);
