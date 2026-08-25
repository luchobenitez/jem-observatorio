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

(async()=>{
  try {
    const db = await setupDb();
    const base = new URL('.', location.href).href;
    await loadParquetCorpus(db, base);
    await loadVotes(db, base);
  } catch(e) {
    console.info('DuckDB-WASM no disponible; se mantiene el modo JSON:', e.message);
  }
})();
