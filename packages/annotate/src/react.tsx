import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { FrameView, toSource, toView, type FrameSources, type MediaElement } from './browser.ts';
import { resolveDocument, type ResolvedDocument } from './document.ts';
import { frameAt, type Frame } from './frame.ts';
import { mediaKind } from './media.ts';
import { shortTime } from './narration.ts';
import type { AnnotateDocument, Point } from './schema.ts';

/** What `overlay` gets on every frame, for drawing editing handles on top of the player. */
export interface PlayerView {
  frame: Frame;
  /** Source pixels to CSS pixels from the stage's top-left. */
  toView(point: Point): Point;
  /** CSS pixels from the stage's top-left to source pixels. */
  toSource(point: Point): Point;
}

export interface AnnotatePlayerProps {
  /** A document with its source size filled in (see `annotate init`). */
  document: AnnotateDocument;
  /** URL of the source image or video. */
  src: string;
  /** URL of the before image or video, for documents with `compare`. */
  beforeSrc?: string | undefined;
  /** Controlled time in seconds. */
  time?: number | undefined;
  onTimeChange?: ((time: number) => void) | undefined;
  autoPlay?: boolean | undefined;
  loop?: boolean | undefined;
  /** Captions on (default) or off. Controlled when set. */
  captions?: boolean | undefined;
  onCaptionsChange?: ((captions: boolean) => void) | undefined;
  /** Follow the camera (default). False shows the whole frame, for editing. */
  camera?: boolean | undefined;
  /** Show the play, scrub, and caption controls (default). */
  controls?: boolean | undefined;
  /** Drawn over the stage on every frame, such as editing handles. */
  overlay?: ((view: PlayerView) => ReactNode) | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

function createMedia(src: string, onReady: () => void): { element: MediaElement; dispose(): void } {
  if (mediaKind(src.split(/[?#]/)[0] ?? src) === 'video') {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('seeked', onReady);
    video.src = src;
    return {
      element: video,
      dispose() {
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('seeked', onReady);
        video.removeAttribute('src');
        video.load();
      },
    };
  }
  const image = new Image();
  image.decoding = 'async';
  image.addEventListener('load', onReady);
  image.src = src;
  return { element: image, dispose: () => image.removeEventListener('load', onReady) };
}

/** Moves a video to a time when it is not already there. */
function seek(video: HTMLVideoElement, time: number, tolerance = 0.01): void {
  if (Math.abs(video.currentTime - time) > tolerance) video.currentTime = time;
}

const button: CSSProperties = { font: 'inherit', color: 'inherit', background: 'transparent', border: 0, padding: '2px 6px', cursor: 'pointer' };

/** Plays an annotate document over its image or video, with the camera, captions, and before/after wipe. */
export function AnnotatePlayer(props: AnnotatePlayerProps): ReactNode {
  const { document: doc, src, beforeSrc, autoPlay = false, loop = false, camera = true, controls = true, overlay, onTimeChange, onCaptionsChange } = props;
  const resolved = useMemo<ResolvedDocument | Error>(() => {
    try {
      return resolveDocument(doc);
    } catch (error) {
      return error as Error;
    }
  }, [doc]);
  const duration = resolved instanceof Error ? 0 : resolved.duration;
  const stage = useRef<HTMLDivElement>(null);
  const view = useRef<FrameView>(undefined);
  const sources = useRef<Partial<FrameSources>>({});
  const timeRef = useRef(0);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [mediaVersion, setMediaVersion] = useState(0);
  const [internalTime, setInternalTime] = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
  const [internalCaptions, setInternalCaptions] = useState(true);
  const [wipe, setWipe] = useState<number>();
  const time = Math.min(props.time ?? internalTime, duration || Infinity);
  const captions = props.captions ?? internalCaptions;
  const controlledTime = props.time !== undefined;

  const setTime = useCallback(
    (next: number) => {
      if (!controlledTime) setInternalTime(next);
      onTimeChange?.(next);
    },
    [controlledTime, onTimeChange],
  );

  useEffect(() => {
    timeRef.current = time;
  }, [time]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const frameView = new FrameView(element);
    view.current = frameView;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box) setSize({ width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height)) });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      frameView.destroy();
      view.current = undefined;
    };
  }, []);

  useEffect(() => {
    const changed = () => setMediaVersion(version => version + 1);
    const main = createMedia(src, changed);
    const before = beforeSrc ? createMedia(beforeSrc, changed) : undefined;
    sources.current = { main: main.element, before: before?.element };
    return () => {
      main.dispose();
      before?.dispose();
      sources.current = {};
    };
  }, [src, beforeSrc]);

  // Playback: videos play natively and report their time; stills advance on a clock.
  useEffect(() => {
    if (!playing || duration <= 0) return;
    const main = sources.current.main;
    const video = main instanceof HTMLVideoElement ? main : undefined;
    let raf = 0;
    let last = performance.now();
    if (video) {
      seek(video, timeRef.current, 0.1);
      void video.play().catch(() => {});
    }
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const fromVideo = video && !video.paused && !video.ended && timeRef.current < (video.duration || Infinity);
      let next = fromVideo ? video.currentTime : timeRef.current + dt;
      if (next >= duration) {
        next = loop ? 0 : duration;
        if (video && loop) seek(video, 0);
        if (!loop) setPlaying(false);
      }
      timeRef.current = next;
      setTime(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      video?.pause();
    };
  }, [playing, duration, loop, setTime, mediaVersion]);

  // Paused: seek videos to the shown time; they repaint when the seek lands.
  useEffect(() => {
    if (playing) return;
    for (const element of [sources.current.main, sources.current.before]) {
      if (element instanceof HTMLVideoElement && element.readyState >= 1) seek(element, time);
    }
  }, [playing, time, mediaVersion]);

  const frame = useMemo(
    () => (size && !(resolved instanceof Error) ? frameAt(resolved, time, { width: size.width, height: size.height, captions, camera, wipe }) : undefined),
    [resolved, time, size, captions, camera, wipe],
  );

  useLayoutEffect(() => {
    const { main, before } = sources.current;
    if (frame && main && view.current && !(resolved instanceof Error)) view.current.paint(frame, resolved, { main, before });
  }, [frame, resolved, mediaVersion]);

  const dragWipe = (event: PointerEvent<HTMLDivElement>) => {
    if (!doc.compare || overlay || (event.type === 'pointermove' && event.buttons !== 1)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setPlaying(false);
    setWipe(Math.min(1, Math.max(0, 1 - (event.clientX - rect.left) / rect.width)));
  };
  const toggleCaptions = () => {
    if (props.captions === undefined) setInternalCaptions(!captions);
    onCaptionsChange?.(!captions);
  };

  if (resolved instanceof Error) {
    return (
      <div className={props.className} style={props.style} role="alert">
        {resolved.message}
      </div>
    );
  }
  return (
    <div className={props.className} style={props.style}>
      <div
        ref={stage}
        onPointerDown={dragWipe}
        onPointerMove={dragWipe}
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: `${resolved.width} / ${resolved.height}`,
          background: '#000',
          overflow: 'hidden',
          cursor: doc.compare && !overlay ? 'ew-resize' : undefined,
          touchAction: 'none',
        }}
      >
        {frame && overlay && <div style={{ position: 'absolute', inset: 0 }}>{overlay({ frame, toView: point => toView(frame, point), toSource: point => toSource(frame, point) })}</div>}
      </div>
      {controls && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          {duration > 0 && (
            <button
              type="button"
              style={button}
              onClick={() => {
                if (!playing) {
                  setWipe(undefined);
                  if (time >= duration) setTime(0);
                }
                setPlaying(!playing);
              }}
            >
              {playing ? 'Pause' : 'Play'}
            </button>
          )}
          {duration > 0 && (
            <input
              type="range"
              aria-label="Time"
              min={0}
              max={duration}
              step={0.01}
              value={time}
              onChange={event => {
                setPlaying(false);
                setWipe(undefined);
                setTime(Number(event.currentTarget.value));
              }}
              style={{ flex: 1 }}
            />
          )}
          {duration > 0 && (
            <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.75 }}>
              {shortTime(time)} / {shortTime(duration)}
            </span>
          )}
          {(doc.narration?.length ?? 0) > 0 && (
            <button type="button" style={{ ...button, fontWeight: captions ? 700 : 400 }} aria-pressed={captions} title="Captions" onClick={toggleCaptions}>
              CC
            </button>
          )}
        </div>
      )}
    </div>
  );
}
