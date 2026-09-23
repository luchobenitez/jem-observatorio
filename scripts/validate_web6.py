#!/usr/bin/env python3
"""Valida que el sitio sea desplegable y que lo que declara sea cierto.

Qué comprobaba antes
---------------------
Que existieran las seis páginas, el manifest del catálogo y los cinco Parquet de
`data/jem-silver/`. Esas comprobaciones siguen aquí.

Qué se le escapaba
-------------------
Todo lo que un archivo **declara** sobre otro. Tres fallos convivieron con el CI
en verde:

1. `data/portal/stats_config.json` declaraba siete rutas y **ninguna existía**
   (decía `data/document.parquet`; los Parquet están en `data/jem-silver/`).
   Ningún script lo leía, de modo que el error era invisible hasta que alguien
   fuera a conectarlo.
2. `data/catalog/manifest_summary.json` afirmaba «no existe
   data/jem-silver/document.parquet» mientras este mismo validador **exigía**
   que existiera. Dos afirmaciones contradictorias en el mismo repositorio.
3. Las seis páginas cargaban `assets/js/site.js`, un archivo de cero bytes.

Los tres son la misma clase de fallo: **una declaración que nadie contrasta con
la realidad**. Las comprobaciones nuevas cierran esa clase, no sólo los tres
casos.

Filosofía de los conjuntos ausentes
-------------------------------------
`stats_config.json` marca cada conjunto como `disponible` o `ausente`. Un
conjunto ausente no es un error: es una declaración de que todavía no se
publicó, y se exige que venga con su motivo. Pero si aparece en el disco, el
validador **también falla**, porque la declaración quedó atrás. Es el mismo
principio que gobierna el resto del proyecto: lo que no se puede determinar se
declara, y la declaración se mantiene al día.

Uso:
    python scripts/validate_web6.py .
    python scripts/validate_web6.py . --allow-missing-parquet
    python scripts/validate_web6.py . --verbose
"""

from pathlib import Path
import argparse, json, re, sys

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
STATS_CONFIG = "data/portal/stats_config.json"
MANIFEST_SUMMARY = "data/catalog/manifest_summary.json"
EDITIONS = "data/jem-silver/editions.json"

# src/href locales en el HTML. Se excluye todo lo que salga a la red.
REF_HTML = re.compile(r'(?:src|href)\s*=\s*"([^"]+)"', re.I)
EXTERNO = re.compile(r"^(?:https?:|//|data:|mailto:|#|javascript:)", re.I)


def filas_parquet(ruta: Path):
    """Número de filas, o None si no se puede leer sin pyarrow."""
    try:
        import pyarrow.parquet as pq
    except ImportError:
        return None
    try:
        return pq.ParquetFile(ruta).metadata.num_rows
    except Exception:
        return None


def revisar_stats_config(root: Path, errores: list, avisos: list, verbose: bool):
    ruta = root / STATS_CONFIG
    if not ruta.is_file():
        avisos.append(f"No existe {STATS_CONFIG}; no se validan rutas declaradas")
        return
    try:
        cfg = json.loads(ruta.read_text(encoding="utf-8"))
    except Exception as e:
        errores.append(f"{STATS_CONFIG} inválido: {e}")
        return

    declarados = 0
    for bloque, entradas in cfg.items():
        if bloque.startswith("_") or not isinstance(entradas, dict):
            continue
        for nombre, spec in entradas.items():
            if not isinstance(spec, dict) or "ruta" not in spec:
                continue
            declarados += 1
            rel = spec["ruta"]
            estado = spec.get("estado", "disponible")
            destino = root / rel
            etiqueta = f"{STATS_CONFIG} → {bloque}.{nombre}"

            if estado == "disponible":
                if not destino.is_file():
                    errores.append(f"{etiqueta}: declara «disponible» pero no existe {rel}")
                    continue
                esperadas = spec.get("filas")
                if esperadas is not None and rel.endswith(".parquet"):
                    reales = filas_parquet(destino)
                    if reales is None:
                        avisos.append(f"{etiqueta}: no se pudo contar filas (falta pyarrow)")
                    elif reales != esperadas:
                        errores.append(
                            f"{etiqueta}: declara {esperadas:,} filas y {rel} tiene {reales:,}")
                    elif verbose:
                        print(f"  ok  {etiqueta}: {reales:,} filas")
                elif verbose:
                    print(f"  ok  {etiqueta}: {rel}")
            elif estado == "ausente":
                if destino.is_file():
                    errores.append(
                        f"{etiqueta}: declara «ausente» pero {rel} existe. "
                        "Promover a «disponible» y declarar sus filas.")
                elif not spec.get("motivo"):
                    errores.append(f"{etiqueta}: declara «ausente» sin «motivo»")
                elif verbose:
                    print(f"  ok  {etiqueta}: ausente, declarado")
            else:
                errores.append(f"{etiqueta}: estado desconocido «{estado}»")

    if not declarados:
        avisos.append(f"{STATS_CONFIG} no declara ninguna ruta con el formato esperado")
    elif verbose:
        print(f"  {declarados} rutas declaradas revisadas")


def sha256_archivo(ruta: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with ruta.open("rb") as fh:
        for trozo in iter(lambda: fh.read(1 << 20), b""):
            h.update(trozo)
    return h.hexdigest()


def revisar_editions(root: Path, errores: list, avisos: list, verbose: bool):
    """Cada edición de la capa Silver debe existir tal como se declara.

    Las ediciones conviven fechadas y ninguna sobrescribe a la anterior, así que
    lo único que impide que una se pudra en silencio es comprobarla: filas
    declaradas contra filas reales, y SHA-256 declarado contra el archivo.
    """
    ruta = root / EDITIONS
    if not ruta.is_file():
        avisos.append(f"No existe {EDITIONS}; no se validan las ediciones Silver")
        return
    try:
        cfg = json.loads(ruta.read_text(encoding="utf-8"))
    except Exception as e:
        errores.append(f"{EDITIONS} inválido: {e}")
        return

    ediciones = cfg.get("ediciones", {})
    if not ediciones:
        errores.append(f"{EDITIONS} no declara ninguna edición")
        return

    # «en_uso_por_la_interfaz» puede ser una cadena o un mapa pestaña -> edición:
    # la página consulta dos ediciones a la vez desde la Fase 2, y un solo valor
    # no podría decirlo sin mentir.
    for clave in ("vigente", "en_uso_por_la_interfaz"):
        valor = cfg.get(clave)
        if isinstance(valor, dict):
            for panel, ed in valor.items():
                if ed not in ediciones:
                    errores.append(
                        f"{EDITIONS}: «{clave}.{panel}» apunta a «{ed}», que no está declarada")
                elif not (root / "estadisticas.html").read_text(
                        encoding="utf-8", errors="replace").count(f'id="{panel}"'):
                    errores.append(
                        f"{EDITIONS}: «{clave}» declara «{panel}», que no existe en estadisticas.html")
        elif valor and valor not in ediciones:
            errores.append(f"{EDITIONS}: «{clave}» apunta a «{valor}», que no está declarada")

    for nombre, ed in ediciones.items():
        base = ed.get("base", "")
        tablas = dict(ed.get("tablas", {}))
        # El índice BM25 se declara aparte porque lo genera otro script, pero
        # sus archivos se comprueban igual: filas y SHA-256 contra el disco.
        # Los vectores semánticos imponen un coste de descarga grande y
        # desigual: publicarlos sin decir de qué modelo salen, con qué
        # dimensión y con qué límites sería pedir que se les crea.
        vectores = ed.get("vectores")
        if vectores:
            tablas.update(vectores.get("tablas", {}))
            for clave in ("modelo", "dimensiones", "prefijo_consulta", "cuantizacion"):
                if not vectores.get(clave):
                    errores.append(
                        f"{EDITIONS} → {nombre}.vectores: falta «{clave}», sin lo cual "
                        "la consulta no puede caer en el mismo espacio vectorial")
            if not vectores.get("limitaciones"):
                errores.append(f"{EDITIONS} → {nombre}.vectores: no declara limitaciones")

        indice = ed.get("indice")
        if indice:
            tablas.update(indice.get("tablas", {}))
            for clave in ("num_docs", "longitud_media", "k1", "b"):
                if indice.get(clave) is None:
                    errores.append(
                        f"{EDITIONS} → {nombre}.indice: falta «{clave}», que la página "
                        "necesita para puntuar")
            if not indice.get("limitaciones"):
                errores.append(
                    f"{EDITIONS} → {nombre}.indice: no declara limitaciones")
            docs = tablas.get("indice_fragmento", {}).get("filas")
            if docs is not None and indice.get("num_docs") != docs:
                errores.append(
                    f"{EDITIONS} → {nombre}.indice: num_docs={indice.get('num_docs'):,} "
                    f"no coincide con las {docs:,} filas de indice_fragmento")
        if not tablas:
            errores.append(f"{EDITIONS} → {nombre}: no declara tablas")
            continue
        for tabla, spec in tablas.items():
            etiqueta = f"{EDITIONS} → {nombre}.{tabla}"
            destino = root / base / spec.get("archivo", "")
            if not destino.is_file():
                errores.append(f"{etiqueta}: no existe {base}{spec.get('archivo')}")
                continue
            esperadas = spec.get("filas")
            reales = filas_parquet(destino)
            if esperadas is not None and reales is not None and reales != esperadas:
                errores.append(
                    f"{etiqueta}: declara {esperadas:,} filas y el archivo tiene {reales:,}")
            digest = spec.get("sha256")
            if digest and sha256_archivo(destino) != digest:
                errores.append(
                    f"{etiqueta}: el SHA-256 declarado no coincide con el archivo. "
                    "Regenerar la edición o corregir la declaración.")
        if verbose:
            filas = sum(t.get("filas") or 0 for t in tablas.values())
            print(f"  ok  {EDITIONS} → {nombre}: {len(tablas)} tablas, {filas:,} filas")


def revisar_coherencia_resumen(root: Path, errores: list, verbose: bool):
    """El resumen del catálogo no puede negar lo que el validador exige."""
    ruta = root / MANIFEST_SUMMARY
    if not ruta.is_file():
        return
    try:
        resumen = json.loads(ruta.read_text(encoding="utf-8"))
    except Exception as e:
        errores.append(f"{MANIFEST_SUMMARY} inválido: {e}")
        return

    error_silver = resumen.get("silver_load_error")
    silver = root / "data/jem-silver/document.parquet"
    if error_silver and silver.is_file():
        errores.append(
            f"{MANIFEST_SUMMARY}: dice «{error_silver}» pero el archivo existe. "
            "Ejecutar scripts/actualizar_resumen_silver.py")
    elif verbose and silver.is_file():
        print("  ok  manifest_summary coherente con la capa Silver")

    filas = resumen.get("silver_rows")
    if filas is not None and silver.is_file():
        reales = filas_parquet(silver)
        if reales is not None and reales != filas:
            errores.append(
                f"{MANIFEST_SUMMARY}: declara silver_rows={filas:,} y "
                f"document.parquet tiene {reales:,}")


def revisar_referencias_html(root: Path, errores: list, verbose: bool):
    """Ningún HTML debe apuntar a un recurso local inexistente o vacío."""
    revisadas = 0
    for pagina in REQUIRED_PAGES:
        p = root / pagina
        if not p.is_file():
            continue
        for ref in REF_HTML.findall(p.read_text(encoding="utf-8", errors="replace")):
            if EXTERNO.match(ref) or ref.endswith(".html"):
                continue
            destino = root / ref.split("?", 1)[0].split("#", 1)[0]
            revisadas += 1
            if not destino.is_file():
                errores.append(f"{pagina} referencia {ref}, que no existe")
            elif destino.stat().st_size == 0:
                errores.append(f"{pagina} referencia {ref}, que está vacío (0 bytes)")
    if verbose:
        print(f"  {revisadas} referencias locales del HTML revisadas")


ETIQUETAS_VACIAS = {"br", "hr", "img", "input", "meta", "link", "source", "col",
                    "area", "base", "embed", "param", "track", "wbr"}


def revisar_html_balanceado(root: Path, errores: list, verbose: bool):
    """Las etiquetas de bloque deben abrir y cerrar donde corresponde.

    Se añadió después de que un `</div>` sobrante en `estadisticas.html`
    atravesara todas las demás comprobaciones: el validador daba verde sobre un
    HTML que cerraba `<section>` con `</div>`. El navegador no protesta —repara
    el árbol a su manera— y el resultado es un panel que se dibuja fuera de su
    sitio sin que nada lo señale.
    """
    from html.parser import HTMLParser

    class Balance(HTMLParser):
        def __init__(self):
            super().__init__()
            self.pila: list[tuple[str, int]] = []
            self.fallos: list[str] = []

        def handle_starttag(self, tag, attrs):
            if tag not in ETIQUETAS_VACIAS:
                self.pila.append((tag, self.getpos()[0]))

        def handle_startendtag(self, tag, attrs):
            pass

        def handle_endtag(self, tag):
            if tag in ETIQUETAS_VACIAS:
                return
            if not self.pila:
                self.fallos.append(f"</{tag}> sin apertura en la línea {self.getpos()[0]}")
                return
            abierto, linea = self.pila.pop()
            if abierto != tag:
                self.fallos.append(
                    f"</{tag}> en la línea {self.getpos()[0]} cierra "
                    f"<{abierto}>, abierto en la línea {linea}")

    for pagina in REQUIRED_PAGES:
        p = root / pagina
        if not p.is_file():
            continue
        b = Balance()
        b.feed(p.read_text(encoding="utf-8", errors="replace"))
        for f in b.fallos[:3]:
            errores.append(f"{pagina}: {f}")
        for tag, linea in b.pila[:3]:
            errores.append(f"{pagina}: <{tag}> abierto en la línea {linea} no se cierra")
    if verbose and not errores:
        print(f"  {len(REQUIRED_PAGES)} páginas con etiquetas balanceadas")


def revisar_ids_js(root: Path, errores: list, verbose: bool):
    """Ningún JavaScript debe escribir en un elemento que no existe.

    Es la misma clase de fallo que el resto del validador persigue —algo que se
    declara y nadie contrasta— pero con la peor consecuencia posible en esta
    página: `textContent` sobre `null` lanza, y una excepción a mitad de un
    panel deja los demás sin llenar. El lector ve guiones y no sabe si el dato
    falta o el código falló.

    Se buscan los selectores literales `'#id'` que el JS pasa a sus ayudantes.
    No cubre ids construidos dinámicamente; se prefiere una comprobación parcial
    y cierta a ninguna.
    """
    ids_html: set[str] = set()
    for pagina in REQUIRED_PAGES:
        p = root / pagina
        if p.is_file():
            ids_html |= set(re.findall(r'id="([^"]+)"',
                                       p.read_text(encoding="utf-8", errors="replace")))

    # El literal debe cerrar el argumento: `$('#tab-' + x)` construye el id en
    # tiempo de ejecución y no se puede comprobar así. Exigir la coma o el
    # paréntesis evita denunciar el prefijo de una concatenación.
    patron = re.compile(r"""(?:\$|pon)\(\s*['"]#([A-Za-z][\w-]*)['"]\s*[,)]""")
    revisados = 0
    for js in sorted((root / "assets" / "js").glob("*.js")):
        texto = js.read_text(encoding="utf-8", errors="replace")
        for ident in sorted(set(patron.findall(texto))):
            revisados += 1
            if ident not in ids_html:
                errores.append(
                    f"assets/js/{js.name} escribe en #{ident}, que no existe en ningún HTML")
    if verbose:
        print(f"  {revisados} identificadores del JS revisados contra el HTML")


def main():
    ap=argparse.ArgumentParser(description=__doc__,
                               formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--allow-missing-parquet", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    args=ap.parse_args()
    root=Path(args.root).resolve()
    errors=[]
    avisos=[]

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

    revisar_stats_config(root, errors, avisos, args.verbose)
    revisar_editions(root, errors, avisos, args.verbose)
    revisar_coherencia_resumen(root, errors, args.verbose)
    revisar_referencias_html(root, errors, args.verbose)
    revisar_html_balanceado(root, errors, args.verbose)
    revisar_ids_js(root, errors, args.verbose)

    if errors:
        print("ERROR")
        for e in errors: print(" -",e)
        return 1

    print("OK: Web6 listo")
    for a in avisos: print(" ~",a)
    if missing:
        print("Advertencia: faltan Parquet (permitido por flag):", ", ".join(missing))
    return 0

if __name__=="__main__":
    raise SystemExit(main())
