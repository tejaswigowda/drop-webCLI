export const APP_ID = 'drop-webCLI';
export const PROTOCOL = 1;
export const TOPIC_LABEL = 'drop-webCLI/v1/topic';
export const SDP_LABEL = 'drop-webCLI/v1/sdp';
export const MAX_FILES = 500;
export const MAX_NAME_LENGTH = 200;
export const CHUNK_SIZE = 16 * 1024;
export const HIGH_WATER_MARK = 4 * 1024 * 1024;
export const LOW_WATER_MARK = 1024 * 1024;
export const STALL_MS = 15_000;
export const MAX_ACTIVE_RECEIVERS = 3;
export const INVITE_LIFETIME_MS = 60 * 60 * 1000;
export const RELAYS = [
  'wss://no.str.cr',
  'wss://relay.wavlake.com',
  'wss://nostr.hifish.org',
  'wss://relay.notoshi.win',
  'wss://relay.dwadziesciajeden.pl',
];
export const DEFAULT_STUN = 'stun:stun.cloudflare.com:3478';

const enc = new TextEncoder();
const WEB_UR_SAFE = /^[-A-Za-z0-9_]{22}$/;
const PROGRAM_EXTENSIONS = new Set([
  '.exe', '.dmg', '.pkg', '.app', '.msi', '.bat', '.cmd', '.sh', '.command',
  '.apk', '.js', '.jar', '.scr', '.ps1', '.vbs', '.lnk',
]);
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CONTROL_OR_FORMAT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu;

export const b64u = {
  encode(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  },
};

export function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function parseInvite(hash) {
  const match = /^#k=([-A-Za-z0-9_]{22})&e=([0-9]+)$/.exec(hash);
  if (!match || !WEB_UR_SAFE.test(match[1])) return null;
  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  try {
    const secret = b64u.decode(match[1]);
    return secret.length === 16 ? { secret, expiresAt } : null;
  } catch {
    return null;
  }
}

export function makeSecret() {
  return crypto.getRandomValues(new Uint8Array(16));
}

export function makeInviteSecret() {
  return { secret: makeSecret(), expiresAt: Date.now() + INVITE_LIFETIME_MS };
}

export function inviteHash(invite) {
  return `#k=${b64u.encode(invite.secret)}&e=${invite.expiresAt}`;
}

export function concat(first, second) {
  const output = new Uint8Array(first.length + second.length);
  output.set(first);
  output.set(second, first.length);
  return output;
}

export async function deriveRoom(secret, expiresAt) {
  const expiry = enc.encode(`:${expiresAt}`);
  const topic = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(enc.encode(TOPIC_LABEL), concat(secret, expiry))));
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const password = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: expiry, info: enc.encode(SDP_LABEL) },
    key,
    256,
  ));
  return { roomId: hex(topic), password: b64u.encode(password) };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = units[0];
  for (let i = 1; size >= 1024 && i < units.length; i++) {
    size /= 1024;
    unit = units[i];
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${unit}`;
}

export function sanitizeName(raw, used = new Set()) {
  const original = String(raw ?? '');
  const baseName = original.split(/[\\/]/).filter(Boolean).at(-1) || '';
  let stem = baseName
    .replace(CONTROL_OR_FORMAT, '')
    .replace(/^\.+/, '')
    .trim();
  if (!stem) stem = 'untitled';
  stem = [...stem].slice(0, MAX_NAME_LENGTH).join('');
  if (WINDOWS_DEVICE.test(stem)) stem = `_${stem}`;
  const lower = stem.toLowerCase();
  if (used.has(lower)) {
    const dot = stem.lastIndexOf('.');
    const base = dot > 0 ? stem.slice(0, dot) : stem;
    const extension = dot > 0 ? stem.slice(dot) : '';
    for (let number = 2; ; number++) {
      const suffix = ` (${number})`;
      const candidate = `${[...base].slice(0, MAX_NAME_LENGTH - suffix.length - extension.length).join('')}${suffix}${extension}`;
      if (!used.has(candidate.toLowerCase())) {
        stem = candidate;
        break;
      }
    }
  }
  used.add(stem.toLowerCase());
  return { name: stem, changed: stem !== original };
}

export function sanitizeManifestNames(files) {
  const used = new Set();
  return files.map((file) => {
    const safe = sanitizeName(file.name, used);
    return { ...file, originalName: file.name, saveName: safe.name, nameChanged: safe.changed };
  });
}

export function executableWarning(name) {
  const lower = String(name).toLowerCase();
  const parts = lower.split('.').filter(Boolean);
  const extension = lower.match(/\.[^.]+$/)?.[0] || '';
  const hasDangerousExtension = PROGRAM_EXTENSIONS.has(extension);
  const doubleExtension = parts.length > 2
    && PROGRAM_EXTENSIONS.has(`.${parts.at(-1)}`)
    && parts.at(-2).length <= 8;
  return hasDangerousExtension || doubleExtension;
}

export function validateManifest(message) {
  if (!message || message.protocol !== PROTOCOL || !Array.isArray(message.files)) {
    return 'The sender used an unsupported transfer protocol.';
  }
  if (message.files.length > MAX_FILES) {
    return `This manifest contains more than ${MAX_FILES} files.`;
  }
  const ids = new Set();
  let total = 0;
  for (const file of message.files) {
    if (!file || typeof file.id !== 'string' || !file.id || ids.has(file.id)) return 'The manifest contains an invalid or duplicate file id.';
    ids.add(file.id);
    if (typeof file.name !== 'string' || file.name.length > MAX_NAME_LENGTH) return 'The manifest contains a file name over 200 characters.';
    if (!Number.isSafeInteger(file.size) || file.size < 0) return 'The manifest contains an invalid file size.';
    if (!/^[0-9a-f]{64}$/.test(file.sha256 || '')) return 'The manifest contains an invalid SHA-256.';
    total += file.size;
  }
  if (message.total !== total) return 'The manifest total does not match its files.';
  return null;
}

export async function hashFile(file, sha256, onProgress = () => {}) {
  const hasher = sha256.create();
  let read = 0;
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
    read += value.byteLength;
    onProgress(read, file.size);
  }
  return hex(hasher.digest());
}

export function waitForChannelDrain(channel) {
  if (channel.bufferedAmount <= HIGH_WATER_MARK) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('The connection stalled while waiting for the peer to receive data.'));
    }, STALL_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      channel.removeEventListener('bufferedamountlow', low);
      channel.removeEventListener('close', closed);
      channel.removeEventListener('error', closed);
    };
    const low = () => {
      if (channel.bufferedAmount <= LOW_WATER_MARK) {
        cleanup();
        resolve();
      }
    };
    const closed = () => {
      cleanup();
      reject(new Error('The transfer connection closed while data was buffered.'));
    };
    channel.addEventListener('bufferedamountlow', low);
    channel.addEventListener('close', closed);
    channel.addEventListener('error', closed);
    if (channel.bufferedAmount <= LOW_WATER_MARK) low();
  });
}
