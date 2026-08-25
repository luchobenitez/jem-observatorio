(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const state = { docs: [], causes: [], sourceChartsLoaded: false };

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tab,.tab-panel').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#tab-' + b.dataset.tab)?.classList.add('active');
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  }));

  function chart(id, opt) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!window.echarts) {
      el.innerHTML = '<div class="empty-state"><p>El gráfico requiere conexión a la biblioteca ECharts. Los datos siguen disponibles en las tablas y KPI.</p></div>';
      return;
    }
    const old = window.echarts.getInstanceByDom(el);
    if (old) old.dispose();
    const c = window.echarts.init(el);
    c.setOption(opt);
    window.addEventListener('resize', () => c.resize(), { passive: true });
  }

  function populateFilters(docs) {
    const yf = $('#yearFilter'), tf = $('#typeFilter');
    if (!yf || !tf) return;
    const currentY = yf.value, currentT = tf.value;
    yf.innerHTML = '<option value="">Todos los años</option>';
    tf.innerHTML = '<option value="">Todos los tipos</option>';
    [...new Set(docs.map(d => d.year).filter(v => v !== null && v !== undefined && v !== ''))].sort().forEach(y => {
      yf.insertAdjacentHTML('beforeend', `<option value="${esc(y)}">${esc(y)}</option>`);
    });
    [...new Set(docs.map(d => d.kind).filter(Boolean))].sort().forEach(t => {
      tf.insertAdjacentHTML('beforeend', `<option value="${esc(t)}">${esc(t)}</option>`);
    });
    if ([...yf.options].some(o => o.value === currentY)) yf.value = currentY;
    if ([...tf.options].some(o => o.value === currentT)) tf.value = currentT;
  }

  function renderDocs() {
    const tbody = $('#docRows');
    if (!tbody) return;
    const term = ($('#docSearch')?.value || '').trim().toLocaleLowerCase('es');
    const year = $('#yearFilter')?.value || '';
    const type = $('#typeFilter')?.value || '';
    const rows = state.docs.filter(d => {
      const hay = `${d.caratula || ''} ${d.body || ''} ${d.kind || ''}`.toLocaleLowerCase('es');
      return (!term || hay.includes(term)) && (!year || String(d.year ?? '') === year) && (!type || (d.kind || '') === type);
    }).slice(0, 100);

    tbody.innerHTML = rows.map(d => {
      let snippet = String(d.body || '').replace(/\s+/g, ' ').trim();
      if (term) {
        const pos = snippet.toLocaleLowerCase('es').indexOf(term);
        if (pos >= 0) snippet = snippet.slice(Math.max(0, pos - 80), pos + term.length + 180);
      }
      if (snippet.length > 280) snippet = snippet.slice(0, 280) + '…';
      const quality = d.body_quality == null ? null : Number(d.body_quality);
      const path = d.relative_path ? String(d.relative_path).replace(/^\.?\//, '') : '';
      const href = path || d.source_url || '';
      return `<tr>
        <td>${esc(d.year ?? '—')}</td>
        <td>${esc(d.kind || '—')}</td>
        <td>${esc(d.caratula || 'Sin carátula')}</td>
        <td>${esc(snippet || '—')}</td>
        <td><span class="quality ${quality != null && quality > .8 ? 'q-high' : 'q-low'}">${quality == null ? 'N/A' : (quality * 100).toFixed(0) + '%'}</span></td>
        <td>${href ? `<a href="${esc(encodeURI(href))}" target="_blank" rel="noopener">Abrir ↗</a>` : '—'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6">Sin resultados para los filtros seleccionados.</td></tr>';
  }

  function renderBaseCorpus(docs, causes) {
    state.docs = docs;
    state.causes = causes;
    $('#kpiCausas').textContent = Number(causes.length).toLocaleString();
    $('#kpiDocs').textContent = Number(docs.length).toLocaleString();
    $('#kpiOcr').textContent = 'N/A';
    $('#kpiLinks').textContent = Number(docs.filter(d => d.relative_path || d.source_url).length).toLocaleString();
    if ($('#kpiCausasLabel')) $('#kpiCausasLabel').textContent = 'Casos estructurados';
    if ($('#kpiDocsLabel')) $('#kpiDocsLabel').textContent = 'Secciones indexadas';
    if ($('#kpiOcrLabel')) $('#kpiOcrLabel').textContent = 'Calidad OCR';
    populateFilters(docs);
    renderDocs();

    const byType = {};
    docs.forEach(d => { const k = d.kind || 'Desconocido'; byType[k] = (byType[k] || 0) + 1; });
    chart('chartTypes', {title:{text:'Secciones por tipo',left:'center'},tooltip:{trigger:'item'},series:[{type:'pie',radius:['40%','70%'],data:Object.entries(byType).map(([name,value])=>({name,value}))}]});

    const byYear = {};
    docs.forEach(d => { if (d.year != null && d.year !== '') byYear[d.year] = (byYear[d.year] || 0) + 1; });
    if (Object.keys(byYear).length) {
      const years = Object.keys(byYear).sort();
      chart('chartYears', {title:{text:'Secciones por año',left:'center'},tooltip:{trigger:'axis'},xAxis:{type:'category',data:years},yAxis:{type:'value'},series:[{type:'bar',data:years.map(y=>byYear[y])}]});
    } else {
      const el = $('#chartYears');
      if (el) el.innerHTML = '<div class="empty-state"><h3>Sin año editorial asignado</h3><p>El documento base no aporta una fecha de publicación que permita asignar un año al registro sin inferirlo.</p></div>';
    }
  }

  async function loadSourceCharts() {
    try {
      const src = await fetch((window.PORTAL_CONFIG?.portalDataBase||'data/portal/')+'sources.json').then(r => { if(!r.ok) throw new Error(r.status); return r.json(); });
      const byDom = {}, byYear = {};
      for (const s of src) {
        try {
          const u = new URL(s.url);
          const d = u.hostname.replace(/^www\./, '');
          byDom[d] = (byDom[d] || 0) + 1;
          const m = s.url.match(/\/(20\d{2})\//);
          if (m) byYear[m[1]] = (byYear[m[1]] || 0) + 1;
        } catch (_) {}
      }
      chart('chartSourceDomains',{title:{text:'Fuentes por dominio',left:'center'},tooltip:{trigger:'item'},series:[{type:'pie',radius:['35%','70%'],data:Object.entries(byDom).map(([name,value])=>({name,value}))}]});
      const years = Object.keys(byYear).sort();
      chart('chartSourceYears',{title:{text:'Referencias por año en la URL',left:'center'},tooltip:{trigger:'axis'},xAxis:{type:'category',data:years},yAxis:{type:'value'},series:[{type:'bar',data:years.map(k=>byYear[k])}]});
      state.sourceChartsLoaded = true;
    } catch (e) {
      console.warn('No se pudieron cargar los gráficos de fuentes:', e);
    }
  }

  async function initBase() {
    const status = $('#engineStatus');
    try {
      const [docs, causes] = await Promise.all([
        fetch((window.PORTAL_CONFIG?.portalDataBase||'data/portal/')+'document.json').then(r => { if(!r.ok) throw new Error('document.json '+r.status); return r.json(); }),
        fetch((window.PORTAL_CONFIG?.portalDataBase||'data/portal/')+'causa.json').then(r => { if(!r.ok) throw new Error('causa.json '+r.status); return r.json(); })
      ]);
      renderBaseCorpus(docs, causes);
      status.textContent = 'Datos incluidos cargados · búsqueda local activa · DuckDB/Parquet opcional';
    } catch (e) {
      status.textContent = 'No se pudieron cargar los datos incluidos: ' + e.message;
      $('#docRows').innerHTML = '<tr><td colspan="6">Error cargando el corpus JSON incluido.</td></tr>';
    }
    loadSourceCharts();
  }

  $('#docSearch')?.addEventListener('input', renderDocs);
  $('#yearFilter')?.addEventListener('change', renderDocs);
  $('#typeFilter')?.addEventListener('change', renderDocs);

  window.PortalStats = { $, esc, chart, populateFilters, renderDocs, state };
  initBase();
})();
