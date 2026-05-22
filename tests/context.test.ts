import { describe, it, expect, vi, beforeEach } from "vitest";

describe("ActionContext", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads env vars", async () => {
    vi.stubEnv("ATTUNE_ACTION", "mypack.deploy");
    vi.stubEnv("ATTUNE_PACK_REF", "mypack");
    vi.stubEnv("ATTUNE_EXEC_ID", "123");
    vi.stubEnv("ATTUNE_API_URL", "http://api:8080");
    vi.stubEnv("ATTUNE_API_TOKEN", "jwt-token-here");
    vi.stubEnv("ATTUNE_ARTIFACTS_DIR", "/opt/attune/artifacts");

    const { _buildActionContext } = await import("../src/context.js");
    const ctx = _buildActionContext();

    expect(ctx.actionRef).toBe("mypack.deploy");
    expect(ctx.packRef).toBe("mypack");
    expect(ctx.executionId).toBe("123");
    expect(ctx.apiUrl).toBe("http://api:8080");
    expect(ctx.apiToken).toBe("jwt-token-here");
    expect(ctx.hasApiToken).toBe(true);
    expect(ctx.artifactsDir).toBe("/opt/attune/artifacts");

    vi.unstubAllEnvs();
  });

  it("defaults without env", async () => {
    delete process.env.ATTUNE_ACTION;
    delete process.env.ATTUNE_PACK_REF;
    delete process.env.ATTUNE_EXEC_ID;
    delete process.env.ATTUNE_API_URL;
    delete process.env.ATTUNE_API_TOKEN;
    delete process.env.ATTUNE_ARTIFACTS_DIR;

    const { _buildActionContext } = await import("../src/context.js");
    const ctx = _buildActionContext();

    expect(ctx.actionRef).toBe("");
    expect(ctx.apiUrl).toBe("http://localhost:8080");
    expect(ctx.hasApiToken).toBe(false);
    expect(ctx.artifactsDir).toBeUndefined();
  });

  it("is frozen/immutable", async () => {
    const { _buildActionContext } = await import("../src/context.js");
    const ctx = _buildActionContext();
    expect(() => { (ctx as any).actionRef = "changed"; }).toThrow();
  });
});

describe("SensorContext", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads env vars", async () => {
    vi.stubEnv("ATTUNE_SENSOR_REF", "mypack.my_sensor");
    vi.stubEnv("ATTUNE_SENSOR_ID", "7");
    vi.stubEnv("ATTUNE_MQ_URL", "amqp://rabbit:5672");

    const { _buildSensorContext } = await import("../src/context.js");
    const ctx = _buildSensorContext();

    expect(ctx.sensorRef).toBe("mypack.my_sensor");
    expect(ctx.sensorId).toBe("7");
    expect(ctx.packRef).toBe("mypack");
    expect(ctx.mqUrl).toBe("amqp://rabbit:5672");

    vi.unstubAllEnvs();
  });

  it("reads config from env", async () => {
    vi.stubEnv("ATTUNE_SENSOR_REF", "test.sensor");
    vi.stubEnv("ATTUNE_SENSOR_CONFIG_INTERVAL", "10");
    vi.stubEnv("ATTUNE_SENSOR_CONFIG_TARGET_URL", "http://example.com");

    const { _buildSensorContext } = await import("../src/context.js");
    const ctx = _buildSensorContext();

    expect(ctx.config.interval).toBe("10");
    expect(ctx.config.target_url).toBe("http://example.com");

    vi.unstubAllEnvs();
  });
});
