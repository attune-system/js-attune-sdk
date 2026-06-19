import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ConnectionCall = {
  readonly headers: Record<string, string> | undefined;
};

type CloseCall = {
  readonly code: number | undefined;
  readonly reason: string;
};

const connectionCalls: ConnectionCall[] = [];
const closeCalls: CloseCall[] = [];
let autoCloseAfterOpen = true;

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;

  constructor(_url: string, options?: { headers?: Record<string, string> }) {
    super();
    connectionCalls.push({ headers: options?.headers });

    queueMicrotask(() => {
      this.emit("open");
      if (autoCloseAfterOpen) {
        this.readyState = MockWebSocket.CLOSED;
        this.emit("close", 1000, Buffer.alloc(0));
      }
    });
  }

  send(_data: string): void {}

  close(code?: number, reason?: string | Buffer): void {
    this.readyState = MockWebSocket.CLOSED;
    const decodedReason =
      typeof reason === "string"
        ? reason
        : reason
          ? reason.toString("utf8")
          : "";
    closeCalls.push({ code, reason: decodedReason });
    queueMicrotask(() => this.emit("close", code ?? 1000, Buffer.from(decodedReason)));
  }
}

vi.mock("ws", () => ({ default: MockWebSocket }));

describe("Sensor notifier token handling", () => {
  beforeEach(() => {
    vi.resetModules();
    connectionCalls.length = 0;
    closeCalls.length = 0;
    autoCloseAfterOpen = true;
    vi.unstubAllEnvs();
  });

  it("reconnects using the latest token value", async () => {
    const { Sensor } = await import("../src/sensor.js");
    const sensor = new Sensor();
    let currentToken = "token-v1";
    const baseContext = (sensor as any).context;
    (sensor as any).context = {
      ...baseContext,
      notifierWsUrl: "ws://notifier:8081/ws",
      getTokenState: () => ({ token: currentToken, expiresAt: null, source: "env" }),
    };

    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 1,
      rule_ref: "pack.rule",
      trigger_ref: "pack.trigger",
      trigger_params: {},
    });

    await (sensor as any)._connectNotifier("ws://notifier:8081/ws");
    currentToken = "token-v2";
    await (sensor as any)._connectNotifier("ws://notifier:8081/ws");

    expect(connectionCalls[0]?.headers?.Authorization).toBe("Bearer token-v1");
    expect(connectionCalls[1]?.headers?.Authorization).toBe("Bearer token-v2");
  });

  it("proactively reconnects when expiry metadata is near", async () => {
    autoCloseAfterOpen = false;

    const { Sensor } = await import("../src/sensor.js");
    const sensor = new Sensor();
    const baseContext = (sensor as any).context;
    (sensor as any).context = {
      ...baseContext,
      notifierWsUrl: "ws://notifier:8081/ws",
      getTokenState: () => ({
        token: "token-expiring",
        expiresAt: new Date(Date.now() + 1_000),
        source: "state_file",
      }),
    };

    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 1,
      rule_ref: "pack.rule",
      trigger_ref: "pack.trigger",
      trigger_params: {},
    });

    await (sensor as any)._connectNotifier("ws://notifier:8081/ws");

    expect(closeCalls.some((call) => call.code === 4001)).toBe(true);
    expect(closeCalls.some((call) => call.reason.includes("token rotation"))).toBe(true);
  });

  it("keeps notifier connect safe when expiry metadata is unavailable", async () => {
    const { Sensor } = await import("../src/sensor.js");
    const sensor = new Sensor();
    const baseContext = (sensor as any).context;
    (sensor as any).context = {
      ...baseContext,
      notifierWsUrl: "ws://notifier:8081/ws",
      getTokenState: () => ({ token: "token-no-expiry", expiresAt: null, source: "state_file" }),
    };

    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 1,
      rule_ref: "pack.rule",
      trigger_ref: "pack.trigger",
      trigger_params: {},
    });

    await (sensor as any)._connectNotifier("ws://notifier:8081/ws");

    expect(connectionCalls[0]?.headers?.Authorization).toBe("Bearer token-no-expiry");
    expect(closeCalls.some((call) => call.code === 4001)).toBe(false);
  });

  it("skips notifier connection attempts when token state is unavailable", async () => {
    const { Sensor } = await import("../src/sensor.js");
    const sensor = new Sensor();
    const baseContext = (sensor as any).context;
    (sensor as any).context = {
      ...baseContext,
      notifierWsUrl: "ws://notifier:8081/ws",
      getTokenState: () => ({ token: "", expiresAt: null, source: "none" }),
    };

    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 1,
      rule_ref: "pack.rule",
      trigger_ref: "pack.trigger",
      trigger_params: {},
    });

    await (sensor as any)._connectNotifier("ws://notifier:8081/ws");
    expect(connectionCalls).toHaveLength(0);
  });
});
