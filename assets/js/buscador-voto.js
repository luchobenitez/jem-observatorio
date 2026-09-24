// Buscador de voto: qué expedientes votó cada integrante, y con qué sentido.
//
// Consulta la misma edición que el resto del sitio, con DuckDB-WASM sobre los
// Parquet publicados. Nada sale del navegador: ni la elección de integrante ni
// el término que se escriba.
//
// Por qué agrupa por `entidad_final` y no por `entidad_id`
// --------------------------------------------------------
// `voto.entidad_id` trae las 118 entidades que reconoció el extractor, y
// detrás hay unas cincuenta personas: el OCR partió los nombres en variantes
// —«Hemán», «Her nán», «Hernán Davis»—. La correspondencia se publica ya
// resuelta en `entidad_resuelta.parquet`, calculada por el mismo código que
// produce `metrica_juez`. Resolverla acá con SQL recursivo habría creado una
// segunda definición de quién es quién, y la fusión encadena —44 → 53 → 12—,
// de modo que una implementación a medias agruparía distinto que el resto del
// sitio sin que nada fallara.
import { abrirBase, registrar, edicionVigente, filas, numero }
  from './duckdb-base.js';

const CFG = window.PORTAL_CONFIG || { jemSilverBase: 'data/jem-silver/' };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const n = (v) => Number(v || 0).toLocaleString('es-PY');

// Cómo se nombra cada sentido en la interfaz. El dato los guarda en mayúsculas
// porque son un vocabulario controlado; la página no tiene por qué gritarlos.
const SENTIDO = {
  PONENTE: 'Ponencia',
  ADHESION: 'Adhesión',
  DISIDENCIA: 'Disidencia',
};

const TABLAS = ['voto', 'resolucion', 'vinculo', 'causa', 'documento_logico',
                'documento', 'metrica_juez', 'entidad_resuelta'];

const LIMITE = 300;   // filas pintadas de una vez

let conn = null;
let estado = { integrante: '', sentido: '', texto: '' };
let cache = [];       // último resultado crudo, para filtrar por texto sin reconsultar
let totales = { suyos: 0, con: 0 };   // votos del integrante, y los que llegan a un expediente

function pon(sel, texto) {
  const el = $(sel);
  if (el) el.textContent = texto;
}

/** Predicado del filtro de período, si está puesto. */
function filtroPeriodo() {
  const f = window.JemFiltro;
  if (!f?.activo || !f.entidades?.length) return '';
  return ` AND v.resolucion_id IN (SELECT DISTINCT resolucion_id
             FROM read_parquet('voto.parquet')
            WHERE entidad_id IN (${f.entidades.join(',')}))`;
}

async function cargarIntegrantes() {
  // La lista sale de `metrica_juez`, que ya trae una fila por persona con sus
  // votos. Contar sobre `voto` daría 110 nombres, muchos de ellos la misma
  // persona escrita de otra forma.
  const gente = await filas(conn, `
    SELECT entidad_id, nombre, votos, ponente, adhesion, disidencia
    FROM read_parquet('metrica_juez.parquet')
    WHERE votos > 0 ORDER BY votos DESC`);

  const sel = $('#bvIntegrante');
  sel.innerHTML = '<option value="">Elegí un integrante…</option>'
    + gente.map(g => `<option value="${g.entidad_id}">`
        + `${esc(g.nombre)} · ${n(numero(g.votos))} votos</option>`).join('');
  return gente;
}

/** Los sentidos, con el recuento del integrante elegido en cada opción.
 *
 *  Poner el número dentro de la opción no es decoración: sin él, elegir
 *  «Disidencia» y ver una tabla vacía se lee como «este juez nunca disintió»,
 *  cuando lo que significa es que el extractor casi no detecta disidencia. */
function pintarSentidos(g) {
  const sel = $('#bvSentido');
  if (!g) {
    sel.innerHTML = '<option value="">Todos</option>';
    return;
  }
  const total = numero(g.votos);
  const partes = [
    ['', 'Todos', total],
    ['PONENTE', SENTIDO.PONENTE, numero(g.ponente)],
    ['ADHESION', SENTIDO.ADHESION, numero(g.adhesion)],
    ['DISIDENCIA', SENTIDO.DISIDENCIA, numero(g.disidencia)],
  ];
  sel.innerHTML = partes.map(([v, etiqueta, cuantos]) =>
    `<option value="${v}">${etiqueta} · ${n(cuantos)}</option>`).join('');
  sel.value = estado.sentido;
}

async function consultar() {
  if (!estado.integrante) {
    cache = [];
    pintar();
    return;
  }
  const sent = estado.sentido
    ? ` AND v.sentido = '${estado.sentido.replace(/'/g, "''")}'` : '';

  // Una fila por expediente, que es lo que se pidió. Los documentos de cada
  // uno se agregan en una lista: un expediente no es un archivo, y el de más
  // actividad tiene seis resoluciones, cada una con el suyo.
  cache = await filas(conn, `
    SELECT cz.clave,
           count(DISTINCT v.voto_id)        AS votos,
           count(DISTINCT r.resolucion_id)  AS resoluciones,
           string_agg(DISTINCT v.sentido, '|')           AS sentidos,
           min(dl.titulo)                   AS titulo,
           string_agg(DISTINCT d.url_publica, '|')       AS urls
    FROM read_parquet('voto.parquet') v
    JOIN read_parquet('entidad_resuelta.parquet') er ON er.entidad_id = v.entidad_id
    JOIN read_parquet('resolucion.parquet') r  ON r.resolucion_id = v.resolucion_id
    JOIN read_parquet('vinculo.parquet') n     ON n.document_id = r.document_id
    JOIN read_parquet('causa.parquet') cz      ON cz.causa_id = n.causa_id
    LEFT JOIN read_parquet('documento_logico.parquet') dl ON dl.document_id = r.document_id
    LEFT JOIN read_parquet('documento.parquet') d ON d.blob_id = r.document_id
                                                 AND d.accesible
    WHERE er.entidad_final = ${Number(estado.integrante)}${sent}${filtroPeriodo()}
    GROUP BY 1
    ORDER BY votos DESC, cz.clave`);

  // Los totales NO se obtienen sumando la columna de arriba.
  //
  // 217 resoluciones están vinculadas a más de una causa, de modo que sumar
  // los votos por expediente cuenta dos veces los que caen en ellas: para
  // Rivas daba 1.241 donde los votos distintos son 1.018. El selector decía
  // 1.083 y la tabla 1.241, dos cifras del mismo hecho en la misma pantalla.
  //
  // Y hay una tercera: 1.083 son todos sus votos, 1.018 los que llegan a un
  // expediente. Los 65 de diferencia están en resoluciones sin causa
  // vinculada y **no aparecen en esta lista**. Callarlo sería perderlos.
  const tot = await filas(conn, `
    SELECT
      (SELECT count(DISTINCT v.voto_id) FROM read_parquet('voto.parquet') v
        JOIN read_parquet('entidad_resuelta.parquet') er ON er.entidad_id = v.entidad_id
       WHERE er.entidad_final = ${Number(estado.integrante)}${sent}${filtroPeriodo()}
      ) AS suyos,
      (SELECT count(DISTINCT v.voto_id) FROM read_parquet('voto.parquet') v
        JOIN read_parquet('entidad_resuelta.parquet') er ON er.entidad_id = v.entidad_id
        JOIN read_parquet('resolucion.parquet') r ON r.resolucion_id = v.resolucion_id
        JOIN read_parquet('vinculo.parquet') n ON n.document_id = r.document_id
       WHERE er.entidad_final = ${Number(estado.integrante)}${sent}${filtroPeriodo()}
      ) AS con_expediente`);
  totales = { suyos: numero(tot[0]?.suyos), con: numero(tot[0]?.con_expediente) };
  pintar();
}

function pintar() {
  const cuerpo = $('#bvFilas');
  const t = estado.texto.toLocaleLowerCase('es');
  const quitaTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const filtradas = t
    ? cache.filter(f => quitaTildes(`${f.clave || ''} ${f.titulo || ''}`.toLocaleLowerCase('es'))
                          .includes(quitaTildes(t)))
    : cache;

  if (!estado.integrante) {
    cuerpo.innerHTML = '<tr><td colspan="5">Elegí un integrante para empezar.</td></tr>';
    pon('#bvResumen', '—');
    pon('#bvLimite', '');
    return;
  }
  if (!filtradas.length) {
    cuerpo.innerHTML = '<tr><td colspan="5">Ningún expediente con esos criterios.</td></tr>';
  } else {
    cuerpo.innerHTML = filtradas.slice(0, LIMITE).map(f => {
      const urls = String(f.urls || '').split('|').filter(Boolean);
      const sentidos = String(f.sentidos || '').split('|').filter(Boolean)
        .map(s => SENTIDO[s] || s).join(', ');
      const enlaces = urls.length
        ? urls.slice(0, 3).map((u, i) => `<a href="${esc(u.replace('/resolve/main/', '/blob/main/'))}"
              target="_blank" rel="noopener">Ver${urls.length > 1 ? ' ' + (i + 1) : ''} ↗</a>`).join(' · ')
            + (urls.length > 3 ? ` <small>+${urls.length - 3}</small>` : '')
        : '<span class="pending-link">sin copia pública</span>';
      return `<tr>
        <td><strong>${esc(f.clave || '—')}</strong>
            <small class="repo-meta">${n(numero(f.resoluciones))} resolución(es)</small></td>
        <td>${esc(f.titulo || '—')}</td>
        <td>${n(numero(f.votos))}</td>
        <td>${esc(sentidos || '—')}</td>
        <td>${enlaces}</td>
      </tr>`;
    }).join('');
  }

  const conEnlace = filtradas.filter(f => f.urls).length;
  const sinExpediente = totales.suyos - totales.con;
  const parcial = estado.texto ? ' (filtrado por texto)' : '';
  pon('#bvResumen',
    `${n(filtradas.length)} expediente(s)${parcial} · `
    + `${n(totales.con)} de sus ${n(totales.suyos)} votos llegan a un expediente · `
    + `${n(conEnlace)} con documento abrible`
    + (filtradas.length - conEnlace
        ? ` · ${n(filtradas.length - conEnlace)} sin copia pública` : ''));
  const perdidos = $('#bvSinExpediente');
  if (perdidos) {
    perdidos.hidden = sinExpediente <= 0;
    const c = $('#bvSinExpedienteN');
    if (c) c.textContent = n(sinExpediente);
  }
  pon('#bvLimite', filtradas.length > LIMITE
    ? `Se muestran los primeros ${LIMITE}. Afiná con el filtro de texto.` : '');

  const aviso = $('#bvAvisoDisidencia');
  if (aviso) aviso.hidden = estado.sentido !== 'DISIDENCIA';
}

async function iniciar() {
  const base = new URL('.', location.href).href;
  const { edicion, baseEd } = await edicionVigente(base, CFG.jemSilverBase);
  const { db, conn: c } = await abrirBase();
  conn = c;
  for (const t of TABLAS) {
    await registrar(db, conn, `${t}.parquet`, new URL(baseEd + t + '.parquet', base).href);
  }

  const gente = await cargarIntegrantes();
  const porId = new Map(gente.map(g => [String(g.entidad_id), g]));
  const dis = await filas(conn,
    `SELECT count(*) c FROM read_parquet('voto.parquet') WHERE sentido = 'DISIDENCIA'`);
  pon('#bvDisTotal', n(numero(dis[0]?.c)));
  pon('#bvEstado', `Edición ${edicion} · ${n(gente.length)} integrantes con voto`);

  // El estado viaja en la dirección, igual que el filtro de período: una
  // consulta concreta tiene que poder citarse tal como se está viendo.
  const url = new URLSearchParams(location.search);
  estado.integrante = url.get('integrante') || '';
  estado.sentido = url.get('sentido') || '';
  $('#bvIntegrante').value = estado.integrante;
  pintarSentidos(porId.get(estado.integrante));

  function guardarEnLaUrl() {
    const u = new URL(location.href);
    estado.integrante ? u.searchParams.set('integrante', estado.integrante)
                      : u.searchParams.delete('integrante');
    estado.sentido ? u.searchParams.set('sentido', estado.sentido)
                   : u.searchParams.delete('sentido');
    history.replaceState(null, '', u);
  }

  $('#bvIntegrante').addEventListener('change', async (e) => {
    estado.integrante = e.target.value;
    estado.sentido = '';
    pintarSentidos(porId.get(estado.integrante));
    guardarEnLaUrl();
    await consultar();
  });
  $('#bvSentido').addEventListener('change', async (e) => {
    estado.sentido = e.target.value;
    guardarEnLaUrl();
    await consultar();
  });
  $('#bvTexto').addEventListener('input', (e) => {
    estado.texto = e.target.value.trim();
    pintar();
  });
  window.JemFiltro?.alCambiar(() => { consultar().catch(avisar); });

  await consultar();
}

function avisar(err) {
  console.error('Buscador de voto:', err);
  pon('#bvEstado', 'No se pudo cargar el corpus');
  $('#bvFilas').innerHTML =
    `<tr><td colspan="5">No se pudo consultar la edición publicada: ${esc(err.message)}.
     Los datos siguen disponibles en <a href="documentos.html">Documentos</a>.</td></tr>`;
}

iniciar().catch(avisar);
