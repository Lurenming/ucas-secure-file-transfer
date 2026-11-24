"""Assemble public evidence from this run; never copy fixtures, credentials or private keys."""
from pathlib import Path
import hashlib, json, shutil, subprocess, zipfile

ROOT = Path(__file__).resolve().parents[1]
AREA = ROOT / 'artifacts/acceptance-20261125'
OUT = ROOT / 'docs/evidence/acceptance-20261125'
OUT.mkdir(exist_ok=True, parents=True)
def read(path): return json.loads(path.read_text(encoding='utf-8-sig'))
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def copy(source, name):
    dest = OUT / name
    shutil.copyfile(source, dest)
    return {'path': dest.relative_to(ROOT).as_posix(), 'bytes': dest.stat().st_size, 'sha256': digest(dest)}

receipts = {
    'build': '2026-11-24T17-08-39-879Z-build',
    'backend': '2026-11-24T17-09-03-909Z-backend',
    'csharp-enhanced': '2026-11-24T17-09-03-687Z-csharp-enhanced',
    'storage-faults': '2026-11-24T17-09-04-218Z-storage-faults',
    'gui-regression': '2026-11-24T17-08-58-338Z-gui-regression',
}
files, suites = [], {}
for name, folder in receipts.items():
    directory = ROOT / 'artifacts/validation' / folder
    result = read(directory / 'result.json')
    assert result['exitCode'] == 0 and not result['timedOut']
    for leaf in ['result.json', 'stdout.txt', 'stderr.txt']:
        files.append(copy(directory / leaf, name + '-' + leaf))
    stdout = (directory / 'stdout.txt').read_text(encoding='utf-8')
    suites[name] = {**result, 'passLines': sum(line.startswith('PASS:') for line in stdout.splitlines())}
    if name == 'backend':
        assert '# tests 43' in stdout and '# pass 43' in stdout and '# fail 0' in stdout and '# skipped 0' in stdout
        suites[name]['tap'] = {'tests': 43, 'passed': 43, 'failed': 0, 'skipped': 0}

for source, name in [
    (ROOT / 'artifacts/validation/2026-11-24T16-27-51-373Z-build/result.json', 'initial-build-failed-result.json'),
    (ROOT / 'artifacts/validation/2026-11-24T16-27-51-373Z-build/stdout.txt', 'initial-build-failed-stdout.txt'),
    (AREA / 'storage-faults-1795540144218/result.json', 'storage-fault-details.json'),
    (AREA / 'gui-regression-1795540138338/result.json', 'form-method-details.json'),
    (AREA / 'manual/verified-results.json', 'gui-post-audit.json'),
    (AREA / 'originals-check.json', 'originals-check.json'),
    (AREA / 'manual/no-write-evidence.json', 'no-write-evidence.json'),
    (AREA / 'manual/shutdown.json', 'shutdown.json'),
    (AREA / 'manual/startup-health-and-graceful-stop.json', 'startup-health-and-graceful-stop.json'),
    (AREA / 'manual/gui-observations-password.json', 'gui-server-observations.json'),
    (AREA / 'gui-evidence/actual-exe-io.txt', 'checkpoint-denied-before.txt'),
    (AREA / 'gui-evidence/final-exe-io.txt', 'checkpoint-retried-after.txt'),
    (AREA / 'gui-evidence/23-final-four-active-0.png', 'gui-four-active.png'),
    (AREA / 'gui-evidence/33-final-completed-0.png', 'gui-final-completed.png'),
    (AREA / 'gui-evidence/16-mtls-login-0.png', 'gui-mtls-login.png'),
]: files.append(copy(source, name))
for path in (AREA / 'gui-evidence').glob('*.txt'):
    if path.name in ['actual-exe-io.txt', 'final-exe-io.txt', 'io-locations.txt']: continue
    files.append(copy(path, 'gui-' + path.name))
for path in (AREA / 'gui-evidence').glob('*.json'):
    files.append(copy(path, 'gui-' + path.name))

code_paths = [p for base in [ROOT / 'server-node/src', ROOT / 'server-node/scripts', ROOT / 'server-node/test', ROOT / 'SecureFileTransfer.Client']
              for p in base.rglob('*') if p.is_file() and p.suffix in {'.js', '.cs', '.csproj', '.slnx'} and not {'bin', 'obj'} & set(p.parts)]
fingerprints = {p.relative_to(ROOT).as_posix(): digest(p) for p in sorted(code_paths)}
with zipfile.ZipFile(ROOT / 'artifacts/delivery/Enhanced-v4-source.zip') as archive:
    archived = set(archive.namelist())
    changed = [name for name, sha in fingerprints.items() if name not in archived or hashlib.sha256(archive.read(name)).hexdigest() != sha]
    unchanged_server = all(name not in changed for name in fingerprints if name.startswith('server-node/src/'))
assert unchanged_server
git = lambda *args: subprocess.check_output(['git', '-c', 'core.quotepath=false', *args], cwd=ROOT).decode('utf-8').strip()
audit = read(AREA / 'manual/verified-results.json')
evidence = {
    'version': '4.0.0 acceptance revision', 'dateAsiaShanghai': '2026-11-25',
    'scope': 'Course functional acceptance; no fixed duration, soak or new business features',
    'suites': suites, 'simulatedDiskFull': {'passed': True, 'serverScenarios': 5, 'clientScenarios': 4, 'realDiskFull': False},
    'windowsCheckpointContention': {'realFileLock': True, 'transientRetryPassed': True, 'persistentDenialBounded': True,
        'oldRecordPreserved': True, 'maxAttempts': 6, 'maxTotalDelayMs': 385},
    'formMethodRegression': {'passedChecks': 8, 'actualDesktopClicks': False,
        'bugs': ['invalid candidate must not replace valid connection settings', 'expired partial upload must not require local download part']},
    'actualGuiAutomation': {'performed': True, 'tool': '@oai/sky Windows Computer Use',
        'cases': ['invalid 0.0.0.0 rejected without crash', 'CA file selection', 'password login and file list',
            'same window two uploads plus two downloads', 'upload and download pause/resume', 'single cancellation isolation',
            'logout and explicit reauthentication', 'active-upload normal close and restart/resume',
            'real unwritable destination and safe cancellation', 'PFX selection, temporary unlock, mTLS account binding and logout'],
        'finalBatch': {'completed': 3, 'explicitlyCancelled': 1, 'unexpectedTaskFailures': 0, 'retainedTasks': 0, 'localPartFiles': 0},
        'finalOverlap': audit['finalGuiOverlap'], 'verifiedCompletedFileHashesAcrossGuiRuns': len(audit['hashes']),
        'firstChanceAccessDeniedAfterFix': 1, 'thisWasHandledRetryNotTaskFailure': True,
        'notEquivalentToUserManualSignoff': True},
    'failuresAndRepairs': [
        'Initial new test harness failed CS4007 due to a span across await; read into an array first, then full build passed. Original failed receipt retained.',
        'Four pre-fix GUI upload attempts reached recoverable state after Windows denied local checkpoint File.Move; stack captured, no corrupt final file published.',
        'Added bounded asynchronous rename retry for Windows 5/32/33; real held-file regression reproduces previous synchronous failure. Final GUI batch handled another transient denial and finished successfully.',
        'Initial queue-record save failure could leave a job registered; now removes registration and permits retry, covered by simulated disk-full and real C#/Node completion.',
        'Two pre-fix diagnostic uploads intentionally remain retained in isolated data (one password, one mTLS); no claim that every historical attempt completed.',
        'GUI automation modal element cache/focus issues were resolved with fresh snapshots, native file picker keyboard navigation and explicit PFX child-window targeting.',
        'Initial server tool stdin was unavailable; only checked owned PIDs were terminated. Then both exact manual startup commands, strict HTTPS health and graceful service.stop were revalidated with a PTY; final active tasks/connections zero. Neither is power loss.'
    ],
    'nonPassingIntermediateUiObservations': {
        'gui-04-four-tasks.txt': 'Folder picker still open; this initial attempt did not prove four concurrent tasks',
        'gui-07-paused-upload.txt': 'Upload had already completed before pause click; use 08/09 and final 24/25 for actual pause/resume evidence'
    },
    'unperformed': ['real two-machine LAN', 'formal dedicated runtime account deployment', 'real GUI certificate-store selection and switch to another user certificate',
        'all combinations of multiple in-flight tasks during GUI close', 'desktop click expiry cleanup (form-method regression passed)', 'user manual signoff'],
    'notRequiredAndNotPerformed': ['fixed-duration or long pressure test', 'real disk-full test', 'real power-loss test'],
    'historicalEvidence': 'docs/evidence/enhanced-20261124.json', 'serverRuntimeCodeUnchangedFromV4Snapshot': unchanged_server,
    'changedOrAddedCodeFromV4Snapshot': changed, 'testedCodeSha256': fingerprints,
    'originals': read(AREA / 'originals-check.json'), 'postAudit': audit,
    'git': {'branch': git('branch', '--show-current'), 'head': git('rev-parse', 'HEAD'), 'status': git('status', '--short'),
        'newCommit': False, 'pushed': False, 'permissionNote': 'Existing .git write restriction retained; no ACL bypass or repeated lock removal attempt'},
    'publicEvidenceFiles': files,
}
(ROOT / 'docs/evidence/acceptance-20261125.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
info = read(ROOT / 'submission-info.json')
info['guiAcceptanceSummary'] = {'basis': 'Actual desktop automation and separate form/core regressions completed; user manual signoff still pending',
    'evidence': 'docs/evidence/acceptance-20261125.json', 'realCrossMachine': 'pending manual validation', 'historicalAcceptanceIsNotCurrent': True}
info['guiAcceptanceCompleted'] = False
(ROOT / 'submission-info.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'evidenceFiles': len(files), 'passLines': {k: v['passLines'] for k, v in suites.items()},
    'changedCodeFiles': len(changed), 'serverRuntimeUnchanged': unchanged_server}, ensure_ascii=False))
