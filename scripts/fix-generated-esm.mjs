import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/api_client/", import.meta.url));

function rewriteDirectory(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      rewriteDirectory(path);
      continue;
    }
    if (!path.endsWith(".js")) continue;

    const source = readFileSync(path, "utf8");
    const rewritten = source.replace(
      /((?:from\s+|import\s*\(\s*)['"])(\.\.?\/[^'"]+)(['"])/g,
      (match, prefix, specifier, suffix) => /\.(?:js|json|node)$/.test(specifier)
        ? match
        : `${prefix}${specifier}.js${suffix}`,
    );
    if (rewritten !== source) writeFileSync(path, rewritten);
  }
}

rewriteDirectory(root);
