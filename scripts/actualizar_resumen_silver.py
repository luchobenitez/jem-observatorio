#!/usr/bin/env python3
"""Recalcula los campos del resumen del catálogo que dependen de la capa Silver.

`data/catalog/manifest_summary.json` quedó fijado el 2026-08-24, cuando los
Parquet todavía no estaban en el repositorio, y desde entonces afirma:

    "silver_load_error": "no existe data/jem-silver/document.parquet"

El archivo existe. Peor: `validate_web6.py` **exige** que exista, de modo que el
repositorio sostenía dos afirmaciones contradictorias y ninguna herramienta lo
notaba.

Por qué no basta con volver a ejecutar `generar_manifest.py`
--------------------------------------------------------------
Ese script recorre `documentos/`, que no está en este repositorio —los documentos
viven en HuggingFace—. Alimentarlo con `documents_manifest.csv` en su lugar
funciona, pero ese CSV ya está deduplicado: `physical_files` caería de 4.051 a
3.964 y `duplicate_copies` de 87 a 0. Serían cifras **peores**, no más nuevas.

Este script toca únicamente los campos que puede recalcular con lo que hay en el
repositorio, y deja intactos los que provienen del recorrido de archivos.

Sobre `exact_silver_matches`
-----------------------------
Vale 0 y **no es un fallo de este script**: el catálogo identifica por SHA-256
del contenido (64 hex) y la capa Silver por `hf_oid`, que es un OID de blob de
Git (SHA-1, 40 hex). Son espacios de identificadores distintos y no se cruzan.
`sync_huggingface.py` rellena `hf_oid` en el catálogo consultando la API de
HuggingFace; hasta que corre —sólo en CI, con red— el cruce es imposible por
construcción, no por error. Queda declarado en el propio resumen.

Uso:
    python scripts/actualizar_resumen_silver.py .
    python scripts/actualizar_resumen_silver.py . --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

VERSION = "actualizar_resumen_silver/1.0"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    resumen = root / "data/catalog/manifest_summary.json"
    silver = root / "data/jem-silver/document.parquet"
    catalogo = root / "data/catalog/documents_manifest.json"

    for p in (resumen, catalogo):
        if not p.is_file():
            print(f"ERROR: falta {p.relative_to(root)}", file=sys.stderr)
            return 2

    datos = json.loads(resumen.read_text(encoding="utf-8"))
    previo = dict(datos)

    if silver.is_file():
        try:
            import pyarrow.parquet as pq
            tabla = pq.read_table(silver)
            datos["silver_rows"] = tabla.num_rows
            datos["silver_load_error"] = None
            oids = {str(x).lower() for x in tabla.column("hf_oid").to_pylist() if x} \
                if "hf_oid" in tabla.schema.names else set()
        except ImportError:
            print("ERROR: falta pyarrow (pip install -r scripts/requirements.txt)",
                  file=sys.stderr)
            return 2
    else:
        datos["silver_rows"] = None
        datos["silver_load_error"] = "no existe data/jem-silver/document.parquet"
        oids = set()

    docs = json.loads(catalogo.read_text(encoding="utf-8")).get("documents", [])
    cat_oids = {str(d["hf_oid"]).lower() for d in docs if d.get("hf_oid")}
    estados = Counter(d.get("storage_status") or "(vacío)" for d in docs)

    datos["exact_silver_matches"] = len(oids & cat_oids)
    datos["unmatched_silver_rows"] = len(oids - cat_oids)
    datos["unmatched_unique_files"] = len(cat_oids - oids) if cat_oids else len(docs)
    datos["catalog_hf_oid_populated"] = len(cat_oids)
    datos["catalog_storage_status"] = dict(estados)
    datos["silver_join_note"] = (
        "El catálogo identifica por SHA-256 del contenido (64 hex) y la capa Silver "
        "por hf_oid, que es un OID de blob de Git (SHA-1, 40 hex): no son el mismo "
        "espacio de identificadores. El cruce sólo es posible después de que "
        "sync_huggingface.py rellene hf_oid en el catálogo desde la API de "
        "HuggingFace, cosa que ocurre en CI. Con hf_oid sin rellenar, "
        "exact_silver_matches vale 0 por construcción y no por error."
    )
    datos["silver_fields_updated_at_utc"] = datetime.now(timezone.utc).isoformat()
    datos["silver_fields_updated_by"] = VERSION
    datos["_nota_campos"] = (
        "physical_files, unique_sha256, duplicate_copies y categories provienen del "
        "recorrido de documentos/ y NO se recalculan aquí: este repositorio no "
        "contiene esa carpeta. Los actualiza generar_manifest.py."
    )

    cambios = [(k, previo.get(k), datos[k]) for k in datos
               if k not in previo or previo.get(k) != datos[k]]
    print("Campos de la capa Silver en manifest_summary.json\n")
    for k, a, b in cambios:
        va = json.dumps(a, ensure_ascii=False)
        vb = json.dumps(b, ensure_ascii=False)
        corta = lambda s: s if len(s) <= 46 else s[:43] + "…"
        print(f"  {k:32} {corta(va):>48}  ->  {corta(vb)}")
    if not cambios:
        print("  (sin cambios)")

    if args.dry_run:
        print("\n--dry-run: no se escribió nada.")
        return 0
    resumen.write_text(json.dumps(datos, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")
    print(f"\n  escrito {resumen.relative_to(root)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
