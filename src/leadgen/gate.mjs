// Leadgen write-gate. Product red line: v1 has zero automated write actions.
// Every action a collector or UI could trigger goes through here; anything
// that writes to a platform is refused with reason 'read-only'.
const WRITE_ACTIONS = new Set(['post', 'quote', 'reply', 'dm', 'like', 'follow', 'comment']);

export function checkAction(action) {
  if (WRITE_ACTIONS.has(action)) return { ok: false, reason: 'read-only' };
  return { ok: true };
}