# drop-webCLI

Create a room, send its link, and exchange files with the people who join. Everyone can send and receive, and each received file requires its own explicit Accept. The sender and receiver both compute SHA-256 incrementally, compare the result, and show the first eight characters for an out-of-band check.

This is not storage, a cloud locker, a mailbox, or “AirDrop for the internet.” Both browsers must be open at the same time. There is no nearby discovery, and nothing remains on a service when the sender closes the tab.

## Status

`v0.2.0` is the room and bidirectional-transfer release. The automated suite covers:

- a 128-bit invite secret that appears only in the URL fragment;
- different `drop-webCLI` topic/password derivation labels;
- room invitation and membership;
- bidirectional transfer between people in the same room;
- explicit per-file receiver acceptance;
- preparation-time and receive-time incremental SHA-256;
- dedicated ordered, reliable 16 KiB data channels with 4 MiB / 1 MiB backpressure watermarks;
- byte-accurate progress, filename sanitization, executable warnings, and manifest limits;
- relay-frame checks for the invite secret and plaintext SDP;
- a two-browser, real WebRTC transfer through a mock Nostr relay.

Browser-size ceilings, sustained throughput, and the real-device matrix have not been measured yet. Pending rows are deliberately marked below rather than presented as capabilities.

## Run locally

```sh
npm install
npm start
```

Open `http://localhost:8080/`, enter a display name, create a room, copy the room link, and open it in another browser profile or device that can reach the page. The invited person chooses a name and joins the same room. Anyone can select **Everyone** or a specific person, then send files. The static server only receives page requests; it does not receive file bytes or the fragment secret.

Run the checks:

```sh
npm test
```

Vendored dependencies are regenerated and hash-pinned with:

```sh
npm run vendor
```

The page refuses to execute a vendored module whose bytes do not match the SHA-256 embedded in the app. It makes no script or asset request to a CDN.

## How it works

1. The page creates a 128-bit secret in `#k=…`. Browsers do not include URL fragments in HTTP requests.
2. HKDF and a SHA-256 topic derivation isolate drop links from rtc-webCLI rooms.
3. Trystero over public Nostr relays exchanges encrypted WebRTC setup information. Cloudflare STUN can reveal candidate addresses needed for a direct connection.
4. Each outgoing file becomes an independent offer containing its id, original name, size, type, and SHA-256. No file data is sent before the receiver accepts that specific file.
5. Each accepted file gets a dedicated `RTCDataChannel`. The sender pauses at 4 MiB buffered and resumes at 1 MiB.
6. Both sides hash while streaming. A received file is not complete, downloadable, or moved from `.part` until the hashes match.
7. Browsers with `showDirectoryPicker` stream to disk. Other browsers assemble verified files in memory and enforce the configured browser ceiling.

Each sender sends once for every recipient they selected. At most three transfers run at once per browser; additional transfers queue.

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

No server of ours receives an upload. Relay frames contain encrypted setup data, not the URL secret or plaintext SDP. Relays and STUN still see network metadata such as IP addresses. The disclosure is shown before the first transfer and is keyed to its wording.

Allowed claims:

- Files go directly from one browser to another, encrypted, never through a server of ours, unless a TURN server is added.
- Each file is checked against the sender's SHA-256 before it is called done.

Not claims: “safe files,” “works on any network,” “secure from the sender,” “unlimited file size,” or “AirDrop for the internet.” A matching hash proves integrity, not that a file is safe to open. A modified page or sender can send harmful content.

## Receiving safely

- Every person's display name is self-asserted and unverified.
- Nothing transfers before **Accept**.
- Nothing opens or previews automatically.
- File names lose path components, controls and leading dots; reserved Windows device names are prefixed; collisions are deduplicated.
- `.exe`, `.dmg`, `.pkg`, `.app`, `.msi`, `.bat`, `.cmd`, `.sh`, `.command`, `.apk`, `.js`, `.jar`, `.scr`, `.ps1`, `.vbs`, `.lnk`, and suspicious double extensions receive a program warning.
- A manifest is refused above 500 files or with a name over 200 characters.
- An integrity mismatch discards an in-memory result and never offers Save. Streaming receivers keep a visibly damaged `.part` rather than renaming it.
- The app intentionally does not resume. A drop and reconnect restarts the affected file from zero.

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

Opening the page by the computer's reachable LAN IP can make it reachable to another device; opening only by `localhost` cannot. If a transfer fails on restricted Wi-Fi, try a phone on cellular or a network that permits peer traffic. This version has no TURN relay, so it cannot promise connectivity across every NAT and firewall. Adding TURN would also change the egress and transfer claim and must be disclosed.

The hidden console offers `/peers`, `/path`, `/diag`, `/relays`, `/egress`, `/hash <file>`, and `/about`.

## Prior art

- [FilePizza](https://file.pizza/) — peer-to-peer file transfer by link.
- Snapdrop / [PairDrop](https://pairdrop.net/) — local-network-friendly browser transfer.

drop-webCLI differs by making the egress, per-file consent boundary, named failures, dependency hashes, measured limits, and sender/receiver SHA-256 visible before making capability claims.

## Not built in v1

Resume after interruption; folders; text/clipboard transfer; mailbox or sender-offline mode; nearby discovery; or a shared package across webCLI repositories. A transfer over 1 GB that fails mid-way is the trigger to reconsider resume. Sender-offline mode would require storage and therefore is never part of this tool.
