// Capture Pulse's equivalent views, for comparison.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } });
await page.goto('http://localhost:5177', { waitUntil: 'domcontentloaded' });
await page.locator('.big-btn').click({ timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => !!window.pulseStore, null, { timeout: 20000 });
await page.waitForTimeout(900);

for (const [view, file] of [['steps', 'pulse-steps.png'], ['sound', 'pulse-sound.png'],
                            ['mixer', 'pulse-mixer.png']]) {
  await page.evaluate((v) => window.pulseStore.getState().setView(v), view);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `shots/${file}` });
}
await browser.close();
