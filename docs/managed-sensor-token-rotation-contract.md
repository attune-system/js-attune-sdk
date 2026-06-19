# Managed Sensor Token Rotation Contract (Python / JS / Java SDKs)

This contract defines how managed sensor auth token rotation works across Attune SDKs.

## 1) Security model (normative)

- **Rotation is runtime/platform driven**.
- SDKs **must not** implement self-refresh flows that depend on using an expired token.
- SDKs consume externally rotated state and reconnect/retry with the latest state.

## 2) Token state sources and precedence

### Canonical source (all SDKs)
1. `ATTUNE_SENSOR_TOKEN_STATE_PATH` JSON file (runtime-managed, read on demand)
2. Fallback token env (`ATTUNE_API_TOKEN` + optional expiry metadata)

### SDK-specific extras
- **JavaScript only** also accepts inline JSON from `ATTUNE_SENSOR_TOKEN_STATE`.

### Effective precedence by SDK

| SDK | Source order |
|---|---|
| Python | `ATTUNE_SENSOR_TOKEN_STATE_PATH` → `ATTUNE_API_TOKEN` (+ `ATTUNE_API_TOKEN_EXPIRES_AT` / `ATTUNE_SENSOR_TOKEN_EXPIRES_AT`) |
| JavaScript | `ATTUNE_SENSOR_TOKEN_STATE_PATH` → `ATTUNE_SENSOR_TOKEN_STATE` → `ATTUNE_API_TOKEN` (+ `ATTUNE_API_TOKEN_EXPIRES_AT`) → last known valid state |
| Java | `ATTUNE_SENSOR_TOKEN_STATE_PATH` → startup fallback (`ATTUNE_API_TOKEN` + optional `ATTUNE_API_TOKEN_EXPIRES_AT`) |

> For cross-SDK portability, platform/runtime code should always provide the file source.

## 3) Token state JSON shape

### Canonical shape (recommended)

```json
{
  "token": "eyJ...",
  "expires_at": "2026-12-31T00:00:00Z"
}
```

### Compatibility aliases

- Token aliases:
  - All SDKs: `api_token`
  - JavaScript also accepts: `access_token`
- Expiry aliases:
  - All SDKs: `token_expires_at`
  - JavaScript also accepts: `expiresAt`, `tokenExpiresAt`, `exp`, `expiry`, `expires_in`, `expiresIn`

## 4) Expiry metadata expectations

- `expires_at` should be RFC3339/ISO-8601 UTC (for example `2026-12-31T00:00:00Z`).
- Supplying expiry metadata is strongly recommended so reconnect logic can rotate before server-side token expiry.
- If expiry metadata is missing, SDKs continue using token value rotation but cannot pre-schedule expiry-based reconnects.

## 5) Notifier reconnect behavior

- All SDKs reconnect notifier WebSocket connections in a loop and re-resolve token state on new connects.
- If the notifier closes a connection due to expiry (for example close code `4401`), reconnect must use latest rotated token state.

### Proactive reconnect differences

- **Python**: reconnects when token changes or when token is expiring within `ATTUNE_SENSOR_TOKEN_RECONNECT_WINDOW_SECONDS` (default `30`).
- **JavaScript**: reconnects before expiry using `ATTUNE_SENSOR_TOKEN_ROTATION_SKEW_SECONDS` (default `30`), then reconnects with latest token.
- **Java**: no proactive expiry timer today; reconnect loop still re-reads current token state on each connection attempt.

## 6) Backward-compat and local-dev fallback

- If no token-state file is configured, SDKs can run with `ATTUNE_API_TOKEN` for local development.
- If token-state file reads fail:
  - Python/Java: use fallback token when available, otherwise fail with a clear token-source error.
  - JavaScript: falls back to inline/env/last-known state.

## 7) Safe failure semantics

- No SDK should attempt self-refresh with expired credentials.
- Missing/invalid token state must result in explicit auth failure behavior (clear errors and/or reconnect retries), not silent token fabrication.
- Sensor authors should always read token state through SDK accessors (`current_api_token` / `getApiToken()` / `apiToken()`) instead of caching startup token values.

## 8) Runtime/platform writer requirements

Runtime/platform code that rotates managed sensor tokens should:

1. Keep `ATTUNE_SENSOR_TOKEN_STATE_PATH` stable.
2. Write valid JSON objects with at least `token` (and preferably `expires_at`).
3. Use atomic file replacement semantics to avoid partial-read JSON corruption.
4. Rotate before expiry with enough lead time for reconnect windows (~30s default across SDKs).

## 9) Conformance test coverage (current)

- **Python SDK**
  - `tests/test_context.py`
  - `tests/test_sensor.py`
- **JavaScript SDK**
  - `tests/context.test.ts`
  - `tests/sensor.test.ts`
  - `tests/sensor-notifier-token.test.ts`
- **Java SDK**
  - `src/test/java/io/attune/AttuneClientTest.java`
  - `src/test/java/io/attune/SensorContextTest.java`
  - `src/test/java/io/attune/FileSensorTokenProviderTest.java`
  - `src/test/java/io/attune/SensorTest.java`

