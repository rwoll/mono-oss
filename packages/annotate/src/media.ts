export type MediaKind = 'image' | 'video';

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.tif', '.tiff', '.svg']);
const VIDEO = new Set(['.webm', '.mp4', '.mov', '.m4v', '.mkv']);
const extension = (path: string) => /\.[^./\\]+$/.exec(path.toLowerCase())?.[0] ?? '';

/** Whether a source file is an image or a video, by extension. GIFs are read as images (their first frame). */
export function mediaKind(path: string): MediaKind | undefined {
  const ext = extension(path);
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  return undefined;
}

export type OutputFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'mp4' | 'webm' | 'gif';

/** The output format for a file name, and whether it is a still or a video. */
export function outputKind(path: string): { format: OutputFormat; kind: MediaKind } | undefined {
  switch (extension(path)) {
    case '.png':
      return { format: 'png', kind: 'image' };
    case '.jpg':
    case '.jpeg':
      return { format: 'jpeg', kind: 'image' };
    case '.webp':
      return { format: 'webp', kind: 'image' };
    case '.avif':
      return { format: 'avif', kind: 'image' };
    case '.mp4':
      return { format: 'mp4', kind: 'video' };
    case '.webm':
      return { format: 'webm', kind: 'video' };
    case '.gif':
      return { format: 'gif', kind: 'video' };
    default:
      return undefined;
  }
}
