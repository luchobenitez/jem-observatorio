# Dependencias alojadas en el repositorio

Estas bibliotecas se sirven desde aquí y no desde un CDN. Dos razones:

- **Preservación.** Un archivo que necesita a un tercero para poder leerse no
  está preservado. Si jsDelivr cambia, bloquea o deja de publicar un paquete,
  el portal deja de funcionar entero: toda su capa de datos depende de DuckDB.
- **Privacidad.** Cada petición a un CDN le dice a ese tercero qué se está
  consultando y desde dónde. En un sitio sobre procesos disciplinarios a
  personas identificables eso no es un detalle.

| Archivo | Versión | Licencia |
|---|---|---|
| `duckdb/duckdb-*.wasm`, `duckdb/duckdb-browser-*.worker.js` | 1.28.0 | MIT |
| `duckdb/duckdb-duckdb-wasm.esm.js` | 1.28.0 | MIT |
| `duckdb/apache-arrow.esm.js` | 13.0.0 | Apache-2.0 |
| `duckdb/flatbuffers.esm.js` | 23.5.26 | Apache-2.0 |
| `duckdb/tslib.esm.js` | 2.6.2 | 0BSD |
| `echarts.min.js` | 5.5.0 | Apache-2.0 |

Los cuatro `.esm.js` son las versiones que jsDelivr entrega en `/+esm`, con sus
importaciones reescritas a rutas locales: `duckdb-wasm` importa `apache-arrow`,
que a su vez importa `flatbuffers` y `tslib`. Sin resolver esa cadena entera, un
alojamiento propio sólo mueve el problema un nivel más abajo.

`duckdb-duckdb-wasm.esm.js` conserva internamente la función
`getJsDelivrBundles()`, que construye direcciones del CDN. **No se la llama**:
`assets/js/duckdb-stats.js` arma el paquete a mano con rutas locales. Es la única
mención de un CDN que queda en el árbol, y está dentro de código de terceros.

Se sirve **un solo** paquete WASM por visita —`eh` o `mvp` según lo que el
navegador admita—, así que quien entra descarga lo mismo que descargaba del CDN.
Los 40 MB son peso del repositorio, no de la visita.
