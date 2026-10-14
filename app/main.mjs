// SocialMate desktop shell.
// One process: the local control server and the window live together, so the
// UI can never drift from the brain it is driving.
import { app, BrowserWindow, shell, Menu, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Packaged layout:
//   app.asar/app/main.mjs   <- in the asar (read-only archive)
//   app.asar/config.json    <- read-only default template
//   app.asar/src/...        <- read-only code
// The userData directory is the only writable area in a packaged build; all
// runtime files (config.json, state, queue, shots, ...) must land there.
const HERE = dirname(fileURLToPath(import.meta.url));
const ASAR_ROOT = resolve(HERE, '..');

// Find the project folder that owns the data (edge-profile + secrets/provider).
// A packaged exe lives in <repo>\dist (portable) or <repo>\dist\win-unpacked,
// so walking up a couple of parents finds the repo that already holds the
// logged-in Edge profile and the keys. Returns null when there is no such
// folder, in which case the app falls back to %APPDATA%\socialmate.
function findRepoRoot() {
  const bases = [
    process.env.PORTABLE_EXECUTABLE_DIR,
    process.execPath ? dirname(process.execPath) : null,
    ASAR_ROOT,
  ];
  for (const base of bases) {
    if (!base) continue;
    let dir = resolve(base);
    for (let i = 0; i < 3; i++) {
      const hasProfile = existsSync(resolve(dir, 'edge-profile'));
      const hasKeys = existsSync(resolve(dir, 'secrets.json')) || existsSync(resolve(dir, 'provider.json'));
      if (hasProfile && hasKeys) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

if (app.isPackaged) {
  // A launcher (SocialMate.bat / a desktop shortcut) may pin the data root to
  // the repo so the packaged build reuses the SAME edge-profile, secrets.json,
  // provider.json and queue the dev build already uses. Without that override
  // the packaged app falls back to %APPDATA%\socialmate, which is empty on a
  // fresh machine — the classic "packaged build has no X login state" trap.
  // Precedence: an explicit env override (SocialMate.bat / installer) wins,
  // then an explicit --user-data-dir switch (isolated test harnesses), and
  // only then the repo auto-detect. Never let auto-detect shadow a switch the
  // caller passed on purpose.
  const overrideDir = process.env.SOCIALMATE_DATA_DIR;
  const hasUserDataSwitch = process.argv.some((a) => typeof a === 'string' && a.startsWith('--user-data-dir'));
  const autoRoot = hasUserDataSwitch ? null : findRepoRoot();
  const dataDir = resolve(overrideDir || autoRoot || app.getPath('userData'));
  mkdirSync(dataDir, { recursive: true });
  // Runtime data root for every child process (daemon re-spawns itself in
  // node mode, so it inherits this through env, never through asar).
  process.env.SOCIALMATE_DATA_DIR = dataDir;
  // Code root still lives inside the asar; the server needs it to locate the
  // renderer and the daemon entry without depending on process.cwd().
  process.env.SOCIALMATE_CODE_ROOT = ASAR_ROOT;
  process.env.SOCIALMATE_RENDERER = resolve(ASAR_ROOT, 'app', 'renderer');
  // First launch: seed a writable config from the read-only packaged default
  // so the control API never 500s on a missing config.json.
  const userConfig = resolve(dataDir, 'config.json');
  if (!existsSync(userConfig)) {
    // Seed from the committed DEFAULT TEMPLATE (config.example.json), not from
    // any developer's personal config.json: a fresh install must start in the
    // safe "review" mode with features off, never inherit auto-publish. Fall
    // back to config.json only for older builds that predate the template.
    // copyFileSync cannot read from inside app.asar (it is an archive, not a
    // real file path); read+write works for both app.asar and win-unpacked.
    const seed = existsSync(resolve(ASAR_ROOT, 'config.example.json'))
      ? resolve(ASAR_ROOT, 'config.example.json')
      : resolve(ASAR_ROOT, 'config.json');
    try { writeFileSync(userConfig, readFileSync(seed)); } catch {}
  }
  // The whole app runs with the writable data root as its working directory.
  // That is what keeps every relative resolve() (queue/**, cache/**, shots/**,
  // provider.json, run.pid, ...) inside userData without touching dozens of
  // modules. Node resolves module files via import specifiers (as-relative),
  // not process.cwd(), so the asar code keeps loading correctly.
  process.chdir(dataDir);
} else {
  // Dev mode: run from the repo root, exactly like before.
  if (existsSync(resolve(HERE, '..'))) process.chdir(resolve(HERE, '..'));
}

const PORT = Number(process.env.PORT || 4173);
const URL = `http://127.0.0.1:${PORT}/`;
let win = null;
let server = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(boot);
}

async function boot() {
  Menu.setApplicationMenu(null);
  try {
    // Loaded dynamically, AFTER the packaged layout above has set
    // SOCIALMATE_DATA_DIR / cwd: a static import would evaluate
    // server.mjs top-level path resolution before this module's body runs.
    const { startServer } = await import('../src/server.mjs');
    server = await startServer({ port: PORT });
  } catch (e) {
    dialog.showErrorBox('SocialMate', `本地控制服务启动失败：${e.message}`);
    app.quit();
    return;
  }
  createWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    title: 'SocialMate',
    icon: resolve(HERE, 'renderer', 'icon.png'),
    webPreferences: {
      preload: resolve(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed preloads may still use require('electron') for
      // contextBridge, so the renderer gets the strongest boundary available.
      sandbox: true,
    },
  });
  win.loadURL(URL);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { try { server?.close(); } catch {} });
