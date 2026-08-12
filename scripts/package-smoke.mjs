import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "attune-sdk-package-"));

try {
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", tempDir],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const packResult = JSON.parse(output);
  const result = Array.isArray(packResult)
    ? packResult[0]
    : packResult.filename
      ? packResult
      : Object.values(packResult)[0];
  const { filename } = result;
  execFileSync("npm", ["install", "--ignore-scripts", join(tempDir, filename)], {
    cwd: tempDir,
    stdio: "inherit",
  });
  const packageJson = JSON.parse(readFileSync(join(tempDir, "node_modules", "attune-sdk", "package.json"), "utf8"));
  if (packageJson.version !== "0.3.0") {
    throw new Error(`packed SDK version is ${packageJson.version}, expected 0.3.0`);
  }
  const entrypoint = join(tempDir, "node_modules", "attune-sdk", packageJson.exports["."].import);
  const sdk = await import(pathToFileURL(entrypoint).href);
  if (typeof sdk.Sensor !== "function" || typeof sdk.runAction !== "function") {
    throw new Error("packed SDK exports are incomplete");
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
