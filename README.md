# drop-webCLI

Create a temporary two-person room, send its link, and exchange files with the person who joins. Both people can send and receive, and each received file requires its own explicit Accept. The sender and receiver both compute SHA-256 incrementally, compare the result, and show the first eight characters for an out-of-band check.

This is not storage, a cloud locker, a mailbox, or “AirDrop for the internet.” Both browsers must be open at the same time. There is no nearby discovery.

**It does not break the static-page boundary. It trades storage for synchrony.** drop-webCLI keeps both parties present instead of storing a payload. box-webCLI is deliberately the opposite architecture: stored content and token-based access.

**Live app:** https://drop.webcli.app/
**Status:** v0.2.7; functional for current desktop testing, with browser-size ceilings, throughput, and the wider device matrix still explicitly pending below.

## Status

`v0.2.7` enforces the two-person, 60-minute room-link policy, adds folder-backed resume, keeps supported displays awake during incoming transfers, and automatically downloads verified in-memory files. The automated suite covers:

- a 128-bit invite secret that appears only in the URL fragment;
- different `drop-webCLI` topic/password derivation labels;
- room invitation and membership;
- two-person room policy and refusal of a third participant;
- a room-topic key bound to the invite's expiry;
- bidirectional transfer between people in the same room;
- explicit per-file receiver acceptance;
- a visible pending-accept alert and browser-tab count for incoming files;
- preparation-time and receive-time incremental SHA-256;
- dedicated ordered, reliable 16 KiB data channels with 4 MiB / 1 MiB backpressure watermarks;
- byte-accurate progress, filename sanitization, executable warnings, and manifest limits;
- relay-frame checks for the invite secret and plaintext SDP;
- a two-browser, real WebRTC transfer through a mock Nostr relay;
- the same transfer flow in Chromium and Firefox.
- a 105 MiB deterministic folder-backed transfer interrupted mid-way, resumed from its offset, and verified by output SHA-256 (`npm run test:resume`).

The UI uses the shared webCLI visual language: near-black canvas, compact dark panels, muted borders, indigo/lavender accents, a fixed application header, and responsive two-column transfer status. The room workflow remains intentionally simple: create or join, invite, send, accept, verify, save.

Browser-size ceilings, sustained throughput, and the real-device matrix have not been measured yet. Pending rows are deliberately marked below rather than presented as capabilities.

## Run locally

```sh
npm install
npm start
```

Open the live app or `http://localhost:8080/`, enter a display name, and select **Create room**. Copy the room link and open it in another browser profile or device. The link is valid for 60 minutes. The invited person chooses a name and selects **Join room**. A room accepts at most two participants total; a third receives `ROOM_FULL`.

On the receiving side, every offered file remains independent: review its sender, name, size, executable warning, and stable per-session identifier, then choose **Accept**, **Accept to folder**, or **Decline**. The static server receives only page requests; it does not receive the fragment secret or file bytes.

Verified in-memory files begin downloading automatically; there is no second Save action. Folder-picked files are finalized directly in the selected folder after verification. Browsers may prompt once for permission to allow multiple automatic downloads.

After a file is accepted, the page requests the Screen Wake Lock API where available so the display remains awake while incoming data is waiting, receiving, checking, or resumable. The lock is released when no accepted incoming transfer remains active, when the tab is hidden, or when the room is left. Unsupported browsers continue normally.

Incoming offers also produce an in-page alert showing how many files await acceptance and a matching count in the browser tab title. If the tab is hidden and the user has already granted browser notification permission, a native notification is shown as an additional reminder. drop-webCLI never requests notification permission automatically.

Run the checks:

```sh
npm test
npm run test:resume
```

Vendored dependencies are regenerated and hash-pinned with:

```sh
npm run vendor
```

The page refuses to execute a vendored module whose bytes do not match the SHA-256 embedded in the app. It makes no script or asset request to a CDN.

The relay set copied from rtc-webCLI (`c47a420`) on 2026-11-23 is:

```text
wss://no.str.cr
wss://relay.wavlake.com
wss://nostr.hifish.org
wss://relay.notoshi.win
wss://relay.dwadziesciajeden.pl
```

Supply custom relays from the header **Network settings** dialog, one `wss://` URL per line. Use **Cancel** to discard edits, or save and rejoin to apply them. Only `wss://` is accepted; `ws://` is allowed for localhost development. At join time every relay is probed for an open WebSocket. If none responds within eight seconds, the app reports `RELAY_UNREACHABLE` rather than remaining in “connecting” indefinitely.

## Leaving and tab closure

Closing an active room is destructive by design:

- **Leave room** and the header **+** action require confirmation.
- Closing, reloading, or navigating away from an active room triggers the browser's native tab-close confirmation.
- The app cancels all transfers, closes peer connections, revokes in-memory download URLs, clears file references, and removes the saved display name.
- Files streamed into a folder chosen by the user are written with app-owned, collision-safe names and are deleted when leaving, alongside any `.part` file.
- An automatic download is an independent file placed outside the page's control. That downloaded copy cannot be deleted by JavaScript; the user must remove it from their device if required.
- No room or file payload is written to a server of ours. Public signaling relays carry and may retain connection metadata as described below. Browser-native download files and files the operating system has independently copied are outside page storage.

Browsers do not permit a custom message in the close-tab warning, and JavaScript cannot guarantee asynchronous filesystem operations finish during a forced process termination or browser crash. Normal in-page exits await app-created file cleanup before navigating home.

## How it works

1. The page creates a 128-bit secret and a one-hour expiry in `#k=…&e=…`. Browsers do not include URL fragments in HTTP requests.
2. HKDF and a SHA-256 topic derivation bind both the secret and expiry into the room, so editing the timestamp does not join the original room. Different labels isolate drop links from rtc-webCLI rooms.
3. Trystero over public Nostr relays exchanges encrypted WebRTC setup information. Cloudflare STUN can reveal candidate addresses needed for a direct connection.
4. Each outgoing file becomes an independent offer containing its id, original name, size, type, and SHA-256. No file data is sent before the receiver accepts that specific file.
5. Each accepted file gets a dedicated `RTCDataChannel`. The sender pauses at 4 MiB buffered and resumes at 1 MiB.
6. Both sides hash while streaming. A received file is not complete, downloadable, or moved from `.part` until the hashes match.
7. Browsers with `showDirectoryPicker` stream to disk. Other browsers assemble verified files in memory and enforce the configured browser ceiling.

Only folder-backed transfers resume. A receiver retains the highest contiguous byte offset, closes the current file channel after an interruption, and sends that offset to the sender. The sender seeks to that offset and opens a fresh channel. The final whole-file SHA-256 still proves the combined transfer. In-memory receives lose their buffer and do not resume.

The room policy is two participants total. A file sender sees the other participant's display name, stable session identifier, count, and path before sending. The link is a capability: **the room link is a key**. Forwarding it before expiry forwards the ability to attempt to join, and display names are unverified.

## Privacy and egress

| Destination | Purpose |
|---|---|
| Page origin | HTML, CSS, JavaScript, and pinned vendored libraries |
| `wss://no.str.cr` | WebRTC rendezvous |
| `wss://relay.wavlake.com` | WebRTC rendezvous |
| `wss://nostr.hifish.org` | WebRTC rendezvous |
| `wss://relay.notoshi.win` | WebRTC rendezvous |
| `wss://relay.dwadziesciajeden.pl` | WebRTC rendezvous |
| `stun:stun.cloudflare.com:3478` | Discover a network path for direct WebRTC |
| Accepted peers | Encrypted file bytes and transfer control |

We run no server that holds files or room data. Signaling travels over public Nostr relays, which by design store and rebroadcast the events they carry. Those events include connection metadata — public IP addresses and, where mDNS obfuscation does not apply, local-network addresses — and relay operators may retain it. The room topic is derived so relays cannot read the link key, and file contents never pass through them. STUN sees network metadata needed to discover a path.

Allowed claims:

- Transfers are encrypted end-to-end by WebRTC's DTLS, including through a TURN relay — a relay forwards ciphertext it cannot read. Without TURN the connection is also direct: no third party is in the transfer path. With TURN, the operator can see timing and volume, not contents.
- Each file is checked against the sender's SHA-256 before it is called done.

Not claims: “safe files,” “works on any network,” “secure from the sender,” “unlimited file size,” or “AirDrop for the internet.” A matching hash proves integrity, not that a file is safe to open. A modified page or sender can send harmful content.

## Receiving safely

- Every person's display name is self-asserted and unverified.
- Nothing transfers before **Accept**.
- Nothing opens or previews automatically.
- File names lose path components, controls and leading dots; reserved Windows device names are prefixed; collisions are deduplicated.
- `.exe`, `.dmg`, `.pkg`, `.app`, `.msi`, `.bat`, `.cmd`, `.sh`, `.command`, `.apk`, `.js`, `.jar`, `.scr`, `.ps1`, `.vbs`, `.lnk`, and suspicious double extensions receive a program warning.
- A file offer is refused with a name over 200 characters; up to 500 files may be selected in one operation.
- An integrity mismatch discards an in-memory result and never downloads it. Streaming receivers keep a visibly damaged `.part` rather than renaming it.
- Folder-backed receives resume from the highest contiguous byte; in-memory receives cannot resume after reload because the page loses their buffer.

## Size, throughput, and device status

Current in-memory ceiling: **256 MiB, conservative and not yet a measured crash ceiling**. It is enforced before acceptance when folder streaming is unavailable. Chromium desktop with `showDirectoryPicker` is limited by disk capacity rather than the JavaScript heap in the implementation.

| Measurement | Status |
|---|---|
| Chrome desktop in-memory crash-free file ceiling | pending, three tries |
| Firefox macOS crash-free file ceiling | pending, three tries |
| Safari macOS crash-free file ceiling | pending, three tries |
| iOS Safari crash-free file ceiling | pending, three tries |
| Android Chrome crash-free file ceiling | pending, three tries |
| 500 MB same-LAN direct throughput | pending |
| 500 MB internet/cellular direct throughput | pending |

| Sender × receiver, 100 MB | Status |
|---|---|
| Chrome × Chrome, Firefox, Safari on macOS | pending |
| Firefox × Chrome, Firefox, Safari on macOS | pending |
| Safari × Chrome, Firefox, Safari on macOS | pending |
| iOS Safari × supported desktop browsers | pending |
| Android Chrome × supported desktop/mobile browsers | pending |

Failing pairs will remain listed, not hidden.

## Known networking limitation

Some networks keep devices apart, even when they are both on Wi-Fi. Browsers may hide a local address behind an mDNS `.local` name, and routers commonly block client-to-client traffic or do not loop public addresses back inside the network. If both devices expose private addresses but cannot establish a path, guest Wi-Fi/client isolation or a firewall is the first thing to check.

Opening the page by the computer's reachable LAN IP can make it reachable to another device; opening only by `localhost` cannot. If a transfer fails on restricted Wi-Fi, try a phone on cellular or a network that permits peer traffic. This version has no TURN relay, so it cannot promise connectivity across every NAT and firewall. TURN would change directness and add relay metadata exposure, but not end-to-end DTLS confidentiality.

The hidden console offers `/peers`, `/path`, `/diag`, `/relays`, `/egress`, `/hash <file>`, and `/about`.

If a peer cannot connect, the page reports one of these named causes using candidate types and address classes only: `NO_CANDIDATES`, `HIDDEN_LOCAL_ADDRESS`, `NETWORK_ISOLATION`, or `NO_DIRECT_PATH`. It intentionally does not display a peer's IP address. The recommended recovery is to try another network, cellular, or a browser/network configuration that permits direct WebRTC. Relay setup failures are reported separately as `RELAY_UNREACHABLE`.

## Prior art

- [FilePizza](https://file.pizza/) — peer-to-peer file transfer by link.
- Snapdrop / [PairDrop](https://pairdrop.net/) — local-network-friendly browser transfer.

drop-webCLI differs by making the egress, per-file consent boundary, named failures, dependency hashes, measured limits, and sender/receiver SHA-256 visible before making capability claims.

## Licence and vendored code

The project is GPL-3.0-only; see [LICENSE](LICENSE). Vendored browser dependencies retain MIT terms and copyright notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): Trystero, `@noble/hashes`, `@noble/secp256k1`, and `qrcode-generator`.

## Not built in v1

In-memory resume after reload; folders; text/clipboard transfer; mailbox or sender-offline mode; nearby discovery; or a shared package across webCLI repositories. Sender-offline mode would require storage and therefore is never part of this tool.
