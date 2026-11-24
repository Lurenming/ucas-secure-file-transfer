import { createHmac, timingSafeEqual } from 'node:crypto';
import { validUploadId, validDisplayName } from './upload-protocol.js';

export function publicFile(row) {
  if (!row || !validUploadId(row.file_id) || !validDisplayName(row.display_name)
    || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > 100 * 1024 * 1024
    || typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256)
    || typeof row.committed_at !== 'string' || new Date(row.committed_at).toISOString() !== row.committed_at)
    throw new Error('FILE_UNAVAILABLE');
  return { fileId: row.file_id, name: row.display_name, size: row.size, sha256: row.sha256, committedAt: row.committed_at };
}
function mac(store, owner, body) { return createHmac('sha256', store.cursorKey).update(owner).update('\0').update(body).digest(); }
function cursorFor(store, owner, row) {
  const body = Buffer.from(JSON.stringify({ at: row.committed_at, id: row.file_id })).toString('base64url');
  return body + '.' + mac(store, owner, body).toString('base64url');
}
function parseCursor(store, owner, cursor) {
  try {
    if (typeof cursor !== 'string' || cursor.length > 256 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const [body, signature] = cursor.split('.'), supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== 32 || !timingSafeEqual(supplied, mac(store, owner, body))) throw new Error();
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof value.at !== 'string' || value.at.length !== 24 || new Date(value.at).toISOString() !== value.at || !validUploadId(value.id)) throw new Error();
    return value;
  } catch { throw new Error('INVALID_CURSOR'); }
}
export function fileListReply(store, owner, data, connectionId, requestId) {
  const limit = data.limit === undefined ? 10 : data.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('INVALID_MESSAGE');
  const after = data.cursor == null ? null : parseCursor(store, owner, data.cursor);
  let rows = after ? store.pageAfter.all(owner, 'committed', after.at, after.at, after.id, limit + 1)
    : store.pageFirst.all(owner, 'committed', limit + 1);
  let more = rows.length > limit; rows = rows.slice(0, limit);
  while (true) {
    const reply = { version: 1, connectionId, type: 'FILES_LIST_RESULT', requestId,
      data: { files: rows.map(publicFile), nextCursor: more && rows.length ? cursorFor(store, owner, rows.at(-1)) : null } };
    if (Buffer.byteLength(JSON.stringify(reply), 'utf8') <= 16 * 1024) return reply;
    if (rows.length <= 1) throw new Error('FILE_UNAVAILABLE');
    rows.pop(); more = true;
  }
}
