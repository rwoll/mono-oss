// Synthetic screenshots for tests: an SVG settings screen rendered to PNG by sharp,
// so no real screenshot (or anything in one) is ever checked in.
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

export const SCREEN = { width: 1280, height: 800 };
/** Where things are on the screen, in source pixels. */
export const LAYOUT = {
  save: [740, 352, 136, 36] as [number, number, number, number],
  saveBefore: [732, 356, 136, 32] as [number, number, number, number],
  apiKey: [952, 210, 244, 24] as [number, number, number, number],
  toggle: [836, 513, 40, 22] as [number, number, number, number],
  footer: [256, 770, 236, 16] as [number, number, number, number],
};
export const API_KEY_COLOR = { r: 0xd9, g: 0x2d, b: 0x20 };

export function screenSvg(variant: 'before' | 'after' = 'after'): string {
  const before = variant === 'before';
  const save = before ? LAYOUT.saveBefore : LAYOUT.save;
  const text = (x: number, y: number, value: string, size = 14, fill = '#1f2328', weight = 400, anchor = 'start') =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${value}</text>`;
  const card = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#fff" stroke="#d1d9e0"/>`;
  const toggle = (y: number) => `<rect x="836" y="${y - 11}" width="40" height="22" rx="11" fill="#1f883d"/><circle cx="865" cy="${y}" r="8" fill="#fff"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" font-family="Helvetica, Arial, sans-serif">
<rect width="1280" height="800" fill="#f6f8fa"/>
<rect width="1280" height="56" fill="#1f2328"/>${text(52, 33, 'Acme Console', 15, '#fff', 600)}
<rect x="0" y="56" width="220" height="744" fill="#fff"/>
${['Overview', 'Projects', 'Members', 'Billing', 'Settings'].map((name, i) => text(46, 93 + i * 40, name, 14, '#1f2328', name === 'Settings' ? 600 : 400)).join('')}
${text(260, 96, 'Settings', 24, '#1f2328', 700)}
${card(260, 156, 640, 248)}${text(284, 191, 'Profile', 16, '#1f2328', 700)}
<rect x="284" y="230" width="400" height="36" rx="6" fill="#fff" stroke="#d1d9e0"/>${text(296, 253, 'Ada Lovelace', 15)}
<rect x="284" y="296" width="400" height="36" rx="6" fill="#fff" stroke="#d1d9e0"/>${text(296, 319, 'ada@example.com', 15)}
${text(284, 350, "We'll never share your email.", 12, before ? '#c4cad1' : '#59636e')}
<rect x="${save[0]}" y="${save[1]}" width="${save[2]}" height="${save[3]}" rx="6" fill="#1f883d"/>${text(save[0] + save[2] / 2, save[1] + save[3] / 2 + 5, 'Save changes', 14, '#fff', 600, 'middle')}
${card(260, 420, 640, 172)}${text(284, 455, 'Notifications', 16, '#1f2328', 700)}
${['Email digests', 'Product updates', 'Security alerts'].map((name, i) => text(284, 493 + i * 36, name, 14) + toggle(488 + i * 36)).join('')}
${card(920, 156, 320, 180)}${text(944, 191, 'API key', 16, '#1f2328', 700)}
<rect x="944" y="204" width="272" height="36" rx="6" fill="#f6f8fa" stroke="#d1d9e0"/>
<rect x="${LAYOUT.apiKey[0]}" y="${LAYOUT.apiKey[1]}" width="${LAYOUT.apiKey[2]}" height="${LAYOUT.apiKey[3]}" fill="rgb(${API_KEY_COLOR.r},${API_KEY_COLOR.g},${API_KEY_COLOR.b})"/>
${card(920, 352, 320, 240)}${text(944, 387, 'Plan', 16, '#1f2328', 700)}${text(944, 427, 'Pro', 22, '#1f2328', 700)}
<rect x="944" y="540" width="100" height="32" rx="6" fill="${before ? '#f6f8fa' : '#0969da'}" stroke="#d1d9e0"/>${text(994, 561, 'Upgrade', 14, before ? '#1f2328' : '#fff', 600, 'middle')}
<rect x="240" y="756" width="1020" height="1" fill="#d1d9e0"/>${text(260, 781, 'Acme Console v2.8.1 · build 4f9c2a1', 9, '#8c959f')}
</svg>`;
}

/** Writes the synthetic screen as a PNG. */
export async function writeScreen(path: string, variant: 'before' | 'after' = 'after'): Promise<void> {
  await writeFile(path, await sharp(Buffer.from(screenSvg(variant))).png().toBuffer());
}

/** Reads one pixel of an image as RGB. */
export async function pixel(path: string, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.round(y) * info.width + Math.round(x)) * info.channels;
  return { r: data[i] as number, g: data[i + 1] as number, b: data[i + 2] as number };
}
