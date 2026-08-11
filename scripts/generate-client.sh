#!/bin/bash
# Regenerate the OpenAPI client from the Attune API spec.
#
# Usage:
#   ./scripts/generate-client.sh                     # uses running API at localhost:8080
#   ./scripts/generate-client.sh /path/to/spec.json  # uses a local spec file
#   ./scripts/generate-client.sh --check /path/to/spec.json
#   ATTUNE_API_URL=http://host:8080 ./scripts/generate-client.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$PROJECT_DIR/src/api_client"
GENERATOR="$PROJECT_DIR/node_modules/.bin/openapi-ts"
CHECK=false

if [ "${1:-}" = "--check" ]; then
    CHECK=true
    shift
fi

if [ "$#" -gt 1 ]; then
    echo "Usage: $0 [--check] [openapi.json]" >&2
    exit 2
fi

if [ ! -x "$GENERATOR" ]; then
    echo "ERROR: Generator is not installed. Run npm install first." >&2
    exit 1
fi

TEMP_DIR="$(mktemp -d "$PROJECT_DIR/.generate-client.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT
STAGED_OUTPUT="$TEMP_DIR/api_client"

if [ "$#" -eq 1 ]; then
    if [ ! -f "$1" ]; then
        echo "ERROR: OpenAPI spec does not exist: $1" >&2
        exit 1
    fi
    SPEC_PATH="$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$1")"
    echo "Using local spec: $SPEC_PATH"
else
    API_URL="${ATTUNE_API_URL:-http://localhost:8080}"
    SPEC_PATH="$TEMP_DIR/openapi.json"
    echo "Downloading spec from $API_URL/api-spec/openapi.json ..."
    if ! curl -sf "$API_URL/api-spec/openapi.json" -o "$SPEC_PATH"; then
        echo "ERROR: Could not download OpenAPI spec. Is the API running?" >&2
        exit 1
    fi
fi

# Validate JSON
if ! node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$SPEC_PATH" 2>/dev/null; then
    echo "ERROR: Invalid JSON in spec file" >&2
    exit 1
fi

cd "$PROJECT_DIR"
"$GENERATOR" \
    -i "$SPEC_PATH" \
    -o "$STAGED_OUTPUT" \
    -p @hey-api/typescript @hey-api/sdk

if [ "$CHECK" = true ]; then
    if ! diff -ru "$OUTPUT_DIR" "$STAGED_OUTPUT"; then
        echo "ERROR: Generated client is not current with $SPEC_PATH" >&2
        exit 1
    fi
    echo "Generated client is current with $SPEC_PATH"
    exit 0
fi

BACKUP_DIR="$TEMP_DIR/api_client.previous"
if [ -d "$OUTPUT_DIR" ]; then
    mv "$OUTPUT_DIR" "$BACKUP_DIR"
fi
if ! mv "$STAGED_OUTPUT" "$OUTPUT_DIR"; then
    if [ -d "$BACKUP_DIR" ]; then
        mv "$BACKUP_DIR" "$OUTPUT_DIR"
    fi
    exit 1
fi
rm -rf "$BACKUP_DIR"

echo "Done. Generated client at $OUTPUT_DIR"
