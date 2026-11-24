import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const checks = {
  'storage-faults': [process.execPath, ['scripts/check-storage-faults.js', join(root, 'artifacts/acceptance-20261125', 'storage-faults-' + Date.now())], 'server-node', 180000],
  'gui-regression': ['dotnet', ['SecureFileTransfer.Client/SecureFileTransfer.GuiChecks/bin/Debug/net10.0-windows/SecureFileTransfer.GuiChecks.dll', join(root, 'artifacts/acceptance-20261125', 'gui-regression-' + Date.now())], '.', 60000],
  'pki-check': [process.execPath, ['scripts/check-pki.js'], 'server-node', 120000],
  'csharp-enhanced': [process.execPath, ['scripts/check-enhanced-csharp.js'], 'server-node', 180000],
  enhanced: [process.execPath, ['--test', '--test-concurrency=1', 'test/enhanced.test.js'], 'server-node', 180000],
  security: [process.execPath, ['--test', 'test/security.test.js'], 'server-node', 90000],
  backend: [process.execPath, ['--test', '--test-concurrency=1', 'test/*.test.js'], 'server-node', 360000],
  build: ['dotnet', ['build', 'SecureFileTransfer.Client/SecureFileTransfer.Client.slnx', '--nologo'], '.', 180000],
  smoke: [process.execPath, ['scripts/check-smoke.js'], 'server-node', 30000],
  csharp: [process.execPath, ['scripts/check-csharp.js'], 'server-node', 220000],
};
const name = process.argv[2];
if (!Object.hasOwn(checks, name)) throw new Error('Usage: node tools/validate.mjs ' + Object.keys(checks).join('|'));
const [program, args, directory, timeoutMs] = checks[name];
const startedAt = new Date().toISOString();
const output = join(root, 'artifacts/validation', `${startedAt.replace(/[:.]/g, '-')}-${name}`);
await mkdir(output, { recursive: true });
const child = spawn(program, args, { cwd: join(root, directory), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', timedOut = false;
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', text => { stdout += text; });
child.stderr.on('data', text => { stderr += text; });
// Individual suites also own and close their child fixtures; this is an outer finite deadline.
const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
let exitCode;
try { exitCode = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }); }
finally { clearTimeout(timer); }
await writeFile(join(output, 'stdout.txt'), stdout);
await writeFile(join(output, 'stderr.txt'), stderr);
const result = { name, startedAt, endedAt: new Date().toISOString(), command: [program, ...args], cwd: join(root, directory),
  exitCode, timedOut, processId: child.pid, outputDirectory: output, nodeVersion: process.version, nodeExecutable: process.execPath,
  stdoutSha256: createHash('sha256').update(await readFile(join(output, 'stdout.txt'))).digest('hex'),
  stderrSha256: createHash('sha256').update(await readFile(join(output, 'stderr.txt'))).digest('hex') };
await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
console.log(stdout.split(/\r?\n/).slice(-14).join('\n'));
if (exitCode !== 0 || timedOut) { console.error(stderr); process.exitCode = 1; }
