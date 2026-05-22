/**
 * Lightweight HTTP client for the Attune API.
 *
 * Uses the execution-scoped API token from the environment. Uses Node.js
 * built-in fetch (available since Node 18).
 *
 * Usage:
 *   import { AttuneClient } from "attune/client";
 *
 *   const client = new AttuneClient(); // auto-reads ATTUNE_API_URL and ATTUNE_API_TOKEN
 *   const artifacts = await client.get("/api/v1/artifacts", { params: { execution: "42" } });
 */

export interface AttuneClientOptions {
  apiUrl?: string;
  apiToken?: string;
  timeout?: number;
}

export class AttuneClient {
  readonly apiUrl: string;
  readonly apiToken: string;
  private readonly timeout: number;

  constructor(options: AttuneClientOptions = {}) {
    this.apiUrl = (
      options.apiUrl ?? process.env.ATTUNE_API_URL ?? "http://localhost:8080"
    ).replace(/\/+$/, "");
    this.apiToken = options.apiToken ?? process.env.ATTUNE_API_TOKEN ?? "";
    this.timeout = options.timeout ?? 30_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiToken) {
      h["Authorization"] = `Bearer ${this.apiToken}`;
    }
    return h;
  }

  private async request(method: string, path: string, options?: { json?: unknown; params?: Record<string, string> }): Promise<unknown> {
    let url = `${this.apiUrl}${path}`;
    if (options?.params) {
      const qs = new URLSearchParams(options.params).toString();
      url += `?${qs}`;
    }
    const resp = await fetch(url, {
      method,
      headers: this.headers(),
      body: options?.json !== undefined ? JSON.stringify(options.json) : undefined,
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  async get(path: string, options?: { params?: Record<string, string> }): Promise<unknown> {
    return this.request("GET", path, options);
  }

  async post(path: string, options?: { json?: unknown }): Promise<unknown> {
    return this.request("POST", path, options);
  }

  async put(path: string, options?: { json?: unknown }): Promise<unknown> {
    return this.request("PUT", path, options);
  }

  async delete(path: string): Promise<unknown> {
    return this.request("DELETE", path);
  }
}
