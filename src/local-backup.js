const CLIENT_KEY = 'steam_library_backup_client_v1';

export function createLocalBackup({ storage = globalThis.localStorage, fetcher = globalThis.fetch,
  onStatus = () => {}, retryMs = 30000 } = {}) {
  let pending = null;
  let running = false;
  let timer;
  let lastSaved = '';
  let disposed = false;

  function schedule(delay) {
    clearTimeout(timer);
    if (!disposed) timer = setTimeout(flush, delay);
  }

  async function flush() {
    clearTimeout(timer);
    if (running || !pending || disposed) return;
    running = true;
    const snapshot = pending;
    let failed = false;
    try {
      let clientId = storage.getItem(CLIENT_KEY);
      if (!/^[a-f0-9-]{36}$/.test(clientId ?? '')) {
        clientId = crypto.randomUUID();
        storage.setItem(CLIENT_KEY, clientId);
      }
      onStatus('saving');
      const response = await fetcher('/api/library/backups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, games: JSON.parse(snapshot) }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      lastSaved = snapshot;
      if (pending === snapshot) pending = null;
      onStatus('saved', result);
    } catch {
      failed = true;
      onStatus('error');
    } finally {
      running = false;
      if (pending) schedule(failed ? retryMs : 0);
    }
  }

  return {
    save(games) {
      const snapshot = JSON.stringify(games);
      if (snapshot === lastSaved && !running) { pending = null; return; }
      pending = snapshot;
      onStatus('pending');
      schedule(400);
    },
    flush,
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
