import { describe, it, expect, vi, afterEach } from "vitest";
import { Sensor, PollingSensor, AsyncPollingSensor } from "../src/sensor.js";
import type { RuleState } from "../src/sensor.js";

describe("RuleState", () => {
  it("basic construction via _handleRuleMessage", () => {
    const sensor = new Sensor();
    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 1,
      rule_ref: "mypack.my_rule",
      trigger_ref: "mypack.my_trigger",
      trigger_params: { interval: 5 },
    });
    const rule = sensor.rules.get(1)!;
    expect(rule.ruleId).toBe(1);
    expect(rule.ruleRef).toBe("mypack.my_rule");
    expect(rule.triggerParams).toEqual({ interval: 5 });
    expect(rule.enabled).toBe(true);
  });
});

describe("Sensor base", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shutdown sets flag", () => {
    const sensor = new Sensor();
    expect(sensor.isShuttingDown).toBe(false);
    sensor.shutdown();
    expect(sensor.isShuttingDown).toBe(true);
  });

  it("bootstrap rules from env", () => {
    vi.stubEnv(
      "ATTUNE_SENSOR_TRIGGERS",
      JSON.stringify([{ id: 1, ref: "mypack.rule1", trigger_ref: "mypack.trig", config: { interval: "3" } }]),
    );
    const sensor = new Sensor();
    sensor._bootstrapRules();
    expect(sensor.rules.has(1)).toBe(true);
    expect(sensor.rules.get(1)!.ruleRef).toBe("mypack.rule1");
    expect(sensor.rules.get(1)!.triggerParams).toEqual({ interval: "3" });
    vi.unstubAllEnvs();
  });

  it("bootstrap empty env", () => {
    delete process.env.ATTUNE_SENSOR_TRIGGERS;
    const sensor = new Sensor();
    sensor._bootstrapRules();
    expect(sensor.rules.size).toBe(0);
  });

  it("rule lifecycle hooks called", () => {
    const events: unknown[] = [];

    class HookSensor extends Sensor {
      onRuleCreated(rule: RuleState) { events.push(["created", rule.ruleId]); }
      onRuleDisabled(rule: RuleState) { events.push(["disabled", rule.ruleId]); }
      onRuleDeleted(rule: RuleState) { events.push(["deleted", rule.ruleId]); }
      onRuleUpdated(rule: RuleState, oldParams: Record<string, unknown>) {
        events.push(["updated", rule.ruleId, oldParams]);
      }
    }

    const sensor = new HookSensor();

    // Create
    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 10,
      rule_ref: "pack.rule",
      trigger_params: { interval: 5 },
    });
    expect(events).toContainEqual(["created", 10]);

    // Update params
    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 10,
      rule_ref: "pack.rule",
      trigger_params: { interval: 10 },
    });
    expect(events).toContainEqual(["updated", 10, { interval: 5 }]);

    // Disable
    sensor._handleRuleMessage({ event_type: "rule.disabled", rule_id: 10 });
    expect(events).toContainEqual(["disabled", 10]);

    // Enable
    sensor._handleRuleMessage({
      event_type: "rule.enabled",
      rule_id: 10,
      rule_ref: "pack.rule",
      trigger_params: { interval: 10 },
    });
    expect(events.filter((event) => JSON.stringify(event) === JSON.stringify(["created", 10]))).toHaveLength(2);

    // Explicit update
    sensor._handleRuleMessage({
      event_type: "rule.updated",
      rule_id: 10,
      rule_ref: "pack.rule",
      trigger_params: { interval: 15 },
    });
    expect(events).toContainEqual(["updated", 10, { interval: 10 }]);

    // Delete
    sensor._handleRuleMessage({ event_type: "rule.deleted", rule_id: 10 });
    expect(events).toContainEqual(["deleted", 10]);
  });

  it("extracts rule lifecycle from notifier envelope", () => {
    const sensor = new Sensor();
    sensor._handleNotifierEnvelope(Buffer.from(JSON.stringify({
      type: "notification",
      payload: {
        event_type: "rule.created",
        rule_id: 11,
        rule_ref: "pack.rule",
        trigger_ref: "pack.trigger",
        trigger_params: { interval: 7 },
        active: true,
      },
    })));

    expect(sensor.rules.get(11)).toEqual({
      ruleId: 11,
      ruleRef: "pack.rule",
      triggerRef: "pack.trigger",
      triggerParams: { interval: 7 },
      enabled: true,
    });
  });

  it("builds notifier trigger subscriptions from managed rules", () => {
    const sensor = new Sensor();
    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 1,
      rule_ref: "pack.rule1",
      trigger_ref: "pack.trigger",
      trigger_params: {},
    });
    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 2,
      rule_ref: "pack.rule2",
      trigger_ref: "pack.trigger",
      trigger_params: {},
    });

    expect(sensor._getManagedTriggerFilters()).toEqual(["trigger_ref:pack.trigger"]);
  });

  it("uses all declared trigger types for notifier subscriptions", () => {
    vi.stubEnv("ATTUNE_SENSOR_TRIGGER_TYPES", JSON.stringify(["pack.second", "pack.first", "pack.second"]));
    const sensor = new Sensor();

    expect(sensor._getManagedTriggerFilters()).toEqual([
      "trigger_ref:pack.second",
      "trigger_ref:pack.first",
    ]);
  });

  it("refetches deferred creates through the authenticated Attune API", async () => {
    const largeValue = "x".repeat(256 * 1024);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: {
        id: 12,
        ref: "pack.rule",
        trigger_ref: "pack.trigger",
        trigger_params: { large_value: largeValue },
        enabled: true,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const sensor = new Sensor();
    const baseContext = (sensor as any).context;
    (sensor as any).context = {
      ...baseContext,
      apiUrl: "https://attune.test",
      getTokenState: () => ({ token: "sensor-token", expiresAt: null, source: "env" }),
    };

    await sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 12,
      rule_ref: "pack.rule",
      auth_mode: "deferred",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://attune.test/api/v1/rules/pack.rule");
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Authorization: "Bearer sensor-token" });
    expect(sensor.rules.get(12)).toEqual({
      ruleId: 12,
      ruleRef: "pack.rule",
      triggerRef: "pack.trigger",
      triggerParams: { large_value: largeValue },
      enabled: true,
    });
  });

  it.each(["rule.created", "rule.enabled", "rule.updated"])(
    "refetches authoritative parameters for an existing deferred %s without parameters",
    async (eventType) => {
      const oldLargeValue = "x".repeat(256 * 1024);
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({
        data: {
          id: 12,
          ref: "pack.rule",
          trigger_ref: "pack.trigger",
          trigger_params: { interval_seconds: 60 },
          enabled: true,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
      vi.stubGlobal("fetch", fetchMock);
      const sensor = new Sensor();
      const baseContext = (sensor as any).context;
      (sensor as any).context = {
        ...baseContext,
        getTokenState: () => ({ token: "sensor-token", expiresAt: null, source: "env" }),
      };
      await sensor._handleRuleMessage({
        event_type: "rule.created",
        rule_id: 12,
        rule_ref: "pack.rule",
        trigger_ref: "pack.trigger",
        trigger_params: { large_value: oldLargeValue, interval_seconds: 30 },
      });

      await sensor._handleRuleMessage({
        event_type: eventType,
        rule_id: 12,
        rule_ref: "pack.rule",
        trigger_ref: "pack.trigger",
        auth_mode: "deferred",
        active: true,
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(sensor.rules.get(12)?.triggerParams).toEqual({ interval_seconds: 60 });
    },
  );

  it("refetches unknown deferred updates before creating local state", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: {
        id: 13,
        ref: "pack.updated-rule",
        trigger_ref: "pack.trigger",
        trigger_params: { interval: 45 },
        enabled: true,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const sensor = new Sensor();
    const baseContext = (sensor as any).context;
    (sensor as any).context = {
      ...baseContext,
      getTokenState: () => ({ token: "sensor-token", expiresAt: null, source: "env" }),
    };

    await sensor._handleRuleMessage({
      event_type: "rule.updated",
      rule_id: 13,
      rule_ref: "pack.updated-rule",
      auth_mode: "deferred",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sensor.rules.get(13)?.triggerParams).toEqual({ interval: 45 });
  });

  it("fails closed when a deferred rule refetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("API unavailable"); }));
    const sensor = new Sensor();
    const baseContext = (sensor as any).context;
    (sensor as any).context = {
      ...baseContext,
      getTokenState: () => ({ token: "sensor-token", expiresAt: null, source: "env" }),
    };

    await sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 12,
      rule_ref: "pack.rule",
      trigger_ref: "pack.trigger",
      auth_mode: "deferred",
    });

    expect(sensor.rules.size).toBe(0);
  });

  it("applies deferred disable and deletion without refetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sensor = new Sensor();
    await sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 14,
      rule_ref: "pack.rule",
      trigger_ref: "pack.trigger",
      trigger_params: { interval: 30 },
    });

    await sensor._handleRuleMessage({
      event_type: "rule.disabled",
      rule_id: 14,
      auth_mode: "deferred",
    });
    expect(sensor.rules.get(14)?.enabled).toBe(false);

    await sensor._handleRuleMessage({
      event_type: "rule.deleted",
      rule_id: 14,
      auth_mode: "deferred",
    });
    expect(sensor.rules.has(14)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("targets a supplied rule by numeric ID by default", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: { id: 99 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const sensor = new Sensor();
    const rule: RuleState = {
      ruleId: Number.MAX_SAFE_INTEGER,
      ruleRef: "pack.named-rule",
      triggerRef: "pack.trigger",
      triggerParams: {},
      enabled: true,
    };

    await expect(sensor.emit({ value: 1 }, { rule })).resolves.toBe(99);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body).toEqual({
      trigger_ref: "pack.trigger",
      payload: { value: 1 },
      source: sensor.context.sensorRef,
      trigger_instance_id: `rule_${Number.MAX_SAFE_INTEGER}`,
    });
    expect(body).not.toHaveProperty("rule_ref");
  });

  it("broadcasts only when targetRule is explicitly false", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: { id: 1 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const sensor = new Sensor();
    const rule: RuleState = {
      ruleId: 7,
      ruleRef: "pack.rule",
      triggerRef: "pack.trigger",
      triggerParams: {},
      enabled: true,
    };

    await sensor.emit({ value: 1 }, { rule, targetRule: false });
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body).not.toHaveProperty("trigger_instance_id");
    expect(body).not.toHaveProperty("rule_ref");
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])(
    "fails closed without a request for invalid targeted rule ID %s",
    async (ruleId) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const sensor = new Sensor();
      const rule: RuleState = {
        ruleId,
        ruleRef: "pack.rule",
        triggerRef: "pack.trigger",
        triggerParams: {},
        enabled: true,
      };

      await expect(sensor.emit({}, { rule })).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "not-an-id"])(
    "ignores invalid lifecycle rule ID %s",
    (ruleId) => {
      const sensor = new Sensor();
      sensor._handleRuleMessage({ event_type: "rule.created", rule_id: ruleId });
      expect(sensor.rules.size).toBe(0);
    },
  );

  it("emit re-reads token for each API call", async () => {
    const sensor = new Sensor();
    let currentToken = "token-1";
    const baseContext = (sensor as any).context;
    (sensor as any).context = {
      ...baseContext,
      apiUrl: "http://localhost:8080",
      getTokenState: () => ({ token: currentToken, expiresAt: null, source: "env" }),
    };

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { id: 1 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await sensor.emit({ value: 1 });
    currentToken = "token-2";
    await sensor.emit({ value: 2 });

    const firstHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe("Bearer token-1");
    expect(secondHeaders.Authorization).toBe("Bearer token-2");
  });
});

describe("PollingSensor", () => {
  it("does not poll bootstrapped rules until setup completes", async () => {
    let setupComplete = false;
    const pollCalls: boolean[] = [];

    class TestSensor extends PollingSensor {
      interval = 5;
      async setup() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        setupComplete = true;
      }
      async poll() {
        pollCalls.push(setupComplete);
        this.shutdown();
      }
    }

    const sensor = new TestSensor();
    sensor._handleRuleMessage({ event_type: "rule.created", rule_id: 1, trigger_params: {} });
    expect(pollCalls).toEqual([]);
    await sensor._runLifecycle();
    expect(pollCalls).toEqual([true]);
  });

  it("converts interval_seconds to milliseconds and validates timer delays", () => {
    class TestSensor extends PollingSensor {
      ruleInterval(params: Record<string, unknown>) {
        return this._getRuleInterval({
          ruleId: 1,
          ruleRef: "pack.rule",
          triggerRef: "pack.trigger",
          triggerParams: params,
          enabled: true,
        });
      }
    }

    const sensor = new TestSensor();
    expect(sensor.ruleInterval({ interval_seconds: 2.5 })).toBe(2500);
    expect(sensor.ruleInterval({ interval: 250 })).toBe(250);
    expect(sensor.ruleInterval({ interval_seconds: 0 })).toBe(sensor.interval);
    expect(sensor.ruleInterval({ interval: "invalid" })).toBe(sensor.interval);
    expect(sensor.ruleInterval({ interval: Number.POSITIVE_INFINITY })).toBe(sensor.interval);
  });

  it("poll called for rule", async () => {
    const pollCalls: number[] = [];

    class TestSensor extends PollingSensor {
      interval = 50;
      async poll(rule: RuleState) {
        pollCalls.push(rule.ruleId);
        if (pollCalls.length >= 3) this.shutdown();
      }
    }

    const sensor = new TestSensor();
    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 1,
      rule_ref: "pack.rule1",
      trigger_params: {},
    });
    await sensor._runLifecycle();
    expect(pollCalls.length).toBeGreaterThanOrEqual(3);
    expect(pollCalls.every((id) => id === 1)).toBe(true);
  });

  it("multiple rules poll independently", async () => {
    const polledRules = new Set<number>();

    class TestSensor extends PollingSensor {
      interval = 50;
      async poll(rule: RuleState) {
        polledRules.add(rule.ruleId);
        if (polledRules.size >= 2) this.shutdown();
      }
    }

    const sensor = new TestSensor();
    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 1,
      rule_ref: "pack.rule1",
      trigger_params: {},
    });
    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 2,
      rule_ref: "pack.rule2",
      trigger_params: {},
    });
    await sensor._runLifecycle();
    expect(polledRules.has(1)).toBe(true);
    expect(polledRules.has(2)).toBe(true);
  });
});

describe("AsyncPollingSensor", () => {
  it("async poll called", async () => {
    const pollCalls: number[] = [];

    class TestSensor extends AsyncPollingSensor {
      interval = 50;
      async poll(rule: RuleState) {
        pollCalls.push(rule.ruleId);
        if (pollCalls.length >= 3) this.shutdown();
      }
    }

    const sensor = new TestSensor();
    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 1,
      rule_ref: "pack.rule1",
      trigger_params: {},
    });
    await sensor._runLifecycle();
    expect(pollCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("async setup and cleanup called", async () => {
    const events: string[] = [];

    class TestSensor extends AsyncPollingSensor {
      interval = 50;
      async setup() { events.push("setup"); }
      async poll(_rule: RuleState) {
        events.push("poll");
        this.shutdown();
      }
      async cleanup() { events.push("cleanup"); }
    }

    const sensor = new TestSensor();
    sensor._handleRuleMessage({
      event_type: "rule.created",
      rule_id: 1,
      rule_ref: "pack.rule1",
      trigger_params: {},
    });
    await sensor._runLifecycle();
    expect(events[0]).toBe("setup");
    expect(events).toContain("poll");
    expect(events[events.length - 1]).toBe("cleanup");
  });
});
