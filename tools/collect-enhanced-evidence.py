"""Collect actual enhanced validation receipts; never infer GUI acceptance from network tests."""
from pathlib import Path
import datetime as dt
import hashlib, json, re, subprocess

root = Path(__file__).resolve().parents[1]
chosen = {
    'build': '2026-11-24T15-45-55-138Z-build',
    'backend': '2026-11-24T15-39-23-682Z-backend',
    'enhanced': '2026-11-24T15-31-49-774Z-enhanced',
    'csharp': '2026-11-24T15-39-29-541Z-csharp',
    'csharp-enhanced': '2026-11-24T15-33-04-513Z-csharp-enhanced',
    'pki-check': '2026-11-24T15-40-38-176Z-pki-check',
    'smoke': '2026-11-24T15-40-38-236Z-smoke',
}
results, logs = {}, {}
for name, directory in chosen.items():
    base = root / 'artifacts/validation' / directory
    result = json.loads((base / 'result.json').read_text(encoding='utf-8'))
    assert result['exitCode'] == 0 and not result['timedOut'], name
    for output in ['stdout', 'stderr']:
        data = (base / (output + '.txt')).read_bytes()
        assert hashlib.sha256(data).hexdigest() == result[output + 'Sha256'], name
    result['receipt'] = base.relative_to(root).as_posix() + '/result.json'
    logs[name] = (base / 'stdout.txt').read_text(encoding='utf-8')
    results[name] = result
assert '# pass 43' in logs['backend'] and '# skipped 0' in logs['backend']
assert '# pass 9' in logs['enhanced']
rates = [json.loads(line[2:]) for line in logs['backend'].splitlines() if line.startswith('# {"label":')]
failures = []
for path in sorted((root / 'artifacts/validation').glob('2026-11-24T*/result.json')):
    value = json.loads(path.read_text(encoding='utf-8'))
    if value['exitCode'] != 0 or value['timedOut']:
        failures.append({'path': path.relative_to(root).as_posix(), 'name': value['name'], 'exitCode': value['exitCode'], 'timedOut': value['timedOut']})
def read_json(path):
    data = (root / path).read_bytes()
    return json.loads(data.decode('utf-16' if data[:2] in [b'\xff\xfe', b'\xfe\xff'] else 'utf-8-sig'))
data = {
    'recordedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'softwareVersion': '4.0.0',
    'datesUse': 'Asia/Shanghai for display; original receipts use UTC',
    'results': results, 'backend': {'pass': 43, 'fail': 0, 'skipped': 0},
    'enhancedSubset': {'pass': 9, 'includedInBackend43': True}, 'bandwidthMeasurements': rates,
    'realCsharpChecks': [line[6:] for line in logs['csharp-enhanced'].splitlines() if line.startswith('PASS: ')],
    'independentHashComparisons': [line for line in logs['csharp-enhanced'].splitlines() if '_HASH ' in line],
    'idleSecondsActuallyWaited': 61, 'observedConcurrentTasks': 4,
    'acl': read_json('artifacts/baseline/acl-runtime.json'),
    'migrationOfFreshPrivateCopy': read_json('artifacts/baseline/migration-final-result.json'),
    'originalDataFinalCheck': read_json('artifacts/baseline/originals-final-check.json'),
    'earlierFailedReceiptsRetained': failures,
    'failureResolution': [
        'Initial backend assertions assumed old default4 slots and treated HELLO password mode label as leaked password field; corrected scoped expectations and real secret-field check, then full regression passed.',
        'OpenSSL refused expired fixture construction; corrected explicit validity dates and reran all mTLS cases.',
        'New C# check failed compilation because ReadOnlySpan crossed await; stored byte array first, full solution rebuilt successfully.',
        'Sandbox Schannel reported 0x8009030E before certificate callback. Same real C# tests passed as normal Windows logged-in user with isolated cert/data; TLS verification retained.',
        'Precommit disconnect and uncheckpointed local suffix were repaired and covered by actual retry/resume tests.',
        'Invalid GUI connection candidate and expired-upload cleanup found in code review, fixed and rebuilt; these GUI interactions remain manual pending.',
        'Initial exact directory comparison found two new SQLite sidecars from read-only backup; no original content changed. Difference retained and explicitly reported, not deleted or hidden.'
    ],
    'manualStatus': {'enhancedGui': 'launched and inspected only; interactive acceptance pending',
        'realTwoMachineLan': '真实跨机器通信待人工验证',
        'D05UnwritableGuiDirectory': 'pending', 'productionDedicatedAccountDeployment': 'not performed',
        'interactivePfxExportAndGuiSelection': 'pending', 'windowsServiceInstalled': False,
        'realPowerFailureAndLongStress': 'not tested'},
    'git': {'branch': subprocess.check_output(['git','branch','--show-current'],cwd=root,text=True).strip(),
        'head': subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
        'enhancementBranchCreated': False,'newCommitCreated': False,'pushed': False,
        'blocker': '.git ref lock permission denied; no ACL bypass, repository recreation or fabricated commit'},
    'sourceBaseline': {'path': 'artifacts/baseline/P5-accepted-before-enhancements.zip',
        'sha256': '7f9daf1fa06cbc5f9ab2060ca6487057a6e4d9024e06c5c405e64a2a141bae13'},
    'privateBackup': 'artifacts/private-backups/accepted-runtime-full/server-node (excluded from source delivery)',
}
assert data['originalDataFinalCheck']['originalContentsUnchanged']
assert data['migrationOfFreshPrivateCopy']['preservedCommittedFiles'] == 39
output = root / 'docs/evidence/enhanced-20261124.json'
output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('Collected actual receipts:', len(results), '; earlier failures retained:', len(failures))
