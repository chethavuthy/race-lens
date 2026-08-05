<script setup lang="ts">
/**
 * Phase 5 acceptance gate. Dev-only route.
 *
 * Loads the same image the Python indexer embedded and compares stage by stage:
 * landmarks -> aligned crop -> embedding. Gate is cosine >= 0.99.
 */
import { onMounted, ref } from 'vue';
import { detect, embedAligned, loadModels, normCrop, toBitmap } from '../lib/face';

interface Golden {
  source: string;
  bbox: number[];
  det_score: number;
  landmarks: [number, number][];
  embedding: number[];
}

const status = ref('Loading models…');
const error = ref<string | null>(null);
const cosine = ref<number | null>(null);
const landmarkErr = ref<number | null>(null);
const cropMae = ref<number | null>(null);
const cropDiagFailed = ref(false);
const detScore = ref<number | null>(null);
const ourCanvas = ref<HTMLCanvasElement | null>(null);
const refCanvas = ref<HTMLCanvasElement | null>(null);

function drawRgba(canvas: HTMLCanvasElement, rgba: Uint8ClampedArray, size = 112) {
  canvas.width = size;
  canvas.height = size;
  // ImageData's constructor is typed against a plain ArrayBuffer backing store.
  const copy = new Uint8ClampedArray(rgba);
  canvas.getContext('2d')!.putImageData(new ImageData(copy, size, size), 0, 0);
}

onMounted(async () => {
  try {
    await loadModels((p) => (status.value = `Loading ${p}…`));

    status.value = 'Fetching golden.json…';
    const golden: Golden = await (await fetch('/golden/golden.json')).json();
    const blob = await (await fetch('/golden/test.jpg')).blob();
    const bitmap = await toBitmap(blob);

    status.value = 'Detecting…';
    const faces = await detect(bitmap);
    if (!faces.length) throw new Error('Browser detector found no face — detection stage diverged');
    const face = faces.reduce((best, f) => {
      const a = (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]);
      const b = (best.bbox[2] - best.bbox[0]) * (best.bbox[3] - best.bbox[1]);
      return a > b ? f : best;
    });
    detScore.value = face.score;

    // Stage 1 — landmarks. Anything above ~2 px means the detector decode
    // (anchor centres, stride scaling) is off, and alignment cannot recover.
    landmarkErr.value = Math.max(
      ...face.landmarks.map((p, i) =>
        Math.hypot(p[0] - golden.landmarks[i][0], p[1] - golden.landmarks[i][1]),
      ),
    );

    // Stage 2 — aligned crop, warped from the GOLDEN landmarks so this
    // isolates the transform from any detector drift.
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const aligned = normCrop(rgba, canvas.width, canvas.height, golden.landmarks);
    if (ourCanvas.value) drawRgba(ourCanvas.value, aligned);

    // Stage 3 — the embedding. This is the gate, so it runs BEFORE the crop
    // diagnostic: a diagnostic that cannot load must never stop the gate from
    // reporting a verdict.
    status.value = 'Embedding…';
    const vec = await embedAligned(aligned);
    let dot = 0;
    for (let i = 0; i < 512; i++) dot += vec[i] * golden.embedding[i];
    cosine.value = dot;
    status.value = 'Done';

    // Expose for automated capture (CI, preflight).
    (window as any).__GOLDEN__ = {
      cosine: dot,
      landmarkErrPx: landmarkErr.value,
      detScore: detScore.value,
      source: golden.source,
    };

    // Best-effort crop diff. decode() can hang in some headless/offscreen
    // renderers, so race it rather than awaiting it forever.
    try {
      const refImg = new Image();
      const ready = new Promise<void>((resolve, reject) => {
        refImg.onload = () => resolve();
        refImg.onerror = () => reject(new Error('load failed'));
      });
      refImg.src = '/golden/aligned.png';
      await Promise.race([
        ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]);
      if (refCanvas.value) {
        refCanvas.value.width = 112;
        refCanvas.value.height = 112;
        const rctx = refCanvas.value.getContext('2d', { willReadFrequently: true })!;
        rctx.drawImage(refImg, 0, 0);
        const ref = rctx.getImageData(0, 0, 112, 112).data;
        let sum = 0;
        for (let i = 0; i < 112 * 112; i++) {
          for (let ch = 0; ch < 3; ch++) {
            // No channel swap: cv2.imwrite takes a BGR array and writes a
            // correctly-coloured PNG, so the canvas reads it back as plain RGB —
            // the same order normCrop produces.
            sum += Math.abs(aligned[i * 4 + ch] - ref[i * 4 + ch]);
          }
        }
        cropMae.value = sum / (112 * 112 * 3);
        (window as any).__GOLDEN__.cropMae = cropMae.value;
      }
    } catch {
      cropDiagFailed.value = true;
    }
  } catch (e: any) {
    error.value = e.message ?? String(e);
    status.value = 'Failed';
  }
});
</script>

<template>
  <h1>Golden parity test</h1>
  <p class="muted" style="margin-top: 0">
    Python indexer vs. browser embedding. The gate is cosine ≥ 0.99.
  </p>

  <p v-if="error" class="notice err">{{ error }}</p>
  <p v-else-if="status !== 'Done'" class="muted"><span class="spinner" /> {{ status }}</p>

  <div class="card" style="margin-top: 18px">
    <p v-if="cosine != null" :class="['notice', cosine >= 0.99 ? 'ok' : 'err']">
      {{ cosine >= 0.99 ? 'PASS' : 'FAIL' }} — cosine {{ cosine.toFixed(5) }}
    </p>

    <table style="width: 100%; margin-top: 14px; border-collapse: collapse">
      <tbody>
        <tr><td class="muted">Detector score</td><td>{{ detScore?.toFixed(4) ?? '—' }}</td></tr>
        <tr>
          <td class="muted">Max landmark error (px)</td>
          <td>{{ landmarkErr?.toFixed(2) ?? '—' }} <span class="muted small">(want &lt; 2)</span></td>
        </tr>
        <tr>
          <td class="muted">Aligned crop mean abs diff</td>
          <td>
            <template v-if="cropMae != null">{{ cropMae.toFixed(2) }} <span class="muted small">(want &lt; 3 of 255)</span></template>
            <span v-else-if="cropDiagFailed" class="muted small">unavailable in this browser — diagnostic only, the cosine above is the gate</span>
            <span v-else>—</span>
          </td>
        </tr>
      </tbody>
    </table>

    <div style="display: flex; gap: 16px; margin-top: 18px; align-items: flex-start">
      <div>
        <div class="muted small">Browser crop</div>
        <canvas ref="ourCanvas" style="width: 168px; image-rendering: pixelated; border-radius: 8px" />
      </div>
      <div>
        <div class="muted small">Python crop</div>
        <canvas ref="refCanvas" style="width: 168px; image-rendering: pixelated; border-radius: 8px" />
      </div>
    </div>

    <p class="muted small" style="margin-bottom: 0">
      Landmark error high → detector decode is wrong.
      Landmarks fine but crop diff high → the similarity transform or warp is wrong.
      Both fine but cosine low → recognizer input normalization is wrong.
    </p>
  </div>
</template>
