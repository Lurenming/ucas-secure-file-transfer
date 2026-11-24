// Inherited by Node child processes through this invocation's NODE_OPTIONS only.
import { realpathSync, appendFileSync } from 'node:fs';
const normalize = value => process.platform === 'win32' ? realpathSync(value).toLowerCase() : realpathSync(value);
if (!process.env.SFT_NODE_EXECUTABLE || !process.env.SFT_NODE_VERSION
    || normalize(process.execPath) !== normalize(process.env.SFT_NODE_EXECUTABLE)
    || process.version !== process.env.SFT_NODE_VERSION) throw new Error('Unexpected Node runtime; refusing mixed-runtime execution');
if (process.env.SFT_RUNTIME_AUDIT) appendFileSync(process.env.SFT_RUNTIME_AUDIT,
  JSON.stringify({ at: new Date().toISOString(), pid: process.pid, parentPid: process.ppid,
    node: process.version, executable: process.execPath, cwd: process.cwd() }) + '\n');
