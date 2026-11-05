import { describe, expect, it } from 'vitest';
import {
  checkDocument,
  frameAt,
  measureText,
  parseDocument,
  planShots,
  resolveDocument,
  timeCues,
  toMarkdown,
  toSrt,
  toVtt,
  wrapText,
  zoomBetween,
  type AnnotateDocumentInput,
} from '../src/index.ts';

const doc = (extra: Partial<AnnotateDocumentInput> = {}) => parseDocument({ version: 1, source: { path: 'shot.png', width: 1280, height: 800 }, ...extra });

describe('parseDocument', () => {
  it('accepts a minimal document and defaults annotations', () => {
    expect(doc().annotations).toEqual([]);
  });

  it('reports every problem with its path', () => {
    expect(() =>
      parseDocument({ version: 1, source: { path: 'shot.png' }, annotations: [{ type: 'rect', box: [0, 0, -1, 10] }, { type: 'guide' }] }),
    ).toThrow(/annotations\.0\.box\.2[\s\S]*annotations\.1: a guide needs exactly one of x or y/);
  });
});

describe('camera', () => {
  it('zooms about a fixed point, so the subject does not drift', () => {
    const from = { x: 0, y: 0, w: 1280, h: 800 };
    const to = { x: 640, y: 300, w: 320, h: 200 };
    const k = to.w / from.w;
    const fx = (to.x - k * from.x) / (1 - k);
    const positions = [0.25, 0.5, 0.75].map(u => {
      const rect = zoomBetween(from, to, u);
      return (fx - rect.x) / rect.w;
    });
    for (const position of positions) expect(position).toBeCloseTo(positions[0] as number, 9);
    expect(zoomBetween(from, to, 1).w).toBeCloseTo(320);
  });

  it('merges nearby input events into one shot and pans straight between distant ones', () => {
    const shots = planShots(
      doc({
        events: [
          { t: 1.35, type: 'click', at: [480, 248] },
          { t: 1.9, end: 3.1, type: 'type', at: [480, 248] },
          { t: 4.2, type: 'click', at: [1100, 700] },
        ],
        camera: [{ type: 'auto' }],
      }),
      1280,
      800,
    );
    expect(shots).toHaveLength(2);
    expect(shots[0]?.end).toBe(shots[1]?.start);
    for (const shot of shots) expect(shot.rect.w / shot.rect.h).toBeCloseTo(1.6);
  });
});

describe('narration', () => {
  it('ends a cue at the next one, flags cues too fast to read, and stops at the end', () => {
    const cues = timeCues(
      [
        { t: 0, text: 'Open the settings' },
        { t: 1, text: 'This caption is far too long to read in the single second it is shown' },
        { t: 2, text: 'Done' },
      ],
      4,
    );
    expect(cues.map(cue => [cue.start, cue.end, cue.tooFast])).toEqual([
      [0, 1, true],
      [1, 2, true],
      [2, 4, false],
    ]);
  });

  it('exports WebVTT, SRT, and a Markdown transcript', () => {
    const cues = timeCues([{ t: 61.5, text: 'Save with ⌘S', end: 63 }], 70);
    expect(toVtt(cues)).toBe('WEBVTT\n\n1\n00:01:01.500 --> 00:01:03.000\nSave with ⌘S\n');
    expect(toSrt(cues)).toBe('1\n00:01:01,500 --> 00:01:03,000\nSave with ⌘S\n');
    expect(toMarkdown(cues)).toContain('- `1:01.5` Save with ⌘S');
  });
});

describe('checkDocument', () => {
  it('finds unknown references, marks outside the frame, partial redactions, and fast captions', () => {
    const issues = checkDocument(
      doc({
        annotations: [
          { type: 'arrow', from: [10, 10], to: 'missing' },
          { type: 'rect', box: [1200, 10, 200, 20] },
          { type: 'redact', box: [0, 0, 10, 10], time: [0, 1] },
          { id: 'same', type: 'callout', at: [1, 1], text: 'a' },
          { id: 'same', type: 'callout', at: [2, 2], text: 'b' },
        ],
        narration: [
          { t: 0, text: 'A caption that is much too long to read before the next one starts' },
          { t: 0.5, text: 'Next' },
        ],
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', path: 'annotations.0.to' }),
        expect.objectContaining({ level: 'warning', path: 'annotations.1.box' }),
        expect.objectContaining({ level: 'warning', path: 'annotations.2.time' }),
        expect.objectContaining({ level: 'warning', path: 'narration.0' }),
        expect.objectContaining({ level: 'error', path: 'annotations.4.id' }),
      ]),
    );
  });
});

describe('frameAt', () => {
  it('numbers steps in order of appearance and escapes text', () => {
    const resolved = resolveDocument(
      doc({
        annotations: [
          { type: 'rect', box: [10, 10, 50, 50], step: true, label: 'second <b>', time: [2, 4] },
          { type: 'rect', box: [100, 10, 50, 50], step: true, label: 'first', time: [1, 4] },
        ],
      }),
    );
    const frame = frameAt(resolved, 3, { width: 1280, animate: false });
    expect(frame.over).toContain('second &lt;b&gt;');
    expect(resolved.doc.annotations.map(a => resolved.steps.get(a))).toEqual([2, 1]);
  });

  it('draws captions only when asked and keeps the last caption on the final frame', () => {
    const resolved = resolveDocument(doc({ narration: [{ t: 0, text: 'Hello' }] }));
    expect(frameAt(resolved, resolved.duration, { width: 640 }).over).toContain('Hello');
    expect(frameAt(resolved, resolved.duration, { width: 640, captions: false }).over).not.toContain('Hello');
  });

  it('draws marks that are there from the start fully on the first frame', () => {
    const resolved = resolveDocument(
      doc({
        annotations: [{ type: 'guide', x: 640 }, { type: 'arrow', from: [10, 10], to: [200, 200], time: [0, 5] }, { type: 'guide', y: 400, time: [2, 5] }],
        narration: [{ t: 0, text: 'First' }],
      }),
    );
    const first = frameAt(resolved, 0, { width: 1280 });
    expect(first.over).toContain('y2="800"');
    expect(first.over).not.toContain('stroke-dashoffset');
    expect(first.over).toContain('<g opacity="1"><rect');
    // A mark that appears later still animates in.
    expect(frameAt(resolved, 2.1, { width: 1280 }).over).toMatch(/x2="[0-9.]+" y2="400"/);
    expect(frameAt(resolved, 2.1, { width: 1280 }).over).not.toContain('x2="1280" y2="400"');
  });

  it('redacts on every frame of its window, even where marks fade in and out', () => {
    const resolved = resolveDocument(doc({ duration: 3, annotations: [{ type: 'redact', box: [1, 2, 3, 4], time: [1, 2] }] }));
    for (const t of [1, 1.1, 2]) expect(frameAt(resolved, t, { width: 640 }).redactions, `t=${t}`).toHaveLength(1);
    expect(frameAt(resolved, 2.01, { width: 640 }).redactions).toEqual([]);
  });

  it('survives reference cycles, which check reports', () => {
    const input = doc({
      annotations: [
        { id: 'a', type: 'callout', at: 'b', text: 'a' },
        { id: 'b', type: 'callout', at: 'a', text: 'b' },
      ],
    });
    expect(() => frameAt(resolveDocument(input), 0, { width: 640 })).not.toThrow();
    expect(checkDocument(input)).toEqual(expect.arrayContaining([expect.objectContaining({ level: 'error', path: 'annotations.0.at', message: expect.stringMatching(/leads back to itself/) })]));
  });

  it('keeps labels off other marks', () => {
    const resolved = resolveDocument(
      doc({
        annotations: [
          { type: 'rect', box: [100, 80, 600, 40], label: 'Upper' },
          { type: 'rect', box: [100, 140, 200, 40], label: 'Lower' },
        ],
      }),
    );
    const svg = frameAt(resolved, 0, { width: 1280, animate: false }).over;
    const y = (label: string) => Number(new RegExp(`y="([0-9.]+)"[^>]*>${label}<`).exec(svg)?.[1]);
    // Above "Lower" is "Upper", so its label goes below its box instead.
    expect(y('Lower')).toBeGreaterThan(180);
    expect(y('Upper')).toBeLessThan(80);
  });

  it('attaches box labels as tabs on the box edge, and frees them when they must move into the frame', () => {
    const tabs = (box: [number, number, number, number]) =>
      frameAt(resolveDocument(doc({ annotations: [{ type: 'rect', box, label: 'Tab' }] })), 0, { width: 1280, animate: false }).over;
    // At 1280 px wide the stroke is 3.2 px, centered on the edge, so the tab meets its outside at y - 1.6 (y + h + 1.6 below).
    expect(tabs([100, 200, 300, 40])).toContain('<path d="M98.4 198.4V');
    expect(tabs([100, 2, 300, 40])).toContain('<path d="M98.4 43.6H');
    const full = tabs([100, 0, 300, 800]);
    expect(full).not.toContain('<path d=');
    expect(full).toContain('filter="url(#annotate-label-shadow)"');
    expect(full).toContain('<filter id="annotate-label-shadow"');
  });

  it('returns raster work separately: redactions in source pixels and lenses in output pixels', () => {
    const resolved = resolveDocument(
      doc({ annotations: [{ type: 'redact', box: [1, 2, 3, 4] }, { type: 'magnify', box: [0, 0, 100, 50], into: [200, 200, 400, 200] }] }),
    );
    const frame = frameAt(resolved, 0, { width: 640, animate: false });
    expect(frame.redactions).toEqual([{ box: [1, 2, 3, 4], style: 'fill' }]);
    expect(frame.magnifiers[0]?.dest).toEqual([100, 100, 200, 100]);
    expect(frame.height).toBe(400);
  });
});

describe('text', () => {
  it('measures and wraps without fonts', () => {
    expect(measureText('Save', 10)).toBeCloseTo(((667 + 556 + 500 + 556) / 1000) * 10);
    expect(measureText('Save', 10, 700)).toBeGreaterThan(measureText('Save', 10));
    expect(wrapText('one two three four', 10, measureText('three four', 10))).toEqual(['one two', 'three four']);
  });
});
