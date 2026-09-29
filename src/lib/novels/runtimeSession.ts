import type { NovelRuntimeHostAdapter, NovelRuntimeInvokeAction } from "./contracts";

/** Coordinates consumers of the existing host; it does not create another runtime. */
export class NovelRuntimeSession {
  private readonly owners = new Set<symbol>();
  private readonly requests = new Set<Promise<unknown>>();
  private stopping: Promise<void> | null = null;
  private generation = 0;

  constructor(private readonly host: Pick<NovelRuntimeHostAdapter, "invoke" | "stop">) {}

  acquire(): () => Promise<void> {
    const owner = Symbol();
    this.owners.add(owner);
    this.generation += 1;
    return async () => {
      if (!this.owners.delete(owner)) return;
      await this.stop();
    };
  }

  invoke<TPayload = unknown, TResult = unknown>(action: NovelRuntimeInvokeAction, payload: TPayload): Promise<TResult> {
    this.generation += 1;
    const operation = (async () => {
      if (this.stopping) await this.stopping;
      return this.host.invoke<TPayload, TResult>(action, payload);
    })();
    this.requests.add(operation);
    void operation.then(() => this.requests.delete(operation), () => this.requests.delete(operation));
    return operation;
  }

  async stop(): Promise<void> {
    if (this.owners.size > 0) return;
    const generation = this.generation;
    if (this.requests.size > 0) await Promise.allSettled([...this.requests]);
    if (this.owners.size > 0 || generation !== this.generation) return;
    if (this.stopping) return this.stopping;
    const stopping = this.host.stop();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = null;
    }
  }
}
