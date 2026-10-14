// Adapter registry: collect.mjs and the on-demand profile reader resolve a
// platform module through getAdapter(). Unknown platforms resolve to null.
export const PLATFORMS = ['xhs', 'fb', 'threads'];

const FILES = { xhs: './xhs.mjs', fb: './fb.mjs', threads: './threads.mjs' };

export async function getAdapter(platform) {
  const file = FILES[platform];
  if (!file) return null;
  try { return await import(file); } catch { return null; }
}