"""Source-only backups and unencrypted EX1B packages; Python standard library only."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_PARTS = {'.git', '.vs', '.idea', 'node_modules', 'bin', 'obj', 'data', 'uploads', 'downloads',
                  'certs', 'secrets', 'artifacts', '__pycache__', 'output'}
REVIEWED_EVIDENCE_IMAGES = {
    'docs/evidence/acceptance-20261125/gui-four-active.png',
    'docs/evidence/acceptance-20261125/gui-final-completed.png',
    'docs/evidence/acceptance-20261125/gui-mtls-login.png',
    'docs/evidence/manual-20261124/image.png',
    'docs/evidence/manual-20261124/image-1.png',
    'docs/evidence/manual-20261124/102-B04-drag-outcome-0.jpg',
    'docs/evidence/manual-20261124/140-B04-relay-drag-0.jpg',
    'docs/evidence/manual-20261124/141-B05-relay-cancel-confirmed-0.jpg',
}


def allowed_source(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or any(p.lower() in EXCLUDED_PARTS for p in path.parts):
        return False
    if name in {'.gitignore', 'submission-info.json', 'SFT_Manual_Acceptance_P5.md', 'server-node/.gitignore', 'server-node/package.json', 'server-node/package-lock.json'}:
        return True
    if name in REVIEWED_EVIDENCE_IMAGES:
        return True
    if path.suffix.lower() in {'.key', '.pem', '.pfx', '.p12', '.sqlite', '.db', '.part', '.log', '.mp4', '.pdf', '.docx'}:
        return False
    return ((name.startswith('docs/') and path.suffix in {'.md', '.mmd', '.json', '.txt'})
            or (name.startswith(('server-node/src/', 'server-node/scripts/', 'server-node/test/')) and path.suffix in {'.js', '.py'})
            or (name.startswith('SecureFileTransfer.Client/') and path.suffix in {'.cs', '.csproj', '.slnx', '.resx'})
            or (name.startswith('tools/') and path.suffix in {'.py', '.mjs', '.ps1'}))


def git(*args):
    result = subprocess.run(['git', '-c', 'core.quotepath=false', *args], cwd=ROOT, capture_output=True, check=True)
    return result.stdout.decode('utf-8')


def check_source(path):
    relative = path.relative_to(ROOT)
    for parent in [path, *path.parents]:
        if parent == ROOT:
            break
        info = parent.lstat()
        if parent.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Refusing linked source path: ' + relative.as_posix())
    if not path.is_file():
        raise ValueError('Not a regular source file: ' + relative.as_posix())
    data = path.read_bytes()
    if re.search(rb'^-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----', data, re.MULTILINE):
        raise ValueError('Private key material in source: ' + relative.as_posix())
    return data


def source_files():
    names = sorted({name for name in git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0') if allowed_source(name)})
    if not names or 'server-node/src/server.js' not in names:
        raise ValueError('Unexpected project source inventory')
    return {name: check_source(ROOT / name) for name in names}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def metadata(files):
    return {'createdAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'head': git('rev-parse', 'HEAD').strip(),
            'gitStatus': git('status', '--short'), 'notAGitCommit': True,
            'files': [{'path': name, 'bytes': len(data), 'sha256': sha(data)} for name, data in files.items()]}


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def verify(path):
    with zipfile.ZipFile(path) as archive:
        for entry in archive.infolist():
            name = PurePosixPath(entry.filename)
            if entry.flag_bits & 1 or name.is_absolute() or '..' in name.parts:
                raise ValueError('Encrypted or unsafe archive member')
        if archive.testzip() is not None:
            raise ValueError('ZIP CRC check failed')
        manifests = [n for n in archive.namelist() if n.endswith('SOURCE-MANIFEST.json')]
        if len(manifests) != 1:
            raise ValueError('Expected exactly one source manifest')
        manifest = json.loads(archive.read(manifests[0]))
        prefix = manifest.get('sourcePrefix', '')
        for item in manifest['files']:
            if not allowed_source(item['path']):
                raise ValueError('Forbidden file in source manifest')
            data = archive.read(prefix + item['path'])
            if len(data) != item['bytes'] or sha(data) != item['sha256']:
                raise ValueError('Source digest mismatch: ' + item['path'])
        allowed_members = {prefix + f['path'] for f in manifest['files']} | set(manifest.get('generatedMembers', [])) | {manifests[0]}
        if set(archive.namelist()) != allowed_members:
            raise ValueError('Unlisted archive members')
    return {'path': str(path.resolve()), 'bytes': path.stat().st_size, 'sha256': file_sha(path), 'sourceFiles': len(manifest['files']), 'encrypted': False}


def write_archive(output, entries):
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            if isinstance(data, Path):
                archive.write(data, name)  # Stream large MP4s instead of reading the whole video into memory.
            else:
                archive.writestr(name, data)
    result = verify(output)
    with output.with_suffix(output.suffix + '.sha256').open('x', encoding='utf-8') as sidecar:
        sidecar.write(result['sha256'] + '  ' + output.name + '\n')
    return result


def report_draft(info, source_folder=None):
    text = (ROOT / 'docs/report-draft.md').read_text(encoding='utf-8')
    text = text.replace('{{NAME}}', info['name']).replace('{{STUDENT_ID}}', info['studentId']).replace('{{REPOSITORY_URL}}', info['repositoryUrl'])
    text = text.replace('<!-- INCLUDE:protocol.md -->', (ROOT / 'docs/protocol.md').read_text(encoding='utf-8'))
    if source_folder is not None:
        # The generated report sits beside the source folder, not inside docs/.
        text = re.sub(r'\]\((evidence/[^)]+)\)', lambda match: '](' + source_folder + '/docs/' + match[1] + ')', text)
    return text.encode('utf-8')


def candidate_status(info, gaps, head):
    return {'status': '候选包：交付材料尚未齐备，不可作为最终作业提交', 'missing': gaps,
            'deadlineBeijing': '2026-11-24T23:55:00+08:00',
            'report': 'Markdown draft only; export to PDF/DOCX after review',
            'video': 'not included',
            'gui': 'user-confirmed manual acceptance completed; see scope and conditional gap'
                   if info.get('guiAcceptanceCompleted') is True else 'pending manual acceptance',
            'guiAcceptanceSummary': info.get('guiAcceptanceSummary'), 'sourceHead': head}


def safe_component(value):
    if not isinstance(value, str) or not re.fullmatch(r'[\w\-]{1,64}', value) or value in {'.', '..'}:
        raise ValueError('Invalid course filename component')
    return value


def final_gaps(info, report, video, files):
    gaps = []
    for key in ('name', 'studentId', 'repositoryUrl'):
        if not info.get(key) or '待填写' in info[key]:
            gaps.append(key + ' missing')
    if not re.fullmatch(r'https://(?:github\.com|gitee\.com|gitlab\.com)/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?', info.get('repositoryUrl', '')):
        gaps.append('real repository URL required (GitHub/Gitee/GitLab)')
    for key in ('guiAcceptanceCompleted', 'reportReviewed', 'videoReviewed'):
        if info.get(key) is not True:
            gaps.append(key + ' pending')
    if report is None or not report.is_file() or report.suffix.lower() not in {'.pdf', '.docx'}:
        gaps.append('real PDF/DOCX report missing')
    if video is None or not video.is_file() or video.suffix.lower() != '.mp4':
        gaps.append('real MP4 video missing')
    tracked = set(git('ls-files', '-z').split('\0'))
    changed = set(git('diff', 'HEAD', '--name-only', '-z').split('\0'))
    if any(name not in tracked or name in changed for name in files):
        gaps.append('source changes are not all committed locally')
    if not git('remote').strip():
        gaps.append('no Git remote configured; remote history/publication not verified')
    return gaps


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['snapshot', 'candidate', 'final', 'verify'])
    parser.add_argument('--output', type=Path, help='New ZIP path; never overwrites an existing archive')
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--video', type=Path)
    args = parser.parse_args()
    if args.mode == 'verify':
        if args.archive is None:
            parser.error('--archive required')
        print(json.dumps(verify(args.archive), ensure_ascii=False, indent=2))
        return
    files = source_files()
    manifest = metadata(files)
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    if args.mode == 'snapshot':
        entries = dict(files)
        explanation = 'INTERNAL SOURCE RECOVERY BACKUP. Extract into a NEW EMPTY directory, verify SOURCE-MANIFEST.json, compare before merging. Not a Git commit. No runtime secrets, databases, certificates, dependencies or build outputs. Originals are not replaced. See docs/p4.md.\n'
        manifest.update(sourcePrefix='', generatedMembers=['SNAPSHOT-NOTES.txt'])
        entries['SNAPSHOT-NOTES.txt'] = explanation.encode('utf-8')
        entries['SOURCE-MANIFEST.json'] = json_bytes(manifest)
        target = args.output or ROOT.parent / 'lab1-backups' / ('P4-workingtree-' + stamp + '.zip')
    else:
        info = json.loads((ROOT / 'submission-info.json').read_text(encoding='utf-8'))
        base = safe_component(info['name']) + '_' + safe_component(info['studentId'])
        folder = base + '_EX1B/'
        prefix = folder + base + '_ex1B_src/'
        gaps = final_gaps(info, args.report, args.video, files)
        if args.mode == 'final' and gaps:
            raise ValueError('Final package blocked: ' + '; '.join(gaps))
        entries = {prefix + name: data for name, data in files.items()}
        extras = []
        if args.mode == 'candidate':
            draft_name = folder + base + '_ex1B_report.DRAFT.md'
            entries[draft_name] = report_draft(info, base + '_ex1B_src')
            extras.append(draft_name)
            status_name = folder + '交付状态.json'
            entries[status_name] = json_bytes(candidate_status(info, gaps, manifest['head']))
            extras.append(status_name)
        else:
            # Reviewer flags are declarations, not automated evidence of GUI steps or report completeness.
            report_data = args.report.read_bytes()
            if args.report.suffix.lower() == '.pdf' and not report_data.startswith(b'%PDF-'):
                raise ValueError('Invalid PDF header')
            if args.report.suffix.lower() == '.docx':
                with zipfile.ZipFile(args.report) as docx:
                    if 'word/document.xml' not in docx.namelist():
                        raise ValueError('Invalid DOCX')
            probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-show_entries', 'format=duration', '-of', 'json', str(args.video)], capture_output=True, check=True)
            media = json.loads(probe.stdout)
            if not media.get('streams') or float(media.get('format', {}).get('duration', 0)) <= 0:
                raise ValueError('MP4 has no playable video/duration')
            for path, suffix in [(args.report, '_ex1B_report' + args.report.suffix.lower()), (args.video, '_ex1B_play.mp4')]:
                name = folder + base + suffix
                entries[name] = path
                extras.append(name)
        manifest.update(sourcePrefix=prefix, generatedMembers=extras, packageKind=args.mode)
        entries[prefix + 'SOURCE-MANIFEST.json'] = json_bytes(manifest)
        target = args.output or ROOT / 'artifacts/delivery' / (base + '_EX1B_' + args.mode.upper() + '_' + stamp + '.zip')
    print(json.dumps(write_archive(target, entries), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
