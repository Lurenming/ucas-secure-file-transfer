import { scrypt, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { normalizeUsername } from './accounts.js';

const derive = promisify(scrypt);
export const passwordPolicy = Object.freeze({ minCharacters: 12, maxBytes: 256 });
export const scryptParameters = Object.freeze({ N: 131072, r: 8, p: 1, keyLength: 64, maxmem: 192 * 1024 * 1024 });
const dummySalt = randomBytes(16);
const dummyHash = randomBytes(scryptParameters.keyLength);

export function validPassword(value) {
  return typeof value === 'string' && value.isWellFormed() && value.length <= passwordPolicy.maxBytes
    && [...value].length >= passwordPolicy.minCharacters && Buffer.byteLength(value, 'utf8') <= passwordPolicy.maxBytes;
}

function validRecord(record) {
  return record && record.algorithm === 'scrypt' && record.n === scryptParameters.N
    && record.r === scryptParameters.r && record.p === scryptParameters.p
    && record.key_length === scryptParameters.keyLength && record.maxmem === scryptParameters.maxmem
    && record.salt?.length === 16 && record.password_hash?.length === scryptParameters.keyLength;
}

export async function verifyPasswordBytes(input, record) {
  const valid = validRecord(record);
  const derived = await derive(input, valid ? record.salt : dummySalt, scryptParameters.keyLength, scryptParameters);
  try {
    const equal = timingSafeEqual(derived, valid ? record.password_hash : dummyHash);
    return Boolean(valid && equal);
  } finally { derived.fill(0); }
}

export async function createAccount(store, rawUsername, password) {
  const username = normalizeUsername(rawUsername);
  if (!validPassword(password)) throw new Error('密码至少 12 个 Unicode 字符，最多 256 个 UTF-8 字节；不截断或变换密码。');
  if (store.findByUsername(username)) throw new Error('用户名已存在，未修改已有账户。');
  const input = Buffer.from(password, 'utf8');
  const salt = randomBytes(16);
  let hash;
  try {
    hash = await derive(input, salt, scryptParameters.keyLength, scryptParameters);
    const userId = randomUUID();
    store.insert({ userId, username, hash, salt, algorithm: 'scrypt', ...scryptParameters, createdAt: new Date().toISOString() });
    return { userId, username };
  } finally { input.fill(0); hash?.fill(0); }
}
