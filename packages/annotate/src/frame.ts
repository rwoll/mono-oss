import { aspectBox, cameraAt, type Rect } from './camera.ts';
import type { ResolvedDocument } from './document.ts';
import type { Box, Point, Tone } from './schema.ts';
import { FONT_FAMILY, measureText, wrapText } from './text.ts';

export const TONE_COLORS: Record<Tone, string> = {
  problem: '#ef4444',
  removed: '#ef4444',
  warning: '#f59e0b',
  changed: '#f59e0b',
  added: '#22c55e',
  success: '#22c55e',
  note: '#3b82f6',
  accent: '#a855f7',
};
const DARK_TEXT = new Set<Tone>(['warning', 'changed']);

export interface FrameOptions {
  /** Output width in pixels. */
  width: number;
  /** Output height; defaults to the source's aspect ratio. */
  height?: number;
  /** Draw the narration as captions. Default true. */
  captions?: boolean;
  /** Follow the camera. Default true; false shows the whole frame, for editing. */
  camera?: boolean;
  /** Animate entrances (ripples, pops, arrows drawing on). Default true; false draws every visible mark settled, for stills. */
  animate?: boolean;
  /** Overrides the before/after position, 0 to 1. */
  wipe?: number;
  /** Multiplies the size of marks and text. Default: the document's output.scale, else 1. */
  scale?: number;
}

/** Where a lens shows its region: `source` in source pixels, drawn into `dest` in output pixels. */
export interface Magnifier {
  source: Box;
  dest: Box;
  radius: number;
  opacity: number;
}

export interface Redaction {
  box: Box;
  style: 'fill' | 'pixelate';
}

/**
 * One frame, as layers to composite in order: the source with `redactions` applied,
 * cropped to `camera` and scaled to the output (with the `before` image left of the
 * wipe), then `under`, then the `magnifiers`, then `over`. `under` and `over` are SVG
 * fragments in output pixels; wrap them with `svgDocument`.
 */
export interface Frame {
  t: number;
  width: number;
  height: number;
  camera: Rect;
  /** Output pixels per source pixel. */
  scale: number;
  /** Size unit for strokes and text, in output pixels. */
  unit: number;
  redactions: Redaction[];
  /** Before/after position: the before image covers x < (1 - wipe) * width. Undefined without compare. */
  wipe?: number;
  under: string;
  magnifiers: Magnifier[];
  over: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);
const easeOutBack = (u: number) => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2);
const n = (value: number) => Math.round(value * 100) / 100;
const escape = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** Wraps a layer fragment as a standalone SVG document. */
export function svgDocument(fragment: string, width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT_FAMILY}">${fragment}</svg>`;
}

/** Centers text vertically on y without dominant-baseline, which renderers treat differently. */
function textAt(x: number, y: number, text: string, size: number, fill: string, weight = 600, anchor: 'start' | 'middle' = 'start'): string {
  return `<text x="${n(x)}" y="${n(y + size * 0.35)}" font-size="${n(size)}" font-weight="${weight}" fill="${fill}"${anchor === 'middle' ? ' text-anchor="middle"' : ''}>${escape(text)}</text>`;
}

function quadLength(p0: Point, c: Point, p1: Point): number {
  let length = 0;
  let previous = p0;
  for (let i = 1; i <= 24; i += 1) {
    const u = i / 24;
    const point: Point = [
      (1 - u) * (1 - u) * p0[0] + 2 * (1 - u) * u * c[0] + u * u * p1[0],
      (1 - u) * (1 - u) * p0[1] + 2 * (1 - u) * u * c[1] + u * u * p1[1],
    ];
    length += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    previous = point;
  }
  return length;
}

/** Area two boxes share, after growing the first by margin on every side. */
const overlap = ([ax, ay, aw, ah]: Box, [bx, by, bw, bh]: Box, margin: number) =>
  Math.max(0, Math.min(ax + aw + margin, bx + bw) - Math.max(ax - margin, bx)) * Math.max(0, Math.min(ay + ah + margin, by + bh) - Math.max(ay - margin, by));
const boxesMatch = (a: Box, b: Box) => a.every((v, i) => Math.abs(v - (b[i] as number)) < 0.5);

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
};
const boundsOf = (points: Point[]): Box => {
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs) || 1, Math.max(...ys) - Math.min(...ys) || 1];
};

/** Builds the frame at time t. */
export function frameAt(resolved: ResolvedDocument, t: number, options: FrameOptions): Frame {
  const { doc, width: sourceWidth, height: sourceHeight, duration } = resolved;
  const W = options.width;
  const H = options.height ?? Math.round((W * sourceHeight) / sourceWidth);
  const animate = options.animate ?? true;
  const camera = options.camera === false ? { x: 0, y: 0, w: sourceWidth, h: sourceHeight } : cameraAt(resolved.keyframes, t);
  const s = W / camera.w;
  const u = Math.max(0.75, W / 1000) * (options.scale ?? doc.output?.scale ?? 1);
  const P = ([x, y]: Point): Point => [(x - camera.x) * s, (y - camera.y) * s];
  const B = ([x, y, w, h]: Box): Box => [(x - camera.x) * s, (y - camera.y) * s, w * s, h * s];

  const visibility = (a: { time?: [number, number] | undefined }): number => {
    if (!a.time) return 1;
    const [start, end] = a.time;
    if (t < start || t > end) return 0;
    if (!animate) return 1;
    // Marks there from the start (and to the end) are simply there, with no fade.
    return Math.min(1, start <= 0 ? 1 : (t - start) / 0.25, end >= duration - 1e-6 ? 1 : (end - t) / 0.25);
  };
  const progress = (age: number, length: number) => (animate ? clamp(age / length, 0, 1) : 1);
  const boxOf = (ref: string): Box | undefined => {
    const target = resolved.byId.get(ref);
    return target && 'box' in target ? target.box : undefined;
  };
  const pointOf = (value: Point | string, seen = new Set<string>()): Point => {
    if (typeof value !== 'string') return value;
    const box = boxOf(value);
    if (box) return [box[0] + box[2] / 2, box[1] + box[3] / 2];
    const target = resolved.byId.get(value);
    // A reference cycle (checkDocument reports it) resolves to the origin instead of recursing forever.
    if (seen.has(value)) return [0, 0];
    seen.add(value);
    if (target && 'at' in target) return pointOf(target.at, seen);
    if (target && 'from' in target && Array.isArray(target.from)) return target.from;
    return [0, 0];
  };
  const color = (tone: Tone | undefined, fallback: Tone = 'note') => TONE_COLORS[tone ?? fallback];

  function pill(
    label: string | undefined,
    [x, y, w, h]: Box,
    tone: Tone | undefined,
    { step, place = 'above', align = 'start' }: { step?: number | undefined; place?: 'above' | 'below' | 'middle'; align?: 'start' | 'center' | 'end' } = {},
  ): string {
    const own: Box = [x, y, w, h];
    if (!label && step === undefined) return '';
    const fs = 13 * u;
    const ph = 24 * u;
    const padX = 10 * u;
    const badge = 18 * u;
    const inset = 3 * u;
    const textWidth = label ? measureText(label, fs, 600) : 0;
    const lead = step !== undefined ? inset + badge + (label ? 6 * u : inset) : padX;
    const pw = lead + textWidth + (label ? padX : 0);
    // Candidate spots: the requested side first, then the others, each left- and right-aligned
    // for labels on a box. The spot covering the least of earlier labels and other marks wins.
    const sides = place === 'middle' ? (['middle', 'above', 'below'] as const) : place === 'below' ? (['below', 'above'] as const) : (['above', 'below'] as const);
    const yFor = (side: 'above' | 'below' | 'middle') => (side === 'middle' ? y + h / 2 - ph / 2 : side === 'below' ? y + h + 6 * u : y - ph - 6 * u);
    const xs = align === 'center' ? [x + w / 2 - pw / 2] : align === 'end' ? [x - pw] : [x, x + w - pw];
    const others = obstacles.filter(o => !boxesMatch(o, own));
    let best: { px: number; py: number; score: number } | undefined;
    for (const side of sides) {
      for (const cx of xs) {
        const top = yFor(side);
        const left = clamp(cx, 4, W - pw - 4);
        const spot: Box = [left, top, pw, ph];
        const inFrame = top >= 4 && top + ph <= H - 4;
        const score = (inFrame ? 0 : 1e9) + labels.reduce((sum, l) => sum + 4 * overlap(spot, l, 2), 0) + others.reduce((sum, o) => sum + overlap(spot, o, 0), 0);
        if (!best || score < best.score) best = { px: left, py: top, score };
      }
    }
    const { px } = best as { px: number };
    const py = clamp((best as { py: number }).py, 4, H - ph - 4);
    labels.push([px, py, pw, ph]);
    const fill = color(tone);
    const fg = tone && DARK_TEXT.has(tone) ? '#1c1300' : '#ffffff';
    let svg = `<rect x="${n(px)}" y="${n(py)}" width="${n(pw)}" height="${n(ph)}" rx="${n(ph / 2)}" fill="${fill}" stroke="#ffffff" stroke-opacity="0.9" stroke-width="${n(1.5 * u)}"/>`;
    if (step !== undefined) {
      const cx = px + inset + badge / 2;
      svg += `<circle cx="${n(cx)}" cy="${n(py + ph / 2)}" r="${n(badge / 2)}" fill="${fg}"/>${textAt(cx, py + ph / 2, String(step), 11 * u, fill, 700, 'middle')}`;
    }
    if (label) {
      // Centered in its space, so a font a little wider or narrower than the metrics still fits.
      svg += textAt(px + lead + textWidth / 2, py + ph / 2, label, fs, fg, 600, 'middle');
    }
    return svg;
  }

  const labels: Box[] = [];
  // Marks a label should not cover, in output pixels: every visible box and lens.
  const obstacles: Box[] = [];
  for (const a of doc.annotations) {
    if ((a.type === 'rect' || a.type === 'ellipse' || a.type === 'redact') && (a.type === 'redact' || visibility(a) > 0)) obstacles.push(B(a.box));
    if (a.type === 'magnify' && visibility(a) > 0) obstacles.push(B(a.into));
  }
  const under: string[] = [];
  const mid: string[] = [];
  const top: string[] = [];
  const keepClear: Box[] = [];
  const magnifiers: Magnifier[] = [];
  const redactions: Redaction[] = [];

  for (const a of doc.annotations) {
    // Redaction depends only on the time window, never on a fade, so no frame shows the pixels.
    if (a.type === 'redact') {
      if (!a.time || (t >= a.time[0] && t <= a.time[1])) redactions.push({ box: a.box, style: a.style ?? 'fill' });
      continue;
    }
    const o = visibility(a);
    if (o <= 0) continue;
    // Seconds since it appeared, for entrance animations; marks there from the start have settled.
    const age = a.time && a.time[0] > 0 ? t - a.time[0] : Infinity;
    const tone = a.tone;
    const stroke = color(tone);
    switch (a.type) {
      case 'rect':
      case 'ellipse': {
        const [x, y, w, h] = B(a.box);
        const cx = x + w / 2;
        const cy = y + h / 2;
        const k = 1 + 0.08 * (1 - easeOut(progress(age, 0.3)));
        const shape = (attrs: string) =>
          a.type === 'rect'
            ? `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(6 * u)}" ${attrs}/>`
            : `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(w / 2 + 6 * u)}" ry="${n(h / 2 + 6 * u)}" ${attrs}/>`;
        const step = resolved.steps.get(a);
        mid.push(
          `<g opacity="${n(o)}"><g transform="translate(${n(cx)} ${n(cy)}) scale(${n(k)}) translate(${n(-cx)} ${n(-cy)})">` +
            shape(`fill="${stroke}" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.9" stroke-width="${n(6 * u)}"`) +
            shape(`fill="none" stroke="${stroke}" stroke-width="${n(3 * u)}"`) +
            `</g>${pill(a.label, a.type === 'ellipse' ? [x, y - 6 * u, w, h + 12 * u] : [x, y, w, h], tone, { step })}</g>`,
        );
        keepClear.push(a.label || step !== undefined ? [x, y - 34 * u, w, h + 34 * u] : [x, y, w, h]);
        break;
      }
      case 'arrow': {
        const p0 = P(pointOf(a.from));
        const toBox = typeof a.to === 'string' ? boxOf(a.to) : undefined;
        let p1: Point;
        if (toBox) {
          const [x, y, w, h] = B(toBox);
          const cx = x + w / 2;
          const cy = y + h / 2;
          const dx = p0[0] - cx;
          const dy = p0[1] - cy;
          const gap = 10 * u;
          const k = Math.min((w / 2 + gap) / Math.abs(dx || 1e-6), (h / 2 + gap) / Math.abs(dy || 1e-6));
          p1 = [cx + dx * k, cy + dy * k];
        } else {
          p1 = P(pointOf(a.to));
        }
        const dx = p1[0] - p0[0];
        const dy = p1[1] - p0[1];
        const bend = a.bend ?? 0.2;
        const c: Point = [(p0[0] + p1[0]) / 2 - dy * bend, (p0[1] + p1[1]) / 2 + dx * bend];
        let tx = p1[0] - c[0];
        let ty = p1[1] - c[1];
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        const hs = 14 * u;
        const end: Point = [p1[0] - tx * hs * 0.7, p1[1] - ty * hs * 0.7];
        const length = quadLength(p0, c, end);
        const drawn = easeOut(progress(age, 0.45));
        const head = [p1, [p1[0] - tx * hs - ty * hs * 0.55, p1[1] - ty * hs + tx * hs * 0.55], [p1[0] - tx * hs + ty * hs * 0.55, p1[1] - ty * hs - tx * hs * 0.55]]
          .map(p => `${n(p[0] as number)},${n(p[1] as number)}`)
          .join(' ');
        const d = `M${n(p0[0])} ${n(p0[1])} Q${n(c[0])} ${n(c[1])} ${n(end[0])} ${n(end[1])}`;
        const dash = drawn < 1 ? ` stroke-dasharray="${n(length)} ${n(length + 1)}" stroke-dashoffset="${n(length * (1 - drawn))}"` : '';
        let label = '';
        if (a.label) {
          const g = 10 * u;
          label =
            Math.abs(dx) >= Math.abs(dy)
              ? pill(a.label, [p0[0] + (dx > 0 ? -g : g), p0[1], 0, 0], tone, { place: 'middle', align: dx > 0 ? 'end' : 'start' })
              : pill(a.label, [p0[0], p0[1] + (dy > 0 ? -g : g), 0, 0], tone, { place: dy > 0 ? 'above' : 'below', align: 'center' });
        }
        mid.push(
          `<g opacity="${n(o)}" stroke-linecap="round" stroke-linejoin="round">` +
            `<path d="${d}" fill="none" stroke="#ffffff" stroke-opacity="0.9" stroke-width="${n(7 * u)}"${dash}/>` +
            `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${n(3.5 * u)}"${dash}/>` +
            (drawn > 0.8 ? `<polygon points="${head}" fill="${stroke}" stroke="#ffffff" stroke-width="${n(1.5 * u)}"/>` : '') +
            `<circle cx="${n(p0[0])}" cy="${n(p0[1])}" r="${n(4 * u)}" fill="${stroke}" stroke="#ffffff" stroke-width="${n(1.5 * u)}"/>` +
            `${label}</g>`,
        );
        keepClear.push(boundsOf([p0, p1]));
        break;
      }
      case 'callout': {
        const [x, y] = P(pointOf(a.at));
        mid.push(`<g opacity="${n(o)}">${pill(a.text, [x, y, 0, 0], tone, { place: 'middle', align: 'center' })}</g>`);
        keepClear.push([x - 100 * u, y - 14 * u, 200 * u, 28 * u]);
        break;
      }
      case 'step': {
        const at = typeof a.at === 'string' && boxOf(a.at) ? P([(boxOf(a.at) as Box)[0], (boxOf(a.at) as Box)[1]]) : P(pointOf(a.at));
        const r = 13 * u;
        const k = easeOutBack(progress(age, 0.35));
        const fill = color(tone, 'accent');
        top.push(
          `<g opacity="${n(o)}" transform="translate(${n(at[0])} ${n(at[1])}) scale(${n(k)})"><circle r="${n(r)}" fill="${fill}" stroke="#ffffff" stroke-width="${n(2.5 * u)}"/>` +
            `${textAt(0, 0, String(resolved.steps.get(a) ?? ''), 13 * u, '#ffffff', 700, 'middle')}</g>`,
        );
        break;
      }
      case 'guide': {
        const vertical = a.x !== undefined;
        const v = vertical ? P([a.x as number, 0])[0] : P([0, a.y as number])[1];
        const drawn = easeOut(progress(age, 0.5));
        const line = vertical ? `x1="${n(v)}" y1="0" x2="${n(v)}" y2="${n(H * drawn)}"` : `x1="0" y1="${n(v)}" x2="${n(W * drawn)}" y2="${n(v)}"`;
        const label = a.label ?? (vertical ? `x = ${a.x}` : `y = ${a.y}`);
        mid.push(
          `<g opacity="${n(o)}"><line ${line} stroke="${stroke}" stroke-width="${n(1.5 * u)}" stroke-dasharray="${n(6 * u)} ${n(4 * u)}"/>` +
            pill(label, vertical ? [v, 36 * u, 0, 0] : [8 * u, v, 0, 0], tone, { align: vertical ? 'center' : 'start' }) +
            `</g>`,
        );
        break;
      }
      case 'measure': {
        const p0 = P(a.from);
        const p1 = P(a.to);
        const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
        const nx = -(p1[1] - p0[1]) / len;
        const ny = (p1[0] - p0[0]) / len;
        const tick = 7 * u;
        const m: Point = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
        const g = easeOut(progress(age, 0.4));
        const q0: Point = [lerp(m[0], p0[0], g), lerp(m[1], p0[1], g)];
        const q1: Point = [lerp(m[0], p1[0], g), lerp(m[1], p1[1], g)];
        const segment = (p: Point, q: Point) => `<line x1="${n(p[0])}" y1="${n(p[1])}" x2="${n(q[0])}" y2="${n(q[1])}"/>`;
        const ticks = (p: Point) => segment([p[0] - nx * tick, p[1] - ny * tick], [p[0] + nx * tick, p[1] + ny * tick]);
        const lines = segment(q0, q1) + ticks(q0) + ticks(q1);
        const distance = Math.round(Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1]));
        mid.push(
          `<g opacity="${n(o)}" stroke-linecap="round"><g stroke="#ffffff" stroke-opacity="0.9" stroke-width="${n(5 * u)}">${lines}</g>` +
            `<g stroke="${stroke}" stroke-width="${n(2 * u)}">${lines}</g>` +
            (g > 0.6 ? pill(a.label ?? `${distance} px`, [m[0], m[1] - tick, 0, 0], tone, { align: 'center' }) : '') +
            `</g>`,
        );
        keepClear.push(boundsOf([p0, p1]));
        break;
      }
      case 'spotlight': {
        const [x, y, w, h] = B(a.box);
        const p = (a.pad ?? 8) * u;
        under.push(
          `<path d="M0 0H${W}V${H}H0Z M${n(x - p)} ${n(y - p)}h${n(w + 2 * p)}v${n(h + 2 * p)}h${n(-w - 2 * p)}Z" fill="#05070a" fill-opacity="${n(0.6 * o)}" fill-rule="evenodd"/>`,
        );
        keepClear.push([x, y, w, h]);
        break;
      }
      case 'magnify': {
        const [, , iw, ih] = a.into;
        const source = aspectBox(a.box, iw / ih, sourceWidth, sourceHeight);
        const end = a.time?.[1] ?? Infinity;
        const g = animate ? easeOut(clamp(Math.min(age, end >= duration - 1e-6 ? Infinity : end - t) / 0.45, 0, 1)) : 1;
        const from = B(source);
        const to = B(a.into);
        const cur = from.map((v, i) => lerp(v, to[i] as number, g)) as unknown as Box;
        const [sx, sy, sw, sh] = from;
        const [cx, cy, cw, ch] = cur;
        const radius = 10 * u;
        magnifiers.push({ source, dest: cur, radius, opacity: o });
        under.push(
          `<rect x="${n(cx)}" y="${n(cy + 6 * u)}" width="${n(cw)}" height="${n(ch)}" rx="${n(radius)}" fill="#000000" fill-opacity="${n(0.3 * o)}" filter="url(#annotate-shadow)"/>`,
        );
        const ddx = cx + cw / 2 - (sx + sw / 2);
        const ddy = cy + ch / 2 - (sy + sh / 2);
        const pairs: [Point, Point][] =
          ddx * ddy > 0
            ? [[[sx + sw, sy], [cx + cw, cy]], [[sx, sy + sh], [cx, cy + ch]]]
            : [[[sx, sy], [cx, cy]], [[sx + sw, sy + sh], [cx + cw, cy + ch]]];
        const connectors = pairs.map(([p, q]) => `<line x1="${n(p[0])}" y1="${n(p[1])}" x2="${n(q[0])}" y2="${n(q[1])}"/>`).join('');
        const zoom = iw / source[2];
        mid.push(
          `<g opacity="${n(o)}"><g stroke="${stroke}" stroke-width="${n(1.5 * u)}" stroke-opacity="0.7">${connectors}</g>` +
            `<rect x="${n(sx)}" y="${n(sy)}" width="${n(sw)}" height="${n(sh)}" rx="${n(3 * u)}" fill="none" stroke="${stroke}" stroke-width="${n(2 * u)}"/>` +
            `<rect x="${n(cx)}" y="${n(cy)}" width="${n(cw)}" height="${n(ch)}" rx="${n(radius)}" fill="none" stroke="${stroke}" stroke-width="${n(3 * u)}"/>` +
            (g > 0.7 ? pill(`${a.label ? `${a.label} · ` : ''}${zoom.toFixed(1)}×`, cur, tone) : '') +
            `</g>`,
        );
        keepClear.push(union(cur, from));
        break;
      }
      case 'clicks':
        for (const event of doc.events ?? []) {
          if (event.type !== 'click' || !event.at) continue;
          const clickAge = t - event.t;
          if (clickAge < 0 || clickAge > 0.8 || (!animate && clickAge > 0)) continue;
          const k = clickAge / 0.8;
          const [x, y] = P(event.at);
          top.push(
            `<circle cx="${n(x)}" cy="${n(y)}" r="${n((8 + 30 * easeOut(k)) * u)}" fill="none" stroke="${stroke}" stroke-width="${n(3 * u)}" opacity="${n(1 - k)}"/>` +
              `<circle cx="${n(x)}" cy="${n(y)}" r="${n(9 * u)}" fill="${stroke}" opacity="${n(0.45 * (1 - k))}"/>`,
          );
        }
        break;
      case 'keys': {
        let row = 0;
        for (const event of doc.events ?? []) {
          if (event.type !== 'key' || !event.keys) continue;
          const keyAge = t - event.t;
          if (keyAge < 0 || keyAge > 1.2) continue;
          const ko = animate ? Math.min(1, keyAge / 0.12, (1.2 - keyAge) / 0.25) : 1;
          const fs = 20 * u;
          const kw = measureText(event.keys, fs, 600) + 28 * u;
          const kh = 40 * u;
          const kx = W - kw - 16 * u;
          const ky = 16 * u + row * (kh + 8 * u);
          row += 1;
          const k = animate ? 0.9 + 0.1 * easeOutBack(clamp(keyAge / 0.25, 0, 1)) : 1;
          top.push(
            `<g opacity="${n(ko)}" transform="translate(${n(kx + kw / 2)} ${n(ky + kh / 2)}) scale(${n(k)})">` +
              `<rect x="${n(-kw / 2)}" y="${n(-kh / 2)}" width="${n(kw)}" height="${n(kh)}" rx="${n(8 * u)}" fill="#0d1117" fill-opacity="0.85" stroke="#ffffff" stroke-opacity="0.25"/>` +
              `${textAt(0, 0, event.keys, fs, '#ffffff', 600, 'middle')}</g>`,
          );
        }
        break;
      }
    }
  }

  let wipe: number | undefined;
  if (doc.compare) {
    wipe = options.wipe ?? wipeAt(doc.compare.track, t);
    const x = (1 - wipe) * W;
    const chip = (label: string, cx: number, anchor: 'start' | 'end') => {
      const fs = 12 * u;
      const w = measureText(label, fs, 600) + 18 * u;
      const h = 22 * u;
      const left = anchor === 'end' ? cx - w : cx;
      return `<rect x="${n(left)}" y="${n(12 * u)}" width="${n(w)}" height="${n(h)}" rx="${n(h / 2)}" fill="#0d1117" fill-opacity="0.8"/>${textAt(left + w / 2, 12 * u + h / 2, label, fs, '#ffffff', 600, 'middle')}`;
    };
    if (wipe > 0.001 && wipe < 0.999) {
      top.push(
        `<line x1="${n(x)}" y1="0" x2="${n(x)}" y2="${H}" stroke="#ffffff" stroke-width="${n(2.5 * u)}"/>` +
          `<circle cx="${n(x)}" cy="${n(H / 2)}" r="${n(16 * u)}" fill="#ffffff" stroke="#000000" stroke-opacity="0.25"/>` +
          textAt(x, H / 2, '‹ ›', 14 * u, '#1f2328', 700, 'middle'),
      );
      if (x > 90 * u) top.push(chip('Before', 12 * u, 'start'));
      if (W - x > 90 * u) top.push(chip('After', W - 12 * u, 'end'));
    } else {
      top.push(chip(wipe >= 0.999 ? 'After' : 'Before', 12 * u, 'start'));
    }
  }

  if (options.captions !== false) {
    const fs = Math.max(12, 16 * u);
    const lh = fs * 1.3;
    const padY = fs * 0.45;
    const padX = 16 * u;
    for (const cue of resolved.cues) {
      if (t < cue.start || t > cue.end) continue;
      const o = animate ? Math.min(1, cue.start <= 0 ? 1 : (t - cue.start) / 0.2, cue.end >= duration - 1e-6 ? 1 : (cue.end - t) / 0.2) : 1;
      const lines = wrapText(cue.text, fs, W * 0.82 - 2 * padX, 500);
      const bw = Math.max(...lines.map(line => measureText(line, fs, 500))) + 2 * padX;
      const bh = lines.length * lh + 2 * padY;
      const bx = (W - bw) / 2;
      const bottom = H - bh - 16 * u;
      const upper = 16 * u;
      // Bottom unless the top covers less of what the marks point at and their labels.
      const covered = (y: number) =>
        [...keepClear, ...labels].reduce((area, k) => area + Math.max(0, Math.min(bx + bw, k[0] + k[2]) - Math.max(bx, k[0])) * Math.max(0, Math.min(y + bh, k[1] + k[3]) - Math.max(y, k[1])), 0);
      const by = covered(upper) < covered(bottom) ? upper : bottom;
      top.push(
        `<g opacity="${n(o)}"><rect x="${n(bx)}" y="${n(by)}" width="${n(bw)}" height="${n(bh)}" rx="${n(8 * u)}" fill="#0d1117" fill-opacity="0.85"/>` +
          lines.map((line, i) => textAt(W / 2, by + padY + lh * (i + 0.5), line, fs, '#ffffff', 500, 'middle')).join('') +
          `</g>`,
      );
    }
  }

  const defs = magnifiers.length ? `<defs><filter id="annotate-shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${n(10 * u)}"/></filter></defs>` : '';
  return {
    t,
    width: W,
    height: H,
    camera,
    scale: s,
    unit: u,
    redactions,
    wipe,
    under: defs + under.join(''),
    magnifiers,
    over: mid.join('') + top.join(''),
  };
}

/** The before/after position at time t, eased between keyframes. */
export function wipeAt(track: ReadonlyArray<readonly [number, number]>, t: number): number {
  const first = track[0];
  if (!first) return 1;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < track.length; i += 1) {
    const [t1, v1] = track[i] as readonly [number, number];
    if (t <= t1) {
      const [t0, v0] = track[i - 1] as readonly [number, number];
      const u = (t - t0) / (t1 - t0 || 1);
      return lerp(v0, v1, u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
    }
  }
  return (track.at(-1) as readonly [number, number])[1];
}

