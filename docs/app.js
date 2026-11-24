import {
  APP_ID, CHUNK_SIZE, DEFAULT_STUN, HIGH_WATER_MARK, LOW_WATER_MARK, MAX_ACTIVE_RECEIVERS,
  MAX_FILES, PROTOCOL, RELAYS, STALL_MS, deriveRoom, executableWarning, formatBytes,
  hashFile, hex, inviteHash, makeInviteSecret, parseInvite, sanitizeManifestNames, validateManifest,
  waitForChannelDrain,
} from './lib/core.js';

const PINS = /*PINS*/{"trystero-nostr.js":{"version":"0.27.0","package":"@trystero-p2p/nostr","sha256":"d26013f7ecae563f4fcdbf7dece219cfdb5f2d3efc2caff32df9a768d5066fc6"},"qrcode.js":{"version":"1.5.2","package":"qrcode-generator","sha256":"065509cfd450f89dbffccc8e37d16f5cb03099aef7c36ab2a23d27611bd97b03"},"sha256.js":{"version":"2.0.1","package":"@noble/hashes","sha256":"d1cc9098f317cf4c5c1652090f680cd4303a9854e345845199ccdae64269c79e"}}/*END-PINS*/;
const VERSION = '0.2.8';
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
const $ = (selector) => document.querySelector(selector);
const ui = {
  error: $('#errorBanner'), start: $('#startScreen'), room: $('#roomScreen'),
  displayName: $('#displayName'), inviteLink: $('#inviteLink'), people: $('#people'),
  sendTo: $('#sendTo'), fileInput: $('#fileInput'), dropZone: $('#dropZone'),
  preparing: $('#preparing'), incoming: $('#incoming'), outgoing: $('#outgoing'),
  incomingAlert: $('#incomingAlert'),
  consolePanel: $('#consolePanel'), consoleOut: $('#consoleOut'), consoleIn: $('#consoleIn'),
  notice: $('#notice'), qrDialog: $('#qrDialog'),
};
const settings = (() => {
  try { return { name: '', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { name: '' }; }
})();
ui.displayName.value = settings.name;
const activeRelays = () => Array.isArray(DEV.relays) && DEV.relays.length
  ? DEV.relays
  : Array.isArray(settings.relays) && settings.relays.length
    ? settings.relays
    : RELAYS;
const invite = parseInvite(location.hash);

const state = {
  room: null,
  action: null,
  selfId: null,
  secret: invite?.secret || null,
  expiresAt: invite?.expiresAt || null,
  roomCreatedAt: null,
  sha256: null,
  joined: false,
  peers: new Map(),
  incoming: new Map(),
  outgoing: new Map(),
  jobs: [],
  activeJobs: new Set(),
  departedPeers: new Map(),
  cancelled: false,
  sessionId: crypto.randomUUID(),
};
const allPCs = new Set();
const observedSockets = new Set();
const corruptedTransfers = new Set();
const libCache = {};
const consoleLines = [];
let screenWakeLock = null;

const myName = () => ui.displayName.value.trim().slice(0, 24)
  || `Guest ${state.selfId ? state.selfId.slice(0, 4) : '...'}`;
const incomingKey = (peerId, fileId) => `${peerId}:${fileId}`;
const peerName = (peerId) => state.peers.get(peerId)?.name || `Peer ${peerId.slice(0, 4)}`;
const activeIncoming = () => [...state.incoming.values()].some((receive) =>
  ['waiting', 'receiving', 'checking', 'paused'].includes(receive.state));

async function syncWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (activeIncoming() && document.visibilityState === 'visible') {
    if (!screenWakeLock) {
      try {
        screenWakeLock = await navigator.wakeLock.request('screen');
        screenWakeLock.addEventListener('release', () => { screenWakeLock = null; });
        log('Screen wake lock active while incoming files are pending.');
      } catch (cause) {
        log(`Could not keep the display awake: ${cause?.message || cause}`, 'warning');
      }
    }
  } else if (screenWakeLock) {
    await screenWakeLock.release().catch(() => {});
    screenWakeLock = null;
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function parseRelayUrls(raw) {
  const urls = String(raw || '').split(/[\n,]/).map((url) => url.trim()).filter(Boolean);
  if (!urls.length) return [];
  if (urls.length > 12) throw new Error('Choose at most 12 relays.');
  return urls.map((value) => {
    const url = new URL(value);
    const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && localhost)) {
      throw new Error(`${value} must use wss:// (ws:// is allowed only for localhost).`);
    }
    return url.href.replace(/\/$/, '');
  });
}

async function probeRelays(urls) {
  const reachable = await Promise.all(urls.map((url) => new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(url);
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 8000);
    socket.addEventListener('open', () => finish(true), { once: true });
    socket.addEventListener('error', () => finish(false), { once: true });
  })));
  return urls.filter((_, index) => reachable[index]);
}

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

function showRoom(on) {
  ui.start.classList.toggle('hidden', on);
  ui.room.classList.toggle('hidden', !on);
  $('#leaveRoom').classList.toggle('hidden', !on);
}

function saveSettings() {
  settings.name = ui.displayName.value.trim().slice(0, 24);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

async function loadVerified(file) {
  if (libCache[file]) return libCache[file];
  const pin = PINS[file];
  if (!pin) throw new Error(`No hash pin exists for lib/${file}. The page refuses to run it.`);
  const response = await fetch(new URL(`lib/${file}`, location.origin + APP_DIR), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load lib/${file} (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  if (actual !== pin.sha256) throw new Error(`lib/${file} failed its SHA-256 pin check. It will not run.`);
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
    allPCs.add(this);
    this._localCandidates = [];
    this._remoteCandidates = [];
    this.addEventListener('icecandidate', (event) => {
      if (event.candidate?.candidate) this._localCandidates.push(event.candidate.candidate);
    });
    this.addEventListener('datachannel', (event) => onIncomingDataChannel(this, event.channel));
    this.addEventListener('connectionstatechange', () => {
      if (this.connectionState === 'closed') allPCs.delete(this);
      if (['failed', 'disconnected', 'closed'].includes(this.connectionState)) handleConnectionChange(this);
    });
  }
  close() {
    allPCs.delete(this);
    return super.close();
  }
  get ondatachannel() { return this.trysteroOnDataChannel || null; }
  set ondatachannel(handler) {
    this.trysteroOnDataChannel = typeof handler === 'function' ? handler : null;
    super.ondatachannel = handler ? (event) => {
      if (!event.channel.label.startsWith('drop:')) handler.call(this, event);
    } : null;
  }
  addIceCandidate(candidate, ...rest) {
    if (candidate?.candidate) this._remoteCandidates.push(candidate.candidate);
    return super.addIceCandidate(candidate, ...rest);
  }
}

function peerIdForConnection(pc) {
  if (!state.room) return null;
  for (const [peerId, peer] of Object.entries(state.room.getPeers())) {
    if (peer.connection === pc) return peerId;
  }
  return null;
}

function getPeerConnection(peerId) {
  return state.room?.getPeers()?.[peerId]?.connection || null;
}

function connectionLabel(pc) {
  return `Connection ${pc?.connectionState || 'closed'}${pc ? ` / ICE ${pc.iceConnectionState}` : ''}`;
}

function candidateSummary(line) {
  const fields = String(line).replace(/^a=/, '').split(' ');
  const type = /\btyp (\w+)/.exec(line)?.[1] || 'unknown';
  const address = fields[4] || '';
  let addressClass;
  if (type === 'relay') addressClass = 'relay';
  else if (address.endsWith('.local')) addressClass = 'mdns';
  else if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fc|fd)/i.test(address)) addressClass = 'private';
  else addressClass = 'public';
  return { type, addressClass };
}

function diagnoseConnection(pc) {
  const local = pc?._localCandidates.map(candidateSummary) || [];
  const remote = [
    ...(pc?.remoteDescription?.sdp.match(/^a=candidate:.*$/gm) || []).map((line) => candidateSummary(line)),
    ...(pc?._remoteCandidates.map(candidateSummary) || []),
  ];
  const host = (items) => items.filter((item) => item.type === 'host');
  const localMdns = host(local).some((item) => item.addressClass === 'mdns');
  const remoteMdns = host(remote).some((item) => item.addressClass === 'mdns');
  const localPrivate = host(local).some((item) => item.addressClass === 'private');
  const remotePrivate = host(remote).some((item) => item.addressClass === 'private');
  if (!local.length || !remote.length) {
    return { code: 'NO_CANDIDATES', text: 'One browser offered no usable connection candidates. A VPN, browser privacy setting, or restrictive network may be blocking WebRTC.' };
  }
  if (localMdns || remoteMdns) {
    return { code: 'HIDDEN_LOCAL_ADDRESS', text: 'One browser hid a same-network address behind an mDNS name. Try another browser, disable the browser’s WebRTC mDNS hiding for this test, or use a cellular network.' };
  }
  if (localPrivate && remotePrivate) {
    return { code: 'NETWORK_ISOLATION', text: 'Both devices offered local-network addresses, but the network did not let them connect. Guest Wi-Fi, client isolation, a VPN, or a device firewall may be keeping them apart. Try cellular or a different network.' };
  }
  return { code: 'NO_DIRECT_PATH', text: 'The browsers could not find a direct network path. Try cellular or another network. No TURN relay is configured, so this version cannot cross every NAT or firewall.' };
}

function onRoomError(event) {
  if (event?.code === 'room-full') {
    error('ROOM_FULL: this room has reached its visible 10-participant limit. Ask the participants for a new room link.');
    return;
  }
  if (event?.code !== 'peer-connect-failed') {
    error(`Connection error: ${event?.message || String(event)}`);
    return;
  }
  const pc = [...allPCs].find((item) => item.connectionState === 'failed' || item.iceConnectionState === 'failed');
  const diagnosis = diagnoseConnection(pc);
  const who = peerName(event.peerId);
  error(`Couldn't connect to ${who}. ${diagnosis.text} [${diagnosis.code}]`);
}

function handleConnectionChange(pc) {
  const peerId = peerIdForConnection(pc);
  if (!peerId) return;
  for (const receive of state.incoming.values()) {
    if (receive.peerId === peerId && ['waiting', 'receiving', 'checking'].includes(receive.state)) {
      if (receive.directory && receive.bytes > 0) {
        receive.state = 'paused';
        receive.message = `${connectionLabel(pc)}. Keeping the verified-prefix .part file for resume.`;
      } else {
        receive.state = 'failed';
        receive.message = `${connectionLabel(pc)}. Incomplete data was discarded.`;
        receive.chunks = [];
      }
    }
  }
  renderIncoming();
  renderOutgoing();
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
  if (!state.expiresAt || state.expiresAt <= Date.now()) {
    throw new Error('This room invite expired. Ask for a newly created link.');
  }
  const relays = activeRelays();
  const reachable = await probeRelays(relays);
  if (!reachable.length) throw new Error(`RELAY_UNREACHABLE: none of the ${relays.length} configured Nostr relays responded within 8 seconds.`);
  if (reachable.length !== relays.length) log(`${reachable.length}/${relays.length} configured relays are reachable.`, 'warning');
  const { roomId, password } = await deriveRoom(state.secret, state.expiresAt);
  const library = await loadVerified('trystero-nostr.js');
  state.room = library.joinRoom({
    appId: APP_ID,
    password,
    maxUsers: 10,
    identity: 'none',
    relayConfig: { urls: reachable, warnOnRelayFailure: false },
    rtcConfig: { iceServers: DEV.localIce ? [] : [{ urls: DEFAULT_STUN }] },
    rtcPolyfill: TrackedPC,
  }, roomId);
  state.action = state.room.makeAction('drop-room-v2');
  state.action.onMessage(onControl);
  state.room.onPeerJoin(onPeerJoin);
  state.room.onPeerLeave(onPeerLeave);
  state.room.onError(onRoomError);
  const self = await state.room.getSelf();
  state.selfId = self.peerId;
  state.joined = true;
  showRoom(true);
  ui.inviteLink.value = `${location.origin}${APP_DIR}${inviteHash({ secret: state.secret, expiresAt: state.expiresAt })}`;
  history.replaceState(null, '', ui.inviteLink.value);
  renderPeople();
  log(`Joined room ${roomId.slice(0, 8)} as ${state.selfId.slice(0, 8)}.`);
}

async function enterRoom(create = false) {
  clearError();
  saveSettings();
  const button = $('#createRoom');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = create ? 'Creating room…' : 'Joining room…';
  button.setAttribute('aria-busy', 'true');
  try {
    if (!(await ensureDisclosure())) return;
    if (create) {
      const newInvite = makeInviteSecret();
      state.secret = newInvite.secret;
      state.expiresAt = newInvite.expiresAt;
      state.roomCreatedAt = Date.now();
    }
    if (!state.secret) {
      error('This invite link is invalid. Ask for a new room link.');
      return;
    }
    await connectRoom();
    setInterval(tick, 1000);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
    button.removeAttribute('aria-busy');
  }
}

function send(peerId, message) {
  return state.action.send(message, peerId ? { target: peerId } : undefined).catch((cause) => {
    error(`Could not contact the peer: ${cause?.message || cause}`);
    return false;
  });
}

function onPeerJoin({ peerId }) {
  log(`Peer ${peerId.slice(0, 8)} connected.`);
  state.peers.set(peerId, { id: peerId, name: `Peer ${peerId.slice(0, 4)}`, path: 'connecting' });
  renderPeople();
  send(peerId, {
    type: 'hello', name: myName(), protocol: PROTOCOL,
    sessionId: state.sessionId,
  });
}

function onPeerLeave({ peerId }) {
  const peer = state.peers.get(peerId);
  state.peers.delete(peerId);
  if (peer?.sessionId) state.departedPeers.set(peer.sessionId, peer);
  for (const outgoing of state.outgoing.values()) {
    const target = outgoing.targets.get(peerId);
    if (target && !['verified', 'failed'].includes(target.state)) {
      target.state = 'paused';
      target.message = `${peer?.name || 'The peer'} disconnected; waiting to reconnect for resume.`;
    }
  }
  for (const receive of state.incoming.values()) {
    if (receive.peerId === peerId && !['verified', 'failed', 'declined'].includes(receive.state)) {
      receive.state = receive.directory && receive.bytes > 0 ? 'paused' : 'failed';
      receive.message = receive.state === 'paused'
        ? `${peer?.name || 'The sender'} disconnected; the .part file is ready to resume.`
        : `${peer?.name || 'The sender'} left the room; incomplete data was discarded.`;
      if (receive.state === 'failed') receive.chunks = [];
    }
  }
  renderPeople();
  renderIncoming();
  renderOutgoing();
}

function migratePeer(oldPeerId, newPeerId, sessionId) {
  const oldPeer = state.departedPeers.get(sessionId);
  if (!oldPeer || oldPeer.id !== oldPeerId) return false;
  for (const outgoing of state.outgoing.values()) {
    if (!outgoing.targets.has(oldPeerId)) continue;
    const target = outgoing.targets.get(oldPeerId);
    outgoing.targets.delete(oldPeerId);
    outgoing.targets.set(newPeerId, target);
  }
  for (const [key, receive] of [...state.incoming]) {
    if (receive.peerId !== oldPeerId) continue;
    state.incoming.delete(key);
    receive.peerId = newPeerId;
    state.incoming.set(incomingKey(newPeerId, receive.id), receive);
  }
  state.departedPeers.delete(sessionId);
  return true;
}

async function onControl(message, context) {
  const peerId = context.peerId;
  if (!message || typeof message !== 'object' || message.protocol && message.protocol !== PROTOCOL) return;
  if (message.type === 'hello') {
    const peer = state.peers.get(peerId);
    if (peer) {
      peer.name = String(message.name || peer.name).slice(0, 24);
      peer.sessionId = String(message.sessionId || '');
      const oldPeer = state.departedPeers.get(peer.sessionId);
      if (oldPeer && migratePeer(oldPeer.id, peerId, peer.sessionId)) {
        log(`Reconnected to ${peer.name}; folder-backed transfers can resume.`);
        for (const receive of state.incoming.values()) {
          if (receive.peerId === peerId && receive.state === 'paused' && receive.directory) {
            receive.state = 'waiting';
            receive.message = `resuming from ${formatBytes(receive.bytes)}`;
            send(peerId, { type: 'resume', fileId: receive.id, offset: receive.bytes });
          }
        }
      }
    }
    renderPeople();
    return;
  }
  if (message.type === 'offer') {
    const invalid = validateManifest({
      protocol: PROTOCOL,
      files: [message.file],
      total: message.file?.size,
    });
    if (invalid) {
      send(peerId, { type: 'decline', fileId: message.file?.id, reason: invalid });
      error(`Refused an offer from ${peerName(peerId)}: ${invalid}`);
      return;
    }
    const [safeFile] = sanitizeManifestNames([message.file]);
    const key = incomingKey(peerId, safeFile.id);
    state.incoming.set(key, {
      ...safeFile,
      peerId,
      senderName: peerName(peerId),
      state: 'offered',
      bytes: 0,
      chunks: [],
      hasher: null,
      message: '',
    });
    renderIncoming();
    notifyIncoming(state.incoming.get(key));
    return;
  }
  if (message.type === 'accept') {
    const outgoing = state.outgoing.get(message.fileId);
    const target = outgoing?.targets.get(peerId);
    if (!target) return;
    target.state = 'queued';
    target.message = 'accepted; waiting to send';
    state.jobs.push({ peerId, fileId: message.fileId, offset: 0 });
    renderOutgoing();
    processJobs();
    return;
  }
  if (message.type === 'decline') {
    const target = state.outgoing.get(message.fileId)?.targets.get(peerId);
    if (!target) return;
    target.state = 'failed';
    target.message = `declined${message.reason ? `: ${message.reason}` : ''}`;
    renderOutgoing();
    return;
  }
  if (message.type === 'done') {
    const receive = state.incoming.get(incomingKey(peerId, message.fileId));
    if (receive?.state === 'verified' || receive?.state === 'failed') {
      send(peerId, { type: 'verify', fileId: receive.id, ok: receive.state === 'verified' });
    }
    return;
  }
  if (message.type === 'verify') {
    const target = state.outgoing.get(message.fileId)?.targets.get(peerId);
    if (!target) return;
    target.state = message.ok ? 'verified' : 'failed';
    target.message = message.ok ? 'verified ✓' : 'receiver SHA-256 mismatch ✗';
    renderOutgoing();
    return;
  }
  if (message.type === 'resume') {
    const outgoing = state.outgoing.get(message.fileId);
    const target = outgoing?.targets.get(peerId);
    if (!outgoing || !target) return;
    const offset = Number(message.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= outgoing.size || offset % CHUNK_SIZE !== 0) {
      target.state = 'failed';
      target.message = 'receiver requested an invalid resume offset';
      send(peerId, { type: 'cancel', fileId: message.fileId, reason: target.message });
      renderOutgoing();
      return;
    }
    target.state = 'queued';
    target.bytes = offset;
    target.message = `resuming from ${formatBytes(offset)}`;
    state.jobs = state.jobs.filter((job) => !(job.peerId === peerId && job.fileId === message.fileId));
    state.jobs.push({ peerId, fileId: message.fileId, offset });
    renderOutgoing();
    processJobs();
    return;
  }
  if (message.type === 'cancel') {
    const receive = state.incoming.get(incomingKey(peerId, message.fileId));
    if (receive && !['verified', 'failed'].includes(receive.state)) {
      receive.state = 'failed';
      receive.message = message.reason || 'Transfer cancelled.';
      receive.chunks = [];
      renderIncoming();
    }
    return;
  }
  if (message.type === 'cancel-all') {
    for (const receive of state.incoming.values()) {
      if (receive.peerId !== peerId || ['verified', 'failed', 'declined'].includes(receive.state)) continue;
      receive.state = 'failed';
      receive.message = message.reason || 'The sender left the room.';
      receive.chunks = [];
    }
    for (const outgoing of state.outgoing.values()) {
      const target = outgoing.targets.get(peerId);
      if (target && !['verified', 'failed'].includes(target.state)) {
        target.state = 'failed';
        target.message = message.reason || 'The recipient left the room.';
      }
    }
    renderIncoming();
    renderOutgoing();
    return;
  }
}

function renderPeople() {
  const previousTarget = ui.sendTo.value;
  ui.people.replaceChildren();
  ui.sendTo.replaceChildren();
  ui.sendTo.append(new Option('Everyone', 'all'));
  const self = element('div', 'person self');
  self.append(element('strong', '', `${myName()} (you)`),
    element('span', 'dim', `${state.selfId?.slice(0, 8) || 'joining'} · ${state.peers.size + 1} people · 10 max`));
  ui.people.append(self);
  if (!state.peers.size) {
    ui.people.append(element('span', 'dim', 'Invite people. Rooms are limited to 10 participants.'));
    return;
  }
  for (const peer of state.peers.values()) {
    const row = element('div', 'person');
    row.append(element('strong', '', peer.name), element('span', 'dim', `${(peer.sessionId || peer.id).slice(0, 8)} · ${peer.path || 'connecting'} · unverified name`));
    ui.people.append(row);
    ui.sendTo.append(new Option(peer.name, peer.id));
  }
  if ([...ui.sendTo.options].some((option) => option.value === previousTarget)) ui.sendTo.value = previousTarget;
}

function progressRow(parent, bytes, size, status) {
  const progress = element('div', `progress ${status === 'verified' ? 'ok' : status === 'failed' ? 'bad' : ''}`);
  const fill = element('span');
  fill.style.width = `${size ? Math.min(100, bytes / size * 100).toFixed(1) : 100}%`;
  progress.append(fill);
  parent.append(progress);
}

function appendFileHeading(card, file) {
  const head = element('div', 'file-head');
  head.append(element('strong', '', file.name), element('span', '', formatBytes(file.size)));
  card.append(head);
  if (file.nameChanged) card.append(element('div', 'file-meta', `Will be saved as "${file.saveName}".`));
  if (executableWarning(file.name)) {
    card.classList.add('warn');
    card.append(element('div', 'file-meta status warn', 'This is a program. Only accept it if you expected it and trust the sender.'));
  }
}

function renderIncoming() {
  ui.incoming.replaceChildren();
  if (!state.incoming.size) {
    ui.incoming.append(element('div', 'empty', 'No incoming files.'));
    return;
  }
  for (const receive of state.incoming.values()) {
    const card = element('div', `file ${receive.state === 'failed' ? 'failed' : ''}`);
    appendFileHeading(card, receive);
    card.append(element('div', 'file-meta', `From ${receive.senderName} (unverified)`));
    card.append(element('div', `status ${receive.state === 'verified' ? 'ok' : receive.state === 'failed' ? 'bad' : ''}`,
      receive.message || receive.state));
    if (['waiting', 'receiving', 'checking', 'verified'].includes(receive.state)) {
      progressRow(card, receive.bytes, receive.size, receive.state);
    }
    if (receive.state === 'offered') {
      const actions = element('div', 'actions compact-actions');
      const decline = element('button', '', 'Decline');
      decline.dataset.action = `decline-${receive.peerId}-${receive.id}`;
      decline.addEventListener('click', () => declineIncoming(receive));
      const accept = element('button', 'primary', 'Accept');
      accept.dataset.action = `accept-${receive.peerId}-${receive.id}`;
      accept.addEventListener('click', () => acceptIncoming(receive));
      actions.append(decline, accept);
      if (window.showDirectoryPicker) {
        const folder = element('button', '', 'Accept to folder');
        folder.addEventListener('click', async () => {
          try { await acceptIncoming(receive, await window.showDirectoryPicker({ mode: 'readwrite' })); }
          catch (cause) { if (cause?.name !== 'AbortError') error(`Could not choose a folder: ${cause?.message || cause}`); }
        });
        actions.append(folder);
      }
      if (!window.showDirectoryPicker && receive.size > MEMORY_LIMIT) {
        accept.disabled = true;
        card.append(element('div', 'file-meta status warn',
          `Too large for this browser (limit ${formatBytes(MEMORY_LIMIT)}). Use Chrome on a computer and choose a folder.`));
      }
      card.append(actions);
    }
    if (receive.state === 'verified') {
      card.append(element('div', 'file-meta mono', `sha256 ${receive.sha256.slice(0, 8)}…`));
      if (receive.downloaded) card.append(element('div', 'file-meta status ok', `downloaded as ${receive.saveName}`));
      else if (receive.savedPath) card.append(element('div', 'file-meta', `Saved as ${receive.savedPath}`));
    }
    ui.incoming.append(card);
  }
  renderIncomingAlert();
}

function renderIncomingAlert() {
  const pending = [...state.incoming.values()].filter((receive) => receive.state === 'offered');
  if (!pending.length) {
    ui.incomingAlert.classList.add('hidden');
    ui.incomingAlert.replaceChildren();
    document.title = 'drop-webCLI';
    return;
  }
  const people = new Set(pending.map((receive) => receive.senderName));
  const count = pending.length;
  const message = element('span');
  const strong = element('strong', '', `${count} incoming file${count === 1 ? '' : 's'} waiting`);
  message.append(strong, ` from ${[...people].join(', ')}. Review and accept each file before anything transfers.`);
  const review = element('button', '', 'Review files');
  review.addEventListener('click', () => ui.incoming.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  ui.incomingAlert.replaceChildren(message, review);
  ui.incomingAlert.classList.remove('hidden');
  document.title = `(${count}) drop-webCLI`;
}

function notifyIncoming(receive) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification('Incoming file', {
    body: `${receive.senderName} wants to send ${receive.name}. Accept each file in drop-webCLI.`,
    tag: `drop-${receive.peerId}-${receive.id}`,
  });
}

function renderOutgoing() {
  ui.outgoing.replaceChildren();
  if (!state.outgoing.size) {
    ui.outgoing.append(element('div', 'empty', 'No outgoing files.'));
    return;
  }
  for (const outgoing of state.outgoing.values()) {
    const card = element('div', 'file');
    appendFileHeading(card, outgoing);
    card.append(element('div', 'file-meta mono', `sha256 ${outgoing.sha256.slice(0, 8)}…`));
    for (const [peerId, target] of outgoing.targets) {
      const line = element('div', 'file-meta', `${peerName(peerId)}: ${target.message || target.state}`);
      if (['sending', 'checking', 'verified'].includes(target.state)) progressRow(line, target.bytes, outgoing.size, target.state);
      card.append(line);
    }
    ui.outgoing.append(card);
  }
}

async function prepareFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const targetIds = ui.sendTo.value === 'all' ? [...state.peers.keys()] : [ui.sendTo.value];
  if (!targetIds.length || targetIds.some((id) => !state.peers.has(id))) {
    error('Invite at least one person before sending files.');
    ui.fileInput.value = '';
    return;
  }
  if (files.length > MAX_FILES) {
    error(`Choose at most ${MAX_FILES} files at a time.`);
    return;
  }
  if (files.some((file) => file.name.length > 200)) {
    error('A selected file name is over 200 characters. Rename it and try again.');
    return;
  }
  clearError();
  state.sha256 ??= (await loadVerified('sha256.js')).sha256;
  ui.preparing.classList.remove('hidden');
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;
  for (let index = 0; index < files.length; index++) {
    const source = files[index];
    const sha256 = await hashFile(source, state.sha256, (read) => {
      const percent = total ? Math.floor((completed + read) / total * 100) : 100;
      ui.preparing.textContent = `Preparing ${files.length} file${files.length === 1 ? '' : 's'}… ${percent}% (${index + 1}/${files.length})`;
    });
    const outgoing = {
      id: crypto.randomUUID(), name: source.name, size: source.size,
      type: source.type || 'application/octet-stream', sha256, source,
      targets: new Map(targetIds.map((peerId) => [peerId, { state: 'offered', bytes: 0, message: 'waiting for acceptance' }])),
    };
    state.outgoing.set(outgoing.id, outgoing);
    for (const peerId of targetIds) {
      await send(peerId, {
        type: 'offer',
        protocol: PROTOCOL,
        file: {
          id: outgoing.id, name: outgoing.name, size: outgoing.size,
          type: outgoing.type, sha256: outgoing.sha256,
        },
      });
    }
    completed += source.size;
  }
  ui.preparing.classList.add('hidden');
  ui.fileInput.value = '';
  renderOutgoing();
}

async function acceptIncoming(receive, directory = null) {
  if (receive.size > MEMORY_LIMIT && !directory) {
    error(`Too large for this browser to receive in memory (limit ${formatBytes(MEMORY_LIMIT)}). Choose a folder in Chrome.`);
    return;
  }
  state.sha256 ??= (await loadVerified('sha256.js')).sha256;
  receive.state = 'waiting';
  receive.message = 'accepted; waiting for bytes';
  receive.bytes = 0;
  receive.receivedBytes = 0;
  receive.chunks = [];
  receive.hasher = state.sha256.create();
  receive.directory = directory;
  receive.partName = `${receive.saveName}.part`;
  renderIncoming();
  await syncWakeLock();
  send(receive.peerId, { type: 'accept', fileId: receive.id });
}

function declineIncoming(receive) {
  receive.state = 'declined';
  receive.message = 'declined';
  send(receive.peerId, { type: 'decline', fileId: receive.id });
  renderIncoming();
  void syncWakeLock();
}

function processJobs() {
  while (state.activeJobs.size < MAX_ACTIVE_RECEIVERS && state.jobs.length) {
    const job = state.jobs.shift();
    const key = `${job.peerId}:${job.fileId}`;
    if (state.activeJobs.has(key)) continue;
    const outgoing = state.outgoing.get(job.fileId);
    const target = outgoing?.targets.get(job.peerId);
    if (!outgoing || !target || target.state !== 'queued') continue;
    state.activeJobs.add(key);
    transferToPeer(job).finally(() => {
      state.activeJobs.delete(key);
      processJobs();
    });
  }
}

async function openFileChannel(peerId, fileId) {
  const pc = getPeerConnection(peerId);
  if (!pc || pc.connectionState !== 'connected') throw new Error('The receiving peer is no longer connected.');
  const channel = pc.createDataChannel(`drop:${fileId}`);
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
  if (channel.readyState === 'open') return channel;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The file channel did not open.')), STALL_MS);
    channel.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    channel.addEventListener('error', () => { clearTimeout(timer); reject(new Error('The file channel failed to open.')); }, { once: true });
    channel.addEventListener('close', () => { clearTimeout(timer); reject(new Error('The file channel closed before it opened.')); }, { once: true });
  });
  return channel;
}

async function waitForChannelEmpty(channel) {
  const started = Date.now();
  while (channel.readyState === 'open' && channel.bufferedAmount > 0) {
    if (Date.now() - started > STALL_MS) throw new Error('The connection stalled while draining the final file chunk.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (channel.readyState !== 'open') throw new Error('The file channel closed before its final bytes drained.');
}

async function waitForVerification(target) {
  const started = Date.now();
  while (!['verified', 'failed'].includes(target.state)) {
    if (Date.now() - started > STALL_MS) throw new Error('The receiver did not confirm the SHA-256 within 15 seconds.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return target.state === 'verified';
}

async function transferToPeer({ peerId, fileId, offset = 0 }) {
  const outgoing = state.outgoing.get(fileId);
  const target = outgoing?.targets.get(peerId);
  if (!outgoing || !target) return;
  try {
    target.state = 'opening';
    target.message = 'opening a dedicated data channel';
    renderOutgoing();
    const channel = await openFileChannel(peerId, fileId);
    const reader = outgoing.source.slice(offset).stream().getReader();
    let done = false;
    while (!done) {
      await waitForChannelDrain(channel);
      if (state.cancelled || channel.readyState !== 'open') throw new Error('The transfer or connection was closed.');
      const next = await reader.read();
      done = next.done;
      if (done) break;
      for (let offset = 0; offset < next.value.byteLength; offset += CHUNK_SIZE) {
        await waitForChannelDrain(channel);
        let chunk = next.value.subarray(offset, Math.min(offset + CHUNK_SIZE, next.value.byteLength));
        if (DEV.disconnectAfter && target.bytes >= Number(DEV.disconnectAfter) && !target.interrupted) {
          target.interrupted = true;
          getPeerConnection(peerId)?.close();
          throw new Error('Test peer disconnect after configured byte count.');
        }
        if (DEV.flipFirstByte && target.bytes === 0 && !corruptedTransfers.has(fileId)) {
          chunk = chunk.slice();
          chunk[0] ^= 1;
          corruptedTransfers.add(fileId);
        }
        channel.send(chunk);
        target.state = 'sending';
        target.bytes += chunk.byteLength;
        target.message = `sending ${Math.floor(target.bytes / outgoing.size * 100)}%`;
        renderOutgoing();
        if (channel.bufferedAmount > HIGH_WATER_MARK) await waitForChannelDrain(channel);
      }
    }
    await waitForChannelEmpty(channel);
    target.state = 'checking';
    target.message = 'sent; waiting for receiver SHA-256';
    renderOutgoing();
    await send(peerId, { type: 'done', fileId, bytes: target.bytes });
    await waitForVerification(target);
    channel.close();
  } catch (cause) {
    if (!['verified', 'failed'].includes(target.state)) {
      target.state = 'paused';
      target.message = cause?.message || 'Interrupted; waiting for the receiver to request resume.';
    }
    renderOutgoing();
  }
}

function findIncoming(peerId, fileId) {
  return state.incoming.get(incomingKey(peerId, fileId));
}

async function pauseIncomingForResume(receive, pc) {
  if (!receive.directory || receive.bytes >= receive.size || receive.bytes % CHUNK_SIZE !== 0) return false;
  receive.state = 'paused';
  receive.message = `waiting to resume from ${formatBytes(receive.bytes)}`;
  await receive.writeQueue;
  await receive.writer?.close().catch(() => {});
  receive.writer = null;
  receive.writerSeek = null;
  renderIncoming();
  void syncWakeLock();
  if (pc.connectionState === 'connected' && state.peers.has(receive.peerId)) {
    receive.state = 'waiting';
    receive.message = `resuming from ${formatBytes(receive.bytes)}`;
    send(receive.peerId, { type: 'resume', fileId: receive.id, offset: receive.bytes });
  }
  return true;
}

function onIncomingDataChannel(pc, channel) {
  if (!channel.label.startsWith('drop:')) return;
  const peerId = peerIdForConnection(pc);
  const receive = peerId && findIncoming(peerId, channel.label.slice(5));
  if (!receive || receive.state !== 'waiting') {
    channel.close();
    if (peerId) send(peerId, { type: 'cancel', fileId: channel.label.slice(5), reason: 'That file was not accepted.' });
    return;
  }
  channel.binaryType = 'arraybuffer';
  receive.state = 'receiving';
  receive.message = 'receiving';
  receive.lastByteAt = Date.now();
  receive.writeQueue = Promise.resolve();
  channel.addEventListener('message', (event) => {
    const bytes = event.data instanceof ArrayBuffer ? event.data : event.data?.buffer;
    if (!(bytes instanceof ArrayBuffer)) return failReceive(receive, 'Received an unsupported chunk format.');
    if (receive.receivedBytes + bytes.byteLength > receive.size) {
      channel.close();
      return failReceive(receive, 'The sender sent more bytes than the accepted file size.');
    }
    const chunk = new Uint8Array(bytes);
    receive.hasher.update(chunk);
    receive.receivedBytes += chunk.byteLength;
    receive.lastByteAt = Date.now();
    receive.writeQueue = receive.writeQueue.then(async () => {
      if (receive.directory) {
        receive.partHandle ??= await receive.directory.getFileHandle(receive.partName, { create: true });
        receive.writer ??= await receive.partHandle.createWritable({ keepExistingData: receive.bytes > chunk.byteLength });
        if (receive.writer && receive.bytes > chunk.byteLength && receive.writerSeek == null) {
          await receive.writer.seek?.(receive.bytes);
          receive.writerSeek = receive.bytes;
        }
        await receive.writer.write(chunk);
      } else {
        receive.chunks.push(chunk.slice());
      }
      receive.bytes += chunk.byteLength;
      renderIncoming();
      void syncWakeLock();
    }).catch((cause) => failReceive(receive, `Could not write the file: ${cause?.message || cause}`));
    if (receive.receivedBytes === receive.size) {
      receive.writeQueue.then(() => finishReceive(receive)).catch((cause) => failReceive(receive, cause?.message || String(cause)));
    }
    renderIncoming();
  });
  channel.addEventListener('error', async () => {
    if (!await pauseIncomingForResume(receive, pc)) {
      failReceive(receive, `The file data channel failed. ${connectionLabel(pc)}.`);
    }
  });
  channel.addEventListener('close', async () => {
    if (receive.state !== 'receiving') return;
    if (!await pauseIncomingForResume(receive, pc)) {
      failReceive(receive, `The file channel closed before every byte arrived (${receive.bytes}/${receive.size}).`);
    }
  });
  renderIncoming();
}

async function finalizePart(receive) {
  await receive.writer?.close();
  receive.writer = null;
  let finalName = receive.saveName;
  for (let number = 2; ; number++) {
    try {
      await receive.directory.getFileHandle(finalName);
    } catch {
      break;
    }
    const dot = receive.saveName.lastIndexOf('.');
    const base = dot > 0 ? receive.saveName.slice(0, dot) : receive.saveName;
    const extension = dot > 0 ? receive.saveName.slice(dot) : '';
    finalName = `${base} (${number})${extension}`;
  }
  const final = await receive.directory.getFileHandle(finalName, { create: true });
  if (typeof receive.partHandle?.move === 'function') {
    await receive.partHandle.move(finalName);
  } else {
    const file = await receive.partHandle.getFile();
    const output = await final.createWritable();
    await file.stream().pipeTo(output);
    await receive.directory.removeEntry(receive.partName);
  }
  receive.savedPath = finalName;
  receive.createdOutput = true;
}

async function finishReceive(receive) {
  if (receive.state === 'checking' || receive.state === 'verified') return;
  receive.state = 'checking';
  receive.message = 'checking SHA-256';
  renderIncoming();
  await receive.writeQueue;
  if (hex(receive.hasher.digest()) !== receive.sha256) {
    receive.state = 'failed';
    receive.chunks = [];
    await receive.writer?.close().catch(() => {});
    receive.writer = null;
    receive.message = receive.directory
      ? `The file arrived damaged. ${receive.partName} is not safe: delete this file.`
      : 'The file arrived damaged and was discarded.';
    send(receive.peerId, { type: 'verify', fileId: receive.id, ok: false });
    renderIncoming();
    void syncWakeLock();
    return;
  }
  if (receive.directory) await finalizePart(receive);
  else {
    receive.url = URL.createObjectURL(new Blob(receive.chunks, { type: receive.type }));
    receive.chunks = [];
  }
  receive.state = 'verified';
  receive.message = 'verified ✓';
  if (receive.url) {
    saveBlob(receive);
    receive.downloaded = true;
    receive.message = 'verified ✓ · download started';
  }
  send(receive.peerId, { type: 'verify', fileId: receive.id, ok: true });
  renderIncoming();
  void syncWakeLock();
}

function failReceive(receive, message) {
  if (!receive || ['failed', 'verified'].includes(receive.state)) return;
  receive.state = 'failed';
  receive.message = message;
  receive.chunks = [];
  receive.writer?.abort().catch(() => {});
  send(receive.peerId, { type: 'verify', fileId: receive.id, ok: false });
  renderIncoming();
  void syncWakeLock();
}

function saveBlob(receive) {
  const anchor = document.createElement('a');
  anchor.href = receive.url;
  anchor.download = receive.saveName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

async function updatePaths() {
  for (const peer of state.peers.values()) {
    const pc = getPeerConnection(peer.id);
    if (!pc || pc.connectionState !== 'connected') continue;
    try {
      const report = await pc.getStats();
      let relay = false;
      for (const entry of report.values()) {
        if (entry.type !== 'candidate-pair' || entry.state !== 'succeeded') continue;
        const local = report.get(entry.localCandidateId);
        const remote = report.get(entry.remoteCandidateId);
        relay ||= local?.candidateType === 'relay' || remote?.candidateType === 'relay';
      }
      peer.path = relay ? 'relay' : 'direct';
    } catch { peer.path = 'unknown path'; }
  }
  renderPeople();
}

function tick() {
  updatePaths();
  const now = Date.now();
  for (const receive of state.incoming.values()) {
    if (receive.state === 'receiving' && now - receive.lastByteAt >= STALL_MS) {
      failReceive(receive, `Stalled: no data from ${receive.senderName} for 15 s. ${connectionLabel(getPeerConnection(receive.peerId))}.`);
    }
  }
}

function runConsole(command) {
  const [name, argument] = command.trim().split(/\s+(.*)/);
  log(`> ${command}`, 'command');
  if (name === '/peers') {
    log([...state.peers.values()].map((peer) => `${peer.name} (${peer.id.slice(0, 8)}) ${peer.path || ''}`).join('\n') || 'No other peers.');
  } else if (name === '/path') {
    log([...state.peers.values()].map((peer) => `${peer.name}: ${peer.path || 'unknown path'}`).join('\n') || 'No peers.');
  } else if (name === '/diag') {
    log(JSON.stringify({
      app: { name: APP_ID, version: VERSION, protocol: PROTOCOL },
      self: state.selfId,
      peers: state.peers.size,
      connections: [...allPCs].map((pc) => ({ state: pc.connectionState, ice: pc.iceConnectionState })),
      incoming: state.incoming.size,
      outgoing: state.outgoing.size,
      memoryLimit: MEMORY_LIMIT,
      streaming: !!window.showDirectoryPicker,
    }, null, 2));
  } else if (name.startsWith('/relays')) {
    if (command === '/relays reset') {
      settings.relays = [];
      saveSettings();
      log('Restored the default relay set. Rejoin to apply it.');
      return;
    }
    log(activeRelays().join('\n'));
  } else if (name === '/egress') {
    log([
      'DECLARED HOSTS',
      location.host,
      ...activeRelays().map((url) => new URL(url).host),
      ...(!DEV.localIce ? ['stun.cloudflare.com:3478'] : []),
      '<room peers>',
      '',
      'OBSERVED WEBSOCKETS',
      ...observedSockets,
    ].join('\n'));
  } else if (name === '/hash') {
    const file = [...state.outgoing.values(), ...state.incoming.values()]
      .find((item) => item.name === argument || item.id === argument);
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
  $('#createRoom').addEventListener('click', () => {
    enterRoom(!state.secret).catch((cause) => error(`Could not enter the room: ${cause?.message || cause}`));
  });
  ui.displayName.addEventListener('change', saveSettings);
  ui.fileInput.addEventListener('change', () => prepareFiles(ui.fileInput.files));
  ui.dropZone.addEventListener('dragover', (event) => { event.preventDefault(); ui.dropZone.classList.add('drag'); });
  ui.dropZone.addEventListener('dragleave', () => ui.dropZone.classList.remove('drag'));
  ui.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    ui.dropZone.classList.remove('drag');
    prepareFiles(event.dataTransfer.files);
  });
  $('#copyLink').addEventListener('click', async () => {
    await navigator.clipboard.writeText(ui.inviteLink.value);
    $('#copyLink').textContent = 'Copied';
    setTimeout(() => { $('#copyLink').textContent = 'Copy link'; }, 1200);
  });
  $('#showQr').addEventListener('click', renderQr);
  $('#networkSettings').addEventListener('click', () => {
    $('#relayUrls').value = activeRelays().join('\n');
    $('#networkDialog').showModal();
  });
  $('#saveRelays').addEventListener('click', (event) => {
    try {
      settings.relays = parseRelayUrls($('#relayUrls').value);
      saveSettings();
      log(settings.relays.length ? `Saved ${settings.relays.length} custom relays. Rejoin to apply them.` : 'Restored the default relay set. Rejoin to apply it.');
    } catch (cause) {
      event.preventDefault();
      error(cause?.message || String(cause));
    }
  });
  $('#newRoom').addEventListener('click', () => $('#newRoomDialog').showModal());
  $('#confirmNewRoom').addEventListener('click', async () => {
    await cleanupRoom();
    location.replace(location.pathname + location.search);
  });
  $('#leaveRoom').addEventListener('click', () => $('#leaveRoomDialog').showModal());
  $('#confirmLeaveRoom').addEventListener('click', async () => {
    await cleanupRoom();
    history.replaceState(null, '', location.pathname + location.search);
    location.reload();
  });
  $('#consoleToggle').addEventListener('click', () => {
    const visible = !ui.consolePanel.classList.toggle('hidden');
    $('#consoleToggle').setAttribute('aria-pressed', String(visible));
    if (visible) ui.consoleIn.focus();
  });
  $('#consoleRun').addEventListener('click', () => { runConsole(ui.consoleIn.value); ui.consoleIn.value = ''; });
  ui.consoleIn.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { runConsole(ui.consoleIn.value); ui.consoleIn.value = ''; }
  });
}

async function cleanupRoom({ notify = true } = {}) {
  if (state.cancelled && !state.joined && !state.incoming.size && !state.outgoing.size) return;
  state.cancelled = true;
  if (notify && state.action && state.room) {
    try { await state.action.send({ type: 'cancel-all', reason: 'The participant left the room.' }); } catch {}
  }
  for (const receive of state.incoming.values()) {
    if (receive.url) {
      try { URL.revokeObjectURL(receive.url); } catch {}
    }
    receive.chunks = [];
    try { await receive.writer?.abort(); } catch {}
    if (receive.directory) {
      try { await receive.directory.removeEntry(receive.partName); } catch {}
      if (receive.createdOutput && receive.savedPath) {
        try { await receive.directory.removeEntry(receive.savedPath); } catch {}
      }
    }
  }
  for (const outgoing of state.outgoing.values()) {
    outgoing.source = null;
    outgoing.targets.clear();
  }
  state.jobs.length = 0;
  state.activeJobs.clear();
  state.incoming.clear();
  state.outgoing.clear();
  state.peers.clear();
  try { state.room?.leave(); } catch {}
  for (const pc of allPCs) {
    try { pc.close(); } catch {}
  }
  allPCs.clear();
  state.joined = false;
  state.room = null;
  state.action = null;
  state.selfId = null;
  if (screenWakeLock) {
    await screenWakeLock.release().catch(() => {});
    screenWakeLock = null;
  }
  settings.name = '';
  saveSettings();
}

addEventListener('beforeunload', (event) => {
  if (!state.joined || state.cancelled) return;
  event.preventDefault();
  event.returnValue = '';
});

addEventListener('visibilitychange', () => {
  void syncWakeLock();
});

addEventListener('pagehide', () => {
  void cleanupRoom({ notify: false });
});

window.drop = { state, allPCs, deriveRoom, executableWarning, sanitizeManifestNames, validateManifest, runConsole, loadVerified, diagnoseConnection };

initializeEvents();
if (state.secret) {
  showRoom(false);
  $('#startScreen .eyebrow').textContent = 'Room invitation';
  $('#startScreen h1').textContent = 'Join this room';
  $('#startScreen .lede').textContent = 'Choose a display name, then join. Everyone in the room can send and receive files.';
  $('#createRoom').textContent = 'Join room';
} else {
  showRoom(false);
  log(`drop-webCLI ${VERSION}; rooms are temporary and every received file requires acceptance.`);
}
