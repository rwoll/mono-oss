import type { AnnotateDocument, Box } from './schema.ts';

/** A rectangle in source pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A camera shot after planning: when it holds and what it frames. */
export interface PlannedShot {
  start: number;
  end: number;
  ease: number;
  auto: boolean;
  /** The region asked for, before fitting to the output's aspect ratio. */
  box: Box;
  /** The region the camera shows. */
  rect: Rect;
}

export interface Keyframe {
  t: number;
  rect: Rect;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
};
const center = (box: Box) => [box[0] + box[2] / 2, box[1] + box[3] / 2] as const;

/** Grows a box to the frame's aspect ratio with padding, limits the zoom, and keeps it inside the frame. */
export function fitBox(box: Box, width: number, height: number, pad = 24, maxZoom = 4): Rect {
  const aspect = width / height;
  let [x, y, w, h] = box;
  x -= pad;
  y -= pad;
  w += 2 * pad;
  h += 2 * pad;
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  if (w < width / maxZoom) {
    w = width / maxZoom;
    h = w / aspect;
  }
  if (w > width || h > height) {
    w = width;
    h = height;
  }
  return { x: clamp(cx - w / 2, 0, width - w), y: clamp(cy - h / 2, 0, height - h), w, h };
}

/** Grows a box around its center to an aspect ratio, kept inside the frame. */
export function aspectBox([x, y, w, h]: Box, aspect: number, width: number, height: number): Box {
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  w = Math.min(w, width);
  h = Math.min(h, height);
  return [clamp(cx - w / 2, 0, width - w), clamp(cy - h / 2, 0, height - h), w, h];
}

/**
 * Plans the camera: manual zoom shots plus shots that follow input events. Nearby
 * event shots merge into one; a shot that overlaps the next ends where the next begins,
 * so the camera pans straight to it.
 */
export function planShots(doc: AnnotateDocument, width: number, height: number): PlannedShot[] {
  const raw: Omit<PlannedShot, 'rect'>[] = [];
  for (const shot of doc.camera ?? []) {
    if (shot.type === 'zoom') {
      raw.push({ start: shot.time[0], end: shot.time[1], box: shot.box, ease: shot.ease ?? 0.7, auto: false });
      continue;
    }
    const zoom = shot.zoom ?? 2.2;
    const w = width / zoom;
    const h = height / zoom;
    const follow = shot.from ?? ['click', 'type', 'key'];
    for (const event of doc.events ?? []) {
      if (!follow.includes(event.type) || !event.at) continue;
      raw.push({
        start: Math.max(0, event.t - (shot.lead ?? 0.8)),
        end: (event.end ?? event.t) + (shot.hold ?? 1),
        box: [event.at[0] - w / 2, event.at[1] - h / 2, w, h],
        ease: shot.ease ?? 0.7,
        auto: true,
      });
    }
  }
  raw.sort((a, b) => a.start - b.start);
  const merged: Omit<PlannedShot, 'rect'>[] = [];
  const near = Math.hypot(width, height) * 0.16;
  for (const shot of raw) {
    const previous = merged.at(-1);
    if (previous && shot.start < previous.end) {
      const [px, py] = center(previous.box);
      const [sx, sy] = center(shot.box);
      if (previous.auto && shot.auto && Math.hypot(px - sx, py - sy) < near) {
        previous.end = Math.max(previous.end, shot.end);
        previous.box = union(previous.box, shot.box);
        continue;
      }
      previous.end = shot.start;
    }
    merged.push({ ...shot });
  }
  return merged
    .filter(shot => shot.end > shot.start)
    .map(shot => ({ ...shot, rect: fitBox(shot.box, width, height, shot.auto ? 0 : 24) }));
}

/** Camera keyframes: full frame, then each shot, zooming out only when the next shot is far off in time. */
export function cameraKeyframes(shots: readonly PlannedShot[], width: number, height: number): Keyframe[] {
  const full: Rect = { x: 0, y: 0, w: width, h: height };
  const keyframes: Keyframe[] = [{ t: 0, rect: full }];
  shots.forEach((shot, index) => {
    const last = keyframes.at(-1) as Keyframe;
    const start = Math.max(shot.start, last.t);
    const easeIn = Math.min(shot.ease, Math.max(0.05, (shot.end - start) / 2));
    if (start > last.t) keyframes.push({ t: start, rect: last.rect });
    keyframes.push({ t: start + easeIn, rect: shot.rect });
    if (shot.end > start + easeIn) keyframes.push({ t: shot.end, rect: shot.rect });
    const next = shots[index + 1];
    if (!next || next.start - shot.end >= shot.ease + 0.2) {
      keyframes.push({ t: Math.max(shot.end, start + easeIn) + shot.ease, rect: full });
    }
  });
  return keyframes;
}

/**
 * Moves between two camera rects of the same aspect ratio by zooming about the point
 * they share, with a geometric scale: the subject does not drift and the zoom feels even.
 */
export function zoomBetween(from: Rect, to: Rect, u: number): Rect {
  const k = to.w / from.w;
  if (Math.abs(k - 1) < 1e-3) {
    return { x: lerp(from.x, to.x, u), y: lerp(from.y, to.y, u), w: lerp(from.w, to.w, u), h: lerp(from.h, to.h, u) };
  }
  const fx = (to.x - k * from.x) / (1 - k);
  const fy = (to.y - k * from.y) / (1 - k);
  const m = Math.pow(k, u);
  return { x: fx + (from.x - fx) * m, y: fy + (from.y - fy) * m, w: from.w * m, h: from.h * m };
}

/** The camera rect at time t. */
export function cameraAt(keyframes: readonly Keyframe[], t: number): Rect {
  for (let index = 1; index < keyframes.length; index += 1) {
    const b = keyframes[index] as Keyframe;
    if (t < b.t) {
      const a = keyframes[index - 1] as Keyframe;
      return zoomBetween(a.rect, b.rect, easeInOut((t - a.t) / (b.t - a.t)));
    }
  }
  return (keyframes.at(-1) as Keyframe).rect;
}
