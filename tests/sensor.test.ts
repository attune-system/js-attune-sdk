import { describe, it, expect, vi, beforeEach } from "vitest";
import { Sensor, PollingSensor, AsyncPollingSensor } from "../src/sensor.js";
import type { RuleState } from "../src/sensor.js";

describe("RuleState", () => {
  it("basic construction via _handleRuleMessage", () => {
    const sensor = new Sensor();
    sensor._handleRuleMessage({
      event_type: "RuleCreated",
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
      event_type: "RuleCreated",
      rule_id: 10,
      rule_ref: "pack.rule",
      trigger_params: { interval: 5 },
    });
    expect(events).toContainEqual(["created", 10]);

    // Update params
    sensor._handleRuleMessage({
      event_type: "RuleCreated",
      rule_id: 10,
      rule_ref: "pack.rule",
      trigger_params: { interval: 10 },
    });
    expect(events).toContainEqual(["updated", 10, { interval: 5 }]);

    // Disable
    sensor._handleRuleMessage({ event_type: "RuleDisabled", rule_id: 10 });
    expect(events).toContainEqual(["disabled", 10]);

    // Delete
    sensor._handleRuleMessage({ event_type: "RuleDeleted", rule_id: 10 });
    expect(events).toContainEqual(["deleted", 10]);
  });
});

describe("PollingSensor", () => {
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
      event_type: "RuleCreated",
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
      event_type: "RuleCreated",
      rule_id: 1,
      rule_ref: "pack.rule1",
      trigger_params: {},
    });
    sensor._handleRuleMessage({
      event_type: "RuleCreated",
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
      event_type: "RuleCreated",
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
      event_type: "RuleCreated",
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
