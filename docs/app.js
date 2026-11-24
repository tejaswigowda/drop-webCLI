import {
  APP_ID, CHUNK_SIZE, DEFAULT_STUN, HIGH_WATER_MARK, LOW_WATER_MARK, MAX_ACTIVE_RECEIVERS,
  MAX_FILES, PROTOCOL, RELAYS, STALL_MS, b64u, deriveRoom, executableWarning, formatBytes,
  hashFile, hex, makeSecret, parseInvite, sanitizeManifestNames, validateManifest,
  waitForChannelDrain,
} from './lib/core.js';

const PINS = /*PINS*/{"trystero-nostr.js":{"version":"0.27.0","package":"@trystero-p2p/nostr","sha256":"d26013f7ecae563f4fcdbf7dece219cfdb5f2d3efc2caff32df9a768d5066fc6"},"qrcode.js":{"version":"1.5.2","package":"qrcode-generator","sha256":"065509cfd450f89dbffccc8e37d16f5cb03099aef7c36ab2a23d27611bd97b03"},"sha256.js":{"version":"2.0.1","package":"@noble/hashes","sha256":"d1cc9098f317cf4c5c1652090f680cd4303a9854e345845199ccdae64269c79e"}}/*END-PINS*/;
const VERSION = '0.1.0';
const APP_DIR = (() => {
  const pathname = location.pathname;
  if (pathname.endsWith('/')) return pathname;
  const last = pathname.split('/').at(-1);
  return last.includes('.') ? pathname.slice(0, pathname.length - last.length) : `${pathname}/`;
})();
const SETTINGS_KEY = 'drop.settings';
const NOTICE_KEY = 'drop.ipNotice.1';
const DEFAULT_MEMORY_LIMIT = 256 * 1024 * 1024;
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  ? (() => { try { return JSON.parse(localStorage.getItem('drop.dev') || '{}'); } catch { return {}; } })()
  : {};
const MEMORY_LIMIT = Number(DEV.memoryLimit) || DEFAULT_MEMORY_LIMIT;
const ACTIVE_RELAYS = Array.isArray(DEV.relays) && DEV.relays.length ? DEV.relays : RELAYS;

const $ = (selector) => document.querySelector(selector);
const ui = {
  error: $('#errorBanner'), senderStart: $('#senderStart'), senderRoom: $('#senderRoom'),
  receiver: $('#receiver'), fileInput: $('#fileInput'), dropZone: $('#dropZone'),
  senderName: $('#senderName'), preparing: $('#preparing'), inviteBox: $('#inviteBox'),
  inviteLink: $('#inviteLink'), senderFiles: $('#senderFiles'), receivers: $('#receivers'),
  incomingName: $('#incomingName'), incomingFiles: $('#incomingFiles'),
  incomingWarning: $('#incomingWarning'), acceptActions: $('#acceptActions'),
  receiverStatus: $('#receiverStatus'), consolePanel: $('#consolePanel'), consoleOut: $('#consoleOut'),
  consoleIn: $('#consoleIn'), notice: $('#notice'), qrDialog: $('#qrDialog'),
};
const settings = (() => {
  try { return { name: '', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { name: '' }; }
})();
ui.senderName.value = settings.name;

const state = {
  role: null,
  room: null,
  action: null,
  selfId: null,
  secret: parseInvite(location.hash),
  lib: null,
  sha256: null,
  preparedFiles: [],
  manifest: null,
  senderName: '',
  incoming: null,
  receivers: new Map(),
  receive: new Map(),
  queue: [],
  active: new Set(),
  cancelled: false,
  senderPeerId: null,
  directory: null,
  joined: false,
  acceptedSignature: null,
};
const allPCs = new Set();
const observedSockets = new Set();
const corruptedTransfers = new Set();
const libCache = {};
const consoleLines = [];
let saveTimer;

function log(message, kind = '') {
  const line = `[${new Date().toLocaleTimeString()}] ${kind ? `${kind.toUpperCase()}: ` : ''}${message}`;
  consoleLines.push(line);
  if (consoleLines.length > 250) consoleLines.shift();
  ui.consoleOut.textContent = consoleLines.join('\n');
  ui.consoleOut.scrollTop = ui.consoleOut.scrollHeight;
}

function error(message) {
  ui.error.textContent = message;
  ui.error.classList.remove('hidden');
  log(message, 'error');
}

function clearError() {
  ui.error.classList.add('hidden');
  ui.error.textContent = '';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function show(sender) {
  ui.senderStart.classList.toggle('hidden', sender !== 'start');
  ui.senderRoom.classList.toggle('hidden', sender !== 'room');
  ui.receiver.classList.toggle('hidden', sender !== 'receiver');
}

function saveSettings() {
  settings.name = ui.senderName.value.trim().slice(0, 24);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function friendlyName() {
  const supplied = ui.senderName.value.trim().slice(0, 24);
  return supplied || `Guest ${state.selfId ? state.selfId.slice(0, 4) : '...'}`;
}

async function loadVerified(file) {
  if (libCache[file]) return libCache[file];
  const pin = PINS[file];
  if (!pin) throw new Error(`No hash pin exists for lib/${file}. The page refuses to run it.`);
  const response = await fetch(new URL(`lib/${file}`, location.origin + APP_DIR), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load lib/${file} (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  if (actual !== pin.sha256) {
    throw new Error(`lib/${file} failed its SHA-256 pin check. It will not run.`);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  try { libCache[file] = await import(url); }
  finally { URL.revokeObjectURL(url); }
  return libCache[file];
}

const NativeWebSocket = globalThis.WebSocket;
if (NativeWebSocket) {
  globalThis.WebSocket = class ObservedWebSocket extends NativeWebSocket {
    constructor(url, ...args) {
      try { observedSockets.add(new URL(url).host); } catch {}
      super(url, ...args);
    }
  };
}

class TrackedPC extends RTCPeerConnection {
  constructor(config) {
    super(config);
    this.trackedBorn = Date.now();
    allPCs.add(this);
    this.addEventListener('datachannel', (event) => onIncomingDataChannel(this, event.channel));
    this.addEventListener('connectionstatechange', () => {
      if (this.connectionState === 'closed') allPCs.delete(this);
      if (['failed', 'disconnected', 'closed'].includes(this.connectionState)) handlePeerConnectionChange(this);
    });
  }
  close() {
    allPCs.delete(this);
    return super.close();
  }
}

function peerIdForConnection(pc) {
  if (!state.room) return null;
  for (const [peerId, peer] of Object.entries(state.room.getPeers())) {
    if (peer.connection === pc) return peerId;
  }
  return null;
}

function handlePeerConnectionChange(pc) {
  const peerId = peerIdForConnection(pc);
  if (state.role === 'receiver' && peerId === state.senderPeerId) {
    for (const receive of state.receive.values()) {
      if (receive.state === 'receiving' || receive.state === 'waiting' || receive.state === 'checking') {
        receive.state = 'failed';
        receive.message = `${connectionLabel(pc)}. Incomplete data was discarded.`;
        receive.chunks = [];
      }
    }
    renderIncoming();
  }
  if (state.role === 'sender') renderReceivers();
}

function connectionLabel(pc) {
  const value = pc?.connectionState || 'connection closed';
  return `Connection ${value}`;
}

async function ensureDisclosure() {
  if (localStorage.getItem(NOTICE_KEY) === '1') return true;
  ui.notice.showModal();
  const value = await new Promise((resolve) => {
    ui.notice.addEventListener('close', () => resolve(ui.notice.returnValue), { once: true });
  });
  if (value !== 'accept') return false;
  localStorage.setItem(NOTICE_KEY, '1');
  return true;
}

async function connectRoom() {
  if (state.joined) return;
  const { roomId, password } = await deriveRoom(state.secret);
  const library = await loadVerified('trystero-nostr.js');
  state.lib = library;
  state.room = library.joinRoom({
    appId: APP_ID,
    password,
    maxUsers: 10,
    identity: 'none',
    relayConfig: { urls: ACTIVE_RELAYS, warnOnRelayFailure: false },
    rtcConfig: { iceServers: [{ urls: DEFAULT_STUN }] },
    rtcPolyfill: TrackedPC,
  }, roomId);
  state.action = state.room.makeAction('drop-v1');
  state.action.onMessage(onControl);
  state.room.onPeerJoin(onPeerJoin);
  state.room.onPeerLeave(onPeerLeave);
  state.room.onError((event) => error(`Connection error: ${event?.message || String(event)}`));
  const self = await state.room.getSelf();
  state.selfId = self.peerId;
  state.joined = true;
  log(`Joined ${roomId.slice(0, 8)} as ${state.selfId.slice(0, 8)}.`);
}

function send(peerId, message) {
  return state.action.send(message, peerId ? { target: peerId } : undefined).catch((cause) => {
    error(`Could not contact the peer: ${cause?.message || cause}`);
  });
}

function onPeerJoin({ peerId }) {
  log(`Peer ${peerId.slice(0, 8)} connected.`);
  const peerRole = state.role;
  send(peerId, { type: 'hello', role: peerRole, name: friendlyName(), protocol: PROTOCOL });
}

function onPeerLeave({ peerId }) {
  if (state.role === 'sender') {
    const receiver = state.receivers.get(peerId);
    if (receiver) receiver.disconnected = true;
    state.active.delete(peerId);
    state.queue = state.queue.filter((queued) => queued !== peerId);
    renderReceivers();
  } else if (peerId === state.senderPeerId) {
    let incomplete = false;
    for (const receive of state.receive.values()) {
      if (!['verified', 'failed', 'declined'].includes(receive.state)) {
        incomplete = true;
        receive.state = 'failed';
        receive.message = `${state.senderName || 'The sender'} closed the page; incomplete files were discarded.`;
        receive.chunks = [];
      }
    }
    if (incomplete) renderIncoming();
    error(`${state.senderName || 'The sender'} closed the page; incomplete files were discarded.`);
  }
}

async function onControl(message, context) {
  const peerId = context.peerId;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'hello') {
    if (state.role === 'sender' && message.role === 'receiver' && state.manifest) {
      const existing = state.receivers.get(peerId);
      if (existing) {
        existing.disconnected = false;
        existing.name = String(message.name || existing.name).slice(0, 24);
        existing.files.clear();
      }
      state.receivers.set(peerId, existing || {
        id: peerId, name: String(message.name || `Receiver ${peerId.slice(0, 4)}`).slice(0, 24),
        state: 'waiting', files: new Map(), disconnected: false,
      });
      renderReceivers();
      send(peerId, { type: 'manifest', ...state.manifest });
    } else if (state.role === 'receiver' && message.role === 'sender') {
      state.senderPeerId = peerId;
      state.senderName = String(message.name || `Sender ${peerId.slice(0, 4)}`).slice(0, 24);
      ui.incomingName.textContent = state.senderName;
    }
    return;
  }
  if (message.type === 'manifest' && state.role === 'receiver') {
    const invalid = validateManifest(message);
    if (invalid) {
      send(peerId, { type: 'decline', reason: invalid });
      error(`Manifest refused: ${invalid}`);
      return;
    }
    const restarting = state.receive.size > 0;
    state.senderPeerId = peerId;
    state.incoming = { ...message, files: sanitizeManifestNames(message.files) };
    if (!state.senderName) state.senderName = state.incoming.senderName || `Sender ${peerId.slice(0, 4)}`;
    ui.incomingName.textContent = state.senderName;
    state.receive.clear();
    for (const file of state.incoming.files) {
      state.receive.set(file.id, { ...file, state: 'listed', bytes: 0, chunks: [], hasher: null, message: restarting ? `restarting ${file.name} from the beginning` : '' });
    }
    show('receiver');
    renderIncoming();
    const signature = state.incoming.files.map((file) => `${file.id}:${file.sha256}`).join('|');
    if (state.acceptedSignature === signature) {
      for (const receive of state.receive.values()) {
        receive.state = 'waiting';
        receive.message = `restarting ${receive.name} from the beginning`;
        receive.hasher = state.sha256.create();
      }
      renderIncoming();
      send(peerId, { type: 'accept', ids: state.incoming.files.map((file) => file.id) });
    }
    return;
  }
  if (message.type === 'accept' && state.role === 'sender') {
    const receiver = state.receivers.get(peerId);
    if (!receiver) return;
    const ids = Array.isArray(message.ids)
      ? message.ids.filter((id) => state.preparedFiles.some((file) => file.id === id))
      : [];
    receiver.acceptedIds = ids;
    receiver.state = 'queued';
    for (const id of ids) receiver.files.set(id, { state: 'waiting', bytes: 0, message: '' });
    state.queue.push(peerId);
    renderReceivers();
    processQueue();
    return;
  }
  if (message.type === 'decline' && state.role === 'sender') {
    const receiver = state.receivers.get(peerId);
    if (receiver) receiver.state = `declined${message.reason ? `: ${message.reason}` : ''}`;
    renderReceivers();
    return;
  }
  if (message.type === 'verify' && state.role === 'sender') {
    const receiver = state.receivers.get(peerId);
    const file = receiver?.files.get(message.id);
    if (!file) return;
    file.state = message.ok ? 'verified' : 'failed';
    file.message = message.ok ? 'verified ✓' : 'receiver SHA-256 mismatch ✗';
    renderReceivers();
    return;
  }
  if (message.type === 'done' && state.role === 'receiver') {
    const receive = state.receive.get(message.id);
    if (receive?.state === 'sending') {
      receive.message = 'All bytes sent; waiting for the final chunk.';
    }
    return;
  }
  if (message.type === 'cancel') {
    const label = message.reason || 'Transfer cancelled';
    if (state.role === 'receiver') {
      const targets = message.id ? [state.receive.get(message.id)] : [...state.receive.values()];
      for (const item of targets.filter(Boolean)) {
        if (!['verified', 'failed'].includes(item.state)) {
          item.state = 'failed';
          item.message = label;
          item.chunks = [];
        }
      }
      renderIncoming();
    }
  }
}

function renderProgress(parent, percent, status) {
  const bar = element('div', `progress ${status === 'verified' ? 'ok' : status === 'failed' ? 'bad' : ''}`);
  bar.setAttribute('aria-label', `${Math.floor(percent)} percent`);
  const fill = element('span');
  fill.style.width = `${Math.min(100, percent).toFixed(1)}%`;
  bar.append(fill);
  parent.append(bar);
}

function renderSenderFiles() {
  ui.senderFiles.replaceChildren();
  for (const file of state.manifest?.files || []) {
    const row = element('div', `file${executableWarning(file.name) ? ' warn' : ''}`);
    const head = element('div', 'file-head');
    head.append(element('strong', '', file.name), element('span', '', formatBytes(file.size)));
    const meta = element('div', 'file-meta mono', `sha256 ${file.sha256}`);
    if (executableWarning(file.name)) meta.append(element('div', 'status warn', 'Program: only send this if the receiver expects it.'));
    row.append(head, meta);
    ui.senderFiles.append(row);
  }
}

function renderReceivers() {
  ui.receivers.replaceChildren();
  if (!state.receivers.size) {
    ui.receivers.append(element('div', 'empty', 'No receivers yet.'));
    return;
  }
  for (const receiver of state.receivers.values()) {
    const card = element('div', 'receiver');
    const head = element('div', 'receiver-head');
    head.append(element('strong', '', receiver.name), element('span', 'path', receiver.path || 'connecting'));
    card.append(head);
    const body = element('div', 'receiver-meta', `${receiver.state}${receiver.disconnected ? ' · disconnected' : ''}`);
    card.append(body);
    for (const source of state.preparedFiles) {
      const transfer = receiver.files.get(source.id);
      if (!transfer) continue;
      const line = element('div', 'file-meta', `${source.name}: ${transfer.message || transfer.state}`);
      if (transfer.bytes != null && source.size) renderProgress(line, transfer.bytes / source.size * 100, transfer.state);
      card.append(line);
    }
    ui.receivers.append(card);
  }
}

function renderIncoming() {
  if (!state.incoming) return;
  ui.incomingFiles.replaceChildren();
  let warning = false;
  let tooLarge = false;
  for (const file of state.incoming.files) {
    const receive = state.receive.get(file.id);
    const row = element('div', `file${executableWarning(file.name) ? ' warn' : ''}`);
    const head = element('div', 'file-head');
    head.append(element('strong', '', file.name), element('span', '', formatBytes(file.size)));
    row.append(head);
    if (file.nameChanged) row.append(element('div', 'file-meta', `Will be saved as "${file.saveName}". Original name shown above.`));
    if (executableWarning(file.name)) {
      warning = true;
      row.append(element('div', 'file-meta status warn', `This is a program. Only open it if you trust ${state.senderName || 'the sender'} and expected it.`));
    }
    const status = receive.message || receive.state;
    row.append(element('div', `file-meta status ${receive.state === 'verified' ? 'ok' : receive.state === 'failed' ? 'bad' : ''}`, status));
    if (['waiting', 'receiving', 'checking', 'verified'].includes(receive.state)) {
      renderProgress(row, file.size ? receive.bytes / file.size * 100 : 100, receive.state);
    }
    if (receive.state === 'verified') {
      row.append(element('div', 'file-meta mono', `sha256 ${file.sha256.slice(0, 8)}…`));
      if (receive.url) {
        const save = element('button', 'primary', 'Save');
        save.addEventListener('click', () => saveBlob(receive));
        row.append(save);
      } else if (receive.savedPath) row.append(element('div', 'file-meta', `Saved as ${receive.savedPath}`));
    }
    ui.incomingFiles.append(row);
    if (!state.directory && file.size > MEMORY_LIMIT) tooLarge = true;
  }
  const total = formatBytes(state.incoming.total);
  ui.incomingWarning.classList.toggle('hidden', !warning && !tooLarge);
  ui.incomingWarning.textContent = [
    warning ? 'Program files are not previewed or opened automatically.' : '',
    tooLarge ? `Too large for this browser to receive in memory (limit ${formatBytes(MEMORY_LIMIT)}). Use Chrome on a computer and choose a folder.` : '',
  ].filter(Boolean).join(' ');
  $('#acceptMemory').disabled = tooLarge;
  ui.incomingFiles.append(element('div', 'file-meta', `Total: ${total}`));
  ui.acceptActions.classList.toggle('hidden', [...state.receive.values()].some((file) => file.state !== 'listed'));
}

function saveBlob(receive) {
  const anchor = document.createElement('a');
  anchor.href = receive.url;
  anchor.download = receive.saveName;
  anchor.click();
}

async function prepareFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (files.length > MAX_FILES) {
    error(`Choose at most ${MAX_FILES} files at a time.`);
    return;
  }
  if (files.some((file) => file.name.length > 200)) {
    error('A selected file name is over 200 characters. Rename it and try again.');
    return;
  }
  clearError();
  saveSettings();
  if (!(await ensureDisclosure())) return;
  state.role = 'sender';
  state.secret ??= makeSecret();
  show('room');
  ui.preparing.classList.remove('hidden');
  ui.inviteBox.classList.add('hidden');
  state.sha256 ??= (await loadVerified('sha256.js')).sha256;
  const prepared = [];
  let completedBytes = 0;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    ui.preparing.textContent = `Preparing ${files.length} file${files.length === 1 ? '' : 's'}… 0% (${index + 1}/${files.length})`;
    const sha256 = await hashFile(file, state.sha256, (read) => {
      const percent = totalBytes ? Math.floor((completedBytes + read) / totalBytes * 100) : 100;
      ui.preparing.textContent = `Preparing ${files.length} file${files.length === 1 ? '' : 's'}… ${percent}% (${index + 1}/${files.length})`;
    });
    prepared.push({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      sha256,
      file,
    });
    completedBytes += file.size;
  }
  state.preparedFiles = prepared;
  state.manifest = {
    type: 'manifest',
    protocol: PROTOCOL,
    senderName: friendlyName(),
    files: prepared.map(({ file, ...metadata }) => metadata),
    total: prepared.reduce((sum, file) => sum + file.size, 0),
  };
  const inviteSecret = b64u.encode(state.secret);
  history.replaceState(null, '', `${location.pathname}${location.search}#k=${inviteSecret}`);
  ui.inviteLink.value = location.href;
  ui.preparing.classList.add('hidden');
  ui.inviteBox.classList.remove('hidden');
  renderSenderFiles();
  await connectRoom();
}

async function acceptIncoming(directory = null) {
  if (!state.incoming) return;
  if (!directory && state.incoming.files.some((file) => file.size > MEMORY_LIMIT)) {
    error(`Too large for this browser to receive (limit ${formatBytes(MEMORY_LIMIT)}).`);
    return;
  }
  clearError();
  state.directory = directory;
  state.sha256 ??= (await loadVerified('sha256.js')).sha256;
  state.acceptedSignature = state.incoming.files.map((file) => `${file.id}:${file.sha256}`).join('|');
  for (const file of state.incoming.files) {
    const receive = state.receive.get(file.id);
    receive.state = 'waiting';
    receive.message = `waiting for ${file.name}`;
    receive.bytes = 0;
    receive.chunks = [];
    receive.hasher = state.sha256.create();
  }
  renderIncoming();
  send(state.senderPeerId, { type: 'accept', ids: state.incoming.files.map((file) => file.id) });
}

async function processQueue() {
  while (state.active.size < MAX_ACTIVE_RECEIVERS && state.queue.length) {
    const peerId = state.queue.shift();
    const receiver = state.receivers.get(peerId);
    if (!receiver || receiver.disconnected) continue;
    state.active.add(peerId);
    transferToReceiver(peerId).finally(() => {
      state.active.delete(peerId);
      processQueue();
    });
  }
}

function getPeerConnection(peerId) {
  return state.room?.getPeers()?.[peerId]?.connection || null;
}

async function updatePeerPath(peerId) {
  const pc = getPeerConnection(peerId);
  const receiver = state.receivers.get(peerId);
  if (!pc || !receiver) return;
  try {
    const report = await pc.getStats();
    let pair = null;
    report.forEach((entry) => {
      if (entry.type === 'candidate-pair' && entry.state === 'succeeded') pair = entry;
    });
    receiver.path = pair?.nominated ? 'direct' : 'direct';
    for (const entry of report.values()) {
      if (entry.type === 'candidate-pair' && entry.state === 'succeeded') {
        const local = report.get(entry.localCandidateId);
        const remote = report.get(entry.remoteCandidateId);
        if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') receiver.path = 'relay';
      }
    }
  } catch {
    receiver.path = 'unknown path';
  }
}

async function openFileChannel(peerId, file) {
  const pc = getPeerConnection(peerId);
  if (!pc || pc.connectionState !== 'connected') throw new Error('The receiver is no longer connected.');
  const channel = pc.createDataChannel(`drop:${file.id}`);
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
  if (channel.readyState === 'open') return channel;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The file channel did not open.')), 15_000);
    channel.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    channel.addEventListener('error', () => { clearTimeout(timer); reject(new Error('The file channel failed to open.')); }, { once: true });
    channel.addEventListener('close', () => { clearTimeout(timer); reject(new Error('The file channel closed before it opened.')); }, { once: true });
  });
  return channel;
}

async function transferToReceiver(peerId) {
  const receiver = state.receivers.get(peerId);
  receiver.state = 'sending';
  await updatePeerPath(peerId);
  for (const id of receiver.acceptedIds || []) {
    const source = state.preparedFiles.find((file) => file.id === id);
    if (!source) continue;
    const transfer = receiver.files.get(id);
    transfer.state = 'opening';
    transfer.message = 'opening a dedicated data channel';
    renderReceivers();
    try {
      const channel = await openFileChannel(peerId, source);
      const reader = source.file.stream().getReader();
      let done = false;
      while (!done) {
        await waitForChannelDrain(channel);
        if (state.cancelled || receiver.disconnected || channel.readyState !== 'open') {
          throw new Error('The transfer was cancelled or the receiver disconnected.');
        }
        const next = await reader.read();
        done = next.done;
        if (done) break;
        for (let offset = 0; offset < next.value.byteLength; offset += CHUNK_SIZE) {
          await waitForChannelDrain(channel);
          const end = Math.min(offset + CHUNK_SIZE, next.value.byteLength);
          let chunk = next.value.subarray(offset, end);
          if (DEV.flipFirstByte && transfer.bytes === 0 && !corruptedTransfers.has(id)) {
            chunk = chunk.slice();
            chunk[0] ^= 1;
            corruptedTransfers.add(id);
          }
          channel.send(chunk);
          transfer.state = 'sending';
          transfer.bytes += chunk.byteLength;
          transfer.message = `sending ${Math.floor(transfer.bytes / source.size * 100)}%`;
          renderReceivers();
          if (channel.bufferedAmount > HIGH_WATER_MARK) await waitForChannelDrain(channel);
        }
      }
      transfer.state = 'checking';
      transfer.bytes = source.size;
      transfer.message = 'sent; waiting for receiver SHA-256';
      renderReceivers();
      await send(peerId, { type: 'done', id, bytes: transfer.bytes });
      channel.close();
    } catch (cause) {
      transfer.state = 'failed';
      transfer.message = cause?.message || String(cause);
      send(peerId, { type: 'cancel', id, reason: transfer.message });
      receiver.state = 'failed';
      renderReceivers();
      return;
    }
  }
  receiver.state = receiver.disconnected ? 'disconnected' : 'sent; waiting for verification';
  renderReceivers();
}

function onIncomingDataChannel(pc, channel) {
  if (!channel.label.startsWith('drop:')) return;
  const id = channel.label.slice(5);
  const receive = state.receive.get(id);
  if (!receive || !['waiting', 'listed'].includes(receive.state)) {
    channel.close();
    send(state.senderPeerId, { type: 'cancel', id, reason: 'The file was not accepted.' });
    return;
  }
  if (peerIdForConnection(pc) !== state.senderPeerId) {
    channel.close();
    return;
  }
  receive.state = 'receiving';
  receive.message = 'receiving';
  receive.lastByteAt = Date.now();
  channel.binaryType = 'arraybuffer';
  receive.writeQueue = Promise.resolve();
  receive.partName = `${receive.saveName}.part`;
  channel.addEventListener('message', (event) => {
    const bytes = event.data instanceof ArrayBuffer ? event.data : event.data?.buffer;
    if (!(bytes instanceof ArrayBuffer)) return failReceive(receive, 'Received an unsupported chunk format.');
    if (receive.bytes + bytes.byteLength > receive.size) {
      channel.close();
      return failReceive(receive, 'The sender sent more bytes than the manifest allowed.');
    }
    const chunk = new Uint8Array(bytes);
    receive.hasher.update(chunk);
    receive.bytes += chunk.byteLength;
    receive.lastByteAt = Date.now();
    receive.writeQueue = receive.writeQueue.then(async () => {
      if (state.directory) {
        receive.partHandle ??= await state.directory.getFileHandle(receive.partName, { create: true });
        receive.writer ??= await receive.partHandle.createWritable();
        await receive.writer.write(chunk);
      } else {
        receive.chunks.push(chunk.slice());
      }
    }).catch((cause) => failReceive(receive, `Could not write the file: ${cause?.message || cause}`));
    renderIncoming();
    if (receive.bytes === receive.size) finishReceive(receive).catch((cause) => failReceive(receive, cause?.message || String(cause)));
  });
  channel.addEventListener('error', () => failReceive(receive, 'The file data channel failed.'));
  channel.addEventListener('close', () => {
    if (receive.state === 'receiving') failReceive(receive, 'The connection closed before every byte arrived.');
  });
  renderIncoming();
}

async function finalizePart(receive) {
  if (receive.writer) {
    await receive.writer.close();
    receive.writer = null;
  }
  const finalHandle = await state.directory.getFileHandle(receive.saveName, { create: true });
  if (typeof receive.partHandle?.move === 'function') {
    await receive.partHandle.move(receive.saveName);
  } else {
    const file = await receive.partHandle.getFile();
    const output = await finalHandle.createWritable();
    await file.stream().pipeTo(output);
    await state.directory.removeEntry(receive.partName);
  }
  receive.savedPath = receive.saveName;
}

async function finishReceive(receive) {
  if (receive.state === 'checking' || receive.state === 'verified') return;
  receive.state = 'checking';
  receive.message = 'checking SHA-256';
  renderIncoming();
  await receive.writeQueue;
  const actual = hex(receive.hasher.digest());
  if (actual !== receive.sha256) {
    receive.state = 'failed';
    receive.chunks = [];
    if (receive.writer) await receive.writer.close().catch(() => {});
    receive.writer = null;
    receive.message = state.directory
      ? `The file arrived damaged and was discarded. ${receive.partName} is not safe: delete this file.`
      : 'The file arrived damaged and was discarded.';
    await send(state.senderPeerId, { type: 'verify', id: receive.id, ok: false });
    renderIncoming();
    return;
  }
  if (state.directory) {
    await finalizePart(receive);
  } else {
    receive.url = URL.createObjectURL(new Blob(receive.chunks, { type: receive.type || 'application/octet-stream' }));
    receive.chunks = [];
  }
  receive.state = 'verified';
  receive.message = 'verified ✓';
  await send(state.senderPeerId, { type: 'verify', id: receive.id, ok: true });
  renderIncoming();
}

function failReceive(receive, message) {
  if (!receive || ['failed', 'verified'].includes(receive.state)) return;
  receive.state = 'failed';
  receive.message = message;
  receive.chunks = [];
  if (receive.writer) receive.writer.abort().catch(() => {});
  send(state.senderPeerId, { type: 'verify', id: receive.id, ok: false });
  renderIncoming();
}

async function declineIncoming() {
  if (!state.incoming) return;
  send(state.senderPeerId, { type: 'decline' });
  ui.receiverStatus.replaceChildren(element('p', 'dim', 'Declined. No file bytes were received.'));
  ui.acceptActions.classList.add('hidden');
}

function runConsole(command) {
  const [name, argument] = command.trim().split(/\s+(.*)/);
  log(`> ${command}`, 'command');
  if (name === '/peers') {
    log(state.role === 'sender'
      ? [...state.receivers.values()].map((r) => `${r.name} (${r.id.slice(0, 8)}) ${r.state} ${r.path || ''}`).join('\n') || 'No peers.'
      : `${state.senderName || 'No sender'} ${state.senderPeerId ? state.senderPeerId.slice(0, 8) : ''}`);
  } else if (name === '/path') {
    log(state.role === 'sender'
      ? [...state.receivers.values()].map((r) => `${r.name}: ${r.path || 'unknown path'}`).join('\n') || 'No peers.'
      : 'The path is selected per connection and shown by the sender. No TURN server is configured.');
  } else if (name === '/diag') {
    log(JSON.stringify({
      app: { name: APP_ID, version: VERSION, protocol: PROTOCOL },
      role: state.role,
      self: state.selfId,
      peers: state.room ? Object.keys(state.room.getPeers()).length : 0,
      connections: [...allPCs].map((pc) => ({ state: pc.connectionState, ice: pc.iceConnectionState })),
      memoryLimit: MEMORY_LIMIT,
      streaming: !!window.showDirectoryPicker,
    }, null, 2));
  } else if (name === '/relays') {
    log(ACTIVE_RELAYS.join('\n'));
  } else if (name === '/egress') {
    log([
      'DECLARED HOSTS',
      location.host,
      ...ACTIVE_RELAYS.map((url) => new URL(url).host),
      'stun.cloudflare.com:3478',
      '<accepted peers>',
      '',
      'OBSERVED WEBSOCKETS',
      ...observedSockets,
      '',
      `Every observed WebSocket host is declared: ${[...observedSockets].every((host) => ACTIVE_RELAYS.some((url) => new URL(url).host === host))}`,
    ].join('\n'));
  } else if (name === '/hash') {
    const files = state.role === 'sender' ? state.preparedFiles : state.incoming?.files || [];
    const file = files.find((item) => item.name === argument || item.id === argument);
    log(file ? `${file.name}\n${file.sha256}\nshort: ${file.sha256.slice(0, 8)}` : `No file named "${argument || ''}".`);
  } else if (name === '/about') {
    log([
      `drop-webCLI ${VERSION} protocol ${PROTOCOL}`,
      ...Object.entries(PINS).map(([file, pin]) => `lib/${file} ${pin.package}@${pin.version} sha256:${pin.sha256} (verified at load)`),
    ].join('\n'));
  } else {
    log('Commands: /peers /path /diag /relays /egress /hash <file> /about');
  }
}

async function renderQr() {
  const qrModule = await loadVerified('qrcode.js');
  const qr = qrModule.default(0, 'M');
  qr.addData(ui.inviteLink.value);
  qr.make();
  const cells = qr.getModuleCount();
  const scale = 7;
  const quiet = 4;
  const canvas = $('#qrCanvas');
  canvas.width = canvas.height = (cells + quiet * 2) * scale;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  for (let row = 0; row < cells; row++) for (let column = 0; column < cells; column++) {
    if (qr.isDark(row, column)) context.fillRect((column + quiet) * scale, (row + quiet) * scale, scale, scale);
  }
  $('#qrText').textContent = ui.inviteLink.value;
  ui.qrDialog.showModal();
}

function initializeEvents() {
  ui.fileInput.addEventListener('change', () => prepareFiles(ui.fileInput.files));
  ui.dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    ui.dropZone.classList.add('drag');
  });
  ui.dropZone.addEventListener('dragleave', () => ui.dropZone.classList.remove('drag'));
  ui.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    ui.dropZone.classList.remove('drag');
    prepareFiles(event.dataTransfer.files);
  });
  ui.senderName.addEventListener('change', saveSettings);
  $('#copyLink').addEventListener('click', async () => {
    await navigator.clipboard.writeText(ui.inviteLink.value);
    $('#copyLink').textContent = 'Copied';
    setTimeout(() => { $('#copyLink').textContent = 'Copy link'; }, 1200);
  });
  $('#showQr').addEventListener('click', renderQr);
  $('#decline').addEventListener('click', declineIncoming);
  $('#acceptMemory').addEventListener('click', () => acceptIncoming());
  if (window.showDirectoryPicker) {
    $('#acceptFolder').classList.remove('hidden');
    $('#acceptFolder').addEventListener('click', async () => {
      try { await acceptIncoming(await window.showDirectoryPicker({ mode: 'readwrite' })); }
      catch (cause) { if (cause?.name !== 'AbortError') error(`Could not choose a folder: ${cause?.message || cause}`); }
    });
  }
  $('#consoleToggle').addEventListener('click', () => {
    const visible = ui.consolePanel.classList.toggle('hidden') === false;
    $('#consoleToggle').setAttribute('aria-pressed', String(visible));
    if (visible) ui.consoleIn.focus();
  });
  $('#consoleRun').addEventListener('click', () => { runConsole(ui.consoleIn.value); ui.consoleIn.value = ''; });
  ui.consoleIn.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { runConsole(ui.consoleIn.value); ui.consoleIn.value = ''; }
  });
}

async function boot() {
  initializeEvents();
  if (state.secret) {
    state.role = 'receiver';
    show('receiver');
    ui.incomingFiles.append(element('div', 'empty', 'Connecting to the sender…'));
    ui.acceptActions.classList.add('hidden');
    if (!(await ensureDisclosure())) {
      history.replaceState(null, '', location.pathname + location.search);
      location.reload();
      return;
    }
    await connectRoom();
    sendTimer();
  } else {
    show('start');
  }
  log(`drop-webCLI ${VERSION}; relays are public rendezvous only, file bytes are peer-to-peer.`);
}

function sendTimer() {
  setInterval(async () => {
    if (state.role === 'sender') {
      await Promise.all([...state.receivers.keys()].map(updatePeerPath));
      renderReceivers();
    }
    if (state.role === 'receiver') {
      const now = Date.now();
      for (const receive of state.receive.values()) {
        if (receive.state === 'receiving' && now - receive.lastByteAt >= STALL_MS) {
          failReceive(receive, `Stalled: no data from ${state.senderName || 'the sender'} for 15 s. ${connectionLabel(getPeerConnection(state.senderPeerId))}.`);
        }
      }
    }
  }, 1000);
}

addEventListener('pagehide', () => {
  state.cancelled = true;
  if (state.action && state.room) {
    try {
      state.action.send({ type: 'cancel', reason: 'The sender or receiver closed the page.' });
      state.room.leave();
    } catch {}
  }
});

window.drop = {
  state, allPCs, deriveRoom, executableWarning, sanitizeManifestNames, validateManifest,
  runConsole, loadVerified,
};

boot().catch((cause) => {
  error(`drop-webCLI could not start: ${cause?.message || cause}`);
  console.error(cause);
});
