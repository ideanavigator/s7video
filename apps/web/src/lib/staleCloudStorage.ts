// T3 Code kept its T3 Connect proof key in this database and Clerk caches
// under `__clerk*` keys. Nothing reads them now; drop them so the key does not linger.
const CLOUD_AUTH_DATABASE = "t3code:cloud-auth";
const STALE_LOCAL_STORAGE_KEYS = ["t3code:connect-onboarding-opt-out:v1"];

export function clearStaleCloudStorage(): void {
  try {
    globalThis.indexedDB?.deleteDatabase(CLOUD_AUTH_DATABASE);
  } catch {}
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined) return;
    const stale = new Set(STALE_LOCAL_STORAGE_KEYS);
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key !== null && key.startsWith("__clerk")) stale.add(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {}
}
