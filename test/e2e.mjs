import { chromium, firefox } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockRelay } from './mock-relay.mjs';

const port = 19080 + Math.floor(Math.random() * 500);
const origin = `http://localhost:${port}`;
const relay = await startMockRelay();
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(port) },
  stdio: 'inherit',
});
const directory = await mkdtemp(path.join(os.tmpdir(), 'drop-webcli-'));
const first = path.join(directory, 'hello.txt');
const second = path.join(directory, 'bytes.bin');
const reply = path.join(directory, 'reply.txt');
await writeFile(first, 'browser-to-browser integrity check\n'.repeat(2000));
await writeFile(second, Buffer.alloc(700_000, 0x5a));
await writeFile(reply, 'The receiver can also send files in the same room.\n'.repeat(100));
const results = [];
const browserName = process.env.BROWSER || 'chromium';
const corrupt = process.env.CORRUPT === '1';
const check = (name, value, detail = '') => {
  results.push({ name, value });
  console.log(`${value ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const until = async (fn, timeout = 30_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await fn(); if (value) return value; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(origin)).ok) break; } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}

let browser;
let contexts = [];
try {
  const engine = browserName === 'firefox' ? firefox : chromium;
  browser = await engine.launch(browserName === 'chromium'
    ? { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] }
    : { firefoxUserPrefs: {
      'media.peerconnection.ice.obfuscate_host_addresses': false,
      'media.peerconnection.ice.default_address_only': false,
    } });
  async function open({ flipFirstByte = false, relayUrls } = {}) {
    const context = await browser.newContext();
    contexts.push(context);
    await context.addInitScript(({ relayUrl, relayUrls, flipFirstByte }) => {
      localStorage.setItem('drop.ipNotice.1', '1');
      window.__wakeLocks = { requested: 0, released: 0 };
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request: async () => {
            window.__wakeLocks.requested++;
            return {
              addEventListener() {},
              release: async () => { window.__wakeLocks.released++; },
            };
          },
        },
      });
      window.__automaticDownloads = 0;
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function (...args) {
        if (this.download && this.href.startsWith('blob:')) window.__automaticDownloads++;
        return originalClick.apply(this, args);
      };
      localStorage.setItem('drop.dev', JSON.stringify({
        relays: relayUrls || [relayUrl],
        localIce: true,
        ...(flipFirstByte ? { flipFirstByte: true } : {}),
      }));
    }, { relayUrl: relay.url, relayUrls, flipFirstByte });
    const page = await context.newPage();
    page.on('pageerror', (cause) => check('no page error', false, cause.message));
    return page;
  }

  const requests = [];
  const sender = await open({ flipFirstByte: corrupt });
  sender.on('request', (request) => requests.push(request.url()));
  await sender.goto(origin);
  await sender.fill('#displayName', 'Alice');
  await sender.click('#createRoom');
  await sender.waitForSelector('#roomScreen:not(.hidden)', { timeout: 30_000 });
  const invite = await sender.inputValue('#inviteLink');
  check('DP1 invite secret lives in fragment and is time-boxed', /#k=[-_A-Za-z0-9]{22}&e=\d+$/.test(invite), invite);

  const receiver = await open();
  receiver.on('request', (request) => requests.push(request.url()));
  await receiver.goto(invite);
  const inviteTheme = await receiver.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    header: getComputedStyle(document.querySelector('header')).backgroundColor,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    stylesheet: document.querySelector('link[rel="stylesheet"]')?.href || '',
  }));
  check('shared-link landing has the versioned webCLI theme',
    inviteTheme.background === 'rgb(13, 15, 26)'
      && inviteTheme.header === 'rgb(21, 24, 39)'
      && inviteTheme.overflow === 0
      && inviteTheme.stylesheet.includes('style.css?v='));
  check('connection diagnostics name actionable causes without IP data', await receiver.evaluate(() => {
    const pc = { _localCandidates: ['candidate:1 1 udp 1 192.168.1.2 1234 typ host'], _remoteCandidates: ['candidate:2 1 udp 1 192.168.1.3 5678 typ host'] };
    const diagnosis = window.drop.diagnoseConnection(pc);
    return diagnosis.code === 'NETWORK_ISOLATION' && !diagnosis.text.includes('192.168.');
  }));
  await receiver.fill('#displayName', 'Bob');
  await receiver.click('#createRoom');
  await receiver.waitForSelector('#roomScreen:not(.hidden)', { timeout: 45_000 });
  check('room invite opens directly in the shared room',
    await until(async () => /Alice/.test(await receiver.textContent('#people')), 10_000));
  await sender.waitForFunction(() => document.querySelector('#people')?.textContent.includes('Bob'));

  const third = await open();
  await third.goto(invite);
  await third.fill('#displayName', 'Mallory');
  await third.click('#createRoom');
  check('rooms visibly admit a third participant', await until(async () =>
    /3 people/.test(await sender.textContent('#people'))
      && /Mallory/.test(await sender.textContent('#people')), 20_000));
  await third.context().close();

  if (browserName === 'chromium' && !corrupt) {
    const noRelay = await open({ relayUrls: ['ws://127.0.0.1:1'] });
    await noRelay.goto(origin);
    await noRelay.click('#createRoom');
    check('no reachable relay produces a named error', await until(async () =>
      /RELAY_UNREACHABLE/.test(await noRelay.textContent('#errorBanner')), 12_000));
    await noRelay.context().close();
  }

  await sender.setInputFiles('#fileInput', [first, second]);
  await receiver.waitForSelector('[data-action^="accept-"]', { timeout: 45_000 });
  check('DP7 hashes are offered only after preparation',
    await until(async () => await receiver.locator('#incoming .file').count() === 2, 10_000));
  check('DP14 each file requires explicit Accept', await receiver.locator('[data-action^="accept-"]').count() === 2);
  check('incoming files show a waiting alert and tab badge',
    /2 incoming files waiting/.test(await receiver.textContent('#incomingAlert'))
      && (await receiver.title()).startsWith('(2)'));
  check('DP19 sender name is labelled unverified', /unverified/.test(await receiver.textContent('#incoming')));
  const acceptButtons = receiver.locator('[data-action^="accept-"]');
  await acceptButtons.first().click();
  check('accepting one file does not accept the other',
    await until(async () => await receiver.locator('[data-action^="accept-"]').count() === 1, 10_000));
  check('incoming alert count decreases per accepted file',
    /1 incoming file waiting/.test(await receiver.textContent('#incomingAlert'))
      && (await receiver.title()).startsWith('(1)'));
  await receiver.locator('[data-action^="accept-"]').click();
  check('receiving requests a screen wake lock', await until(async () =>
    await receiver.evaluate(() => window.__wakeLocks.requested > 0), 10_000));

  if (corrupt) {
    const receiverFailed = await until(async () => (await receiver.locator('#incoming .status.bad').count()) === 2, 45_000);
    const senderFailed = await until(async () => (await sender.locator('#outgoing').textContent()).match(/mismatch ✗/g)?.length === 2, 45_000);
    check('DP9 a transit mismatch is never presented as a file', receiverFailed && senderFailed
      && await receiver.getByRole('button', { name: 'Save' }).count() === 0
      && /discarded/.test(await receiver.textContent('#incoming')),
    `${await receiver.textContent('#incoming')} | ${await sender.textContent('#outgoing')} | saves ${await receiver.getByRole('button', { name: 'Save' }).count()}`);
  } else {
    const receiverVerified = await until(async () => (await receiver.locator('#incoming .status.ok').count()) === 2, 45_000);
    const senderVerified = await until(async () => (await sender.locator('#outgoing').textContent()).match(/verified ✓/g)?.length === 2, 45_000);
    check(`DP6–DP10 ${browserName} chunks transfer and both sides verify SHA-256`, receiverVerified && senderVerified,
      `${await receiver.textContent('#incoming')} | ${await sender.textContent('#outgoing')}`);
    check('DP15 received content downloads automatically with no Save step',
      await receiver.getByRole('button', { name: 'Save' }).count() === 0
        && await until(async () => await receiver.evaluate(() => window.__automaticDownloads === 2), 10_000));
    check('screen wake lock is released after incoming transfers finish', await until(async () =>
      await receiver.evaluate(() => window.__wakeLocks.released > 0), 10_000));

    await receiver.setInputFiles('#fileInput', reply);
    await sender.waitForSelector('[data-action^="accept-"]', { timeout: 30_000 });
    check('the receiver can send back to the same room', /reply\.txt/.test(await sender.textContent('#incoming')));
    await sender.locator('[data-action^="accept-"]').click();
    check('bidirectional room transfer verifies on both sides', await until(async () =>
      /verified ✓/.test(await sender.textContent('#incoming')) && /verified ✓/.test(await receiver.textContent('#outgoing')), 45_000));
  }

  const secret = invite.match(/#k=([-_A-Za-z0-9]{22})/)?.[1];
  check('DP1 secret appears in no request', requests.every((url) => !url.includes(secret)));
  const frames = relay.frames.join('\n');
  check('DP2 relay frames carry neither secret nor plaintext SDP',
    !frames.includes(secret) && !/a=fingerprint|a=candidate|a=ice-ufrag|m=application/.test(frames));
  check('DP25 every observed WebSocket is the configured test relay', requests
    .filter((url) => url.startsWith('ws:') || url.startsWith('wss:'))
    .every((url) => new URL(url).host === new URL(relay.url).host));

  check('active room requests browser confirmation before tab close', await receiver.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return !window.dispatchEvent(event);
  }));

  await receiver.click('#leaveRoom');
  await receiver.click('#leaveRoomDialog button[value="cancel"]');
  check('Leave room requires confirmation', await receiver.isVisible('#roomScreen')
    && (await receiver.url()).includes('#k='));
  await receiver.click('#leaveRoom');
  await receiver.click('#confirmLeaveRoom');
  await receiver.waitForSelector('#startScreen:not(.hidden)');
  check('Confirmed Leave returns home without a fragment', await receiver.url() === `${origin}/`);

  await sender.click('#newRoom');
  await sender.click('#newRoomDialog button[value="cancel"]');
  check('New room action requires confirmation', await sender.isVisible('#roomScreen')
    && (await sender.url()).includes('#k='));
  await sender.click('#newRoom');
  await sender.click('#confirmNewRoom');
  await sender.waitForSelector('#startScreen:not(.hidden)');
  check('Confirmed New returns home without a fragment', await sender.url() === `${origin}/`);
} catch (cause) {
  console.error(cause);
  console.error(`relay frames (${relay.frames.length}):`, relay.frames.slice(-20));
  for (const context of contexts) for (const page of context.pages()) {
    console.error(await page.locator('body').textContent().catch(() => 'unavailable'));
    console.error(await page.evaluate(() => ({
      peers: Object.keys(window.drop?.state.room?.getPeers() || {}),
      pcs: window.drop?.allPCs.size,
      pcStates: [...(window.drop?.allPCs || [])].map((pc) => ({ connection: pc.connectionState, ice: pc.iceConnectionState })),
      console: document.querySelector('#consoleOut')?.textContent,
      error: document.querySelector('#errorBanner')?.textContent,
    })).catch(() => 'state unavailable'));
  }
  results.push({ name: 'e2e completed without exception', value: false });
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
  server.kill('SIGTERM');
  await relay.close();
  await rm(directory, { recursive: true });
}

const failed = results.filter(({ value }) => !value);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed: ${failed.map(({ name }) => name).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${results.length} checks passed.`);
}
