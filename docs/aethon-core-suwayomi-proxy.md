# Aethon Core Suwayomi proxy contract

The Core exposes an authenticated HTTP proxy for the Aethon-owned Suwayomi
instance associated with the paired profile. Clients must never discover or
submit an upstream URL.

## Capability negotiation

`GET /v1/capabilities` includes these additive fields:

```json
{
  "supportedScopes": [
    "books:global",
    "novels:profile:<paired-profile>",
    "comics:profile:<paired-profile>"
  ],
  "supportsSuwayomiProxy": true,
  "supportsSuwayomiWebSocketProxy": false,
  "suwayomiProxyPathTemplate": "/v1/suwayomi/{path}?scopeId=comics%3Aprofile%3A{pairedProfile}"
}
```

WebSocket tunnelling is deliberately not part of this version. Mobile clients
must keep subscription-based features disabled or use normal HTTP refresh while
`supportsSuwayomiWebSocketProxy` is `false`.

## HTTP endpoint

The endpoint is:

```text
/v1/suwayomi/{suwayomiPath}?scopeId=comics%3Aprofile%3A{pairedProfile}
```

It requires the normal Core headers and bearer token:

```text
Authorization: Bearer {coreToken}
X-Aethon-Client-Version: {semver}
X-Aethon-Client-Protocol-Version: {protocol}
```

The required `scopeId` must be exactly
`comics:profile:{profileIdFromToken}` and must be granted to that token. The Core
removes `scopeId` before forwarding all other query parameters to Suwayomi.

Supported methods:

- `POST /v1/suwayomi/api/graphql`: JSON GraphQL, maximum request body 2 MiB.
- `GET /v1/suwayomi/{path}`: GraphQL GET, cover, page and download responses.
- `HEAD /v1/suwayomi/{path}`: metadata and range capability probes.

GET and HEAD forward only `Accept`, `Accept-Language`, `Range`, `If-Range`,
`If-None-Match`, and `If-Modified-Since`. POST additionally forwards
`Content-Type`. The Core bearer token, cookies, `Host`, forwarding headers and
hop-by-hop headers are never sent upstream.

Responses are streamed rather than collected in memory. The safe response
header allowlist is `Content-Type`, `Content-Length`, `Content-Range`,
`Content-Disposition`, `Content-Encoding`, `Accept-Ranges`, `Cache-Control`,
`ETag`, `Last-Modified`, `Expires`, and `Vary`. The proxy adds
`X-Content-Type-Options: nosniff`.

## Upstream trust boundary

For every request the Core selects the running owner record whose `profileKey`
matches the authenticated token. The owner record is accepted only when:

- its root directory is the expected Aethon profile root;
- its Java PID is alive and contains the exact Suwayomi root-dir JVM flag;
- its URL is HTTP(S) loopback with the recorded port;
- it contains no credentials, path prefix, query, or fragment.

`localhost` is normalized to the literal `127.0.0.1`, environment HTTP proxies
are disabled, and redirects are never followed. This prevents a client, owner
file path, DNS override, proxy environment variable, or redirect response from
turning the Core into an SSRF relay.

## Stable proxy errors

All errors use the normal Core `{ "error": { ... } }` envelope.

| Status | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Invalid/duplicate scope query or unsafe path |
| 401 | `UNAUTHORIZED` | Missing, invalid, expired, or revoked Core token |
| 403 | `SUWAYOMI_PROXY_SCOPE_FORBIDDEN` | Token/profile does not own the requested comics scope |
| 405 | `SUWAYOMI_PROXY_POST_NOT_ALLOWED` | POST attempted outside `/api/graphql` |
| 413 | `SUWAYOMI_PROXY_BODY_TOO_LARGE` | GraphQL body exceeds 2 MiB |
| 415 | `SUWAYOMI_PROXY_CONTENT_TYPE_REQUIRED` | GraphQL body is not `application/json` |
| 502 | `SUWAYOMI_UPSTREAM_REDIRECT_BLOCKED` | Suwayomi returned a redirect |
| 503 | `SUWAYOMI_UPSTREAM_UNAVAILABLE` | No validated owner or the local server is unreachable |

`SUWAYOMI_UPSTREAM_UNAVAILABLE` and redirect failures are marked retryable.
New pairing and local-authority tokens include the comics scope. On startup the
Core idempotently grants the matching comics scope to active tokens created by
older versions; revoked tokens remain revoked.
