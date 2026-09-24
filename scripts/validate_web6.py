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

# Las tablas que el portal necesita para funcionar, dentro de la edición
# vigente. Antes esta lista nombraba los parquet sueltos del pipeline anterior
# —`document.parquet`, `party.parquet`— que vivían en la raíz de
# `data/jem-silver/`. Exigirlos obligaba a conservar el corpus viejo al lado del
# nuevo, que es justo lo que hacía que la primera pestaña contara 3.964
# documentos y la siguiente 4.627.
REQUIRED_PARQUETS = [
    "documento.parquet",
    "causa.parquet",
    "voto.parquet",
    "resolucion.parquet",
    "entidad.parquet",
]
REQUIRED_CATALOG = [
    "document_public.parquet",
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

    # El portal consulta UNA SOLA edición.
    #
    # Hasta el 24/09/2026 `en_uso_por_la_interfaz` era un mapa de pestaña a
    # edición, y las pestañas heredadas apuntaban a la anterior: la primera
    # contaba 3.964 documentos y la siguiente 4.627, sin que nada lo explicara.
    # El mapa se eliminó, y esta comprobación impide que vuelva: repartir
    # pestañas entre ediciones es indistinguible, para el visitante, de publicar
    # dos cifras distintas del mismo hecho.
    if cfg.get("en_uso_por_la_interfaz") is not None:
        errores.append(
            f"{EDITIONS}: «en_uso_por_la_interfaz» reparte pestañas entre ediciones. "
            "El portal consulta una sola: la declarada en «vigente»")

    vigente = cfg.get("vigente")
    if not vigente:
        errores.append(f"{EDITIONS}: no declara una edición «vigente»")
    elif vigente not in ediciones:
        errores.append(f"{EDITIONS}: «vigente» apunta a «{vigente}», que no está declarada")

    # Las ediciones que no son la vigente son procedencia histórica y deben
    # decirlo, para que nadie las tome por datos publicados.
    for nombre, ed in ediciones.items():
        esperado = "vigente" if nombre == vigente else "historica"
        if ed.get("estado") != esperado:
            errores.append(
                f"{EDITIONS} → {nombre}: estado «{ed.get('estado')}», se esperaba «{esperado}»")

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
    # El catálogo del portal sustituyó a `data/jem-silver/document.parquet`,
    # que era del pipeline anterior. Apuntando al archivo viejo, estas dos
    # comprobaciones se saltaban en silencio en cuanto se retiró.
    silver = root / "data/catalog/document_public.parquet"
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
            # Una referencia que empieza por «/» es absoluta respecto de la
            # raíz del sitio, no del sistema de archivos. Sin quitar la barra,
            # `root / "/favicon.ico"` descarta `root` y busca en la raíz del
            # disco: el archivo existe y la comprobación lo declara ausente.
            limpio = ref.split("?", 1)[0].split("#", 1)[0].lstrip("/")
            destino = root / limpio
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


CDN = re.compile(r"https?://(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com"
                 r"|ajax\.googleapis\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)",
                 re.I)


def revisar_sin_cdn(root: Path, errores: list, verbose: bool):
    """El portal no debe depender de un CDN para funcionar.

    Un archivo que necesita a un tercero para poder leerse no está preservado, y
    cada petición a un CDN le dice a ese tercero qué se consulta y desde dónde.
    En un sitio sobre procesos disciplinarios a personas identificables eso no
    es un detalle.

    Se excluye `assets/vendor/`, que es código de terceros alojado aquí
    precisamente para no depender del CDN; el módulo de DuckDB conserva dentro
    una función que arma direcciones de jsDelivr y que no se llama.
    """
    revisados = 0
    for p in sorted(root.glob("*.html")) + sorted((root / "assets" / "js").glob("*.js")):
        revisados += 1
        texto = p.read_text(encoding="utf-8", errors="replace")
        for m in set(CDN.findall(texto)):
            errores.append(
                f"{p.relative_to(root).as_posix()} depende de {m}. "
                "Alojar la biblioteca en assets/vendor/.")
    if verbose:
        print(f"  {revisados} archivos propios sin dependencias de CDN")


def revisar_diccionario(root: Path, errores: list, avisos: list, verbose: bool):
    """El diccionario de datos debe cubrir cada columna publicada.

    Es el indicador FAIR `R5`, que valía cero. Un diccionario que pierde
    cobertura en silencio cuando aparece una columna nueva vuelve a valer cero
    sin que nadie lo note, y la puntuación seguiría diciendo lo contrario.
    """
    try:
        cfg = json.loads((root / EDITIONS).read_text(encoding="utf-8"))
    except Exception:
        return
    edicion = cfg.get("vigente")
    base = (cfg.get("ediciones", {}).get(edicion) or {}).get("base", "")
    dp = root / base / "datapackage.json"
    if not dp.is_file():
        avisos.append(f"No existe {base}datapackage.json; no se valida el diccionario")
        return
    try:
        paquete = json.loads(dp.read_text(encoding="utf-8"))
    except Exception as e:
        errores.append(f"{base}datapackage.json inválido: {e}")
        return

    try:
        import pyarrow.parquet as pq
    except ImportError:
        avisos.append("Sin pyarrow no se valida la cobertura del diccionario")
        return

    descritos = {r["name"]: {c["name"]: c.get("description", "")
                             for c in r.get("schema", {}).get("fields", [])}
                 for r in paquete.get("resources", [])}
    faltan_tablas, faltan_campos = [], []
    for p in sorted((root / base).glob("*.parquet")):
        if p.stem not in descritos:
            faltan_tablas.append(p.stem)
            continue
        for nombre in pq.ParquetFile(p).schema_arrow.names:
            if not descritos[p.stem].get(nombre):
                faltan_campos.append(f"{p.stem}.{nombre}")
    if faltan_tablas:
        errores.append(f"{base}datapackage.json no describe: "
                       + ", ".join(faltan_tablas[:6]))
    if faltan_campos:
        errores.append(f"{base}datapackage.json deja {len(faltan_campos)} columnas sin "
                       f"descripción: " + ", ".join(faltan_campos[:6]))
    if verbose and not faltan_tablas and not faltan_campos:
        n = sum(len(v) for v in descritos.values())
        print(f"  {len(descritos)} tablas y {n} columnas descritas en el diccionario")


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

    # La edición se resuelve del propio editions.json en vez de fijarse acá:
    # una ruta con la fecha escrita a mano caducaría en la siguiente edición y
    # nadie se enteraría hasta que el portal dejara de encontrar sus tablas.
    try:
        ed = json.loads((root/"data/jem-silver/editions.json").read_text(encoding="utf-8"))
        vigente = ed.get("vigente", "")
    except Exception:
        vigente = ""

    # El catálogo que consume documentos.html, dentro de la edición vigente.
    # Antes se exigía `data/catalog/documents_manifest.json`, del pipeline de
    # agosto: 3.964 documentos, ninguno con enlace público. Era la reserva de
    # la página, y exigirla obligaba a conservarla.
    catalogo = root/"data/jem-silver"/vigente/"catalogo.json" if vigente else None
    if catalogo is None or not catalogo.is_file():
        errors.append(f"Falta el catálogo de la edición vigente: {catalogo}")
    else:
        try:
            obj=json.loads(catalogo.read_text(encoding="utf-8"))
            docs=obj if isinstance(obj,list) else obj.get("documentos") or obj.get("documents") or []
            if not docs:
                errors.append("catalogo.json no contiene documentos")
            else:
                sin=[d for d in docs if not (d.get("view_url") or d.get("download_url"))]
                if sin:
                    errors.append(
                        f"catalogo.json: {len(sin):,} de {len(docs):,} documentos sin enlace "
                        "público. La página los mostraría como «pendiente de sincronización»")
        except Exception as e:
            errors.append(f"catalogo.json inválido: {e}")

    base_ed = root/"data/jem-silver"/vigente if vigente else root/"data/jem-silver"
    missing=[x for x in REQUIRED_PARQUETS if not (base_ed/x).is_file()]
    if missing and not args.allow_missing_parquet:
        errors.append(f"Faltan Parquet de la edición vigente en {base_ed.name}/: "
                      +", ".join(missing))

    faltan_cat=[x for x in REQUIRED_CATALOG if not (root/"data/catalog"/x).is_file()]
    if faltan_cat and not args.allow_missing_parquet:
        errors.append("Falta el catálogo del portal en data/catalog/: "+", ".join(faltan_cat)
                      +". Sin él, la pestaña del corpus no tiene de dónde leer")

    revisar_stats_config(root, errors, avisos, args.verbose)
    revisar_editions(root, errors, avisos, args.verbose)
    revisar_coherencia_resumen(root, errors, args.verbose)
    revisar_referencias_html(root, errors, args.verbose)
    revisar_html_balanceado(root, errors, args.verbose)
    revisar_ids_js(root, errors, args.verbose)
    revisar_sin_cdn(root, errors, args.verbose)
    revisar_diccionario(root, errors, avisos, args.verbose)

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
