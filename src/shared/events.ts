/** Append-only domain fact, named in past tense (DDD domain event). */
export interface DomainEvent {
  id: string;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

/** In-process pub/sub for the pipeline. Persistence of events is the EventRepository's job. */
export interface EventBus {
  publish(event: DomainEvent): void;
  subscribe(handler: (event: DomainEvent) => void): () => void;
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Set<(event: DomainEvent) => void>();

  publish(event: DomainEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        // A broken subscriber must not break the pipeline; the error is logged by the subscriber itself.
        console.error(`[events] handler for ${event.type} failed:`, err);
      }
    }
  }

  subscribe(handler: (event: DomainEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
