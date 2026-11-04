import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { AnnotateError, parseDocument } from '../document.ts';
import { mediaKind } from '../media.ts';
import type { AnnotateDocument, Media } from '../schema.ts';
import { probeVideo, type FfmpegOptions } from './ffmpeg.ts';

export interface MediaInfo {
  kind: 'image' | 'video';
  width: number;
  height: number;
  /** Seconds, for videos. */
  duration?: number;
}

/** Reads an image's or video's kind, size, and length. Videos need ffmpeg. */
export async function probe(path: string, options: FfmpegOptions = {}): Promise<MediaInfo> {
  const kind = mediaKind(path);
  if (!kind) throw new AnnotateError('unsupported_media', `${path} is not a supported image or video (by its extension).`);
  if (kind === 'video') return { kind, ...(await probeVideo(path, options)) };
  const metadata = await sharp(path).metadata();
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (!width || !height) throw new AnnotateError('unsupported_media', `Could not read the size of ${path}.`);
  return { kind, width, height };
}

export interface LoadedDocument {
  doc: AnnotateDocument;
  /** The folder media paths are relative to. */
  baseDir: string;
}

/** Reads and validates a document file. */
export async function loadDocument(path: string): Promise<LoadedDocument> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new AnnotateError('invalid_document', `Could not read ${path}: ${(error as Error).message}`);
  }
  return { doc: parseDocument(json), baseDir: dirname(resolve(path)) };
}

export const mediaPath = (media: Media, baseDir: string) => resolve(baseDir, media.path);

/** Fills in missing sizes and video lengths from the files. */
export async function completeDocument(doc: AnnotateDocument, baseDir: string, options: FfmpegOptions = {}): Promise<AnnotateDocument> {
  const complete = async (media: Media): Promise<Media> => {
    const kind = mediaKind(media.path);
    if (media.width && media.height && (kind !== 'video' || media.duration !== undefined)) return media;
    const info = await probe(mediaPath(media, baseDir), options);
    return { ...media, width: media.width ?? info.width, height: media.height ?? info.height, ...(info.duration !== undefined && { duration: media.duration ?? info.duration }) };
  };
  const source = await complete(doc.source);
  const compare = doc.compare && { ...doc.compare, before: await complete(doc.compare.before) };
  return { ...doc, source, ...(compare && { compare }) };
}
