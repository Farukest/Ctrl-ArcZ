/**
 * A `localStorage` for tests that run in node.
 *
 * The app's records live in local storage, so anything testing them needs one
 * before the module under test is imported -- which a stub inside a test file
 * cannot do, because imports hoist above it. A setup file runs first, so the
 * global is there by the time any module reads it.
 *
 * Cleared between tests by `resetStorage`, which is cheaper and less surprising
 * than re-importing the module graph for every case.
 */
const map = new Map<string, string>();

const shim: Storage = {
  get length() {
    return map.size;
  },
  key: (i: number) => [...map.keys()][i] ?? null,
  getItem: (k: string) => map.get(k) ?? null,
  setItem: (k: string, v: string) => void map.set(k, String(v)),
  removeItem: (k: string) => void map.delete(k),
  clear: () => map.clear(),
};

globalThis.localStorage = shim;

/** Start a test with nothing remembered. */
export function resetStorage(): void {
  map.clear();
}
