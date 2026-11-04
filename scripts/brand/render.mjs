// Renders the documentation artwork in docs/assets/ from scripts/brand/templates.html and the live site.
//
//   python3 -m http.server 8765        (from the repository root, in another terminal)
//   node scripts/brand/render.mjs
//
// Needs Playwright with a Chromium-based browser (CHROME_PATH to use an installed Chrome), Python 3
// with Pillow for the GIFs, and the site fonts (node site/tools/fetch-fonts.mjs).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8765";
const OUT = "docs/assets";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });

async function still(name, query, size) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
  await page.goto(`${BASE}/scripts/brand/templates.html?${query}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.locator("section.on .frame").screenshot({ path: join(OUT, `${name}.png`) });
  await page.close();
  console.log(`${name}.png`);
}

await still("banner", "t=banner", { width: 1280, height: 440 });
await still("flow", "t=flow", { width: 1280, height: 560 });
await still("lifecycle", "t=life", { width: 1280, height: 520 });
const docs = [
  ["header-contributing", "CS-02", "Contributing", "How to file a change", "Filed under", "community"],
  ["header-security", "CS-03", "Security policy", "Report privately", "Response", "within 72 hours"],
  ["header-conduct", "CS-04", "Code of conduct", "Be kind, be specific", "Applies to", "everyone"],
  ["header-concepts", "CS-05", "Concepts", "How the gate thinks", "Read time", "6 minutes"],
  ["header-changelog", "CS-06", "Changelog", "Every release, filed", "Format", "newest first"],
];
for (const [name, form, title, kicker, sidelabel, sidevalue] of docs) {
  const q = new URLSearchParams({ t: "doc", form: `Form ${form}`, title, kicker, sidelabel, sidevalue });
  await still(name, q.toString(), { width: 1280, height: 230 });
}

// ---- site captures: the signing ritual as a GIF (recorded as video, encoded by ffmpeg), the tampered ledger as a still
const videoDir = mkdtempSync(join(tmpdir(), "cs-video-"));
const vctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } });
const site = await vctx.newPage();
const t0 = Date.now();
await site.goto(`${BASE}/site/`, { waitUntil: "networkidle" });
await site.addStyleTag({ content: ".grain{display:none} .plan{transform:none}" });
await site.evaluate(() => document.fonts.ready);
await site.waitForTimeout(1200);
const box = await site.locator(".plan").boundingBox();
const startAt = (Date.now() - t0) / 1000;
await site.waitForTimeout(700);
await site.evaluate(() => document.querySelector("[data-sign-for-me]").click());
await site.waitForTimeout(3600);
await site.evaluate(() => document.querySelector("[data-apply]").click());
await site.waitForTimeout(4600);
const duration = (Date.now() - t0) / 1000 - startAt;
await site.evaluate(() => document.querySelector("#ledger").scrollIntoView());
await site.waitForTimeout(1200);
await site.locator("[data-entries] li:nth-child(2) .data").click();
await site.keyboard.press("End");
await site.keyboard.type(" (edited)");
await site.waitForTimeout(1600);
await site.locator("[data-book]").screenshot({ path: join(OUT, "ledger-tamper.png") });
console.log("ledger-tamper.png");
const video = await site.video().path();
await vctx.close();

const c = { w: Math.round(box.width) + 16, h: Math.min(900 - Math.round(box.y) + 8, Math.round(box.height) + 90), x: Math.round(box.x) - 8, y: Math.round(box.y) - 8 };
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-ss", startAt.toFixed(2), "-t", duration.toFixed(2), "-i", video,
  "-vf", `crop=${c.w}:${c.h}:${c.x}:${c.y},fps=10,scale=600:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
  "-loop", "0", join(OUT, "signing.gif"),
]);
console.log("signing.gif");
rmSync(videoDir, { recursive: true, force: true });

await browser.close();
execFileSync("python3", ["scripts/brand/optimize-png.py", OUT], { stdio: "inherit" });
