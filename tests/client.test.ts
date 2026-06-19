import { afterEach, describe, expect, it, vi } from "vitest";
import { AttuneClient } from "../src/client.js";

describe("AttuneClient token access", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("re-reads ATTUNE_API_TOKEN between requests by default", async () => {
    vi.stubEnv("ATTUNE_API_URL", "http://localhost:8080");
    vi.stubEnv("ATTUNE_API_TOKEN", "token-a");

    const fetchMock = vi.fn(async (request: Request) => {
      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AttuneClient();
    await client.get("/api/v1/health");

    vi.stubEnv("ATTUNE_API_TOKEN", "token-b");
    await client.get("/api/v1/health");

    const firstHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe("Bearer token-a");
    expect(secondHeaders.Authorization).toBe("Bearer token-b");
  });

  it("supports explicit token provider", async () => {
    vi.stubEnv("ATTUNE_API_URL", "http://localhost:8080");
    let currentToken = "token-1";

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AttuneClient({
      apiTokenProvider: () => currentToken,
    });
    await client.get("/api/v1/health");
    currentToken = "token-2";
    await client.get("/api/v1/health");

    const firstHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe("Bearer token-1");
    expect(secondHeaders.Authorization).toBe("Bearer token-2");
  });
});
