"""Read-only inventory and isolated backup of the pre-enhancement runtime data."""
from pathlib import Path
import hashlib, json, zipfile, sqlite3, shutil, sys

root = Path(__file__).resolve().parents[1]
base = root / 'artifacts/baseline'
with zipfile.ZipFile(base / 'original-materials.zip', 'x', zipfile.ZIP_DEFLATED) as archive:
    for path in root.iterdir():
        if path.is_file():
            archive.write(path, path.name)
rows = []
for area in ['server-node/data', 'server-node/certs']:
    for path in sorted((root / area).rglob('*')):
        if path.is_file():
            rows.append({'path': path.relative_to(root).as_posix(), 'bytes': path.stat().st_size,
                         'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
(base / 'original-private-manifest.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
private = root / 'artifacts/private-backups/accepted-20261124'
private.mkdir(parents=True, exist_ok=False)
for area in ['server-node/data', 'server-node/certs']:
    for path in (root / area).rglob('*'):
        if path.is_file() and not path.name.endswith(('-wal', '-shm')) and path.name != 'writer.lock':
            output = private / path.relative_to(root)
            output.parent.mkdir(parents=True, exist_ok=True)
            if path.suffix == '.sqlite':
                source = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
                destination = sqlite3.connect(output)
                source.backup(destination)
                destination.close()
                source.close()
            else:
                shutil.copy2(path, output)
sys.path.insert(0, str(root / 'artifacts/python-tools'))
from pypdf import PdfReader
reader = PdfReader(next(root.glob('*.pdf')))
text = '\n'.join(f'\nPAGE {i+1}\n' + page.extract_text() for i, page in enumerate(reader.pages))
(base / 'course-extracted.txt').write_text(text, encoding='utf-8')
print('Private files inventoried:', len(rows), '; course pages:', len(reader.pages))
