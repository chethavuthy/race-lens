/**
 * Find me by face.
 *
 * The differentiator, and the answer when a bib cannot be read — folded, covered
 * by a hand, turned away, which is roughly four photos in ten. The embedding runs
 * here, in the browser: the selfie never leaves the device and only a 512-float
 * vector is sent. That is a real privacy property, so it is stated plainly in the
 * dialog rather than buried in a policy.
 *
 * ~16 MB of ONNX loads on first use, and is warmed during idle time by
 * prewarmModels once an album page is open — so by the time this dialog runs, the
 * bytes are usually already on the device. Its size is deliberately NOT mentioned
 * on screen: it is our engineering problem, not a number a runner can act on, and
 * naming it only invites them to wonder whether to wait.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Upload, X } from 'lucide-react';
import { NoFaceError, embedLargestFace, loadModels, type LoadPhase } from '@/lib/face';
import { ApiError, api, type FaceMatch } from '@/lib/api';
import { Button } from '@/components/ui/button';

type Stage = 'idle' | 'camera' | 'working' | 'error';

const PHASE_COPY: Record<LoadPhase, string> = {
  detector: 'Loading the face detector…',
  recognizer: 'Loading the matcher…',
  ready: 'Looking through the album…',
};

export function FaceSearch({
  slug, open, onClose, onResults,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  onResults: (matches: FaceMatch[], faceCount: number) => void;
}) {
  const [stage, setStage] = useState<Stage>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [phase, setPhase] = useState<LoadPhase | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // `open` as a ref, because getUserMedia resolves after an await and the closure
  // that started it cannot see a later prop.
  const openRef = useRef(open);
  openRef.current = open;

  /**
   * Release the camera, and mean it.
   *
   * Also clears the element's srcObject: a <video> holding a stopped stream keeps
   * a reference to it, and leaving one attached is how a "stopped" camera comes
   * back to life the next time the element plays.
   */
  const stopCamera = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);

  // The camera must stop when the dialog closes, whichever way it closed —
  // button, Escape, or the page navigating away. A live camera light left on
  // after a dialog closes is the kind of thing people notice and do not forgive.
  useEffect(() => {
    if (!open) { stopCamera(); setStage('idle'); setMessage(null); }
    return stopCamera;
  }, [open, stopCamera]);

  /**
   * Lock the page behind the dialog.
   *
   * Padding compensates for the scrollbar the lock removes — without it the
   * whole page shifts sideways as the dialog opens, which reads as a glitch on
   * exactly the interaction that has to feel trustworthy. Restored to whatever
   * was there before rather than to '': the value is not necessarily ours.
   */
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const prev = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: document.body.style.overflow,
      paddingRight: document.body.style.paddingRight,
    };
    // BOTH elements. Which one scrolls depends on the page's own height rules,
    // and locking only <body> left the page scrolling behind the dialog here.
    const gap = window.innerWidth - html.clientWidth;
    html.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;
    return () => {
      html.style.overflow = prev.htmlOverflow;
      document.body.style.overflow = prev.bodyOverflow;
      document.body.style.paddingRight = prev.paddingRight;
    };
  }, [open]);

  // Escape closes it, like every other dialog on the web.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  /**
   * Attach the stream once the <video> actually exists.
   *
   * This used to run inside a requestAnimationFrame straight after setStage, on
   * the assumption that React had committed by then. When it had not, video.current
   * was still null, the guard swallowed it, and nothing ever retried: permission
   * granted, camera light on, and a permanently grey rectangle with a "Take the
   * photo" button under it. An effect keyed on the stage cannot lose that race —
   * it only runs after the element is in the DOM.
   *
   * muted is set on the NODE, not left to the JSX. React does not reflect the
   * muted prop to the attribute, and an unmuted video is not allowed to autoplay:
   * play() rejects on iOS, which is the other way this ended up blank.
   */
  useEffect(() => {
    if (stage !== 'camera') return;
    const el = video.current;
    const media = stream.current;
    if (!el || !media) return;
    let live = true;
    el.muted = true;
    el.playsInline = true;
    el.srcObject = media;
    el.play().catch(() => {
      if (!live) return;
      // A camera we hold but cannot show is worse than one we never opened: the
      // light is on and the button lies. Release it and say so.
      stopCamera();
      setStage('error');
      setMessage('The camera opened but could not be shown. Choose a photo instead.');
    });
    return () => { live = false; };
  }, [stage, stopCamera]);

  async function run(source: Blob | HTMLVideoElement) {
    setStage('working');
    setMessage(null);
    try {
      await loadModels(setPhase);
      const { vec, faceCount } = await embedLargestFace(source);
      const r = await api.searchFace(slug, vec);
      stopCamera();
      onResults(r.matches, faceCount);
      onClose();
    } catch (e) {
      // Releasing here as well. A failed read is the most likely outcome of all —
      // "no face found" on a bad frame — and it left the dialog sitting open on an
      // error message with the camera still running behind it.
      stopCamera();
      setStage('error');
      setMessage(
        e instanceof NoFaceError
          ? 'No face found in that picture. Try a closer, front-facing shot in good light.'
          : e instanceof ApiError
            ? e.message
            : 'The search could not run on this device. Try your bib number instead.',
      );
    }
  }

  async function startCamera() {
    // Anything already running is released first. Two presses of "Use the camera"
    // otherwise overwrite the ref and orphan the first stream, which then has
    // nothing holding it and never stops — a camera light with no way back.
    stopCamera();
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      // The dialog can close while the permission prompt is up. Whoever closed it
      // has already run the teardown, so this stream would leak past it.
      if (!openRef.current) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = media;
      // Attaching is the stage effect's job, not this function's — see above.
      setStage('camera');
    } catch {
      setStage('error');
      setMessage('Could not open the camera. Check the permission in your browser, or upload a photo instead.');
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Find me by face"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold tracking-tight">Find me by face</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Matching happens on this device. Your picture is never uploaded.
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>

        {stage === 'camera' ? (
          <div className="space-y-4">
            {/* Mirrored, because a selfie preview that moves the wrong way is
                disorienting to aim. */}
            <video
              ref={video}
              autoPlay
              playsInline
              muted
              className="aspect-[4/3] w-full -scale-x-100 rounded-lg bg-muted object-cover"
            />
            <Button size="lg" className="w-full" onClick={() => video.current && run(video.current)}>
              Take the photo
            </Button>
          </div>
        ) : stage === 'working' ? (
          <div className="py-10 text-center">
            <div className="mx-auto mb-4 size-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
            <p className="text-sm text-muted-foreground">
              {phase ? PHASE_COPY[phase] : 'Starting…'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {message && (
              <p className="rounded-md border border-destructive/45 px-3 py-2 text-sm text-destructive">
                {message}
              </p>
            )}
            <Button size="lg" className="w-full" onClick={startCamera}>
              <Camera /> Use the camera
            </Button>
            <Button size="lg" variant="outline" className="w-full" onClick={() => fileInput.current?.click()}>
              <Upload /> Choose a photo
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) run(f); }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
