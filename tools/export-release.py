"""Export an explicit source allowlist; seal a clean runnable tree and source ZIP without runtime data."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = 'SOURCE-MANIFEST.json'
FORBIDDEN = {'.git', '.vs', 'obj', 'bin', '__pycache__', 'artifacts', '.cache', 'data', 'uploads', 'downloads', 'certs', 'secrets', 'private-backups'}


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_relative(name):
    path = PurePosixPath(name)
    if not name or path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name:
        raise ValueError('Unsafe relative path: ' + name)
    return path


def no_links(path, base):
    for item in [path, *path.parents]:
        if item == base:
            break
        if item.is_symlink() or getattr(item.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('Refusing linked path: ' + str(item))


def source_names():
    names = [line.strip() for line in (ROOT/'tools/release-files.txt').read_text(encoding='utf-8-sig').splitlines() if line.strip() and not line.startswith('#')]
    if len(names) != len(set(names)):
        raise ValueError('Duplicate source entries')
    for name in names:
        path = safe_relative(name)
        if any(part.lower() in FORBIDDEN for part in path.parts) or path.parts[0].lower().startswith('runtime') or path.suffix.lower() in {'.key', '.pem', '.pfx', '.p12', '.sqlite', '.db', '.zip', '.exe', '.dll'}:
            raise ValueError('Forbidden source entry: ' + name)
        no_links(ROOT/name, ROOT)
        if not (ROOT/name).is_file():
            raise ValueError('Missing source file: ' + name)
        if re.search(rb'^-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----', (ROOT/name).read_bytes(), re.M):
            raise ValueError('Private key in source: ' + name)
    return sorted(names)


def write_json(path, value):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def record(base, name):
    path = base/name
    return {'path': name, 'bytes': path.stat().st_size, 'sha256': sha(path)}


def git_state():
    if not (ROOT/'.git').is_dir():
        original = ROOT/MANIFEST
        if not original.exists():
            raise ValueError('Original Git metadata or SOURCE-MANIFEST.json required')
        return json.loads(original.read_text(encoding='utf-8'))['git']
    def run(*args):
        return subprocess.check_output(['git', '-c', 'core.quotepath=false', *args], cwd=ROOT).decode('utf-8').strip()
    names = set(source_names())
    changed = set(run('diff', 'HEAD', '--name-only').splitlines())
    tracked = set(run('ls-files').splitlines())
    pending = sorted((changed | (names-tracked)) & names)
    return {'head': run('rev-parse', 'HEAD'), 'sourceCommitted': not pending, 'uncommittedSourceFiles': pending,
            'historyPreservedInOriginalWorkspace': True, 'exportIsNotAGitCommit': True}


def export(destination):
    names = source_names()
    git = git_state()
    destination.mkdir(parents=True, exist_ok=False)
    for name in names:
        target = destination/name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write((ROOT/name).read_bytes())
    manifest = {'format': 1, 'createdAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'git': git,
                'scope': 'current source from explicit tools/release-files.txt; no private or generated runtime files',
                'files': [record(destination, name) for name in names]}
    write_json(destination/MANIFEST, manifest)
    print(json.dumps({'sourceFiles': len(names), 'destination': str(destination), 'git': git}, ensure_ascii=False))


def verify_sources(directory):
    manifest = json.loads((directory/MANIFEST).read_text(encoding='utf-8'))
    names = [item['path'] for item in manifest['files']]
    if len(names) != len(set(names)) or set(names) != set(source_names()):
        raise ValueError('Source inventory differs from explicit allowlist')
    for item in manifest['files']:
        safe_relative(item['path'])
        no_links(directory/item['path'], directory)
        if record(directory, item['path']) != item:
            raise ValueError('Source changed after export: ' + item['path'])
    return manifest


def seal(directory, output):
    manifest = verify_sources(directory)
    source = {item['path'] for item in manifest['files']} | {MANIFEST}
    runnable = set()
    # These generated roots were inspected separately: full publish, official portable Node, locked npm dependencies.
    generated = ('publish/client/', 'tools/runtime/node-v22.23.5-win-x64/', 'server-node/node_modules/')
    for path in directory.rglob('*'):
        no_links(path, directory)
        if path.is_dir():
            continue
        name = path.relative_to(directory).as_posix()
        if name not in source and not name.startswith(generated):
            raise ValueError('Unexpected file in clean delivery: ' + name)
        if path.suffix.lower() in {'.key', '.pfx', '.p12', '.sqlite', '.db', '.pem'}:
            raise ValueError('Private/runtime file in delivery: ' + name)
        runnable.add(name)
    required = ['publish/client/SecureFileTransfer.Client' + suffix for suffix in ('.exe', '.dll', '.deps.json', '.runtimeconfig.json')]
    required += ['publish/client/SecureFileTransfer.Protocol.dll', 'tools/runtime/node-v22.23.5-win-x64/node.exe',
                 'tools/runtime/node-v22.23.5-win-x64/node_modules/npm/bin/npm-cli.js', 'server-node/node_modules/express/package.json', 'server-node/node_modules/ws/package.json']
    if any(name not in runnable for name in required):
        raise ValueError('Runnable delivery is incomplete')
    if sha(directory/'tools/runtime/node-v22.23.5-win-x64/node.exe') != '247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a':
        raise ValueError('Portable Node digest mismatch')
    output.mkdir(parents=True, exist_ok=True)
    products = ['SFT-4.0.0-source.zip', 'SFT-4.0.0-source.zip.sha256', 'DELIVERY-MANIFEST.json', 'FILELIST.txt', 'SHA256SUMS.txt']
    if any((output/name).exists() for name in products):
        raise ValueError('Refusing to replace an existing sealed package')
    archive = output/products[0]
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as target:
        for name in sorted(source):
            target.write(directory/name, 'SFT-4.0.0/'+name)
    with zipfile.ZipFile(archive) as check:
        if check.testzip() or len(check.namelist()) != len(source):
            raise ValueError('Archive verification failed')
        for item in manifest['files']:
            if hashlib.sha256(check.read('SFT-4.0.0/'+item['path'])).hexdigest() != item['sha256']:
                raise ValueError('ZIP source mismatch')
    files = [record(directory, name) for name in sorted(runnable)]
    archive_record = record(output, archive.name)
    write_json(output/'DELIVERY-MANIFEST.json', {'format': 1, 'projectDirectory': directory.name, 'sourceArchive': archive_record,
               'git': manifest['git'], 'files': files, 'runtimeDirectoryIncluded': False,
               'excluded': 'original .git, old test output, old packages, private backups, account databases, uploaded objects, all generated private keys'})
    (output/'FILELIST.txt').write_text('\n'.join(directory.name+'/'+item['path'] for item in files)+'\n', encoding='utf-8')
    (output/'SFT-4.0.0-source.zip.sha256').write_text(archive_record['sha256']+'  '+archive.name+'\n', encoding='utf-8')
    sums = [item['sha256']+'  '+directory.name+'/'+item['path'] for item in files]
    for name in ['SFT-4.0.0-source.zip', 'SFT-4.0.0-source.zip.sha256', 'DELIVERY-MANIFEST.json', 'FILELIST.txt']:
        sums.append(sha(output/name)+'  '+name)
    (output/'SHA256SUMS.txt').write_text('\n'.join(sums)+'\n', encoding='utf-8')
    print(json.dumps({'files':len(files), 'sourceArchive':archive_record, 'runtimeDataIncluded':False}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['export','seal','verify'])
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    directory = args.directory.resolve()
    if args.action == 'export':
        export(directory)
    elif args.action == 'seal':
        if args.output is None:
            parser.error('--output required')
        seal(directory, args.output.resolve())
    else:
        print(json.dumps({'verifiedSourceFiles': len(verify_sources(directory)['files'])}))


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
