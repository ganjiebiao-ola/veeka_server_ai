import type { RunEvent } from "../../shared/types.ts";

type Handler = (ev: RunEvent) => void;

export class RunEventBus {
  private channels = new Map<string, Set<Handler>>();
  private buffers = new Map<string, RunEvent[]>();
  private closers = new Map<string, Set<() => void>>();

  publish(runId: string, ev: RunEvent): void {
    const buf = this.buffers.get(runId) ?? [];
    buf.push(ev);
    this.buffers.set(runId, buf);
    const subs = this.channels.get(runId);
    if (subs) for (const fn of subs) fn(ev);
  }

  history(runId: string): RunEvent[] {
    return [...(this.buffers.get(runId) ?? [])]
  }

  subscribe(runId: string): AsyncIterableIterator<RunEvent> {
    let subs = this.channels.get(runId);
    if (!subs) {
      subs = new Set();
      this.channels.set(runId, subs);
    }
    let closeSet = this.closers.get(runId);
    if (!closeSet) {
      closeSet = new Set();
      this.closers.set(runId, closeSet);
    }
    const queued: RunEvent[] = [...(this.buffers.get(runId) ?? [])];
    let resolveNext: ((v: IteratorResult<RunEvent>) => void) | null = null;
    let closed = false;

    const handler: Handler = (ev) => {
      if (closed) return;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: ev, done: false });
      } else {
        queued.push(ev);
      }
    };
    subs.add(handler);

    const close = () => {
      if (closed) return;
      closed = true;
      subs!.delete(handler);
      closeSet!.delete(close);
      if (!subs!.size) this.channels.delete(runId)
      if (!closeSet!.size) this.closers.delete(runId)
      queued.length = 0
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as unknown as RunEvent, done: true });
      }
    };
    closeSet.add(close);

    return {
      next: () => {
        if (closed) return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
        if (queued.length > 0) {
          return Promise.resolve({ value: queued.shift()!, done: false });
        }
        return new Promise<IteratorResult<RunEvent>>((resolve) => {
          resolveNext = resolve;
        });
      },
      return: () => {
        close();
        return Promise.resolve({ value: undefined as unknown as RunEvent, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  drop(runId: string): void {
    const closeSet = this.closers.get(runId);
    if (closeSet) {
      // Snapshot to a new array because close() mutates the set
      for (const c of [...closeSet]) c();
    }
    this.channels.delete(runId);
    this.buffers.delete(runId);
    this.closers.delete(runId);
  }
}
