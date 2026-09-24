// Pinta la pestaña de actuaciones y calidad desde el análisis consolidado.
//
// Antes leía `rivas_jem_20260824.json`, el informe del 24 de agosto, con su
// propio corpus de 3.964 documentos y 8.355 votos, mientras el resto del sitio
// consultaba la edición vigente con 4.627 y 9.956. Dos análisis del mismo hecho
// en la misma pantalla.
//
// Ahora lee `analisis-vigente.json`, calculado desde el mismo Parquet que
// consulta DuckDB-WASM en las demás pestañas. Una sola cifra por hecho.
(() => {
  const P = window.PortalStats || {};
  const esc = P.esc || ((s) => String(s ?? ''));
  const chart = P.chart || (() => {});
  const n = (v) => Number(v || 0).toLocaleString('es-PY');
  const pct = (v) => (Number(v || 0) * 100).toLocaleString('es-PY',
    { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  const ESTADO = {
    RESUELTO:      { etiqueta: 'Resuelto',       clase: 'ok' },
    MEJORADO:      { etiqueta: 'Mejorado',       clase: 'neutral' },
    VIGENTE:       { etiqueta: 'Sigue vigente',  clase: 'warning' },
    NO_LOCALIZADA: { etiqueta: 'No localizada',  clase: 'neutral' }
  };

  // Pinta la cola de revisión traducida y contrastada.
  //
  // Esta función faltaba. El commit que tradujo la cola añadió la llamada y no
  // el cuerpo, de modo que `pintarCola` lanzaba ReferenceError, la promesa se
  // rechazaba y el `.catch()` pintaba la reserva en inglés. El resultado es que
  // la traducción nunca llegó a verse: el sitio publicado mostraba
  // `SYSTEMIC_TRACEABILITY_FAILURE` en una página en castellano, y los cuatro
  // contadores de arriba se quedaban en «—».
  function pintarCola(datos, tbody) {
    const inc = datos.incidencias || [];
    const r = datos.resumen || {};
    setText('colaResuelto', r.RESUELTO || 0);
    setText('colaMejorado', r.MEJORADO || 0);
    setText('colaVigente', r.VIGENTE || 0);
    setText('colaNoLoc', r.NO_LOCALIZADA || 0);

    // Las 40 decisiones cuyo texto expresa disidencia sin que se extrajera
    // ninguna. Es el hallazgo más revelador de la cola, y el conteo se deriva
    // de los datos en vez de escribirse a mano.
    const disidencia = inc.filter(x => /isidencia/.test(x.categoria || ''));
    const resueltas = disidencia.filter(x => x.estado !== 'VIGENTE').length;
    setText('colaDisResueltas', resueltas);
    setText('colaDisVigentes', disidencia.length - resueltas);

    const selEstado = document.getElementById('colaEstado');
    const selPrio = document.getElementById('colaPrioridad');

    function render() {
      const e = selEstado?.value || '';
      const p = selPrio?.value || '';
      // Se filtra por la prioridad en castellano, no por el código original
      // en inglés. El `<option value="P0_BLOCKER">` obligaba a que esas
      // cadenas vivieran en el HTML de una página en castellano, y el JSON ya
      // trae las dos: el código queda como procedencia en el archivo, no en
      // la interfaz.
      const filas = inc.filter(x => (!e || x.estado === e)
                                 && (!p || x.prioridad === p));
      if (!filas.length) {
        tbody.innerHTML = '<tr><td colspan="5">Ninguna incidencia con ese filtro.</td></tr>';
        return;
      }
      tbody.innerHTML = filas.map(x => {
        const s = ESTADO[x.estado] || { etiqueta: x.estado, clase: 'neutral' };
        return `<tr>
          <td><span class="status-badge ${s.clase}">${esc(s.etiqueta)}</span></td>
          <td><span class="priority-chip">${esc(x.prioridad)}</span></td>
          <td><strong>${esc(x.categoria)}</strong><small>${esc(x.motivo || '')}</small></td>
          <td>${esc(x.causa || '—')}</td>
          <td>${esc(x.comprobacion || '—')}</td>
        </tr>`;
      }).join('');
    }

    [selEstado, selPrio].forEach(el => el && el.addEventListener('change', render));
    render();
  }

  async function load() {
    const base = window.PORTAL_CONFIG?.analysisBase || 'data/analysis/';
    const response = await fetch(base + 'analisis-vigente.json');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const d = await response.json();

    // El estado ya no es una etiqueta heredada del informe: se deriva de lo
    // que de verdad limita al corpus hoy, que es la verificación humana.
    setText('indStatus', 'Sin verificación humana');
    setText('indNote', d.nota);

    const ponencias = (d.roles.find(x => x.rol === 'Ponente') || {}).filas || 0;
    setText('indActions', n(d.integrante.votos));
    setText('indCases', n(d.integrante.causas));
    setText('indPonencias', n(ponencias));
    setText('indVariantes', n(d.integrante.variantes_ocr_fusionadas));

    chart('chartRivasRoles', {
      title: { text: 'Cómo se registró cada actuación', left: 'center' },
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { type: 'scroll', bottom: 0 },
      series: [{
        type: 'pie',
        radius: ['38%', '68%'],
        center: ['50%', '46%'],
        data: d.roles.map(x => ({ name: x.rol, value: x.filas }))
      }]
    });

    chart('chartRivasYears', {
      title: { text: 'Actuaciones por año', left: 'center' },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: d.actuaciones_por_anio.map(x => x.anio) },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data: d.actuaciones_por_anio.map(x => x.valor) }]
    });

    // Fiabilidad del fechado. Sustituye al gráfico que comparaba los turnos
    // textuales del informe de agosto con su tabla de votos: esa brecha era un
    // defecto del pipeline anterior y hoy no existe, de modo que el gráfico
    // sólo podía mostrar un 100 % sin contenido.
    const f = d.fechado;
    chart('chartFechado', {
      title: { text: 'Qué campo fecha mejor una resolución', left: 'center' },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: ['Año del número', 'Año de la fecha'] },
      yAxis: { type: 'value', max: f.resoluciones_comparables },
      series: [{
        type: 'bar',
        data: [f.acierta_anio_de_numero, f.acierta_anio_de_fecha],
        label: { show: true, position: 'top',
                 formatter: (x) => pct(x.value / f.resoluciones_comparables) }
      }]
    });
    setText('fecComparables', n(f.resoluciones_comparables));
    setText('fecNumero', pct(f.acierta_anio_de_numero / f.resoluciones_comparables));
    setText('fecFecha', pct(f.acierta_anio_de_fecha / f.resoluciones_comparables));
    setText('fecTestigo', f.testigo);

    setText('qMissingCase', n(d.corpus.documentos_sin_causa));
    setText('qOrganMismatch', n(d.organo.resoluciones_con_presentes_menores_que_votos));
    setText('qQuorum', n(d.organo.quorum['Incompleto por extracción'] || 0));
    setText('qEvidencePath', n(d.trazabilidad.votos_sin_pagina));

    setText('dictTotal', n(d.dictamenes.documentos));
    setText('dictLinks', n(d.dictamenes.relaciones_derivadas));
    setText('dictLinked', n(d.dictamenes.dictamenes_distintos_vinculados));
    setText('dictSinCorresp', n(d.dictamenes.por_determinacion['Sin correspondencia'] || 0));
    setText('dictNota', d.dictamenes.nota_concordancia);

    chart('chartDictamenDeterminacion', {
      title: { text: 'Firmeza del vínculo dictamen–resolución', left: 'center' },
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { type: 'scroll', bottom: 0 },
      series: [{
        type: 'pie',
        radius: ['38%', '68%'],
        center: ['50%', '46%'],
        data: Object.entries(d.dictamenes.por_determinacion)
          .map(([k, v]) => ({ name: k, value: v }))
      }]
    });

    // Las doce métricas que el portal mostraba bajo una sola etiqueta,
    // `NO_DETERMINABLE`, como si todas fallaran por el mismo motivo. Se
    // agrupan por CAUSA, porque «no calculable» y «no calculado todavía» no
    // son lo mismo. La clasificación y los valores vienen ya calculados en el
    // JSON: antes estaban fijos aquí y habían envejecido —decían «110
    // integrantes» cuando tras la fusión son 50—.
    const nd = document.getElementById('ndMetrics');
    if (nd && d.metricas_indeterminables) {
      const { causas, orden, metricas } = d.metricas_indeterminables;
      const ordenadas = metricas.slice()
        .sort((a, b) => orden.indexOf(a.causa) - orden.indexOf(b.causa));
      let ultimo = null;
      nd.innerHTML = ordenadas.map(x => {
        const c = causas[x.causa];
        const cabecera = x.causa !== ultimo
          ? `<div class="nd-group"><span class="status-badge ${c.clase}">${esc(c.etiqueta)}</span>
             <p>${esc(c.nota)}</p></div>` : '';
        ultimo = x.causa;
        return cabecera + `<div class="nd-card"><span>${esc(x.metrica)}</span>
          <strong>${x.valor ? esc(x.valor) : 'NO_DETERMINABLE'}</strong></div>`;
      }).join('');
    }

    // La cola de revisión traducida y contrastada. Ya no hay reserva en
    // inglés: el archivo original en inglés sigue descargable como fuente
    // primaria, pero no se pinta. Si esto falla, se dice que falló en vez de
    // rellenar la tabla con texto que el visitante no puede leer.
    const review = document.getElementById('reviewRows');
    if (review) {
      fetch(base + 'cola-revision-auditada.json')
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(a => pintarCola(a, review))
        .catch(e => {
          review.innerHTML = `<tr><td colspan="5">No se pudo cargar la cola de
            revisión: ${esc(e.message)}</td></tr>`;
        });
    }

    // Lo único del corpus que verificó una persona leyendo las resoluciones.
    const hv = d.hallazgos_verificados_por_persona.casos;
    const dis = hv.find(x => x.tipo === 'Disidencia verificada');
    const div = hv.find(x => x.tipo === 'Votación dividida');
    if (dis) {
      setText('dissentDecision', `${dis.resolucion} · causa ${dis.causa}`);
      setText('dissentFinding', dis.hallazgo);
    }
    if (div) {
      setText('splitDecision', `${div.resolucion} · causa ${div.causa}`);
      setText('splitFinding', div.hallazgo);
    }
    setText('hvProcedencia', d.hallazgos_verificados_por_persona.procedencia);

    const dec = document.getElementById('decisivenessRows');
    if (dec) {
      dec.innerHTML = d.decisividad.casos.map(x => `<tr>
        <td>${esc(x.resolucion)}</td>
        <td>${esc(x.causa)}</td>
        <td>${esc(x.votos_alineados)}</td>
        <td>${esc(x.sin_el_integrante)}</td>
        <td>${esc(x.regla)}</td>
        <td><span class="status-badge ok">${esc(x.clasificacion)}</span></td>
      </tr>`).join('');
    }
    setText('decProcedencia', d.decisividad.procedencia);
  }

  load().catch(err => {
    console.error('No se pudo cargar el análisis consolidado:', err);
    setText('indStatus', 'ERROR CARGANDO EL ANÁLISIS');
    setText('indNote', 'No se pudo abrir data/analysis/analisis-vigente.json');
  });
})();
