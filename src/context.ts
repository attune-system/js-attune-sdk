/**
 * Execution context — singletons providing access to environment
 * variables and execution metadata.
 *
 * These are computed once at import time from environment variables and are
 * immutable for the lifetime of the process (which is a single action execution
 * or sensor run).
 *
 * Usage:
 *   import { context, sensorContext } from "attune";
 *   console.log(context.executionId);
 *   console.log(sensorContext.sensorRef);
 *
 * Access the generated API client from context:
 *   import { context } from "attune";
 *   import { listPacks } from "attune/api_client";
 *
 *   const response = await listPacks({ client: context.client });
 */

import { createClient, type Client } from "./api_client/client/index.js";

export interface ActionContext {
  /** The action reference (e.g., `mypack.deploy`). */
  readonly actionRef: string;
  /** The pack reference (e.g., `mypack`). */
  readonly packRef: string;
  /** The execution database ID. */
  readonly executionId: string;
  /** The Attune API base URL. */
  readonly apiUrl: string;
  /** The execution-scoped API token (if permission sets were granted). */
  readonly apiToken: string | undefined;
  /** Path to the shared artifact volume. */
  readonly artifactsDir: string | undefined;
  /** Path to the runtime environments root. */
  readonly runtimeEnvsDir: string | undefined;
  /** The rule reference (if triggered by a rule). */
  readonly ruleRef: string | undefined;
  /** The trigger reference (if triggered by an event). */
  readonly triggerRef: string | undefined;
  /** Whether an execution-scoped API token is available. */
  readonly hasApiToken: boolean;
  /**
   * Lazily constructed authenticated API client for this execution.
   *
   * Uses the execution-scoped token and API URL from the context.
   * The client instance is cached for the lifetime of the process.
   *
   * Usage:
   *   import { context } from "attune";
   *   import { listPacks } from "attune/api_client";
   *
   *   const response = await listPacks({ client: context.client });
   *
   * @throws Error if no API token is available in this execution context.
   */
  readonly client: Client;
}

export interface SensorContext {
  /** The sensor reference (e.g., `mypack.my_sensor`). */
  readonly sensorRef: string;
  /** The sensor database ID. */
  readonly sensorId: string;
  /** The Attune API base URL. */
  readonly apiUrl: string;
  /** The sensor-scoped API token. */
  readonly apiToken: string;
  /** The RabbitMQ connection URL. */
  readonly mqUrl: string;
  /** The RabbitMQ exchange name. */
  readonly mqExchange: string;
  /** The configured log level. */
  readonly logLevel: string;
  /** The pack reference derived from sensorRef. */
  readonly packRef: string;
  /** Sensor-specific config from ATTUNE_SENSOR_CONFIG_* environment variables. */
  readonly config: Record<string, string>;
  /**
   * Lazily constructed authenticated API client for this sensor.
   *
   * Uses the sensor-scoped token and API URL from the context.
   * The client instance is cached for the lifetime of the process.
   *
   * Usage:
   *   import { sensorContext } from "attune";
   *   import { listSensors } from "attune/api_client";
   *
   *   const response = await listSensors({ client: sensorContext.client });
   */
  readonly client: Client;
}

// --- Lazy client singletons ---

let _actionClient: Client | undefined;
let _sensorClient: Client | undefined;

function getActionClient(apiUrl: string, apiToken: string | undefined): Client {
  if (!_actionClient) {
    if (!apiToken) {
      throw new Error(
        "No API token available. The action must have execution permission " +
        "sets configured to receive an API token."
      );
    }
    _actionClient = createClient({
      baseUrl: apiUrl,
      headers: { Authorization: `Bearer ${apiToken}` },
    });
  }
  return _actionClient;
}

function getSensorClient(apiUrl: string, apiToken: string): Client {
  if (!_sensorClient) {
    _sensorClient = createClient({
      baseUrl: apiUrl,
      headers: { Authorization: `Bearer ${apiToken}` },
    });
  }
  return _sensorClient;
}

function buildActionContext(): ActionContext {
  const apiToken = process.env.ATTUNE_API_TOKEN || undefined;
  const apiUrl = process.env.ATTUNE_API_URL ?? "http://localhost:8080";

  return Object.freeze({
    actionRef: process.env.ATTUNE_ACTION ?? "",
    packRef: process.env.ATTUNE_PACK_REF ?? "",
    executionId: process.env.ATTUNE_EXEC_ID ?? "",
    apiUrl,
    apiToken,
    artifactsDir: process.env.ATTUNE_ARTIFACTS_DIR || undefined,
    runtimeEnvsDir: process.env.ATTUNE_RUNTIME_ENVS_DIR || undefined,
    ruleRef: process.env.ATTUNE_RULE || undefined,
    triggerRef: process.env.ATTUNE_TRIGGER || undefined,
    hasApiToken: Boolean(apiToken),
    get client(): Client {
      return getActionClient(apiUrl, apiToken);
    },
  });
}

function buildSensorContext(): SensorContext {
  const sensorRef = process.env.ATTUNE_SENSOR_REF ?? "";
  const parts = sensorRef.split(".");
  const packRef = parts.length >= 2 ? parts[0] : "";
  const apiUrl = process.env.ATTUNE_API_URL ?? "http://localhost:8080";
  const apiToken = process.env.ATTUNE_API_TOKEN ?? "";

  const prefix = "ATTUNE_SENSOR_CONFIG_";
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(prefix) && value !== undefined) {
      config[key.slice(prefix.length).toLowerCase()] = value;
    }
  }

  return Object.freeze({
    sensorRef,
    sensorId: process.env.ATTUNE_SENSOR_ID ?? "0",
    apiUrl,
    apiToken,
    mqUrl: process.env.ATTUNE_MQ_URL ?? "amqp://localhost:5672",
    mqExchange: process.env.ATTUNE_MQ_EXCHANGE ?? "attune",
    logLevel: (process.env.ATTUNE_LOG_LEVEL ?? "info").toUpperCase(),
    packRef,
    config,
    get client(): Client {
      return getSensorClient(apiUrl, apiToken);
    },
  });
}

/** Module-level action context singleton. Computed once at import time. */
export const actionContext: ActionContext = buildActionContext();

/** Module-level sensor context singleton. Computed once at import time. */
export const sensorContext: SensorContext = buildSensorContext();

// Export builders for testing
export { buildActionContext as _buildActionContext, buildSensorContext as _buildSensorContext };
