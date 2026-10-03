#!/usr/bin/env python3
"""Generate or check the shared syncd capabilities fixture used by the Android contract test.

The fixture mirrors the JSON that the desktop syncd returns from GET /v1/capabilities. It is
derived from the desktop sources (models.rs and routes/capabilities.rs), never edited by hand:

    python scripts/core_contract_fixture.py --desktop <Aethon checkout>          # regenerate
    python scripts/core_contract_fixture.py --desktop <Aethon checkout> --check  # CI gate

Runtime-only values (TLS fingerprint, mDNS name, server versions, minimum client version) are
replaced with stable placeholders because they do not describe the protocol contract.
"""
import argparse
import json
import pathlib
import re
import sys

FIXTURE = pathlib.Path(__file__).resolve().parent.parent / (
    "app/src/test/resources/epigraph/contract/syncd_capabilities.json"
)
RUNTIME_PLACEHOLDERS = {
    "minClientVersion": "0.0.0",
    "tlsCertSha256": "0" * 64,
    "mdnsServiceName": "_epigraph-sync._tcp",
    "currentServerVersion": 0,
    "minReplayableServerVersion": 0,
}


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def build(desktop: pathlib.Path) -> dict:
    syncd = desktop / "src-tauri" / "src" / "syncd"
    models = (syncd / "models.rs").read_text(encoding="utf-8")
    route = (syncd / "routes" / "capabilities.rs").read_text(encoding="utf-8")

    schema = int(re.search(r"pub const SNAPSHOT_SCHEMA_VERSION: u32 = (\d+);", models).group(1))
    types_block = re.search(r"pub const SNAPSHOT_ENTITY_TYPES: \[&str; \d+\] = \[(.*?)\];", models, re.S)
    entity_types = re.findall(r'"([^"]+)"', types_block.group(1))

    body = route[route.index("Json(CapabilitiesResponse {"):]
    fixture: dict = {"serverProtocolVersion": 1}
    scopes = re.search(r"supported_scopes: vec!\[(.*?)\]", body, re.S)
    fixture["supportedScopes"] = re.findall(r'"([^"]+)"', scopes.group(1))
    for name, value in re.findall(r"\b(supports_[a-z0-9_]+): (true|false),", body):
        fixture[camel(name)] = value == "true"
    template = re.search(r'suwayomi_proxy_path_template:\s*"([^"]+)"', body)
    fixture["suwayomiProxyPathTemplate"] = template.group(1)
    authority = re.search(r'comic_authority_mode: "([^"]+)"', body)
    if authority:
        fixture["comicAuthorityMode"] = authority.group(1)
    fixture["snapshotSchemaVersion"] = schema
    fixture["snapshotEntityTypes"] = entity_types
    fixture.update(RUNTIME_PLACEHOLDERS)
    return dict(sorted(fixture.items()))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--desktop", required=True, type=pathlib.Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    rendered = json.dumps(build(args.desktop), indent=2) + "\n"
    if args.check:
        current = FIXTURE.read_text(encoding="utf-8") if FIXTURE.exists() else ""
        if current != rendered:
            sys.stderr.write(
                "syncd capabilities changed; regenerate the fixture and update the Android "
                "contract (EpigraphCoreEntityType / CoreCapabilities) in the same change.\n"
            )
            return 1
        print("syncd capabilities fixture is up to date")
        return 0
    FIXTURE.write_text(rendered, encoding="utf-8", newline="\n")
    print(f"wrote {FIXTURE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
