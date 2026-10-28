import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { findPublishedCredentials } from './credential-safety.mjs';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Explicit public configuration keeps private/local demo settings out of releases.
export async function buildVisitor() {
  const env = {
    ...process.env,
    VITE_AUTH_MODE: 'off', VITE_PRIVY_APP_ID: '', VITE_GLOWPET_ADDRESS: '',
    VITE_GLOWPET_SERIES_ID: '1', VITE_DEPLOY_BLOCK: '0', VITE_PROOF_BASE_URL: '',
    VITE_API_BASE_URL: '/api/v1',
    VITE_SEPOLIA_RPC_URL: 'https://ethereum-sepolia-rpc.publicnode.com',
  };
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: PROJECT_ROOT, env, stdio: 'inherit', windowsHide: true,
    });
    child.once('error', reject); child.once('close', resolve);
  });
  if (code !== 0) throw new Error(`Visitor build failed (${code}).`);
  const directory = path.join(PROJECT_ROOT, 'dist');
  if (findPublishedCredentials(directory).length) throw new Error('Release contains claim credentials.');
  await fs.access(path.join(directory, 'index.html'));
  console.log('Visitor build checked: homepage and browser-local garden; account and NFT activation are unconfigured.');
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildVisitor();
