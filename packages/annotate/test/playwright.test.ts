import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render } from '../src/node/index.ts';
import { keyLabel, recorder, screenshotDocument } from '../src/playwright.ts';

const hasBrowser = existsSync(chromium.executablePath());
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const PAGE = `<!doctype html><body style="margin:0;font:16px sans-serif">
<button id="save" style="position:absolute;left:100px;top:50px;width:120px;height:40px">Save</button>
<input id="name" style="position:absolute;left:100px;top:150px;width:200px;height:30px">
<script>document.getElementById('save').onclick = () => document.title = 'clicked';
document.onkeydown = e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') document.title += '+saved' }</script></body>`;

let dir: string;
let browser: Browser;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'annotate-pw-'));
  if (hasBrowser) browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!hasBrowser)('Playwright helpers', () => {
  it('measures locators in screenshot pixels and writes the document', async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 2 });
    await page.setContent(PAGE);
    const { document, documentPath } = await screenshotDocument(page, {
      path: join(dir, 'shot.png'),
      annotations: [{ type: 'rect', locator: page.locator('#save'), pad: 0, label: 'Save' }],
    });
    expect(document.source).toEqual({ path: 'shot.png', width: 800, height: 600, scale: 2 });
    expect(document.annotations[0]).toMatchObject({ type: 'rect', box: [200, 100, 240, 80], target: expect.stringContaining('#save') });
    expect(JSON.parse(await readFile(documentPath, 'utf8'))).toEqual(document);
    await page.close();
  });

  it.skipIf(!hasFfmpeg)('records input alongside a video and renders it', async () => {
    // Device pixel ratio 2 does not change the video: Playwright records CSS pixels.
    const context = await browser.newContext({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 2, recordVideo: { dir, size: { width: 400, height: 300 } } });
    const page = await context.newPage();
    const rec = recorder(page, { scale: 1 });
    await page.setContent(PAGE);
    rec.narrate('Type a name, then save');
    await rec.type(page.locator('#name'), 'Ada', { delay: 30 });
    await rec.click(page.locator('#save'));
    await rec.press('ControlOrMeta+s');
    expect(await rec.box(page.locator('#save'), { pad: 0 })).toEqual([100, 50, 120, 40]);
    await page.waitForTimeout(500);
    expect(await page.title()).toBe('clicked+saved');
    const video = await page.video()?.path();
    await context.close();
    expect(rec.events.map(event => event.type)).toEqual(['type', 'click', 'key']);
    expect(rec.events[1]?.at).toEqual([160, 70]);
    const result = await render(rec.document({ path: video as string }), { out: join(dir, 'recording.mp4'), baseDir: dir });
    expect(result).toMatchObject({ format: 'mp4', width: 400, height: 300 });
  });

  it('labels keys the way people read them', () => {
    expect(keyLabel('ControlOrMeta+s')).toBe('⌘S');
    expect(keyLabel('Shift+Enter')).toBe('⇧↵');
  });
});
