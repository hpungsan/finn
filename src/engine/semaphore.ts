/**
 * Counting semaphore for concurrency control.
 * Used by executor to limit parallel step execution.
 */
export class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) {
      throw new Error("Semaphore permits must be >= 1");
    }
    this.permits = permits;
  }

  /**
   * Acquire a permit. Blocks if no permits available.
   */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /**
   * Release a permit. Wakes up a waiting acquirer if any.
   */
  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }

  /**
   * Number of permits currently available.
   */
  get available(): number {
    return this.permits;
  }
}
