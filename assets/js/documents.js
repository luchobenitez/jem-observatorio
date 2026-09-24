const CFG=window.PORTAL_CONFIG||{
  portalDataBase:'data/portal/',
  jemSilverBase:'data/jem-silver/',
  catalogBase:'data/catalog/',
  storageProvider:'huggingface'
};
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const fmtBytes=(n)=>{
  const v=Number(n||0); if(!v) return '—';
  const u=['B','KB','MB','GB']; let x=v,i=0;
  while(x>=1024&&i<u.length-1){x/=1024;i++;}
  return `${x.toFixed(i?1:0)} ${u[i]}`;
};
function domain(u){try{return new URL(u,location.href).hostname.replace(/^www\./,'')}catch{return 'sin enlace'}}

function accessButtons(d){
  const parts=[];
  if(d.view_url){
    parts.push(`<a class="btn secondary" href="${esc(d.view_url)}" target="_blank" rel="noopener">Ver ↗</a>`);
  }
  if(d.download_url){
    parts.push(`<a class="btn download-btn" href="${esc(d.download_url)}" target="_blank" rel="noopener">Descargar ↧</a>`);
  }
  return parts.length
    ? `<div class="access-buttons">${parts.join(' ')}</div>`
    : '<span class="pending-link">Pendiente de sincronización</span>';
}

async function initRepository(){
  const table=document.getElementById('repoRows');
  if(!table) return;
  const search=document.getElementById('repoSearch');
  const year=document.getElementById('repoYear');
  const kind=document.getElementById('repoKind');
  const count=document.getElementById('repoCount');
  const status=document.getElementById('repoStatus');
  const syncMeta=document.getElementById('storageSyncMeta');
  let docs=[];

  try{
    const snapshot=await fetch(CFG.catalogBase+'hf_snapshot.json').then(r=>r.ok?r.json():null);
    if(snapshot && syncMeta){
      syncMeta.textContent=snapshot.status==='OK'
        ? `Hugging Face sincronizado: ${Number(snapshot.document_files_seen||0).toLocaleString()} documentos vistos · ${Number(snapshot.manifest_matches||0).toLocaleString()} enlazados`
        : 'Repositorio Hugging Face configurado. Los enlaces se completan durante la sincronización.';
    }
  }catch(_){}

  try{
    // Catálogo de la edición vigente. El anterior, `documents_manifest.json`,
    // listaba 3.964 documentos —el linaje de agosto— y por tanto no alcanzaba
    // a «expedientes» ni a «orden del día». Se prefiere el nuevo y se cae al
    // viejo si no estuviera, para no dejar la página en blanco.
    let payload=null, origen='';
    try{
      const ed=await fetch(CFG.jemSilverBase+'editions.json').then(r=>r.json());
      const base=ed.ediciones?.[ed.vigente]?.base;
      if(base){
        payload=await fetch(base+'catalogo.json').then(r=>{if(!r.ok)throw 0;return r.json();});
        origen=` · edición ${ed.vigente}`;
      }
    }catch(e){
      throw new Error(`no se pudo leer el catálogo de la edición vigente: ${e.message}`);
    }
    if(!payload){
      // Sin reserva al catálogo anterior.
      //
      // Había una, a `documents_manifest.json`, con los 3.964 documentos del
      // pipeline de agosto. Nunca se disparó porque el catálogo vigente carga
      // bien, pero de haberlo hecho la página habría mostrado 663 documentos
      // menos sin avisar, igual que pasaba en la pestaña del corpus, donde la
      // reserva sí se disparaba siempre. Un número equivocado que parece bueno
      // es peor que un error visible.
      throw new Error('el catálogo de la edición vigente vino vacío');
    }
    docs=Array.isArray(payload)?payload:(payload.documents||[]);
    const linked=docs.filter(d=>d.view_url||d.download_url).length;
    const faltan=docs.length-linked;
    status.textContent=`${docs.length.toLocaleString()} documentos únicos · `
      +`${linked.toLocaleString()} con enlace`
      +(faltan?` · ${faltan.toLocaleString()} sin copia pública`:'')+origen;
  }catch(e){
    status.textContent='El catálogo documental no está disponible.';
    table.innerHTML='<tr><td colspan="7">Sin catálogo disponible.</td></tr>';
    return;
  }

  const years=[...new Set(docs.map(x=>x.year).filter(Boolean))].sort((a,b)=>a-b);
  const kinds=[...new Set(docs.map(x=>x.kind||x.category).filter(Boolean))].sort();
  years.forEach(y=>year.insertAdjacentHTML('beforeend',`<option value="${esc(y)}">${esc(y)}</option>`));
  kinds.forEach(k=>kind.insertAdjacentHTML('beforeend',`<option value="${esc(k)}">${esc(k.replaceAll('_',' '))}</option>`));

  function render(){
    const q=(search.value||'').trim().toLocaleLowerCase('es');
    const y=year.value,k=kind.value;
    const rows=docs.filter(d=>{
      const hay=`${d.filename||''} ${d.caratula||''} ${d.causa_id||''} ${d.kind||''} ${d.category||''} ${d.sha256||''} ${d.hf_path||''}`.toLocaleLowerCase('es');
      return (!q||hay.includes(q))&&(!y||String(d.year||'')===y)&&(!k||(d.kind||d.category||'')===k);
    });
    count.textContent=`${rows.length.toLocaleString()} documento(s)`;
    table.innerHTML=rows.slice(0,200).map(d=>{
      const title=d.caratula||d.filename||'Documento';
      const type=(d.kind||d.category||'—').replaceAll('_',' ');
      const hash=String(d.sha256||'').slice(0,12);
      return `<tr>
        <td>${esc(d.year||'—')}</td>
        <td>${esc(type)}</td>
        <td><strong>${esc(title)}</strong><small class="repo-meta">${esc(d.filename||'')}${hash?` · SHA-256 ${esc(hash)}…`:''} · Hugging Face</small></td>
        <td>${esc(d.causa_id||'—')}</td>
        <td>${esc(d.extension||'—')}</td>
        <td>${fmtBytes(d.size_bytes)}</td>
        <td>${accessButtons(d)}</td>
      </tr>`;
    }).join('')||'<tr><td colspan="7">Sin resultados.</td></tr>';
    document.getElementById('repoLimitHint').textContent=
      rows.length>200?'Mostrando los primeros 200 resultados. Refine la búsqueda para reducir la lista.':'';
  }
  [search,year,kind].forEach(el=>el.addEventListener(el.tagName==='SELECT'?'change':'input',render));
  render();
}

async function initSources(){
  const list=document.getElementById('sourceList');
  if(!list) return;
  const search=document.getElementById('sourceSearch');
  const cat=document.getElementById('sourceCategory');
  const count=document.getElementById('sourceCount');
  let all=[];
  function render(){
    const q=(search.value||'').toLowerCase(),c=cat.value;
    const rows=all.filter(x=>(!c||x.category===c)&&(!q||(x.title+' '+domain(x.url)).toLowerCase().includes(q)));
    count.textContent=`${rows.length} fuente(s)`;
    list.innerHTML=rows.map(x=>`<article class="source-item"><div><span class="source-id">${esc(x.category)}</span><strong>${esc(x.title)}</strong><small>${esc(domain(x.url))}</small></div><div>${x.url?`<a class="btn secondary" href="${esc(x.url)}" target="_blank" rel="noopener">Abrir ↗</a>`:'Sin URL'}</div></article>`).join('');
  }
  try{
    const [curated,works]=await Promise.all([
      fetch(CFG.portalDataBase+'curated_sources.json').then(r=>r.json()),
      fetch(CFG.portalDataBase+'sources.json').then(r=>r.json())
    ]);
    const curatedUrls=new Set(curated.map(x=>x.url));
    all=[...curated,...works.filter(w=>!curatedUrls.has(w.url)).map(w=>({category:'Works cited',title:w.title,url:w.url}))];
    [...new Set(all.map(x=>x.category))].forEach(c=>cat.insertAdjacentHTML('beforeend',`<option>${esc(c)}</option>`));
    render();
  }catch(e){
    list.innerHTML=`<div class="empty-state">No se pudieron cargar las fuentes: ${esc(e.message)}</div>`;
  }
  search.addEventListener('input',render);
  cat.addEventListener('change',render);
}

initRepository();
initSources();
