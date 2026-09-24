#!/usr/bin/env python3
"""Verifica que cada documento publicado exista de verdad en Hugging Face.

Qué hacía antes y por qué cambió
---------------------------------
Este script generaba `data/catalog/document_public.parquet` cruzando el
manifiesto con la capa Silver. El cruce era `hf_oid` contra `sha256`: un OID de
blob de Git (SHA-1, 40 hex) contra un hash de contenido (SHA-256, 64 hex). Dos
espacios de identificadores distintos, de modo que la unión daba cero filas
**por construcción**. El propio `manifest_summary.json` lo declaraba.

El efecto era que `document_public.parquet` salía sin URL o no salía, la
pestaña del corpus caía a la reserva —el corpus de agosto, con 3.964
documentos— y el portal mostraba dos tamaños distintos según la pestaña.

La generación del catálogo pasó a `exportar_documentos_portal.py`, que deriva
las URL de la edición vigente en vez de reconstruirlas por hash. Acá queda lo
que este script sí sabe hacer y ninguna otra cosa hace: **preguntarle al
repositorio remoto si los archivos están**.

Por qué eso importa
-------------------
El catálogo declara 4.627 URL públicas. Si alguien renombra una carpeta en
Hugging Face, el portal sigue enseñando los enlaces y el visitante se encuentra
con un 404 por cada documento que intente abrir. La comprobación es barata
—una sola llamada que lista el árbol remoto— y detiene el despliegue antes de
publicar enlaces rotos.

Uso:
    python scripts/sync_huggingface.py --root . --repo-id angatupyrytau/jem
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

VERSION = "sync_huggingface/2.0"

# Las extensiones que el catálogo publica de verdad, medidas y no supuestas.
# Con una lista escrita de memoria el recuento de documentos remotos salía en
# 4.535 frente a los 4.627 del catálogo: faltaban los 180 `.json` del orden del
# día, que son documentos del archivo igual que los demás.
EXTENSIONES = {".pdf", ".docx", ".doc", ".json", ".odt", ".rtf", ".txt"}


def clave(ruta: str) -> str:
    """Normaliza una ruta remota para comparar.

    Las URL publicadas van con porcentajes de escape y el árbol remoto no, de
    modo que comparar las cadenas crudas daría falsos negativos en todos los
    documentos con espacios o acentos, que son la mayoría.
    """
    return unquote(str(ruta or "")).replace("\\", "/").strip("/")


def es_documento(ruta: str) -> bool:
    return Path(ruta).suffix.lower() in EXTENSIONES


def catalogo_vigente(root: Path) -> tuple[Path, list]:
    ediciones = json.loads(
        (root / "data" / "jem-silver" / "editions.json").read_text(encoding="utf-8"))
    ruta = root / "data" / "jem-silver" / ediciones["vigente"] / "catalogo.json"
    datos = json.loads(ruta.read_text(encoding="utf-8"))
    docs = datos if isinstance(datos, list) else (
        datos.get("documentos") or datos.get("documents") or [])
    return ruta, docs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=".", type=Path)
    ap.add_argument("--repo-id", required=True)
    ap.add_argument("--revision", default="main")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--permitir-faltantes", type=int, default=0,
                    help="cuántos documentos ausentes se toleran antes de fallar")
    args = ap.parse_args()

    try:
        from huggingface_hub import HfApi
    except ImportError as exc:
        raise SystemExit(
            "Falta huggingface_hub. Ejecute pip install -r scripts/requirements.txt") from exc

    root = Path(args.root).resolve()
    ruta_cat, docs = catalogo_vigente(root)
    if not docs:
        raise SystemExit(f"{ruta_cat} no contiene documentos")

    import os
    api = HfApi(token=os.environ.get("HF_TOKEN") or False)
    print(f"[HF] Dataset: {args.repo_id}@{args.revision}")
    info = api.dataset_info(args.repo_id, revision=args.revision)
    remoto = api.list_repo_files(repo_id=args.repo_id, repo_type="dataset",
                                 revision=args.revision)
    claves = {clave(x) for x in remoto}
    docs_remotos = [x for x in remoto if es_documento(x)]

    faltan, sin_ruta = [], []
    for d in docs:
        hf = d.get("hf_path")
        if not hf:
            sin_ruta.append(d)
        elif clave(hf) not in claves:
            faltan.append(d)

    snapshot = {
        "schema_version": 2,
        "generador": VERSION,
        "provider": "huggingface",
        "repo_id": args.repo_id,
        "revision": args.revision,
        "repo_commit": getattr(info, "sha", None),
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "catalogo": str(ruta_cat.relative_to(root)).replace("\\", "/"),
        "remote_files_seen": len(remoto),
        "document_files_seen": len(docs_remotos),
        "catalogo_records": len(docs),
        "manifest_matches": len(docs) - len(faltan) - len(sin_ruta),
        "manifest_unmatched": len(faltan) + len(sin_ruta),
        "status": "OK" if not (faltan or sin_ruta) else "INCOMPLETO",
    }

    print(f"[HF] archivos remotos: {len(remoto):,} · documentos: {len(docs_remotos):,}")
    print(f"[HF] catálogo: {len(docs):,} · verificados: {snapshot['manifest_matches']:,}")
    if sin_ruta:
        print(f"[HF] {len(sin_ruta):,} sin ruta declarada en el catálogo")
    if faltan:
        print(f"[HF] {len(faltan):,} declarados que NO están en el repositorio:")
        for d in faltan[:10]:
            print(f"        {d.get('hf_path')}")
        if len(faltan) > 10:
            print(f"        … y {len(faltan) - 10:,} más")

    if args.dry_run:
        print("[DRY-RUN] No se escribieron cambios.")
        return 0

    salida = root / "data" / "catalog" / "hf_snapshot.json"
    salida.write_text(json.dumps(snapshot, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[HF] escrito {salida.relative_to(root)}")

    # Falla el despliegue antes que publicar enlaces rotos. El umbral es
    # explícito y por defecto cero: tolerar ausencias «unas pocas» sin decir
    # cuántas es la forma de que crezcan sin que nadie lo note.
    problemas = len(faltan) + len(sin_ruta)
    if problemas > args.permitir_faltantes:
        print(f"\n  ERROR: {problemas:,} documentos del catálogo no se pueden abrir "
              f"en Hugging Face (tolerancia: {args.permitir_faltantes})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
