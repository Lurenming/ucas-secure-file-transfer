"""Optional Windows CLI acceptance test; uses already-installed pywinpty, never real account data."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import threading
import time
from winpty import PtyProcess

root = Path(__file__).resolve().parents[1]


def run_cli(username, passwords, directory, expected_code):
    environment = dict(os.environ, SFT_DATA_DIR=str(directory))
    terminal = PtyProcess.spawn(
        [os.environ['COMSPEC'], '/d', '/c', 'npm.cmd', 'run', 'user:create', '--', username],
        cwd=str(root), env=environment, dimensions=(30, 160),
    )
    chunks = []

    def read_output():
        try:
            while True:
                chunks.append(terminal.read(4096))
        except EOFError:
            pass

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()

    def wait_for(predicate):
        deadline = time.monotonic() + 15
        while not predicate():
            if time.monotonic() >= deadline:
                raise RuntimeError('Interactive CLI test timed out; output withheld')
            time.sleep(0.02)

    try:
        if passwords:
            wait_for(lambda: '不回显' in ''.join(chunks))
            terminal.write(passwords[0] + '\r')
            if len(passwords) > 1:
                wait_for(lambda: '再次输入密码' in ''.join(chunks))
                terminal.write(passwords[1] + '\r')
        wait_for(lambda: not terminal.isalive())
        reader.join(timeout=2)
        transcript = ''.join(chunks)
        if any(password in transcript for password in passwords):
            raise RuntimeError('Password appeared in terminal output; output suppressed')
        if terminal.exitstatus != expected_code:
            raise RuntimeError('Unexpected CLI exit code; output withheld')
        return transcript
    finally:
        if terminal.isalive():
            terminal.terminate(force=True)
        reader.join(timeout=2)


with tempfile.TemporaryDirectory(prefix='sft-p1-cli-') as temporary:
    path = Path(temporary).resolve()
    if path.parent != Path(tempfile.gettempdir()).resolve() or not path.name.startswith('sft-p1-cli-'):
        raise RuntimeError('Unexpected temporary directory')
    directory = path / 'data'
    password = secrets.token_urlsafe(24)
    created = run_cli('Alice', [password, password], directory, 0)
    if '账户已创建' not in created:
        raise RuntimeError('Missing creation confirmation')
    duplicate = run_cli('ALICE', [], directory, 1)
    if '已存在' not in duplicate:
        raise RuntimeError('Missing duplicate-account rejection')
    run_cli('mismatch', [secrets.token_urlsafe(24), secrets.token_urlsafe(24)], directory, 1)
    run_cli('too_long', [secrets.token_urlsafe(200)], directory, 1)
    print('PASS: real npm user:create uses a TTY, hides both password entries, rejects duplicates/mismatches/oversized input.')
    result = subprocess.run(['node', 'test/check-cli-account.js'], cwd=root,
                            input=json.dumps({'directory': str(directory), 'password': password}),
                            capture_output=True, text=True, encoding='utf-8', timeout=60)
    if password in result.stdout + result.stderr:
        raise RuntimeError('Sensitive verification output suppressed')
    if result.returncode != 0:
        raise RuntimeError('Backend process verification failed; output withheld')
    print(result.stdout, end='')
