#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sincroniza el catálogo documental del portal con un dataset de Hugging Face.

IMPORTANTE:
- Hugging Face contiene SOLO los documentos.
- data/jem-silver/*.parquet permanece en el repositorio GitHub/Pages.
- El script NO descarga Parquet.
- El script NO descarga PDF/DOC/DOCX.
- Las asociaciones se hacen únicamente por rutas exactas candidatas.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

DEFAULT_REPO_ID = "angatupyrytau/jem"
DEFAULT_REVISION = "main"

def norm_path(value: str) -> str:
    return unicodedata.normalize("NFC", str(value or "")).replace("\\", "/").strip("/")

def path_key(value: str) -> str:
    return norm_path(value).casefold()

def urls(repo_id: str, revision: str, hf_path: str):
    encoded = quote(norm_path(hf_path), safe="/")
    base = f"https://huggingface.co/datasets/{repo_id}"
    rev = quote(revision, safe="")
    return (
        f"{base}/blob/{rev}/{encoded}",
        f"{base}/resolve/{rev}/{encoded}",
    )

def expected_paths(relative_path: str):
    p = norm_path(relative_path)
    out = []
    if p.startswith("documentos/autos_interlocutorios/"):
        rest = p[len("documentos/autos_interlocutorios/"):]
        out += [f"autos_interlocutorios/{rest}", f"documentos/autos_interlocutorios/{rest}"]
    elif p.startswith("documentos/dictamenes/"):
        rest = p[len("documentos/dictamenes/"):]
        out += [f"dictamenes/{rest}", f"documentos/dictamenes/{rest}"]
    elif p.startswith("documentos/sentencia_definitiva/"):
        rest = p[len("documentos/sentencia_definitiva/"):]
        out += [
            f"sentencias_definitivas/{rest}",
            f"sentencia_definitiva/{rest}",
            f"documentos/sentencias_definitivas/{rest}",
            f"documentos/sentencia_definitiva/{rest}",
        ]
    elif p.startswith("documentos/sentencias_definitivas/"):
        rest = p[len("documentos/sentencias_definitivas/"):]
        out += [
            f"sentencias_definitivas/{rest}",
            f"sentencia_definitiva/{rest}",
            f"documentos/sentencias_definitivas/{rest}",
            f"documentos/sentencia_definitiva/{rest}",
        ]
    return list(dict.fromkeys(out))

def is_document_path(path: str) -> bool:
    return Path(path).suffix.lower() in {".pdf", ".doc", ".docx"}

def create_document_public(root: Path, docs):
    parquet = root / "data/jem-silver/document.parquet"
    output = root / "data/catalog/document_public.parquet"
    if not parquet.exists():
        return {"status": "SKIPPED", "reason": "data/jem-silver/document.parquet no existe"}

    try:
        import pandas as pd
    except ImportError:
        return {"status": "SKIPPED", "reason": "pandas/pyarrow no disponibles"}

    silver = pd.read_parquet(parquet)
    if "hf_oid" not in silver.columns:
        return {"status": "SKIPPED", "reason": "document.parquet no contiene hf_oid"}

    mrows = []
    for d in docs:
        sha = str(d.get("sha256") or "").lower()
        if not re.fullmatch(r"[0-9a-f]{64}", sha):
            continue
        mrows.append({
            "_join_sha": sha,
            "relative_path": d.get("relative_path"),
            "file_sha256": sha,
            "file_size_bytes": d.get("size_bytes"),
            "file_mime_type": d.get("mime_type"),
            "storage_provider": "huggingface",
            "repo_id": d.get("repo_id"),
            "revision": d.get("revision"),
            "hf_path": d.get("hf_path"),
            "view_url": d.get("view_url"),
            "download_url": d.get("download_url"),
        })

    manifest_df = pd.DataFrame(mrows)
    silver = silver.copy()
    silver["_join_sha"] = silver["hf_oid"].astype(str).str.lower()
    public = silver.merge(manifest_df, how="left", on="_join_sha", validate="many_to_one")
    matched = int(public["hf_path"].notna().sum()) if "hf_path" in public.columns else 0
    public.drop(columns=["_join_sha"]).to_parquet(output, index=False)
    return {"status": "OK", "rows": len(public), "exact_sha_matches_with_hf_link": matched}

def write_csv(path: Path, docs):
    fields = [
        "sha256","relative_path","filename","extension","mime_type","size_bytes",
        "category","year","hf_oid","causa_id","kind","number","caratula",
        "storage_provider","storage_status","repo_id","revision","hf_path",
        "hf_match_method","view_url","download_url","aliases_count"
    ]
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for d in docs:
            w.writerow({k:d.get(k) for k in fields})

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--repo-id", default=DEFAULT_REPO_ID)
    ap.add_argument("--revision", default=DEFAULT_REVISION)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    try:
        from huggingface_hub import HfApi
    except ImportError as exc:
        raise SystemExit("Falta huggingface_hub. Ejecute pip install -r scripts/requirements.txt") from exc

    root = Path(args.root).resolve()
    catalog = root / "data/catalog"
    manifest_path = catalog / "documents_manifest.json"
    obj = json.loads(manifest_path.read_text(encoding="utf-8"))
    docs = obj["documents"]

    token = os.environ.get("HF_TOKEN") or False
    api = HfApi(token=token)

    print(f"[HF] Dataset: {args.repo_id}")
    info = api.dataset_info(args.repo_id, revision=args.revision)
    repo_commit = getattr(info, "sha", None)

    remote = api.list_repo_files(
        repo_id=args.repo_id,
        repo_type="dataset",
        revision=args.revision,
        token=token,
    )
    remote_set = {path_key(x): x for x in remote}
    remote_docs = [x for x in remote if is_document_path(x)]

    matched_remote_keys = set()
    for d in docs:
        candidates = d.get("expected_hf_paths") or expected_paths(d.get("relative_path", ""))
        d["expected_hf_paths"] = candidates
        d["storage_provider"] = "huggingface"
        d["repo_id"] = args.repo_id
        d["repo_type"] = "dataset"
        d["revision"] = args.revision
        d["storage_status"] = "not_found_in_huggingface"
        d["hf_path"] = None
        d["hf_match_method"] = None
        d["view_url"] = None
        d["download_url"] = None

        # Ruta canónica + alias, siempre comparación exacta.
        all_candidates = list(candidates)
        for alias in d.get("aliases", []) or []:
            all_candidates.extend(expected_paths(alias))
        all_candidates = list(dict.fromkeys(all_candidates))

        for candidate in all_candidates:
            key = path_key(candidate)
            if key in remote_set:
                actual = remote_set[key]
                view_url, download_url = urls(args.repo_id, args.revision, actual)
                d["storage_status"] = "linked"
                d["hf_path"] = actual
                d["hf_match_method"] = "exact_path"
                d["view_url"] = view_url
                d["download_url"] = download_url
                matched_remote_keys.add(key)
                break

    matches = sum(1 for d in docs if d.get("hf_path"))
    missing = [d for d in docs if not d.get("hf_path")]
    remote_unmatched = [p for p in remote_docs if path_key(p) not in matched_remote_keys]

    snapshot = {
        "schema_version": 1,
        "provider": "huggingface",
        "repo_id": args.repo_id,
        "revision": args.revision,
        "repo_commit": repo_commit,
        "status": "OK",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "remote_files_seen": len(remote),
        "document_files_seen": len(remote_docs),
        "manifest_records": len(docs),
        "manifest_matches": matches,
        "manifest_unmatched": len(missing),
        "remote_documents_not_in_manifest": len(remote_unmatched),
        "jem_silver_source": "local:data/jem-silver",
        "document_public": None,
    }

    print(json.dumps(snapshot, ensure_ascii=False, indent=2))
    if args.dry_run:
        print("[DRY-RUN] No se escribieron cambios.")
        return 0

    summary = obj.setdefault("summary", {})
    summary.update({
        "storage_provider": "huggingface",
        "documents_repo_id": args.repo_id,
        "documents_revision": args.revision,
        "hf_sync_status": "OK",
        "hf_repo_commit": repo_commit,
        "hf_matched_documents": matches,
        "hf_unmatched_documents": len(missing),
        "jem_silver_location": "data/jem-silver (GitHub Pages)"
    })
    obj["documents"] = docs
    manifest_path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(catalog / "documents_manifest.csv", docs)

    with (catalog / "hf_unmatched_manifest.csv").open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["sha256","relative_path","expected_hf_paths"])
        for d in missing:
            w.writerow([d.get("sha256"), d.get("relative_path"), " | ".join(d.get("expected_hf_paths") or [])])

    with (catalog / "hf_remote_unmatched.csv").open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["hf_path"])
        for p in remote_unmatched:
            w.writerow([p])

    snapshot["document_public"] = create_document_public(root, docs)
    (catalog / "hf_snapshot.json").write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("[OK] Catálogo Hugging Face actualizado.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
