/** Fixed pool of network slots (zsnet slot numbers). Its size is also the concurrency limit. */
export class SlotPool {
  readonly max: number;
  private used = new Set<number>();

  constructor(max: number) {
    this.max = max;
  }

  /** Lowest free slot, or null when all are taken. */
  acquire(): number | null {
    for (let n = 0; n < this.max; n++) {
      if (!this.used.has(n)) {
        this.used.add(n);
        return n;
      }
    }
    return null;
  }

  release(n: number): void {
    this.used.delete(n);
  }

  get inUse(): number {
    return this.used.size;
  }
}
