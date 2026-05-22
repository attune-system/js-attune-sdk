/**
 * Action runner — handles stdin parameter parsing, output formatting, and error handling.
 *
 * Usage:
 *   import { runAction } from "attune";
 *
 *   function main(params: { name: string; count?: number }) {
 *     return { greeting: `Hello, ${params.name}!`.repeat(params.count ?? 1) };
 *   }
 *
 *   runAction(main);
 *
 * Exit codes:
 * - 0: success (result is written to stdout as JSON)
 * - 1: failure (error details written to stdout as JSON with `success: false`)
 */

export type ActionFn = (params: Record<string, unknown>) => unknown | Promise<unknown>;

/** Read action parameters from stdin (JSON format). */
export async function readParams(): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf-8"));
  }
  const raw = chunks.join("").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

/** Write a JSON result to stdout. */
export function emitResult(payload: unknown): void {
  console.log(JSON.stringify(payload));
}

/** Write a JSON error to stdout. */
export function emitError(message: string, details?: unknown): void {
  const payload: Record<string, unknown> = { success: false, error: message };
  if (details !== undefined) {
    payload.details = details;
  }
  console.log(JSON.stringify(payload));
}

export interface RunActionOptions {
  /** If true (default), uncaught exceptions are caught and reported as JSON errors. */
  catchExceptions?: boolean;
}

/**
 * Run an action entrypoint with automatic parameter parsing and output handling.
 *
 * The entrypoint function receives the full params object parsed from stdin JSON.
 */
export async function runAction(
  entrypoint: ActionFn,
  options: RunActionOptions = {},
): Promise<void> {
  const { catchExceptions = true } = options;

  try {
    const params = await readParams();
    const result = await entrypoint(params);
    emitResult(result ?? {});
    process.exit(0);
  } catch (err: unknown) {
    if (!catchExceptions) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const details = err instanceof Error && process.stderr.isTTY ? err.stack : undefined;
    emitError(message, details);
    process.exit(1);
  }
}
