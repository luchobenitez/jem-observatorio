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

    const nd = document.getElementById('ndMetrics');
    if (nd) {
      nd.innerHTML = d.non_determinable_metrics.map(x =>
        `<div class="nd-card"><span>${esc(x)}</span><strong>NO_DETERMINABLE</strong></div>`
      ).join('');
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
