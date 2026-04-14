import { useEffect, useRef } from "react";

type Topic = "event_created" | "status_changed" | "pending_changed";

type Subscribers = Partial<Record<Topic, () => void>>;

// Module-global EventSource: multiple components share a single stream.
let shared: EventSource | null = null;
const listeners = new Set<Subscribers>();

function ensureStream() {
  if (shared) return shared;
  const es = new EventSource("/api/stream");
  shared = es;

  const onTopic = (topic: Topic) => () => {
    for (const sub of listeners) sub[topic]?.();
  };
  es.addEventListener("event_created", onTopic("event_created"));
  es.addEventListener("status_changed", onTopic("status_changed"));
  es.addEventListener("pending_changed", onTopic("pending_changed"));

  // EventSource auto-reconnects on error; we also re-open if the object dies.
  es.onerror = () => {
    // Browser will retry automatically. Nothing to do.
  };
  return es;
}

/**
 * Subscribe to one or more server topics. `handlers` is re-read each render
 * via a ref, so you don't have to memoize it.
 */
export function useLive(handlers: Subscribers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    ensureStream();
    const wrapped: Subscribers = {
      event_created: () => ref.current.event_created?.(),
      status_changed: () => ref.current.status_changed?.(),
      pending_changed: () => ref.current.pending_changed?.(),
    };
    listeners.add(wrapped);
    return () => {
      listeners.delete(wrapped);
    };
  }, []);
}
