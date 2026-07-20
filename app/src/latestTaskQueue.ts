export class LatestTaskQueue<T> {
  private pending: T | undefined
  private running: Promise<boolean> | null = null
  private stopped = false

  constructor(private readonly run: (value: T) => Promise<boolean>) {}

  submit(value: T) {
    if (this.stopped) return Promise.resolve(false)
    this.pending = value
    if (!this.running) this.running = this.drain()
    return this.running
  }

  clear() {
    this.pending = undefined
  }

  stop() {
    this.stopped = true
    this.clear()
  }

  snapshot() {
    return {
      running: this.running !== null,
      pending: this.pending !== undefined,
      stopped: this.stopped,
    }
  }

  private async drain() {
    let successful = true
    try {
      while (!this.stopped && this.pending !== undefined) {
        const value = this.pending
        this.pending = undefined
        if (!await this.run(value)) {
          successful = false
          this.pending = undefined
          break
        }
      }
      return successful
    } finally {
      this.running = null
    }
  }
}
