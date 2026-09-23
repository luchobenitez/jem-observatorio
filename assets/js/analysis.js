(() => {
  const P = window.PortalStats || {};
  const $ = P.$ || ((s) => document.querySelector(s));
  const esc = P.esc || ((s) => String(s ?? ''));
  const chart = P.chart || (() => {});
  const n = (v) => Number(v || 0).toLocaleString('es-PY');

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function statusClass(value) {
    if (String(value).includes('NO_DETERMINABLE')) return 'nd-chip';
    return 'status-badge neutral';
  }

  async function load() {
    const base = window.PORTAL_CONFIG?.analysisBase || 'data/analysis/';
    const response = await fetch(base + 'rivas_jem_20260824.json');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const d = await response.json();

    setText('indStatus', d.metadata.status.replaceAll('_', ' '));
    setText('indNote', d.metadata.note);

    setText('indActions', n(d.rivas.action_rows));
    setText('indCases', n(d.rivas.distinct_valid_case_ids));
    setText('indTurns', n(d.vote_extraction.decisions_with_explicit_rivas_speaking_turn));
    setText('indDissents', '≥ ' + n(d.rivas.verified_explicit_dissents_minimum));

    chart('chartRivasRoles', {
      title: { text: 'Roles derivados de Rivas', left: 'center' },
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { type: 'scroll', bottom: 0 },
      series: [{
        type: 'pie',
        radius: ['38%', '68%'],
        center: ['50%', '46%'],
        data: d.roles.map(x => ({ name: x.role, value: x.rows }))
      }]
    });

    chart('chartRivasYears', {
      title: { text: 'Actuaciones derivadas por año', left: 'center' },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: d.rivas_actions_by_year.map(x => x.year) },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data: d.rivas_actions_by_year.map(x => x.value) }]
    });

    chart('chartVoteCoverage', {
      title: { text: 'Turnos explícitos de Rivas vs tabla votes', left: 'center' },
      tooltip: { trigger: 'item' },
      series: [{
        type: 'pie',
        radius: ['42%', '72%'],
        data: [
          { name: 'Con fila de voto', value: d.vote_extraction.explicit_rivas_turns_with_vote_row },
          { name: 'Sin fila de voto', value: d.vote_extraction.explicit_rivas_turns_without_vote_row }
        ]
      }]
    });

    setText('indVoteRows', n(d.corpus.vote_rows));
    setText('indDissentLanguage', n(d.vote_extraction.decisions_with_dissent_language));
    setText('indTurnsCovered', n(d.vote_extraction.explicit_rivas_turns_with_vote_row));
    setText('indTurnsMissing', n(d.vote_extraction.explicit_rivas_turns_without_vote_row));

    setText('qMissingCase', n(d.corpus.documents_without_valid_case));
    setText('qOrganMismatch', n(d.organ_and_quorum.decisions_with_present_members_below_votes_cast));
    setText('qQuorum', n(d.organ_and_quorum.decisions_marked_quorum_invalid));
    setText('qEvidencePath', n(d.traceability.evidence_spans_without_file_path));

    setText('dictTotal', n(d.dictamenes.total));
    setText('dictLinks', n(d.dictamenes.link_rows));
    setText('dictLinked', n(d.dictamenes.distinct_dictamenes_linked));
    setText('dictTemporalFail', n(d.dictamenes.links_failing_strict_temporal_or_date_control));

    chart('chartDictamenRecommendations', {
      title: { text: 'Recomendación normalizada en dictámenes', left: 'center' },
      tooltip: { trigger: 'item' },
      legend: { type: 'scroll', bottom: 0 },
      series: [{
        type: 'pie',
        radius: ['38%', '68%'],
        center: ['50%', '46%'],
        data: d.dictamenes.recommendations.map(x => ({name:x.label, value:x.value}))
      }]
    });

    // Las doce métricas del informe de agosto venían bajo una sola etiqueta,
    // como si fallaran por el mismo motivo. Se clasifican por CAUSA, porque
    // «no calculable» y «no calculado todavía» son cosas distintas y sólo una
    // de las dos es un límite del corpus.
    //
    // Contrastado contra la edición vigente el 23/09/2026: una ya está
    // resuelta —y de hecho se publica en la pestaña de Votos, de modo que el
    // panel se contradecía con el resto del sitio—.
    const MOTIVO = {
      resuelto: {
        etiqueta: 'YA RESUELTO', clase: 'ok',
        nota: 'Calculado en la edición vigente. Ver la pestaña «Votos y decisividad».'
      },
      instrumento: {
        etiqueta: 'MEDIRÍA LA HERRAMIENTA', clase: 'warning',
        nota: 'Se puede calcular, pero el extractor sólo reconoce ponencia, adhesión y '
            + 'disidencia, y «adhesión» significa acuerdo. El resultado describiría la '
            + 'expresión regular, no la conducta del juzgador.'
      },
      sin_dato: {
        etiqueta: 'SIN DATO EN EL CORPUS', clase: 'warning',
        nota: 'El texto de las resoluciones no registra este hecho. No es que se haya '
            + 'perdido en la extracción: no está escrito en el documento.'
      },
      bloqueado: {
        etiqueta: 'BLOQUEADO', clase: 'warning',
        nota: 'Exige saber quién podía votar, quién estaba presente y qué mayoría regía. '
            + '655 de 1.670 resoluciones tienen quórum incompleto por extracción.'
      },
      pendiente: {
        etiqueta: 'PENDIENTE DE TRABAJO', clase: 'neutral',
        nota: 'Hacible: el vínculo dictamen-resolución existe en 1.202 casos. Falta '
            + 'extraer la recomendación del dictamen para poder compararla.'
      }
    };
    const CLASIFICACION = {
      'total_votos_identificables': ['resuelto', '9.956 votos · 110 integrantes'],
      'total_votos_mayoria': ['instrumento', 'daría 9.949'],
      'total_votos_minoria': ['instrumento', 'daría 7'],
      'total_disidencias (mínimo verificado: 1)': ['instrumento', 'daría 7'],
      'agreement_with_majority_rate': ['instrumento', 'daría 99,93 %'],
      'dissent_rate': ['instrumento', 'daría 0,070 %'],
      'total_abstenciones': ['sin_dato', 'el esquema no tiene la categoría'],
      'abstention_rate': ['sin_dato', 'el esquema no tiene la categoría'],
      'total_ausencias': ['sin_dato', 'el texto no declara ausencias'],
      'total_votos_pivotal': ['bloqueado', ''],
      'pivotal_vote_rate': ['bloqueado', ''],
      'concordance_rate dictamen-resolución': ['pendiente', '']
    };
    const ORDEN = ['resuelto', 'pendiente', 'bloqueado', 'sin_dato', 'instrumento'];

    const nd = document.getElementById('ndMetrics');
    if (nd) {
      const metricas = d.non_determinable_metrics.slice()
        .sort((a, b) => ORDEN.indexOf((CLASIFICACION[a] || ['instrumento'])[0])
                      - ORDEN.indexOf((CLASIFICACION[b] || ['instrumento'])[0]));
      let ultimo = null;
      nd.innerHTML = metricas.map(x => {
        const [clave, valor] = CLASIFICACION[x] || ['instrumento', ''];
        const m = MOTIVO[clave];
        const cabecera = clave !== ultimo
          ? `<div class="nd-group"><span class="status-badge ${m.clase}">${m.etiqueta}</span>
             <p>${esc(m.nota)}</p></div>` : '';
        ultimo = clave;
        return cabecera + `<div class="nd-card"><span>${esc(x)}</span>
          <strong>${valor ? esc(valor) : 'NO_DETERMINABLE'}</strong></div>`;
      }).join('');
    }

    const review = document.getElementById('reviewRows');
    if (review) {
      const priorityRows = d.review_queue.filter(x =>
        String(x.priority).startsWith('P0')
      ).slice(0, 12);
      review.innerHTML = priorityRows.map(x => `<tr>
        <td><span class="priority-chip">${esc(x.priority)}</span></td>
        <td>${esc(x.category)}</td>
        <td>${esc(x.case_id || '—')}</td>
        <td>${esc(x.decision_id || '—')}</td>
        <td>${esc(x.risk_reason || '—')}</td>
      </tr>`).join('');
    }

    const diss = d.verified_cases.dissent;
    setText('dissentDecision', `${diss.decision} · causa ${diss.case_id}`);
    setText('dissentFinding', diss.finding);

    const split = d.verified_cases.split_vote;
    setText('splitDecision', `${split.decision} · causa ${split.case_id}`);
    setText('splitFinding', split.finding);

    const dec = document.getElementById('decisivenessRows');
    if (dec) {
      dec.innerHTML = d.decisiveness_cases.map(x => `<tr>
        <td>${esc(x.decision)}</td>
        <td>${esc(x.case_id)}</td>
        <td>${esc(x.aligned_votes)}</td>
        <td>${esc(x.without_rivas)}</td>
        <td>${esc(x.rule)}</td>
        <td><span class="status-badge ok">${esc(x.classification)}</span></td>
      </tr>`).join('');
    }
  }

  load().catch(err => {
    console.error('No se pudo cargar el informe independiente:', err);
    setText('indStatus', 'ERROR CARGANDO INFORME');
    setText('indNote', 'No se pudo abrir data/analysis/rivas_jem_20260824.json');
  });
})();
