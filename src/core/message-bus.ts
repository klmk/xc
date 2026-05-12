/**
 * core/message-bus.ts
 *
 * Publish/subscribe message bus for inter-agent communication.
 * Agents do not share state -- they communicate exclusively through
 * structured messages on the bus.
 *
 * Supports two patterns:
 *   1. Pub/Sub  – subscribe to message types, publish without waiting.
 *   2. Request/Response – publish and wait for a reply correlated by ID.
 *
 * Uses only Node.js built-ins (EventEmitter).
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// ─── Message Types ───────────────────────────────────────────────────────────

export type MessageType =
  | 'task_assigned'
  | 'task_completed'
  | 'task_failed'
  | 'code_generated'
  | 'test_result'
  | 'review_result'
  | 'human_request'
  | 'human_response';

// ─── Message Envelope ────────────────────────────────────────────────────────

export interface Message<P = unknown> {
  /** Unique message identifier */
  id: string;
  /** Message type discriminator */
  type: MessageType;
  /** Sender agent identifier */
  from: string;
  /** Target agent identifier (or '*' for broadcast) */
  to: string;
  /** Structured payload */
  payload: P;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Correlation ID for request/response linking */
  correlationId?: string;
}

// ─── Subscriber Handler ─────────────────────────────────────────────────────

export type MessageHandler<P = unknown> = (message: Message<P>) => void | Promise<void>;

// ─── Request/Response ────────────────────────────────────────────────────────

export interface RequestOptions<P = unknown> {
  type: MessageType;
  from: string;
  to: string;
  payload: P;
  /** Timeout in ms (default 30 000) */
  timeout?: number;
}

// ─── Pending Request ─────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Message Bus ─────────────────────────────────────────────────────────────

export class MessageBus extends EventEmitter {
  private handlers: Map<string, Set<MessageHandler>>;
  private pendingRequests: Map<string, PendingRequest>;
  private defaultTimeout: number;
  private history: Message[];
  private maxHistory: number;
  private logger: { debug: (msg: string, data?: unknown) => void } | null;

  constructor(options?: {
    defaultTimeout?: number;
    maxHistory?: number;
    logger?: { debug: (msg: string, data?: unknown) => void };
  }) {
    super();
    this.handlers = new Map();
    this.pendingRequests = new Map();
    this.defaultTimeout = options?.defaultTimeout ?? 30_000;
    this.maxHistory = options?.maxHistory ?? 1000;
    this.history = [];
    this.logger = options?.logger ?? null;
  }

  // ─── Pub/Sub ────────────────────────────────────────────────────────────

  /**
   * Subscribe a handler to a specific message type.
   * Returns an unsubscribe function for easy cleanup.
   */
  subscribe<P = unknown>(type: MessageType, handler: MessageHandler<P>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as MessageHandler);

    // Return unsubscribe function
    return () => {
      set!.delete(handler as MessageHandler);
      if (set!.size === 0) {
        this.handlers.delete(type);
      }
    };
  }

  /**
   * Subscribe a handler to ALL message types (wildcard).
   * Returns an unsubscribe function.
   */
  subscribeAny(handler: MessageHandler): () => void {
    return this.subscribe('*' as MessageType, handler);
  }

  /**
   * Publish a message to the bus. All subscribers matching the message type
   * (and wildcard subscribers) will be notified.
   */
  publish<P = unknown>(
    type: MessageType,
    from: string,
    to: string,
    payload: P,
    correlationId?: string,
  ): Message<P> {
    const message: Message<P> = {
      id: randomUUID(),
      type,
      from,
      to,
      payload,
      timestamp: new Date().toISOString(),
      correlationId,
    };

    this.deliver(message);
    return message;
  }

  // ─── Request / Response ─────────────────────────────────────────────────

  /**
   * Publish a message and wait for a response correlated by `correlationId`.
   * The responder should reply using `respond()` or by publishing a message
   * with the same `correlationId`.
   *
   * Rejects with a timeout error if no response arrives in time.
   */
  async request<P = unknown, R = unknown>(
    options: RequestOptions<P>,
  ): Promise<Message<R>> {
    const { type, from, to, payload, timeout } = options;
    const correlationId = randomUUID();

    return new Promise<Message<R>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(
          new Error(
            `Request timeout: ${type} from ${from} to ${to} (correlationId=${correlationId}, timeout=${timeout ?? this.defaultTimeout}ms)`,
          ),
        );
      }, timeout ?? this.defaultTimeout);

      this.pendingRequests.set(correlationId, {
        resolve: resolve as (msg: Message) => void,
        reject,
        timer,
      });

      // Publish the request message
      this.publish(type, from, to, payload, correlationId);
    });
  }

  /**
   * Convenience method: send a reply to a previously received request.
   * Automatically copies `correlationId` and swaps `from`/`to`.
   */
  respond<R = unknown>(
    originalMessage: Message,
    replyType: MessageType,
    payload: R,
  ): Message<R> {
    return this.publish(
      replyType,
      originalMessage.to,
      originalMessage.from,
      payload,
      originalMessage.correlationId,
    );
  }

  // ─── History ────────────────────────────────────────────────────────────

  /**
   * Get the message history (up to `maxHistory` entries).
   */
  getHistory(): ReadonlyArray<Message> {
    return this.history;
  }

  /**
   * Get message history filtered by type.
   */
  getHistoryByType(type: MessageType): ReadonlyArray<Message> {
    return this.history.filter((m) => m.type === type);
  }

  /**
   * Get message history filtered by sender.
   */
  getHistoryBySender(from: string): ReadonlyArray<Message> {
    return this.history.filter((m) => m.from === from);
  }

  /**
   * Get message history filtered by correlation ID.
   */
  getHistoryByCorrelationId(correlationId: string): ReadonlyArray<Message> {
    return this.history.filter((m) => m.correlationId === correlationId);
  }

  /**
   * Clear all message history.
   */
  clearHistory(): void {
    this.history = [];
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Reject all pending requests and clear all handlers.
   */
  shutdown(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Message bus shut down'));
    }
    this.pendingRequests.clear();
    this.handlers.clear();
    this.removeAllListeners();
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /**
   * Deliver a message to all matching subscribers and check pending requests.
   */
  private deliver(message: Message): void {
    // Record in history
    this.history.push(message);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    this.logger?.debug('Message delivered', { id: message.id, type: message.type, from: message.from, to: message.to });

    // Emit as EventEmitter event (for programmatic listeners)
    this.emit('message', message);
    this.emit(`message:${message.type}`, message);

    // Notify type-specific subscribers
    const typeHandlers = this.handlers.get(message.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        this.invokeHandler(handler, message);
      }
    }

    // Notify wildcard subscribers
    const anyHandlers = this.handlers.get('*' as MessageType);
    if (anyHandlers) {
      for (const handler of anyHandlers) {
        this.invokeHandler(handler, message);
      }
    }

    // Check if this message resolves a pending request
    if (message.correlationId) {
      const pending = this.pendingRequests.get(message.correlationId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.correlationId);
        pending.resolve(message);
      }
    }
  }

  /**
   * Invoke a handler, catching and reporting errors so one failing handler
   * does not prevent others from running.
   */
  private invokeHandler(handler: MessageHandler, message: Message): void {
    try {
      const result = handler(message);
      // If the handler returns a promise, catch its rejections
      if (result instanceof Promise) {
        result.catch((err: Error) => {
          process.stderr.write(
            `[message-bus] Handler error for message ${message.id} (${message.type}): ${err.message}\n`,
          );
        });
      }
    } catch (err: unknown) {
      const message2 = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[message-bus] Synchronous handler error for message ${message.id} (${message.type}): ${message2}\n`,
      );
    }
  }
}
