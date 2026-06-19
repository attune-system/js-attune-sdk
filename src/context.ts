/**
 * Execution context — singletons providing access to environment variables and
 * execution metadata.
 *
 * Action fields are computed once at import time. Sensor token access is
 * intentionally mutable and can be re-read from runtime-provided token state
 * sources so managed sensors can pick up external token rotation.
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

import fs from "node:fs";
import { createClient, type Client } from "./api_client/client/index.js";

export type SensorTokenSource = "none" | "env" | "state_env" | "state_file";

export interface SensorTokenState {
  /** The current token to use for API and notifier auth. */
  readonly token: string;
  /** Token expiry when provided by the runtime; null when unavailable. */
  readonly expiresAt: Date | null;
  /** Where this token state was resolved from. */
  readonly source: SensorTokenSource;
}

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
  /** Initial sensor-scoped API token snapshot at context creation time. */
  readonly apiToken: string;
  /** The notifier WebSocket URL for managed-sensor lifecycle updates. */
  readonly notifierWsUrl: string | undefined;
  /** The configured log level. */
  readonly logLevel: string;
  /** The pack reference derived from sensorRef. */
  readonly packRef: string;
  /** Sensor-specific config from ATTUNE_SENSOR_CONFIG_* environment variables. */
  readonly config: Record<string, string>;
  /** Optional JSON token state file path for managed-sensor token rotation. */
  readonly tokenStatePath: string | undefined;
  /**
   * Returns the latest sensor API token, re-reading rotation state when
   * available.
   */
  readonly getApiToken: () => string;
  /**
   * Returns the latest token plus source/expiry metadata.
   */
  readonly getTokenState: () => SensorTokenState;
  /**
   * Lazily constructed authenticated API client for this sensor.
   *
   * Uses the sensor token accessor so each request sees rotated credentials.
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

function getSensorClient(apiUrl: string, tokenProvider: () => string): Client {
  if (!_sensorClient) {
    _sensorClient = createClient({
      baseUrl: apiUrl,
      auth: () => tokenProvider() || undefined,
    });
  }
  return _sensorClient;
}

const NUMERIC_STRING_RE = /^\d+$/;

function parseExpiresAt(value: unknown): Date | null {
  if (value == null || value === "") {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (NUMERIC_STRING_RE.test(trimmed)) {
      return parseExpiresAt(Number(trimmed));
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function parseExpiresInSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (NUMERIC_STRING_RE.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

function parseTokenStateObject(
  payload: Record<string, unknown>,
  source: SensorTokenSource,
): SensorTokenState | null {
  const tokenRaw = payload.token ?? payload.api_token ?? payload.access_token;
  if (typeof tokenRaw !== "string") {
    return null;
  }
  const token = tokenRaw.trim();
  if (token.length === 0) {
    return null;
  }

  let expiresAt = parseExpiresAt(
    payload.expires_at ??
      payload.expiresAt ??
      payload.token_expires_at ??
      payload.tokenExpiresAt ??
      payload.exp ??
      payload.expiry,
  );

  if (!expiresAt) {
    const expiresIn = parseExpiresInSeconds(payload.expires_in ?? payload.expiresIn);
    if (expiresIn != null) {
      expiresAt = new Date(Date.now() + expiresIn * 1000);
    }
  }

  return { token, expiresAt, source };
}

function parseTokenStateJson(raw: string, source: SensorTokenSource): SensorTokenState | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parseTokenStateObject(parsed as Record<string, unknown>, source);
  } catch {
    return null;
  }
}

function readTokenStateFromFile(path: string): SensorTokenState | null {
  try {
    const raw = fs.readFileSync(path, "utf8");
    return parseTokenStateJson(raw, "state_file");
  } catch {
    return null;
  }
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
  const tokenStatePath = process.env.ATTUNE_SENSOR_TOKEN_STATE_PATH || undefined;
  const tokenStateFromEnv = process.env.ATTUNE_SENSOR_TOKEN_STATE || undefined;
  let lastKnownState: SensorTokenState = {
    token: apiToken,
    expiresAt: parseExpiresAt(process.env.ATTUNE_API_TOKEN_EXPIRES_AT),
    source: apiToken ? "env" : "none",
  };

  const getTokenState = (): SensorTokenState => {
    if (tokenStatePath) {
      const stateFromFile = readTokenStateFromFile(tokenStatePath);
      if (stateFromFile) {
        lastKnownState = stateFromFile;
        return stateFromFile;
      }
    }

    const inlineStateRaw = process.env.ATTUNE_SENSOR_TOKEN_STATE ?? tokenStateFromEnv;
    if (inlineStateRaw) {
      const stateFromEnv = parseTokenStateJson(inlineStateRaw, "state_env");
      if (stateFromEnv) {
        lastKnownState = stateFromEnv;
        return stateFromEnv;
      }
    }

    const envToken = process.env.ATTUNE_API_TOKEN ?? "";
    if (envToken.length > 0) {
      lastKnownState = {
        token: envToken,
        expiresAt: parseExpiresAt(process.env.ATTUNE_API_TOKEN_EXPIRES_AT),
        source: "env",
      };
      return lastKnownState;
    }

    return lastKnownState;
  };

  const getApiToken = (): string => getTokenState().token;

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
    tokenStatePath,
    notifierWsUrl: process.env.ATTUNE_NOTIFIER_WS_URL || undefined,
    logLevel: (process.env.ATTUNE_LOG_LEVEL ?? "info").toUpperCase(),
    packRef,
    config,
    getApiToken,
    getTokenState,
    get client(): Client {
      return getSensorClient(apiUrl, getApiToken);
    },
  });
}

/** Module-level action context singleton. Computed once at import time. */
export const actionContext: ActionContext = buildActionContext();

/** Module-level sensor context singleton. Computed once at import time. */
export const sensorContext: SensorContext = buildSensorContext();

// Export builders for testing
export { buildActionContext as _buildActionContext, buildSensorContext as _buildSensorContext };
