// Draws frames in the browser with the same layers, in the same order, as the
// Node renderer: redacted source → camera → wipe → under → lenses → over.
import type { ResolvedDocument } from './document.ts';
import { frameAt, svgDocument, type Frame, type FrameOptions, type Redaction } from './frame.ts';
import type { Point } from './schema.ts';

/** Anything the browser can draw: an <img>, a <video>, or a canvas. */
export type MediaElement = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;

export interface FrameSources {
  main: MediaElement;
  before?: MediaElement | undefined;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function ready(element: MediaElement): boolean {
  if (element instanceof HTMLImageElement) return element.complete && element.naturalWidth > 0;
  if (element instanceof HTMLVideoElement) return element.readyState >= 2 && element.videoWidth > 0;
  return element.width > 0;
}

/** A source drawn at the document's size with its redactions applied, cached while neither changes. */
class RedactedSource {
  readonly canvas = document.createElement('canvas');
  #key = '';
  #element: MediaElement | undefined;

  update(element: MediaElement, width: number, height: number, redactions: readonly Redaction[], force: boolean): HTMLCanvasElement {
    const key = `${width}x${height}:${JSON.stringify(redactions)}`;
    if (!force && element === this.#element && key === this.#key) return this.canvas;
    this.#element = element;
    this.#key = key;
    const { canvas } = this;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.drawImage(element, 0, 0, width, height);
    for (const { box, style } of redactions) {
      const [x, y, w, h] = box.map(Math.round) as [number, number, number, number];
      if (w <= 0 || h <= 0) continue;
      if (style === 'pixelate') {
        const block = Math.max(6, Math.round(Math.min(w, h) / 3));
        const small = document.createElement('canvas');
        small.width = Math.max(1, Math.ceil(w / block));
        small.height = Math.max(1, Math.ceil(h / block));
        const sctx = small.getContext('2d') as CanvasRenderingContext2D;
        sctx.drawImage(canvas, x, y, w, h, 0, 0, small.width, small.height);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, small.width, small.height, x, y, small.width * block, small.height * block);
        ctx.restore();
      } else {
        ctx.fillStyle = '#24292f';
        ctx.fillRect(x, y, w, h);
      }
    }
    return canvas;
  }
}

/**
 * The layers of a player inside a positioned container: a canvas for the picture,
 * SVG under, a canvas for lenses, and SVG over. Call `draw` for each frame.
 */
export class FrameView {
  readonly element: HTMLDivElement;
  readonly #base = document.createElement('canvas');
  readonly #lenses = document.createElement('canvas');
  readonly #under = document.createElementNS(SVG_NS, 'svg');
  readonly #over = document.createElementNS(SVG_NS, 'svg');
  readonly #main = new RedactedSource();
  readonly #before = new RedactedSource();
  #frame: Frame | undefined;

  constructor(container: HTMLElement) {
    this.element = document.createElement('div');
    this.element.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
    for (const layer of [this.#base, this.#under, this.#lenses, this.#over]) {
      layer.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;');
      this.element.append(layer);
    }
    container.append(this.element);
  }

  /** The last frame drawn. */
  get frame(): Frame | undefined {
    return this.#frame;
  }

  /** Draws the frame at t to fit the container. Returns undefined until the media can be drawn. */
  draw(resolved: ResolvedDocument, t: number, sources: FrameSources, options: Omit<FrameOptions, 'width' | 'height'> = {}): Frame | undefined {
    const rect = this.element.getBoundingClientRect();
    const frame = frameAt(resolved, t, { ...options, width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) });
    return this.paint(frame, resolved, sources) ? frame : undefined;
  }

  /** Paints a frame built with `frameAt` at this view's size. Returns false until the media can be drawn. */
  paint(frame: Frame, resolved: ResolvedDocument, sources: FrameSources): boolean {
    this.#frame = frame;
    const { width, height } = frame;
    const dpr = window.devicePixelRatio || 1;
    for (const canvas of [this.#base, this.#lenses]) {
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
    }
    const ctx = this.#base.getContext('2d') as CanvasRenderingContext2D;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, width, height);
    const lens = this.#lenses.getContext('2d') as CanvasRenderingContext2D;
    lens.setTransform(dpr, 0, 0, dpr, 0, 0);
    lens.clearRect(0, 0, width, height);
    for (const svg of [this.#under, this.#over]) {
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
    if (!ready(sources.main)) {
      this.#under.innerHTML = '';
      this.#over.innerHTML = '';
      return false;
    }
    const live = (element: MediaElement) => element instanceof HTMLVideoElement;
    const main = this.#main.update(sources.main, resolved.width, resolved.height, frame.redactions, live(sources.main));
    const { camera } = frame;
    ctx.drawImage(main, camera.x, camera.y, camera.w, camera.h, 0, 0, width, height);
    if (sources.before && frame.wipe !== undefined && ready(sources.before)) {
      const x = (1 - frame.wipe) * width;
      if (x > 0) {
        const before = this.#before.update(sources.before, resolved.width, resolved.height, frame.redactions, live(sources.before));
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, x, height);
        ctx.clip();
        ctx.drawImage(before, camera.x, camera.y, camera.w, camera.h, 0, 0, width, height);
        ctx.restore();
      }
    }
    this.#under.innerHTML = frame.under;
    for (const { source, dest, radius, opacity } of frame.magnifiers) {
      lens.save();
      lens.globalAlpha = opacity;
      lens.beginPath();
      lens.roundRect(dest[0], dest[1], dest[2], dest[3], radius);
      lens.clip();
      lens.drawImage(main, source[0], source[1], source[2], source[3], dest[0], dest[1], dest[2], dest[3]);
      lens.restore();
    }
    this.#over.innerHTML = frame.over;
    return true;
  }

  destroy(): void {
    this.element.remove();
  }
}

/** Converts output pixels (CSS pixels from the view's top-left) to source pixels. */
export const toSource = (frame: Frame, [x, y]: Point): Point => [frame.camera.x + x / frame.scale, frame.camera.y + y / frame.scale];

/** Converts source pixels to output pixels. */
export const toView = (frame: Frame, [x, y]: Point): Point => [(x - frame.camera.x) * frame.scale, (y - frame.camera.y) * frame.scale];

/** The frame as one standalone SVG (over and under layers only), for tests and debugging. */
export const overlaySvg = (frame: Frame) => svgDocument(frame.under + frame.over, frame.width, frame.height);
