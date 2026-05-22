import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";

// Helper to mock stdin with given content
function mockStdin(content: string) {
  const readable = Readable.from([content]);
  Object.defineProperty(process, "stdin", { value: readable, writable: true, configurable: true });
}

describe("readParams", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads JSON from stdin", async () => {
    mockStdin('{"name": "World", "count": 3}');
    const { readParams } = await import("../src/action.js");
    const params = await readParams();
    expect(params).toEqual({ name: "World", count: 3 });
  });

  it("empty stdin returns empty dict", async () => {
    mockStdin("");
    const { readParams } = await import("../src/action.js");
    const params = await readParams();
    expect(params).toEqual({});
  });

  it("whitespace only returns empty dict", async () => {
    mockStdin("   \n  ");
    const { readParams } = await import("../src/action.js");
    const params = await readParams();
    expect(params).toEqual({});
  });
});

describe("runAction", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("runs action and outputs result", async () => {
    mockStdin('{"name": "Attune", "greeting": "Hi"}');
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as any);

    const { runAction } = await import("../src/action.js");

    await expect(
      runAction((params) => ({ message: `${params.greeting}, ${params.name}!` }))
    ).rejects.toThrow("exit");

    expect(mockExit).toHaveBeenCalledWith(0);
    const output = JSON.parse(logs[0]);
    expect(output).toEqual({ message: "Hi, Attune!" });

    vi.restoreAllMocks();
  });

  it("action returning null emits empty object", async () => {
    mockStdin("{}");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as any);

    const { runAction } = await import("../src/action.js");

    await expect(runAction(() => null)).rejects.toThrow("exit");
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(JSON.parse(logs[0])).toEqual({});

    vi.restoreAllMocks();
  });

  it("action exception produces error", async () => {
    mockStdin("{}");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(msg));
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as any);

    const { runAction } = await import("../src/action.js");

    await expect(
      runAction(() => { throw new Error("something went wrong"); })
    ).rejects.toThrow("exit");

    expect(mockExit).toHaveBeenCalledWith(1);
    const output = JSON.parse(logs[0]);
    expect(output.success).toBe(false);
    expect(output.error).toContain("something went wrong");

    vi.restoreAllMocks();
  });

  it("catchExceptions false lets errors propagate", async () => {
    mockStdin("{}");
    const { runAction } = await import("../src/action.js");

    await expect(
      runAction(() => { throw new Error("boom"); }, { catchExceptions: false })
    ).rejects.toThrow("boom");
  });
});
