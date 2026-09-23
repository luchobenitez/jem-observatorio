# Plan por fases — del sitio actual a búsqueda recuperable sobre el archivo

Fecha: 2026-09-22 · Corte de datos: `corte-2026-08-30`
· `manifest.sha256` `5ec45cc3fd023ebe…`

Documento de trabajo. Cada fase es entregable por separado y verificable sola.

---

## 0. Qué hay hoy, sin adornos

La arquitectura es buena y hay que conservarla: sitio estático, sin framework,
GPL-3.0, GitHub Pages con Actions, DuckDB-WASM consultando Parquet por rangos
HTTP, documentos en HuggingFace. Todo libre, sin servidor, sin coste corriente.
Es exactamente la base que hace falta para lo que sigue.

Tres cosas están rotas ahora mismo:

| Hallazgo | Comprobación |
|---|---|
| **7 de 7 rutas de `data/portal/stats_config.json` no existen** | Declara `data/document.parquet`; los Parquet viven en `data/jem-silver/` |
| **`data/catalog/manifest_summary.json` está desactualizado** | Dice `"silver_load_error": "no existe data/jem-silver/document.parquet"`, y sí existe |
| **`assets/js/site.js` está vacío** | 0 bytes, cargado por las páginas |

Lo grave no es cada fallo: es que **`validate_web6.py` corre en CI y ninguno lo
detiene**. El validador nombra «parquet» siete veces y no comprueba que ningún
archivo exista. El CI está en verde sobre una página desconectada de sus datos.

### El problema de fondo: dos linajes de datos

En el repositorio conviven hoy dos mediciones del mismo archivo que no coinciden:

| | Parquet en `data/jem-silver/` | Corte vigente |
|---|---:|---:|
| Documentos únicos | 3.964 | **4.627** |
| Causas | 1.669 | **2.908** |
| Filas de voto | 8.355 | **9.956** |
| Votos con página citable | 0 | **9.955** |

No es que unos números sean falsos y otros verdaderos: son **pipelines distintos
sobre corpus distintos**. El de 2026-08-24 no incluía la colección «orden del
día» ni el anclaje por página. Pero si la página muestra 4.627 en un panel y
consulta 3.964 en otro, el sitio se contradice a sí mismo, y eso es peor que
cualquiera de las dos cifras.

**Esto se resuelve en la Fase 1 y bloquea todo lo demás.** No tiene sentido
construir búsqueda sobre datos cuya identidad no está decidida.

### Lo ya hecho hoy

`scripts/exportar_observatorio.py` (en `jem-full`) genera desde la base:

- `data/analysis/jem_full_20260830.json` — snapshot del corte vigente, en el
  mismo formato que el de agosto, **sin sustituirlo**.
- `data/analysis/comparacion_snapshots.json` — qué dejó de ser
  `NO_DETERMINABLE` (6 métricas) y qué lo sigue siendo (7).

Ninguna cifra está transcrita: todas se consultan a la base en cada ejecución.
La versión preliminar de ese script llevaba cuatro valores escritos a mano y
**dos estaban mal** (decía 183/166 ocurrencias del patrón textual, son 182/165;
decía 98,0 % de votos citables, es 99,99 %). Quedó como recordatorio de por qué
el sitio no debe llevar cifras a mano en el HTML.

---

## Fase 0 — Reparar y blindar (2–4 h)

Antes de añadir nada. Es el trabajo de mejor relación valor/esfuerzo del plan.

1. Corregir las rutas de `stats_config.json`.
2. Regenerar `manifest_summary.json`.
3. Resolver `site.js`: darle contenido o quitar la etiqueta que lo carga.
4. **Extender `validate_web6.py`** para que falle cuando una ruta declarada en
   cualquier `*.json` de configuración no exista en el árbol desplegado.

El punto 4 es el que importa. Un validador que no detiene el despliegue de una
página rota no está validando: está dando una garantía falsa.

**Verificación:** introducir a propósito una ruta inexistente y comprobar que el
workflow falla. Un validador sin prueba negativa no está probado.

---

## Fase 1 — Un linaje, fechado y explícito — **hecha**

Publicados los Parquet del corte vigente **junto a** los de agosto, no encima.

```
data/jem-silver/
  *.parquet          edición 2026-08-24, intacta      5 tablas ·  13.573 filas
  2026-08-30/        edición del corte vigente       13 tablas ·  96.757 filas · 11,7 MB
  editions.json      qué hay en cada una, de dónde sale y qué la limita
```

Genera `scripts/exportar_parquet.py` en `jem-full`. Las 13 tablas coinciden fila
a fila con su tabla de origen en SQLite: **13 comprobaciones, 0 discrepancias**.

### La unidad citable no es la página

El plan preveía una tabla `pagina`. Medirlo lo desmintió: **las páginas existen
sólo en PDF**. De 4.620 documentos con texto, 2.387 tienen páginas y 2.233 no
—2.053 son Word y 180 son actas en JSON—. Un `.docx` no tiene paginación hasta
que se renderiza: la página no falta, **no existe**.

Un índice sobre `pagina` habría buscado en el 51,7 % del corpus sin avisarlo.
Por eso se publica `fragmento`, con `tipo_ancla` explícito:

| tipo_ancla | fragmentos | documentos | texto |
|---|---:|---:|---:|
| `PAGINA` | 15.908 | 2.387 | 30,0 MB |
| `DOCUMENTO` | 2.233 | 2.233 | 23,7 MB |

Lo que esto **no** compromete: el 100 % de los votos y de las resoluciones sale
de documentos paginados, de modo que la cita por página sigue intacta donde el
proyecto la usa como garantía.

### Qué custodia el validador

`editions.json` declara por tabla su archivo, sus filas y su **SHA-256**. El
validador comprueba las tres cosas, más que `vigente` y
`en_uso_por_la_interfaz` nombren ediciones que existan.

Que esas dos difieran hoy —vigente `2026-08-30`, interfaz `2026-08-24`— no es un
error: es el trabajo de la Fase 2, **declarado en vez de disimulado**.

**Verificado:** 14 pruebas negativas, 0 fallos. Entre ellas, alterar un byte de
un Parquet publicado: el SHA-256 declarado lo detecta.

---

## Fase 2 — Estadísticas conectadas a la base real — **hecha**

Las cuatro pestañas heredadas se conservan intactas y se suman cuatro que el
corte vigente hace posibles por primera vez:

| Pestaña | Qué muestra |
|---|---|
| **Trazabilidad** | 18.141 fragmentos por tipo de ancla, banda de confianza y motor |
| **Quórum y decisión** | 655 de 1.670 resoluciones con quórum incompleto por extracción |
| **Procedencia** | 178 de 4.627 documentos con URL persistente; 1.229 comparten una |
| **Índice FAIR** | las ocho dimensiones en radar y en barras, sin cifra agregada |

Todo consulta la edición `2026-08-30` con DuckDB-WASM, **reusando la conexión ya
abierta**: una segunda instancia habría significado otro worker y otra copia del
WASM en memoria.

Las tres reglas se cumplieron:

1. **`NO_DETERMINABLE` es una categoría dibujada**, con color propio y junto a
   `sin_calcular` y `sin_score`. En un gráfico la tentación de omitirla es
   grande, porque una barra ausente se lee como «ninguno» y nadie la cuestiona.
2. **Banner permanente** encabezando la página: `0` de `25.293` campos con
   revisión humana. Los dos números se consultan, de modo que el día que alguien
   valide, el banner cambia solo.
3. **Ninguna cifra derivada escrita en el HTML.** Las tres que se me colaron al
   redactar —1.229 URL compartidas, 7 disidencias, 7,5 puntos de amplitud— se
   convirtieron en consultas. La de las 1.229 **reproduce sola** el valor que
   estaba transcrito.

### Verificado

- **16 consultas SQL** ejecutadas contra los Parquet reales antes de escribir el
  JavaScript: 0 fallos.
- **26 de 26 identificadores** de los paneles nuevos existen en el HTML,
  comprobado en ambos sentidos.
- `verificar_cifras.py --sitio` alcanza ahora el HTML del sitio: **45
  afirmaciones, 0 discrepancias**.
- **19 pruebas negativas**, 0 fallos.

Dos comprobaciones nuevas nacieron de fallos propios de esta fase: que el
JavaScript no escriba en un `id` inexistente, y que el HTML tenga sus etiquetas
balanceadas. La segunda se añadió **después** de que un `</div>` sobrante
atravesara todas las demás: el validador daba verde sobre un HTML que cerraba
`<section>` con `</div>`.

---

## Fase 3 — Búsqueda léxica sobre el texto — **hecha**

El plan decía «cargar `fts` en el navegador, sin dependencia nueva». **No
sirve**: `PRAGMA create_fts_index` *materializa* el índice en tablas, de modo
que el cliente tendría que descargar los 53,7 MB de texto y construirlo en cada
visita. `fts` está pensada para una base local persistente, no para una sesión
sin estado sobre HTTP.

La extensión sí se usa, **fuera de línea**, para no reimplementar el tokenizador
ni el stemmer Snowball. Lo que viaja son cuatro Parquet:

| archivo | filas | tamaño |
|---|---:|---:|
| `indice_posting` | 2.781.227 | 6,4 MB |
| `indice_forma` | 116.418 | 1,2 MB |
| `indice_termino` | 100.643 | 0,8 MB |
| `indice_fragmento` | 18.141 | 0,1 MB |
| | | **8,5 MB** |

El posting va **ordenado por `termid` y en grupos de 40.000 filas**: DuckDB lee
por rangos HTTP y descarga unos cientos de kilobytes por consulta, no los 6,4 MB.
BM25 se calcula con SQL corriente y `k1`/`b` se leen de `editions.json`, así que
reconstruir el índice con otros parámetros no obliga a tocar el JavaScript.

### Las tildes, decididas midiendo

El stemmer español necesita el acento: `stem('destitución')` da `destitu`, pero
`stem('destitucion')` da `destitucion`. Sobre seis familias de palabras,
conservar la tilde agrupa mejor —«destitución/destituciones/destituir» cae en un
grupo en vez de dos—.

Aun así el índice **quita** las tildes, porque este corpus viene de OCR y sus
acentos no son fiables: un índice sensible a la tilde no encontraría el
documento mal reconocido, que es justo el más difícil de hallar por otros
medios. La morfología se recupera en la consulta, expandiendo por la familia que
`indice_forma` trae calculada con el stemmer que sí ve los acentos.

### Dos límites medidos, no supuestos

**El índice no contiene cifras.** El diccionario de `fts` no tiene un solo
término con dígitos: `94`, `2020` y `942020` no existen. En un archivo judicial
eso importa, así que la interfaz lo detecta y lo dice en vez de devolver cero
resultados en silencio.

**Una forma que no aparece en el corpus no encuentra nada** aunque su familia sí
esté indexada, porque el stemmer no viaja al navegador. Se compensa con respaldo
por prefijo —«destituciones», que no está, alcanza «destitución» por la raíz
`destitu`— y cuando eso ocurre la página lo declara.

El primer tokenizador propio sólo alcanzaba al **78,5 %** de las formas, porque
partía por no-alfanumérico y generaba tokens como «312020» que nunca podrían
unirse. Partir por letras subió la correspondencia al **96,7 %**.

**Verificado:** las consultas se ejecutaron contra los Parquet reales
(0,26–0,53 s), el validador custodia los cuatro archivos por filas y SHA-256 más
los parámetros de puntuación, y **23 pruebas negativas** pasan.

Lo que **no** está verificado, y se declara en la propia página: la relevancia.
No hay juicios de pertinencia sobre este corpus, así que el orden de los
resultados es una hipótesis del algoritmo y no un resultado medido.

---

## Fase 4 — Recuperación semántica — **medida y descartada para ordenar**

El plan la cerraba con una condición: «si el híbrido no mejora, la fase no se
despliega». Se cumplió la condición, en el sentido desfavorable.

### Lo que se construyó

41.405 vectores de 384 dimensiones en `int8`, **15,6 MB**, con
`multilingual-e5-small` (MIT). Trocear fue necesario y medirlo lo demostró: el
modelo admite 512 tokens y los fragmentos `DOCUMENTO` promedian 10.603
caracteres, de modo que truncar habría conservado el **15,9 %** del texto de los
dictámenes. Ventanas de 1.800 con 200 de solape, guardando el desplazamiento
para que un resultado siga siendo citable.

La cuantización `int8` resultó casi sin pérdida: coseno **0,99998** con el vector
original y top-20 sin cambios de composición.

### Por qué no ordena nada en el sitio

Tres medidas, en este orden:

| Medida | Resultado |
|---|---|
| Amplitud del coseno entre el resultado 1 y el 200 | **0,012** (0,894 → 0,872) |
| Estabilidad del top-10 ante nueve reformulaciones triviales | **60 %** · BM25: **100 %** |
| Amplitud con ventanas de 300 / 700 / 1.800 caracteres | 0,0275 / 0,0346 / 0,0288 |

La primera dice que el modelo ve casi todos los pasajes igual de parecidos: el
orden dentro de esa banda no responde a la consulta. La segunda lo confirma
desde el uso —escribir «quorum de la sesion» sin tildes cambia **ocho de cada
diez** resultados—. La tercera descarta que la culpa sea del troceado.

**Un archivo que responde distinto a la misma pregunta no es consultable.** Eso
contradice lo único que este proyecto promete, así que la interfaz no ofrece
búsqueda semántica y explica por qué en la propia página.

Causa probable: el español jurídico de este corpus es extremadamente formulario
y un vector que promedia un pasaje entero se parece a cualquier otro. Un modelo
de dominio jurídico podría comportarse distinto; **no se probó**.

### Lo que sí queda

Los vectores **se publican como dato**, con modelo, dimensión, prefijos,
cuantización y límites declarados en `editions.json`, y con
`apto_para_ranking_en_el_sitio: false`. Sirven para experimentar con otros
modelos, reagrupar el corpus o comparar; no para decidir qué se muestra.

Se descartó también, antes y por medición, la alternativa barata de expandir la
consulta con vecinos semánticos precomputados por término: devuelve variantes
morfológicas —«magistrado → magistrados, magistrada»— que la expansión por
familia de BM25 ya cubría.

### Una corrección al plan

Este documento estimaba «~30 MB, cacheado» para el codificador de consultas. El
ONNX más pequeño pesa **118 MB**, más 17 del vocabulario: **135 MB**, cuatro
veces y media la estimación. En un modelo multilingüe pequeño la tabla de
embeddings del vocabulario domina y no se comprime —`model_q4.onnx` pesa 398 MB
porque sólo cuantiza las capas—. Aunque el ranking hubiera funcionado, ese coste
habría exigido discutirlo.

---

## Fase 5 — Respuesta asistida (16–32 h) — **condicionada, no automática**

Aquí hay que parar y decidir, no seguir por inercia.

El proyecto entero se sostiene sobre una regla: **toda afirmación se ancla a una
página, y lo indeterminable se declara**. Un modelo generativo produce prosa
fluida y plausible sobre procesos disciplinarios **de personas reales y
nombradas**. Una sola frase inventada sobre la conducta de un magistrado es un
daño que no se repara con una nota al pie, y contradice de raíz `alcance-etico.md`.

**Recomendación: respuesta extractiva, sin generación.** La respuesta se arma
con pasajes literales recuperados, ordenados, cada uno con documento y página,
y con una plantilla fija que los presenta. Cuando la recuperación es débil, la
respuesta correcta es «no determinable con este corpus» —que es, además, la
respuesta honesta y la que el proyecto ya sabe dar—.

Si aun así se quiere generación, entonces: modelo local (WebLLM, ~1 GB de
descarga), cada oración con ancla obligatoria, negativa explícita ante
recuperación débil, y **no antes** de cerrar la validación humana y una decisión
expresa sobre protección de datos. Un modelo servido desde un tercero rompe las
dos propiedades que hoy hacen sostenible este sitio: estático y gratuito.

---

## Fase 6 — El sitio como objeto FAIR (8 h)

El observatorio es en sí mismo un producto de investigación, y hoy no es citable.

- **DOI por Zenodo**, vía la integración con GitHub. Gratuito.
- `ro-crate-metadata.json` y `codemeta.json` — metadatos legibles por máquina.
- `datapackage.json` (Frictionless) describiendo cada Parquet.
- `CITATION.cff`.
- **Alojar DuckDB-WASM en el propio repositorio** en lugar de jsDelivr. Un CDN
  es un punto único de fallo y una fuga de datos de navegación hacia un tercero,
  en un sitio sobre derechos. Además, un archivo que depende de un CDN para
  leerse no está preservado.

Es la fase de mejor rendimiento sobre el índice FAIR: ataca **Gobernable (45,0)**
y **Encontrable (70,8)**, las dos dimensiones más bajas de las ocho.

---

## Orden, esfuerzo y dependencias

```
Fase 0  reparar y blindar        2–4 h    ← empezar aquí
   │
Fase 1  un linaje fechado        4–8 h    ← bloquea 2, 3 y 4
   ├── Fase 2  estadísticas      8–12 h
   └── Fase 3  BM25              8–16 h
          └── Fase 4  semántica  16–24 h
                 └── Fase 5  respuesta   condicionada
Fase 6  FAIR del sitio           8 h      ← independiente, en paralelo
```

Fases 0 a 3: entre tres y cinco jornadas, y dejan el sitio **correcto, coherente
y con búsqueda útil**. Es el corte que yo recomendaría como primer entregable.

Fase 4 añade valor real pero no es imprescindible para que el sitio sirva.
Fase 5 no debería iniciarse antes de que `T6` deje de valer cero.

## Herramientas — todas libres

DuckDB-WASM (MIT) · Transformers.js (Apache-2.0) · ONNX Runtime Web (MIT) ·
sentence-transformers (Apache-2.0) · Frictionless (MIT) · RO-Crate ·
Zenodo · Playwright (Apache-2.0) · pa11y (LGPL) · GitHub Pages y Actions.

Sin servicio de pago, sin servidor propio, sin dependencia de un proveedor para
que el sitio siga leyéndose.
