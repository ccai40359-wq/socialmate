// Minimal, deliberately narrow bridge. The renderer talks to the local HTTP
// API for everything; this only exposes what the browser cannot know.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('socialmate', {
  version: process.versions.electron,
  platform: process.platform,
});
