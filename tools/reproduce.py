"""Fresh candidate-ZIP reproduction, isolated caches/data, explicit portable Node, recorded commands."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile
import delivery

def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

def verify_run(destination, node, archive_result, checks):
    baseline = json.loads((destination/'baseline.json').read_text(encoding='utf-8'))
    assert baseline['archive']['sha256'] == archive_result['sha256'], 'Different baseline archive'
    source = destination/'src'; logs = destination/'logs'
    commands = json.loads((logs/'commands.json').read_text(encoding='utf-8'))
    assert [x['action'] for x in commands] == checks
    for command in commands:
        assert command['exitCode'] == 0 and not command.get('timedOut'), 'A required command failed'
        for stream in ('stdout','stderr'):
            assert delivery.file_sha(logs/(command['action']+'.'+stream+'.txt')) == command[stream+'Sha256']
    audit = [json.loads(line) for line in (logs/'runtime.jsonl').read_text(encoding='utf-8').splitlines()]
    assert audit and all(x['node']=='v22.23.5' and Path(x['executable']).resolve()==node for x in audit)
    assert all(delivery.ROOT != Path(x['cwd']).resolve() and delivery.ROOT not in Path(x['cwd']).resolve().parents for x in audit), 'Child used original workspace'
    for item in baseline['manifest']['files']:
        assert delivery.file_sha(source/item['path']) == item['sha256'], 'Source or lock changed during reproduction'
    write_json(destination/'result.json', {'status':'passed','source':str(source),'archive':archive_result,'node':str(node),
        'runtimeProcesses':len(audit),'lockUnchanged':True,'sourceUnchanged':True,'actions':checks,
        'verifiedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'gui':'not tested'})
    print('PASS recorded steps: '+','.join(checks)+'; command logs, runtime audit, source and lock verified',flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True, help='New directory outside the original project; must not exist')
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--checks', default='info,npm-ci,build,certs,smoke,backend,csharp', help='Comma-separated steps; default is the complete reproduction')
    parser.add_argument('--verify-existing', action='store_true', help='Only recheck completed logs/hashes; does not rerun or invent test results')
    args = parser.parse_args()
    deadlines = dict(info=30, **{'npm-ci':180}, build=240, certs=90, smoke=45, backend=270, security=120, csharp=240)
    checks = args.checks.split(',')
    if not checks or any(action not in deadlines for action in checks) or len(set(checks)) != len(checks):
        raise ValueError('Invalid or repeated checks')
    destination = args.destination.resolve()
    if destination == delivery.ROOT or delivery.ROOT in destination.parents:
        raise ValueError('Reproduction must be outside the original workspace')
    result = delivery.verify(args.archive)
    if args.verify_existing:
        verify_run(destination, args.node.resolve(), result, checks)
        return
    destination.mkdir(parents=True, exist_ok=False)
    source = destination/'src'
    source.mkdir()
    with zipfile.ZipFile(args.archive) as archive:
        manifest = json.loads(archive.read(next(n for n in archive.namelist() if n.endswith('SOURCE-MANIFEST.json'))))
        for item in manifest['files']:
            path = source / item['path']
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as target: target.write(archive.read(manifest.get('sourcePrefix','')+item['path']))
    for item in manifest['files']:
        assert delivery.file_sha(source/item['path']) == item['sha256']
    write_json(destination/'baseline.json', {'archive': result, 'manifest': manifest, 'source': str(source), 'noRuntimeFilesCopied': True})
    logs = destination/'logs'; logs.mkdir()
    for name in ('tmp','npm-cache','nuget-packages','dotnet-home'): (destination/name).mkdir()
    env = dict(os.environ)
    env.update(TEMP=str(destination/'tmp'), TMP=str(destination/'tmp'), NUGET_PACKAGES=str(destination/'nuget-packages'),
               DOTNET_CLI_HOME=str(destination/'dotnet-home'), DOTNET_CLI_TELEMETRY_OPTOUT='1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1',
               SFT_DATA_DIR=str(source/'server-node/data'), SFT_CERT_DIR=str(source/'server-node/certs'))
    node = args.node.resolve()
    commands = []
    before_lock = delivery.file_sha(source/'server-node/package-lock.json')
    try:
        for action in checks:
            seconds = deadlines[action]
            argv = [str(node),str(source/'tools/run-node.mjs'),action]
            env['SFT_RUNTIME_AUDIT'] = str(logs/'runtime.jsonl')
            if action == 'npm-ci': argv += [str(destination/'npm-cache')]
            record = {'action':action,'command':argv,'cwd':str(source),'startedAt':dt.datetime.now(dt.timezone.utc).isoformat()}
            process = subprocess.Popen(argv,cwd=source,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            record['pid'] = process.pid
            try: stdout,stderr = process.communicate(timeout=seconds)
            except subprocess.TimeoutExpired:
                # Only this invocation's process tree. Finite suite timeouts normally clean their fixtures first.
                subprocess.run(['taskkill.exe','/PID',str(process.pid),'/T','/F'],capture_output=True)
                stdout,stderr = process.communicate()
                record['timedOut'] = True
            record.update(endedAt=dt.datetime.now(dt.timezone.utc).isoformat(),exitCode=process.returncode,
                          stdoutSha256=hashlib.sha256(stdout).hexdigest(),stderrSha256=hashlib.sha256(stderr).hexdigest())
            (logs/(action+'.stdout.txt')).write_bytes(stdout); (logs/(action+'.stderr.txt')).write_bytes(stderr)
            commands.append(record); write_json(logs/'commands.json',commands)
            print(json.dumps(record,ensure_ascii=True),flush=True)
            if record.get('timedOut') or process.returncode: raise RuntimeError('Reproduction failed at '+action+'; inspect recorded logs')
        assert before_lock == delivery.file_sha(source/'server-node/package-lock.json'), 'Lockfile changed'
        verify_run(destination, node, result, checks)
    finally:
        write_json(logs/'commands.json',commands)

if __name__ == '__main__':
    main()
