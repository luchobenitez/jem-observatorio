// Arranque de DuckDB-WASM, compartido por las páginas que consultan Parquet.
//
// Estaba dentro de `duckdb-stats.js`, atado a la página de estadísticas. Al
// añadirse el buscador de voto había dos caminos: copiarlo —y tener dos
// arranques que pueden separarse, con dos formas de elegir el paquete y dos
// sitios donde arreglar un fallo— o extraerlo. Se extrajo.
//
// Por qué los archivos vienen de este repositorio y no de un CDN: un archivo
// que necesita a un tercero para poder leerse no está preservado, y en un sitio
// sobre derechos cada petición a un CDN le filtra a ese tercero qué se está
// consultando y desde dónde.
import * as duckdb from '../vendor/duckdb/duckdb-duckdb-wasm.esm.js';

/** Paquetes locales. `selectBundle` elige entre ellos según lo que el
 *  navegador admita: `eh` usa excepciones de WebAssembly y `mvp` es el
 *  respaldo para los que no las tienen. Se sirve uno solo, así que el coste
 *  para quien visita la página no cambia respecto del CDN; lo que cambia es de
 *  quién depende el sitio para funcionar. */
export function paquetesLocales() {
  const raiz = new URL('../vendor/duckdb/', import.meta.url).href;
  return {
    mvp: { mainModule: raiz + 'duckdb-mvp.wasm',
           mainWorker: raiz + 'duckdb-browser-mvp.worker.js' },
    eh:  { mainModule: raiz + 'duckdb-eh.wasm',
           mainWorker: raiz + 'duckdb-browser-eh.worker.js' },
  };
}

/** Arranca la base y devuelve {db, conn}. */
export async function abrirBase() {
  const bundle = await duckdb.selectBundle(paquetesLocales());
  // El Blob se conserva aunque el worker sea del mismo origen: mantiene una
  // sola forma de arranque y evita depender de cómo resuelva cada navegador
  // una ruta relativa dentro de un worker.
  const workerUrl = URL.createObjectURL(new Blob(
    [`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  const conn = await db.connect();
  return { db, conn };
}

/** Registra un Parquet remoto y comprueba que se puede leer.
 *
 *  La lectura de prueba no sobra: `registerFileURL` no toca la red, de modo
 *  que sin ella un archivo inexistente se descubriría más tarde, dentro de una
 *  consulta, y el error señalaría al sitio equivocado. */
export async function registrar(db, conn, nombre, url) {
  await db.registerFileURL(nombre, url, duckdb.DuckDBDataProtocol.HTTP, false);
  await conn.query(`SELECT * FROM read_parquet('${nombre}') LIMIT 0`);
}

/** Resuelve qué edición consulta el sitio. Una sola, la declarada «vigente».
 *
 *  Antes `editions.json` traía un mapa de pestaña a edición y las heredadas
 *  apuntaban a la anterior: la primera pestaña contaba 3.964 documentos y la
 *  siguiente 4.627. Toda página que consulte datos debe pasar por acá. */
export async function edicionVigente(base, jemSilverBase = 'data/jem-silver/') {
  const cfg = await fetch(new URL(jemSilverBase + 'editions.json', base).href)
    .then(r => { if (!r.ok) throw new Error('editions.json ' + r.status); return r.json(); });
  if (!cfg.vigente) throw new Error('editions.json no declara una edición vigente');
  const decl = cfg.ediciones?.[cfg.vigente];
  if (!decl?.base) throw new Error(`la edición ${cfg.vigente} no está declarada`);
  return { edicion: cfg.vigente, baseEd: decl.base, declaracion: decl };
}

/** Consulta que devuelve filas como objetos llanos. */
export async function filas(conn, sql) {
  const r = await conn.query(sql);
  return r.toArray().map(x => x.toJSON());
}

/** Número a partir de lo que devuelve Arrow, que puede ser BigInt. */
export function numero(valor, porDefecto = 0) {
  if (valor === null || valor === undefined) return porDefecto;
  if (typeof valor === 'bigint') return Number(valor);
  const n = Number(valor);
  return Number.isFinite(n) ? n : porDefecto;
}
