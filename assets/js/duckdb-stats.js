import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm';
const P = window.PortalStats;
if (!P) throw new Error('PortalStats no inicializado');
const {$, esc, chart} = P;
const CFG = window.PORTAL_CONFIG || {
  portalDataBase:'data/portal/',
  jemSilverBase:'data/jem-silver/',
  catalogBase:'data/catalog/'
};
let conn = null, schema = new Set();
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

async function setupDb() {
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
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

async function loadParquetCorpus(db, base) {
  try {
    // Preferir la capa pública derivada porque agrega relative_path/download_url
    // sin modificar la capa JEM Silver.
    try {
      activeDocumentFile = 'document_public.parquet';
      await registerAndTest(
        db,
        activeDocumentFile,
        new URL(CFG.catalogBase + 'document_public.parquet', base).href
      );
    } catch (_) {
      activeDocumentFile = 'document.parquet';
      await registerAndTest(
        db,
        activeDocumentFile,
        new URL(CFG.jemSilverBase + 'document.parquet', base).href
      );
    }

    await registerAndTest(
      db,
      'causa.parquet',
      new URL(CFG.jemSilverBase + 'causa.parquet', base).href
    );

    const desc = await conn.query(
      `DESCRIBE SELECT * FROM read_parquet('${activeDocumentFile}')`
    );
    schema = new Set(desc.toArray().map(r => r.toJSON().column_name));

    const linkExpr = schema.has('download_url')
      ? "COALESCE(download_url,'') <> ''"
      : schema.has('relative_path')
        ? "COALESCE(relative_path,'') <> ''"
        : 'FALSE';

    const k = await conn.query(`SELECT
      (SELECT COUNT(*) FROM read_parquet('causa.parquet')) total_causas,
      COUNT(*) total_docs,
      AVG(${schema.has('body_quality') ? 'body_quality' : 'NULL'}) avg_quality,
      COUNT(CASE WHEN ${linkExpr} THEN 1 END) linkable
      FROM read_parquet('${activeDocumentFile}')`);
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

    const yf = $('#yearFilter'), tf = $('#typeFilter');
    yf.innerHTML = '<option value="">Todos los años</option>';
    tf.innerHTML = '<option value="">Todos los tipos</option>';

    if (schema.has('kind')) {
      const r = await conn.query(
        `SELECT kind,COUNT(*) c FROM read_parquet('${activeDocumentFile}')
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
         FROM read_parquet('${activeDocumentFile}')
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

    async function searchDocs() {
      const term = $('#docSearch').value || '';
      const year = yf.value, type = tf.value;
      const st = term.replaceAll("'","''");
      const sy = year.replaceAll("'","''");
      const sk = type.replaceAll("'","''");
      const wh = [];

      if (term && schema.has('body')) wh.push(`LOWER(body) LIKE LOWER('%${st}%')`);
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
        FROM read_parquet('${activeDocumentFile}')
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

async function loadVotes(db, base) {
  try {
    await registerAndTest(
      db,
      'votacion.parquet',
      new URL(CFG.jemSilverBase + 'votacion.parquet', base).href
    );
    await registerAndTest(
      db,
      'miembro_voto.parquet',
      new URL(CFG.jemSilverBase + 'miembro_voto.parquet', base).href
    );

    const vd = await conn.query("DESCRIBE SELECT * FROM read_parquet('votacion.parquet')");
    const vs = new Set(vd.toArray().map(r=>r.toJSON().column_name));
    const total = await conn.query("SELECT COUNT(*) n FROM read_parquet('votacion.parquet')");
    $('#voteTotal').textContent = Number(total.toArray()[0].toJSON().n).toLocaleString();

    if (vs.has('rivas_decisivo')) {
      const r = await conn.query(
        "SELECT COUNT(CASE WHEN rivas_decisivo THEN 1 END) n FROM read_parquet('votacion.parquet')"
      );
      $('#voteDecisive').textContent = Number(r.toArray()[0].toJSON().n||0).toLocaleString();
    }
    if (vs.has('hubo_desempate')) {
      const r = await conn.query(
        "SELECT COUNT(CASE WHEN hubo_desempate THEN 1 END) n FROM read_parquet('votacion.parquet')"
      );
      $('#voteTies').textContent = Number(r.toArray()[0].toJSON().n||0).toLocaleString();
    }

    const md = await conn.query(
      "DESCRIBE SELECT * FROM read_parquet('miembro_voto.parquet')"
    );
    const ms = new Set(md.toArray().map(r=>r.toJSON().column_name));
    if (ms.has('miembro')) {
      const r = await conn.query(
        "SELECT COUNT(DISTINCT miembro) n FROM read_parquet('miembro_voto.parquet')"
      );
      $('#voteMembers').textContent = Number(r.toArray()[0].toJSON().n||0).toLocaleString();
    }
    if (vs.has('resultado')) {
      const r=await conn.query(
        "SELECT resultado,COUNT(*) c FROM read_parquet('votacion.parquet') GROUP BY resultado ORDER BY c DESC"
      );
      const d=r.toArray().map(x=>x.toJSON());
      chart('chartOutcomes',{
        title:{text:'Resultados',left:'center'},
        xAxis:{type:'category',data:d.map(x=>x.resultado)},
        yAxis:{type:'value'},
        series:[{type:'bar',data:d.map(x=>Number(x.c))}]
      });
    }
    if (vs.has('margen_votos')) {
      const r=await conn.query(
        "SELECT CAST(margen_votos AS INT) margen,COUNT(*) c FROM read_parquet('votacion.parquet') GROUP BY margen ORDER BY margen"
      );
      const d=r.toArray().map(x=>x.toJSON());
      chart('chartMargins',{
        title:{text:'Distribución del margen de votos',left:'center'},
        xAxis:{type:'category',data:d.map(x=>x.margen)},
        yAxis:{type:'value'},
        series:[{type:'bar',data:d.map(x=>Number(x.c))}]
      });
    }
    $('#voteStatus').hidden = true;
    $('#voteDashboard').hidden = false;
  } catch (e) {
    console.info('Parquet de votaciones opcional no disponible:', e.message);
  }
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
    const uso = cfg.en_uso_por_la_interfaz;
    edicion = (typeof uso === 'string' ? uso : uso?.['tab-trazabilidad']) || cfg.vigente;
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

  const TABLAS = ['fragmento','documento','resolucion','voto','procedencia','campo'];
  try {
    for (const t of TABLAS) {
      await registerAndTest(db, `${t}.parquet`, new URL(baseEd + t + '.parquet', base).href);
    }
  } catch (e) {
    console.info('Edición vigente no disponible:', e.message);
    pon('#edicionEstado', 'Edición: no disponible');
    return;
  }

  window.__db = db;
  pon('#edicionEstado', `Edición ${edicion}`);
  ['#trzEdicion','#qrmEdicion','#prvEdicion'].forEach(s => pon(s, `Edición ${edicion}`));

  // ---- Banner permanente de validación -----------------------------
  // Es el indicador que ningún código puede mover: cuenta revisiones
  // humanas, y sólo una persona puede incrementarlo.
  const v = await uno(`SELECT COUNT(*) total,
      COUNT(CASE WHEN revision <> 'AUTO' THEN 1 END) revisados
      FROM read_parquet('campo.parquet')`);
  pon('#valTotal', num(v.total));
  pon('#valRevisados', num(v.revisados));

  await panelTrazabilidad();
  await panelQuorum();
  await panelProcedencia();
  await panelFair(base);
  await loadIndiceBM25(db, base, baseEd, indiceMeta);
}

async function panelTrazabilidad() {
  const t = await uno(`SELECT COUNT(*) fragmentos,
      COUNT(DISTINCT blob_id) documentos,
      COUNT(CASE WHEN tipo_ancla='PAGINA' AND anclado=1 THEN 1 END) ancladas,
      COUNT(CASE WHEN tipo_ancla='PAGINA' THEN 1 END) paginas
      FROM read_parquet('fragmento.parquet')`);
  pon('#trzFragmentos', num(t.fragmentos));
  pon('#trzDocumentos', num(t.documentos));
  pon('#trzAncladas', `${num(t.ancladas)} de ${num(t.paginas)}`);

  const vt = await uno(`SELECT COUNT(*) total, COUNT(pagina) con_pagina
      FROM read_parquet('voto.parquet')`);
  pon('#trzVotos', `${num(vt.con_pagina)} de ${num(vt.total)}`);

  const anclas = await filas(`SELECT tipo_ancla, COUNT(*) n
      FROM read_parquet('fragmento.parquet') GROUP BY 1 ORDER BY 2 DESC`);
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
      COUNT(*) n FROM read_parquet('fragmento.parquet')
      GROUP BY 1 ORDER BY CASE banda WHEN 'alta' THEN 1 WHEN 'media' THEN 2
        WHEN 'baja' THEN 3 WHEN 'muy baja' THEN 4 ELSE 5 END`);
  barras('chartBandas', 'Confianza del reconocimiento por fragmento', bandas, 'banda', 'n');

  const det = await filas(`SELECT f.tipo_ancla,
      COUNT(*) fragmentos, COUNT(DISTINCT f.blob_id) documentos,
      ROUND(SUM(LENGTH(f.texto))/1e6, 1) mb,
      STRING_AGG(DISTINCT d.extension, ', ') formatos
      FROM read_parquet('fragmento.parquet') f
      JOIN read_parquet('documento.parquet') d USING (blob_id)
      GROUP BY 1 ORDER BY 2 DESC`);
  $('#trzAnclaRows').innerHTML = det.map(r=>`<tr>
      <td><code>${esc(r.tipo_ancla)}</code></td><td>${num(r.fragmentos)}</td>
      <td>${num(r.documentos)}</td><td>${esc(r.mb)} MB</td>
      <td>${esc(r.formatos)}</td></tr>`).join('');

  const motores = await filas(`SELECT COALESCE(motor,'sin motor') motor, COUNT(*) n
      FROM read_parquet('fragmento.parquet') GROUP BY 1 ORDER BY 2 DESC`);
  barras('chartMotores', 'Fragmentos por motor de extracción', motores, 'motor', 'n');
}

async function panelQuorum() {
  const q = await uno(`SELECT
      COUNT(CASE WHEN estado_votos='CON_VOTOS' THEN 1 END) con_votos,
      COUNT(CASE WHEN quorum='COMPLETO' THEN 1 END) completo,
      COUNT(CASE WHEN quorum='INCOMPLETO_POR_EXTRACCION' THEN 1 END) incompleto,
      COUNT(CASE WHEN quorum='NO_DETERMINABLE' THEN 1 END) nodet
      FROM read_parquet('resolucion.parquet')`);
  pon('#qrmConVotos', num(q.con_votos));
  pon('#qrmCompleto', num(q.completo));
  pon('#qrmIncompleto', num(q.incompleto));
  pon('#qrmNoDet', num(q.nodet));

  const quorum = await filas(`SELECT COALESCE(quorum,'sin_calcular') quorum, COUNT(*) n
      FROM read_parquet('resolucion.parquet') GROUP BY 1 ORDER BY 2 DESC`);
  barras('chartQuorum', 'Estado del quórum por resolución', quorum, 'quorum', 'n');

  const sentido = await filas(`SELECT COALESCE(sentido,'sin_calcular') sentido, COUNT(*) n
      FROM read_parquet('resolucion.parquet') GROUP BY 1 ORDER BY 2 DESC`);
  barras('chartSentido', 'Sentido de la decisión', sentido, 'sentido', 'n');

  const verbos = await filas(`SELECT verbo, COUNT(*) n
      FROM read_parquet('resolucion.parquet') WHERE verbo IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
  $('#qrmVerboRows').innerHTML = verbos.map(r=>`<tr>
      <td>${esc(r.verbo)}</td><td>${num(r.n)}</td></tr>`).join('');

  const d = await uno(`SELECT COUNT(*) n FROM read_parquet('voto.parquet')
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

  const docs = await uno(`SELECT COUNT(*) n FROM read_parquet('documento.parquet')`);
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
      FROM read_parquet('documento.parquet') GROUP BY 1 ORDER BY 2 DESC`);
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
    SELECT f.tipo_ancla, f.pagina, f.texto, d.coleccion, d.ruta, d.sha256,
           ROUND(punt.score, 2) AS score, punt.terminos,
           (SELECT COUNT(*) FROM punt) AS total
    FROM punt
    JOIN read_parquet('indice_fragmento.parquet') df ON df.docid = punt.docid
    JOIN read_parquet('fragmento.parquet') f ON f.fragmento_id = df.fragmento_id
    JOIN read_parquet('documento.parquet') d USING (blob_id)
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

  const REPO = (window.PORTAL_CONFIG?.documentsRepoUrl) || '';
  cuerpo.innerHTML = r.map(x => {
    const ancla = x.tipo_ancla === 'PAGINA'
      ? `<code>página ${esc(x.pagina)}</code>`
      : `<code>documento</code>`;
    const enlace = REPO && x.ruta
      ? `<a href="${esc(REPO)}/resolve/main/${encodeURI(String(x.ruta))}" rel="noopener">abrir</a>`
      : `<span title="${esc(x.sha256||'')}">—</span>`;
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
    await loadVotes(db, base);
    await loadEdicionVigente(db, base);
  } catch(e) {
    console.info('DuckDB-WASM no disponible; se mantiene el modo JSON:', e.message);
  }
})();
