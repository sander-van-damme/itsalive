interface Waiting {
  priority: number;
  start: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
}
/** Bursts wait their turn; interactive requests go ahead of queued background work. */
export class RequestQueue {
  private active = 0;
  private waiting: Waiting[] = [];
  private starts: number[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly limits: () => {
      concurrency: number;
      requestsPerMinute: number;
    },
    private readonly now = Date.now,
  ) {}
  get size() {
    return this.active + this.waiting.length;
  }
  async run<T>(
    task: () => Promise<T>,
    priority: number,
    parent?: AbortSignal,
  ): Promise<T> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(120_000),
      ...(parent ? [parent] : []),
    ]);
    signal.throwIfAborted();
    if (this.waiting.length >= 128)
      throw new Error(
        "Too much work is waiting. Please let the current tasks finish.",
      );
    await new Promise<void>((resolve, reject) => {
      const entry: Waiting = {
        priority,
        signal,
        reject,
        start: resolve,
        abort: () => {
          this.waiting = this.waiting.filter((item) => item !== entry);
          reject(signal.reason);
          this.drain();
        },
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      this.waiting.push(entry);
      this.waiting.sort((a, b) => b.priority - a.priority);
      this.drain();
    });
    try {
      parent?.throwIfAborted();
      return await task();
    } finally {
      this.active--;
      this.drain();
    }
  }
  private drain() {
    if (this.timer) clearTimeout(this.timer);
    const now = this.now();
    this.starts = this.starts.filter((time) => now - time < 60_000);
    const limits = this.limits();
    while (this.waiting.length && this.active < limits.concurrency) {
      const recent = this.starts.filter((time) => now - time < 1000);
      if (
        this.starts.length >= limits.requestsPerMinute ||
        recent.length >= 30
      ) {
        const delay =
          this.starts.length >= limits.requestsPerMinute
            ? 60_000 - (now - this.starts[0]!)
            : 1000 - (now - recent[0]!);
        this.timer = setTimeout(() => this.drain(), Math.max(1, delay));
        return;
      }
      const entry = this.waiting.shift()!;
      entry.signal.removeEventListener("abort", entry.abort);
      if (entry.signal.aborted) {
        entry.reject(entry.signal.reason);
        continue;
      }
      this.active++;
      this.starts.push(now);
      entry.start();
    }
  }
}
