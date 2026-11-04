import { cameraKeyframes, planShots, type Keyframe, type PlannedShot } from './camera.ts';
import { cuesEnd, timeCues, type TimedCue } from './narration.ts';
import { documentSchema, type Annotation, type AnnotateDocument, type Box, type Point } from './schema.ts';

export class AnnotateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AnnotateError';
    this.code = code;
  }
}

/** Validates a document, with every problem in one readable message. */
export function parseDocument(input: unknown): AnnotateDocument {
  const result = documentSchema.safeParse(input);
  if (result.success) return result.data;
  const lines = result.error.issues.map(issue => `- ${issue.path.length ? issue.path.join('.') : '(document)'}: ${issue.message}`);
  throw new AnnotateError('invalid_document', `The document is not valid:\n${lines.join('\n')}`);
}

/** A document with everything derived from it that rendering needs. */
export interface ResolvedDocument {
  doc: AnnotateDocument;
  width: number;
  height: number;
  /** Timeline length in seconds; 0 for a single still frame. */
  duration: number;
  byId: ReadonlyMap<string, Annotation>;
  steps: ReadonlyMap<Annotation, number>;
  shots: readonly PlannedShot[];
  keyframes: readonly Keyframe[];
  cues: readonly TimedCue[];
}

/** Resolves a parsed document. The source size must be known (see `annotate init`). */
export function resolveDocument(doc: AnnotateDocument): ResolvedDocument {
  const { width, height } = doc.source;
  if (!width || !height) {
    throw new AnnotateError('unknown_size', 'source.width and source.height are unknown; run `annotate init` or render with the Node renderer, which reads them from the file.');
  }
  const byId = new Map<string, Annotation>();
  for (const annotation of doc.annotations) {
    if (!annotation.id) continue;
    if (byId.has(annotation.id)) throw new AnnotateError('duplicate_id', `Two annotations have the id "${annotation.id}".`);
    byId.set(annotation.id, annotation);
  }
  const numbered = doc.annotations.filter(a => ('step' in a && a.step === true) || (a.type === 'step' && a.n === undefined));
  const steps = new Map<Annotation, number>();
  [...numbered].sort((a, b) => (a.time?.[0] ?? 0) - (b.time?.[0] ?? 0)).forEach((annotation, index) => steps.set(annotation, index + 1));
  for (const annotation of doc.annotations) {
    if ('step' in annotation && typeof annotation.step === 'number') steps.set(annotation, annotation.step);
    if (annotation.type === 'step' && annotation.n !== undefined) steps.set(annotation, annotation.n);
  }
  const duration = documentDuration(doc);
  const shots = planShots(doc, width, height);
  return {
    doc,
    width,
    height,
    duration,
    byId,
    steps,
    shots,
    keyframes: cameraKeyframes(shots, width, height),
    cues: timeCues(doc.narration ?? [], duration),
  };
}

/** The explicit duration, else the video's length, else the last moment anything happens. */
export function documentDuration(doc: AnnotateDocument): number {
  if (doc.duration !== undefined) return doc.duration;
  if (doc.source.duration !== undefined) return doc.source.duration;
  let end = cuesEnd(doc.narration ?? []);
  for (const annotation of doc.annotations) end = Math.max(end, annotation.time?.[1] ?? 0);
  for (const shot of doc.camera ?? []) end = Math.max(end, shot.type === 'zoom' ? shot.time[1] + (shot.ease ?? 0.7) : 0);
  for (const event of doc.events ?? []) end = Math.max(end, (event.end ?? event.t) + 1);
  for (const [t] of doc.compare?.track ?? []) end = Math.max(end, t);
  // Rounded down to the millisecond, so the last caption or mark still shows on the final frame.
  return Math.floor(end * 1000) / 1000;
}

export interface Issue {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

const isPoint = (value: unknown): value is Point => Array.isArray(value);

/**
 * Problems a schema cannot see: unknown references, marks outside the frame,
 * captions too fast to read, and redactions that do not cover the whole timeline.
 */
export function checkDocument(doc: AnnotateDocument): Issue[] {
  const issues: Issue[] = [];
  const add = (level: Issue['level'], path: string, message: string) => issues.push({ level, path, message });
  const ids = new Set<string>();
  doc.annotations.forEach((annotation, index) => {
    if (!annotation.id) return;
    if (ids.has(annotation.id)) add('error', `annotations.${index}.id`, `another annotation also has the id "${annotation.id}"`);
    ids.add(annotation.id);
  });
  const { width, height } = doc.source;
  const outside = (box: Box) => width !== undefined && height !== undefined && (box[0] < 0 || box[1] < 0 || box[0] + box[2] > width || box[1] + box[3] > height);
  const pointOutside = ([x, y]: Point) => width !== undefined && height !== undefined && (x < 0 || y < 0 || x > width || y > height);
  const duration = documentDuration(doc);

  const byId = new Map(doc.annotations.flatMap(a => (a.id ? [[a.id, a] as const] : [])));
  // Follows a reference to a point: a box ends it; another reference continues it.
  const cycles = (start: string): boolean => {
    const seen = new Set<string>();
    let ref: unknown = start;
    while (typeof ref === 'string') {
      if (seen.has(ref)) return true;
      seen.add(ref);
      const target = byId.get(ref);
      if (!target || 'box' in target) return false;
      ref = 'at' in target ? target.at : undefined;
    }
    return false;
  };
  doc.annotations.forEach((annotation, index) => {
    const path = `annotations.${index}`;
    for (const key of ['from', 'to', 'at'] as const) {
      const value = (annotation as Record<string, unknown>)[key];
      if (typeof value === 'string' && !ids.has(value)) add('error', `${path}.${key}`, `no annotation has the id "${value}"`);
      else if (typeof value === 'string' && cycles(value)) add('error', `${path}.${key}`, `"${value}" leads back to itself through other references`);
      if (isPoint(value) && pointOutside(value)) add('warning', `${path}.${key}`, 'is outside the frame');
    }
    for (const key of ['box', 'into'] as const) {
      const value = (annotation as Record<string, unknown>)[key];
      if (isPoint(value) && outside(value as unknown as Box)) add('warning', `${path}.${key}`, 'extends outside the frame');
    }
    if (annotation.time && duration > 0 && annotation.time[0] >= duration) add('warning', `${path}.time`, `starts after the document ends (${duration}s)`);
    if (annotation.type === 'redact' && annotation.time) {
      add('warning', `${path}.time`, 'a redaction with a time window leaves the pixels visible outside it; remove time to hide them throughout');
    }
  });
  if (doc.camera?.some(shot => shot.type === 'auto') && !(doc.events ?? []).some(event => event.at)) {
    add('warning', 'camera', 'auto zoom follows events with `at`, and there are none');
  }
  (doc.camera ?? []).forEach((shot, index) => {
    if (shot.type === 'zoom' && outside(shot.box)) add('warning', `camera.${index}.box`, 'extends outside the frame');
  });
  for (const cue of timeCues(doc.narration ?? [], duration)) {
    const index = (doc.narration ?? []).findIndex(c => c.t === cue.start && c.text === cue.text);
    if (cue.tooFast) {
      add('warning', `narration.${index}`, `"${cue.text}" needs ${cue.needs.toFixed(1)}s to read but is shown for ${(cue.end - cue.start).toFixed(1)}s`);
    }
  }
  if (doc.compare) {
    const before = doc.compare.before;
    if (before.width && before.height && width && height && (before.width !== width || before.height !== height)) {
      add('warning', 'compare.before', `is ${before.width}×${before.height} but the source is ${width}×${height}; it will be stretched to match`);
    }
  }
  return issues;
}
