import { EventEmitter } from "node:events";

/**
 * Pub/sub used for SSE pushes. Payloads are intentionally tiny — the UI pulls
 * fresh state through its REST endpoints when a topic fires.
 */
export type BusTopic = "event_created" | "status_changed" | "pending_changed";

export class Bus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(100);
  }
  emit(topic: BusTopic) {
    this.emitter.emit(topic);
  }
  on(topic: BusTopic, fn: () => void): () => void {
    this.emitter.on(topic, fn);
    return () => this.emitter.off(topic, fn);
  }
}
