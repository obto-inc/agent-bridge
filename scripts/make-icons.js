'use strict';
// Renders extension/icons/*.png from the OBTO app icon (Tile mark on violet).
// Toolbar sizes are full bleed; icon128 follows the store rule: 96 px artwork
// with 16 px transparent padding. Needs a Chromium for playwright-core:
//   CHROME=/path/to/chrome node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="24" fill="#7C6CF2"/>' +
  '<g transform="translate(12.9 14) scale(0.72)"><path d="M56 18H32Q18 18 18 32V68Q18 82 32 82H68Q82 82 82 68V56" fill="none" stroke="#F5F3EF" ' +
  'stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><circle cx="80" cy="26" r="11" fill="#121214"/></g></svg>';
const OUT = path.join(__dirname, '..', 'extension', 'icons');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const page = await browser.newPage();
  for (const [size, art] of [[16, 16], [32, 32], [48, 48], [128, 96]]) {
    const pad = (size - art) / 2;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent('<html><body style="margin:0;background:transparent"><div style="width:' + size + 'px;height:' + size +
      'px;padding:' + pad + 'px;box-sizing:border-box">' + SVG.replace('<svg ', '<svg width="' + art + '" height="' + art + '" ') + '</div></body></html>');
    await page.screenshot({ path: path.join(OUT, 'icon' + size + '.png'), omitBackground: true });
  }
  await browser.close();
  console.log('icons written to ' + OUT);
})();
