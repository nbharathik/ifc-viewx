export type GeometryPriority = 0 | 1 | 2;

interface QueuedTask {
  priority: GeometryPriority;
  order: number;
  run(): Promise<void>;
}

/** Interactive work can run at the next worker yield while background work stays serial. */
export class GeometryScheduler {
  private readonly background: QueuedTask[] = [];
  private backgroundRunning = false;
  private sequence = 0;

  schedule<T>(priority: GeometryPriority, task: () => T | Promise<T>): Promise<T> {
    if (priority === 0) return Promise.resolve().then(task);
    return new Promise<T>((resolve, reject) => {
      this.background.push({
        priority,
        order: ++this.sequence,
        run: async () => {
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          }
        },
      });
      this.background.sort((a, b) => a.priority - b.priority || a.order - b.order);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.backgroundRunning) return;
    this.backgroundRunning = true;
    try {
      while (this.background.length) await this.background.shift()!.run();
    } finally {
      this.backgroundRunning = false;
    }
  }
}
