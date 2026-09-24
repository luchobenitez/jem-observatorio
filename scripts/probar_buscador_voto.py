"""El buscador de voto: ¿elige, filtra, cuenta bien y enlaza al documento?

Compara lo que la página muestra contra lo que da la base calculada aparte.
Que una tabla se pinte no dice nada si sus números no son los correctos: el
primer intento sumaba los votos por expediente y daba 1.241 donde los votos
distintos son 1.018, porque 217 resoluciones cuelgan de más de una causa.

Uso:
    python scripts/probar_buscador_voto.py .
"""
import http.server, socketserver, threading, urllib.request, socket
from functools import partial
from pathlib import Path
from playwright.sync_api import sync_playwright
import duckdb

import sys
RAIZ = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
PUERTO = 9001
import json
_ed = json.loads((RAIZ / "data/jem-silver/editions.json").read_text(encoding="utf-8"))
B = (RAIZ / "data" / "jem-silver" / _ed["vigente"]).as_posix()


class S(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


h = socketserver.TCPServer(("127.0.0.1", PUERTO), partial(S, directory=str(RAIZ)))
threading.Thread(target=h.serve_forever, daemon=True).start()
socket.setdefaulttimeout(45)

# La verdad, calculada aparte: la página tiene que dar esto.
c = duckdb.connect()
RIVAS = c.execute(f"""SELECT entidad_id, nombre, votos, ponente, adhesion, disidencia
  FROM '{B}/metrica_juez.parquet' WHERE nombre LIKE '%RIVAS%'""").fetchone()
esperado_exp = c.execute(f"""
  SELECT count(DISTINCT n.causa_id) FROM '{B}/voto.parquet' v
  JOIN '{B}/entidad_resuelta.parquet' er ON er.entidad_id = v.entidad_id
  JOIN '{B}/resolucion.parquet' r USING(resolucion_id)
  JOIN '{B}/vinculo.parquet' n ON n.document_id = r.document_id
  WHERE er.entidad_final = {RIVAS[0]}""").fetchone()[0]
esperado_pon = c.execute(f"""
  SELECT count(DISTINCT n.causa_id) FROM '{B}/voto.parquet' v
  JOIN '{B}/entidad_resuelta.parquet' er ON er.entidad_id = v.entidad_id
  JOIN '{B}/resolucion.parquet' r USING(resolucion_id)
  JOIN '{B}/vinculo.parquet' n ON n.document_id = r.document_id
  WHERE er.entidad_final = {RIVAS[0]} AND v.sentido = 'PONENTE'""").fetchone()[0]
print(f"  verdad: {RIVAS[1]} · {RIVAS[2]} votos · {esperado_exp} expedientes "
      f"· ponencia en {esperado_pon}")

fallos = []
with sync_playwright() as pw:
    nav = pw.chromium.launch()
    pag = nav.new_page()
    err = []
    pag.on("pageerror", lambda e: err.append(str(e)[:110]))
    pag.on("console", lambda m: err.append(m.text[:110]) if m.type == "error" else None)
    pag.goto(f"http://127.0.0.1:{PUERTO}/buscador-voto.html",
             wait_until="networkidle", timeout=90_000)
    pag.wait_for_timeout(9_000)

    print(f"\n  estado    : {pag.inner_text('#bvEstado')}")
    opciones = pag.eval_on_selector_all("#bvIntegrante option", "e=>e.length")
    print(f"  integrantes en la lista: {opciones - 1}")
    # El número no se fija a mano: sale de la misma tabla que alimenta el
    # selector. Escribirlo aquí obligaría a tocar la prueba cada vez que una
    # fusión o un descarte cambian el recuento, y una prueba que hay que
    # ajustar a mano acaba ajustándose sin mirar.
    esperados = c.execute(f"SELECT count(*) FROM '{B}/metrica_juez.parquet' WHERE votos > 0").fetchone()[0]
    if opciones - 1 != esperados:
        fallos.append(f"la lista tiene {opciones-1} integrantes y metrica_juez da {esperados}")

    # Ninguna opción puede ser una frase: seis de las siete disidencias del
    # corpus estaban atribuidas a «Para emitir mi» y similares, y esas
    # entidades aparecían en el selector como si fueran jueces.
    import re as _re
    nombres = pag.eval_on_selector_all("#bvIntegrante option", "e=>e.map(x=>x.textContent)")
    frases = [x for x in nombres[1:]
              if _re.search(r"(mi|un|que|para|ante|esta|y con|seguidamente)\s*·", x, _re.I)]
    if frases:
        fallos.append(f"el selector ofrece frases como integrantes: {frases[:3]}")

    # Elegir Rivas
    pag.select_option("#bvIntegrante", str(RIVAS[0]))
    pag.wait_for_timeout(7_000)
    resumen = pag.inner_text("#bvResumen")
    filas = pag.query_selector_all("#bvFilas tr")
    print(f"  tras elegir a Rivas: {resumen}")
    print(f"  filas pintadas: {len(filas)}")
    got = int(resumen.split()[0].replace(".", "").replace(",", ""))
    if got != esperado_exp:
        fallos.append(f"la página dice {got} expedientes y la base da {esperado_exp}")

    sentidos = pag.eval_on_selector_all("#bvSentido option", "e=>e.map(x=>x.textContent)")
    print(f"  sentidos  : {sentidos}")

    # Filtrar por ponencia
    pag.select_option("#bvSentido", "PONENTE")
    pag.wait_for_timeout(6_000)
    r2 = pag.inner_text("#bvResumen")
    got2 = int(r2.split()[0].replace(".", "").replace(",", ""))
    print(f"  sólo ponencia: {r2}")
    if got2 != esperado_pon:
        fallos.append(f"con ponencia da {got2} y la base da {esperado_pon}")

    # Disidencia: debe avisar
    pag.select_option("#bvSentido", "DISIDENCIA")
    pag.wait_for_timeout(5_000)
    aviso = pag.query_selector("#bvAvisoDisidencia")
    print(f"  aviso de disidencia visible: {aviso.is_visible() if aviso else False}")
    if not (aviso and aviso.is_visible()):
        fallos.append("elegir «Disidencia» no muestra el aviso: un cero se leería como "
                      "que nunca disintió")

    # Volver a todos y comprobar los enlaces
    pag.select_option("#bvSentido", "")
    pag.wait_for_timeout(6_000)
    enl = [a.get_attribute("href") for a in pag.query_selector_all("#bvFilas a")]
    hf = [u for u in enl if u and "huggingface.co" in u]
    print(f"\n  enlaces en la tabla: {len(enl)} · a Hugging Face: {len(hf)}")
    if not hf:
        fallos.append("ninguna fila enlaza al repositorio")
    else:
        op = urllib.request.build_opener()
        op.addheaders = [("User-Agent", "Mozilla/5.0")]
        for u in hf[:3]:
            try:
                r = op.open(u)
                print(f"    {r.status}  {urllib.request.unquote(u.rsplit('/',1)[-1])[:54]}")
            except Exception as e:
                fallos.append(f"enlace roto: {str(e)[:50]}")

    # El texto filtra
    pag.fill("#bvTexto", "Cárdenas")
    pag.wait_for_timeout(1_500)
    print(f"  filtrando «Cárdenas»: {pag.inner_text('#bvResumen')}")

    # La URL guarda la consulta
    print(f"  URL: {pag.url.split('/')[-1]}")
    if "integrante=" not in pag.url:
        fallos.append("la consulta no queda en la URL: no se puede citar")

    print(f"\n  errores de consola: {err[:3] or 'ninguno'}")
    if err:
        fallos.append(f"consola: {err[0]}")
    nav.close()
h.shutdown()

if fallos:
    print("\n  FALLA el buscador de voto:")
    for f in fallos:
        print(f"   - {f}")
    print()
    raise SystemExit(1)
print("\n  OK: el buscador de voto responde, sus recuentos coinciden con la base "
      "y sus filas enlazan al repositorio\n")
