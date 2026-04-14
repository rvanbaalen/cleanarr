/**
 * Buffers per-episode delete events keyed by `${tvdbId}:${seasonNumber}`.
 * After `debounceMs` of silence on that key, invokes `onFlush` with the
 * accumulated events. The flush handler can then decide whether the whole
 * season (or series) should be escalated beyond per-episode cleanup.
 */
export type EpisodeEvent = {
  seriesTvdbId: string;
  seasonNumber: number;
  episodeNumber: number;
  name?: string | null;
};

export class SeasonDebouncer {
  private buckets = new Map<
    string,
    { events: EpisodeEvent[]; timer: NodeJS.Timeout }
  >();

  constructor(
    private debounceMs: number,
    private onFlush: (key: string, events: EpisodeEvent[]) => Promise<void>,
  ) {}

  private keyOf(e: EpisodeEvent) {
    return `${e.seriesTvdbId}:${e.seasonNumber}`;
  }

  add(event: EpisodeEvent) {
    const key = this.keyOf(event);
    const existing = this.buckets.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.events.push(event);
      existing.timer = setTimeout(() => this.flush(key), this.debounceMs);
    } else {
      const timer = setTimeout(() => this.flush(key), this.debounceMs);
      this.buckets.set(key, { events: [event], timer });
    }
  }

  private async flush(key: string) {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    this.buckets.delete(key);
    try {
      await this.onFlush(key, bucket.events);
    } catch {
      // flush errors are logged by caller; buffer is already cleared
    }
  }

  /** snapshot current state for the UI */
  snapshot(): Array<{ key: string; count: number; events: EpisodeEvent[] }> {
    return Array.from(this.buckets.entries()).map(([key, b]) => ({
      key,
      count: b.events.length,
      events: b.events,
    }));
  }

  /** flush everything immediately (e.g. shutdown) */
  async flushAll() {
    const keys = Array.from(this.buckets.keys());
    for (const key of keys) {
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      clearTimeout(bucket.timer);
      await this.flush(key);
    }
  }
}
