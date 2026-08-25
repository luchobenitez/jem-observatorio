#!/usr/bin/env python3
from pathlib import Path
from urllib.parse import urlparse, unquote
from html.parser import HTMLParser
import argparse, json, sys

root = Path(__file__).resolve().parents[1]

required = [
    'index.html','caso.html','estadisticas.html','documentos.html','metodologia.html',
    'assets/css/styles.css','assets/js/config.js','assets/js/site.js',
    'assets/js/documents.js','assets/js/stats.js','assets/js/duckdb-stats.js',
    'data/portal/content.json','data/portal/sources.json',
    'data/portal/curated_sources.json','data/portal/timeline.json',
    'data/portal/exams.json','data/portal/document.json','data/portal/causa.json',
    'data/catalog/documents_manifest.json',
    'docs/ARQUITECTURA_DATOS.md',
    'scripts/generar_manifest.py',
    '.github/workflows/deploy-pages.yml'
]

ap=argparse.ArgumentParser()
ap.add_argument('--check-documents', action='store_true',
                help='Verifica que las rutas relativas del catálogo existan físicamente.')
args=ap.parse_args()

missing=[x for x in required if not (root/x).exists()]
assert not missing, f'Faltan archivos: {missing}'

# JSON
json_files=list((root/'data').rglob('*.json'))
for p in json_files:
    json.loads(p.read_text(encoding='utf-8'))

sources=json.loads((root/'data/portal/sources.json').read_text(encoding='utf-8'))
assert len(sources)==41, f'Se esperaban 41 fuentes editoriales, hay {len(sources)}'

manifest=json.loads((root/'data/catalog/documents_manifest.json').read_text(encoding='utf-8'))
docs=manifest.get('documents',[])
assert docs, 'El catálogo documental está vacío.'

# SHA uniqueness at canonical level
hashes=[d.get('sha256') for d in docs if d.get('sha256')]
assert len(hashes)==len(set(hashes)), 'Hay hashes canónicos duplicados en el manifest.'

if args.check_documents:
    missing_docs=[]
    for d in docs:
        href=d.get('relative_path')
        if not href: continue
        p=(root/unquote(href)).resolve()
        try: p.relative_to(root.resolve())
        except ValueError:
            missing_docs.append(href); continue
        if not p.exists(): missing_docs.append(href)
    assert not missing_docs, f'Faltan {len(missing_docs)} documentos físicos; ejemplos: {missing_docs[:10]}'

class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__(); self.refs=[]
    def handle_starttag(self, tag, attrs):
        d=dict(attrs)
        for k in ('href','src'):
            if d.get(k): self.refs.append(d[k])

broken=[]
for html in root.glob('*.html'):
    parser=LinkParser(); parser.feed(html.read_text(encoding='utf-8'))
    for ref in parser.refs:
        if ref.startswith(('#','mailto:','tel:','javascript:','data:')): continue
        u=urlparse(ref)
        if u.scheme in ('http','https'): continue
        path=unquote(u.path)
        if not path: continue
        target=(html.parent/path).resolve()
        try: target.relative_to(root.resolve())
        except ValueError: continue
        if not target.exists(): broken.append((html.name,ref))

assert not broken, 'Referencias locales rotas: '+repr(broken)
print(
    f'OK: sitio válido; {len(sources)} fuentes editoriales; '
    f'{len(docs)} documentos canónicos en catálogo; '
    f'{len(json_files)} JSON; enlaces internos verificados.'
)
