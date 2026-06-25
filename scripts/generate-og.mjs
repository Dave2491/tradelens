import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const root = process.cwd();
const geist = await readFile(resolve(root, "node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"));
const inter = await readFile(resolve(root, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"));
const logo = await readFile(resolve(root, "public/tradelens-mark.svg"));

const browserCandidates = [
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

let executablePath = "";
for (const candidate of browserCandidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {
    // Try the next locally installed Chromium browser.
  }
}
if (!executablePath) throw new Error("Chrome or Edge is required to generate the social preview image.");

const fontData = (buffer) => `data:font/woff2;base64,${buffer.toString("base64")}`;
const logoData = `data:image/svg+xml;base64,${logo.toString("base64")}`;

const document = `<!doctype html>
<html>
  <head>
    <style>
      @font-face { font-family: Geist; src: url(${fontData(geist)}) format("woff2"); font-weight: 100 900; }
      @font-face { font-family: Inter; src: url(${fontData(inter)}) format("woff2"); font-weight: 100 900; }
      * { box-sizing: border-box; }
      html, body { width: 1200px; height: 630px; margin: 0; overflow: hidden; }
      body {
        position: relative;
        display: flex;
        justify-content: space-between;
        padding: 58px 70px;
        background:
          linear-gradient(rgba(175,198,255,.045) 1px, transparent 1px),
          linear-gradient(90deg, rgba(175,198,255,.045) 1px, transparent 1px),
          #0B0E15;
        background-size: 80px 80px;
        color: #E1E2EC;
        font-family: Inter, sans-serif;
      }
      .left { position: relative; width: 650px; display: flex; flex-direction: column; }
      .brand { display: flex; align-items: center; }
      .brand img { width: 68px; height: 68px; }
      .brand-copy { display: flex; flex-direction: column; margin-left: 16px; }
      .brand-name { font: 700 34px/38px Geist, sans-serif; }
      .brand-tag { margin-top: 3px; color: #AFC6FF; font: 600 14px/20px Geist, sans-serif; }
      .live { width: max-content; display: flex; align-items: center; margin-top: 41px; padding: 7px 16px; border: 1px solid rgba(175,198,255,.3); border-radius: 999px; background: rgba(175,198,255,.1); color: #AFC6FF; font: 600 15px/20px Geist, sans-serif; }
      .live i { width: 10px; height: 10px; margin-right: 11px; border-radius: 50%; background: #4ADE80; }
      h1 { margin: 31px 0 0; font: 700 62px/1.08 Geist, sans-serif; letter-spacing: 0; }
      .summary { margin-top: 22px; color: #C2C6D6; font: 400 21px/31px Inter, sans-serif; }
      .steps { display: flex; gap: 14px; margin-top: 34px; }
      .step { height: 48px; display: flex; align-items: center; padding: 0 22px; border: 1px solid rgba(255,255,255,.1); border-radius: 12px; background: #131A2E; color: #AFC6FF; font: 600 16px/20px Geist, sans-serif; }
      .step:nth-child(1), .step:nth-child(2) { width: 184px; }
      .step:nth-child(3) { width: 214px; }
      .review { width: 338px; height: 482px; display: flex; flex-direction: column; padding: 28px; border: 1px solid rgba(175,198,255,.3); border-radius: 18px; background: #131A2E; }
      .review-label { color: #AFC6FF; font: 600 14px/20px Geist, sans-serif; }
      .review-card { height: 88px; display: flex; flex-direction: column; justify-content: center; margin-top: 20px; padding: 0 20px; border: 1px solid rgba(255,255,255,.1); border-radius: 12px; background: #1D1F27; }
      .review-card span, .plan span { color: #C2C6D6; font-size: 14px; }
      .review-card strong { margin-top: 6px; color: #FFB77B; font: 700 26px/30px Geist, sans-serif; }
      .arrow { height: 68px; display: grid; place-items: center; color: #4F8CFF; font: 400 34px/34px Geist, sans-serif; }
      .plan { height: 132px; display: flex; flex-direction: column; justify-content: center; padding: 0 20px; border: 1px solid rgba(79,140,255,.5); border-radius: 12px; background: rgba(175,198,255,.08); }
      .plan span { color: #AFC6FF; }
      .plan strong { margin-top: 8px; font: 700 30px/34px Geist, sans-serif; }
      .plan em { margin-top: 5px; color: #4ADE80; font: normal 400 15px/20px Inter, sans-serif; }
      .cta { height: 62px; display: grid; place-items: center; margin-top: 28px; border-radius: 12px; background: linear-gradient(90deg,#4F8CFF,#7B61FF); color: #fff; font: 700 18px/22px Geist, sans-serif; }
      footer { position: absolute; left: 70px; right: 70px; bottom: 29px; display: flex; justify-content: space-between; color: #C2C6D6; font-size: 15px; }
      footer span:last-child { color: #AFC6FF; }
    </style>
  </head>
  <body>
    <section class="left">
      <div class="brand">
        <img src="${logoData}" alt="" />
        <div class="brand-copy"><span class="brand-name">TradeLens</span><span class="brand-tag">AI TRADE SIGNAL PROTECTION</span></div>
      </div>
      <div class="live"><i></i>Live Bitget market checks</div>
      <h1>See the risk before<br />you take the trade.</h1>
      <div class="summary">Paste any crypto signal. TradeLens checks it against live<br />market conditions, explains the risk, and builds a safer plan.</div>
      <div class="steps"><div class="step">01&nbsp;&nbsp;Paste signal</div><div class="step">02&nbsp;&nbsp;Check risk</div><div class="step">03&nbsp;&nbsp;Compare plans</div></div>
    </section>
    <aside class="review">
      <div class="review-label">TRADE REVIEW</div>
      <div class="review-card"><span>ORIGINAL SIGNAL</span><strong>Needs review</strong></div>
      <div class="arrow">↓</div>
      <div class="plan"><span>TRADELENS PLAN</span><strong>Risk adjusted</strong><em>Live context + safer sizing</em></div>
      <div class="cta">Review before you follow</div>
    </aside>
    <footer><span>Built for Bitget AI Base Camp</span><span>Powered by Qwen AI</span></footer>
  </body>
</html>`;

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(document, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(root, "public/og-tradelens.png"), type: "png" });
} finally {
  await browser.close();
}

console.log("Generated public/og-tradelens.png (1200x630)");
