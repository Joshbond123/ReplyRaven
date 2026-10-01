import chromium from '@sparticuz/chromium';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { brotliDecompressSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
export async function browserOptions() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)
    return { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] };
  // The npm-distributed browser allows reproducible tests without a second download.
  // Extract its small NSS dependencies for minimal Linux containers as well.
  let root = dirname(require.resolve('@sparticuz/chromium'));
  while (true) {
    try {
      await access(resolve(root, 'bin/al2023.tar.br'));
      break;
    } catch {
      const parent = dirname(root);
      if (parent === root) throw new Error('Could not find the npm Chromium package assets.');
      root = parent;
    }
  }
  const libs = resolve('.cache/chromium-libs');
  if (process.platform === 'linux') {
    try {
      await access(resolve(libs, 'lib/libnspr4.so'));
    } catch {
      await mkdir(libs, { recursive: true });
      const tar = resolve('.cache/al2023.tar');
      await writeFile(tar, brotliDecompressSync(await readFile(resolve(root, 'bin/al2023.tar.br'))));
      execFileSync('tar', ['-xf', tar, '-C', libs]);
    }
  }
  return {
    executablePath: await chromium.executablePath(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
    env: { ...process.env, LD_LIBRARY_PATH: `${resolve(libs, 'lib')}:${process.env.LD_LIBRARY_PATH || ''}` },
  };
}
