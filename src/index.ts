/**
 * Attune Node.js SDK — helpers for building actions and sensors.
 *
 * Quick start for actions:
 *
 *   import attune from "attune";
 *
 *   function main(params: { name: string; count?: number }) {
 *     return { greeting: `Hello, ${params.name}!`.repeat(params.count ?? 1) };
 *   }
 *
 *   attune.runAction(main);
 *
 * Quick start for sensors:
 *
 *   import { PollingSensor, runSensor, RuleState } from "attune";
 *
 *   class MySensor extends PollingSensor {
 *     interval = 5000;
 *     async poll(rule: RuleState) {
 *       this.emit({ value: 42 }, { rule });
 *     }
 *   }
 *
 *   runSensor(MySensor);
 *
 * Access execution context anywhere:
 *
 *   import { context, sensorContext } from "attune";
 *   console.log(context.executionId);      // action context
 *   console.log(sensorContext.sensorRef);  // sensor context
 */

export { runAction } from "./action.js";
export type { ActionFn, RunActionOptions } from "./action.js";

export { AttuneClient } from "./client.js";
export type { AttuneClientOptions } from "./client.js";

export { createClient } from "./api_client/client/index.js";
export type { Client, ClientOptions as ApiClientOptions } from "./api_client/client/index.js";

export {
  actionContext as context,
  actionContext,
  sensorContext,
} from "./context.js";
export type { ActionContext, SensorContext } from "./context.js";

export {
  Sensor,
  PollingSensor,
  AsyncPollingSensor,
  runSensor,
} from "./sensor.js";
export type { RuleState, EmitOptions } from "./sensor.js";
