import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/index.js";
import {
  createEvent,
  getKey,
  installPack,
  listWorkflowCacheIterations,
  saveWorkflowFile,
} from "../src/api_client/index.js";

type OpenApiOperation = {
  operationId?: string;
  parameters?: Array<Record<string, unknown>>;
  requestBody?: {
    content?: { "application/json"?: { schema?: Record<string, unknown> } };
    required?: boolean;
  };
  responses?: Record<string, unknown>;
};

type OpenApiSpec = {
  components: { schemas: Record<string, Record<string, unknown>> };
  paths: Record<string, Record<string, OpenApiOperation>>;
};

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = process.env.ATTUNE_OPENAPI_SPEC
  ? resolve(process.env.ATTUNE_OPENAPI_SPEC)
  : resolve(projectDir, "../attune.wiki/openapi.json");
const spec = JSON.parse(readFileSync(specPath, "utf8")) as OpenApiSpec;

function operation(path: string, method: string): OpenApiOperation {
  const value = spec.paths[path]?.[method];
  if (!value) throw new Error(`Missing OpenAPI operation: ${method.toUpperCase()} ${path}`);
  return value;
}

function schemaRef(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const ref = schema?.$ref;
  if (typeof ref !== "string") throw new Error("Expected a component schema reference");
  const name = ref.split("/").at(-1);
  if (!name || !spec.components.schemas[name]) throw new Error(`Missing schema: ${ref}`);
  return spec.components.schemas[name];
}

function generatedName(operationId: string): string {
  return operationId.replace(/_([a-z0-9])/g, (_, character: string) => character.toUpperCase());
}

function recordingClient() {
  const requests: Request[] = [];
  const client = createClient({
    baseUrl: "https://attune.test",
    fetch: async (request) => {
      requests.push(request);
      return new Response(null, { status: 204 });
    },
  });
  return { client, requests };
}

describe("generated OpenAPI client contracts", () => {
  it("matches the complete OpenAPI operation inventory", () => {
    const expected = Object.values(spec.paths)
      .flatMap((path) => Object.values(path))
      .map((value) => value.operationId)
      .filter((value): value is string => typeof value === "string")
      .map(generatedName)
      .sort();
    const sdkSource = readFileSync(resolve(projectDir, "src/api_client/sdk.gen.ts"), "utf8");
    const actual = Array.from(sdkSource.matchAll(/^export const (\w+)\s*=/gm), (match) => match[1]).sort();

    expect(new Set(expected).size).toBe(expected.length);
    expect(actual).toEqual(expected);
  });

  it("keeps key decryption explicit and serializes decrypt=true", async () => {
    const getKeyOperation = operation("/api/v1/keys/{ref}", "get");
    expect(getKeyOperation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "decrypt", in: "query", required: false }),
    ]));

    const { client, requests } = recordingClient();
    await getKey({ client, path: { ref: "deploy token" }, query: { decrypt: true } });
    expect(requests[0].url).toBe("https://attune.test/api/v1/keys/deploy%20token?decrypt=true");
  });

  it("keeps install no_registry in the request body", async () => {
    const install = operation("/api/v1/packs/install", "post");
    const requestSchema = schemaRef(install.requestBody?.content?.["application/json"]?.schema);
    expect(requestSchema.properties).toMatchObject({
      no_registry: { type: "boolean" },
    });

    const { client, requests } = recordingClient();
    await installPack({ client, body: { source: "https://example.test/pack.git", no_registry: true } });
    expect(await requests[0].json()).toEqual({
      source: "https://example.test/pack.git",
      no_registry: true,
    });
  });

  it("preserves omitted workflow visibility and an explicitly empty allow-list", async () => {
    const save = operation("/api/v1/packs/{pack_ref}/workflow-files", "post");
    const requestSchema = schemaRef(save.requestBody?.content?.["application/json"]?.schema);
    expect(requestSchema.required).not.toContain("reference_visibility");
    expect(requestSchema.required).not.toContain("reference_allowed_pack_refs");
    expect(requestSchema.properties).toMatchObject({
      reference_allowed_pack_refs: { type: ["array", "null"] },
    });

    const baseBody = {
      name: "deploy",
      label: "Deploy",
      version: "1.0.0",
      pack_ref: "core",
      definition: {},
    };
    const { client, requests } = recordingClient();
    await saveWorkflowFile({ client, path: { pack_ref: "core" }, body: baseBody });
    await saveWorkflowFile({
      client,
      path: { pack_ref: "core" },
      body: { ...baseBody, reference_allowed_pack_refs: [] },
    });

    const omittedVisibilityBody = await requests[0].json();
    expect(omittedVisibilityBody).not.toHaveProperty("reference_visibility");
    expect(omittedVisibilityBody).not.toHaveProperty("reference_allowed_pack_refs");
    expect(await requests[1].json()).toMatchObject({ reference_allowed_pack_refs: [] });
  });

  it("keeps createEvent as a required JSON-body POST", async () => {
    const create = operation("/api/v1/events", "post");
    expect(create.requestBody?.required).toBe(true);
    expect(create.responses).toHaveProperty("201");
    const requestSchema = schemaRef(create.requestBody?.content?.["application/json"]?.schema);
    expect(requestSchema.required).toContain("trigger_ref");

    const { client, requests } = recordingClient();
    await createEvent({
      client,
      body: { trigger_ref: "monitor.alert", payload: { severity: "high" } },
    });
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers.get("content-type")).toBe("application/json");
    expect(await requests[0].json()).toEqual({
      trigger_ref: "monitor.alert",
      payload: { severity: "high" },
    });
  });

  it("keeps workflow cache iteration status safe and execution-scoped", async () => {
    const list = operation("/api/v1/executions/{id}/workflow-cache-iterations", "get");
    expect(list.operationId).toBe("list_workflow_cache_iterations");
    expect(list.responses).toHaveProperty("403");
    expect(list.responses).toHaveProperty("404");
    const success = list.responses?.["200"] as {
      content: { "application/json": { schema: { properties: { data: { items: Record<string, unknown> } } } } };
    };
    expect(success.content["application/json"].schema.properties.data.items.required).toEqual(
      expect.arrayContaining(["task_name", "generation_id", "state", "scanned_count", "dispatched_count"]),
    );

    const { client, requests } = recordingClient();
    await listWorkflowCacheIterations({ client, path: { id: 42 } });
    expect(requests[0].url).toBe("https://attune.test/api/v1/executions/42/workflow-cache-iterations");
  });
});
