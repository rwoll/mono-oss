import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { render } from '../src/node/index.ts';
import { writeScreen } from './fixtures.ts';

const hasFfmpeg = spawnSync(process.env.ANNOTATE_FFMPEG ?? 'ffmpeg', ['-version']).status === 0;
const ffprobe = (path: string, entries: string) =>
  spawnSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', path], { encoding: 'utf8' }).stdout;
const quiet = { stdout: { write: () => true }, stderr: { write: () => true } };

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'annotate-video-'));
  await writeScreen(join(dir, 'after.png'), 'after');
  await writeScreen(join(dir, 'before.png'), 'before');
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe.skipIf(!hasFfmpeg)('render video', () => {
  it('renders a screenshot tour to MP4 with a subtitle track', async () => {
    const doc = join(dir, 'tour.json');
    await writeFile(
      doc,
      JSON.stringify({
        version: 1,
        source: { path: 'after.png' },
        duration: 1.5,
        compare: { before: { path: 'before.png' }, track: [[0, 0], [1, 1]] },
        camera: [{ type: 'zoom', time: [0.2, 1.4], box: [740, 352, 136, 36], ease: 0.3 }],
        narration: [{ t: 0, text: 'Before and after', end: 1.5 }],
      }),
    );
    const progress: number[] = [];
    const result = await render(doc, { out: join(dir, 'tour.mp4'), width: 320, fps: 10, captions: 'soft', onProgress: ({ frame }) => progress.push(frame) });
    expect(result).toMatchObject({ width: 320, height: 200, frames: 15, format: 'mp4' });
    expect(progress.at(-1)).toBe(15);
    const info = JSON.parse(ffprobe(join(dir, 'tour.mp4'), 'stream=codec_type,codec_name,width,height,nb_frames')) as { streams: Record<string, unknown>[] };
    expect(info.streams).toEqual([
      expect.objectContaining({ codec_type: 'video', codec_name: 'h264', width: 320, height: 200, nb_frames: '15' }),
      expect.objectContaining({ codec_type: 'subtitle', codec_name: 'mov_text' }),
    ]);
  });

  it('annotates a screen recording, redacting every frame', async () => {
    const recording = join(dir, 'recording.webm');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x200:rate=10:duration=1.5', '-c:v', 'libvpx-vp9', recording]);
    expect(made.status).toBe(0);
    expect(await main(['init', recording], quiet)).toBe(0);
    const docPath = join(dir, 'recording.annotate.json');
    const doc = JSON.parse(await readFile(docPath, 'utf8')) as Record<string, unknown>;
    expect(doc.source).toMatchObject({ path: 'recording.webm', width: 320, height: 200, duration: 1.5 });
    await writeFile(docPath, JSON.stringify({ ...doc, annotations: [{ type: 'redact', box: [0, 0, 160, 100] }, { type: 'rect', box: [200, 120, 60, 40], label: 'Here' }] }));
    expect(await main(['render', docPath, '-o', join(dir, 'recording.mp4'), '-o', join(dir, 'recording.gif'), '--fps', '10'], quiet)).toBe(0);
    // Every frame of the redacted corner is the fill color (allowing for compression).
    const frames = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'recording.mp4'), '-vf', 'crop=120:80:20:10', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
      maxBuffer: 64 * 1024 * 1024,
    }).stdout;
    expect(frames.length).toBe(120 * 80 * 3 * 15);
    let worst = 0;
    for (let i = 0; i < frames.length; i += 3) {
      worst = Math.max(worst, Math.abs((frames[i] as number) - 0x24), Math.abs((frames[i + 1] as number) - 0x29), Math.abs((frames[i + 2] as number) - 0x2f));
    }
    expect(worst).toBeLessThan(12);
    expect(JSON.parse(ffprobe(join(dir, 'recording.gif'), 'stream=codec_name')).streams[0].codec_name).toBe('gif');

    // A recording converted for players that cannot open WebM.
    expect(await main(['convert', recording, '-o', join(dir, 'recording-h264.mp4')], quiet)).toBe(0);
    expect(JSON.parse(ffprobe(join(dir, 'recording-h264.mp4'), 'stream=codec_name,width,height')).streams).toEqual([{ codec_name: 'h264', width: 320, height: 200 }]);
  });
});
