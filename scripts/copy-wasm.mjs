// Copy the delegation session-contract WASM binaries into the build output. `tsc` only emits .js,
// so the .wasm source-of-truth files (served unsigned by the grant-init endpoint) must be carried
// into dist/ beside grant-wasm.js so its `new URL('./wasm/', import.meta.url)` resolves at runtime.
// Runs as a build poststep.
import { readdir, mkdir, copyFile } from 'node:fs/promises';

// tsc uses rootDir "." so sources emit under dist/src/...; keep the .wasm files beside grant-wasm.js
// (dist/src/engines/identity/delegation/wasm/).
const srcDir = new URL('../src/engines/identity/delegation/wasm/', import.meta.url);
const outDir = new URL('../dist/src/engines/identity/delegation/wasm/', import.meta.url);

await mkdir(outDir, { recursive: true });
let copied = 0;
for (const file of await readdir(srcDir)) {
  if (!file.endsWith('.wasm')) continue;
  await copyFile(new URL(file, srcDir), new URL(file, outDir));
  copied += 1;
}
console.log(`copied ${copied} wasm binary(ies) to dist/src/engines/identity/delegation/wasm/`);
