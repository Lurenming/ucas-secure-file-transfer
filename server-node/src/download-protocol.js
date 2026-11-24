import { encodeChunk, decodeChunk } from './upload-protocol.js';

// Same 92-byte layout as P2; direction is explicit and P2 stays byte-for-byte compatible.
export function encodeDownloadChunk(requestId, downloadId, offset, data) {
  const frame = encodeChunk(requestId, downloadId, offset, data);
  frame.write('SFTD', 0, 'ascii'); frame[5] = 2;
  return frame;
}
export function decodeDownloadChunk(frame) {
  if (frame.length < 92 || frame.toString('hex', 0, 4) !== '53465444' || frame[5] !== 2) throw new Error('INVALID_CHUNK');
  const upload = Buffer.from(frame); upload.write('SFTU', 0, 'ascii'); upload[5] = 1;
  const result = decodeChunk(upload);
  return { requestId: result.requestId, downloadId: result.uploadId, offset: result.offset, data: result.data };
}
