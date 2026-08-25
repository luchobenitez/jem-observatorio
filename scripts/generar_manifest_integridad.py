#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Genera MANIFEST.sha256 para el portal, excluyendo artefactos temporales."""
from __future__ import annotations
import argparse
import hashlib
from pathlib import Path

EXCLUDED_DIRS = {".git", ".venv", "venv", "__pycache__", "_site", "node_modules"}
EXCLUDED_FILES = {"MANIFEST.sha256"}

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--output", default="MANIFEST.sha256")
    args = ap.parse_args()
    root = Path(args.root).resolve()
    output = root / args.output

    rows = []
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root)
        if any(part in EXCLUDED_DIRS for part in rel.parts):
            continue
        if rel.as_posix() in EXCLUDED_FILES or p.resolve() == output.resolve():
            continue
        if p.suffix == ".pyc":
            continue
        rows.append((rel.as_posix(), sha256_file(p)))

    output.write_text(
        "".join(f"{digest}  {rel}\n" for rel, digest in rows),
        encoding="utf-8"
    )
    print(f"{output}: {len(rows)} archivos")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
