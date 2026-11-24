export const chunkBytes = 8192;
export const headerBytes = 92;
export const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validUploadId = value => typeof value === 'string' && canonicalUuid.test(value);

export function validDisplayName(name) {
  return typeof name === 'string' && name.isWellFormed() && name.length > 0 && name.length <= 120
    && Buffer.byteLength(name, 'utf8') <= 240 && !/[\x00-\x1f\x7f-\x9f<>:"/\\|?*]/u.test(name)
    && !/[. ]$/.test(name) && name !== '.' && name !== '..'
    && !/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(name);
}

// ASCII UUIDs intentionally avoid Guid.ToByteArray's mixed-endian representation.
export function encodeChunk(requestId, uploadId, offset, data) {
  if (!validUploadId(requestId) || !validUploadId(uploadId) || !Number.isSafeInteger(offset) || offset < 0
    || data.length < 1 || data.length > chunkBytes) throw new Error('INVALID_CHUNK');
  const frame = Buffer.alloc(headerBytes + data.length);
  frame.write('SFTU', 0, 'ascii'); frame[4] = 1; frame[5] = 1;
  frame.write(requestId, 8, 36, 'ascii'); frame.write(uploadId, 44, 36, 'ascii');
  frame.writeBigUInt64BE(BigInt(offset), 80); frame.writeUInt32BE(data.length, 88);
  data.copy(frame, headerBytes);
  return frame;
}

export function decodeChunk(frame) {
  if (frame.length < headerBytes || frame.toString('hex', 0, 4) !== '53465455'
    || frame[4] !== 1 || frame[5] !== 1 || frame.readUInt16BE(6) !== 0) throw new Error('INVALID_CHUNK');
  // latin1 preserves high bits so non-ASCII bytes cannot masquerade as valid UUIDs.
  const requestId = frame.toString('latin1', 8, 44), uploadId = frame.toString('latin1', 44, 80);
  const position = frame.readBigUInt64BE(80), length = frame.readUInt32BE(88);
  if (!canonicalUuid.test(requestId) || !canonicalUuid.test(uploadId) || position > BigInt(Number.MAX_SAFE_INTEGER)
    || length < 1 || length > chunkBytes || frame.length !== headerBytes + length) throw new Error('INVALID_CHUNK');
  return { requestId, uploadId, offset: Number(position), data: frame.subarray(headerBytes) };
}
