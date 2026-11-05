import { z } from 'zod';

// Every coordinate is in source pixels: the pixels of the screenshot or video, not CSS pixels.
const coordinate = z.number().finite();
const seconds = z.number().finite().nonnegative();

export const pointSchema = z.tuple([coordinate, coordinate]).describe('[x, y] in source pixels.');
export const boxSchema = z
  .tuple([coordinate, coordinate, z.number().finite().positive(), z.number().finite().positive()])
  .describe('[x, y, width, height] in source pixels.');
export const timeSchema = z
  .tuple([seconds, seconds])
  .refine(([start, end]) => end >= start, 'the end must not be before the start')
  .describe('[start, end] in seconds. Omit to show it for the whole document.');
const reference = z.string().min(1).describe('The id of another annotation.');
const pointOrReference = z.union([pointSchema, reference]);

export const TONES = ['problem', 'warning', 'changed', 'added', 'removed', 'note', 'success', 'accent'] as const;
export const toneSchema = z.enum(TONES).describe('What the mark means. Colors follow from it.');

const base = {
  id: z.string().min(1).max(100).optional().describe('Lets other annotations refer to this one.'),
  time: timeSchema.optional(),
  tone: toneSchema.optional(),
};
const label = z.string().min(1).max(200).optional().describe('Short text shown next to the mark.');
const note = z
  .string()
  .min(1)
  .max(1000)
  .optional()
  .describe('A longer explanation, shown in the notes panel beside or below the image; **bold** and `code` are styled. The mark gets a number that matches it.');
const target = z
  .string()
  .max(500)
  .optional()
  .describe('How the box was found, such as a Playwright locator. Informational; the box is what renders.');
const step = z
  .union([z.literal(true), z.number().int().positive()])
  .optional()
  .describe('Show a step number: true numbers steps in order of appearance.');

const shape = <T extends string>(type: T, description: string) =>
  z.object({ type: z.literal(type), ...base, box: boxSchema, label, note, step, target }).describe(description);

export const annotationSchema = z.discriminatedUnion('type', [
  shape('rect', 'A rectangle around something.'),
  shape('ellipse', 'An ellipse around something.'),
  z
    .object({
      type: z.literal('arrow'),
      ...base,
      from: pointOrReference,
      to: pointOrReference,
      label,
      note,
      bend: z.number().min(-1).max(1).optional().describe('Curvature, -1 to 1. Default 0.2.'),
    })
    .describe('An arrow. A reference points at the edge of that annotation.'),
  z
    .object({ type: z.literal('callout'), ...base, at: pointOrReference, text: z.string().min(1).max(300) })
    .describe('A note at a point.'),
  z
    .object({ type: z.literal('step'), ...base, at: pointOrReference, n: z.number().int().positive().optional() })
    .describe('A numbered badge.'),
  z
    .object({
      type: z.literal('guide'),
      ...base,
      x: coordinate.optional(),
      y: coordinate.optional(),
      label,
    })
    .refine(guide => (guide.x === undefined) !== (guide.y === undefined), 'a guide needs exactly one of x or y')
    .describe('A full-length line, such as a content edge.'),
  z
    .object({ type: z.literal('measure'), ...base, from: pointSchema, to: pointSchema, label, note })
    .describe('A dimension line labeled with its length in source pixels.'),
  z
    .object({ type: z.literal('spotlight'), ...base, box: boxSchema, pad: z.number().nonnegative().max(200).optional() })
    .describe('Dims everything except the box.'),
  z
    .object({ type: z.literal('magnify'), ...base, box: boxSchema, into: boxSchema, label })
    .describe('A lens: shows box enlarged at into, with connector lines.'),
  z
    .object({
      type: z.literal('redact'),
      ...base,
      box: boxSchema,
      style: z.enum(['fill', 'pixelate']).optional().describe('fill (default) is solid; pixelate keeps the layout readable.'),
    })
    .describe('Hides pixels. Applied to the source before anything else, so it never reaches an output.'),
  z.object({ type: z.literal('clicks'), ...base }).describe('Shows a ripple at each click event.'),
  z.object({ type: z.literal('keys'), ...base }).describe('Shows each key event as a chip.'),
]);

export const eventSchema = z
  .object({
    t: seconds,
    type: z.enum(['click', 'key', 'type', 'scroll']),
    at: pointSchema.optional().describe('Where it happened; auto zoom needs it.'),
    end: seconds.optional().describe('When a type or scroll event ended.'),
    keys: z.string().max(50).optional().describe('For key events, such as "⌘S".'),
  })
  .describe('Input recorded with the video.');

export const shotSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('zoom'),
      time: timeSchema,
      box: boxSchema,
      ease: z.number().min(0.05).max(5).optional().describe('Seconds to zoom in and out. Default 0.7.'),
    })
    .describe('Zoom the camera onto a box.'),
  z
    .object({
      type: z.literal('auto'),
      from: z.array(z.enum(['click', 'key', 'type', 'scroll'])).optional().describe('Event types to follow. Default click, type, key.'),
      zoom: z.number().min(1).max(8).optional().describe('Zoom factor. Default 2.2.'),
      lead: z.number().nonnegative().max(5).optional().describe('Seconds to arrive before the event. Default 0.8.'),
      hold: z.number().nonnegative().max(10).optional().describe('Seconds to stay after it. Default 1.'),
      ease: z.number().min(0.05).max(5).optional(),
    })
    .describe('Follow the input events: nearby events share a shot, distant ones pan.'),
]);

export const cueSchema = z
  .object({
    t: seconds,
    text: z.string().min(1).max(500),
    end: seconds.optional().describe('Default: when the next cue starts, or after the reading time.'),
  })
  .describe('One caption.');

export const mediaSchema = z
  .object({
    path: z.string().min(1).describe('Image or video file, relative to the document.'),
    width: z.number().int().positive().optional().describe('Filled in by `annotate init`, or read from the file.'),
    height: z.number().int().positive().optional(),
    duration: seconds.optional().describe('Video length in seconds.'),
    scale: z.number().positive().max(8).optional().describe('Device pixel ratio of a screenshot, such as 2.'),
  })
  .describe('An image or video.');

export const documentSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    source: mediaSchema,
    duration: seconds.optional().describe('Timeline length. Default: the video length, or the last time used.'),
    compare: z
      .object({
        before: mediaSchema,
        track: z
          .array(z.tuple([seconds, z.number().min(0).max(1)]))
          .min(1)
          .describe('[time, position] keyframes: 0 shows only before, 1 only after.'),
      })
      .optional()
      .describe('Before/after wipe between two images of the same size.'),
    events: z.array(eventSchema).max(5000).optional(),
    camera: z.array(shotSchema).max(500).optional(),
    annotations: z.array(annotationSchema).max(2000).default([]),
    notes: z
      .object({
        title: z.string().min(1).max(200).optional().describe('Heading of the panel.'),
        side: z
          .enum(['auto', 'right', 'bottom'])
          .optional()
          .describe('Where the panel goes. auto (default) puts it on the right of tall or square images, else below, so wide screenshots keep their width.'),
      })
      .optional()
      .describe('The notes panel, shown when any mark has a note.'),
    narration: z.array(cueSchema).max(1000).optional().describe('Captions. Silent videos rely on them.'),
    output: z
      .object({
        width: z.number().int().min(16).max(7680).optional(),
        fps: z.number().int().min(1).max(60).optional(),
        scale: z.number().min(0.25).max(4).optional().describe('Size of marks and text. Default 1.'),
      })
      .optional(),
  })
  .describe('An annotate document.');

export type Point = z.output<typeof pointSchema>;
export type Box = z.output<typeof boxSchema>;
export type Tone = z.output<typeof toneSchema>;
export type Annotation = z.output<typeof annotationSchema>;
export type AnnotationType = Annotation['type'];
export type AnnotateEvent = z.output<typeof eventSchema>;
export type Shot = z.output<typeof shotSchema>;
export type Cue = z.output<typeof cueSchema>;
export type Media = z.output<typeof mediaSchema>;
export type AnnotateDocument = z.output<typeof documentSchema>;
export type AnnotateDocumentInput = z.input<typeof documentSchema>;

/** The document's JSON Schema, for editors and agents. */
export function jsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(documentSchema, { io: 'input' }) as Record<string, unknown>;
}
