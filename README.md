# attune — Node.js SDK for Attune Actions & Sensors

A lightweight TypeScript package providing boilerplate for writing [Attune](https://github.com/AndroxxTraxxon/attune) actions and sensors.

## Installation

```bash
npm install attune                # core (no extra dependencies)
npm install attune amqplib        # with RabbitMQ for sensor rule lifecycle
```

## Writing Actions

Actions receive parameters as JSON on stdin and output results as JSON on stdout.
This package handles all of that:

```typescript
import { runAction } from "attune";

function main(params: { name: string; count?: number }) {
  return { greeting: `Hello, ${params.name}!`.repeat(params.count ?? 1) };
}

runAction(main);
```

Your function receives the full params object parsed from stdin JSON.

### Accessing Execution Context

The context is a module-level singleton available anywhere after import:

```typescript
import { context, runAction } from "attune";
import { AttuneClient } from "attune/client";

function main(params: { url: string; method?: string }) {
  if (context.hasApiToken) {
    const client = new AttuneClient();
    // ... use the API with the execution-scoped token
  }
  return { action: context.actionRef, exec_id: context.executionId };
}

runAction(main);
```

### Using the API Client

```typescript
import { AttuneClient } from "attune/client";

const client = new AttuneClient(); // reads ATTUNE_API_URL and ATTUNE_API_TOKEN from env
const data = await client.get("/api/v1/artifacts", { params: { execution: "42" } });
await client.post("/api/v1/artifacts/1/versions/file", { json: { created_by: "my_action" } });
```

## Writing Sensors

Sensors are long-running processes that emit events. The SDK provides rule
lifecycle management, signal handling (SIGINT/SIGTERM), and MQ integration
out of the box.

The sensor context is a module-level singleton, accessible anywhere:

```typescript
import { sensorContext } from "attune";

console.log(sensorContext.sensorRef);
console.log(sensorContext.apiUrl);
console.log(sensorContext.config); // ATTUNE_SENSOR_CONFIG_* vars
```

### Polling Sensor (`PollingSensor`)

One interval timer per active rule:

```typescript
import { PollingSensor, runSensor, RuleState } from "attune";

class TemperatureSensor extends PollingSensor {
  interval = 5000; // ms

  async poll(rule: RuleState) {
    const device = (rule.triggerParams.device as string) ?? "/dev/temp0";
    const temp = readTemperature(device);
    if (temp > 100) {
      this.emit({ temperature: temp, alert: true }, { rule });
    }
  }
}

runSensor(TemperatureSensor);
```

### Async Polling (`AsyncPollingSensor`)

One async loop per active rule (ideal for I/O-bound checks):

```typescript
import { AsyncPollingSensor, runSensor, RuleState } from "attune";

class ApiSensor extends AsyncPollingSensor {
  interval = 10000; // ms

  async poll(rule: RuleState) {
    const url = rule.triggerParams.url as string;
    const resp = await fetch(url);
    if (resp.status >= 500) {
      this.emit({ url, status: resp.status }, { rule });
    }
  }
}

runSensor(ApiSensor);
```

### Custom Event Loops (`Sensor` base class)

For non-polling sensors, override `run()`:

```typescript
import { Sensor, runSensor } from "attune";
import { watch } from "fs";

class FileWatchSensor extends Sensor {
  async run() {
    const path = this.config.watch_path ?? "/var/log/app.log";
    const watcher = watch(path, () => {
      this.emit({ path, event: "change" });
    });
    while (!this.isShuttingDown) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    watcher.close();
  }
}

runSensor(FileWatchSensor);
```

### Rule Lifecycle Hooks

All sensor classes support rule lifecycle hooks that fire when the platform
creates, enables, disables, deletes, or updates a rule:

```typescript
class StatefulSensor extends PollingSensor {
  onRuleCreated(rule: RuleState) {
    this.logger.info(`Rule created: ${rule.ruleRef}`);
  }

  onRuleEnabled(rule: RuleState) {
    // Previously disabled rule re-enabled
  }

  onRuleDisabled(rule: RuleState) {
    // Rule disabled — pause per-rule work
  }

  onRuleDeleted(rule: RuleState) {
    // Rule permanently removed — free resources
  }

  onRuleUpdated(rule: RuleState, oldParams: Record<string, unknown>) {
    this.logger.info(`Rule updated: ${JSON.stringify(oldParams)} → ${JSON.stringify(rule.triggerParams)}`);
  }
}
```

## Environment Variables

### Actions

| Variable | Description |
|----------|-------------|
| `ATTUNE_ACTION` | Action reference (e.g., `mypack.deploy`) |
| `ATTUNE_PACK_REF` | Pack reference |
| `ATTUNE_EXEC_ID` | Execution database ID |
| `ATTUNE_API_URL` | API base URL |
| `ATTUNE_API_TOKEN` | Execution-scoped API token (optional) |
| `ATTUNE_ARTIFACTS_DIR` | Shared artifact volume path |
| `ATTUNE_RULE` | Rule reference (if rule-triggered) |
| `ATTUNE_TRIGGER` | Trigger reference (if event-triggered) |

### Sensors

| Variable | Description |
|----------|-------------|
| `ATTUNE_SENSOR_REF` | Sensor reference |
| `ATTUNE_SENSOR_ID` | Sensor database ID |
| `ATTUNE_API_URL` | API base URL |
| `ATTUNE_API_TOKEN` | Sensor-scoped API token |
| `ATTUNE_MQ_URL` | RabbitMQ connection URL |
| `ATTUNE_MQ_EXCHANGE` | RabbitMQ exchange name |
| `ATTUNE_LOG_LEVEL` | Log verbosity |

## Development

```bash
cd packs.external/node-attune
npm install
npm run build
npm test
```
