// Estado del filtro de período, compartido por toda la página.
//
// Qué filtra y por qué ése
// ------------------------
// Deja sólo las resoluciones en las que votó el integrante estudiado: 1.078 de
// 1.816. La alternativa evidente —filtrar por los años en que ejerció— se midió
// y se descartó: entre 2020 y 2023 caen 9.917 de los 9.956 votos del corpus, el
// 99,6 %. Ese botón habría quitado 39 votos de 9.956 y el visitante no habría
// visto cambiar nada.
//
// El recorte que sí responde una pregunta es éste, porque permite comparar cómo
// votó el órgano en los casos en que él estuvo contra los 738 en que no.
//
// Cómo se propaga
// ---------------
// Un solo estado, en la URL, y los tres archivos de JavaScript se suscriben.
// Sin esto cada pestaña habría llevado su propio interruptor y el visitante
// podría haber dejado una filtrada y otra sin filtrar, que es la misma
// contradicción que el portal acaba de quitarse de encima con las ediciones.
(() => {
  const PARAM = 'periodo';

  const estado = {
    activo: new URLSearchParams(location.search).get(PARAM) === '1',
    entidades: [],       // se rellena al cargar el análisis
    definicion: '',
    alcance: null,
  };

  const suscriptores = [];

  function notificar() {
    for (const fn of suscriptores) {
      try { fn(estado.activo); }
      catch (e) { console.error('Un suscriptor del filtro falló:', e); }
    }
    document.body.classList.toggle('filtro-periodo-activo', estado.activo);
    for (const el of document.querySelectorAll('[data-filtro-etiqueta]')) {
      el.textContent = estado.activo
        ? 'resoluciones con Hernán Rivas'
        : 'corpus completo';
    }
  }

  window.JemFiltro = {
    get activo() { return estado.activo; },
    get entidades() { return estado.entidades; },
    get alcance() { return estado.alcance; },

    /** Declara los datos del filtro. Los entrega `analisis-vigente.json`, que
     *  los deriva del mapa de fusión: fijar los ids acá los dejaría obsoletos
     *  en cuanto se aprobara una fusión nueva. */
    declarar(bloque) {
      if (!bloque) return;
      estado.entidades = bloque.entidades || [];
      estado.definicion = bloque.definicion || '';
      estado.alcance = bloque.alcance || null;
      // Cada página cuenta en su propia unidad: estadísticas en resoluciones,
      // el repositorio en documentos. Decir «1.078 de 1.816 resoluciones» en
      // una página que lista archivos sería una cifra correcta en el lugar
      // equivocado.
      estado.unidad = bloque.unidad
        || (bloque.alcance && Object.keys(bloque.alcance)[0])
        || 'resoluciones';
      notificar();
    },

    cambiar(activo) {
      if (estado.activo === activo) return;
      estado.activo = activo;
      const url = new URL(location.href);
      if (activo) url.searchParams.set(PARAM, '1');
      else url.searchParams.delete(PARAM);
      // Se reemplaza en vez de apilar: el botón no es navegación y llenar el
      // historial de estados obligaría a pulsar «atrás» una vez por cada vez
      // que se tocó el interruptor.
      history.replaceState(null, '', url);
      notificar();
    },

    alCambiar(fn) {
      suscriptores.push(fn);
      return fn;
    },

    /** Predicado SQL para las consultas de DuckDB.
     *  `columna` es la que lleva el id de resolución en la consulta que llama. */
    sqlResoluciones(columna = 'resolucion_id') {
      if (!estado.activo || !estado.entidades.length) return '';
      return `${columna} IN (SELECT DISTINCT resolucion_id FROM read_parquet('voto.parquet')`
           + ` WHERE entidad_id IN (${estado.entidades.join(',')}))`;
    },

    /** Predicado para las consultas que parten del documento. */
    sqlDocumentos(columna = 'blob_id') {
      if (!estado.activo || !estado.entidades.length) return '';
      return `${columna} IN (SELECT r.document_id FROM read_parquet('resolucion.parquet') r`
           + ` WHERE r.resolucion_id IN (SELECT DISTINCT resolucion_id`
           + ` FROM read_parquet('voto.parquet') WHERE entidad_id IN (${estado.entidades.join(',')})))`;
    },

    /** Añade el predicado a una lista de condiciones WHERE, si está activo. */
    aplicar(condiciones, tipo = 'resoluciones', columna = null) {
      const p = tipo === 'documentos'
        ? this.sqlDocumentos(columna || 'blob_id')
        : this.sqlResoluciones(columna || 'resolucion_id');
      if (p) condiciones.push(p);
      return condiciones;
    },
  };

  // El interruptor se monta donde la página declare un hueco para él.
  document.addEventListener('DOMContentLoaded', () => {
    for (const hueco of document.querySelectorAll('[data-filtro-control]')) {
      hueco.innerHTML = `
        <label class="filtro-periodo">
          <input type="checkbox" ${estado.activo ? 'checked' : ''}>
          <span>Sólo resoluciones con Hernán Rivas</span>
        </label>
        <p class="filtro-nota">
          <strong data-filtro-alcance>—</strong>
          <span data-filtro-explica></span>
        </p>`;
      hueco.querySelector('input').addEventListener('change', (e) => {
        window.JemFiltro.cambiar(e.target.checked);
      });
    }
    window.JemFiltro.alCambiar(() => {
      for (const el of document.querySelectorAll('[data-filtro-control] input')) {
        el.checked = estado.activo;
      }
      for (const el of document.querySelectorAll('[data-filtro-alcance]')) {
        const a = estado.alcance;
        const u = estado.unidad || 'resoluciones';
        const n = a && a[u];
        if (!n) { el.textContent = ''; continue; }
        el.textContent = estado.activo
          ? `${n.periodo.toLocaleString('es-PY')} de `
            + `${n.todo.toLocaleString('es-PY')} ${u}`
          : `${n.todo.toLocaleString('es-PY')} ${u}`;
      }
      for (const el of document.querySelectorAll('[data-filtro-explica]')) {
        el.textContent = estado.activo
          ? '· todas las cifras de esta página se recalculan sobre ese recorte'
          : '· corpus completo, todos los integrantes';
      }
    });
    notificar();
  });
})();
