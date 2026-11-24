// Invoke with the verified portable node.exe. Never selects a runtime from global PATH.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.version !== 'v22.23.5' || process.arch !== 'x64' || process.platform !== 'win32') {
  console.error(`Expected verified Windows x64 Node v22.23.5; refusing ${process.version} at ${process.execPath}`);
  process.exit(2);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = dirname(process.execPath);
const [action, ...args] = process.argv.slice(2);
let program = process.execPath, argv, cwd = root;
switch (action) {
  case 'info':
    console.log(JSON.stringify({ node: process.version, executable: process.execPath, arch: process.arch,
      sqlite: process.versions.sqlite, openssl: process.versions.openssl,
      npm: JSON.parse(readFileSync(join(runtime, 'node_modules/npm/package.json'), 'utf8')).version }));
    process.exit(0);
  case 'start': argv = ['server-node/src/server.js']; break;
  case 'health': argv = ['server-node/scripts/health.js']; break;
  case 'certs': argv = ['server-node/scripts/certs-dev.js']; break;
  case 'pki': argv = ['server-node/scripts/pki.js', ...args]; break;
  case 'admin': argv = ['server-node/scripts/admin.js', ...args]; break;
  case 'user-create':
    if (args.length !== 1 || !/^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(args[0])) throw new Error('Supply one valid username only; password is requested interactively');
    argv = ['server-node/scripts/user-create.js', args[0]]; break;
  case 'npm-ci':
    if (args.length > 1) throw new Error('Optional single cache directory expected');
    argv = [join(runtime, 'node_modules/npm/bin/npm-cli.js'), 'ci', '--no-audit', '--no-fund'];
    if (args[0]) argv.push('--cache', args[0]);
    cwd = join(root, 'server-node'); break;
  case 'build': case 'backend': case 'security': case 'csharp': case 'smoke': case 'enhanced': case 'csharp-enhanced': case 'pki-check': case 'storage-faults': case 'gui-regression':
    argv = ['tools/validate.mjs', action]; break;
  default: throw new Error('Usage: run-node.mjs info|start|health|certs|pki ARGS|admin ARGS|user-create USERNAME|npm-ci [CACHE]|build|backend|security|csharp|smoke|enhanced|csharp-enhanced|pki-check|storage-faults|gui-regression');
}
console.log(`[runtime] ${process.version} ${process.execPath}`);
const env = { ...process.env, SFT_NODE_EXECUTABLE: process.execPath, SFT_NODE_VERSION: process.version,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('./runtime-guard.mjs', import.meta.url).href}`.trim() };
// Windows environment names are case-insensitive. Do not pass both Path and PATH to spawn.
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = runtime + ';' + (process.env.PATH ?? process.env.Path ?? '');
const child = spawn(program, argv, { cwd, env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(`Cannot launch: ${error.code}`); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
// Console Ctrl+C is delivered to child processes too; allow the service's bounded shutdown to finish.
process.on('SIGINT', () => {});
