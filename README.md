# Web6 — Observatorio Cívico JEM

Web6 utiliza:

- **GitHub Pages** para el portal y JEM Silver.
- **Hugging Face** para los documentos originales.

Dataset documental:

`https://huggingface.co/datasets/angatupyrytau/jem`

## Regla principal

`data/jem-silver/*.parquet` permanece en este repositorio GitHub.

No subir esos Parquet al dataset de Hugging Face.

## Puesta en marcha

Leer:

- `docs/HOWTO_WEB6.md`
- `docs/HUGGINGFACE_GITHUB.md`
- `docs/ARQUITECTURA_DATOS.md`

## Validación

```bash
pip install -r scripts/requirements.txt
python scripts/sync_huggingface.py --root . --dry-run
python scripts/validate_web6.py .
python -m http.server 8000
```
