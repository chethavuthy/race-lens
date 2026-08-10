/**
 * Browser-side face embedding — must produce vectors that match the Python
 * indexer's to cosine >= 0.99, or every search silently returns nothing.
 *
 * Parity contract (mirrors insightface's SCRFD + ArcFaceONNX exactly):
 *   detect:    letterbox to 640x640, RGB, (px - 127.5) / 128.0, NCHW
 *   align:     Umeyama similarity transform from 5 landmarks onto ARCFACE_TEMPLATE,
 *              bilinear warp to 112x112
 *   recognize: RGB, (px - 127.5) / 127.5, NCHW, then L2-normalize the 512-d output
 *
 * Verified by tools/golden. Change nothing here without re-running that.
 */
// Import the WASM-only build, not the default barrel. The default pulls in the
// JSEP/WebGPU binary (25.6 MB) which exceeds Cloudflare Pages' 25 MB per-file
// limit — and we pin executionProviders to 'wasm' anyway, so none of it is
// reachable. This build is 12.9 MB.
import * as ort from 'onnxruntime-web/wasm';

export const DET_MODEL = '/models/det_500m.onnx';
export const REC_MODEL = '/models/w600k_mbf.onnx';

/** ArcFace 5-point template for a 112x112 output. */
export const ARCFACE_TEMPLATE: [number, number][] = [
  [38.2946, 51.6963], // left eye
  [73.5318, 51.5014], // right eye
  [56.0252, 71.7366], // nose tip
  [41.5493, 92.3655], // left mouth corner
  [70.7299, 92.2041], // right mouth corner
];

const DET_SIZE = 640;
const REC_SIZE = 112;
const FEAT_STRIDES = [8, 16, 32];
const NUM_ANCHORS = 2;
const FMC = 3; // feature map count: scores, bboxes, kps

export interface DetectedFace {
  bbox: [number, number, number, number]; // x1, y1, x2, y2 in source pixels
  score: number;
  landmarks: [number, number][];          // 5 points in source pixels
}

let detSession: ort.InferenceSession | null = null;
let recSession: ort.InferenceSession | null = null;
let loading: Promise<void> | null = null;

export type LoadPhase = 'detector' | 'recognizer' | 'ready';

/**
 * Loads ~16 MB of ONNX. Idempotent and safe to call concurrently — the second
 * caller awaits the first load rather than starting its own.
 */
export function loadModels(onPhase?: (p: LoadPhase) => void): Promise<void> {
  if (detSession && recSession) return Promise.resolve();
  if (loading) return loading;

  loading = (async () => {
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);
    // Cross-origin isolation is required for threaded wasm; without it ORT
    // silently falls back, so only ask for threads when it will actually work.
    if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;

    // ...and then pin to 1 regardless. This is measured, not cargo-culted.
    //
    // Threads genuinely were broken: Emscripten boots each pthread from
    // `ort-wasm-simd-threaded.mjs` at runtime, nothing imports that file, so
    // Vite never emitted it and `InferenceSession.create()` waited forever on
    // workers that could not start — no error, no rejection, models never even
    // fetched. Setting `ort.env.wasm.wasmPaths` to a directory containing that
    // script fixes it completely; threads then boot in ~65 ms.
    //
    // It is pinned anyway because fixing it bought nothing. Measured on a
    // 10-core machine against the Angkor album, warm (models already cached):
    //
    //     1 thread   992 / 993 ms      4 threads   989 / 994 ms
    //
    // of which ~280 ms is the API round-trip, so client inference is ~710 ms
    // either way. This workload is one detection and one embedding on a single
    // image; there is nothing for a thread pool to divide. Cold start was
    // materially WORSE with threads (11,990 ms vs 1,902 ms) from compiling and
    // spinning up the pool.
    //
    // So the site also does not send COOP/COEP (see public/_headers). Pinning
    // here rather than relying on that means enabling those headers later — for
    // any reason — cannot silently resurrect the hang.
    ort.env.wasm.numThreads = 1;

    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    };
    onPhase?.('detector');
    detSession = await ort.InferenceSession.create(DET_MODEL, opts);
    onPhase?.('recognizer');
    recSession = await ort.InferenceSession.create(REC_MODEL, opts);
    onPhase?.('ready');
  })().catch((e) => {
    loading = null; // allow a retry after a transient network failure
    throw e;
  });

  return loading;
}

/** Decode any user-supplied image, honouring EXIF rotation (matters on phones). */
export async function toBitmap(src: Blob | HTMLVideoElement | HTMLCanvasElement): Promise<ImageBitmap> {
  if (src instanceof Blob) return createImageBitmap(src, { imageOrientation: 'from-image' });
  return createImageBitmap(src);
}

function drawToRgba(bitmap: ImageBitmap): { data: Uint8ClampedArray; w: number; h: number } {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, w: canvas.width, h: canvas.height };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function distance2bbox(cx: number, cy: number, d: Float32Array, o: number): [number, number, number, number] {
  return [cx - d[o], cy - d[o + 1], cx + d[o + 2], cy + d[o + 3]];
}

function nms(faces: DetectedFace[], iouThresh = 0.4): DetectedFace[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const keep: DetectedFace[] = [];
  for (const f of sorted) {
    const [ax1, ay1, ax2, ay2] = f.bbox;
    const areaA = (ax2 - ax1) * (ay2 - ay1);
    let overlaps = false;
    for (const k of keep) {
      const [bx1, by1, bx2, by2] = k.bbox;
      const iw = Math.min(ax2, bx2) - Math.max(ax1, bx1);
      const ih = Math.min(ay2, by2) - Math.max(ay1, by1);
      if (iw <= 0 || ih <= 0) continue;
      const inter = iw * ih;
      const union = areaA + (bx2 - bx1) * (by2 - by1) - inter;
      if (inter / union > iouThresh) { overlaps = true; break; }
    }
    if (!overlaps) keep.push(f);
  }
  return keep;
}

export async function detect(bitmap: ImageBitmap, scoreThresh = 0.5): Promise<DetectedFace[]> {
  await loadModels();
  const { data, w, h } = drawToRgba(bitmap);

  // Letterbox into the top-left of a 640x640 canvas, exactly as insightface does.
  const imRatio = h / w;
  const modelRatio = 1; // DET_SIZE / DET_SIZE
  let newW: number, newH: number;
  if (imRatio > modelRatio) {
    newH = DET_SIZE;
    newW = Math.floor(newH / imRatio);
  } else {
    newW = DET_SIZE;
    newH = Math.floor(newW * imRatio);
  }
  const detScale = newH / h;

  const scratch = document.createElement('canvas');
  scratch.width = DET_SIZE;
  scratch.height = DET_SIZE;
  const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, DET_SIZE, DET_SIZE);
  sctx.drawImage(bitmap, 0, 0, w, h, 0, 0, newW, newH);
  const padded = sctx.getImageData(0, 0, DET_SIZE, DET_SIZE).data;

  const plane = DET_SIZE * DET_SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    input[i] = (padded[p] - 127.5) / 128.0;             // R
    input[plane + i] = (padded[p + 1] - 127.5) / 128.0; // G
    input[2 * plane + i] = (padded[p + 2] - 127.5) / 128.0; // B
  }

  const feeds: Record<string, ort.Tensor> = {
    [detSession!.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, DET_SIZE, DET_SIZE]),
  };
  const out = await detSession!.run(feeds);
  const names = detSession!.outputNames;

  const found: DetectedFace[] = [];
  for (let idx = 0; idx < FEAT_STRIDES.length; idx++) {
    const stride = FEAT_STRIDES[idx];
    const scores = out[names[idx]].data as Float32Array;
    const bboxes = out[names[idx + FMC]].data as Float32Array;
    const kpss = out[names[idx + FMC * 2]].data as Float32Array;

    const gw = Math.floor(DET_SIZE / stride);
    const gh = Math.floor(DET_SIZE / stride);

    for (let row = 0; row < gh; row++) {
      for (let col = 0; col < gw; col++) {
        for (let a = 0; a < NUM_ANCHORS; a++) {
          const i = (row * gw + col) * NUM_ANCHORS + a;
          if (scores[i] < scoreThresh) continue;

          const cx = col * stride;
          const cy = row * stride;

          // Regression targets are in stride units.
          const d = new Float32Array(4);
          for (let k = 0; k < 4; k++) d[k] = bboxes[i * 4 + k] * stride;
          const box = distance2bbox(cx, cy, d, 0);

          const lms: [number, number][] = [];
          for (let k = 0; k < 5; k++) {
            lms.push([
              (cx + kpss[i * 10 + k * 2] * stride) / detScale,
              (cy + kpss[i * 10 + k * 2 + 1] * stride) / detScale,
            ]);
          }

          found.push({
            bbox: [box[0] / detScale, box[1] / detScale, box[2] / detScale, box[3] / detScale],
            score: scores[i],
            landmarks: lms,
          });
        }
      }
    }
  }

  return nms(found);
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

/**
 * Least-squares 2D similarity transform (Umeyama, no-reflection case).
 *
 * Deliberately closed-form rather than via a 2x2 SVD: for a similarity fit the
 * two are algebraically identical, and this avoids the sign/branch traps of a
 * hand-rolled SVD — which is exactly the class of bug that would silently
 * de-align every embedding by a few degrees and tank recall.
 *
 * Returns [a, -b, tx, b, a, ty] — the 2x3 matrix mapping src -> dst.
 */
export function similarityTransform(
  src: [number, number][],
  dst: [number, number][],
): [number, number, number, number, number, number] {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
  sx /= n; sy /= n; dx /= n; dy /= n;

  let num = 0, den = 0, cross = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - sx, py = src[i][1] - sy;
    const qx = dst[i][0] - dx, qy = dst[i][1] - dy;
    num += px * qx + py * qy;
    cross += px * qy - py * qx;
    den += px * px + py * py;
  }
  if (den === 0) return [1, 0, 0, 0, 1, 0];

  const a = num / den;   // s * cos(theta)
  const b = cross / den; // s * sin(theta)
  return [a, -b, dx - (a * sx - b * sy), b, a, dy - (b * sx + a * sy)];
}

function invertAffine(m: number[]): number[] {
  const det = m[0] * m[4] - m[1] * m[3];
  const id = 1 / det;
  const a = m[4] * id, b = -m[1] * id, d = -m[3] * id, e = m[0] * id;
  return [a, b, -(a * m[2] + b * m[5]), d, e, -(d * m[2] + e * m[5])];
}

/** insightface `norm_crop`: warp the face onto the 112x112 ArcFace template. */
export function normCrop(
  rgba: Uint8ClampedArray, w: number, h: number, landmarks: [number, number][],
): Uint8ClampedArray {
  const m = similarityTransform(landmarks, ARCFACE_TEMPLATE);
  const inv = invertAffine(m);
  const out = new Uint8ClampedArray(REC_SIZE * REC_SIZE * 4);

  for (let y = 0; y < REC_SIZE; y++) {
    for (let x = 0; x < REC_SIZE; x++) {
      // Integer destination coordinates, no half-pixel offset — cv2.warpAffine
      // maps dst (x, y) directly through the inverse matrix.
      const srcX = inv[0] * x + inv[1] * y + inv[2];
      const srcY = inv[3] * x + inv[4] * y + inv[5];
      const o = (y * REC_SIZE + x) * 4;

      const x0 = Math.floor(srcX), y0 = Math.floor(srcY);
      const fx = srcX - x0, fy = srcY - y0;

      for (let ch = 0; ch < 3; ch++) {
        let v = 0;
        for (let dyi = 0; dyi < 2; dyi++) {
          for (let dxi = 0; dxi < 2; dxi++) {
            const xx = x0 + dxi, yy = y0 + dyi;
            // Outside the source reads as 0, matching warpAffine's default border.
            const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : rgba[(yy * w + xx) * 4 + ch];
            v += s * (dxi ? fx : 1 - fx) * (dyi ? fy : 1 - fy);
          }
        }
        out[o + ch] = v;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

export async function embedAligned(aligned: Uint8ClampedArray): Promise<Float32Array> {
  await loadModels();
  const plane = REC_SIZE * REC_SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    input[i] = (aligned[p] - 127.5) / 127.5;
    input[plane + i] = (aligned[p + 1] - 127.5) / 127.5;
    input[2 * plane + i] = (aligned[p + 2] - 127.5) / 127.5;
  }

  const feeds: Record<string, ort.Tensor> = {
    [recSession!.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, REC_SIZE, REC_SIZE]),
  };
  const out = await recSession!.run(feeds);
  const raw = out[recSession!.outputNames[0]].data as Float32Array;

  let norm = 0;
  for (let i = 0; i < raw.length; i++) norm += raw[i] * raw[i];
  norm = Math.sqrt(norm) || 1;
  const vec = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) vec[i] = raw[i] / norm;
  return vec;
}

export class NoFaceError extends Error {
  constructor() { super('No face found in that photo'); }
}

/** Full pipeline: detect, pick the largest face, align, embed. */
export async function embedLargestFace(
  source: Blob | HTMLVideoElement | HTMLCanvasElement,
): Promise<{ vec: number[]; bbox: [number, number, number, number]; faceCount: number }> {
  const bitmap = await toBitmap(source);
  const faces = await detect(bitmap);
  if (!faces.length) throw new NoFaceError();

  // Largest, not highest-scoring: in a selfie the subject is the big face, and
  // a sharp bystander in the background can easily out-score them.
  const face = faces.reduce((best, f) => {
    const area = (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]);
    const bestArea = (best.bbox[2] - best.bbox[0]) * (best.bbox[3] - best.bbox[1]);
    return area > bestArea ? f : best;
  });

  const { data, w, h } = drawToRgba(bitmap);
  const aligned = normCrop(data, w, h, face.landmarks);
  const vec = await embedAligned(aligned);
  bitmap.close();

  return { vec: Array.from(vec), bbox: face.bbox, faceCount: faces.length };
}
