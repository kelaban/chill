import type { ServerEvent } from "@chill/shared";

type Listener = (e: ServerEvent) => void;

/** In-process pub/sub feeding the SSE endpoint. */
export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(e: ServerEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a broken listener must not break the publisher */
      }
    }
  }

  get size() {
    return this.listeners.size;
  }
}
