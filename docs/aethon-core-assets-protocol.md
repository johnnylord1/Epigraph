# Aethon Core asset protocol

The asset API is an additive Aethon sync protocol capability advertised as
`supportsAssets: true`. It stores immutable content-addressed blobs under the
sync daemon's per-user data directory, never under the installed application.

## Requests

All three methods use `/v1/assets/:sha256?scopeId=:scopeId`, where `sha256` is
exactly 64 hexadecimal characters. The server canonicalizes uppercase input to
lowercase. `scopeId` is mandatory and must be granted to the bearer token.
Possessing a token for another scope does not reveal whether a blob exists.

Every request also uses the existing sync protocol headers:

- `Authorization: Bearer <token>`
- `X-Aethon-Client-Version: <semver>`
- `X-Aethon-Client-Protocol-Version: 1`

`PUT` streams the body to a private staging directory, enforces the configured
size limit, compares `Content-Length` when supplied, computes SHA-256, flushes
the file, and atomically renames the completed directory into the blob store.
Only then does it publish the scope grant. A new blob returns `201 Created`; an
already valid blob returns `204 No Content`. A client must upload and prove the
complete bytes even when another scope already stored the same hash.

`HEAD` returns metadata only. `GET` returns the complete body or one byte range.
Multiple ranges are rejected with `416 Range Not Satisfiable`; the response
includes `Content-Range: bytes */<size>`. A valid range returns `206 Partial
Content` and `Content-Range: bytes <start>-<end>/<size>`.

## Response headers

Successful `PUT`, `HEAD`, and `GET` responses include:

- `ETag: "<lowercase-sha256>"`
- `X-Aethon-Asset-Sha256: <lowercase-sha256>`
- `Accept-Ranges: bytes`
- `Cache-Control: private, max-age=31536000, immutable`
- `Content-Length`, for the selected representation

`GET` and `HEAD` use `Content-Type: application/octet-stream`. Clients must
validate the ETag/hash before publishing their related library mutation.

## Storage and failure behavior

The default upload limit is 2 GiB and can be lowered or raised with the positive
integer environment variable `AETHON_SYNCD_ASSET_MAX_BYTES`. At most two uploads
are hashed and written concurrently, and each upload has a 30-minute deadline.
Interrupted, oversized, truncated, or hash-mismatched bodies never appear at the
served blob path. Unfinished staging paths are private and removed when the
request is cancelled or fails.
