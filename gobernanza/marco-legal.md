# Memo de marco legal aplicable

**Proyecto:** JEM-Full — archivo del Jurado de Enjuiciamiento de Magistrados preparado para IA
**Destino:** secciones 15–16 del artículo (gobernanza, riesgos y soberanía del dato)
**Fase:** 1 del plan de [`JEM.md`](../../JEM.md)
**Estado:** borrador para revisión jurídica · **no validado por profesional del derecho**

> **Convención de etiquetado** (formalizada según `JEM.md` §4.6, aplicada a todo este documento):
>
> - **`[Dato]`** — verificable contra una fuente normativa oficial o contra los datos del proyecto.
> - **`[Inferencia]`** — razonamiento del equipo a partir de datos, sujeto a error.
> - **`[Propuesta]`** — decisión de diseño sugerida, aún no adoptada.
> - **`[Verificar]`** — afirmación que el equipo necesita confirmar contra el texto oficial antes de publicarla.
>
> Las etiquetas se conservan hasta la redacción final. Una afirmación sin verificar
> no puede pasar al artículo sin su etiqueta.

---

## 1. Para qué sirve este memo

El proyecto hace dos cosas jurídicamente distintas, y conviene no confundirlas:

1. **Recolecta** documentos que el JEM publica por mandato legal.
2. **Reprocesa** esos documentos —OCR, extracción de entidades, normalización de
   nombres de personas— y potencialmente **publica un conjunto de datos derivado**.

La primera actividad se ampara en el régimen de acceso a la información pública.
La segunda es un tratamiento de datos personales a escala, y **no se ampara
automáticamente en el mismo régimen**. El memo separa ambas.

---

## 2. Ley N.º 5282/2014 — Libre acceso ciudadano a la información pública

### 2.1 Qué establece

`[Dato]` La Ley N.º 5282/2014 *"De Libre Acceso Ciudadano a la Información Pública
y Transparencia Gubernamental"* regula el derecho de acceso a la información en
poder del Estado paraguayo. `[Verificar]` Fecha exacta de sanción y promulgación,
y el decreto reglamentario (el equipo maneja como referencia el Decreto N.º
4064/2015; confirmar número y vigencia contra la Gaceta Oficial o la BACN).

`[Dato]` La ley distingue dos regímenes:

- **Transparencia activa** — información que las fuentes públicas deben publicar
  de oficio, sin que medie solicitud.
- **Transparencia pasiva** — información que debe entregarse ante solicitud
  ciudadana, con plazos y causales de reserva tasadas.

`[Verificar]` El artículo que enumera la información de publicación obligatoria de
oficio (el equipo lo cita como art. 8, siguiendo la propia rotulación del sitio
del JEM en su sección "Transparencia y Anticorrupción"). Confirmar el número de
artículo y su contenido literal antes de citarlo en el artículo científico.

### 2.2 Por qué aplica al JEM

`[Dato]` El Jurado de Enjuiciamiento de Magistrados es un órgano de rango
constitucional del Estado paraguayo. `[Inferencia]` Como tal, es una *fuente
pública* en el sentido de la ley, y sus resoluciones, dictámenes y órdenes del día
quedan alcanzados por el régimen de transparencia activa.

`[Dato]` El sitio institucional `jem.gov.py` mantiene una sección de transparencia
que se declara fundada en esta ley, y publica buscadores de resoluciones y de
expedientes de acceso público.

### 2.3 Consecuencia para el proyecto

`[Inferencia]` El corpus **no es una filtración ni una obtención irregular**: son
documentos que el propio órgano publica en cumplimiento de un mandato legal. Esto
sostiene la licitud de la recolección y es un punto que el artículo debe afirmar
con la cita normativa concreta.

`[Inferencia]` **Pero la ley no previó el reprocesamiento masivo por sistemas de
IA.** Fue redactada para un modelo de consulta documento-a-documento por un
ciudadano. Nada en ella autoriza ni prohíbe explícitamente construir un corpus
estructurado, entrenar modelos o publicar derivados. Ese silencio normativo es en
sí mismo un hallazgo publicable y debería ocupar un lugar en la sección de
discusión del artículo, no esconderse.

`[Propuesta]` Redactar la discusión en estos términos: *la publicidad legal
garantiza disponibilidad, no gobernanza; un marco de acceso a la información
diseñado para lectura humana no resuelve las preguntas que plantea el
reprocesamiento algorítmico.* Es la formulación jurídica de la tesis central del
proyecto.

---

## 3. Ley N.º 7593/2025 — Protección de datos personales

### 3.1 Estado de la información disponible

`[Antecedente informado, vía JEM.md §4.1]` Ley N.º 7593/2025 *"De Protección de
Datos Personales en la República del Paraguay"*, promulgada el 28 de noviembre de
2025, que crea la **Agencia Nacional de Protección de Datos Personales (ANPDP)**
como unidad desconcentrada del MITIC.

`[Verificar]` **Todo lo anterior requiere confirmación contra el texto oficial.**
El equipo no ha verificado aún: número de ley, fecha de promulgación, existencia y
naturaleza jurídica de la ANPDP, entrada en vigencia, *vacatio legis*, y si existe
decreto reglamentario. **Ninguna de estas afirmaciones debe pasar al artículo sin
verificación directa en la Gaceta Oficial o la BACN.**

`[Dato]` Existe normativa paraguaya previa sobre datos personales que sigue siendo
contexto relevante: la garantía constitucional de *habeas data*, y la Ley N.º
1682/2001 que reglamenta la información de carácter privado, con sus
modificatorias. `[Verificar]` Si la Ley 7593/2025 deroga, sustituye o convive con
la Ley 1682/2001 — la respuesta cambia qué norma rige los tratamientos anteriores
a su vigencia.

### 3.2 Obligaciones que previsiblemente aplican

`[Inferencia]` Las siguientes son obligaciones estándar de una ley de protección
de datos de esta generación. Se listan como hipótesis de trabajo para dimensionar
el esfuerzo de cumplimiento, **no como cita de la norma**:

| Obligación | Impacto previsible en el proyecto |
|---|---|
| Base legal explícita para todo tratamiento | Hay que declarar cuál invoca el proyecto: interés público / investigación científica / fuente de acceso público. **Decisión abierta.** |
| Principio de finalidad y minimización | El corpus se recolectó para investigación documental. Cualquier uso distinto necesita justificación separada. |
| Privacidad desde el diseño | Afecta la arquitectura: qué se guarda en Silver/Gold, qué se publica, qué se seudonimiza. |
| Derechos de acceso, rectificación, supresión y portabilidad | Requiere un canal de contacto y un procedimiento operativo. Ver §5. |
| Protección reforzada de datos de menores | El corpus puede contener menciones a menores (causas de la jurisdicción de la adolescencia aparecen en el corpus). **Riesgo concreto, no teórico.** |
| Registro de actividades de tratamiento | Documento a producir si la norma lo exige al responsable. |
| Responsable / delegado de protección de datos | Rol a designar en el equipo. |

### 3.3 Por qué importa especialmente en este proyecto

`[Dato]` El corpus contiene nombres completos de magistrados, agentes fiscales,
defensores, denunciantes y abogados. Los propios nombres de archivo los exponen:
el inventario incluye rutas como `Auto_Interlocutorio_126-2020 - Investigación
Preliminar <NOMBRE Y APELLIDOS>`. Es decir, **hay datos personales en la capa de
metadatos, no sólo dentro del texto de los documentos.**

`[Dato]` El corpus incluye documentos de la jurisdicción penal de la adolescencia.

`[Inferencia]` El riesgo no es la publicación original —que ya hizo el JEM— sino
la **agregación**: convertir 4.627 documentos dispersos en una base consultable,
con entidades normalizadas y búsqueda semántica, produce un perfil de personas
identificables que no existía antes. Es un cambio cualitativo, no sólo de escala.
`[Propuesta]` El artículo debe nombrar este efecto explícitamente; es una de las
contribuciones conceptuales más sólidas que el trabajo puede hacer.

### 3.4 Distinción que debe sostenerse

`[Propuesta]` Separar con claridad tres objetos con regímenes distintos:

1. **Documentos originales del JEM** — siguen su propio régimen legal. El proyecto
   no los relicencia, no los altera y no los republica como copia auténtica.
2. **Datos derivados** (índices, metadatos, entidades normalizadas, votos
   estructurados) — son producto del proyecto y caen bajo su responsabilidad. Aquí
   aplican los derechos de rectificación y supresión.
3. **Texto extraído por OCR** — zona gris. Es una reproducción del original, pero
   con errores introducidos por el proyecto. `[Propuesta]` Tratarlo como derivado
   a efectos de responsabilidad, y declarar explícitamente su tasa de error
   (resultado de la Fase 6) junto a cualquier publicación.

---

## 4. Reglamento del Expediente Electrónico del JEM

`[Antecedente informado, vía JEM.md §5.3]` El JEM publica un "Reglamento del
Expediente Electrónico", referenciado desde `jem.gov.py`.

`[Verificar]` **Documento no revisado aún.** Es la fuente normativa de mayor
especificidad disponible y puede contener cláusulas directamente decisivas sobre:

- condiciones de reutilización de los documentos publicados;
- autenticidad y valor probatorio de las copias descargadas;
- si existe alguna restricción expresa a la extracción automatizada;
- qué parte del sistema es pública y cuál requiere autenticación.

`[Propuesta]` Obtenerlo y analizarlo antes de cerrar la Fase 1. Si contiene
cláusulas de reutilización, son el insumo directo de la dimensión *Reusable* del
índice FAIR ampliado (Fase 9), y cambiarían la puntuación de esa dimensión.

---

## 5. Procedimiento de rectificación y supresión

`[Propuesta]` Establecer, antes de cualquier publicación del dataset derivado:

1. **Canal de contacto** publicado junto al dataset, con dirección de correo
   verificable y compromiso de plazo de respuesta.
2. **Alcance de lo que puede corregirse**: los datos derivados del proyecto. El
   proyecto **no puede** modificar ni suprimir los documentos originales del JEM;
   ante una solicitud de ese tipo, deriva al órgano.
3. **Registro de solicitudes** con fecha, objeto, resolución y plazo — que es a la
   vez evidencia de cumplimiento y un dato de investigación interesante.
4. **Supresión efectiva en las capas derivadas**: si un titular ejerce su derecho,
   debe eliminarse de Silver/Gold, de los índices de búsqueda y de los embeddings,
   no sólo de la vista pública. `[Inferencia]` Esto tiene una implicación técnica
   que conviene anticipar en el diseño: un índice vectorial debe poder reconstruirse
   excluyendo documentos, lo que exige mantener la trazabilidad documento→vector.
5. **Política de retención** declarada: cuánto tiempo se conservan las capas
   derivadas y qué ocurre al cierre del proyecto.

---

## 6. Qué falta verificar — lista de control de la Fase 1

- [ ] Texto oficial de la Ley 5282/2014: número de artículo de publicación obligatoria de oficio, causales de reserva, órgano de aplicación.
- [ ] Decreto reglamentario de la Ley 5282/2014: número y vigencia.
- [ ] Texto oficial de la Ley 7593/2025: existencia, número, fecha, articulado.
- [ ] Entrada en vigencia y *vacatio legis* de la Ley 7593/2025.
- [ ] Decreto reglamentario de la Ley 7593/2025, si existe.
- [ ] Constitución y funcionamiento efectivo de la ANPDP.
- [ ] Relación entre la Ley 7593/2025 y la Ley 1682/2001 (derogación, sustitución o convivencia).
- [ ] Régimen aplicable a tratamientos iniciados **antes** de la vigencia de la Ley 7593/2025 — el corpus es mayoritariamente anterior.
- [ ] Reglamento del Expediente Electrónico del JEM: obtener y analizar.
- [ ] Existencia de excepción por investigación científica o estadística en la Ley 7593/2025, y sus condiciones.
- [ ] Régimen de datos de menores y si alguna causa del corpus lo activa.
- [ ] Revisión del memo por profesional del derecho paraguayo.

`[Propuesta]` Revisar el estado normativo **otra vez** inmediatamente antes de la
redacción final (Fase 12). `JEM.md` §11 identifica correctamente el riesgo: una ley
de noviembre de 2025 puede reglamentarse durante el desarrollo del proyecto, y una
afirmación correcta hoy puede ser falsa al momento de publicar.

---

## 7. Resumen ejecutivo

`[Inferencia]` Con la información disponible hoy:

- La **recolección** del corpus está bien fundada en el régimen de acceso a la
  información pública. No es el punto débil del proyecto.
- El **reprocesamiento y la eventual publicación de derivados** son el punto que
  requiere trabajo: base legal por declarar, derechos de titulares por
  instrumentar, y un efecto de agregación que ninguna de las dos leyes contempla
  expresamente.
- La **brecha normativa** —leyes de transparencia que no previeron la IA, leyes de
  datos personales posteriores a la mayor parte del corpus— no es un obstáculo del
  proyecto sino uno de sus resultados. Merece tratamiento como hallazgo, con la
  prudencia de no sobreinterpretar el silencio de la norma.

---

## Documentos relacionados

- [`alcance-etico.md`](alcance-etico.md) — qué se recolecta y qué se excluye deliberadamente
- [`licencia-derivados.md`](licencia-derivados.md) — condiciones de reutilización del dataset derivado
- [`../../MANIFEST.md`](../../MANIFEST.md) — corte vigente del corpus
- [`../../JEM.md`](../../JEM.md) — plan de proyecto por fases
