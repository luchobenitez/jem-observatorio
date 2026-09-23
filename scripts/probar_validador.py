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


EDITIONS = "data/jem-silver/editions.json"


def edicion_con_filas_falsas(root: Path) -> str:
    p = root / EDITIONS
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["ediciones"]["2026-08-30"]["tablas"]["voto"]["filas"] = 8355  # cifra del otro linaje
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return "declara 8,355 filas"


def edicion_a_una_tabla_que_falta(root: Path) -> str:
    (root / "data/jem-silver/2026-08-30/entidad.parquet").unlink()
    return "no existe data/jem-silver/2026-08-30/entidad.parquet"


def parquet_alterado(root: Path) -> str:
    """Un Parquet modificado sin regenerar la edición: el SHA-256 lo delata."""
    p = root / "data/jem-silver/2026-08-30/alias.parquet"
    datos = bytearray(p.read_bytes())
    datos[len(datos) // 2] ^= 0xFF
    p.write_bytes(bytes(datos))
    return "SHA-256 declarado no coincide"


def vigente_inexistente(root: Path) -> str:
    p = root / EDITIONS
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["vigente"] = "2027-01-01"
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return "no está declarada"


def js_a_un_id_inexistente(root: Path) -> str:
    """Un panel que escribe en un elemento que no existe se corta a la mitad."""
    p = root / "assets/js/duckdb-stats.js"
    p.write_text(p.read_text(encoding="utf-8").replace(
        "pon('#trzFragmentos'", "pon('#trzFragmentosQueNoExiste'"), encoding="utf-8")
    return "#trzFragmentosQueNoExiste, que no existe"


def panel_declarado_que_falta(root: Path) -> str:
    """editions.json asigna edición a una pestaña que el HTML no tiene."""
    p = root / EDITIONS
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["en_uso_por_la_interfaz"]["tab-inventado"] = "2026-08-30"
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return "tab-inventado"


def panel_con_edicion_inexistente(root: Path) -> str:
    p = root / EDITIONS
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["en_uso_por_la_interfaz"]["tab-fair"] = "2025-01-01"
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return "tab-fair» apunta a «2025-01-01"


def div_sobrante(root: Path) -> str:
    """El fallo exacto que atravesó todas las comprobaciones anteriores."""
    p = root / "estadisticas.html"
    p.write_text(p.read_text(encoding="utf-8").replace(
        "</section>\n</main>", "</div>\n</section>\n</main>", 1), encoding="utf-8")
    return "cierra <section>"


def div_sin_cerrar(root: Path) -> str:
    p = root / "caso.html"
    p.write_text(p.read_text(encoding="utf-8").replace(
        "<main>", '<main><div class="huerfano">', 1), encoding="utf-8")
    return "no se cierra"


def indice_sin_parametros(root: Path) -> str:
    """Sin k1/b/num_docs la página no puede puntuar: fallaría al usarse."""
    p = root / EDITIONS
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["ediciones"]["2026-08-30"]["indice"].pop("k1", None)
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return "falta «k1»"


def indice_sin_limitaciones(root: Path) -> str:
    """Un índice sin límites declarados se lee como un índice sin límites."""
    p = root / EDITIONS
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["ediciones"]["2026-08-30"]["indice"]["limitaciones"] = []
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return "no declara limitaciones"


def indice_descuadrado(root: Path) -> str:
    """num_docs debe coincidir con las filas del índice de fragmentos."""
    p = root / EDITIONS
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["ediciones"]["2026-08-30"]["indice"]["num_docs"] = 15908
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return "no coincide con las 18,141 filas"


def posting_alterado(root: Path) -> str:
    p = root / "data/jem-silver/2026-08-30/indice_posting.parquet"
    datos = bytearray(p.read_bytes())
    datos[len(datos) // 3] ^= 0xFF
    p.write_bytes(bytes(datos))
    return "SHA-256 declarado no coincide"


def _tiene_vectores(root: Path) -> bool:
    cfg = json.loads((root / EDITIONS).read_text(encoding="utf-8"))
    return bool(cfg["ediciones"].get("2026-08-30", {}).get("vectores"))


def vectores_sin_modelo(root: Path) -> str:
    """Sin saber de qué modelo salieron, los vectores no son consultables:
    la consulta caería en otro espacio y el resultado sería arbitrario."""
    p = root / EDITIONS
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["ediciones"]["2026-08-30"]["vectores"].pop("modelo", None)
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return "falta «modelo»"


def vectores_sin_limitaciones(root: Path) -> str:
    p = root / EDITIONS
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["ediciones"]["2026-08-30"]["vectores"]["limitaciones"] = []
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return "vectores: no declara limitaciones"


# Pruebas que sólo tienen sentido si la edición ya publicó ese artefacto.
# Saltarlas es honesto; fingir que pasan, no.
CONDICIONALES = {
    vectores_sin_modelo: _tiene_vectores,
    vectores_sin_limitaciones: _tiene_vectores,
}


def vuelve_al_cdn(root: Path) -> str:
    """Volver a un CDN reintroduce la dependencia que la Fase 6 quitó."""
    p = root / "estadisticas.html"
    p.write_text(p.read_text(encoding="utf-8").replace(
        'assets/vendor/echarts.min.js',
        'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js'),
        encoding="utf-8")
    return "depende de https://cdn.jsdelivr.net"


def diccionario_incompleto(root: Path) -> str:
    """Una columna sin descripción devuelve R5 a cero sin que nadie lo note."""
    p = root / "data/jem-silver/2026-08-30/datapackage.json"
    d = json.loads(p.read_text(encoding="utf-8"))
    for r in d["resources"]:
        if r["name"] == "voto":
            r["schema"]["fields"][0]["description"] = ""
    p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    return "sin descripción"


def diccionario_sin_una_tabla(root: Path) -> str:
    p = root / "data/jem-silver/2026-08-30/datapackage.json"
    d = json.loads(p.read_text(encoding="utf-8"))
    d["resources"] = [r for r in d["resources"] if r["name"] != "entidad"]
    p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    return "no describe: entidad"


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
    ("la edición declara filas de otro linaje",  edicion_con_filas_falsas),
    ("falta una tabla de la edición",            edicion_a_una_tabla_que_falta),
    ("un Parquet alterado tras publicarse",      parquet_alterado),
    ("«vigente» nombra una edición inexistente", vigente_inexistente),
    ("el JS escribe en un id inexistente",       js_a_un_id_inexistente),
    ("se declara una pestaña que no existe",     panel_declarado_que_falta),
    ("una pestaña con edición inexistente",      panel_con_edicion_inexistente),
    ("un </div> sobrante en el HTML",            div_sobrante),
    ("un <div> que no se cierra",                div_sin_cerrar),
    ("el índice sin parámetro de puntuación",    indice_sin_parametros),
    ("el índice sin limitaciones declaradas",    indice_sin_limitaciones),
    ("num_docs que no cuadra con el índice",     indice_descuadrado),
    ("el posting alterado tras publicarse",      posting_alterado),
    ("vectores sin el modelo declarado",         vectores_sin_modelo),
    ("vectores sin limitaciones declaradas",     vectores_sin_limitaciones),
    ("el sitio vuelve a depender de un CDN",     vuelve_al_cdn),
    ("una columna sin describir",                diccionario_incompleto),
    ("una tabla fuera del diccionario",          diccionario_sin_una_tabla),
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
            guarda = CONDICIONALES.get(romper)
            if guarda and not guarda(base):
                print(f"  --    {nombre}: no aplica todavía (falta el artefacto)")
                continue
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
