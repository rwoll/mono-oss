import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnnotateDocumentInput } from '../src/index.ts';
import { drawGrid, probe, render } from '../src/node/index.ts';
import { API_KEY_COLOR, LAYOUT, pixel, writeScreen } from './fixtures.ts';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'annotate-test-'));
  await writeScreen(join(dir, 'after.png'), 'after');
  await writeScreen(join(dir, 'before.png'), 'before');
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function renderDoc(doc: Omit<AnnotateDocumentInput, 'version'>, out: string, options: { at?: number; width?: number } = {}) {
  const path = join(dir, `${out}.json`);
  await writeFile(path, JSON.stringify({ version: 1, ...doc }));
  return render(path, { out: join(dir, out), ...options });
}

describe('render stills', () => {
  it('reads the source size from the file', async () => {
    expect(await probe(join(dir, 'after.png'))).toEqual({ kind: 'image', width: 1280, height: 800 });
    const result = await renderDoc({ source: { path: 'after.png' } }, 'plain.png');
    expect(result).toMatchObject({ width: 1280, height: 800, frames: 1, format: 'png' });
  });

  it('adds the notes panel below a wide image and beside a tall one, leaving the image as it was', async () => {
    const annotations = [{ type: 'rect' as const, box: LAYOUT.save, note: 'Save is 8 px short of the card edge.' }];
    const below = await renderDoc({ source: { path: 'after.png' }, annotations }, 'notes-below.png');
    expect(below.width).toBe(1280);
    expect(below.height).toBeGreaterThan(800);
    expect(await pixel(join(dir, 'notes-below.png'), 10, 10)).toEqual(await pixel(join(dir, 'after.png'), 10, 10));
    expect(await pixel(join(dir, 'notes-below.png'), 640, below.height - 4)).toEqual({ r: 0xf6, g: 0xf8, b: 0xfa });
    const beside = await renderDoc({ source: { path: 'after.png' }, annotations, notes: { side: 'right' } }, 'notes-right.png');
    expect(beside).toMatchObject({ height: 800 });
    expect(beside.width).toBeGreaterThan(1280);
  });

  it('redacts source pixels with a solid fill', async () => {
    const [x, y, w, h] = LAYOUT.apiKey;
    expect(await pixel(join(dir, 'after.png'), x + w / 2, y + h / 2)).toEqual(API_KEY_COLOR);
    await renderDoc({ source: { path: 'after.png' }, annotations: [{ type: 'redact', box: LAYOUT.apiKey }] }, 'redacted.png');
    expect(await pixel(join(dir, 'redacted.png'), x + w / 2, y + h / 2)).toEqual({ r: 0x24, g: 0x29, b: 0x2f });
  });

  it('pixelates into blocks of one color', async () => {
    const field: [number, number, number, number] = [284, 230, 400, 36];
    const a = [297, 243] as const;
    const b = [306, 252] as const;
    await renderDoc({ source: { path: 'after.png' }, annotations: [{ type: 'redact', box: field, style: 'pixelate' }] }, 'pixelated.png');
    expect(await pixel(join(dir, 'pixelated.png'), ...a)).toEqual(await pixel(join(dir, 'pixelated.png'), ...b));
  });

  it('follows the camera: a zoom on the Save button fills the frame with it', async () => {
    const result = await renderDoc({ source: { path: 'after.png' }, camera: [{ type: 'zoom', time: [0, 4], box: LAYOUT.save }] }, 'zoom.png', { at: 2 });
    expect(result).toMatchObject({ width: 1280, height: 800 });
    // The shot frames x 648-968, y 270-470 at 4×: output (400, 345) is source (748, 356), inside the button.
    const inside = await pixel(join(dir, 'zoom.png'), 400, 345);
    expect(inside.g).toBeGreaterThan(inside.r + 60);
  });

  it('shows before left of the wipe and after right of it', async () => {
    const [x, y] = [736, 372];
    const wipe = (position: number) =>
      renderDoc({ source: { path: 'after.png' }, compare: { before: { path: 'before.png' }, track: [[0, position]] } }, `wipe-${position}.png`);
    await wipe(0);
    await wipe(1);
    const before = await pixel(join(dir, 'wipe-0.png'), x, y);
    const after = await pixel(join(dir, 'wipe-1.png'), x, y);
    expect(before.g).toBeGreaterThan(before.r + 60);
    expect(after).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('draws a lens over the frame and resizes the output', async () => {
    const result = await renderDoc(
      { source: { path: 'after.png' }, annotations: [{ type: 'magnify', box: LAYOUT.footer, into: [300, 500, 700, 120], label: 'Footer' }] },
      'lens.png',
      { width: 640 },
    );
    expect(result).toMatchObject({ width: 640, height: 400 });
    expect(await pixel(join(dir, 'lens.png'), 325, 280)).not.toEqual(await pixel(join(dir, 'plain.png'), 650, 560));
  });

  it.each(['jpg', 'webp', 'avif'])('writes .%s', async ext => {
    await renderDoc({ source: { path: 'after.png' }, annotations: [{ type: 'rect', box: LAYOUT.save, label: 'Save' }] }, `marked.${ext}`);
    expect(await sharp(join(dir, `marked.${ext}`)).metadata()).toMatchObject({ width: 1280, height: 800 });
  });

  it('draws a coordinate grid', async () => {
    expect(await drawGrid(join(dir, 'after.png'), join(dir, 'grid.png'), { step: 50 })).toEqual({ width: 1280, height: 800 });
  });

  it('never writes over the source', async () => {
    await expect(renderDoc({ source: { path: 'after.png' } }, 'after.png')).rejects.toThrow(/own media/);
  });

  it('refuses a video for a document without a timeline', async () => {
    await expect(renderDoc({ source: { path: 'after.png' } }, 'still.mp4')).rejects.toThrow(/no timeline/);
  });
});
