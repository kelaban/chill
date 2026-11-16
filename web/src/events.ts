import type { ServerEvent } from "@chill/shared";
import { useEffect, useRef } from "react";

// One shared EventSource for the whole app; components subscribe by callback.
type Fn = (e: ServerEvent) => void;
const listeners = new Set<Fn>();
let source: EventSource | null = null;

function ensure() {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/events");
  source.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as ServerEvent;
      for (const fn of listeners) fn(e);
    } catch {
      /* ignore malformed */
    }
  };
  source.onerror = () => {
    // EventSource reconnects by itself; nothing to do.
  };
}

export function useServerEvents(fn: Fn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ensure();
    const l: Fn = (e) => ref.current(e);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}
