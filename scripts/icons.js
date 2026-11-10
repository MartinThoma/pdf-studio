// Renders icons/icon.svg into the PNG icons the web app manifest and iOS need.
//
// Usage: node scripts/icons.js   (needs Google Chrome; CHROME=/path/to/chrome to override)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ICONS = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const svg = readFileSync(join(ICONS, "icon.svg"), "utf8");
// Maskable: full-bleed background, artwork inside the central 80 % safe zone.
const maskable = svg
  .replace('<rect width="512" height="512" rx="112" fill="#2847c4"/>', '<rect width="512" height="512" fill="#2847c4"/><g transform="translate(51.2 51.2) scale(0.8)">')
  .replace("</svg>", "</g></svg>");

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : { channel: "chrome" });
const page = await browser.newPage();
for (const [name, size, source] of [
  ["icon-180.png", 180, svg],
  ["icon-192.png", 192, svg],
  ["icon-512.png", 512, svg],
  ["icon-maskable-512.png", 512, maskable],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
  );
  await page.screenshot({ path: join(ICONS, name), omitBackground: true });
}
await browser.close();
console.log("icons/*.png written");
