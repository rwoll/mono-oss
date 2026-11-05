import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import type { Rect } from '../camera.ts';
import { AnnotateError, resolveDocument, type ResolvedDocument } from '../document.ts';
import { frameAt, svgDocument, type Frame, type Magnifier, type Redaction } from '../frame.ts';
import { mediaKind, outputKind, type OutputFormat } from '../media.ts';
import { toVtt } from '../narration.ts';
import { notesPanel, type NotesPanel } from '../notes.ts';
import type { AnnotateDocument, Media } from '../schema.ts';
import { decodeFrames, extractFrame, findFfmpeg, FrameEncoder, toGif, type FfmpegOptions } from './ffmpeg.ts';
import { completeDocument, loadDocument, mediaPath } from './load.ts';

export interface RenderOptions extends FfmpegOptions {
  /** Output file. Its extension picks the format: .png .jpg .webp .avif (stills) or .mp4 .webm .gif (video). */
  out: string;
  /** For stills: the time to render, in seconds. Default: the end of the timeline. */
  at?: number | undefined;
  /** Output width in pixels. Default: the document's output.width, else the source width (at most 1920 for video, 960 for GIF). */
  width?: number | undefined;
  /** Video frame rate. Default: the document's output.fps, else 30 (12 for GIF). */
  fps?: number | undefined;
  /** burn (default) draws captions into the pixels; soft adds a subtitle track (MP4, WebM); none leaves them out. */
  captions?: 'burn' | 'soft' | 'none' | undefined;
  /** Also write the captions as WebVTT to this file. */
  vtt?: string | undefined;
  /** Folder that media paths are relative to, when the document is passed as an object. Default: the working directory. */
  baseDir?: string | undefined;
  /** Called after each video frame. */
  onProgress?: ((progress: { frame: number; frames: number }) => void) | undefined;
}

export interface RenderResult {
  out: string;
  format: OutputFormat;
  width: number;
  height: number;
  /** 1 for stills. */
  frames: number;
  /** Seconds of video; 0 for stills. */
  duration: number;
}

interface Raw {
  data: Buffer;
  width: number;
  height: number;
}

const RAW = (width: number, height: number) => ({ raw: { width, height, channels: 4 as const } });
const clampInt = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

/** Renders a document (or a document file) to a still or a video, chosen by the output's extension. */
export async function render(input: string | AnnotateDocument, options: RenderOptions): Promise<RenderResult> {
  const loaded = typeof input === 'string' ? await loadDocument(input) : { doc: input, baseDir: resolve(options.baseDir ?? '.') };
  const output = outputKind(options.out);
  if (!output) throw new AnnotateError('unsupported_output', `Cannot tell the format of ${options.out}; use .png, .jpg, .webp, .avif, .mp4, .webm, or .gif.`);
  const out = resolve(options.out);
  for (const media of [loaded.doc.source, loaded.doc.compare?.before]) {
    if (media && resolve(mediaPath(media, loaded.baseDir)) === out) {
      throw new AnnotateError('overwrites_source', `${options.out} is the document's own media; render to another file.`);
    }
  }
  const doc = await completeDocument(loaded.doc, loaded.baseDir, options);
  const resolved = resolveDocument(doc);
  await mkdir(dirname(resolve(options.out)), { recursive: true });
  if (options.vtt) await writeFile(options.vtt, toVtt(resolved.cues));
  if (output.kind === 'image') return renderStill(resolved, loaded.baseDir, output.format, options);
  if (resolved.duration <= 0) throw new AnnotateError('nothing_to_animate', 'The document has no timeline (no duration, times, camera, or narration); render a still such as .png instead.');
  return renderVideo(resolved, loaded.baseDir, output.format as 'mp4' | 'webm' | 'gif', options);
}

function outputSize(resolved: ResolvedDocument, requested: number | undefined, cap: number, even: boolean) {
  let width = Math.round(requested ?? resolved.doc.output?.width ?? Math.min(resolved.width, cap));
  let height = Math.round((width * resolved.height) / resolved.width);
  if (even) {
    width -= width % 2;
    height -= height % 2;
  }
  return { width: Math.max(2, width), height: Math.max(2, height) };
}

async function renderStill(resolved: ResolvedDocument, baseDir: string, format: OutputFormat, options: RenderOptions): Promise<RenderResult> {
  const { width: imageWidth, height: imageHeight } = outputSize(resolved, options.width, Infinity, false);
  const t = options.at ?? resolved.duration;
  const frame = frameAt(resolved, t, { width: imageWidth, height: imageHeight, captions: options.captions !== 'none', animate: false });
  const panel = notesPanel(resolved, t, { width: imageWidth, height: imageHeight });
  const { width, height } = canvasSize(imageWidth, imageHeight, panel, false);
  const main = await stillSource(resolved.doc.source, resolved, baseDir, t, options);
  const before = resolved.doc.compare ? await stillSource(resolved.doc.compare.before, resolved, baseDir, t, options) : undefined;
  const data = await withNotes(await composeFrame(frame, redact(main, frame.redactions), before && redact(before, frame.redactions)), frame, panel, width, height);
  let image = sharp(data, RAW(width, height));
  if (format === 'png') image = image.png();
  else if (format === 'jpeg') image = image.flatten({ background: '#ffffff' }).jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true });
  else if (format === 'webp') image = image.webp({ quality: 90 });
  else if (format === 'avif') image = image.avif({ quality: 65, chromaSubsampling: '4:4:4' });
  await image.toFile(options.out);
  return { out: options.out, format, width, height, frames: 1, duration: 0 };
}

/** Loads media as RGBA at the document's source size, the frame at time t for a video. */
async function stillSource(media: Media, resolved: ResolvedDocument, baseDir: string, t: number, options: FfmpegOptions): Promise<Raw> {
  const path = mediaPath(media, baseDir);
  const { width, height } = resolved;
  if (mediaKind(path) === 'video') return { data: await extractFrame(path, t, { width, height }, options), width, height };
  const data = await sharp(path).autoOrient().resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  return { data, width, height };
}

interface FrameSource {
  frame(index: number): Promise<Raw>;
  close(): void;
}

async function videoSource(media: Media, resolved: ResolvedDocument, baseDir: string, fps: number, options: FfmpegOptions): Promise<FrameSource> {
  const path = mediaPath(media, baseDir);
  const { width, height } = resolved;
  if (mediaKind(path) !== 'video') {
    const still = await stillSource(media, resolved, baseDir, 0, options);
    return { frame: async () => still, close: () => {} };
  }
  const frames = decodeFrames(path, { width, height, fps }, options);
  let last: Raw | undefined;
  let next = 0;
  let done = false;
  return {
    async frame(index) {
      while (!done && next <= index) {
        const step = await frames.next();
        if (step.done) done = true;
        else last = { data: step.value, width, height };
        next += 1;
      }
      if (!last) throw new AnnotateError('command_failed', `ffmpeg returned no frames from ${path}.`);
      return last;
    },
    close: () => void frames.return(undefined),
  };
}

async function renderVideo(resolved: ResolvedDocument, baseDir: string, format: 'mp4' | 'webm' | 'gif', options: RenderOptions): Promise<RenderResult> {
  const { ffmpeg } = await findFfmpeg(options);
  const gif = format === 'gif';
  if (gif && options.captions === 'soft') throw new AnnotateError('unsupported_output', 'GIFs cannot carry a subtitle track; use --captions burn or none.');
  const fps = options.fps ?? resolved.doc.output?.fps ?? (gif ? 12 : 30);
  const { width: imageWidth, height: imageHeight } = outputSize(resolved, options.width, gif ? 960 : 1920, true);
  // The panel's size does not depend on time, so the first frame's sizes the canvas.
  const { width, height } = canvasSize(imageWidth, imageHeight, notesPanel(resolved, 0, { width: imageWidth, height: imageHeight }), true);
  const frames = Math.max(1, Math.round(resolved.duration * fps));
  const work = await mkdtemp(join(tmpdir(), 'annotate-'));
  const main = await videoSource(resolved.doc.source, resolved, baseDir, fps, options);
  const before = resolved.doc.compare ? await videoSource(resolved.doc.compare.before, resolved, baseDir, fps, options) : undefined;
  let subtitles: string | undefined;
  if (options.captions === 'soft' && resolved.cues.length) {
    subtitles = join(work, 'captions.vtt');
    await writeFile(subtitles, toVtt(resolved.cues));
  }
  const target = gif ? join(work, 'frames.mp4') : options.out;
  const encoder = new FrameEncoder(ffmpeg, target, gif ? 'mp4' : format, { width, height, fps }, subtitles);
  const redacted = new Map<string, { source: Raw; data: Buffer }>();
  // Compose a few frames at once (sharp runs them on its own threads) and write them in order.
  const inFlight: Promise<Buffer>[] = [];
  try {
    for (let index = 0; index < frames; index += 1) {
      const t = index / fps;
      const frame = frameAt(resolved, t, { width: imageWidth, height: imageHeight, captions: (options.captions ?? 'burn') === 'burn' });
      const panel = notesPanel(resolved, t, { width: imageWidth, height: imageHeight });
      const [mainRaw, beforeRaw] = await Promise.all([main.frame(index), before?.frame(index)]);
      const cached = (raw: Raw) => {
        const key = JSON.stringify(frame.redactions);
        const hit = redacted.get(key);
        if (hit && hit.source === raw) return { ...raw, data: hit.data };
        const data = redact(raw, frame.redactions);
        if (redacted.size > 8) redacted.clear();
        redacted.set(key, { source: raw, data: data.data });
        return data;
      };
      inFlight.push(composeFrame(frame, cached(mainRaw), beforeRaw && redact(beforeRaw, frame.redactions)).then(data => withNotes(data, frame, panel, width, height)));
      if (inFlight.length >= 4) await encoder.write(await (inFlight.shift() as Promise<Buffer>));
      options.onProgress?.({ frame: index + 1, frames });
    }
    for (const pending of inFlight.splice(0)) await encoder.write(await pending);
    await encoder.end();
    if (gif) await toGif(ffmpeg, target, options.out, join(work, 'palette.png'), fps);
  } catch (error) {
    encoder.kill();
    await Promise.allSettled(inFlight);
    throw error;
  } finally {
    main.close();
    before?.close();
    await rm(work, { recursive: true, force: true });
  }
  return { out: options.out, format, width, height, frames, duration: frames / fps };
}

/** Hides pixels in the source: solid fill, or blocks of averaged color. Returns a copy when anything changed. */
function redact(image: Raw, redactions: readonly Redaction[]): Raw {
  if (!redactions.length) return image;
  const { width, height } = image;
  const data = Buffer.from(image.data);
  for (const { box, style } of redactions) {
    const x0 = clampInt(Math.floor(box[0]), 0, width);
    const y0 = clampInt(Math.floor(box[1]), 0, height);
    const x1 = clampInt(Math.ceil(box[0] + box[2]), 0, width);
    const y1 = clampInt(Math.ceil(box[1] + box[3]), 0, height);
    if (x1 <= x0 || y1 <= y0) continue;
    const block = style === 'pixelate' ? Math.max(6, Math.round(Math.min(x1 - x0, y1 - y0) / 3)) : Math.max(x1 - x0, y1 - y0);
    for (let by = y0; by < y1; by += block) {
      for (let bx = x0; bx < x1; bx += block) {
        const ex = Math.min(x1, bx + block);
        const ey = Math.min(y1, by + block);
        let r = 0x24;
        let g = 0x29;
        let b = 0x2f;
        if (style === 'pixelate') {
          let sr = 0;
          let sg = 0;
          let sb = 0;
          for (let y = by; y < ey; y += 1) {
            for (let x = bx; x < ex; x += 1) {
              const i = (y * width + x) * 4;
              sr += data[i] as number;
              sg += data[i + 1] as number;
              sb += data[i + 2] as number;
            }
          }
          const count = (ex - bx) * (ey - by);
          r = Math.round(sr / count);
          g = Math.round(sg / count);
          b = Math.round(sb / count);
        }
        for (let y = by; y < ey; y += 1) {
          for (let x = bx; x < ex; x += 1) {
            const i = (y * width + x) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = 255;
          }
        }
      }
    }
  }
  return { data, width, height };
}

/**
 * Crops the camera rect and scales it to the output with sub-pixel accuracy: crop a
 * whole-pixel region around it, scale that, then trim to the exact offset.
 */
async function cameraView(image: Raw, camera: Rect, width: number, height: number): Promise<Buffer> {
  const s = width / camera.w;
  const x0 = clampInt(Math.floor(camera.x), 0, image.width - 1);
  const y0 = clampInt(Math.floor(camera.y), 0, image.height - 1);
  const x1 = clampInt(Math.ceil(camera.x + camera.w) + 1, x0 + 1, image.width);
  const y1 = clampInt(Math.ceil(camera.y + camera.h) + 1, y0 + 1, image.height);
  const rw = Math.max(width, Math.round((x1 - x0) * s));
  const rh = Math.max(height, Math.round((y1 - y0) * s));
  const left = clampInt((camera.x - x0) * s, 0, rw - width);
  const top = clampInt((camera.y - y0) * s, 0, rh - height);
  return sharp(image.data, RAW(image.width, image.height))
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .resize(rw, rh, { fit: 'fill', kernel: s > 1 ? 'mitchell' : 'lanczos3' })
    .extract({ left, top, width, height })
    .raw()
    .toBuffer();
}

async function magnifierLayer(image: Raw, magnifier: Magnifier, frameWidth: number, frameHeight: number): Promise<OverlayOptions | undefined> {
  const [dx, dy, dw, dh] = magnifier.dest;
  const left = Math.round(dx);
  const top = Math.round(dy);
  const width = Math.round(dw);
  const height = Math.round(dh);
  if (width < 2 || height < 2) return undefined;
  const [sx, sy, sw, sh] = magnifier.source;
  const x0 = clampInt(Math.floor(sx), 0, image.width - 1);
  const y0 = clampInt(Math.floor(sy), 0, image.height - 1);
  const x1 = clampInt(Math.ceil(sx + sw), x0 + 1, image.width);
  const y1 = clampInt(Math.ceil(sy + sh), y0 + 1, image.height);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${Math.round(magnifier.radius)}" fill="#fff" fill-opacity="${magnifier.opacity}"/></svg>`,
  );
  const lens = await sharp(image.data, RAW(image.width, image.height))
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .resize(width, height, { fit: 'fill', kernel: 'mitchell' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .raw()
    .toBuffer();
  // Keep the part inside the frame; sharp composites only overlays that fit.
  const cl = Math.max(0, -left);
  const ct = Math.max(0, -top);
  const cw = Math.min(width - cl, frameWidth - Math.max(0, left));
  const ch = Math.min(height - ct, frameHeight - Math.max(0, top));
  if (cw <= 0 || ch <= 0) return undefined;
  const input = cl || ct || cw < width || ch < height ? await sharp(lens, RAW(width, height)).extract({ left: cl, top: ct, width: cw, height: ch }).raw().toBuffer() : lens;
  return { input, ...RAW(cw, ch), left: Math.max(0, left), top: Math.max(0, top) };
}

/** The output size: the image plus the notes panel beside or below it, even in both directions for video. */
function canvasSize(width: number, height: number, panel: NotesPanel | undefined, even: boolean): { width: number; height: number } {
  const up = (value: number) => (even ? value + (value % 2) : value);
  if (!panel) return { width, height };
  if (panel.side === 'right') return { width: up(width + panel.width), height: up(Math.max(height, panel.height)) };
  return { width, height: up(height + panel.height) };
}

/** Puts a composed image on a canvas of the output size, with the notes panel in the rest. */
async function withNotes(image: Buffer, frame: Frame, panel: NotesPanel | undefined, width: number, height: number): Promise<Buffer> {
  if (!panel) return image;
  const right = panel.side === 'right';
  const panelWidth = right ? width - frame.width : width;
  const panelHeight = right ? height : height - frame.height;
  return sharp({ create: { width, height, channels: 4, background: panel.background } })
    .composite([
      { input: image, ...RAW(frame.width, frame.height), left: 0, top: 0 },
      { input: Buffer.from(svgDocument(panel.svg, panelWidth, panelHeight)), left: right ? frame.width : 0, top: right ? 0 : frame.height },
    ])
    .raw()
    .toBuffer();
}

/** Composites one frame's layers. Sources must already be redacted. Returns RGBA. */
async function composeFrame(frame: Frame, main: Raw, before?: Raw): Promise<Buffer> {
  const { width, height } = frame;
  const view = await cameraView(main, frame.camera, width, height);
  const layers: OverlayOptions[] = [];
  if (before && frame.wipe !== undefined) {
    const x = Math.round((1 - frame.wipe) * width);
    if (x > 0) {
      const beforeView = await cameraView(before, frame.camera, width, height);
      const part = x >= width ? beforeView : await sharp(beforeView, RAW(width, height)).extract({ left: 0, top: 0, width: x, height }).raw().toBuffer();
      layers.push({ input: part, ...RAW(Math.min(x, width), height), left: 0, top: 0 });
    }
  }
  if (frame.under) layers.push({ input: Buffer.from(svgDocument(frame.under, width, height)), left: 0, top: 0 });
  for (const magnifier of frame.magnifiers) {
    const layer = await magnifierLayer(main, magnifier, width, height);
    if (layer) layers.push(layer);
  }
  if (frame.over) layers.push({ input: Buffer.from(svgDocument(frame.over, width, height)), left: 0, top: 0 });
  if (!layers.length) return view;
  return sharp(view, RAW(width, height)).composite(layers).raw().toBuffer();
}

/** Draws a labeled coordinate grid over an image, so you can read positions off it. */
export async function drawGrid(path: string, out: string, options: { step?: number } = {}): Promise<{ width: number; height: number }> {
  const step = Math.max(10, Math.round(options.step ?? 100));
  const metadata = await sharp(path).metadata();
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (!width || !height) throw new AnnotateError('unsupported_media', `Could not read the size of ${path}.`);
  const image = sharp(path).autoOrient();
  const fs = Math.max(11, Math.round(Math.min(width, height) / 70));
  const lines: string[] = [];
  const label = (x: number, y: number, text: string, anchor: string) =>
    `<text x="${x}" y="${y}" font-size="${fs}" font-weight="700" text-anchor="${anchor}" fill="#d6006f" stroke="#ffffff" stroke-width="${Math.max(2, fs / 4)}" paint-order="stroke">${text}</text>`;
  for (let x = step; x < width; x += step) {
    const major = x % (step * 5) === 0;
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#d6006f" stroke-opacity="${major ? 0.8 : 0.45}" stroke-width="${major ? 2 : 1}"/>`);
    lines.push(label(x, fs + 2, String(x), 'middle'));
  }
  for (let y = step; y < height; y += step) {
    const major = y % (step * 5) === 0;
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#d6006f" stroke-opacity="${major ? 0.8 : 0.45}" stroke-width="${major ? 2 : 1}"/>`);
    lines.push(label(4, y + fs / 3, String(y), 'start'));
  }
  await mkdir(dirname(resolve(out)), { recursive: true });
  await image.composite([{ input: Buffer.from(svgDocument(lines.join(''), width, height)) }]).png().toFile(out);
  return { width, height };
}
