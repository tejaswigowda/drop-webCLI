import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockRelay } from './mock-relay.mjs';

const port = 19800 + Math.floor(Math.random() * 300);
const origin = `http://localhost:${port}`;
const relay = await startMockRelay();
const temp = await mkdtemp(path.join(os.tmpdir(), 'drop-resume-'));
const sourcePath = path.join(temp, 'resume-105MiB.bin');
const source = await open(sourcePath, 'w');
for (let block = 0; block < 105; block++) {
  const bytes = Buffer.allocUnsafe(1024 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (block * 31 + index * 17) & 0xff;
  await source.write(bytes);
}
await source.close();
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(port) },
  stdio: 'inherit',
});
const until = async (fn, timeout = 180_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await fn(); if (value) return value; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
};
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(origin)).ok) break; } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}

let browser;
const contexts = [];
let success = false;
try {
  browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  async function open(dev = {}) {
    const context = await browser.newContext();
    contexts.push(context);
    await context.addInitScript(({ relayUrl, dev }) => {
      localStorage.setItem('drop.ipNotice.1', '1');
      localStorage.setItem('drop.dev', JSON.stringify({ relays: [relayUrl], localIce: true, ...dev }));
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle('drop-resume-test', { create: true });
        },
      });
    }, { relayUrl: relay.url, dev });
    return context.newPage();
  }

  const sender = await open({ disconnectAfter: 32 * 1024 * 1024 });
  const receiver = await open();
  await sender.goto(origin);
  await sender.fill('#displayName', 'Alice');
  await sender.click('#createRoom');
  await sender.waitForFunction(() => document.querySelector('#inviteLink')?.value.includes('#k='));
  const invite = await sender.inputValue('#inviteLink');

  await receiver.goto(invite);
  await receiver.fill('#displayName', 'Bob');
  await receiver.click('#createRoom');
  await sender.waitForFunction(() => document.querySelector('#people')?.textContent.includes('Bob'));
  await sender.setInputFiles('#fileInput', sourcePath);
  await receiver.waitForSelector('#incoming .file');
  await receiver.getByRole('button', { name: 'Accept to folder' }).click();

  const verified = await until(async () => {
    const values = await receiver.evaluate(() => [...window.drop.state.incoming.values()].map((item) => ({
      state: item.state,
      message: item.message,
      bytes: item.bytes,
      size: item.size,
      savedPath: item.savedPath,
    })));
    return values.length === 1 && values[0].state === 'verified' ? values[0] : false;
  });
  const senderState = await until(async () => sender.evaluate(() => {
    const file = [...window.drop.state.outgoing.values()][0];
    const target = file && [...file.targets.values()][0];
    return target?.state === 'verified' ? target : false;
  }));
  const output = verified && await receiver.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('drop-resume-test');
    const handle = await directory.getFileHandle(name);
    const file = await handle.getFile();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    let partExists = true;
    try { await directory.getFileHandle('resume-105MiB.bin.part'); }
    catch (cause) { partExists = cause?.name !== 'NotFoundError'; }
    return { size: file.size, sha256, partExists };
  }, verified.savedPath);

  const expectedHash = await sender.evaluate(() => [...window.drop.state.outgoing.values()][0]?.sha256);
  success = Boolean(verified && senderState && senderState.interrupted
    && output?.size === 105 * 1024 * 1024
    && output.sha256 === expectedHash
    && output.partExists === false);
  console.log(`${success ? 'PASS' : 'FAIL'}  DR9 folder-backed 105 MiB transfer resumes after peer reconnect`,
    { bytes: verified?.bytes, resumed: senderState?.interrupted, output });
} catch (cause) {
  console.error(cause);
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
  server.kill('SIGTERM');
  await relay.close();
  await rm(temp, { recursive: true });
}

if (!success) process.exitCode = 1;
