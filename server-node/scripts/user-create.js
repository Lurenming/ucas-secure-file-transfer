import { emitKeypressEvents } from 'node:readline';
import { openAccounts, normalizeUsername } from '../src/accounts.js';
import { createAccount, validPassword } from '../src/passwords.js';

function hiddenInput(prompt) {
  const input = process.stdin;
  return new Promise((resolve, reject) => {
    let value = '';
    const previousRaw = Boolean(input.isRaw);
    const finish = (error) => {
      input.removeListener('keypress', keypress);
      input.removeListener('end', ended);
      input.setRawMode(previousRaw);
      input.pause();
      process.stdout.write('\n');
      if (error) { value = ''; reject(error); } else resolve(value);
    };
    const ended = () => finish(new Error('输入已结束。'));
    const keypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('已取消。'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') { value = [...value].slice(0, -1).join(''); return; }
      if (key.ctrl || key.meta || !text || /[\x00-\x1f\x7f]/.test(text) || ['left', 'right', 'up', 'down', 'delete', 'home', 'end'].includes(key.name)) return;
      if (Buffer.byteLength(value + text, 'utf8') > 256) return finish(new Error('密码超过 256 个 UTF-8 字节，输入已取消；未截断。'));
      value += text;
    };
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on('keypress', keypress);
    input.once('end', ended);
    process.stdout.write(prompt);
    input.resume();
  });
}

let store;
let password = '';
let confirmation = '';
try {
  if (process.argv.length !== 3 || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('用法：npm run user:create -- 用户名。必须在交互终端输入密码，不支持密码参数或管道。');
  }
  const username = normalizeUsername(process.argv[2]);
  store = openAccounts();
  if (store.findByUsername(username)) throw new Error('用户名已存在，未修改已有账户。');
  password = await hiddenInput('密码（至少 12 个字符，最多 256 个 UTF-8 字节，不回显）：');
  if (!validPassword(password)) throw new Error('密码长度或编码不符合要求。');
  confirmation = await hiddenInput('再次输入密码（不回显）：');
  if (password !== confirmation) throw new Error('两次密码不一致，未创建账户。');
  const user = await createAccount(store, username, password);
  console.log(`账户已创建：${user.username}。`);
} catch (error) {
  // All diagnostics are controlled local messages; never dump request data or SQL parameters.
  console.error(error.message);
  process.exitCode = 1;
} finally {
  password = '';
  confirmation = '';
  store?.close();
}
