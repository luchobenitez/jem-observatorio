# Procedencia

Registros históricos de cómo llegaron a ser los datos que publica el portal.

No son vistas del sitio y no se enlazan desde las páginas: el portal presenta
**un solo análisis sobre una sola edición**. Lo que vive acá es la memoria de
las transiciones, para que sean auditables sin ofrecerle al visitante dos
juegos de cifras del mismo hecho.

- `transicion-de-pipeline.json` — qué cambió al reemplazarse el pipeline
  anterior: qué dejó de ser indeterminable y qué sigue siéndolo.
- `informe-independiente-20260824.json` — el informe empírico del 24/08/2026,
  sobre el pipeline anterior. Ya no alimenta ninguna página: todo lo calculable
  se recalculó desde la edición vigente. Se conserva porque es la procedencia de
  los dos hallazgos que una persona verificó leyendo las resoluciones, que son
  el único dato del proyecto no producido por extracción automática.
- `jem-silver-2026-08-24/` — las cinco tablas del pipeline anterior
  (`document.parquet` con 3.964 filas, `causa.parquet` con 1.669). Estaban
  sueltas en `data/jem-silver/`, junto a la edición vigente, y la primera
  pestaña del portal las leía. Se conservan declaradas en `editions.json` como
  edición histórica; ninguna página las consulta.
