#!/usr/bin/env python3
"""Carga la página en un navegador real y comprueba que de verdad se pinta.

Por qué hace falta
------------------
`validate_web6.py` comprueba que los archivos existan, que las filas declaradas
cuadren y que el HTML esté balanceado. Nada de eso detecta que el JavaScript
falle al ejecutarse.

Y falló. El commit que tradujo la cola de revisión añadió la llamada a
`pintarCola()` y no la función. La promesa se rechazaba, el `.catch()` pintaba
la reserva en inglés, y el sitio publicado mostró durante días
`SYSTEMIC_TRACEABILITY_FAILURE` en una página en castellano, con los cuatro
contadores de arriba en «—». Ningún validador lo vio porque todos miraban
archivos, no comportamiento.

Esta prueba abre la página, deja que corra, y falla si:

- la consola registra un error,
- un indicador se queda en «—» o «Cargando…»,
- aparece texto en inglés donde debería haber castellano,
- el corpus no coincide con la edición vigente declarada.

Uso:
    python scripts/probar_pagina.py .
"""

from __future__ import annotations

import http.server
import json
import re
import socketserver
import sys
import threading
from functools import partial
from pathlib import Path

from playwright.sync_api import sync_playwright

PUERTO = 8987

# Cadenas que no deben aparecer nunca en el texto visible. Son los códigos del
# informe original en inglés: si alguno asoma, es que una traducción falló o que
# una reserva se disparó.
INGLES = [
    "SYSTEMIC_", "_FAILURE", "P0_BLOCKER", "P1_URGENT", "P2_HIGH", "P0_CRITICAL",
    "REQUIRES_", "_MISSING_", "OCR_LOW_QUALITY", "EMPTY_OR_TRUNCATED",
]

# Indicadores que deben tener un valor. Un «—» acá significa que el JavaScript
# no llegó, que es justo lo que el validador de archivos no puede ver.
INDICADORES = [
    "indActions", "indCases", "indPonencias", "indVariantes",
    "colaResuelto", "colaMejorado", "colaVigente", "colaNoLoc",
    "colaDisResueltas", "colaDisVigentes",
    "fecComparables", "fecNumero", "fecFecha",
    "dictTotal", "dictLinks", "dictLinked", "dictSinCorresp",
    "qMissingCase", "qQuorum", "qEvidencePath",
    "kpiDocs", "kpiCausas",
]

VACIOS = {"", "—", "-", "Cargando…", "Cargando...", "…"}


class Silencioso(http.server.SimpleHTTPRequestHandler):
    """Sirve sin registrar: la página pide más de cien archivos y el log tapaba
    el resultado de la prueba, que es lo único que interesa leer."""

    def log_message(self, *a):  # noqa: D102
        pass


def servir(raiz: Path):
    handler = partial(Silencioso, directory=str(raiz))
    httpd = socketserver.TCPServer(("127.0.0.1", PUERTO), handler)
    httpd.allow_reuse_address = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def numero(texto: str):
    t = (texto or "").strip().replace(".", "").replace(",", "")
    return int(t.split()[0]) if t and t.split() and t.split()[0].isdigit() else None


def probar_filtro(pag, raiz: Path) -> list[str]:
    """El filtro de período debe cambiar todas las cifras, y las correctas.

    Es la comprobación que más falta hace: un filtro que recorta el 40 % de las
    resoluciones y se olvida de una pestaña no produce ningún error visible.
    Deja esa pestaña mostrando el corpus entero junto a otras recortadas, y el
    visitante no tiene forma de notarlo.
    """
    errores: list[str] = []
    datos = json.loads((raiz / "data" / "analysis" / "analisis-vigente.json")
                       .read_text(encoding="utf-8"))
    alcance = datos.get("filtro_periodo", {}).get("alcance")
    if not alcance:
        return ["analisis-vigente.json no declara el alcance del filtro de período"]

    control = pag.query_selector("[data-filtro-control] input")
    if control is None:
        return ["no hay control del filtro de período en la página"]

    # Las cifras que el filtro DEBE mover, con el valor que debe dejar.
    ESPERADO = {
        "kpiDocs": alcance["documentos"]["periodo"],
        "kpiCausas": alcance["causas"]["periodo"],
        "voteTotal": alcance["votos"]["periodo"],
        "voteDecisions": alcance["resoluciones"]["periodo"],
    }
    antes = {k: numero(pag.inner_text(f"#{k}")) for k in ESPERADO}

    control.check()
    pag.wait_for_timeout(7_000)

    for ident, quiere in ESPERADO.items():
        hay = numero(pag.inner_text(f"#{ident}"))
        if hay == antes[ident]:
            errores.append(f"#{ident} no cambió con el filtro puesto ({hay})")
        elif hay != quiere:
            errores.append(f"#{ident} da {hay} y el análisis declara {quiere}")

    if "periodo=1" not in pag.url:
        errores.append("el filtro no queda en la URL: el enlace no es compartible")

    # Las actuaciones del integrante no pueden cambiar: por construcción todos
    # sus votos están dentro de sus propias resoluciones. Si cambiaran, el
    # recorte estaría mal definido.
    propio = numero(pag.inner_text("#indActions"))
    control.uncheck()
    pag.wait_for_timeout(5_000)
    if numero(pag.inner_text("#indActions")) != propio:
        errores.append("las actuaciones del integrante cambian con el filtro; "
                       "deberían ser las mismas en los dos estados")
    if "periodo=1" in pag.url:
        errores.append("el filtro no se quita de la URL al apagarlo")
    return errores


def main() -> int:
    raiz = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    ed = json.loads((raiz / "data" / "jem-silver" / "editions.json")
                    .read_text(encoding="utf-8"))
    esperado = ed["ediciones"][ed["vigente"]]["tablas"]

    httpd = servir(raiz)
    errores: list[str] = []
    try:
        with sync_playwright() as pw:
            nav = pw.chromium.launch()
            pag = nav.new_page()
            consola: list[str] = []
            pag.on("console", lambda m: consola.append(f"{m.type}: {m.text}")
                   if m.type == "error" else None)
            pag.on("pageerror", lambda e: consola.append(f"pageerror: {e}"))

            pag.goto(f"http://127.0.0.1:{PUERTO}/estadisticas.html",
                     wait_until="networkidle", timeout=90_000)
            # Las pestañas ocultas no pintan hasta que se activan.
            for tab in pag.query_selector_all(".tab"):
                tab.click()
                pag.wait_for_timeout(400)
            pag.wait_for_timeout(3_000)

            for c in consola:
                errores.append(f"consola: {c[:160]}")

            for ident in INDICADORES:
                el = pag.query_selector(f"#{ident}")
                if el is None:
                    errores.append(f"falta el elemento #{ident}")
                    continue
                v = (el.inner_text() or "").strip()
                if v in VACIOS:
                    errores.append(f"#{ident} quedó sin valor ({v!r})")

            texto = pag.inner_text("body")
            for mal in INGLES:
                if mal in texto:
                    errores.append(f"texto en inglés visible: «{mal}»")

            # El corpus que muestra la página tiene que ser el de la edición
            # declarada. Si alguien reintroduce una reserva a otra edición, el
            # número cambia y esto lo caza.
            docs = pag.inner_text("#kpiDocs").replace(".", "").replace(",", "").strip()
            if docs.isdigit() and int(docs) != esperado["documento"]["filas"]:
                errores.append(
                    f"#kpiDocs muestra {int(docs):,} y la edición declara "
                    f"{esperado['documento']['filas']:,}")

            filas = pag.query_selector_all("#reviewRows tr")
            if len(filas) < 5:
                errores.append(f"la cola de revisión pintó {len(filas)} filas")

            errores += probar_filtro(pag, raiz)
            nav.close()
    finally:
        httpd.shutdown()

    if errores:
        print("\n  FALLA la página:")
        for e in errores:
            print(f"   - {e}")
        print(f"\n  {len(errores)} problemas\n")
        return 1
    print(f"\n  OK: la página se pinta · {len(INDICADORES)} indicadores con valor · "
          f"sin inglés visible · sin errores de consola")
    print("      el filtro de período mueve las cuatro cifras de control "
          "a los valores declarados\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
