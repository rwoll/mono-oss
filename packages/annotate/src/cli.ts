import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { AnnotateError, checkDocument, resolveDocument } from './document.ts';
import { toMarkdown, toSrt, toVtt } from './narration.ts';
import { jsonSchema, type AnnotateDocument } from './schema.ts';
import { completeDocument, loadDocument, mediaPath, probe } from './node/load.ts';
import { drawGrid, render } from './node/render.ts';
import { convertVideo } from './node/ffmpeg.ts';

const HELP = `annotate: annotate screenshots and screen recordings from one JSON document.

Usage:
  annotate init <image|video> [-o doc.json] [--before <image>] [--force]
      Write a document for a screenshot or recording, with its size filled in.
  annotate check <doc.json> [--json]
      Validate a document: references, bounds, caption pacing, missing media.
  annotate render <doc.json> -o <out> [-o <out>...] [--at <s>] [--width <px>] [--fps <n>]
                  [--captions burn|soft|none] [--vtt <file>] [--ffmpeg <path>] [--progress]
      Render to .png .jpg .webp .avif (a still at --at, default the end) or .mp4 .webm .gif.
  annotate grid <image> -o <out.png> [--step <px>]
      Overlay a labeled coordinate grid, for reading positions off a screenshot.
  annotate convert <video> -o <out.mp4|out.webm> [--ffmpeg <path>]
      Re-encode a recording, such as Playwright's WebM, as H.264 MP4 that plays everywhere.
  annotate captions <doc.json> [--format vtt|srt|md] [-o <file>]
      Export the narration as WebVTT, SRT, or a Markdown transcript.
  annotate schema [-o <file>]
      Print the document's JSON Schema.

Video needs ffmpeg on PATH (or --ffmpeg, or ANNOTATE_FFMPEG). Docs: https://github.com/rwoll/mono-oss/tree/main/packages/annotate#readme
`;

interface Io {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown; isTTY?: boolean };
}

class UsageError extends Error {}

const version = (): string => (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

function parse<T extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: T, positionals: number) {
  try {
    const result = parseArgs({ args, options, allowPositionals: true, strict: true });
    if (result.positionals.length !== positionals) throw new UsageError(`expected ${positionals} argument${positionals === 1 ? '' : 's'}, got ${result.positionals.length}`);
    return result;
  } catch (error) {
    throw error instanceof UsageError ? error : new UsageError((error as Error).message);
  }
}

function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`--${name} must be a non-negative number`);
  return parsed;
}

/** Runs the CLI and returns its exit code: 0 ok, 1 failed, 2 usage error. */
export async function main(argv: string[], io: Io = process): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.stdout.write(HELP);
        return command === undefined ? 2 : 0;
      case '--version':
      case '-v':
        io.stdout.write(`${version()}\n`);
        return 0;
      case 'init':
        return await init(args, io);
      case 'check':
        return await check(args, io);
      case 'render':
        return await renderCommand(args, io);
      case 'grid':
        return await grid(args, io);
      case 'captions':
        return await captions(args, io);
      case 'convert':
        return await convert(args, io);
      case 'schema':
        return await schema(args, io);
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`annotate: ${error.message}\nRun \`annotate --help\` for usage.\n`);
      return 2;
    }
    io.stderr.write(`annotate: ${error instanceof AnnotateError ? error.message : (error as Error).stack ?? String(error)}\n`);
    return 1;
  }
}

async function init(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { out: { type: 'string', short: 'o' }, before: { type: 'string' }, force: { type: 'boolean' } }, 1);
  const media = resolve(positionals[0] as string);
  const out = resolve(values.out ?? join(dirname(media), `${basename(media, extname(media))}.annotate.json`));
  if (existsSync(out) && !values.force) throw new AnnotateError('exists', `${out} already exists; pass --force to replace it.`);
  const info = await probe(media);
  const ref = (path: string) => relative(dirname(out), path).split('\\').join('/') || basename(path);
  const doc: AnnotateDocument = {
    version: 1,
    source: { path: ref(media), width: info.width, height: info.height, ...(info.duration !== undefined && { duration: info.duration }) },
    annotations: [],
  };
  if (values.before) {
    const before = resolve(values.before);
    const beforeInfo = await probe(before);
    doc.compare = { before: { path: ref(before), width: beforeInfo.width, height: beforeInfo.height }, track: [[0, 0], [1, 0], [3, 1]] };
  }
  await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`);
  io.stdout.write(`Wrote ${relative(process.cwd(), out) || out} (${info.width}×${info.height} ${info.kind}${info.duration ? `, ${info.duration}s` : ''}).\n`);
  return 0;
}

async function check(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } }, 1);
  const { doc, baseDir } = await loadDocument(positionals[0] as string);
  const issues = [];
  let complete = doc;
  for (const [path, media] of [['source', doc.source], ['compare.before', doc.compare?.before]] as const) {
    if (media && !existsSync(mediaPath(media, baseDir))) issues.push({ level: 'error' as const, path: `${path}.path`, message: `${media.path} does not exist` });
  }
  if (!issues.length) complete = await completeDocument(doc, baseDir);
  issues.push(...checkDocument(complete));
  const errors = issues.filter(issue => issue.level === 'error').length;
  if (values.json) {
    io.stdout.write(`${JSON.stringify({ ok: errors === 0, issues }, null, 2)}\n`);
    return errors ? 1 : 0;
  }
  for (const issue of issues) io.stdout.write(`${issue.level}: ${issue.path}: ${issue.message}\n`);
  if (!errors) {
    const resolved = resolveDocument(complete);
    const parts = [
      `${resolved.width}×${resolved.height}`,
      resolved.duration ? `${resolved.duration}s` : 'still',
      `${complete.annotations.length} annotation${complete.annotations.length === 1 ? '' : 's'}`,
      `${resolved.shots.length} camera shot${resolved.shots.length === 1 ? '' : 's'}`,
      `${resolved.cues.length} caption${resolved.cues.length === 1 ? '' : 's'}`,
    ];
    io.stdout.write(`${issues.length ? 'OK with warnings' : 'OK'}: ${parts.join(', ')}.\n`);
  }
  return errors ? 1 : 0;
}

async function renderCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      out: { type: 'string', short: 'o', multiple: true },
      at: { type: 'string' },
      width: { type: 'string' },
      fps: { type: 'string' },
      captions: { type: 'string' },
      vtt: { type: 'string' },
      ffmpeg: { type: 'string' },
      progress: { type: 'boolean' },
    },
    1,
  );
  const outs = values.out ?? [];
  if (!outs.length) throw new UsageError('render needs at least one -o <out>');
  const captionMode = values.captions;
  if (captionMode !== undefined && captionMode !== 'burn' && captionMode !== 'soft' && captionMode !== 'none') throw new UsageError('--captions must be burn, soft, or none');
  const width = number(values.width, 'width');
  const fps = number(values.fps, 'fps');
  for (const [index, out] of outs.entries()) {
    let lastPercent = -1;
    const result = await render(positionals[0] as string, {
      out,
      at: number(values.at, 'at'),
      width: width && Math.round(width),
      fps: fps && Math.round(fps),
      captions: captionMode,
      vtt: index === 0 ? values.vtt : undefined,
      ffmpeg: values.ffmpeg,
      onProgress: ({ frame, frames }) => {
        if (values.progress) {
          io.stderr.write(`${JSON.stringify({ out, frame, frames })}\n`);
          return;
        }
        const percent = Math.floor((frame / frames) * 100);
        if (io.stderr.isTTY && percent !== lastPercent) io.stderr.write(`\rRendering ${basename(out)}: ${percent}%`);
        lastPercent = percent;
      },
    });
    if (io.stderr.isTTY && !values.progress && result.frames > 1) io.stderr.write('\n');
    const detail = result.duration ? `${result.width}×${result.height}, ${result.duration.toFixed(1)}s, ${result.frames} frames` : `${result.width}×${result.height}`;
    io.stdout.write(`Wrote ${out} (${detail}).\n`);
  }
  return 0;
}

async function grid(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { out: { type: 'string', short: 'o' }, step: { type: 'string' } }, 1);
  if (!values.out) throw new UsageError('grid needs -o <out.png>');
  const { width, height } = await drawGrid(positionals[0] as string, values.out, { step: number(values.step, 'step') });
  io.stdout.write(`Wrote ${values.out} (${width}×${height}, lines every ${values.step ?? 100} px).\n`);
  return 0;
}

async function captions(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { format: { type: 'string' }, out: { type: 'string', short: 'o' } }, 1);
  const format = values.format ?? (values.out ? extname(values.out).slice(1) : 'vtt');
  const write = format === 'vtt' ? toVtt : format === 'srt' ? toSrt : format === 'md' ? toMarkdown : undefined;
  if (!write) throw new UsageError('--format must be vtt, srt, or md');
  const { doc, baseDir } = await loadDocument(positionals[0] as string);
  const text = write(resolveDocument(await completeDocument(doc, baseDir)).cues);
  if (values.out) {
    await writeFile(values.out, text);
    io.stdout.write(`Wrote ${values.out}.\n`);
  } else {
    io.stdout.write(text);
  }
  return 0;
}

async function convert(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, { out: { type: 'string', short: 'o' }, ffmpeg: { type: 'string' } }, 1);
  if (!values.out) throw new UsageError('convert needs -o <out.mp4>');
  const input = resolve(positionals[0] as string);
  if (resolve(values.out) === input) throw new UsageError('convert needs an output different from its input');
  await convertVideo(input, values.out, { ffmpeg: values.ffmpeg });
  io.stdout.write(`Wrote ${values.out}.\n`);
  return 0;
}

async function schema(args: string[], io: Io): Promise<number> {
  const { values } = parse(args, { out: { type: 'string', short: 'o' } }, 0);
  const text = `${JSON.stringify(jsonSchema(), null, 2)}\n`;
  if (values.out) await writeFile(values.out, text);
  else io.stdout.write(text);
  return 0;
}
