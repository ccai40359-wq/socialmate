// Copy your Edge "Default" profile (cookies, localStorage, etc.) into a
// working copy so the bot can run its own isolated Edge instance.
// MUST run while Edge is fully closed.
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const LOCAL = process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local');
const EDGE_ROOT = resolve(LOCAL, 'Microsoft', 'Edge', 'User Data');
const dest = resolve(process.cwd(), 'edge-profile');

function joinPath(...p) { return p.join('\\'); }

async function main() {
  const chosen = process.argv[2] || 'Default';
  const src = joinPath(EDGE_ROOT, chosen);
  const dst = joinPath(dest, chosen);
  if (!existsSync(src)) {
    console.error(`Edge profile not found: ${src}`);
    process.exit(1);
  }
  if (existsSync(dst)) {
    console.error(`Destination already exists: ${dst}`);
    console.error('Delete it first (e.g. Remove-Item -Recurse edge-profile) or choose another name.');
    process.exit(1);
  }
  await mkdir(dest, { recursive: true });
  console.log(`Copying ${src} -> ${dst}`);
  await cp(src, dst, { recursive: true, force: false });
  const localState = joinPath(EDGE_ROOT, 'Local State');
  if (existsSync(localState)) {
    await cp(localState, joinPath(dest, 'Local State'));
    console.log('Copied Local State (needed to unlock cookies).');
  }
  console.log('\nDone. Edge profile copied for isolated bot instance.');
}

main().catch(e => { console.error(e); process.exit(1); });
