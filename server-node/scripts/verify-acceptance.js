// Read-only audit of this acceptance fixture, never the original data directories.
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../artifacts/acceptance-20261125/manual/', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const fixture = json(join(root, 'fixture.json'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function inside(path) {
  const rel = relative(root, resolve(path));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Scoped test path required');
  return path;
}
const evidence = { at: new Date().toISOString(), passed: false, classification: 'Post-GUI filesystem/database audit; clicks evidenced separately', modes: {}, clients: {}, hashes: [] };
for (const mode of ['password', 'mtls']) {
  const config = fixture.modes[mode], directory = join(config.data, 'uploads');
  const db = new DatabaseSync(inside(join(directory, 'uploads.sqlite')), { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM files').all(), lookup = new Map(rows.map(r => [r.file_id, r]));
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    for (const seed of config.files) {
      const row = lookup.get(seed.fileId), path = join(directory, 'objects', seed.fileId + '.bin');
      assert.equal(row.state, 'committed'); assert.equal(statSync(path).size, seed.size); assert.equal(sha(path), seed.sha256);
    }
    for (const client of mode === 'password' ? ['client-password', 'client-final'] : ['client-mtls']) {
      const taskDir = join(root, client, 'tasks'), states = readdirSync(taskDir).filter(n => /^[0-9a-f-]{36}\.json$/.test(n)).map(n => json(join(taskDir, n)));
      const summary = { completed: 0, cancelled: 0, retained: 0, partFiles: readdirSync(taskDir).filter(n => n.endsWith('.part')).length,
        pendingRecordFiles: readdirSync(taskDir).filter(n => n.endsWith('.new')).length, tasks: [] };
      for (const task of states) {
        summary.tasks.push({ id: task.Id, direction: task.Direction, name: task.Name, status: task.Status, offset: task.Offset, size: task.Size, uploadId: task.UploadId });
        const objectId = task.Direction === 'upload' ? task.UploadId : task.File?.FileId;
        if (task.Status === '完成') {
          summary.completed++;
          const row = lookup.get(objectId); assert.equal(row.state, 'committed');
          const path = inside(task.LocalPath), object = join(directory, 'objects', objectId + '.bin');
          assert.equal(statSync(path).size, task.Size); assert.equal(sha(path), task.Sha256); assert.equal(sha(object), task.Sha256);
          assert.equal(existsSync(join(taskDir, task.Id + '.part')), false);
          evidence.hashes.push({ client, direction: task.Direction, fileId: objectId, name: task.Name, size: task.Size, sha256: task.Sha256 });
        } else if (task.Status === '已取消') {
          summary.cancelled++;
          assert.equal(existsSync(join(taskDir, task.Id + '.part')), false);
          if (task.Direction === 'upload') {
            assert.equal(lookup.has(objectId), false);
            assert.equal(existsSync(join(directory, 'objects', objectId + '.part')), false);
            assert.equal(existsSync(join(directory, 'objects', objectId + '.bin')), false);
          }
        } else {
          summary.retained++; const row = lookup.get(objectId);
          assert.equal(row.state, 'receiving'); assert.ok(row.durable_offset >= task.Offset);
          assert.ok(row.retain_until > Date.now()); assert.equal(existsSync(join(directory, 'objects', objectId + '.bin')), false);
        }
      }
      evidence.clients[client] = summary;
    }
    evidence.modes[mode] = { integrity: 'ok', schemaVersion: 1, seededFilesUnchanged: config.files.length,
      committed: rows.filter(r => r.state === 'committed').length, retained: rows.filter(r => r.state !== 'committed').length,
      reservedBytes: rows.reduce((sum, r) => sum + r.size, 0), quotaBytes: fixture.quotaBytesPerServer };
    assert.ok(evidence.modes[mode].reservedBytes <= fixture.quotaBytesPerServer);
  } finally { db.close(); }
}
const final = evidence.clients['client-final'];
assert.equal(final.completed, 3); assert.equal(final.cancelled, 1); assert.equal(final.retained, 0); assert.equal(final.partFiles, 0);
assert.equal(final.pendingRecordFiles, 0);
const noWrite = json(join(root, 'no-write-evidence.json'));
assert.equal(sha(join(root, 'no-write/keep.txt')).toUpperCase(), noWrite.SentinelSha256);
assert.deepEqual(readdirSync(join(root, 'no-write')), ['keep.txt']);
const archivedObservation = join(root, 'gui-observations-password.json');
const observed = json(existsSync(archivedObservation) ? archivedObservation : join(root, 'observations-password.json'));
const finalStates = readdirSync(join(root, 'client-final/tasks')).filter(n => n.endsWith('.json')).map(n => json(join(root, 'client-final/tasks', n)));
const finalStart = finalStates.map(s => s.CreatedAt).sort()[0];
const finalOverlap = observed.samples.filter(s => s.at >= new Date(finalStart).toISOString() && s.up >= 2 && s.down >= 2);
assert.ok(finalOverlap.length > 0);
evidence.finalGuiOverlap = { samples: finalOverlap.length, first: finalOverlap[0], last: finalOverlap.at(-1), sampleIntervalMs: 500 };
evidence.unwritableSentinelUnchanged = true;
evidence.initialFixtureShutdown = json(join(root, 'shutdown.json'));
evidence.finalStartupAndShutdown = json(join(root, 'startup-health-and-graceful-stop.json'));
assert.ok(evidence.finalStartupAndShutdown.PortsReleased);
for (const mode of evidence.finalStartupAndShutdown.Modes) {
  assert.equal(mode.HttpsStatus, 200); assert.equal(mode.ConnectionsAfter, 0); assert.equal(mode.ActiveAfter, 0);
}
evidence.passed = true;
writeFileSync(join(root, 'verified-results.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ passed: true, modes: evidence.modes, finalClient: final, overlap: evidence.finalGuiOverlap, verifiedHashes: evidence.hashes.length }, null, 2));
