/**
 * Anonymous watcher identity. Stored once in localStorage.
 * On first call, generates a stable opaque UUID. Later, when the user
 * signs in, the back-end can merge this watcherId into user.id.
 */
const STORAGE_KEY = 'as_watcher_id';

function _genId(): string {
  // crypto-strong if available, fall back to Math.random.
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return `w_${c.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  return `w_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

export function getWatcherId(): string {
  if (typeof localStorage === 'undefined') return _genId();
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = _genId();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
