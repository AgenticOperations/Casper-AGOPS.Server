// Copy the hot-tier Lua scripts into the build output. `tsc` only emits .js, so the .lua
// source-of-truth files must be carried into dist/redis/lua/ for `node dist/...` to load them
// (see src/redis/lua/load.ts). Runs as a build poststep.
import { readdir, mkdir, copyFile } from 'node:fs/promises';

// tsc uses rootDir "." so sources emit under dist/src/...; keep the .lua files beside load.js
// (dist/src/redis/lua/) so its `new URL('./reserve.lua', import.meta.url)` resolves at runtime.
const srcDir = new URL('../src/redis/lua/', import.meta.url);
const outDir = new URL('../dist/src/redis/lua/', import.meta.url);

await mkdir(outDir, { recursive: true });
let copied = 0;
for (const file of await readdir(srcDir)) {
  if (!file.endsWith('.lua')) continue;
  await copyFile(new URL(file, srcDir), new URL(file, outDir));
  copied += 1;
}
console.log(`copied ${copied} lua script(s) to dist/src/redis/lua/`);
