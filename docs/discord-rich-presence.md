# Discord Rich Presence

Epigraph uses `tauri-plugin-drpc` with Discord Application ID `1522314876649996368`.

Portal assets:

- `epigraph_icon`: large app image for idle/navigation/activity states.
- `epigraph_logo`: transparent small overlay shown only while reading a work, under the cover/fallback cover.
- `fallback_cover`: fallback when a work cover is private, local, cached, or unavailable.
- Rich Presence invite image: `discord-assets/rich_presence_invite.png` uploaded in the Portal cover slot.

Presence payloads must pass through privacy filtering before deduplication, throttling, logging, caching, or sending. Private mode forces `Reading in Epigraph`.

Progress updates are conservative: 5 percent buckets and a 45 second minimum interval. Immediate updates are limited to app open, work/chapter changes, TTS start/stop, download start/stop, migration start/stop, and privacy changes.

Optimized covers are generated locally as 1024x1024 images and uploaded to Litterbox for a temporary public HTTPS URL. Litterbox is free, anonymous, does not require a user account, and supports `72h` expiry, but it is an external service without project-owned SLA. `EPIGRAPH_DISCORD_COVER_UPLOAD_URL` is a developer/maintainer override for testing a custom JSON upload endpoint. If upload fails, Epigraph falls back to the original public/tracker cover URL or `fallback_cover`.

The optimized cover cache expires after 70 hours, slightly before Litterbox's 72 hour maximum. Do not store titles, original cover URLs, or local paths in Discord cover cache entries.
