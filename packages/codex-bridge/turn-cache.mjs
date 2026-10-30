// Coalesce concurrent history reads; native events invalidate completed or pending reads.
export class TurnCache {
  constructor({ttl = 2000, now = Date.now} = {}) { this.ttl = ttl; this.now = now; this.entries = new Map(); }
  invalidate(threadId) { this.entries.delete(threadId); }
  get(threadId, load) {
    const old = this.entries.get(threadId);
    if (old && (old.pending || this.now() - old.at < this.ttl)) return old.promise;
    const entry = {pending: true, at: 0};
    entry.promise = Promise.resolve().then(load).then(rows => {
      entry.pending = false; entry.at = this.now(); return rows;
    }, error => { if (this.entries.get(threadId) === entry) this.entries.delete(threadId); throw error; });
    this.entries.set(threadId, entry);
    return entry.promise;
  }
}
