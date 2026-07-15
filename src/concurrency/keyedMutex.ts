export class KeyedMutex {
  private readonly queues = new Map<string, Promise<void>>();

  /** 同一业务键串行执行，其他用户/会话仍可并行。 */
  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(key, current);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }
}
