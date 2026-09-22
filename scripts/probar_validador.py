#!/usr/bin/env python3
"""Pruebas negativas de `validate_web6.py`.

Un validador que nunca se vio fallar no está probado: sólo se sabe que acepta el
estado actual, que es lo que hace también un validador que no comprueba nada. El
CI de este repositorio estuvo en verde mientras convivía con siete rutas
declaradas inexistentes, un resumen que negaba un archivo requerido y un
JavaScript de cero bytes cargado por seis páginas.

Cada prueba **rompe algo a propósito** sobre una copia temporal del repositorio
—nunca sobre el original— y exige que el validador lo detecte con el mensaje
correcto. Si una prueba pasa cuando no debería, el validador tiene un agujero.

Uso:
    python scripts/probar_validador.py .
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CONFIG = "data/portal/stats_config.json"
RESUMEN = "data/catalog/manifest_summary.json"


# --- perturbaciones: cada una devuelve el fragmento que debe aparecer ---------

def falta_un_disponible(root: Path) -> str:
    (root / "data/jem-silver/link.parquet").unlink()
    return "declara «disponible» pero no existe"


def filas_que_no_cuadran(root: Path) -> str:
    p = root / CONFIG
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["parquet"]["causa"]["filas"] = 1670          # el valor real es 1.669
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return "declara 1,670 filas"


def ausente_que_ya_existe(root: Path) -> str:
    shutil.copy(root / "data/jem-silver/link.parquet",
                root / "data/jem-silver/votacion.parquet")
    return "declara «ausente» pero"


def ausente_sin_motivo(root: Path) -> str:
    p = root / CONFIG
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["parquet"]["votacion"].pop("motivo", None)
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return "sin «motivo»"


def resumen_que_niega_el_parquet(root: Path) -> str:
    p = root / RESUMEN
    r = json.loads(p.read_text(encoding="utf-8"))
    r["silver_load_error"] = "no existe data/jem-silver/document.parquet"
    p.write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8")
    return "pero el archivo existe"


def resumen_con_filas_falsas(root: Path) -> str:
    p = root / RESUMEN
    r = json.loads(p.read_text(encoding="utf-8"))
    r["silver_rows"] = 4627                          # cifra del otro linaje
    p.write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8")
    return "declara silver_rows=4,627"


def html_a_un_archivo_inexistente(root: Path) -> str:
    p = root / "index.html"
    p.write_text(p.read_text(encoding="utf-8").replace(
        "</body>", '<script src="assets/js/no-existe.js"></script></body>'),
        encoding="utf-8")
    return "referencia assets/js/no-existe.js"


def html_a_un_archivo_vacio(root: Path) -> str:
    """El fallo exacto que tenía el repositorio: site.js con cero bytes."""
    (root / "assets/js/vacio.js").write_text("", encoding="utf-8")
    p = root / "estadisticas.html"
    p.write_text(p.read_text(encoding="utf-8").replace(
        "</body>", '<script src="assets/js/vacio.js"></script></body>'),
        encoding="utf-8")
    return "está vacío (0 bytes)"


def estado_desconocido(root: Path) -> str:
    p = root / CONFIG
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["parquet"]["causa"]["estado"] = "quizas"
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return "estado desconocido"


PRUEBAS = [
    ("un conjunto «disponible» que falta",       falta_un_disponible),
    ("filas declaradas que no cuadran",          filas_que_no_cuadran),
    ("un conjunto «ausente» que ya existe",      ausente_que_ya_existe),
    ("un «ausente» sin motivo",                  ausente_sin_motivo),
    ("el resumen niega un Parquet que existe",   resumen_que_niega_el_parquet),
    ("el resumen declara filas de otro linaje",  resumen_con_filas_falsas),
    ("HTML apunta a un archivo inexistente",     html_a_un_archivo_inexistente),
    ("HTML apunta a un archivo vacío",           html_a_un_archivo_vacio),
    ("un estado que no está definido",           estado_desconocido),
]


def correr(root: Path) -> tuple[int, str]:
    r = subprocess.run([sys.executable, "scripts/validate_web6.py", "."],
                       cwd=root, capture_output=True, text=True, encoding="utf-8")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", nargs="?", default=".")
    args = ap.parse_args()
    origen = Path(args.root).resolve()

    print("Pruebas negativas de validate_web6.py\n")
    fallos = 0

    with tempfile.TemporaryDirectory(prefix="valida-") as tmp:
        base = Path(tmp) / "limpio"
        shutil.copytree(origen, base,
                        ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc"))

        # Prueba positiva: sobre la copia intacta debe pasar.
        codigo, salida = correr(base)
        if codigo == 0:
            print("  ok    copia intacta: el validador pasa")
        else:
            fallos += 1
            print("  FALLO copia intacta: el validador ya falla antes de romper nada")
            print("        " + salida.strip().replace("\n", "\n        "))

        for nombre, romper in PRUEBAS:
            trabajo = Path(tmp) / "trabajo"
            if trabajo.exists():
                shutil.rmtree(trabajo)
            shutil.copytree(base, trabajo)
            esperado = romper(trabajo)
            codigo, salida = correr(trabajo)

            if codigo == 0:
                fallos += 1
                print(f"  FALLO {nombre}: el validador NO lo detectó")
            elif esperado not in salida:
                fallos += 1
                print(f"  FALLO {nombre}: detectó algo, pero no lo esperado")
                print(f"        esperaba: {esperado!r}")
                print("        " + salida.strip().replace("\n", "\n        "))
            else:
                print(f"  ok    {nombre}")

    print(f"\n  {len(PRUEBAS) + 1} pruebas · {fallos} fallos")
    if fallos:
        print("\n  Una prueba negativa que no falla significa que el validador")
        print("  tiene un agujero de ese tamaño.")
    return 1 if fallos else 0


if __name__ == "__main__":
    raise SystemExit(main())
