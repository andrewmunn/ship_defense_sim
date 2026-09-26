// Production browser smoke test: validation, repeated combat/restart cleanup, runtime errors.
// Run npm run build first.
import { preview } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0, open: false } });
const port = server.httpServer.address().port;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] : [],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?scenario=LeakerDrill`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  const initialId = await page.evaluate(() => window.game.world.ship.id);
  await page.locator('#setup [data-f=count]').fill('0');
  await page.locator('#setup [data-a=go]').click();
  assert.equal(await page.evaluate(() => window.game.world.ship.id), initialId);
  assert.match(await page.locator('#setup .scenario-errors').innerText(), /count/);
  console.log('Invalid raid blocked with a visible validation error');
  await page.locator('#setup [data-f=count]').fill('2');
  await page.locator('#setup [data-k=seed]').fill('');
  await page.locator('#setup [data-a=go]').click();
  assert.equal(await page.evaluate(() => window.game.world.ship.id), initialId);
  assert.match(await page.locator('#setup .scenario-errors').innerText(), /Random seed/);
  await page.locator('#setup [data-k=seed]').fill('1');
  await page.locator('#setup [data-a=go]').click();
  await page.waitForFunction(id => window.game.world.ship.id !== id, initialId);
  await page.evaluate(() => {
    game.setPaused(true);
    game.setAutoTime(false);
    director.setActive(false);
    // Terrain LOD grows independently of combat; hold it constant for this resource assertion.
    game.terrainView.update = () => {};
  });
  const memory = [];
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => { game.restart(game.cfg); game.advance(165); });
    const frames = await page.evaluate(() => game.frames);
    await page.waitForFunction(f => game.frames >= f + 4, frames, { timeout: 30000 });
    memory.push(await page.evaluate(() => ({
      geometries: game.R.renderer.info.memory.geometries,
      textures: game.R.renderer.info.memory.textures,
      programs: game.R.renderer.info.programs.length,
      time: game.world.t,
    })));
  }
  assert.deepEqual(memory[2], memory[1]);
  console.log('Repeated combat/restart resources stable:', JSON.stringify(memory));
  await page.evaluate(() => { game.setTimeScale(0.05); game.setPaused(false); });
  await page.waitForFunction(() => Math.abs(game.shipView.root.matrix.elements[12] - game.world.ship.pos.x) > 1e-5, null, { timeout: 30000 });
  await page.evaluate(() => game.setPaused(true));
  console.log('Slow motion interpolates displayed poses between physics steps');
  assert.deepEqual(errors, []);
  console.log('No runtime or shader errors');
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
