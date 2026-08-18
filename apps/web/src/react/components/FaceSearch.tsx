/**
 * Find me by face.
 *
 * The differentiator, and the answer when a bib cannot be read — folded, covered
 * by a hand, turned away, which is roughly four photos in ten. The embedding runs
 * here, in the browser: the selfie never leaves the device and only a 512-float
 * vector is sent. That is a real privacy property, so it is stated plainly in the
 * dialog rather than buried in a policy.
 *
 * ~16 MB of ONNX loads on first use, never on page load — most visitors search by
 * number and should not pay for a model they will not run.
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

  const stopCamera = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  // The camera must stop when the dialog closes, whichever way it closed —
  // button, Escape, or the page navigating away. A live camera light left on
  // after a dialog closes is the kind of thing people notice and do not forgive.
  useEffect(() => {
    if (!open) { stopCamera(); setStage('idle'); setMessage(null); }
    return stopCamera;
  }, [open, stopCamera]);

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
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      setStage('camera');
      // The <video> only exists once the camera stage renders.
      requestAnimationFrame(async () => {
        if (video.current && stream.current) {
          video.current.srcObject = stream.current;
          await video.current.play().catch(() => {});
        }
      });
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
            <p className="mt-1 text-xs text-muted-foreground">
              The matcher is about 16 MB and loads once.
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
