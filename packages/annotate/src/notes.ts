import type { ResolvedDocument } from './document.ts';
import { labelTextColor, TONE_LABEL_COLORS } from './frame.ts';
import type { Annotation, Tone } from './schema.ts';
import { measureText } from './text.ts';

export type NotesSide = 'right' | 'bottom';

/** The notes panel: an SVG fragment in its own pixels, from its top-left, placed right of or below the image. */
export interface NotesPanel {
  side: NotesSide;
  width: number;
  height: number;
  background: string;
  svg: string;
}

export interface NotesOptions {
  /** Width of the image the panel goes with, in output pixels. */
  width: number;
  /** Height of the image. */
  height: number;
  /** Multiplies the size of the text, as for the marks. Default: the document's output.scale, else 1. */
  scale?: number;
  /** Dim the notes of marks not shown at t. Default true; false shows every note at full strength. */
  dim?: boolean;
}

const COLORS = { background: '#f6f8fa', text: '#1f2328', code: '#e6eaef', border: '#d0d7de' };
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";
// Monospace fonts advance 0.6 em per character, close enough to lay out without the font.
const MONO_ADVANCE = 0.6;

const n = (value: number) => Math.round(value * 100) / 100;
const escape = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

interface Word {
  text: string;
  bold: boolean;
  code: boolean;
  /** A space comes before it. */
  space: boolean;
}

/** Splits text into words, reading **bold** and `code`. */
function words(text: string, bold = false): Word[] {
  const out: Word[] = [];
  let space = false;
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    const isBold = part.length > 4 && part.startsWith('**') && part.endsWith('**');
    const isCode = !isBold && part.length > 2 && part.startsWith('`') && part.endsWith('`');
    const body = isBold ? part.slice(2, -2) : isCode ? part.slice(1, -1) : part;
    // Code stays in one piece, so a span like `padding-right: 24px` is one chip.
    for (const piece of isCode ? [body] : body.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) space = true;
      else {
        out.push({ text: piece, bold: bold || isBold, code: isCode, space });
        space = false;
      }
    }
  }
  return out;
}

/** Lays out text at (x, y), y being the first baseline. Returns the SVG and the last baseline. */
function paragraph(text: string, x: number, y: number, maxWidth: number, size: number, lineHeight: number, bold = false): { svg: string; last: number } {
  const space = measureText(' ', size);
  const pad = 0.25 * size;
  let svg = '';
  let cx = x;
  let cy = y;
  for (const word of words(text, bold)) {
    const fs = word.code ? 0.88 * size : size;
    const width = word.code ? word.text.length * MONO_ADVANCE * fs + 2 * pad : measureText(word.text, fs, word.bold ? 700 : 400);
    let left = cx > x && word.space ? cx + space : cx;
    if (left + width > x + maxWidth && cx > x) {
      cy += lineHeight;
      left = x;
    }
    if (word.code) {
      svg += `<rect x="${n(left)}" y="${n(cy - 0.9 * size)}" width="${n(width)}" height="${n(1.2 * size)}" rx="${n(0.2 * size)}" fill="${COLORS.code}"/>`;
      svg += `<text x="${n(left + pad)}" y="${n(cy)}" font-size="${n(fs)}" font-family="${MONO}" fill="${COLORS.text}">${escape(word.text)}</text>`;
    } else {
      svg += `<text x="${n(left)}" y="${n(cy)}" font-size="${n(fs)}" font-weight="${word.bold ? 700 : 400}" fill="${COLORS.text}">${escape(word.text)}</text>`;
    }
    cx = left + width;
  }
  return { svg, last: cy };
}

const hasNote = (a: Annotation): a is Annotation & { note: string } => 'note' in a && typeof a.note === 'string' && a.note.length > 0;

/**
 * The notes panel for the frame at t, or undefined when no mark has a note. Its size depends only on
 * the document and the image size, never on t, so every frame of a video gets the same canvas.
 */
export function notesPanel(resolved: ResolvedDocument, t: number, options: NotesOptions): NotesPanel | undefined {
  const notes = resolved.doc.annotations
    .filter(hasNote)
    .map(a => ({ a, number: resolved.steps.get(a) ?? 0 }))
    .sort((x, y) => x.number - y.number);
  if (!notes.length) return undefined;
  const { width: W, height: H } = options;
  const u = Math.max(0.75, W / 1000) * (options.scale ?? resolved.doc.output?.scale ?? 1);
  const dim = options.dim ?? true;
  const shown = (a: Annotation) => !dim || !a.time || (t >= a.time[0] && t <= a.time[1]);

  const layout = (side: NotesSide) => {
    const pad = 20 * u;
    const size = 14 * u;
    const lineHeight = 20 * u;
    const r = 10 * u;
    const indent = 2 * r + 10 * u;
    const width = side === 'right' ? Math.round(340 * u) : W;
    const columns = side === 'bottom' && notes.length > 1 && W >= 700 * u ? 2 : 1;
    const gutter = 32 * u;
    const columnWidth = (width - 2 * pad - (columns - 1) * gutter) / columns;
    let svg = '';
    let top = pad;
    if (resolved.doc.notes?.title) {
      const title = paragraph(resolved.doc.notes.title, pad, pad + 17 * u, width - 2 * pad, 17 * u, 23 * u, true);
      svg += title.svg;
      top = title.last + 16 * u;
    }
    let bottom = top;
    const perColumn = Math.ceil(notes.length / columns);
    for (let column = 0; column < columns; column += 1) {
      const x = pad + column * (columnWidth + gutter);
      let y = top + size;
      for (const { a, number } of notes.slice(column * perColumn, (column + 1) * perColumn)) {
        const tone: Tone = a.tone ?? 'note';
        const text = paragraph(a.note, x + indent, y, columnWidth - indent, size, lineHeight);
        const cy = y - 0.35 * size;
        svg +=
          `<g opacity="${shown(a) ? 1 : 0.4}"><circle cx="${n(x + r)}" cy="${n(cy)}" r="${n(r)}" fill="${TONE_LABEL_COLORS[tone]}"/>` +
          `<text x="${n(x + r)}" y="${n(cy + 0.35 * 11.5 * u)}" font-size="${n(11.5 * u)}" font-weight="700" fill="${labelTextColor(tone)}" text-anchor="middle">${number}</text>${text.svg}</g>`;
        bottom = Math.max(bottom, text.last + 0.35 * lineHeight);
        y = text.last + lineHeight + 12 * u;
      }
    }
    const height = Math.ceil(side === 'right' ? Math.max(H, bottom + pad) : bottom + pad);
    const edge = side === 'right' ? `<line x1="0.5" y1="0" x2="0.5" y2="${height}"` : `<line x1="0" y1="0.5" x2="${width}" y2="0.5"`;
    return { width, height, svg: `<rect width="${width}" height="${height}" fill="${COLORS.background}"/>${edge} stroke="${COLORS.border}"/>${svg}` };
  };

  const requested = resolved.doc.notes?.side ?? 'auto';
  let side: NotesSide = requested === 'auto' ? (W / H < 1.3 ? 'right' : 'bottom') : requested;
  let panel = layout(side);
  // On the right, notes taller than the image would leave an empty strip under it; below fits them better.
  if (requested === 'auto' && side === 'right' && panel.height > H) {
    side = 'bottom';
    panel = layout(side);
  }
  return { side, background: COLORS.background, ...panel };
}
