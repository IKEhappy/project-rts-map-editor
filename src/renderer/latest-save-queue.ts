/** Saves are ordered; only the newest waiting snapshot of each document is
 * retained. Never cancel an atomic write already in progress. A rejection
 * stops that document's waiting saves so conflicts cannot be silently retried. */
export class LatestSaveQueue<T> {
  private entries = new Map<string, { snapshot: T; pending: boolean; waiters: Array<(ok: boolean) => void> }>();
  private running = false;
  private write: (key: string, snapshot: T) => Promise<boolean>;
  private onBusy: (busy: boolean) => void;

  constructor(
    write: (key: string, snapshot: T) => Promise<boolean>,
    onBusy: (busy: boolean) => void = () => {},
  ) { this.write = write; this.onBusy = onBusy; }

  isBusy(): boolean { return this.running; }

  request(key: string, snapshot: T): Promise<boolean> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { snapshot, pending: true, waiters: [] };
      this.entries.set(key, entry);
    } else {
      // Repeated Ctrl+S on the same immutable snapshot joins the active write.
      entry.pending = entry.pending || entry.snapshot !== snapshot;
      entry.snapshot = snapshot;
    }
    const result = new Promise<boolean>((resolve) => entry!.waiters.push(resolve));
    if (!this.running) void this.drain();
    return result;
  }

  private async drain(): Promise<void> {
    this.running = true;
    this.onBusy(true);
    try {
      while (this.entries.size) {
        const [key, entry] = this.entries.entries().next().value!;
        entry.pending = false;
        let ok = false;
        try { ok = await this.write(key, entry.snapshot); }
        catch { ok = false; }
        if (!ok || !entry.pending) {
          this.entries.delete(key);
          for (const resolve of entry.waiters) resolve(ok);
        }
      }
    } finally {
      this.running = false;
      this.onBusy(false);
    }
  }
}
