import type { Cue } from './schema.ts';

/** Reading speed for captions, in characters per second. */
export const READING_CPS = 15;
/** The shortest time any caption should stay up, in seconds. */
export const MIN_CUE_SECONDS = 1.2;
/** How long a caption lingers past its reading time when nothing follows it. */
const LINGER_SECONDS = 2.5;

export interface TimedCue {
  start: number;
  end: number;
  text: string;
  /** Seconds a viewer needs to read it. */
  needs: number;
  /** True when it is shown for less than its reading time. */
  tooFast: boolean;
}

export const readingTime = (text: string) => Math.max(MIN_CUE_SECONDS, text.length / READING_CPS + 0.4);

/**
 * Times the captions: each starts at t and ends at its explicit end, else at the next
 * caption, else after its reading time plus a moment. Ends never pass `duration`.
 */
export function timeCues(cues: readonly Cue[], duration: number): TimedCue[] {
  const sorted = [...cues].sort((a, b) => a.t - b.t);
  return sorted.map((cue, index) => {
    const needs = readingTime(cue.text);
    const next = sorted[index + 1]?.t ?? Infinity;
    const natural = Math.min(next, cue.t + needs + LINGER_SECONDS);
    const end = Math.min(cue.end ?? natural, duration > 0 ? duration : Infinity);
    return { start: cue.t, end, text: cue.text, needs, tooFast: end - cue.t < needs - 0.05 };
  });
}

/** The time a cue list needs, for documents without an explicit duration. */
export function cuesEnd(cues: readonly Cue[]): number {
  return timeCues(cues, 0).reduce((end, cue) => Math.max(end, Number.isFinite(cue.end) ? cue.end : cue.start + cue.needs), 0);
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');
function clock(seconds: number, separator: '.' | ','): string {
  const ms = Math.round(seconds * 1000);
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}
/** m:ss.s, for transcripts. */
export const shortTime = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;

export function toVtt(cues: readonly TimedCue[]): string {
  return `WEBVTT\n\n${cues.map((cue, index) => `${index + 1}\n${clock(cue.start, '.')} --> ${clock(cue.end, '.')}\n${cue.text}\n`).join('\n')}`;
}

export function toSrt(cues: readonly TimedCue[]): string {
  return cues.map((cue, index) => `${index + 1}\n${clock(cue.start, ',')} --> ${clock(cue.end, ',')}\n${cue.text}\n`).join('\n');
}

/** A collapsible transcript for a pull request or issue, under the video it describes. */
export function toMarkdown(cues: readonly TimedCue[]): string {
  const lines = cues.map(cue => `- \`${shortTime(cue.start)}\` ${cue.text.replace(/\s+/g, ' ')}`);
  return `<details><summary>Transcript</summary>\n\n${lines.join('\n')}\n\n</details>\n`;
}
