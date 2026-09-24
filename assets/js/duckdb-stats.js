// DuckDB-WASM y sus dependencias se sirven desde este mismo repositorio, no
// desde un CDN. Un archivo que necesita a un tercero para poder leerse no está
// preservado, y en un sitio sobre derechos cada petición a un CDN filtra a ese
// tercero qué se está consultando y desde dónde.
//
// El módulo conserva internamente `getJsDelivrBundles()`, que construye URLs
// del CDN. No se llama: el paquete se arma a mano más abajo con rutas locales.
import * as duckdb from '../vendor/duckdb/duckdb-duckdb-wasm.esm.js';
const P = window.PortalStats;
if (!P) throw new Error('PortalStats no inicializado');
const {$, esc, chart} = P;
const CFG = window.PORTAL_CONFIG || {
  portalDataBase:'data/portal/',
  jemSilverBase:'data/jem-silver/',
  catalogBase:'data/catalog/'
};
let conn = null, schema = new Set();
// Repintados que el filtro de período dispara. Se asignan cuando sus
// datos están cargados; antes de eso el interruptor no tiene nada que
// recalcular y estas funciones no hacen nada.
let panelCorpus = async () => {};
let repintarPaneles = async () => {};
let activeDocumentFile = 'document.parquet';

function scalarNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  try {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  } catch (_) {
    return fallback;
  }
}

function col(name, fallback='NULL') {
  return schema.has(name) ? name + ` AS ${name}` : `${fallback} AS ${name}`;
}

/** Paquetes locales. `selectBundle` elige entre ellos según lo que el
 *  navegador admita: `eh` usa excepciones de WebAssembly y `mvp` es el
 *  respaldo para navegadores que no las tienen. Se sirve uno solo, así que
 *  el coste para quien visita la página no cambia respecto del CDN; lo que
 *  cambia es de quién depende el sitio para funcionar. */
function paquetesLocales() {
  const raiz = new URL('../vendor/duckdb/', import.meta.url).href;
  return {
    mvp: { mainModule: raiz + 'duckdb-mvp.wasm',
           mainWorker: raiz + 'duckdb-browser-mvp.worker.js' },
    eh:  { mainModule: raiz + 'duckdb-eh.wasm',
           mainWorker: raiz + 'duckdb-browser-eh.worker.js' },
  };
}

async function setupDb() {
  const bundle = await duckdb.selectBundle(paquetesLocales());
  // El Blob se conserva aunque el worker sea del mismo origen: mantiene una
  // sola forma de arranque y evita depender de cómo resuelva cada navegador
  // una ruta relativa dentro de un worker.
  const workerUrl = URL.createObjectURL(new Blob(
    [`importScripts("${bundle.mainWorker}");`],
    {type:'text/javascript'}
  ));
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();
  return db;
}

async function registerAndTest(db, virtualName, url) {
  await db.registerFileURL(virtualName, url, duckdb.DuckDBDataProtocol.HTTP, false);
  await conn.query(`SELECT * FROM read_parquet('${virtualName}') LIMIT 0`);
}

// Qué edición consulta la página. Se resuelve una sola vez, de `editions.json`,
// y la usan todas las pestañas.
//
// Antes `en_uso_por_la_interfaz` era un mapa de pestaña a edición y las
// heredadas apuntaban a la anterior. El propio archivo lo justificaba: «la
// página lee las dos». Esa era la contradicción de fondo del sitio, y no se
// arregla renombrando textos: se arregla leyendo una sola edición.
let EDICION_VIGENTE = null;

async function resolverEdicion(base) {
  if (EDICION_VIGENTE) return EDICION_VIGENTE;
  const cfg = await fetch(new URL(CFG.jemSilverBase + 'editions.json', base).href)
    .then(r => { if (!r.ok) throw new Error('editions.json ' + r.status); return r.json(); });
  EDICION_VIGENTE = cfg.vigente;
  if (!EDICION_VIGENTE) throw new Error('editions.json no declara una edición vigente');
  return EDICION_VIGENTE;
}

/** Monta las vistas que consultan todos los paneles.
 *
 *  El filtro de período no se escribe en cada consulta: se escribe una vez,
 *  acá, y las cuarenta consultas de este archivo leen `v_voto`, `v_resolucion`
 *  y compañía sin saber cuál de los dos estados están midiendo. Repetir el
 *  predicado en cada consulta habría garantizado que tarde o temprano una se
 *  quedara sin él, y una sola pestaña sin filtrar en una página filtrada es
 *  indistinguible de publicar una cifra falsa.
 */
async function montarVistas() {
  if (!conn) return;
  const f = window.JemFiltro;
  const activo = f?.activo && f.entidades?.length;
  const ids = activo ? f.entidades.join(',') : '';
  const resFiltro = activo
    ? `WHERE resolucion_id IN (SELECT DISTINCT resolucion_id`
      + ` FROM read_parquet('voto.parquet') WHERE entidad_id IN (${ids}))`
    : '';
  const docFiltro = activo
    ? `WHERE blob_id IN (SELECT r.document_id FROM read_parquet('resolucion.parquet') r`
      + ` WHERE r.resolucion_id IN (SELECT DISTINCT resolucion_id`
      + ` FROM read_parquet('voto.parquet') WHERE entidad_id IN (${ids})))`
    : '';

  const defs = {
    v_voto:        `SELECT * FROM read_parquet('voto.parquet') ${resFiltro}`,
    v_resolucion:  `SELECT * FROM read_parquet('resolucion.parquet') ${resFiltro}`,
    v_documento:   `SELECT * FROM read_parquet('documento.parquet') ${docFiltro}`,
    v_fragmento:   `SELECT * FROM read_parquet('fragmento.parquet') ${docFiltro}`,
    v_campo:       `SELECT * FROM read_parquet('campo.parquet') ${docFiltro}`,
    // Las causas se recortan por sus documentos, no por sí mismas.
    // El recorte de causas va por `vinculo`, que es la relación
    // documento-causa. Un primer intento usó `campo`, que también trae
    // `causa_id` pero como campo extraído: daba 1.033 causas donde el cálculo
    // de referencia da 1.097. Dos caminos de join, dos cifras del mismo hecho.
    v_causa: activo
      ? `SELECT * FROM read_parquet('causa.parquet') WHERE causa_id IN (
           SELECT n.causa_id FROM read_parquet('vinculo.parquet') n
           WHERE n.document_id IN (SELECT r.document_id
             FROM read_parquet('resolucion.parquet') r
             WHERE r.resolucion_id IN (SELECT DISTINCT resolucion_id
               FROM read_parquet('voto.parquet') WHERE entidad_id IN (${ids}))))`
      : `SELECT * FROM read_parquet('causa.parquet')`,
    // El catálogo llama `document_id` a lo que la capa Silver llama `blob_id`,
    // de modo que el predicado se escribe aparte en vez de derivarse por
    // sustitución de texto del otro: una sustitución que dejara de coincidir
    // no fallaría, devolvería el corpus entero con el filtro puesto.
    v_catalogo: activo
      ? `SELECT * FROM read_parquet('${activeDocumentFile}')
         WHERE document_id IN (SELECT r.document_id
           FROM read_parquet('resolucion.parquet') r
           WHERE r.resolucion_id IN (SELECT DISTINCT resolucion_id
             FROM read_parquet('voto.parquet') WHERE entidad_id IN (${ids})))`
      : `SELECT * FROM read_parquet('${activeDocumentFile}')`,
    v_metrica_juez: `SELECT * FROM read_parquet('${activo
      ? 'metrica_juez_periodo.parquet' : 'metrica_juez.parquet'}')`,
  };
  for (const [nombre, sql] of Object.entries(defs)) {
    try { await conn.query(`CREATE OR REPLACE VIEW ${nombre} AS ${sql}`); }
    catch (e) { console.error(`No se pudo montar ${nombre}:`, e.message); }
  }
}

async function loadParquetCorpus(db, base) {
  try {
    await resolverEdicion(base);
    // El catálogo del portal, derivado de la edición vigente. Agrega
    // carátula, calidad de OCR y las URL de Hugging Face sin tocar la capa
    // Silver.
    //
    // Antes esto tenía una reserva a `data/jem-silver/document.parquet` —el
    // corpus del pipeline anterior, con 3.964 documentos— y como el archivo
    // preferido no existía, la reserva se disparaba siempre. El resultado es
    // que la primera pestaña contaba 663 documentos menos que la siguiente.
    // Ya no hay reserva: si el catálogo falta, la pestaña lo dice. Un número
    // equivocado es peor que un error visible.
    activeDocumentFile = 'document_public.parquet';
    await registerAndTest(
      db,
      activeDocumentFile,
      new URL(CFG.catalogBase + 'document_public.parquet', base).href
    );

    // Las causas salen de la misma edición que todo lo demás. Leerlas del
    // archivo suelto daba 1.669 donde el corte vigente tiene 2.908.
    await registerAndTest(
      db,
      'causa.parquet',
      new URL(CFG.jemSilverBase + EDICION_VIGENTE + '/causa.parquet', base).href
    );

    const desc = await conn.query(
      `DESCRIBE SELECT * FROM read_parquet('${activeDocumentFile}')`
    );
    schema = new Set(desc.toArray().map(r => r.toJSON().column_name));

    // Vista del catálogo, recortable por el filtro igual que las demás. El
    // recorte va por documento: los del catálogo que pertenecen a alguna
    // resolución del período.
    await conn.query(`CREATE OR REPLACE VIEW v_catalogo AS
      SELECT * FROM read_parquet('${activeDocumentFile}')`);
    // `causa.parquet` queda disponible como vista antes de que el resto de las
    // tablas exista: esta función corre primero y necesita contar expedientes.
    await conn.query(`CREATE OR REPLACE VIEW v_causa AS
      SELECT * FROM read_parquet('causa.parquet')`);

    const linkExpr = schema.has('download_url')
      ? "COALESCE(download_url,'') <> ''"
      : schema.has('relative_path')
        ? "COALESCE(relative_path,'') <> ''"
        : 'FALSE';

    // Las cifras del corpus se repintan cuando cambia el filtro. Se aíslan
    // acá en vez de quedarse sueltas dentro del arranque porque si no, el
    // interruptor cambiaría las cifras de las demás pestañas y dejaría ésta
    // —la primera que se ve— mostrando el corpus entero.
    //
    // Los dos selectores se declaran FUERA: `searchDocs` los usa y, al quedar
    // dentro, lanzaba «yf is not defined». El error caía en un `catch` que lo
    // registraba como `console.info`, de modo que no salía como error y la
    // tabla de documentos se quedaba con las nueve filas del documento
    // editorial que pinta stats.js. Las pruebas no lo vieron porque
    // comprobaban los KPI, que se escriben antes del fallo.
    const yf = $('#yearFilter'), tf = $('#typeFilter');
    panelCorpus = async () => {
    const k = await conn.query(`SELECT
      (SELECT COUNT(*) FROM v_causa) total_causas,
      COUNT(*) total_docs,
      AVG(${schema.has('body_quality') ? 'body_quality' : 'NULL'}) avg_quality,
      COUNT(CASE WHEN ${linkExpr} THEN 1 END) linkable
      FROM v_catalogo`);
    const o = k.toArray()[0].toJSON();

    const totalCausas = scalarNumber(o.total_causas);
    const totalDocs = scalarNumber(o.total_docs);
    const linkableDocs = scalarNumber(o.linkable);

    $('#kpiCausas').textContent = totalCausas.toLocaleString();
    $('#kpiDocs').textContent = totalDocs.toLocaleString();
    $('#kpiOcr').textContent = o.avg_quality == null
      ? '—'
      : (scalarNumber(o.avg_quality) * 100).toFixed(1) + '%';

    // Invariante: los documentos enlazables nunca pueden superar el corpus.
    if (linkableDocs < 0 || linkableDocs > totalDocs) {
      console.error('KPI documentos enlazables inválido', { linkableDocs, totalDocs });
      $('#kpiLinks').textContent = '—';
      $('#kpiLinks').title = 'Valor descartado por control de consistencia';
    } else {
      $('#kpiLinks').textContent = linkableDocs.toLocaleString();
      $('#kpiLinks').title = `${linkableDocs.toLocaleString()} de ${totalDocs.toLocaleString()} documentos tienen enlace`;
    }
    $('#kpiCausasLabel').textContent = 'Expedientes únicos';
    $('#kpiDocsLabel').textContent = 'Documentos procesados';
    $('#kpiOcrLabel').textContent = 'Calidad promedio OCR';

    yf.innerHTML = '<option value="">Todos los años</option>';
    tf.innerHTML = '<option value="">Todos los tipos</option>';

    if (schema.has('kind')) {
      const r = await conn.query(
        `SELECT kind,COUNT(*) c FROM v_catalogo
         GROUP BY kind ORDER BY c DESC`
      );
      const d = r.toArray().map(x => x.toJSON());
      chart('chartTypes',{
        title:{text:'Tipos de documento',left:'center'},
        tooltip:{trigger:'item'},
        series:[{
          type:'pie',
          radius:['40%','70%'],
          data:d.map(x=>({name:x.kind||'Desconocido',value:Number(x.c)}))
        }]
      });
      d.forEach(x => tf.insertAdjacentHTML(
        'beforeend',
        `<option value="${esc(x.kind||'')}">${esc(x.kind||'Desconocido')}</option>`
      ));
    }

    if (schema.has('year')) {
      const r = await conn.query(
        `SELECT CAST(year AS INT) y,COUNT(*) c
         FROM v_catalogo
         WHERE year IS NOT NULL GROUP BY y ORDER BY y`
      );
      const d = r.toArray().map(x=>x.toJSON());
      chart('chartYears',{
        title:{text:'Volumen documental por año',left:'center'},
        tooltip:{trigger:'axis'},
        xAxis:{type:'category',data:d.map(x=>x.y)},
        yAxis:{type:'value'},
        series:[{type:'bar',data:d.map(x=>Number(x.c))}]
      });
      d.forEach(x=>yf.insertAdjacentHTML(
        'beforeend',
        `<option value="${x.y}">${x.y}</option>`
      ));
    }
    };
    await panelCorpus();

    async function searchDocs() {
      const term = $('#docSearch').value || '';
      const year = yf.value, type = tf.value;
      const st = term.replaceAll("'","''");
      const sy = year.replaceAll("'","''");
      const sk = type.replaceAll("'","''");
      const wh = [];

      // El catálogo del portal no trae el texto completo: son 53,7 millones de
      // caracteres y enviarlos al navegador para hacer LIKE sería más lento y
      // peor que el índice BM25 de la pestaña «Buscar en el texto». Acá se
      // filtran metadatos —carátula y nombre de archivo—, y la página lo dice
      // en vez de ignorar el término en silencio, que es lo que pasaba antes
      // cuando la columna `body` no estaba.
      const campos = ['caratula', 'filename', 'causa_clave']
        .filter(c => schema.has(c));
      if (term) {
        if (schema.has('body')) {
          wh.push(`LOWER(body) LIKE LOWER('%${st}%')`);
        } else if (campos.length) {
          // Se normalizan los acentos de los dos lados. Los nombres propios
          // paraguayos los llevan y los nombres de archivo no: «Cárdenas»
          // bien escrito no encontraba el documento que el archivo guarda como
          // «CARDENAS», y «Garantías» no encontraba las 218 resoluciones que
          // lo mencionan.
          wh.push('(' + campos
            .map(c => `strip_accents(LOWER(COALESCE(${c},'')))`
                    + ` LIKE strip_accents(LOWER('%${st}%'))`)
            .join(' OR ') + ')');
        }
      }
      if (year && schema.has('year')) wh.push(`CAST(year AS VARCHAR)='${sy}'`);
      if (type && schema.has('kind')) wh.push(`kind='${sk}'`);

      const snippet = schema.has('body')
        ? `SUBSTRING(body,GREATEST(1,POSITION(LOWER('${st}') IN LOWER(body))-70),260)`
        : `''`;

      const q = `SELECT
        ${col('year')},
        ${col('kind',"''")},
        ${col('caratula',"''")},
        ${col('body_quality')},
        ${col('relative_path',"''")},
        ${col('download_url',"''")},
        ${col('view_url',"''")},
        ${col('storage_provider',"''")},
        ${col('file_sha256',"''")},
        ${snippet} snippet
        FROM v_catalogo
        ${wh.length ? 'WHERE '+wh.join(' AND ') : ''}
        ORDER BY ${schema.has('year') ? 'year DESC NULLS LAST' : '1'}
        LIMIT 100`;

      try {
        const r = await conn.query(q);
        const rows = r.toArray().map(x => x.toJSON());
        $('#docRows').innerHTML = rows.map(x => {
          const qual = x.body_quality == null ? null : Number(x.body_quality);
          let href = x.download_url || '';
          if (!href && x.relative_path) {
            href = String(x.relative_path).replace(/^\.?\//,'');
          }
          const actions=[];
          if(x.view_url) actions.push(`<a href="${esc(x.view_url)}" target="_blank" rel="noopener">Ver ↗</a>`);
          if(href) actions.push(`<a href="${esc(href)}" target="_blank" rel="noopener">Descargar ↧</a>`);
          return `<tr>
            <td>${esc(x.year||'—')}</td>
            <td>${esc(x.kind||'—')}</td>
            <td>${esc(x.caratula||'Sin carátula')}</td>
            <td>${esc(String(x.snippet||'').replace(/\s+/g,' '))}</td>
            <td><span class="quality ${qual!=null&&qual>.8?'q-high':'q-low'}">${
              qual==null?'N/A':(qual*100).toFixed(0)+'%'
            }</span></td>
            <td>${actions.length?actions.join(' · '):'—'}</td>
          </tr>`;
        }).join('') || '<tr><td colspan="6">Sin resultados.</td></tr>';
      } catch(e) {
        $('#docRows').innerHTML =
          `<tr><td colspan="6">Error de consulta Parquet: ${esc(e.message)}</td></tr>`;
      }
    }

    $('#docSearch').oninput = searchDocs;
    yf.onchange = searchDocs;
    tf.onchange = searchDocs;
    await searchDocs();

    $('#engineStatus').textContent = activeDocumentFile === 'document_public.parquet'
      ? 'JEM Silver + catálogo público · DuckDB-WASM activo · documentos enlazados'
      : 'JEM Silver detectado · DuckDB-WASM activo · ejecute generar_manifest.py para enlazar documentos';
    return true;
  } catch (e) {
    console.info('Parquet documental no disponible:', e.message);
    return false;
  }
}

/** Votos y decisividad, sobre la edición vigente.
 *
 *  Antes esta sección esperaba `votacion.parquet` y `miembro_voto.parquet`,
 *  dos archivos que nunca se publicaron y que no deberían publicarse con ese
 *  esquema: pedían una columna `rivas_decisivo`, que es exactamente la métrica
 *  que el proyecto declara NO_DETERMINABLE. Un Parquet con esa columna sería
 *  una respuesta inventada a una pregunta que el corpus no responde.
 *
 *  Se sustituye por lo que los datos sí sostienen: cuántos votos hay, de
 *  quiénes, en qué resoluciones y con qué ancla. Lo indeterminable sigue
 *  declarado como tal en la propia sección.
 */
async function loadVotes(db, base, baseEd) {
  if (!baseEd) return;
  try {
    for (const t of ['voto', 'entidad', 'resolucion']) {
      await registerAndTest(db, `${t}.parquet`,
        new URL(baseEd + t + '.parquet', base).href);
    }
  } catch (e) {
    console.info('Capa de votos no disponible:', e.message);
    $('#voteStatus').hidden = false;
    return;
  }

  const k = await uno(`SELECT
      (SELECT COUNT(*) FROM v_voto) votos,
      (SELECT COUNT(*) FROM v_voto WHERE pagina IS NOT NULL) citables,
      -- Integrantes DESPUÉS de fusionar las variantes del OCR. Contando
      -- entidad_id en crudo daban 110, mientras la tabla de más abajo de
      -- esta misma pestaña mostraba 50: el mismo hecho con dos cifras a un
      -- palmo de distancia. Las 60 de diferencia no son personas, son
      -- «Hemán», «Her nán» y «Hernán Davis» contados aparte.
      (SELECT COUNT(*) FROM v_metrica_juez) integrantes,
      (SELECT COUNT(*) FROM v_resolucion
         WHERE estado_votos='CON_VOTOS') decisiones,
      (SELECT COUNT(*) FROM v_voto
         WHERE sentido='DISIDENCIA') disidencias`);
  pon('#voteTotal', num(k.votos));
  pon('#voteTotal2', num(k.votos));
  pon('#voteMembers', num(k.integrantes));
  pon('#voteDecisions', num(k.decisiones));
  pon('#voteCitable', `${num(k.citables)} de ${num(k.votos)}`);
  pon('#voteDissent', num(k.disidencias));

  const sentido = await filas(`SELECT COALESCE(sentido,'sin_calcular') sentido,
      COUNT(*) n FROM v_voto GROUP BY 1 ORDER BY 2 DESC`);
  barras('chartOutcomes', 'Sentido del voto individual', sentido, 'sentido', 'n');

  // Métricas por integrante, ya calculadas con su verificación al lado.
  try {
    await registerAndTest(db, 'metrica_juez.parquet',
      new URL(baseEd + 'metrica_juez.parquet', base).href);
  } catch (e) {
    console.info('Métricas por integrante no disponibles:', e.message);
    return;
  }
  const m = await filas(`SELECT * FROM v_metrica_juez
      ORDER BY votos DESC LIMIT 40`);
  barras('chartVotesPerMember', 'Votos por integrante (12 primeros)',
         m.slice(0, 12).map(r => ({
           n: String(r.nombre).split(' ').slice(-2).join(' '), v: Number(r.votos) })),
         'n', 'v');
  const pct = (x) => x === null || x === undefined
    ? '—' : (Number(x) * 100).toFixed(1).replace('.', ',') + ' %';
  $('#voteMemberRows').innerHTML = m.map(r => `<tr>
      <td>${esc(r.nombre)}</td><td>${num(r.votos)}</td>
      <td>${num(r.ponente)}</td><td>${num(r.adhesion)}</td><td>${num(r.disidencia)}</td>
      <td>${num(r.resoluciones)}</td>
      <td>${pct(r.acuerdo_aparente)}</td>
      <td>${pct(r.indice_verificacion)}</td>
      <td>${num(r.errores)}</td>
      <td>${Number(r.posibles_duplicados) ? `<strong title="Entidades que comparten apellidos con ésta">${num(r.posibles_duplicados)}</strong>` : '—'}</td>
    </tr>`).join('');

  // Índice de verificación y concordancia, del resumen que acompaña la edición.
  try {
    const met = await fetch(new URL(baseEd + 'metricas.json', base).href)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    const v = met.verificacion || {};
    pon('#verIndice', pct(v.indice));
    pon('#verRevisados', num(v.revisados));
    pon('#verTotal', num(v.votos_totales));
    pon('#verErrores', num(v.errores_hallados));
    pon('#verCorrecciones', num(v.correcciones));
    pon('#verTasaError', v.tasa_error === null || v.tasa_error === undefined
        ? 'sin datos: no hay revisiones' : pct(v.tasa_error));
    const c = met.concordancia_dictamen_resolucion || {};
    pon('#concCoincide', c.comparables
        ? `${num(c.coincide)} · ${pct(c.tasa_coincidencia)}` : '—');
    pon('#concDifiere', num(c.difiere));
    pon('#concComparables', `${num(c.comparables)} de ${num(c.vinculos)}`);
    pon('#concSinRec', num(c.sin_recomendacion));
  } catch (e) {
    console.info('Resumen de métricas no disponible:', e.message);
  }

  $('#voteStatus').hidden = true;
  $('#voteDashboard').hidden = false;
}

/* ==================================================================
   Edición vigente de la capa Silver
   ==================================================================
   Las pestañas Trazabilidad, Quórum, Procedencia y FAIR consultan la
   edición fechada que declara `data/jem-silver/editions.json`, no la
   raíz. Reusa la conexión DuckDB ya abierta: una segunda instancia
   significaría otro worker y otra copia del WASM en memoria.

   Regla que gobierna todo este bloque: NO_DETERMINABLE es una
   categoría que se dibuja, nunca un cero ni un hueco. En un gráfico
   la tentación es grande, porque una barra ausente se lee como
   «ninguno» y nadie la cuestiona.
   ================================================================== */

const PALETA = {
  bien:'#2f855a', medio:'#b7791f', mal:'#c05621',
  nd:'#718096', neutro:'#4a5568'
};
const NO_DET = new Set(['NO_DETERMINABLE','sin_calcular','sin_score','SIN_URL']);
const colorDe = (k) => NO_DET.has(String(k)) ? PALETA.nd : PALETA.neutro;
const num = (n) => Number(n||0).toLocaleString('es-PY');

function barras(id, titulo, filas, clave, valor) {
  chart(id, {
    title:{text:titulo, left:'center', textStyle:{fontSize:14}},
    tooltip:{trigger:'axis'},
    grid:{left:'3%', right:'4%', bottom:'12%', containLabel:true},
    xAxis:{type:'category', data:filas.map(r=>r[clave]),
           axisLabel:{interval:0, rotate:filas.length>4?28:0, fontSize:10}},
    yAxis:{type:'value'},
    series:[{type:'bar', data:filas.map(r=>({
      value:Number(r[valor]), itemStyle:{color:colorDe(r[clave])}}))}]
  });
}

async function filas(sql) {
  const r = await conn.query(sql);
  return r.toArray().map(x=>x.toJSON());
}
const uno = async (sql) => (await filas(sql))[0] || {};
const pon = (sel, v) => { const e = $(sel); if (e) e.textContent = v; };

async function loadEdicionVigente(db, base) {
  let edicion, baseEd, indiceMeta = null;
  try {
    const cfg = await fetch(new URL(CFG.jemSilverBase + 'editions.json', base).href)
      .then(r => { if(!r.ok) throw new Error('editions.json '+r.status); return r.json(); });
    // Una sola edición para toda la página. Antes esto miraba
    // `en_uso_por_la_interfaz`, un mapa por pestaña que permitía que unas
    // leyeran agosto y otras el corte vigente.
    edicion = cfg.vigente;
    baseEd = cfg.ediciones?.[edicion]?.base;
    if (!baseEd) throw new Error(`la edición ${edicion} no está declarada`);
    // Los parámetros de BM25 se leen de la declaración en vez de repetirse
    // aquí: si el índice se reconstruye con otro k1 o b, la página los usa
    // sin que nadie tenga que acordarse de tocar el JavaScript.
    indiceMeta = cfg.ediciones[edicion]?.indice || null;
  } catch (e) {
    console.info('No se pudo resolver la edición vigente:', e.message);
    pon('#edicionEstado', 'Edición: no disponible');
    return;
  }

  const TABLAS = ['fragmento','documento','resolucion','voto','procedencia','campo','vinculo'];
  try {
    for (const t of TABLAS) {
      await registerAndTest(db, `${t}.parquet`, new URL(baseEd + t + '.parquet', base).href);
    }
    // Las dos tablas de métricas por integrante: la del corpus entero y la
    // del período. Se calculan fuera, donde vive el mapa de fusión, porque
    // reimplementar esa agrupación en SQL del lado del cliente sería tener dos
    // definiciones de «quién es quién» que pueden separarse.
    for (const t of ['metrica_juez', 'metrica_juez_periodo']) {
      await registerAndTest(db, `${t}.parquet`, new URL(baseEd + t + '.parquet', base).href);
    }
  } catch (e) {
    console.info('Edición vigente no disponible:', e.message);
    pon('#edicionEstado', 'Edición: no disponible');
    return;
  }

  await montarVistas();

  window.__db = db;
  pon('#edicionEstado', `Edición ${edicion}`);
  ['#trzEdicion','#qrmEdicion','#prvEdicion'].forEach(s => pon(s, `Edición ${edicion}`));

  // ---- Banner permanente de validación -----------------------------
  // Es el indicador que ningún código puede mover: cuenta revisiones
  // humanas, y sólo una persona puede incrementarlo.
  const v = await uno(`SELECT COUNT(*) total,
      COUNT(CASE WHEN revision <> 'AUTO' THEN 1 END) revisados
      FROM v_campo`);
  pon('#valTotal', num(v.total));
  pon('#valRevisados', num(v.revisados));

  // Los paneles se agrupan para poder repintarlos enteros cuando cambia el
  // filtro. Repintar sólo algunos dejaría la página con unas cifras del corpus
  // completo y otras del recorte, que es la contradicción que el filtro
  // existe para evitar, no para crear.
  repintarPaneles = async () => {
    await montarVistas();
    await loadVotes(db, base, baseEd);
    await panelTrazabilidad();
    await panelQuorum();
    await panelCorpus();
    // La procedencia y el índice FAIR no se filtran: uno describe de dónde
    // salió cada archivo y el otro mide el conjunto publicado, no un
    // subconjunto del corpus. La página lo declara en vez de callarlo.
  };
  await repintarPaneles();
  await panelProcedencia();
  await panelFair(base);
  await loadIndiceBM25(db, base, baseEd, indiceMeta);

  window.JemFiltro?.alCambiar(() => {
    repintarPaneles().catch(e => console.error('Al repintar con el filtro:', e));
  });
}

async function panelTrazabilidad() {
  const t = await uno(`SELECT COUNT(*) fragmentos,
      COUNT(DISTINCT blob_id) documentos,
      COUNT(CASE WHEN tipo_ancla='PAGINA' AND anclado=1 THEN 1 END) ancladas,
      COUNT(CASE WHEN tipo_ancla='PAGINA' THEN 1 END) paginas
      FROM v_fragmento`);
  pon('#trzFragmentos', num(t.fragmentos));
  pon('#trzDocumentos', num(t.documentos));
  pon('#trzAncladas', `${num(t.ancladas)} de ${num(t.paginas)}`);

  const vt = await uno(`SELECT COUNT(*) total, COUNT(pagina) con_pagina
      FROM v_voto`);
  pon('#trzVotos', `${num(vt.con_pagina)} de ${num(vt.total)}`);

  const anclas = await filas(`SELECT tipo_ancla, COUNT(*) n
      FROM v_fragmento GROUP BY 1 ORDER BY 2 DESC`);
  chart('chartAnclas', {
    title:{text:'Unidad citable', left:'center', textStyle:{fontSize:14}},
    tooltip:{trigger:'item'},
    series:[{type:'pie', radius:['40%','68%'], data:anclas.map(r=>({
      name:r.tipo_ancla, value:Number(r.n),
      itemStyle:{color:r.tipo_ancla==='PAGINA'?PALETA.bien:PALETA.medio}}))}]
  });

  // Las bandas incluyen «sin confianza» como categoría propia: los
  // fragmentos de documento no tienen score porque no pasaron por OCR,
  // y eso no es una confianza baja, es la ausencia de la medida.
  const bandas = await filas(`SELECT CASE
        WHEN confianza IS NULL THEN 'sin_score'
        WHEN confianza < 0.50 THEN 'muy baja'
        WHEN confianza < 0.70 THEN 'baja'
        WHEN confianza < 0.85 THEN 'media' ELSE 'alta' END banda,
      COUNT(*) n FROM v_fragmento
      GROUP BY 1 ORDER BY CASE banda WHEN 'alta' THEN 1 WHEN 'media' THEN 2
        WHEN 'baja' THEN 3 WHEN 'muy baja' THEN 4 ELSE 5 END`);
  barras('chartBandas', 'Confianza del reconocimiento por fragmento', bandas, 'banda', 'n');

  const det = await filas(`SELECT f.tipo_ancla,
      COUNT(*) fragmentos, COUNT(DISTINCT f.blob_id) documentos,
      ROUND(SUM(LENGTH(f.texto))/1e6, 1) mb,
      STRING_AGG(DISTINCT d.extension, ', ') formatos
      FROM v_fragmento f
      JOIN v_documento d USING (blob_id)
      GROUP BY 1 ORDER BY 2 DESC`);
  $('#trzAnclaRows').innerHTML = det.map(r=>`<tr>
      <td><code>${esc(r.tipo_ancla)}</code></td><td>${num(r.fragmentos)}</td>
      <td>${num(r.documentos)}</td><td>${esc(r.mb)} MB</td>
      <td>${esc(r.formatos)}</td></tr>`).join('');

  const motores = await filas(`SELECT COALESCE(motor,'sin motor') motor, COUNT(*) n
      FROM v_fragmento GROUP BY 1 ORDER BY 2 DESC`);
  barras('chartMotores', 'Fragmentos por motor de extracción', motores, 'motor', 'n');
}

async function panelQuorum() {
  const q = await uno(`SELECT
      COUNT(CASE WHEN estado_votos='CON_VOTOS' THEN 1 END) con_votos,
      COUNT(CASE WHEN quorum='COMPLETO' THEN 1 END) completo,
      COUNT(CASE WHEN quorum='INCOMPLETO_POR_EXTRACCION' THEN 1 END) incompleto,
      COUNT(CASE WHEN quorum='NO_DETERMINABLE' THEN 1 END) nodet
      FROM v_resolucion`);
  pon('#qrmConVotos', num(q.con_votos));
  pon('#qrmCompleto', num(q.completo));
  pon('#qrmIncompleto', num(q.incompleto));
  pon('#qrmNoDet', num(q.nodet));

  const quorum = await filas(`SELECT COALESCE(quorum,'sin_calcular') quorum, COUNT(*) n
      FROM v_resolucion GROUP BY 1 ORDER BY 2 DESC`);
  barras('chartQuorum', 'Estado del quórum por resolución', quorum, 'quorum', 'n');

  const sentido = await filas(`SELECT COALESCE(sentido,'sin_calcular') sentido, COUNT(*) n
      FROM v_resolucion GROUP BY 1 ORDER BY 2 DESC`);
  barras('chartSentido', 'Sentido de la decisión', sentido, 'sentido', 'n');

  const verbos = await filas(`SELECT verbo, COUNT(*) n
      FROM v_resolucion WHERE verbo IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
  $('#qrmVerboRows').innerHTML = verbos.map(r=>`<tr>
      <td>${esc(r.verbo)}</td><td>${num(r.n)}</td></tr>`).join('');

  const d = await uno(`SELECT COUNT(*) n FROM v_voto
      WHERE sentido='DISIDENCIA'`);
  pon('#qrmDisidencias', num(d.n));
}

async function panelProcedencia() {
  const p = await uno(`SELECT COUNT(DISTINCT blob_id) registro,
      COUNT(DISTINCT CASE WHEN persistencia='PERSISTENTE' THEN blob_id END) persistente,
      COUNT(DISTINCT CASE WHEN persistencia='EFIMERA' THEN blob_id END) efimera,
      COUNT(DISTINCT CASE WHEN persistencia='SIN_URL' THEN blob_id END) sin_url
      FROM read_parquet('procedencia.parquet')`);
  pon('#prvRegistro', num(p.registro));
  pon('#prvPersistente', num(p.persistente));
  pon('#prvEfimera', num(p.efimera));
  pon('#prvSinUrl', num(p.sin_url));

  const docs = await uno(`SELECT COUNT(*) n FROM v_documento`);
  const pct = docs.n ? (Number(p.persistente)/Number(docs.n)*100) : 0;
  pon('#prvPct', `${pct.toFixed(1).replace('.', ',')} %`);

  const pers = await filas(`SELECT COALESCE(persistencia,'sin_calcular') persistencia,
      COUNT(DISTINCT blob_id) n FROM read_parquet('procedencia.parquet')
      GROUP BY 1 ORDER BY 2 DESC`);
  barras('chartPersistencia', 'Persistencia de la URL de origen', pers, 'persistencia', 'n');

  // Cuántas resoluciones comparten la URL más repetida: la evidencia
  // directa de que el sistema de origen no expone identificador por
  // documento.
  const rep = await uno(`SELECT COUNT(*) n FROM read_parquet('procedencia.parquet')
      WHERE url = (SELECT url FROM read_parquet('procedencia.parquet')
                   WHERE url IS NOT NULL GROUP BY url
                   ORDER BY COUNT(*) DESC LIMIT 1)`);
  pon('#prvMismaUrl', num(rep.n));

  const col = await filas(`SELECT COALESCE(coleccion,'sin colección') coleccion,
      COUNT(*) n, SUM(tiene_paginas) con_paginas
      FROM v_documento GROUP BY 1 ORDER BY 2 DESC`);
  $('#prvColeccionRows').innerHTML = col.map(r=>`<tr>
      <td>${esc(r.coleccion)}</td><td>${num(r.n)}</td>
      <td>${num(r.con_paginas)}</td></tr>`).join('');
}

async function panelFair(base) {
  let d;
  try {
    d = await fetch(new URL('data/analysis/jem_full_20260830.json', base).href)
      .then(r => { if(!r.ok) throw new Error(r.status); return r.json(); });
  } catch (e) {
    console.info('Snapshot FAIR no disponible:', e.message);
    return;
  }
  const dim = d.indice_fair?.dimensiones || {};
  const ent = Object.entries(dim);
  if (!ent.length) return;

  const vals = ent.map(([,v])=>Number(v));
  pon('#fairDispersion', (Math.max(...vals)-Math.min(...vals)).toFixed(1).replace('.', ','));
  pon('#fairIndicadores', num(d.indice_fair?.indicadores));
  pon('#fairNoComputables', num(d.indice_fair?.no_computables));

  const s = d.indice_fair?.sensibilidad || {};
  const agregados = Object.values(s).map(Number).filter(Number.isFinite);
  if (agregados.length > 1) {
    pon('#fairAmplitud', (Math.max(...agregados)-Math.min(...agregados))
        .toFixed(1).replace('.', ','));
  }

  chart('chartFair', {
    title:{text:'Ocho dimensiones', left:'center', textStyle:{fontSize:14}},
    tooltip:{},
    radar:{indicator: ent.map(([k])=>({name:k, max:100})),
           radius:'62%', axisName:{fontSize:10}},
    series:[{type:'radar', data:[{value:vals, name:'Puntuación',
      areaStyle:{opacity:0.25}, lineStyle:{color:PALETA.neutro},
      itemStyle:{color:PALETA.neutro}}]}]
  });

  const orden = ent.slice().sort((a,b)=>b[1]-a[1]);
  barras('chartFairBarras', 'Dimensiones ordenadas',
         orden.map(([k,v])=>({dim:k, val:v})), 'dim', 'val');

  const lectura = (x) => x>=85 ? 'Sólido'
    : x>=70 ? 'Aceptable con reservas'
    : x>=55 ? 'Débil' : 'Crítico';
  $('#fairRows').innerHTML = orden.map(([k,v])=>`<tr>
      <td>${esc(k)}</td><td>${String(v).replace('.', ',')}</td>
      <td>${lectura(Number(v))}</td></tr>`).join('');
}

/* ==================================================================
   Búsqueda BM25 — Fase 3
   ==================================================================
   El índice se construye fuera de línea y viaja como cuatro Parquet.
   `PRAGMA create_fts_index` materializa el índice en tablas, así que
   cargar `fts` aquí obligaría a descargar los 53,7 MB de texto y a
   construirlo en cada visita: está pensada para una base local
   persistente, no para una sesión sin estado sobre HTTP.

   Lo que sí aprovecha esta página es que el posting está ordenado por
   `termid`: DuckDB lee por rangos HTTP y, con las estadísticas por
   grupo de filas, una consulta descarga unos cientos de kilobytes en
   vez de los 6,4 MB del archivo.
   ================================================================== */

const IDX = { listo:false, N:0, avgdl:0, k1:1.2, b:0.75 };

// Misma normalización que el índice: minúsculas y sin tildes. El
// stemmer no viaja aquí; lo sustituye `indice_forma`, que ya trae la
// familia morfológica de cada forma que aparece en el corpus.
const normaliza = (s) => String(s||'')
  .normalize('NFD').replace(/[̀-ͯ]/g,'')
  .toLowerCase().replace(/[^a-z\s]+/g,' ').trim();

const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

async function loadIndiceBM25(db, base, baseEd, meta) {
  const archivos = ['indice_termino','indice_posting','indice_fragmento','indice_forma'];
  try {
    for (const a of archivos) {
      await registerAndTest(db, `${a}.parquet`, new URL(baseEd + a + '.parquet', base).href);
    }
  } catch (e) {
    console.info('Índice BM25 no disponible:', e.message);
    pon('#bmEstado', 'Índice no disponible');
    return;
  }
  IDX.listo = true;
  IDX.N = Number(meta?.num_docs || 0);
  IDX.avgdl = Number(meta?.longitud_media || 1);
  IDX.k1 = Number(meta?.k1 ?? 1.2);
  IDX.b = Number(meta?.b ?? 0.75);
  pon('#bmEstado', `Índice BM25 · ${num(meta?.tablas?.indice_posting?.filas)} postings`);
  pon('#bmFragmentos', num(IDX.N));

  const lanzar = () => buscar().catch(e => {
    console.error('Búsqueda:', e);
    $('#bmResumen').hidden = false;
    $('#bmResumen').textContent = 'La búsqueda falló: ' + e.message;
  });
  $('#bmBuscar')?.addEventListener('click', lanzar);
  $('#bmConsulta')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); lanzar(); }
  });
}

/* ------------------------------------------------------------------
   Recuperación semántica: medida y descartada para ordenar
   ------------------------------------------------------------------
   Se calcularon 41.405 vectores del corpus con multilingual-e5-small y
   se midió si servían para ordenar. No sirven, y por tres razones que
   están medidas, no supuestas:

     - El coseno no discrimina: entre el mejor pasaje y el número 200
       hay 0,012 de diferencia (0,894 frente a 0,872). El orden dentro
       de esa banda no responde a la consulta.
     - El orden no es reproducible: ante nueve reformulaciones triviales
       el top-10 se conserva al 60 %, y quitar las tildes cambia ocho de
       cada diez resultados. BM25 conserva el 100 % en las mismas nueve.
     - No es culpa del troceado: con ventanas de 300, 700 y 1.800
       caracteres la amplitud se queda en 0,027-0,035.

   Un archivo cuya búsqueda responde distinto a la misma pregunta
   contradice lo único que este proyecto promete. Los vectores se
   publican como dato —con su modelo, dimensión y límites declarados—
   pero no ordenan nada aquí, y por eso no hay código que los consulte:
   el hallazgo vive en editions.json y en docs/plan-fases.md, que es
   donde se puede leer.
   ------------------------------------------------------------------ */

async function buscar() {
  const crudo = $('#bmConsulta')?.value || '';
  const resumen = $('#bmResumen');
  const cuerpo = $('#bmResultados');
  if (!IDX.listo || !cuerpo) return;

  const palabras = normaliza(crudo).split(/\s+/).filter(w => w.length >= 2);
  const traiaDigitos = /\d/.test(crudo);
  cuerpo.innerHTML = '';
  resumen.hidden = false;

  if (!palabras.length) {
    resumen.textContent = traiaDigitos
      ? 'El índice no contiene cifras: una consulta sólo numérica no puede resolverse aquí. '
        + 'Para buscar una causa por su número, usar el explorador de «Corpus documental».'
      : 'Escribir al menos una palabra de dos letras.';
    return;
  }
  resumen.textContent = 'Buscando…';

  const lista = palabras.map(lit).join(',');
  // Expansión morfológica en dos pasos. Si una forma escrita no aparece
  // en el corpus no tiene familia, y entonces se reintenta por prefijo:
  // sin eso, «destituciones» —que no está— no encontraría «destitución»,
  // que sí está. Cuando eso ocurre, se dice.
  const fam = await filas(`
    WITH escrito AS (SELECT UNNEST([${lista}]) AS f),
    exacta AS (
      SELECT e.f, fo.familia FROM escrito e
      JOIN read_parquet('indice_forma.parquet') fo ON fo.forma = e.f),
    huerfana AS (SELECT f FROM escrito EXCEPT SELECT f FROM exacta),
    prefijo AS (
      SELECT h.f, fo.familia FROM huerfana h
      JOIN read_parquet('indice_forma.parquet') fo
        ON fo.forma LIKE SUBSTR(h.f, 1, GREATEST(4, LENGTH(h.f) - 3)) || '%')
    SELECT DISTINCT familia, f, FALSE AS aprox FROM exacta
    UNION SELECT DISTINCT familia, f, TRUE FROM prefijo`);

  if (!fam.length) {
    resumen.textContent = `Ninguna de las palabras buscadas aparece en el corpus`
      + (traiaDigitos ? '. El índice tampoco contiene cifras.' : '.');
    return;
  }
  const aproximadas = [...new Set(fam.filter(r => r.aprox).map(r => r.f))];
  const familias = [...new Set(fam.map(r => r.familia))].map(lit).join(',');
  const filtro = $('#bmAncla')?.value;

  const r = await filas(`
    WITH term AS (
      SELECT DISTINCT termid FROM read_parquet('indice_forma.parquet')
      WHERE familia IN (${familias})),
    q AS (SELECT t.termid, ti.df FROM term t
          JOIN read_parquet('indice_termino.parquet') ti USING (termid)),
    punt AS (
      SELECT p.docid,
        SUM(LN((${IDX.N} - q.df + 0.5)/(q.df + 0.5) + 1) *
            (p.tf * (${IDX.k1} + 1)) /
            (p.tf + ${IDX.k1} * (1 - ${IDX.b} + ${IDX.b} * d.longitud / ${IDX.avgdl})))
          AS score,
        COUNT(DISTINCT p.termid) AS terminos
      FROM read_parquet('indice_posting.parquet') p
      JOIN q USING (termid)
      JOIN read_parquet('indice_fragmento.parquet') d USING (docid)
      GROUP BY 1)
    SELECT f.tipo_ancla, f.pagina, f.texto, d.coleccion, d.url_publica, d.accesible,
           ROUND(punt.score, 2) AS score, punt.terminos,
           (SELECT COUNT(*) FROM punt) AS total
    FROM punt
    JOIN read_parquet('indice_fragmento.parquet') df ON df.docid = punt.docid
    JOIN v_fragmento f ON f.fragmento_id = df.fragmento_id
    JOIN v_documento d USING (blob_id)
    ${filtro ? `WHERE f.tipo_ancla = ${lit(filtro)}` : ''}
    ORDER BY punt.score DESC LIMIT 25`);

  const total = r.length ? Number(r[0].total) : 0;
  const partes = [`<strong>${num(total)}</strong> fragmentos coinciden; se muestran los ${Math.min(25, r.length)} de mayor relevancia.`];
  if (aproximadas.length) {
    partes.push(`No aparecen en el corpus tal cual: <em>${aproximadas.map(esc).join(', ')}</em>. `
      + `Se buscó por raíz aproximada.`);
  }
  if (traiaDigitos) {
    partes.push('Las cifras de la consulta se ignoraron: el índice no las contiene.');
  }
  resumen.innerHTML = partes.join(' ');

  cuerpo.innerHTML = r.map(x => {
    const ancla = x.tipo_ancla === 'PAGINA'
      ? `<code>página ${esc(x.pagina)}</code>`
      : `<code>documento</code>`;
    // La dirección viene calculada y verificada en el dato. Antes se armaba
    // aquí concatenando la ruta local, que lleva espacios donde el
    // repositorio público lleva guiones bajos: daba 404 en los 4.051
    // documentos que sí están subidos. Y donde no hay copia se dice, en vez
    // de ofrecer un enlace que no lleva a ninguna parte.
    const enlace = x.accesible && x.url_publica
      ? `<a href="${esc(x.url_publica)}" rel="noopener">abrir</a>`
      : `<span title="Esta colección no está publicada todavía">sin copia</span>`;
    return `<tr>
      <td>${ancla}</td><td>${esc(x.coleccion)}</td>
      <td>${esc(x.score)}<small> · ${esc(x.terminos)} térm.</small></td>
      <td>${resaltar(x.texto, palabras)}</td>
      <td>${enlace}</td></tr>`;
  }).join('') || '<tr><td colspan="5">Sin coincidencias con el filtro aplicado.</td></tr>';
}

/** Recorta alrededor de la primera coincidencia y la resalta. */
function resaltar(texto, palabras) {
  const plano = String(texto || '').replace(/\s+/g, ' ');
  const sin = normaliza(plano);
  let pos = -1;
  for (const w of palabras) {
    const raiz = w.slice(0, Math.max(4, w.length - 3));
    const i = sin.indexOf(raiz);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  const desde = Math.max(0, pos - 60);
  const trozo = plano.slice(desde, desde + 220);
  let html = esc((desde ? '…' : '') + trozo + (plano.length > desde + 220 ? '…' : ''));
  for (const w of palabras) {
    const raiz = w.slice(0, Math.max(4, w.length - 3));
    html = html.replace(new RegExp(`(${raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*)`, 'gi'),
                        '<mark>$1</mark>');
  }
  return html;
}

(async()=>{
  try {
    const db = await setupDb();
    const base = new URL('.', location.href).href;
    await loadParquetCorpus(db, base);
    await loadEdicionVigente(db, base);
  } catch(e) {
    console.info('DuckDB-WASM no disponible; se mantiene el modo JSON:', e.message);
  }
})();
