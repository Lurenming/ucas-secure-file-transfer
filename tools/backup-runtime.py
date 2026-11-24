"""Back up only named application data/certs; never change the originals' ACL."""
from pathlib import Path
import os, hashlib, json, shutil, sqlite3, sys

root = Path(__file__).resolve().parents[1]
target = root / 'artifacts/private-backups/accepted-runtime-full'
target.mkdir(parents=True, exist_ok=False)
manifest = []
for name in ['data', 'certs']:
    source = root / 'server-node' / name
    for directory, dirs, files in os.walk(source, onerror=lambda e: (_ for _ in ()).throw(e)):
        for filename in files:
            path = Path(directory) / filename
            if path.is_symlink(): raise RuntimeError('Refusing symlink')
            relative = path.relative_to(root)
            manifest.append({'path': relative.as_posix(), 'bytes': path.stat().st_size,
                             'sha256': hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()})
            if filename.endswith(('-wal','-shm')) or filename == 'writer.lock': continue
            output = target / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            if path.suffix == '.sqlite':
                with sqlite3.connect(path.as_uri()+'?mode=ro', uri=True) as src, sqlite3.connect(output) as dst:
                    src.backup(dst)
                    if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise RuntimeError('Backup integrity check failed')
            else: shutil.copy2(path, output)
(root/'artifacts/baseline/full-private-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print('Read-only backup complete; files:',len(manifest))
