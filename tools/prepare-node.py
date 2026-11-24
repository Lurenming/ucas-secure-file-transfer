"""Download and verify the official portable Windows x64 Node 22.23.5. No PATH/installer changes."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import platform
import subprocess
import urllib.request
import zipfile

VERSION = '22.23.5'
NAME = 'node-v' + VERSION + '-win-x64'
BASE = 'https://nodejs.org/dist/v' + VERSION + '/'
# Pinned against the official release page and separately checked against SHASUMS256.txt.
ZIP_SHA = '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3'
EXE_SHA = '247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a'

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != 'Windows' or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise ValueError('This verified package is for Windows x64 only')
    directory = args.directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    sums = directory / ('node-v' + VERSION + '-SHASUMS256.txt')
    if not sums.exists():
        with urllib.request.urlopen(BASE + 'SHASUMS256.txt', timeout=30) as source:
            data = source.read(65537)
        if len(data) > 65536: raise ValueError('Unexpected checksum response size')
        with sums.open('xb') as target: target.write(data)
    checksums = {line.split()[1]: line.split()[0] for line in sums.read_text().splitlines() if line.strip()}
    if checksums.get(NAME + '.zip') != ZIP_SHA or checksums.get('win-x64/node.exe') != EXE_SHA:
        raise ValueError('Official checksum differs from the reviewed release; stop for review')
    archive = directory / (NAME + '.zip')
    if not archive.exists():
        with urllib.request.urlopen(BASE + archive.name, timeout=60) as source, archive.open('xb') as target:
            count = 0
            while chunk := source.read(1024 * 1024):
                count += len(chunk)
                if count > 100 * 1024 * 1024: raise ValueError('Unexpected download size')
                target.write(chunk)
    if digest(archive) != ZIP_SHA: raise ValueError('ZIP hash mismatch; archive left for inspection, never executed')
    runtime = directory / NAME
    if not runtime.exists():
        with zipfile.ZipFile(archive) as source:
            if sum(item.file_size for item in source.infolist()) > 400 * 1024 * 1024:
                raise ValueError('Unexpected extracted size')
            for item in source.infolist():
                path = PurePosixPath(item.filename)
                if path.is_absolute() or '..' in path.parts or '\\' in item.filename or ':' in item.filename or path.parts[0] != NAME:
                    raise ValueError('Unexpected archive path')
            source.extractall(directory)
    node = runtime / 'node.exe'
    if digest(node) != EXE_SHA: raise ValueError('node.exe hash mismatch')
    versions = json.loads(subprocess.check_output([str(node), '-p', 'JSON.stringify({node:process.version,arch:process.arch,execPath:process.execPath,sqlite:process.versions.sqlite,openssl:process.versions.openssl})']))
    if versions['node'] != 'v' + VERSION or versions['arch'] != 'x64': raise ValueError('Runtime mismatch')
    npm = subprocess.check_output([str(node), str(runtime/'node_modules/npm/bin/npm-cli.js'), '--version']).decode().strip()
    result = {'download': BASE + archive.name, 'checksums': BASE+'SHASUMS256.txt', 'zip': str(archive), 'zipSha256': ZIP_SHA,
              'nodeSha256': EXE_SHA, 'versions': versions, 'npm': npm, 'globalPathChanged': False, 'pgpSignatureVerified': False}
    (directory / ('node-v'+VERSION+'-verification.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=True, indent=2))

if __name__ == '__main__':
    main()
