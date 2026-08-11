#!/usr/bin/env python3
"""Is any face-embedding shard still sitting in the PUBLIC R2 bucket?

    set -a; . ./.env.deploy; set +a
    python3 tools/check-index-leak.py

Face shards are raw biometric vectors — one row per detected face. They were moved
to the private `race-lens-index` bucket precisely so the public bucket could be
given a custom domain, because an R2 custom domain publishes the WHOLE bucket.
apps/api/src/search.ts still falls back to the public bucket for events indexed
before that split, which is both the reason any leftovers are still reachable and
the reason nobody would notice them.

Two things have to be true before that fallback can be deleted:

  1. Nothing is left under index/ in the public bucket, or it leaks.
  2. Nothing is left under index/ in the public bucket, or deleting the fallback
     BREAKS FACE SEARCH for whichever events those shards belong to.

So this is a precondition, not a formality — running it in the wrong order turns a
quiet privacy problem into a loud outage.

Exit 0 = clean, safe to drop the fallback. Exit 1 = objects found, listed below.
Exit 2 = could not check (missing credentials or boto3).
"""
from __future__ import annotations

import os
import sys

PUBLIC_BUCKET = os.environ.get("R2_BUCKET", "race-lens")
PRIVATE_BUCKET = os.environ.get("R2_INDEX_BUCKET", "race-lens-index")


def main() -> int:
    try:
        import boto3
    except ImportError:
        print("boto3 is not installed. Try:\n  pip install boto3", file=sys.stderr)
        return 2

    # R2_ACCOUNT_ID is the Actions secret name; .env.deploy stores the same value as
    # CLOUDFLARE_ACCOUNT_ID and set-secrets.sh maps one to the other. Accept either,
    # or this refuses to run against a perfectly well-configured .env.deploy.
    account = os.environ.get("R2_ACCOUNT_ID") or os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    missing = [k for k in ("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY") if not os.environ.get(k)]
    if not account:
        missing.insert(0, "R2_ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID)")
    if missing:
        print(f"Missing: {', '.join(missing)}", file=sys.stderr)
        print("  set -a; . ./.env.deploy; set +a", file=sys.stderr)
        return 2

    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )

    found: list[tuple[str, int]] = []
    total = 0
    paginator = s3.get_paginator("list_objects_v2")
    try:
        for page in paginator.paginate(Bucket=PUBLIC_BUCKET, Prefix="index/"):
            for obj in page.get("Contents", []):
                total += 1
                if len(found) < 40:
                    found.append((obj["Key"], obj["Size"]))
    except Exception as exc:  # noqa: BLE001
        print(f"Could not list {PUBLIC_BUCKET}: {exc}", file=sys.stderr)
        return 2

    if not total:
        print(f"clean — no objects under index/ in the public bucket ({PUBLIC_BUCKET}).")
        print("It is now safe to delete the BUCKET fallback in apps/api/src/search.ts.")
        return 0

    print(f"{total} shard object(s) still in the PUBLIC bucket ({PUBLIC_BUCKET}):\n")
    for key, size in found:
        print(f"  {size:>10,}  {key}")
    if total > len(found):
        print(f"  … and {total - len(found)} more")

    print(
        "\nEach of these is publicly fetchable at the bucket's custom domain by anyone\n"
        "who knows the key. Copy them into the private bucket, verify face search\n"
        "still works for those events, delete them here, then re-run this check:\n"
        f"\n  aws s3 sync s3://{PUBLIC_BUCKET}/index/ s3://{PRIVATE_BUCKET}/index/ \\\n"
        f"    --endpoint-url https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com\n"
        "\nDo NOT delete the search.ts fallback until this reports clean — those events\n"
        "would lose face search entirely."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
