/**
 * Sensor base classes — lifecycle management, rule change hooks, event emission,
 * signal handling, and polling helpers.
 *
 * Architecture:
 *
 *   Sensor (base — custom event loops)
 *   ├── PollingSensor (synchronous polling with setInterval per rule)
 *   └── AsyncPollingSensor (async polling with per-rule loops)
 *
 * Quick start — polling:
 *
 *   import { PollingSensor, runSensor } from "attune";
 *
 *   class TempSensor extends PollingSensor {
 *     interval = 5000;
 *     async poll(rule: RuleState) {
 *       const temp = readTemp(rule.triggerParams.device);
 *       if (temp > 100) this.emit({ temperature: temp }, { rule });
 *     }
 *   }
 *
 *   runSensor(TempSensor);
 */

import {
  sensorContext,
  type SensorContext,
  type SensorTokenState,
} from "./context.js";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Rule representation
// ---------------------------------------------------------------------------

export interface RuleState {
  ruleId: number;
  ruleRef: string;
  triggerRef: string;
  triggerParams: Record<string, unknown>;
  enabled: boolean;
}

type NormalizedRuleEventType = "created" | "enabled" | "disabled" | "deleted" | "updated";

// ---------------------------------------------------------------------------
// Logger (structured JSON to stderr)
// ---------------------------------------------------------------------------

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_LEVELS: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const DEFAULT_TOKEN_ROTATION_SKEW_MS = 30_000;
const PROACTIVE_ROTATION_CLOSE_CODE = 4001;
const PROACTIVE_ROTATION_REASON = "sensor token rotation";

class Logger {
  private level: number;
  private sensorRef: string;

  constructor(sensorRef: string, level: string) {
    this.sensorRef = sensorRef;
    this.level = LOG_LEVELS[level as LogLevel] ?? LOG_LEVELS.INFO;
  }

  private write(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < this.level) return;
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      logger: `attune.sensor.${this.sensorRef}`,
      message,
      sensor: this.sensorRef,
      ...extra,
    };
    process.stderr.write(JSON.stringify(entry) + "\n");
  }

  debug(message: string, extra?: Record<string, unknown>) { this.write("DEBUG", message, extra); }
  info(message: string, extra?: Record<string, unknown>) { this.write("INFO", message, extra); }
  warn(message: string, extra?: Record<string, unknown>) { this.write("WARN", message, extra); }
  error(message: string, extra?: Record<string, unknown>) { this.write("ERROR", message, extra); }
}

// ---------------------------------------------------------------------------
// Emit options
// ---------------------------------------------------------------------------

export interface EmitOptions {
  rule?: RuleState;
  triggerRef?: string;
  targetRule?: boolean;
}

// ---------------------------------------------------------------------------
// Base Sensor
// ---------------------------------------------------------------------------

export class Sensor {
  readonly context: SensorContext = sensorContext;
  readonly logger: Logger;
  protected _shutdownRequested = false;
  protected _rules: Map<number, RuleState> = new Map();

  constructor() {
    this.logger = new Logger(
      this.context.sensorRef || "unknown",
      this.context.logLevel,
    );
  }

  // ------------------------------------------------------------------
  // Properties
  // ------------------------------------------------------------------

  get isShuttingDown(): boolean {
    return this._shutdownRequested;
  }

  get rules(): Map<number, RuleState> {
    return new Map(this._rules);
  }

  get config(): Record<string, string> {
    return this.context.config;
  }

  // ------------------------------------------------------------------
  // HTTP helpers
  // ------------------------------------------------------------------

  private getCurrentTokenState(): SensorTokenState {
    if (typeof this.context.getTokenState === "function") {
      return this.context.getTokenState();
    }
    return {
      token: this.context.apiToken ?? "",
      expiresAt: null,
      source: this.context.apiToken ? "env" : "none",
    };
  }

  private getHttpHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = this.getCurrentTokenState().token;
    if (token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  // ------------------------------------------------------------------
  // Event emission
  // ------------------------------------------------------------------

  async emit(
    payload: Record<string, unknown>,
    options: EmitOptions = {},
  ): Promise<number | null> {
    const { rule, triggerRef, targetRule = false } = options;

    const resolvedTriggerRef =
      triggerRef ?? rule?.triggerRef ?? this.context.sensorRef;

    const body: Record<string, unknown> = {
      trigger_ref: resolvedTriggerRef,
      payload,
      source: this.context.sensorRef,
    };
    if (rule) {
      body.trigger_instance_id = `rule_${rule.ruleRef}`;
      if (targetRule) {
        body.rule_ref = rule.ruleRef;
      }
    }

    try {
      const resp = await fetch(`${this.context.apiUrl}/api/v1/events`, {
        method: "POST",
        headers: this.getHttpHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        this.logger.error(`Failed to emit event: HTTP ${resp.status}`);
        return null;
      }
      const data = (await resp.json()) as { data?: { id?: number } };
      const eventId = data?.data?.id ?? null;
      this.logger.debug("Event emitted", { trigger_ref: resolvedTriggerRef, event_id: eventId });
      return eventId;
    } catch (err: unknown) {
      // Retry once on connection errors
      if (err instanceof TypeError || (err as NodeJS.ErrnoException)?.code === "ECONNREFUSED") {
        this.logger.warn(`Transport error, retrying: ${err}`);
        try {
          const resp = await fetch(`${this.context.apiUrl}/api/v1/events`, {
            method: "POST",
            headers: this.getHttpHeaders(),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          });
          if (!resp.ok) {
            this.logger.error(`Failed to emit event after retry: HTTP ${resp.status}`);
            return null;
          }
          const data = (await resp.json()) as { data?: { id?: number } };
          return data?.data?.id ?? null;
        } catch (retryErr) {
          this.logger.error(`Failed to emit event after retry: ${retryErr}`);
          return null;
        }
      }
      this.logger.error(`Failed to emit event: ${err}`);
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle hooks (override in subclasses)
  // ------------------------------------------------------------------

  /** Called once before the main loop starts. Override to initialize resources. */
  async setup(): Promise<void> {}

  /** Called once during shutdown. Override to release resources. */
  async cleanup(): Promise<void> {}

  /** Main sensor loop. Override for custom event-driven sensors. */
  async run(): Promise<void> {
    while (!this._shutdownRequested) {
      await sleep(500);
    }
  }

  // ------------------------------------------------------------------
  // Rule lifecycle hooks (override in subclasses)
  // ------------------------------------------------------------------

  onRuleCreated(_rule: RuleState): void {}
  onRuleEnabled(rule: RuleState): void { this.onRuleCreated(rule); }
  onRuleDisabled(_rule: RuleState): void {}
  onRuleDeleted(rule: RuleState): void { this.onRuleDisabled(rule); }
  onRuleUpdated(rule: RuleState, _oldParams: Record<string, unknown>): void {
    this.onRuleDisabled(rule);
    this.onRuleEnabled(rule);
  }

  // ------------------------------------------------------------------
  // Rule management
  // ------------------------------------------------------------------

  _handleRuleMessage(message: Record<string, unknown>): void {
    const eventType = normalizeRuleEventType(message.event_type);
    if (!eventType) return;
    const rawRuleId = message.rule_id;
    if (rawRuleId == null) return;

    const ruleId = Number(rawRuleId);
    if (Number.isNaN(ruleId)) return;
    const ruleRef = (message.rule_ref as string) ?? `rule_${ruleId}`;
    const triggerRef = (message.trigger_ref as string) ?? (message.trigger_type as string) ?? "";
    const triggerParams = toRecord(message.trigger_params) ?? toRecord(message.config) ?? {};
    const active = typeof message.active === "boolean" ? message.active : undefined;

    if (eventType === "created" || eventType === "enabled") {
      const rule: RuleState = {
        ruleId,
        ruleRef,
        triggerRef,
        triggerParams,
        enabled: active ?? true,
      };
      const existing = this._rules.get(ruleId);
      this._rules.set(ruleId, rule);

      if (existing && JSON.stringify(existing.triggerParams) !== JSON.stringify(triggerParams)) {
        this.onRuleUpdated(rule, existing.triggerParams);
      } else if (eventType === "enabled" && existing) {
        this.onRuleEnabled(rule);
      } else {
        this.onRuleCreated(rule);
      }
    } else if (eventType === "disabled") {
      const rule = this._rules.get(ruleId);
      if (rule) {
        rule.enabled = false;
        this.onRuleDisabled(rule);
      }
    } else if (eventType === "deleted") {
      const rule = this._rules.get(ruleId);
      this._rules.delete(ruleId);
      if (rule) this.onRuleDeleted(rule);
    } else if (eventType === "updated") {
      const existing = this._rules.get(ruleId);
      if (existing) {
        const oldParams = { ...existing.triggerParams };
        existing.ruleRef = ruleRef;
        existing.triggerRef = triggerRef;
        existing.triggerParams = triggerParams;
        existing.enabled = active ?? existing.enabled;
        if (JSON.stringify(oldParams) !== JSON.stringify(triggerParams)) {
          this.onRuleUpdated(existing, oldParams);
        }
      } else {
        const rule: RuleState = {
          ruleId,
          ruleRef,
          triggerRef,
          triggerParams,
          enabled: active ?? true,
        };
        this._rules.set(ruleId, rule);
        this.onRuleCreated(rule);
      }
    }
  }

  _handleNotifierEnvelope(data: WebSocket.RawData): void {
    const message = extractRuleLifecycleMessage(data);
    if (!message) return;
    this._handleRuleMessage(message);
  }

  _getManagedTriggerFilters(): string[] {
    return [...new Set(
      [...this._rules.values()]
        .map((rule) => rule.triggerRef)
        .filter((triggerRef) => triggerRef.length > 0)
        .map((triggerRef) => `trigger_ref:${triggerRef}`),
    )];
  }

  _bootstrapRules(): void {
    const raw = process.env.ATTUNE_SENSOR_TRIGGERS ?? "[]";
    let triggers: unknown[];
    try {
      triggers = JSON.parse(raw);
    } catch {
      triggers = [];
    }
    if (!Array.isArray(triggers)) triggers = [];

    for (const item of triggers) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      const ruleId = obj.id ?? obj.rule_id;
      if (ruleId == null) continue;
      this._handleRuleMessage({
        event_type: "rule.created",
        rule_id: ruleId,
        rule_ref: obj.ref ?? obj.rule_ref ?? `rule_${ruleId}`,
        trigger_ref: obj.trigger_ref ?? "",
        trigger_params: (obj.config ?? obj.trigger_params ?? {}) as Record<string, unknown>,
      });
    }
  }

  // ------------------------------------------------------------------
  // Notifier WebSocket consumer (optional)
  // ------------------------------------------------------------------

  private _notifierConnection: WebSocket | null = null;

  async _startNotifierConsumer(): Promise<boolean> {
    const notifierWsUrl = this.context.notifierWsUrl;
    if (!notifierWsUrl) {
      this.logger.info("Notifier WebSocket URL not configured; managed rule updates disabled");
      return false;
    }

    this._notifierConsumeLoop(notifierWsUrl).catch((err) => {
      this.logger.warn(`Notifier loop exited: ${err}`);
    });
    return true;
  }

  private async _notifierConsumeLoop(notifierWsUrl: string): Promise<void> {
    while (!this._shutdownRequested) {
      try {
        await this._connectNotifier(notifierWsUrl);
      } catch (err) {
        this.logger.warn(`Notifier connection error, retrying in 5s: ${err}`);
      } finally {
        this._notifierConnection = null;
      }
      if (!this._shutdownRequested) {
        await sleep(5000);
      }
    }
  }

  private async _connectNotifier(notifierWsUrl: string): Promise<void> {
    const filters = this._getManagedTriggerFilters();
    if (filters.length === 0) {
      this.logger.info("No managed trigger refs available for notifier subscriptions");
      return;
    }

    const tokenState = this.getCurrentTokenState();
    if (!tokenState.token) {
      this.logger.warn("Notifier token unavailable; skipping connection attempt");
      return;
    }

    const rotationSkewMs = resolveTokenRotationSkewMs();

    await new Promise<void>((resolve, reject) => {
      let connected = false;
      let settled = false;
      let proactiveRotationTimer: ReturnType<typeof setTimeout> | null = null;
      const ws = new WebSocket(notifierWsUrl, {
        headers: { Authorization: `Bearer ${tokenState.token}` },
      });
      this._notifierConnection = ws;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (proactiveRotationTimer) {
          clearTimeout(proactiveRotationTimer);
          proactiveRotationTimer = null;
        }
        if (this._notifierConnection === ws) {
          this._notifierConnection = null;
        }
        if (error && !connected) {
          reject(error);
        } else {
          resolve();
        }
      };

      ws.on("open", () => {
        connected = true;
        if (tokenState.expiresAt) {
          const reconnectAt = tokenState.expiresAt.getTime() - rotationSkewMs;
          const delay = Math.max(0, reconnectAt - Date.now());
          proactiveRotationTimer = setTimeout(() => {
            if (!this._shutdownRequested && ws.readyState === WebSocket.OPEN) {
              this.logger.info("Reconnecting notifier before token expiry", {
                token_source: tokenState.source,
                expires_at: tokenState.expiresAt?.toISOString(),
              });
              ws.close(PROACTIVE_ROTATION_CLOSE_CODE, PROACTIVE_ROTATION_REASON);
            }
          }, delay);
        }

        for (const filter of filters) {
          ws.send(JSON.stringify({ type: "subscribe", filter }));
        }
        this.logger.info("Notifier connected", { filters });
        if (this._shutdownRequested) {
          ws.close();
        }
      });

      ws.on("message", (data: WebSocket.RawData) => {
        try {
          this._handleNotifierEnvelope(data);
        } catch (err) {
          this.logger.warn(`Invalid notifier message: ${err}`);
        }
      });

      ws.on("error", (err: Error) => {
        this.logger.warn(`Notifier socket error: ${err.message}`);
        if (!connected) finish(err);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        if (!this._shutdownRequested) {
          const closeReason = decodeWebSocketReason(reason);
          this.logger.warn("Notifier disconnected", {
            code,
            ...(closeReason ? { reason: closeReason } : {}),
          });
          if (code === 4401) {
            this.logger.info("Notifier requested reconnect due to token expiry");
          }
        }
        finish();
      });
    });
  }

  // ------------------------------------------------------------------
  // Signal handling
  // ------------------------------------------------------------------

  private _installSignalHandlers(): void {
    const handler = (signal: string) => {
      this.logger.info(`Received ${signal}, shutting down`);
      this._shutdownRequested = true;
    };
    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
  }

  shutdown(): void {
    this._shutdownRequested = true;
  }

  // ------------------------------------------------------------------
  // Main lifecycle
  // ------------------------------------------------------------------

  async _runLifecycle(): Promise<number> {
    this._installSignalHandlers();

    try {
      this._bootstrapRules();
      await this.setup();
      await this._startNotifierConsumer();
      this.logger.info("Sensor started", { active_rules: this._rules.size });
      await this.run();
    } catch (err) {
      this.logger.error(`Sensor error: ${err}`);
      return 1;
    } finally {
      this._shutdownRequested = true;
      this._notifierConnection?.close();
      try {
        await this.cleanup();
      } catch (err) {
        this.logger.error(`Cleanup error: ${err}`);
      }
      this.logger.info("Sensor stopped");
    }

    return 0;
  }
}

function resolveTokenRotationSkewMs(): number {
  const raw = process.env.ATTUNE_SENSOR_TOKEN_ROTATION_SKEW_SECONDS;
  if (!raw) {
    return DEFAULT_TOKEN_ROTATION_SKEW_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TOKEN_ROTATION_SKEW_MS;
  }
  return Math.floor(parsed * 1000);
}

// ---------------------------------------------------------------------------
// PollingSensor — setInterval-based per-rule polling
// ---------------------------------------------------------------------------

export class PollingSensor extends Sensor {
  /** Default polling interval in milliseconds. */
  interval = 5000;

  private _pollTimers: Map<number, ReturnType<typeof setInterval>> = new Map();

  /** Called periodically for each active rule. Override to check for events. */
  async poll(_rule: RuleState): Promise<void> {}

  protected _getRuleInterval(rule: RuleState): number {
    const params = rule.triggerParams;
    for (const key of ["interval", "interval_seconds", "poll_interval"]) {
      const val = params[key];
      if (val != null) {
        const num = Number(val);
        if (!isNaN(num)) return num;
      }
    }
    return this.interval;
  }

  private _startPollTimer(rule: RuleState): void {
    this._stopPollTimer(rule.ruleId);
    const interval = this._getRuleInterval(rule);
    const timer = setInterval(async () => {
      const currentRule = this._rules.get(rule.ruleId);
      if (!currentRule || !currentRule.enabled || this.isShuttingDown) {
        this._stopPollTimer(rule.ruleId);
        return;
      }
      try {
        await this.poll(currentRule);
      } catch (err) {
        this.logger.error(`Poll error for rule ${currentRule.ruleRef}: ${err}`);
      }
    }, interval);
    this._pollTimers.set(rule.ruleId, timer);
    // Also run immediately
    this.poll(rule).catch((err) => {
      this.logger.error(`Poll error for rule ${rule.ruleRef}: ${err}`);
    });
  }

  private _stopPollTimer(ruleId: number): void {
    const timer = this._pollTimers.get(ruleId);
    if (timer) {
      clearInterval(timer);
      this._pollTimers.delete(ruleId);
    }
  }

  onRuleCreated(rule: RuleState): void { this._startPollTimer(rule); }
  onRuleEnabled(rule: RuleState): void { this._startPollTimer(rule); }
  onRuleDisabled(rule: RuleState): void { this._stopPollTimer(rule.ruleId); }
  onRuleDeleted(rule: RuleState): void { this._stopPollTimer(rule.ruleId); }
  onRuleUpdated(rule: RuleState, _oldParams: Record<string, unknown>): void {
    this._startPollTimer(rule);
  }

  async run(): Promise<void> {
    while (!this.isShuttingDown) {
      await sleep(500);
    }
  }

  async cleanup(): Promise<void> {
    for (const ruleId of [...this._pollTimers.keys()]) {
      this._stopPollTimer(ruleId);
    }
  }
}

// ---------------------------------------------------------------------------
// AsyncPollingSensor — async loop per rule (for async/await-heavy sensors)
// ---------------------------------------------------------------------------

export class AsyncPollingSensor extends Sensor {
  /** Default polling interval in milliseconds. */
  interval = 5000;

  private _pollAbortControllers: Map<number, AbortController> = new Map();
  private _pollPromises: Map<number, Promise<void>> = new Map();
  private _running = false;

  /** Called periodically for each active rule (async). Override to check for events. */
  async poll(_rule: RuleState): Promise<void> {}

  protected _getRuleInterval(rule: RuleState): number {
    const params = rule.triggerParams;
    for (const key of ["interval", "interval_seconds", "poll_interval"]) {
      const val = params[key];
      if (val != null) {
        const num = Number(val);
        if (!isNaN(num)) return num;
      }
    }
    return this.interval;
  }

  private _startPollTask(rule: RuleState): void {
    if (!this._running) return;
    this._cancelPollTask(rule.ruleId);
    const controller = new AbortController();
    this._pollAbortControllers.set(rule.ruleId, controller);

    const promise = this._pollLoop(rule.ruleId, controller.signal);
    this._pollPromises.set(rule.ruleId, promise);
  }

  private async _pollLoop(ruleId: number, signal: AbortSignal): Promise<void> {
    while (!this.isShuttingDown && !signal.aborted) {
      const rule = this._rules.get(ruleId);
      if (!rule || !rule.enabled) break;
      try {
        await this.poll(rule);
      } catch (err) {
        if (signal.aborted) break;
        this.logger.error(`Poll error for rule ${rule.ruleRef}: ${err}`);
      }
      const interval = this._getRuleInterval(rule);
      await interruptibleSleep(interval, signal);
    }
  }

  private _cancelPollTask(ruleId: number): void {
    const controller = this._pollAbortControllers.get(ruleId);
    if (controller) {
      controller.abort();
      this._pollAbortControllers.delete(ruleId);
    }
  }

  onRuleCreated(rule: RuleState): void { this._startPollTask(rule); }
  onRuleEnabled(rule: RuleState): void { this._startPollTask(rule); }
  onRuleDisabled(rule: RuleState): void { this._cancelPollTask(rule.ruleId); }
  onRuleDeleted(rule: RuleState): void { this._cancelPollTask(rule.ruleId); }
  onRuleUpdated(rule: RuleState, _oldParams: Record<string, unknown>): void {
    this._startPollTask(rule);
  }

  async run(): Promise<void> {
    this._running = true;
    // Start poll tasks for bootstrapped rules
    for (const rule of this._rules.values()) {
      if (rule.enabled) this._startPollTask(rule);
    }

    while (!this.isShuttingDown) {
      await sleep(1000);
    }
  }

  async cleanup(): Promise<void> {
    for (const ruleId of [...this._pollAbortControllers.keys()]) {
      this._cancelPollTask(ruleId);
    }
    // Wait for all tasks to finish
    await Promise.allSettled([...this._pollPromises.values()]);
    this._pollPromises.clear();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSensor(SensorClass: new () => Sensor): Promise<void> {
  const sensor = new SensorClass();
  const code = await sensor._runLifecycle();
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function normalizeRuleEventType(eventType: unknown): NormalizedRuleEventType | null {
  if (typeof eventType !== "string") return null;
  switch (eventType) {
    case "RuleCreated":
    case "rule.created":
      return "created";
    case "RuleEnabled":
    case "rule.enabled":
      return "enabled";
    case "RuleDisabled":
    case "rule.disabled":
      return "disabled";
    case "RuleDeleted":
    case "rule.deleted":
      return "deleted";
    case "RuleUpdated":
    case "rule.updated":
      return "updated";
    default:
      return null;
  }
}

function extractRuleLifecycleMessage(data: WebSocket.RawData): Record<string, unknown> | null {
  const raw = decodeWebSocketMessage(data);
  if (!raw) return null;

  const parsed = JSON.parse(raw) as unknown;
  const envelope = toRecord(parsed);
  if (!envelope) return null;

  if (envelope.type === "welcome") return null;
  if (envelope.type === "error") {
    throw new Error(typeof envelope.message === "string" ? envelope.message : "unknown notifier error");
  }

  const payload =
    toRecord(envelope.payload) ??
    toRecord(envelope.data) ??
    envelope;

  return typeof payload.event_type === "string" ? payload : null;
}

function decodeWebSocketMessage(data: WebSocket.RawData): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return null;
}

function decodeWebSocketReason(reason: Buffer): string | null {
  const decoded = reason.toString("utf8").trim();
  return decoded.length > 0 ? decoded : null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
