// Helpers for capturing annotated screenshots and recordings with Playwright.
// They use structural types, so this package does not depend on Playwright: pass
// your own `page` and locators.
import { writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import type { AnnotateDocument, AnnotateEvent, Annotation, Box, Cue, Point } from './schema.ts';

export interface LocatorLike {
  boundingBox(options?: { timeout?: number }): Promise<{ x: number; y: number; width: number; height: number } | null>;
  click(options?: Record<string, unknown>): Promise<void>;
  fill(value: string, options?: Record<string, unknown>): Promise<void>;
  pressSequentially?(text: string, options?: { delay?: number }): Promise<void>;
  scrollIntoViewIfNeeded?(options?: Record<string, unknown>): Promise<void>;
  toString(): string;
}

export interface PageLike {
  screenshot(options?: { path?: string; fullPage?: boolean; animations?: 'disabled' | 'allow' }): Promise<Uint8Array>;
  evaluate<R>(fn: () => R): Promise<R>;
  keyboard: { press(key: string, options?: Record<string, unknown>): Promise<void> };
  viewportSize(): { width: number; height: number } | null;
}

/** Any annotation with a box can take a locator instead; the box is measured when the screenshot is taken. */
export type AnchoredAnnotation = Annotation extends infer A
  ? A extends { box: Box }
    ? Omit<A, 'box'> & ({ box: Box; locator?: undefined } | { box?: undefined; locator: LocatorLike; pad?: number })
    : A
  : never;

const viewportScale = (page: PageLike) => page.evaluate(() => ({ dpr: window.devicePixelRatio, x: window.scrollX, y: window.scrollY }));

/**
 * The box of a locator in screenshot pixels: CSS pixels times the device pixel ratio.
 * For full-page screenshots, pass fullPage so the scroll position is included.
 */
export async function boxOf(page: PageLike, locator: LocatorLike, options: { pad?: number; fullPage?: boolean; scale?: number } = {}): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator.toString()} is not visible, so it has no box.`);
  const { dpr, x: scrollX, y: scrollY } = await viewportScale(page);
  const scale = options.scale ?? dpr;
  const pad = options.pad ?? 4;
  const left = box.x + (options.fullPage ? scrollX : 0) - pad;
  const top = box.y + (options.fullPage ? scrollY : 0) - pad;
  return [left * scale, top * scale, (box.width + 2 * pad) * scale, (box.height + 2 * pad) * scale].map(v => Math.round(v * 10) / 10) as Box;
}

function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface ScreenshotDocumentOptions {
  /** Where to save the screenshot (.png). */
  path: string;
  annotations?: AnchoredAnnotation[];
  narration?: Cue[];
  fullPage?: boolean;
  /** Where to write the document. Default: next to the screenshot, as <name>.annotate.json. */
  documentPath?: string;
}

/**
 * Takes a screenshot and writes an annotate document for it, measuring each
 * locator's box first so marks line up with the page as it was captured.
 */
export async function screenshotDocument(page: PageLike, options: ScreenshotDocumentOptions): Promise<{ document: AnnotateDocument; documentPath: string }> {
  const annotations: Annotation[] = [];
  for (const item of options.annotations ?? []) {
    if ('locator' in item && item.locator) {
      const { locator, pad, ...rest } = item as { locator: LocatorLike; pad?: number; target?: string } & Record<string, unknown>;
      annotations.push({ ...rest, box: await boxOf(page, locator, { pad, fullPage: options.fullPage }), target: rest.target ?? locator.toString() } as Annotation);
    } else {
      annotations.push(item as Annotation);
    }
  }
  const png = await page.screenshot({ path: options.path, fullPage: options.fullPage ?? false, animations: 'disabled' });
  const { dpr } = await viewportScale(page);
  const documentPath = resolve(options.documentPath ?? join(dirname(options.path), `${basename(options.path, extname(options.path))}.annotate.json`));
  const document: AnnotateDocument = {
    version: 1,
    source: { path: relative(dirname(documentPath), resolve(options.path)).split('\\').join('/'), ...pngSize(png), scale: dpr },
    annotations,
    ...(options.narration?.length && { narration: options.narration }),
  };
  await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`);
  return { document, documentPath };
}

const KEY_LABELS: Record<string, string> = { Meta: '⌘', ControlOrMeta: '⌘', Control: 'Ctrl+', Shift: '⇧', Alt: '⌥', Enter: '↵', Escape: 'Esc', Backspace: '⌫', Tab: '⇥', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
/** A Playwright key such as "ControlOrMeta+s" as a chip label such as "⌘S". */
export const keyLabel = (keys: string) => keys.split('+').map(key => KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key)).join('');

export interface RecorderOptions {
  /**
   * Video pixels per CSS pixel. Playwright records CSS pixels whatever the device
   * pixel ratio, scaled down to `recordVideo.size` (default: the viewport scaled to fit
   * 800×800); a size larger than the viewport is padded, not sharper. So this is
   * `recordVideo.size.width / viewport.width`, at most 1. Default: Playwright's default.
   */
  scale?: number;
  /** Seconds between the video's start and the recorder's creation. Default 0: create it right after the page opens. */
  offset?: number;
}

export interface Recorder {
  /** Clicks a locator and records the click where it happened. */
  click(locator: LocatorLike, options?: Record<string, unknown>): Promise<void>;
  /** Types into a locator and records the typing. With a delay, types key by key so it shows in the video. */
  type(locator: LocatorLike, text: string, options?: { delay?: number }): Promise<void>;
  /** Presses keys (such as "ControlOrMeta+s") and records them as a key chip, at a locator if given. */
  press(keys: string, options?: { at?: LocatorLike; label?: string }): Promise<void>;
  /** Adds a caption starting now. */
  narrate(text: string): void;
  /** A locator's box in video pixels, for marks on the recording. Not `boxOf`, which measures screenshot pixels. */
  box(locator: LocatorLike, options?: { pad?: number }): Promise<Box>;
  /** Seconds since the recording started. */
  now(): number;
  readonly events: readonly AnnotateEvent[];
  readonly narration: readonly Cue[];
  /** A document for the finished recording, with auto zoom, click ripples, key chips, and the captions. */
  document(source: { path: string; width?: number; height?: number; duration?: number }): AnnotateDocument;
}

/** Records input and captions while Playwright records a video, so the video can be annotated afterwards. */
export function recorder(page: PageLike, options: RecorderOptions = {}): Recorder {
  const started = performance.now() - (options.offset ?? 0) * 1000;
  const events: AnnotateEvent[] = [];
  const narration: Cue[] = [];
  const now = () => Math.round((performance.now() - started) / 10) / 100;
  const scale = () => {
    if (options.scale) return Math.min(1, options.scale);
    const viewport = page.viewportSize();
    return viewport ? Math.min(1, 800 / viewport.width, 800 / viewport.height) : 1;
  };
  const centerOf = async (locator: LocatorLike): Promise<Point | undefined> => {
    const box = await locator.boundingBox();
    if (!box) return undefined;
    const k = scale();
    return [Math.round((box.x + box.width / 2) * k), Math.round((box.y + box.height / 2) * k)];
  };
  return {
    events,
    narration,
    now,
    async click(locator, clickOptions) {
      await locator.scrollIntoViewIfNeeded?.();
      const at = await centerOf(locator);
      events.push({ t: now(), type: 'click', ...(at && { at }) });
      await locator.click(clickOptions);
    },
    async type(locator, text, typeOptions = {}) {
      const at = await centerOf(locator);
      const t = now();
      if (typeOptions.delay && locator.pressSequentially) await locator.pressSequentially(text, { delay: typeOptions.delay });
      else await locator.fill(text);
      events.push({ t, end: Math.max(t, now()), type: 'type', ...(at && { at }) });
    },
    async press(keys, pressOptions = {}) {
      const at = pressOptions.at ? await centerOf(pressOptions.at) : undefined;
      events.push({ t: now(), type: 'key', keys: pressOptions.label ?? keyLabel(keys), ...(at && { at }) });
      await page.keyboard.press(keys);
    },
    narrate(text) {
      narration.push({ t: now(), text });
    },
    box(locator, boxOptions = {}) {
      return boxOf(page, locator, { pad: boxOptions.pad, scale: scale() });
    },
    document(source) {
      return {
        version: 1,
        source,
        events: [...events],
        camera: [{ type: 'auto' }],
        annotations: [{ type: 'clicks' }, { type: 'keys' }],
        ...(narration.length && { narration: [...narration] }),
      };
    },
  };
}
