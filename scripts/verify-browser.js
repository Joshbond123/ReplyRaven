import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const children = [];
const privatePassword = crypto.randomUUID() + crypto.randomUUID();
const frontendPort = process.env.VERIFICATION_FRONTEND_PORT || '3001',
  apiPort = process.env.VERIFICATION_API_PORT || '8788';
async function server(file, env, ready) {
  const child = spawn(process.execPath, [resolve(file)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('A verification service did not become ready.')), 30000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(ready)) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.stderr.on('data', () => {});
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`A verification service exited with status ${code}.`));
    });
  });
}
try {
  await server(
    'scripts/local-api.js',
    {
      API_PORT: apiPort,
      LOCAL_STATE_DIR: '.cache/browser-verification',
      LOCAL_OWNER_PASSWORD: privatePassword,
    },
    'ReplyRaven API is available',
  );
  await server(
    'scripts/serve.js',
    { PORT: frontendPort, DEV_API_URL: `http://127.0.0.1:${apiPort}` },
    'ReplyRaven website is available',
  );
  const child = spawn(process.execPath, [resolve('checks/browser.js')], {
    env: {
      ...process.env,
      VERIFICATION_SITE_URL: `http://127.0.0.1:${frontendPort}/`,
      LOCAL_OWNER_PASSWORD: privatePassword,
    },
    stdio: 'inherit',
  });
  const code = await new Promise((resolveCode) => child.once('exit', resolveCode));
  if (code) process.exitCode = code;
} finally {
  for (const child of children) child.kill('SIGTERM');
}
