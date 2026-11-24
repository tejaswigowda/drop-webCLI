import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_FILES, TOPIC_LABEL, b64u, deriveRoom, executableWarning, formatBytes,
  inviteHash, parseInvite, sanitizeName, validateManifest,
} from '../docs/lib/core.js';

test('invite secret is fragment-only and exactly 128 bits', () => {
  const secret = Uint8Array.from({ length: 16 }, (_, i) => i);
  const expiresAt = Date.now() + 60_000;
  assert.deepEqual(parseInvite(inviteHash({ secret, expiresAt })), { secret, expiresAt });
  assert.equal(parseInvite('#k=short'), null);
  assert.equal(parseInvite('#k=AAAAAAAAAAAAAAAAAAAAAA=='), null);
  assert.equal(parseInvite(`#k=${b64u.encode(secret)}`), null);
});

test('drop room derivation is isolated from rtc-webCLI labels', async () => {
  assert.equal(TOPIC_LABEL, 'drop-webCLI/v1/topic');
  const secret = Uint8Array.from({ length: 16 }, (_, i) => 255 - i);
  const first = await deriveRoom(secret, 1234);
  const second = await deriveRoom(Uint8Array.from(secret, (byte) => byte ^ 1), 1234);
  const changedExpiry = await deriveRoom(secret, 5678);
  assert.match(first.roomId, /^[0-9a-f]{64}$/);
  assert.notEqual(first.roomId, second.roomId);
  assert.notEqual(first.password, second.password);
  assert.notEqual(first.roomId, changedExpiry.roomId, 'changing expiry must derive a different room');
  assert.notEqual(first.password, changedExpiry.password, 'changing expiry must change the room key');
});

test('file names strip paths, controls, dots, reserved names and collisions', () => {
  const used = new Set();
  assert.equal(sanitizeName('../../x', used).name, 'x');
  assert.equal(sanitizeName('a\u202eb.txt', used).name, 'ab.txt');
  assert.equal(sanitizeName('CON', used).name, '_CON');
  assert.equal(sanitizeName('.hidden', used).name, 'hidden');
  assert.equal(sanitizeName('report.txt', used).name, 'report.txt');
  assert.equal(sanitizeName('report.txt', used).name, 'report (2).txt');
  assert.equal(sanitizeName('', used).name, 'untitled');
});

test('program detection includes direct, script and double extensions', () => {
  for (const name of ['run.exe', 'script.js', 'photo.jpg.scr', 'installer.PKG', 'notes.tar.apk']) {
    assert.equal(executableWarning(name), true, name);
  }
  assert.equal(executableWarning('photo.jpeg'), false);
  assert.equal(executableWarning('archive.tar.gz'), false);
});

test('manifest validation enforces protocol, ids, names, hashes and exact total', () => {
  const file = { id: 'a', name: 'a.txt', size: 3, type: 'text/plain', sha256: 'a'.repeat(64) };
  assert.equal(validateManifest({ protocol: 1, files: [file], total: 3 }), null);
  assert.match(validateManifest({ protocol: 1, files: [file], total: 4 }), /total/);
  assert.match(validateManifest({ protocol: 1, files: [{ ...file, name: 'x'.repeat(201) }], total: 3 }), /name/);
  assert.match(validateManifest({ protocol: 1, files: [file, file], total: 6 }), /duplicate/);
  assert.match(validateManifest({ protocol: 1, files: Array(MAX_FILES + 1).fill(file), total: 1 }), /more than/);
});

test('byte formatting remains readable without claiming unlimited size', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(1024 ** 3), '1.00 GB');
});
