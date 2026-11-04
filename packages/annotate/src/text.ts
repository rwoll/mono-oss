// Text layout that does not depend on installed fonts, so a label is the same size
// in a PNG rendered by sharp and in the browser player. Widths are Helvetica's
// (Arial is metric-compatible) in 1/1000 em for ASCII 32-126; labels are centered
// in their pills, so a slightly different system font still fits.
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

export const FONT_FAMILY = "Helvetica, Arial, 'Liberation Sans', 'Nimbus Sans', sans-serif";

function advance(code: number, bold: boolean): number {
  if (code >= 32 && code <= 126) return (bold ? BOLD : REGULAR)[code - 32] as number;
  if (code >= 0x1f000) return 1250;
  if ((code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xffef)) return 1000;
  if (code >= 0x2190 && code <= 0x23ff) return 1000;
  if (code === 0xa0) return 278;
  return 600;
}

/** Width of text in pixels at a font size, for weights 400 (regular) and 600+ (bold). */
export function measureText(text: string, size: number, weight = 400): number {
  const bold = weight >= 600;
  let total = 0;
  for (const char of text) total += advance(char.codePointAt(0) ?? 32, bold);
  return (total / 1000) * size;
}

/** Splits text into lines no wider than maxWidth, breaking at spaces (and inside words that are too long). */
export function wrapText(text: string, size: number, maxWidth: number, weight = 400): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (measureText(next, size, weight) <= maxWidth) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    let rest = word;
    while (measureText(rest, size, weight) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && measureText(rest.slice(0, cut), size, weight) > maxWidth) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}
