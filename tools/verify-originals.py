"""Read-only comparison against the full pre-enhancement runtime inventory."""
from pathlib import Path
import argparse, hashlib, json, os, zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', default='artifacts/baseline/originals-final-check.json')
output = (root / parser.parse_args().output).resolve()
if not output.is_relative_to(root / 'artifacts'):
    raise ValueError('Evidence output must stay inside workspace artifacts')
manifest = json.loads((root / 'artifacts/baseline/full-private-manifest.json').read_text(encoding='utf-8'))
expected = {entry['path']: entry for entry in manifest}
actual = {}
for area in ['server-node/data', 'server-node/certs']:
    for directory, dirs, files in os.walk(root / area, onerror=lambda e: (_ for _ in ()).throw(e)):
        for name in files:
            path = Path(directory) / name
            with path.open('rb') as stream:
                actual[path.relative_to(root).as_posix()] = {
                    'bytes': path.stat().st_size,
                    'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}
differences = [path for path in sorted(set(expected) | set(actual))
               if path not in expected or path not in actual
               or expected[path]['bytes'] != actual[path]['bytes']
               or expected[path]['sha256'] != actual[path]['sha256']]
original_changes = [path for path in expected if path not in actual
                    or expected[path]['bytes'] != actual[path]['bytes']
                    or expected[path]['sha256'] != actual[path]['sha256']]
added = [path for path in actual if path not in expected]
with zipfile.ZipFile(root / 'artifacts/baseline/original-materials.zip') as archive:
    acceptance_unchanged = archive.read('验收.md') == (root / '验收.md').read_bytes()
result = {'originalFiles': len(expected), 'currentFiles': len(actual), 'originalContentsUnchanged': not original_changes,
          'directoryCompletelyUnchanged': not differences, 'changedOrMissingOriginals': original_changes,
          'addedFiles': added, 'differences': differences, 'userAcceptanceFileUnchanged': acceptance_unchanged,
          'originalsOpenedReadOnly': True}
output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
# Always retain the complete directory diff. Extra SQLite sidecars are separately reported,
# not silently excluded from the inventory or described as unchanged.
if original_changes or not acceptance_unchanged: raise SystemExit(1)
