import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(root, 'docs', 'lib');
mkdirSync(lib, { recursive: true });

const packageVersion = (name) => JSON.parse(
  readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
).version;

const entries = [
  {
    file: 'trystero-nostr.js',
    package: '@trystero-p2p/nostr',
    contents: "export { joinRoom } from '@trystero-p2p/nostr';",
  },
  {
    file: 'qrcode.js',
    package: 'qrcode-generator',
    contents: "import qrcode from 'qrcode-generator'; export default qrcode;",
  },
  {
    file: 'sha256.js',
    package: '@noble/hashes',
    contents: "export { sha256 } from '@noble/hashes/sha2.js';",
  },
];

const pins = {};
for (const entry of entries) {
  const output = path.join(lib, entry.file);
  await build({
    stdin: { contents: entry.contents, resolveDir: root, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: false,
    legalComments: 'inline',
    outfile: output,
    logLevel: 'error',
  });
  pins[entry.file] = {
    version: packageVersion(entry.package),
    package: entry.package,
    sha256: createHash('sha256').update(readFileSync(output)).digest('hex'),
  };
}

writeFileSync(path.join(lib, 'PINS.json'), `${JSON.stringify(pins, null, 2)}\n`);
const htmlPath = path.join(root, 'docs', 'app.js');
const html = readFileSync(htmlPath, 'utf8');
const marker = /\/\*PINS\*\/[\s\S]*?\/\*END-PINS\*\//;
if (!marker.test(html)) throw new Error('PINS marker not found in docs/index.html');
writeFileSync(htmlPath, html.replace(marker, `/*PINS*/${JSON.stringify(pins)}/*END-PINS*/`));
for (const [file, pin] of Object.entries(pins)) {
  console.log(`${file} ${pin.package}@${pin.version} sha256:${pin.sha256}`);
}
