import { afterEach, describe, expect, test, vi } from "vitest";

import { SourceRuntimeError } from "./errors";
import { SuwayomiTransport, type GraphQLOperation } from "./transport";

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
});
