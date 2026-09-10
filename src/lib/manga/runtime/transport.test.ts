import { afterEach, describe, expect, test, vi } from "vitest";

import { SourceRuntimeError } from "./errors";
import {
  SuwayomiTransport,
  type GraphQLOperation,
  type GraphQLTraceEvent,
} from "./transport";

interface ExampleResult {
  ok: boolean;
}

const EXAMPLE_QUERY: GraphQLOperation<{ id: string }, ExampleResult> = {
  name: "Example",
  kind: "query",
  document: "query Example($id: String!) { example(id: $id) { ok } }",
  decode(value) {
    const root = value as { example?: { ok?: unknown } };
    if (typeof root.example?.ok !== "boolean") {
      throw new SourceRuntimeError("RUNTIME_INCOMPATIBLE", "Invalid example payload.");
    }
    return { ok: root.example.ok };
  },
};

describe("SuwayomiTransport", () => {
  test.each(["admission", "headers"])("refuses a target change during %s before sending a mutation", async boundary => {
    let resume!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const release = vi.fn();
    let target = "original";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { example: { ok: true } } })));
    const transport = new SuwayomiTransport({
      endpoint: "http://127.0.0.1:4567/api/graphql", fetch: fetchMock,
      beginMutationLease: async () => { if (boundary === "admission") { entered(); await blocked; } return release; },
      headers: async () => { if (boundary === "headers") { entered(); await blocked; } return {}; },
    });
    const result = transport.execute({ ...EXAMPLE_QUERY, kind: "mutation" }, { id: "source-1" }, {
      assertTarget: () => { if (target !== "original") throw Error("RESTORE_TARGET_CHANGED"); },
    });
    const rejected = expect(result).rejects.toMatchObject({ cause: new Error("RESTORE_TARGET_CHANGED"), retryable: false });
    await waiting; target = "different"; resume();
    await rejected;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("executes a typed operation and decodes only the GraphQL data payload", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { example: { ok: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const transport = new SuwayomiTransport({
      endpoint: "http://127.0.0.1:4567/api/graphql",
      fetch: fetchMock,
      headers: () => new Headers({ Authorization: "Basic redacted" }),
      retries: 0,
    });

    await expect(transport.execute(EXAMPLE_QUERY, { id: "source-1" })).resolves.toEqual({ ok: true });

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("Authorization")).toBe("Basic redacted");
    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      operationName: "Example",
      variables: { id: "source-1" },
    });
  });

  test("retries transient HTTP failures without retrying authentication errors", async () => {
    const transientFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { example: { ok: true } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const retrying = new SuwayomiTransport({
      endpoint: "http://127.0.0.1:4567/api/graphql",
      fetch: transientFetch,
      retries: 1,
      retryDelayMs: 0,
    });

    await expect(retrying.execute(EXAMPLE_QUERY, { id: "source-1" })).resolves.toEqual({ ok: true });
    expect(transientFetch).toHaveBeenCalledTimes(2);

    const authFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const authenticated = new SuwayomiTransport({
      endpoint: "http://127.0.0.1:4567/api/graphql",
      fetch: authFetch,
      retries: 2,
    });

    await expect(authenticated.execute(EXAMPLE_QUERY, { id: "source-1" })).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      retryable: false,
    });
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  test("runs the mutation guard before issuing a mutation", async () => {
    const beforeMutation = vi.fn(() => {
      throw new SourceRuntimeError("RUNTIME_UNAVAILABLE", "Writes are locked.");
    });
    const fetchMock = vi.fn<typeof fetch>();
    const transport = new SuwayomiTransport({
      endpoint: "http://127.0.0.1:4567/api/graphql",
      fetch: fetchMock,
      beforeMutation,
    });
    const mutation = { ...EXAMPLE_QUERY, kind: "mutation" as const };

    await expect(transport.execute(mutation, { id: "source-1" })).rejects.toThrow("Writes are locked.");
    expect(beforeMutation).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("never retries a mutation after an ambiguous transient failure", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { example: { ok: true } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const transport = new SuwayomiTransport({
      endpoint: "http://127.0.0.1:4567/api/graphql",
      fetch: fetchMock,
      retries: 2,
      retryDelayMs: 0,
    });
    const mutation = { ...EXAMPLE_QUERY, kind: "mutation" as const };

    await expect(transport.execute(mutation, { id: "source-1" })).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("holds the mutation lease through decoding and releases it after failure", async () => {
    const release = vi.fn();
    const beginMutationLease = vi.fn(async () => release);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: null, errors: [{ message: "Write failed" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const transport = new SuwayomiTransport({
      endpoint: "http://127.0.0.1:4567/api/graphql",
      fetch: fetchMock,
      beginMutationLease,
    });
    const mutation = { ...EXAMPLE_QUERY, kind: "mutation" as const };

    await expect(transport.execute(mutation, { id: "source-1" })).rejects.toThrow("Write failed");
    expect(beginMutationLease).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  test("normalizes GraphQL and incompatible JSON errors", async () => {
    const graphqlFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: null, errors: [{ message: "Source failed" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const graphqlTransport = new SuwayomiTransport({
      endpoint: "http://127.0.0.1:4567/api/graphql",
      fetch: graphqlFetch,
      retries: 0,
    });

    await expect(graphqlTransport.execute(EXAMPLE_QUERY, { id: "source-1" })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: "Source failed",
    });

    const invalidFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not-json", { status: 200 }),
    );
    const invalidTransport = new SuwayomiTransport({
      endpoint: "http://127.0.0.1:4567/api/graphql",
      fetch: invalidFetch,
      retries: 0,
    });

    await expect(invalidTransport.execute(EXAMPLE_QUERY, { id: "source-1" })).rejects.toMatchObject({
      code: "RUNTIME_INCOMPATIBLE",
    });
  });

  test("keeps structured GraphQL evidence while redacting sensitive extensions", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        data: null,
        errors: [{
          message: "Failed at C:\\Users\\private-user\\profile",
          path: ["source", 2],
          locations: [{ line: 3, column: 7 }],
          extensions: {
            code: "SOURCE_FAILURE",
            token: "secret-value",
          },
        }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const transport = new SuwayomiTransport({
      endpoint: "http://127.0.0.1:4567/api/graphql",
      fetch: fetchMock,
      retries: 0,
    });

    const failure = await transport.execute(EXAMPLE_QUERY, { id: "source-1" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "UNKNOWN",
      graphqlErrors: [{
        message: "Failed at [PRIVATE_PATH]\\profile",
        path: ["source", 2],
        locations: [{ line: 3, column: 7 }],
        extensions: {
          code: "SOURCE_FAILURE",
          token: "[REDACTED]",
        },
      }],
    });
  });

  test("emits bounded optional traces without exposing query or credentials", async () => {
    const events: GraphQLTraceEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { example: { ok: true } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    let now = 0;
    const transport = new SuwayomiTransport({
      endpoint: "http://user:password@LOCALHOST:80/api/graphql?token=secret",
      fetch: fetchMock,
      headers: () => ({
        Authorization: "Bearer secret",
        Cookie: "session=secret",
      }),
      retries: 1,
      retryDelayMs: 0,
      requestIdFactory: () => "request-1",
      now: () => {
        now += 5;
        return now;
      },
      traceObserver: (event) => events.push(event),
    });

    await expect(transport.execute(EXAMPLE_QUERY, {
      id: "source-1",
      query: "private title",
      token: "private token",
    } as { id: string })).resolves.toEqual({ ok: true });

    expect(transport.getEndpointIdentity()).toBe("http://localhost/api/graphql");
    expect(events.map((event) => event.stage)).toEqual([
      "request",
      "retry",
      "request",
      "response",
      "decode",
      "complete",
    ]);
    expect(events[0]).toMatchObject({
      requestId: "request-1",
      variables: {
        id: "source-1",
        query: "[REDACTED]",
        token: "[REDACTED]",
      },
    });
    expect(JSON.stringify(events)).not.toContain("Bearer secret");
    expect(JSON.stringify(events)).not.toContain("session=secret");
    expect(JSON.stringify(events)).not.toContain("private title");
  });

  test("isolates trace observer failures from source requests", async () => {
    const transport = new SuwayomiTransport({
      endpoint: "http://127.0.0.1:4567/api/graphql",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: { example: { ok: true } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
      traceObserver: () => {
        throw new Error("observer failed");
      },
    });

    await expect(transport.execute(EXAMPLE_QUERY, { id: "source-1" })).resolves.toEqual({
      ok: true,
    });
  });
});
