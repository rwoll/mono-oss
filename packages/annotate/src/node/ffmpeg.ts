import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { basename, dirname, join } from 'node:path';
import { AnnotateError } from '../document.ts';

export interface FfmpegOptions {
  /** Path to ffmpeg. Default: the ANNOTATE_FFMPEG environment variable, else `ffmpeg` on PATH. */
  ffmpeg?: string | undefined;
}

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

const INSTALL_HINT =
  'Video needs ffmpeg. Install it (macOS: `brew install ffmpeg`; Debian or Ubuntu: `sudo apt install ffmpeg`; Windows: `winget install ffmpeg`), or pass --ffmpeg <path> or set ANNOTATE_FFMPEG.';

const verified = new Map<string, Promise<FfmpegPaths>>();

/** Finds ffmpeg and ffprobe (next to ffmpeg when it is a path), and checks that ffmpeg runs. */
export function findFfmpeg(options: FfmpegOptions = {}): Promise<FfmpegPaths> {
  const ffmpeg = options.ffmpeg ?? process.env.ANNOTATE_FFMPEG ?? 'ffmpeg';
  let pending = verified.get(ffmpeg);
  if (!pending) {
    const name = basename(ffmpeg);
    const ffprobe =
      process.env.ANNOTATE_FFPROBE ?? (ffmpeg.includes('/') || ffmpeg.includes('\\') ? join(dirname(ffmpeg), name.replace(/ffmpeg/i, 'ffprobe')) : 'ffprobe');
    pending = run(ffmpeg, ['-hide_banner', '-version']).then(
      () => ({ ffmpeg, ffprobe }),
      error => {
        verified.delete(ffmpeg);
        throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new AnnotateError('ffmpeg_missing', INSTALL_HINT) : error;
      },
    );
    verified.set(ffmpeg, pending);
  }
  return pending;
}

/** Runs a command to completion; rejects with the end of its stderr when it fails. */
export function run(command: string, args: readonly string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8000);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr });
      else reject(new AnnotateError('command_failed', `${basename(command)} exited with ${code}: ${lastLines(stderr)}`));
    });
  });
}

const lastLines = (text: string) => text.trim().split('\n').slice(-4).join('\n') || '(no output)';

/** Reads a video's size (after rotation) and duration. */
export async function probeVideo(path: string, options: FfmpegOptions = {}): Promise<{ width: number; height: number; duration: number }> {
  const { ffmpeg, ffprobe } = await findFfmpeg(options);
  const { stdout } = await run(ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration:stream_tags=rotate:stream_side_data=rotation:format=duration',
    '-of', 'json',
    path,
  ]);
  const info = JSON.parse(stdout.toString('utf8')) as {
    streams?: { width?: number; height?: number; duration?: string; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[];
    format?: { duration?: string };
  };
  const stream = info.streams?.[0];
  if (!stream?.width || !stream.height) throw new AnnotateError('no_video', `${path} has no video stream.`);
  const rotation = Math.abs(Number(stream.tags?.rotate ?? stream.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? 0)) % 180;
  const [width, height] = rotation === 90 ? [stream.height, stream.width] : [stream.width, stream.height];
  let duration = Number(stream.duration ?? info.format?.duration);
  // Live recordings, such as Playwright's WebM, may not record their length: decode to find it.
  if (!Number.isFinite(duration) || duration <= 0) {
    const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', path, '-map', '0:v:0', '-f', 'null', '-']);
    const times = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    const last = times.at(-1);
    duration = last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : 0;
  }
  return { width, height, duration: Math.round(duration * 1000) / 1000 };
}

/** Decodes a video into RGBA frames of exactly width×height at a frame rate, starting at 0. */
export async function* decodeFrames(path: string, size: { width: number; height: number; fps: number }, options: FfmpegOptions = {}): AsyncGenerator<Buffer> {
  const { ffmpeg } = await findFfmpeg(options);
  const { width, height, fps } = size;
  const child = spawn(
    ffmpeg,
    ['-v', 'error', '-i', path, '-an', '-vf', `fps=${fps},scale=${width}:${height}:flags=lanczos`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-8000);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const frameSize = width * height * 4;
  let pending: Buffer[] = [];
  let pendingSize = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending.push(chunk);
      pendingSize += chunk.length;
      while (pendingSize >= frameSize) {
        const all = Buffer.concat(pending, pendingSize);
        yield all.subarray(0, frameSize);
        const rest = all.subarray(frameSize);
        pending = rest.length ? [Buffer.from(rest)] : [];
        pendingSize = rest.length;
      }
    }
    const code = await exited;
    if (code !== 0) throw new AnnotateError('command_failed', `ffmpeg could not decode ${path}: ${lastLines(stderr)}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

/** Decodes the frame at a time, as RGBA of exactly width×height. */
export async function extractFrame(path: string, t: number, size: { width: number; height: number }, options: FfmpegOptions = {}): Promise<Buffer> {
  const { ffmpeg } = await findFfmpeg(options);
  const { stdout } = await run(ffmpeg, [
    '-v', 'error',
    '-ss', String(Math.max(0, t)),
    '-i', path,
    '-frames:v', '1',
    '-vf', `scale=${size.width}:${size.height}:flags=lanczos`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-',
  ]);
  if (stdout.length >= size.width * size.height * 4) return stdout.subarray(0, size.width * size.height * 4);
  // Past the last frame: use the last one.
  if (t > 0) return extractFrame(path, Math.max(0, t - 0.5), size, options);
  throw new AnnotateError('command_failed', `ffmpeg returned no frame from ${path}.`);
}

export type VideoFormat = 'mp4' | 'webm' | 'gif';

/** Feeds RGBA frames to ffmpeg, which encodes them to a file. */
export class FrameEncoder {
  readonly #child: ChildProcessByStdio<Writable, null, Readable>;
  readonly #exited: Promise<void>;
  #stderr = '';

  constructor(ffmpeg: string, out: string, format: 'mp4' | 'webm', size: { width: number; height: number; fps: number }, subtitles?: string) {
    const input = ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${size.width}x${size.height}`, '-r', String(size.fps), '-i', '-'];
    const subtitleInput = subtitles ? ['-i', subtitles] : [];
    const map = subtitles ? ['-map', '0:v', '-map', '1:s', '-c:s', format === 'mp4' ? 'mov_text' : 'webvtt'] : [];
    const codec =
      format === 'mp4'
        ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
        : ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p'];
    this.#child = spawn(ffmpeg, [...input, ...subtitleInput, ...map, ...codec, out], { stdio: ['pipe', 'ignore', 'pipe'] });
    this.#child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-8000);
    });
    this.#exited = new Promise((resolve, reject) => {
      this.#child.on('error', reject);
      this.#child.on('close', code => (code === 0 ? resolve() : reject(new AnnotateError('command_failed', `ffmpeg could not encode ${out}: ${lastLines(this.#stderr)}`))));
    });
    // Surface encoder failures through write() and end() instead of as an unhandled rejection.
    this.#exited.catch(() => {});
    this.#child.stdin.on('error', () => {});
  }

  async write(frame: Buffer): Promise<void> {
    if (this.#child.exitCode !== null) await this.#exited;
    if (!this.#child.stdin.write(frame)) {
      await Promise.race([new Promise(resolve => this.#child.stdin.once('drain', resolve)), this.#exited]);
    }
  }

  async end(): Promise<void> {
    this.#child.stdin.end();
    await this.#exited;
  }

  kill(): void {
    if (this.#child.exitCode === null) this.#child.kill('SIGKILL');
  }
}

/** Converts a video to an optimized GIF with a palette made from its frames. */
export async function toGif(ffmpeg: string, input: string, out: string, palette: string, fps: number): Promise<void> {
  await run(ffmpeg, ['-y', '-v', 'error', '-i', input, '-vf', `fps=${fps},palettegen=stats_mode=diff`, palette]);
  await run(ffmpeg, ['-y', '-v', 'error', '-i', input, '-i', palette, '-lavfi', `fps=${fps}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, out]);
}

/**
 * Re-encodes a video without audio as H.264 MP4 (.mp4) or VP9 WebM (.webm). MP4 plays in
 * every browser, chat app, and pull request, including browsers that cannot open WebM.
 */
export async function convertVideo(input: string, out: string, options: FfmpegOptions = {}): Promise<void> {
  const { ffmpeg } = await findFfmpeg(options);
  const webm = /\.webm$/i.test(out);
  if (!webm && !/\.(mp4|m4v)$/i.test(out)) throw new AnnotateError('unsupported_output', `Convert to .mp4 or .webm, not ${basename(out)}.`);
  const codec = webm
    ? ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '5']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart'];
  await run(ffmpeg, ['-y', '-v', 'error', '-i', input, '-an', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', ...codec, out]);
}
