"""Produce the reference embedding the browser must reproduce.

    python tools/golden/make_golden.py path/to/face.jpg

Writes into apps/web/public/golden/:
    test.jpg      the source image, copied verbatim
    golden.json   landmarks, bbox, and the 512-d embedding from insightface
    aligned.png   the 112x112 aligned crop

Dumping the aligned crop as well as the embedding is the point. If the browser's
cosine comes out low, the crop tells you immediately whether the problem is in
alignment or in the recognizer's input normalization — otherwise you are staring
at two 512-d vectors with no idea which stage diverged.
"""
from __future__ import annotations

import json
import os
import shutil
import sys

import numpy as np

OUT_DIR = os.path.join("apps", "web", "public", "golden")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    src = sys.argv[1]

    import cv2
    from insightface.app import FaceAnalysis
    from insightface.utils.face_align import norm_crop

    os.makedirs(OUT_DIR, exist_ok=True)

    app = FaceAnalysis(
        name="buffalo_s",
        allowed_modules=["detection", "recognition"],
        providers=["CPUExecutionProvider"],
    )
    app.prepare(ctx_id=-1, det_size=(640, 640))

    bgr = cv2.imread(src)
    if bgr is None:
        print(f"Could not read {src}")
        return 1

    faces = app.get(bgr)
    if not faces:
        print("No face detected in the reference image")
        return 1

    # Largest face — the same rule the browser applies.
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    aligned = norm_crop(bgr, landmark=face.kps, image_size=112)

    shutil.copyfile(src, os.path.join(OUT_DIR, "test.jpg"))
    cv2.imwrite(os.path.join(OUT_DIR, "aligned.png"), aligned)

    emb = face.normed_embedding.astype(np.float32)
    payload = {
        "source": os.path.basename(src),
        "image_size": [int(bgr.shape[1]), int(bgr.shape[0])],
        "bbox": [float(v) for v in face.bbox],
        "det_score": float(face.det_score),
        "landmarks": [[float(x), float(y)] for x, y in face.kps],
        "embedding": [float(v) for v in emb],
        "norm": float(np.linalg.norm(emb)),
    }
    with open(os.path.join(OUT_DIR, "golden.json"), "w") as fh:
        json.dump(payload, fh, indent=2)

    print(f"Wrote {OUT_DIR}/golden.json  (det_score={face.det_score:.3f}, norm={payload['norm']:.4f})")
    print("Now run `npm run dev:web` and open /golden")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
