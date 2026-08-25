#!/usr/bin/env python3
from pathlib import Path
import argparse, json, sys

REQUIRED_PARQUETS = [
    "causa.parquet",
    "document.parquet",
    "link.parquet",
    "party.parquet",
    "party_conflict.parquet",
]
REQUIRED_PAGES = [
    "index.html","caso.html","estadisticas.html",
    "documentos.html","fuentes.html","metodologia.html"
]

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--allow-missing-parquet", action="store_true")
    args=ap.parse_args()
    root=Path(args.root).resolve()
    errors=[]

    for name in REQUIRED_PAGES:
        if not (root/name).is_file():
            errors.append(f"Falta {name}")

    manifest=root/"data/catalog/documents_manifest.json"
    if not manifest.is_file():
        errors.append("Falta data/catalog/documents_manifest.json")
    else:
        try:
            obj=json.loads(manifest.read_text(encoding="utf-8"))
            docs=obj.get("documents",[])
            if not docs:
                errors.append("documents_manifest.json no contiene documentos")
        except Exception as e:
            errors.append(f"Manifest JSON inválido: {e}")

    missing=[x for x in REQUIRED_PARQUETS if not (root/"data/jem-silver"/x).is_file()]
    if missing and not args.allow_missing_parquet:
        errors.append("Faltan Parquet locales en data/jem-silver/: "+", ".join(missing))

    if errors:
        print("ERROR")
        for e in errors: print(" -",e)
        return 1

    print("OK: Web6 listo")
    if missing:
        print("Advertencia: faltan Parquet (permitido por flag):", ", ".join(missing))
    return 0

if __name__=="__main__":
    raise SystemExit(main())
