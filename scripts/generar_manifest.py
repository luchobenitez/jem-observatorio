#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generar_manifest.py

Genera el catálogo público que enlaza el portal con los documentos físicos.

Fuentes admitidas:
1) Escaneo directo de /documentos (modo normal en E:\\jem\\web).
2) Un CSV de inventario previamente generado, útil para reproducir el catálogo
   sin copiar los binarios al entorno de trabajo.

No renombra, mueve ni elimina documentos.
No modifica los Parquet originales de JEM Silver.

Salidas:
  data/catalog/documents_manifest.json
  data/catalog/documents_manifest.csv
  data/catalog/path_index.json
  data/catalog/manifest_summary.json
  data/catalog/unmatched_files.csv
  data/catalog/unmatched_parquet.csv
  data/catalog/silver_prefix_candidates.csv
  data/catalog/document_public.parquet  (si pyarrow y Silver están disponibles)
  MANIFEST.sha256

Ejemplos:

  # Escaneo del archivo documental real:
  python scripts/generar_manifest.py .

  # Reproducir desde el inventario ya calculado:
  python scripts/generar_manifest.py . \
      --inventory-csv docs/inventario/documentos_rutas.csv

  # Documentos alojados en otro host:
  python scripts/generar_manifest.py . \
      --download-base-url "https://HOST/RUTA/documentos"
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import mimetypes
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

PUBLIC_EXTENSIONS = {".pdf", ".doc", ".docx"}
HEX64 = re.compile(r"^[0-9a-f]{64}$", re.I)
HEX8_SUFFIX = re.compile(r"\[([0-9a-f]{8})\](?=\.[^.]+$)", re.I)


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk_size), b""):
            h.update(block)
    return h.hexdigest()


def posix_relative(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def normalize_oid(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip().lower()
    for prefix in ("sha256:", "sha256/", "oid sha256:"):
        if s.startswith(prefix):
            s = s[len(prefix):].strip()
    return s if HEX64.fullmatch(s) else None


def parse_path_metadata(relative_path: str) -> tuple[str | None, int | None]:
    parts = relative_path.replace("\\", "/").split("/")
    category = parts[1] if len(parts) > 1 else None
    year = int(parts[2]) if len(parts) > 2 and re.fullmatch(r"\d{4}", parts[2]) else None
    return category, year


def make_download_url(relative_path: str, documents_root_name: str, base_url: str | None) -> str:
    rel = relative_path.replace("\\", "/").lstrip("/")
    if not base_url:
        return quote(rel, safe="/")
    prefix = documents_root_name.rstrip("/") + "/"
    inner = rel[len(prefix):] if rel.startswith(prefix) else rel
    return base_url.rstrip("/") + "/" + quote(inner, safe="/")


def canonical_row(group: list[dict[str, Any]]) -> dict[str, Any]:
    """Elige una ruta canónica solo entre copias byte-a-byte idénticas."""
    def score(row: dict[str, Any]):
        name = row["filename"]
        # Prefiere nomenclatura 123-2021 sobre duplicados 123-21.
        abbreviated_year = 1 if re.search(r"_\d+-\d{2}\b", name) else 0
        rel = row["relative_path"]
        return (abbreviated_year, len(rel), rel.casefold(), rel)
    return sorted(group, key=score)[0]


def scan_documents(root: Path, documents_dir: Path) -> tuple[list[dict[str, Any]], str]:
    rows: list[dict[str, Any]] = []
    for path in sorted(documents_dir.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in PUBLIC_EXTENSIONS:
            continue
        rel = posix_relative(path, root)
        digest = sha256_file(path)
        category, year = parse_path_metadata(rel)
        stat = path.stat()
        rows.append({
            "sha256": digest,
            "relative_path": rel,
            "filename": path.name,
            "extension": path.suffix.lower(),
            "mime_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            "size_bytes": int(stat.st_size),
            "category": category,
            "year": year,
            "path_verified_by_inventory": False,
            "file_exists_at_generation": True,
        })
    return rows, "filesystem"


def load_inventory(root: Path, inventory_csv: Path) -> tuple[list[dict[str, Any]], str]:
    rows: list[dict[str, Any]] = []
    with inventory_csv.open("r", encoding="utf-8-sig", newline="") as fh:
        for raw in csv.DictReader(fh):
            rel = (raw.get("relative_path") or "").replace("\\", "/").lstrip("/")
            ext = (raw.get("extension") or Path(rel).suffix).lower()
            digest = (raw.get("sha256") or "").strip().lower()
            if not rel.startswith("documentos/") or ext not in PUBLIC_EXTENSIONS:
                continue
            if not HEX64.fullmatch(digest):
                continue
            category, year = parse_path_metadata(rel)
            local = root / Path(rel)
            rows.append({
                "sha256": digest,
                "relative_path": rel,
                "filename": raw.get("name") or Path(rel).name,
                "extension": ext,
                "mime_type": mimetypes.guess_type(rel)[0] or "application/octet-stream",
                "size_bytes": int(float(raw.get("size_bytes") or 0)),
                "category": category,
                "year": year,
                "path_verified_by_inventory": True,
                "file_exists_at_generation": local.is_file(),
            })
    try:
        source_name = inventory_csv.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        source_name = inventory_csv.as_posix()
    return rows, source_name


def load_silver(parquet_path: Path):
    if not parquet_path.exists():
        return None, f"no existe {parquet_path}"
    try:
        import pyarrow.parquet as pq  # type: ignore
        return pq.read_table(parquet_path).to_pandas(), None
    except ImportError:
        return None, "pyarrow no instalado"
    except Exception as exc:
        return None, str(exc)


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            out = dict(row)
            for k, v in list(out.items()):
                if isinstance(v, (list, dict)):
                    out[k] = json.dumps(v, ensure_ascii=False)
            writer.writerow(out)


def create_integrity_manifest(project_root: Path, output_path: Path, excluded_dirs: set[Path]) -> int:
    entries: list[tuple[str, str]] = []
    out = output_path.resolve()
    for path in project_root.rglob("*"):
        if not path.is_file():
            continue
        if "__pycache__" in path.parts or path.suffix.lower() == ".pyc":
            continue
        resolved = path.resolve()
        if resolved == out:
            continue
        skip = False
        for excluded in excluded_dirs:
            try:
                resolved.relative_to(excluded.resolve())
                skip = True
                break
            except ValueError:
                pass
        if skip:
            continue
        entries.append((posix_relative(path, project_root), sha256_file(path)))
    entries.sort(key=lambda x: x[0].casefold())
    output_path.write_text("".join(f"{d}  {p}\n" for p, d in entries), encoding="utf-8")
    return len(entries)


def main() -> int:
    ap = argparse.ArgumentParser(description="Genera catálogo público, enlaces relativos y manifest SHA-256.")
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--documents-dir", default="documentos")
    ap.add_argument("--inventory-csv", default=None,
                    help="CSV de inventario; si se indica, las rutas y hashes se leen desde allí.")
    ap.add_argument("--silver-document", default="data/jem-silver/document.parquet")
    ap.add_argument("--catalog-dir", default="data/catalog")
    ap.add_argument("--download-base-url", default=None)
    ap.add_argument("--sin-integridad", action="store_true")
    ap.add_argument("--incluir-documentos-en-integridad", action="store_true")
    args = ap.parse_args()

    root = Path(args.root).expanduser().resolve()
    documents_dir = (root / args.documents_dir).resolve()
    catalog_dir = (root / args.catalog_dir).resolve()
    silver_path = (root / args.silver_document).resolve()
    if not root.is_dir():
        print(f"ERROR: raíz inexistente: {root}", file=sys.stderr)
        return 2

    if args.inventory_csv:
        inventory_csv = (root / args.inventory_csv).resolve()
        if not inventory_csv.exists():
            print(f"ERROR: inventario inexistente: {inventory_csv}", file=sys.stderr)
            return 2
        physical, source_name = load_inventory(root, inventory_csv)
    else:
        if not documents_dir.is_dir():
            print(f"ERROR: no existe {documents_dir}", file=sys.stderr)
            return 2
        physical, source_name = scan_documents(root, documents_dir)

    if not physical:
        print("ERROR: no se encontraron PDF/DOC/DOCX con SHA-256 válido.", file=sys.stderr)
        return 2

    by_hash: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in physical:
        by_hash[row["sha256"]].append(row)

    silver_df, silver_error = load_silver(silver_path)
    if silver_df is None and not silver_path.exists():
        silver_error = f"no existe {args.silver_document}"
    silver_by_oid: dict[str, dict[str, Any]] = {}
    prefix_index: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    if silver_df is not None and "hf_oid" in silver_df.columns:
        for _, sr in silver_df.iterrows():
            raw = sr.to_dict()
            oid = normalize_oid(raw.get("hf_oid"))
            if oid:
                silver_by_oid[oid] = raw
                prefix_index[oid[:8]].append(raw)
    elif silver_df is not None:
        silver_error = "document.parquet no contiene hf_oid"

    records: list[dict[str, Any]] = []
    matched_exact: set[str] = set()
    prefix_candidates: list[dict[str, Any]] = []

    for digest, group in sorted(by_hash.items()):
        c = canonical_row(group)
        aliases = sorted(r["relative_path"] for r in group if r["relative_path"] != c["relative_path"])
        token_match = HEX8_SUFFIX.search(c["filename"])
        token = token_match.group(1).lower() if token_match else None
        silver = silver_by_oid.get(digest)
        method = "sha256_equals_hf_oid" if silver else None
        if silver:
            matched_exact.add(digest)

        # Solo informa candidatos por prefijo; no los acepta como vínculo automático.
        if not silver and token and len(prefix_index.get(token, [])) == 1:
            s = prefix_index[token][0]
            prefix_candidates.append({
                "file_sha256": digest,
                "relative_path": c["relative_path"],
                "filename_token_8": token,
                "candidate_hf_oid": s.get("hf_oid"),
                "candidate_kind": s.get("kind"),
                "candidate_number": s.get("number"),
                "candidate_year": s.get("year"),
                "candidate_causa_id": s.get("causa_id"),
                "candidate_caratula": s.get("caratula"),
                "status": "candidate_only_not_applied",
            })

        year = silver.get("year") if silver else c["year"]
        number = silver.get("number") if silver else None
        body_quality = silver.get("body_quality") if silver else None
        records.append({
            "document_key": digest,
            "sha256": digest,
            "relative_path": c["relative_path"],
            "download_url": make_download_url(c["relative_path"], Path(args.documents_dir).name, args.download_base_url),
            "filename": c["filename"],
            "extension": c["extension"],
            "mime_type": c["mime_type"],
            "size_bytes": c["size_bytes"],
            "category": c["category"],
            "year": int(year) if year is not None and str(year) != "nan" else None,
            "aliases": aliases,
            "aliases_count": len(aliases),
            "filename_token_8": token,
            "path_source": source_name,
            "path_verified_by_inventory": bool(c["path_verified_by_inventory"]),
            "file_exists_at_generation": bool(c["file_exists_at_generation"]),
            "hf_oid": str(silver.get("hf_oid")) if silver else None,
            "causa_id": silver.get("causa_id") if silver else None,
            "kind": silver.get("kind") if silver else None,
            "number": int(number) if number is not None and str(number) != "nan" else None,
            "caratula": silver.get("caratula") if silver else None,
            "body_quality": float(body_quality) if body_quality is not None and str(body_quality) != "nan" else None,
            "silver_match_method": method,
        })

    unmatched_files = [r for r in records if silver_df is not None and not r["hf_oid"]]
    unmatched_parquet: list[dict[str, Any]] = []
    if silver_df is not None and "hf_oid" in silver_df.columns:
        for _, sr in silver_df.iterrows():
            raw = sr.to_dict()
            oid = normalize_oid(raw.get("hf_oid"))
            if oid and oid not in by_hash:
                unmatched_parquet.append({k: raw.get(k) for k in ["hf_oid","kind","number","year","causa_id","caratula"]})

    summary = {
        "schema_version": "2.0",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "path_source": source_name,
        "documents_dir": args.documents_dir,
        "download_mode": "external" if args.download_base_url else "relative",
        "download_base_url": args.download_base_url,
        "physical_files": len(physical),
        "unique_sha256": len(by_hash),
        "duplicate_copies": len(physical) - len(by_hash),
        "categories": dict(Counter(r["category"] for r in physical)),
        "silver_rows": int(len(silver_df)) if silver_df is not None else None,
        "exact_silver_matches": len(matched_exact),
        "prefix_candidates_not_applied": len(prefix_candidates),
        "unmatched_unique_files": len(unmatched_files),
        "unmatched_silver_rows": len(unmatched_parquet),
        "silver_load_error": silver_error,
    }

    catalog_dir.mkdir(parents=True, exist_ok=True)
    payload = {"schema_version":"2.0", "summary":summary, "documents":records}
    (catalog_dir / "documents_manifest.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str), encoding="utf-8"
    )
    (catalog_dir / "manifest_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    (catalog_dir / "path_index.json").write_text(
        json.dumps({r["sha256"]:{"relative_path":r["relative_path"],"download_url":r["download_url"],"aliases":r["aliases"]} for r in records},
                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    fields = ["document_key","sha256","relative_path","download_url","filename","extension","mime_type","size_bytes","category","year","aliases_count","aliases","filename_token_8","path_source","path_verified_by_inventory","file_exists_at_generation","hf_oid","causa_id","kind","number","caratula","body_quality","silver_match_method"]
    write_csv(catalog_dir / "documents_manifest.csv", records, fields)
    write_csv(catalog_dir / "unmatched_files.csv", unmatched_files, fields)
    write_csv(catalog_dir / "unmatched_parquet.csv", unmatched_parquet, ["hf_oid","kind","number","year","causa_id","caratula"])
    write_csv(catalog_dir / "silver_prefix_candidates.csv", prefix_candidates,
              ["file_sha256","relative_path","filename_token_8","candidate_hf_oid","candidate_kind","candidate_number","candidate_year","candidate_causa_id","candidate_caratula","status"])

    public_written = False
    if silver_df is not None:
        try:
            import pandas as pd  # type: ignore
            import pyarrow as pa  # type: ignore
            import pyarrow.parquet as pq  # type: ignore
            mdf = pd.DataFrame([{
                "manifest_sha256":r["sha256"],
                "relative_path":r["relative_path"],
                "download_url":r["download_url"],
                "file_sha256":r["sha256"],
                "file_size_bytes":r["size_bytes"],
                "file_mime_type":r["mime_type"],
                "file_aliases_count":r["aliases_count"],
            } for r in records if r["hf_oid"]])
            if len(mdf):
                sc = silver_df.copy()
                sc["_oid"] = sc["hf_oid"].map(normalize_oid)
                public = sc.merge(mdf, how="left", left_on="_oid", right_on="manifest_sha256").drop(columns=["_oid"])
                pq.write_table(pa.Table.from_pandas(public, preserve_index=False), catalog_dir / "document_public.parquet", compression="zstd")
                public_written = True
        except Exception as exc:
            summary["public_parquet_error"] = str(exc)
    summary["document_public_parquet_written"] = public_written
    (catalog_dir / "manifest_summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2,default=str),encoding="utf-8")

    if not args.sin_integridad:
        excluded = {documents_dir} if documents_dir.exists() and not args.incluir_documentos_en_integridad else set()
        for candidate in (root/"_inventario_jem", root/".git"):
            if candidate.exists(): excluded.add(candidate.resolve())
        count = create_integrity_manifest(root, root/"MANIFEST.sha256", excluded)
    else:
        count = None

    print("="*76)
    print("CATÁLOGO DOCUMENTAL GENERADO")
    print("="*76)
    print(f"Fuente de rutas          : {source_name}")
    print(f"Archivos físicos         : {len(physical):,}")
    print(f"Contenidos únicos        : {len(by_hash):,}")
    print(f"Copias idénticas         : {len(physical)-len(by_hash):,}")
    print(f"Filas Silver             : {len(silver_df):,}" if silver_df is not None else "Filas Silver             : no disponibles")
    print(f"Matches exactos SHA/OID  : {len(matched_exact):,}")
    print(f"Candidatos por prefijo   : {len(prefix_candidates):,} (NO aplicados)")
    print(f"document_public.parquet  : {'sí' if public_written else 'no'}")
    if count is not None: print(f"MANIFEST.sha256          : {count:,} archivos")
    if silver_error: print(f"Aviso Silver             : {silver_error}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
