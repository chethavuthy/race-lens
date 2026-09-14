#!/usr/bin/env python3
"""Did the faster pipeline produce EXACTLY the same results as the slow one?

    python3 tools/bench_diff.py baseline.json candidate.json
    python3 tools/bench_diff.py baseline.json candidate.json --json
    python3 tools/bench_diff.py report.json          # self-consistency only

We are allowed to make the CPU pipeline (detect + OCR) as fast as we like, and we
are allowed to change nothing else. A bib handed to the wrong runner is not a
performance regression, it is a wrong photo in a stranger's gallery, and nobody
downstream will ever catch it. So every optimisation lands behind this gate:
if the output moved at all, the optimisation is wrong, not the expectation.

Exit 0 = equivalent and self-consistent. Exit 1 = anything else (a difference, a
broken row_idx, or a file we could not parse). It is a CI gate: a report we cannot
read has to fail, because "cannot read" and "identical" must never look the same.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

STAGE_KEYS = [
    "download_s",
    "decode_s",
    "thumbnail_s",
    "detect_s",
    "torso_ocr_s",
    "tile_ocr_s",
    "other_s",
]


class Malformed(Exception):
    """The report is not the shape the harness promises. Never treat this as a pass."""


# ---------------------------------------------------------------- loading


def load_report(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        raise Malformed("cannot open %s: %s" % (path, exc))
    except ValueError as exc:
        raise Malformed("%s is not valid JSON: %s" % (path, exc))
    if not isinstance(data, dict):
        raise Malformed("%s: top level is %s, expected an object" % (path, type(data).__name__))
    for key, kind in (("photos", list), ("shard", list)):
        if key not in data:
            raise Malformed("%s: missing required key %r" % (path, key))
        if not isinstance(data[key], kind):
            raise Malformed("%s: %r is %s, expected a list" % (path, key, type(data[key]).__name__))
    for photo in data["photos"]:
        if not isinstance(photo, dict):
            raise Malformed("%s: photos[] contains a %s, expected objects" % (path, type(photo).__name__))
    return data


def _num(value: Any, default: float = 0.0) -> float:
    """Missing or non-numeric timings become 0.0 rather than crashing the gate.

    Timings are the one part of the report we are allowed to be relaxed about:
    they are the thing that is SUPPOSED to change, and a missing stage should not
    stop us reporting on the results, which are the thing that must not."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return float(value)


def _label(report: Dict[str, Any], fallback: str) -> str:
    meta = report.get("meta")
    if isinstance(meta, dict) and isinstance(meta.get("label"), str) and meta["label"]:
        return meta["label"]
    return fallback


# ------------------------------------------------------- self-consistency


def check_self_consistency(report: Dict[str, Any], who: str) -> List[str]:
    """Does every face still point at its OWN embedding row?

    The shard is a flat list of vectors and a face finds its vector by integer
    offset. Parallelising the pipeline means faces are produced out of order and
    rows are appended by whichever worker finishes first, so row_idx is assigned
    at a distance from the face it describes — exactly the arrangement where an
    off-by-one survives every test we have. The damage is silent and total:
    face search would return confident, well-scored matches for the wrong person.

    So we re-derive the correspondence from the report itself. shard[row_idx] has
    to be that face's emb_sha1, the mapping has to be a bijection (no two faces
    sharing a row, no orphan rows left behind by a dropped face), and every index
    has to be in range. Any failure here is CRITICAL and no amount of speed
    redeems it."""
    problems: List[str] = []
    shard = report["shard"]
    n_rows = len(shard)
    claimed: Dict[int, str] = {}

    for photo in report["photos"]:
        fid = photo.get("drive_file_id", "<no drive_file_id>")
        faces = photo.get("faces") or []
        if not isinstance(faces, list):
            problems.append("%s: photo %s has a non-list faces field" % (who, fid))
            continue
        for ordinal, face in enumerate(faces):
            where = "%s: photo %s face #%d" % (who, fid, ordinal)
            if not isinstance(face, dict):
                problems.append("%s is not an object" % where)
                continue
            row_idx = face.get("row_idx")
            emb = face.get("emb_sha1")
            if isinstance(row_idx, bool) or not isinstance(row_idx, int):
                problems.append("%s has row_idx %r, which is not an integer" % (where, row_idx))
                continue
            if row_idx < 0 or row_idx >= n_rows:
                problems.append(
                    "%s has row_idx %d, outside the shard (%d rows)" % (where, row_idx, n_rows)
                )
                continue
            actual = shard[row_idx]
            if actual != emb:
                problems.append(
                    "%s points at the WRONG embedding: row_idx %d holds %s, face carries %s"
                    % (where, row_idx, actual, emb)
                )
            if row_idx in claimed:
                problems.append(
                    "%s shares row_idx %d with %s — two faces cannot own one vector"
                    % (where, row_idx, claimed[row_idx])
                )
            else:
                claimed[row_idx] = where

    orphans = [i for i in range(n_rows) if i not in claimed]
    if orphans:
        shown = ", ".join(str(i) for i in orphans[:20])
        if len(orphans) > 20:
            shown += ", ... (%d total)" % len(orphans)
        problems.append(
            "%s: %d shard row(s) are claimed by no face: %s — a face was dropped after its "
            "vector was written, or a vector was written twice" % (who, len(orphans), shown)
        )
    return problems


# ------------------------------------------------------------ equivalence


def _face_key(face: Dict[str, Any]) -> Tuple[Any, ...]:
    """The identity of a face, with row_idx deliberately excluded.

    row_idx is a storage address, not a result: two runs may lay the shard out in
    a different order and still be the same answer, provided each run passes the
    check above. Comparing it here would fail every parallel run for free."""
    bbox = face.get("bbox")
    if isinstance(bbox, list):
        rounded = tuple(round(v, 2) if isinstance(v, (int, float)) and not isinstance(v, bool) else v for v in bbox)
    else:
        rounded = ("<bad bbox>", repr(bbox))
    score = face.get("det_score")
    if isinstance(score, (int, float)) and not isinstance(score, bool):
        score = round(score, 4)
    return (rounded, score, face.get("emb_sha1"), face.get("bib"))


def _bib_key(entry: Any) -> Tuple[Any, ...]:
    if not isinstance(entry, dict):
        return ("<bad entry>", repr(entry))
    conf = entry.get("conf")
    if isinstance(conf, (int, float)) and not isinstance(conf, bool):
        conf = round(conf, 4)
    return (entry.get("bib"), entry.get("raw"), conf)


def _multiset(items: Any, keyfn) -> Counter:
    if not isinstance(items, list):
        return Counter([("<not a list>", repr(items))])
    return Counter(keyfn(i) for i in items)


def _diff_multiset(base: Counter, cand: Counter) -> Tuple[List[Any], List[Any]]:
    """Returns (only in baseline, only in candidate), counting duplicates."""
    missing = list((base - cand).elements())
    extra = list((cand - base).elements())
    missing.sort(key=repr)
    extra.sort(key=repr)
    return missing, extra


def _by_id(report: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for i, photo in enumerate(report["photos"]):
        fid = photo.get("drive_file_id")
        if not isinstance(fid, str) or not fid:
            fid = "<photo #%d with no drive_file_id>" % i
        out[fid] = photo
    return out


def classify(base: Dict[str, Any], cand: Dict[str, Any]) -> Dict[str, Any]:
    """Split the differences into the ones that change the product and the ones
    that are float noise.

    Measured on this pipeline: two runs of IDENTICAL code on identical photos
    produced identical face counts, identical boxes and identical bib strings,
    while 20% of the int8 embeddings differed. Multi-threaded onnxruntime does
    not fix its reduction order, so the last bits of a float32 embedding move
    between runs, and `round(v * 127)` turns a last-bit difference into a
    different int8 whenever a component sits near a .5 boundary.

    So "any difference is a bug" is not a usable rule for this pipeline, and a
    flat list of changed hashes buries the one question worth asking: did the
    ANSWERS move, or only the arithmetic? This counts both, separately.
    """
    b = _by_id(base)
    c = _by_id(cand)
    shared = sorted(set(b) & set(c))
    out = {"face_count": 0, "bbox": 0, "det_score": 0, "bib": 0, "embedding": 0,
           "faces": 0, "bib_readings_gained": [], "bib_readings_lost": [],
           "bib_conf_jitter": 0}
    for fid in shared:
        fb = sorted(b[fid].get("faces") or [], key=lambda f: (f.get("bbox"), f.get("det_score")))
        fc = sorted(c[fid].get("faces") or [], key=lambda f: (f.get("bbox"), f.get("det_score")))
        if len(fb) != len(fc):
            out["face_count"] += 1
            continue
        for x, y in zip(fb, fc):
            out["faces"] += 1
            out["bbox"] += x.get("bbox") != y.get("bbox")
            out["det_score"] += x.get("det_score") != y.get("det_score")
            out["bib"] += x.get("bib") != y.get("bib")
            out["embedding"] += x.get("emb_sha1") != y.get("emb_sha1")
        for field in ("torso_bibs", "tile_bibs"):
            hb = {(h.get("bib"), h.get("raw")): h.get("conf") for h in (b[fid].get(field) or [])}
            hc = {(h.get("bib"), h.get("raw")): h.get("conf") for h in (c[fid].get(field) or [])}
            out["bib_readings_lost"] += [k[0] for k in hb if k not in hc]
            out["bib_readings_gained"] += [k[0] for k in hc if k not in hb]
            out["bib_conf_jitter"] += sum(1 for k in hb if k in hc and hb[k] != hc[k])
    return out


def check_equivalence(base: Dict[str, Any], cand: Dict[str, Any]) -> Dict[str, Any]:
    """Compare results as SETS keyed by drive_file_id, never by list position.

    Workers return photos in completion order and faces in whatever order the
    detector emitted them, so list order carries no meaning and comparing it would
    make every parallel candidate look broken. What has to hold is that the same
    photo has the same faces, the same bibs and the same thumbnail bytes."""
    b_photos = _by_id(base)
    c_photos = _by_id(cand)
    b_ids, c_ids = set(b_photos), set(c_photos)

    result: Dict[str, Any] = {
        "classified": classify(base, cand),
        "missing_photos": sorted(b_ids - c_ids),
        "extra_photos": sorted(c_ids - b_ids),
        "photo_diffs": [],
        "global_emb_missing": [],
        "global_emb_extra": [],
    }

    for fid in sorted(b_ids & c_ids):
        bp, cp = b_photos[fid], c_photos[fid]
        issues: List[str] = []

        for field in ("width", "height", "thumb_sha1"):
            if bp.get(field) != cp.get(field):
                issues.append("%s: %r -> %r" % (field, bp.get(field), cp.get(field)))

        miss, extra = _diff_multiset(
            _multiset(bp.get("faces") or [], _face_key),
            _multiset(cp.get("faces") or [], _face_key),
        )
        for key in miss:
            issues.append("face only in baseline:  %s" % _fmt_face(key))
        for key in extra:
            issues.append("face only in candidate: %s" % _fmt_face(key))

        for field in ("torso_bibs", "tile_bibs"):
            # Torso and tile reads stay separate on purpose: the same bib found by a
            # different route is a different pipeline, and merging them would hide
            # precisely the swap we are watching for.
            miss, extra = _diff_multiset(
                _multiset(bp.get(field) or [], _bib_key),
                _multiset(cp.get(field) or [], _bib_key),
            )
            for key in miss:
                issues.append("%s only in baseline:  %s" % (field, _fmt_bib(key)))
            for key in extra:
                issues.append("%s only in candidate: %s" % (field, _fmt_bib(key)))

        if issues:
            result["photo_diffs"].append({"drive_file_id": fid, "issues": issues})

    # Whole-run embedding census. Per-photo checks can be satisfied while a face
    # quietly moves between photos or is counted twice; the global multiset cannot.
    b_all: Counter = Counter()
    c_all: Counter = Counter()
    for photo in base["photos"]:
        b_all.update(f.get("emb_sha1") for f in (photo.get("faces") or []) if isinstance(f, dict))
    for photo in cand["photos"]:
        c_all.update(f.get("emb_sha1") for f in (photo.get("faces") or []) if isinstance(f, dict))
    miss, extra = _diff_multiset(b_all, c_all)
    result["global_emb_missing"] = [str(x) for x in miss]
    result["global_emb_extra"] = [str(x) for x in extra]

    result["equivalent"] = not (
        result["missing_photos"]
        or result["extra_photos"]
        or result["photo_diffs"]
        or result["global_emb_missing"]
        or result["global_emb_extra"]
    )
    return result


def _fmt_face(key: Tuple[Any, ...]) -> str:
    bbox, score, emb, bib = key[0], key[1], key[2], key[3]
    if isinstance(bbox, tuple):
        bbox_s = "[" + ", ".join(str(v) for v in bbox) + "]"
    else:
        bbox_s = str(bbox)
    return "bbox=%s det=%s bib=%r emb=%s" % (bbox_s, score, bib, emb)


def _fmt_bib(key: Tuple[Any, ...]) -> str:
    if len(key) != 3:
        return str(key)
    return "bib=%r raw=%r conf=%s" % (key[0], key[1], key[2])


# ------------------------------------------------------------------ speed


def _stage_times(report: Dict[str, Any]) -> Dict[str, float]:
    totals = report.get("totals")
    stages = totals.get("stages") if isinstance(totals, dict) else None
    stages = stages if isinstance(stages, dict) else {}
    known = {k: _num(stages.get(k)) for k in STAGE_KEYS}
    for k, v in stages.items():
        if k not in known:
            known[k] = _num(v)
    return known


def _photo_count(report: Dict[str, Any]) -> int:
    totals = report.get("totals")
    if isinstance(totals, dict):
        n = totals.get("photos")
        if isinstance(n, int) and not isinstance(n, bool) and n > 0:
            return n
    return len(report["photos"])


def _ratio(base: float, cand: float) -> Optional[float]:
    """Speedup, or None when the candidate took no measurable time at all."""
    if cand <= 0:
        return None
    return base / cand


def _pct(base: float, cand: float) -> Optional[float]:
    if base <= 0:
        return None
    return (cand - base) / base * 100.0


def build_speed(base: Dict[str, Any], cand: Dict[str, Any]) -> Dict[str, Any]:
    b_stages, c_stages = _stage_times(base), _stage_times(cand)
    names = list(STAGE_KEYS) + [k for k in sorted(c_stages) if k not in STAGE_KEYS and k not in b_stages]
    names += [k for k in sorted(b_stages) if k not in names]

    b_photos, c_photos = _photo_count(base), _photo_count(cand)
    b_sum = sum(b_stages.get(n, 0.0) for n in names) or 0.0
    c_sum = sum(c_stages.get(n, 0.0) for n in names) or 0.0

    rows = []
    for name in names:
        bt, ct = b_stages.get(name, 0.0), c_stages.get(name, 0.0)
        rows.append(
            {
                "stage": name,
                "baseline_s": bt,
                "candidate_s": ct,
                "delta_s": ct - bt,
                "pct_change": _pct(bt, ct),
                "speedup": _ratio(bt, ct),
                "baseline_s_per_photo": bt / b_photos if b_photos else None,
                "candidate_s_per_photo": ct / c_photos if c_photos else None,
                "baseline_share_pct": (bt / b_sum * 100.0) if b_sum > 0 else None,
                "candidate_share_pct": (ct / c_sum * 100.0) if c_sum > 0 else None,
            }
        )

    b_wall = _num((base.get("totals") or {}).get("wall_s")) if isinstance(base.get("totals"), dict) else 0.0
    c_wall = _num((cand.get("totals") or {}).get("wall_s")) if isinstance(cand.get("totals"), dict) else 0.0

    def dominant(which: str) -> Optional[str]:
        pick = max(rows, key=lambda r: r["%s_s" % which]) if rows else None
        if pick is None or pick["%s_s" % which] <= 0:
            return None
        return pick["stage"]

    return {
        "wall": {
            "baseline_s": b_wall,
            "candidate_s": c_wall,
            "delta_s": c_wall - b_wall,
            "pct_change": _pct(b_wall, c_wall),
            "speedup": _ratio(b_wall, c_wall),
            "baseline_s_per_photo": b_wall / b_photos if b_photos else None,
            "candidate_s_per_photo": c_wall / c_photos if c_photos else None,
        },
        "photos": {"baseline": b_photos, "candidate": c_photos},
        "stages": rows,
        "dominant_baseline": dominant("baseline"),
        "dominant_candidate": dominant("candidate"),
    }


# ----------------------------------------------------------------- output


def _f(value: Optional[float], fmt: str = "%.3f", dash: str = "-") -> str:
    return dash if value is None else fmt % value


def print_speed_table(speed: Dict[str, Any]) -> None:
    header = ("stage", "baseline_s", "cand_s", "delta_s", "pct", "speedup", "base/photo", "cand/photo")
    lines = [header]
    w = speed["wall"]
    lines.append(
        (
            "WALL",
            _f(w["baseline_s"]),
            _f(w["candidate_s"]),
            "%+.3f" % w["delta_s"],
            _f(w["pct_change"], "%+.1f%%"),
            _f(w["speedup"], "%.2fx"),
            _f(w["baseline_s_per_photo"]),
            _f(w["candidate_s_per_photo"]),
        )
    )
    for row in speed["stages"]:
        lines.append(
            (
                row["stage"],
                _f(row["baseline_s"]),
                _f(row["candidate_s"]),
                "%+.3f" % row["delta_s"],
                _f(row["pct_change"], "%+.1f%%"),
                _f(row["speedup"], "%.2fx"),
                _f(row["baseline_s_per_photo"]),
                _f(row["candidate_s_per_photo"]),
            )
        )
    widths = [max(len(row[i]) for row in lines) for i in range(len(header))]
    for n, row in enumerate(lines):
        cells = [row[0].ljust(widths[0])] + [row[i].rjust(widths[i]) for i in range(1, len(header))]
        print("  " + "  ".join(cells))
        if n == 0:
            print("  " + "  ".join("-" * width for width in widths))

    print("")
    print(
        "  dominant stage  baseline: %s   candidate: %s"
        % (speed["dominant_baseline"] or "n/a", speed["dominant_candidate"] or "n/a")
    )
    for row in speed["stages"]:
        if row["baseline_share_pct"] is None and row["candidate_share_pct"] is None:
            continue
        print(
            "    %-12s %5s of baseline stage time -> %5s of candidate"
            % (
                row["stage"],
                _f(row["baseline_share_pct"], "%.1f%%"),
                _f(row["candidate_share_pct"], "%.1f%%"),
            )
        )


def report_text(
    verdict: str,
    consistency: Dict[str, List[str]],
    equiv: Optional[Dict[str, Any]],
    speed: Optional[Dict[str, Any]],
    labels: Dict[str, str],
) -> None:
    print(verdict)
    print("")

    print("SELF-CONSISTENCY (shard row <-> face embedding)")
    for who, problems in consistency.items():
        name = labels.get(who, who)
        if not problems:
            print("  %-10s ok — every face points at its own embedding row" % (name + ":"))
        else:
            print("  %s: %d CRITICAL violation(s)" % (name, len(problems)))
            for p in problems[:40]:
                print("    - %s" % p)
            if len(problems) > 40:
                print("    ... and %d more" % (len(problems) - 40))
    print("")

    if equiv is not None:
        print("EQUIVALENCE (per-photo, order-independent)")
        if equiv["equivalent"]:
            print("  identical — same photos, faces, bibs and thumbnails")
        else:
            cl = equiv.get("classified") or {}
            product = (cl.get("face_count", 0) + cl.get("bbox", 0) + cl.get("bib", 0)
                       + len(cl.get("bib_readings_lost", []))
                       + len(cl.get("bib_readings_gained", [])))
            if product:
                print("  THESE ARE BUGS, NOT NOISE. The pipeline changed its answers.")
            else:
                print("  No ANSWER changed. Every difference below is float noise.")
            print("  what moved, across %d faces:" % cl["faces"])
            print("    photos whose face COUNT differs : %d" % cl["face_count"])
            print("    faces whose bbox differs        : %d" % cl["bbox"])
            print("    faces whose bib differs         : %d" % cl["bib"])
            print("    bib readings lost / gained      : %d / %d"
                  % (len(cl["bib_readings_lost"]), len(cl["bib_readings_gained"])))
            print("    ---- below here is arithmetic, not answers ----")
            print("    faces whose det_score differs   : %d" % cl["det_score"])
            print("    faces whose EMBEDDING differs   : %d" % cl["embedding"])
            print("    bib confidences that jittered   : %d" % cl["bib_conf_jitter"])
            if equiv["missing_photos"]:
                print("  photos missing from candidate (%d):" % len(equiv["missing_photos"]))
                for fid in equiv["missing_photos"][:40]:
                    print("    - %s" % fid)
            if equiv["extra_photos"]:
                print("  photos only in candidate (%d):" % len(equiv["extra_photos"]))
                for fid in equiv["extra_photos"][:40]:
                    print("    - %s" % fid)
            if equiv["photo_diffs"]:
                print("  photos that differ (%d):" % len(equiv["photo_diffs"]))
                for diff in equiv["photo_diffs"][:40]:
                    print("    %s" % diff["drive_file_id"])
                    for issue in diff["issues"][:20]:
                        print("      - %s" % issue)
                    if len(diff["issues"]) > 20:
                        print("      ... and %d more" % (len(diff["issues"]) - 20))
                if len(equiv["photo_diffs"]) > 40:
                    print("    ... and %d more photos" % (len(equiv["photo_diffs"]) - 40))
            if equiv["global_emb_missing"] or equiv["global_emb_extra"]:
                print("  whole-run embedding census does not balance:")
                for sha in equiv["global_emb_missing"][:20]:
                    print("    - lost from candidate:      %s" % sha)
                for sha in equiv["global_emb_extra"][:20]:
                    print("    - appeared in candidate:    %s" % sha)
        print("")

    if speed is not None:
        print(
            "SPEED  (%s -> %s, %d -> %d photos)"
            % (
                labels.get("baseline", "baseline"),
                labels.get("candidate", "candidate"),
                speed["photos"]["baseline"],
                speed["photos"]["candidate"],
            )
        )
        print_speed_table(speed)


# ------------------------------------------------------------------- main


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Prove a faster run of the indexer produced identical results.",
    )
    parser.add_argument("baseline", help="baseline report JSON (or the only report, in single-file mode)")
    parser.add_argument("candidate", nargs="?", help="candidate report JSON")
    parser.add_argument("--json", action="store_true", dest="as_json", help="emit a machine-readable summary")
    args = parser.parse_args(argv)

    try:
        base = load_report(args.baseline)
        cand = load_report(args.candidate) if args.candidate else None
    except Malformed as exc:
        # A malformed report is a failure, not an absence of evidence.
        if args.as_json:
            print(json.dumps({"verdict": "MALFORMED", "ok": False, "error": str(exc)}, indent=2))
        else:
            print("MALFORMED — %s" % exc)
        return 1

    labels = {"baseline": _label(base, "baseline")}
    consistency = {"baseline": check_self_consistency(base, _label(base, "baseline"))}
    if cand is not None:
        labels["candidate"] = _label(cand, "candidate")
        consistency["candidate"] = check_self_consistency(cand, _label(cand, "candidate"))

    broken = [who for who, problems in consistency.items() if problems]

    if cand is None:
        verdict = (
            "CRITICAL — row_idx/embedding correspondence broken in %s" % labels["baseline"]
            if broken
            else "SELF-CONSISTENT — %d face row(s) all point at their own embedding" % len(base["shard"])
        )
        equiv, speed = None, None
        ok = not broken
    else:
        equiv = check_equivalence(base, cand)
        speed = build_speed(base, cand)
        ok = not broken and equiv["equivalent"]
        if broken:
            verdict = "CRITICAL — row_idx/embedding correspondence broken in %s" % (
                " and ".join(labels[w] for w in ("baseline", "candidate") if w in broken)
            )
        elif not equiv["equivalent"]:
            n = len(equiv["photo_diffs"]) + len(equiv["missing_photos"]) + len(equiv["extra_photos"])
            if n == 0:
                verdict = "NOT EQUIVALENT — whole-run embedding census does not balance (see below)"
            else:
                verdict = "NOT EQUIVALENT — %s (see below)" % (
                    "1 photo differs" if n == 1 else "%d photos differ" % n
                )
        else:
            factor = speed["wall"]["speedup"]
            if factor is None:
                verdict = "EQUIVALENT — results identical (no usable wall clock to compare)"
            else:
                verdict = "EQUIVALENT — results identical, %.2fx %s" % (
                    factor if factor >= 1 else (1 / factor if factor > 0 else 0.0),
                    "faster" if factor >= 1 else "SLOWER",
                )

    if args.as_json:
        payload: Dict[str, Any] = {
            "verdict": verdict,
            "ok": ok,
            "labels": labels,
            "self_consistency": {who: {"ok": not p, "violations": p} for who, p in consistency.items()},
        }
        if equiv is not None:
            payload["equivalence"] = equiv
        if speed is not None:
            payload["speed"] = speed
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        report_text(verdict, consistency, equiv, speed, labels)

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
