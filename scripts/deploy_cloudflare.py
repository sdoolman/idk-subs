#!/usr/bin/env python3
"""
Zero-Dependency Direct Cloudflare Workers Bundle Uploader (`scripts/deploy_cloudflare.py`)

Deploys `src/index.js`, `src/subedit.js`, `src/sources.js`, and `src/translator.js`
directly to the Cloudflare Workers v4 API as an ES Module multipart bundle with
native Workers AI (`env.AI`) and environment variables from `wrangler.toml`.

Works out-of-the-box with Python 3.12 (no Node.js, npm, or Wrangler CLI required!).

Usage:
  $env:CLOUDFLARE_ACCOUNT_ID="your_account_id"
  $env:CLOUDFLARE_API_TOKEN="your_api_token"
  python scripts/deploy_cloudflare.py
"""

import json
import os
import sys
import urllib.request
import urllib.error
import uuid
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
WORKER_NAME = os.environ.get("WORKER_NAME", "idk-subs")

MODULES = [
    ("index.js", ROOT_DIR / "src" / "index.js"),
    ("subedit.js", ROOT_DIR / "src" / "subedit.js"),
    ("sources.js", ROOT_DIR / "src" / "sources.js"),
    ("translator.js", ROOT_DIR / "src" / "translator.js"),
]

DEFAULT_VARS = {
    "AI_MODEL": "@cf/google/gemma-4-26b-a4b-it",
    "BATCH_SIZE": "25",
    "MAX_CONCURRENT_BATCHES": "6",
    "SINGLE_LINE_MAX_LENGTH": "42",
    "MERGE_LINES_SHORTER_THAN": "43",
    "STRICT_SYNC_ONLY": "true",
    "OS_REST_BASE": "https://rest.opensubtitles.org",
    "OS_STREMIO_BASE": "https://opensubtitles-v3.strem.io",
    "OS_UTF8_DL_BASE": "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file",
    "OS_USER_AGENT": "trailerrs",
}


def build_multipart_body(metadata_dict, modules):
    boundary = f"----CloudflareWorkerBoundary{uuid.uuid4().hex}"
    lines = []

    # 1. Add metadata part
    lines.append(f"--{boundary}".encode("utf-8"))
    lines.append(
        b'Content-Disposition: form-data; name="metadata"; filename="metadata.json"'
    )
    lines.append(b"Content-Type: application/json")
    lines.append(b"")
    lines.append(json.dumps(metadata_dict).encode("utf-8"))

    # 2. Add ES module parts
    for mod_name, mod_path in modules:
        content = mod_path.read_bytes()
        lines.append(f"--{boundary}".encode("utf-8"))
        lines.append(
            f'Content-Disposition: form-data; name="{mod_name}"; filename="{mod_name}"'.encode(
                "utf-8"
            )
        )
        lines.append(b"Content-Type: application/javascript+module")
        lines.append(b"")
        lines.append(content)

    lines.append(f"--{boundary}--".encode("utf-8"))
    lines.append(b"")

    body = b"\r\n".join(lines)
    content_type = f"multipart/form-data; boundary={boundary}"
    return body, content_type


def cf_request(method, url, token, data=None, content_type="application/json"):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {url}: {err_body}") from e


def load_cloudflare_credentials():
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    api_token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if account_id and api_token:
        return account_id, api_token

    cfg_path = Path.home() / ".cloudflare" / "config"
    if cfg_path.exists():
        import configparser
        cp = configparser.ConfigParser()
        cp.read(cfg_path, encoding="utf-8")
        if "default" in cp:
            account_id = account_id or cp["default"].get("account_id", "").strip()
            api_token = api_token or cp["default"].get("api_token", "").strip()

    return account_id, api_token


def ensure_kv_namespace(account_id, api_token, title="idk_subs_cache"):
    list_url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/storage/kv/namespaces"
    res = cf_request("GET", list_url, api_token, content_type=None)
    for ns in res.get("result", []):
        if ns.get("title") == title:
            return ns["id"]

    create_res = cf_request(
        "POST",
        list_url,
        api_token,
        data=json.dumps({"title": title}).encode("utf-8"),
    )
    return create_res["result"]["id"]


def main():
    account_id, api_token = load_cloudflare_credentials()

    if not account_id or not api_token:
        print(
            "ERROR: Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN environment variables.",
            file=sys.stderr,
        )
        sys.exit(1)

    kv_id = None
    try:
        kv_id = ensure_kv_namespace(account_id, api_token)
        print(f"Bound Cloudflare KV namespace 'SUBS_KV' (id: {kv_id})")
    except Exception as e:
        print(f"Note: KV namespace setup skipped ({e})")

    bindings = [
        {"type": "ai", "name": "AI"},
    ]
    if kv_id:
        bindings.append({"type": "kv_namespace", "name": "SUBS_KV", "namespace_id": kv_id})
    for k, v in DEFAULT_VARS.items():
        bindings.append({"type": "plain_text", "name": k, "text": v})

    metadata = {
        "main_module": "index.js",
        "compatibility_date": "2025-02-01",
        "bindings": bindings,
    }

    body, content_type = build_multipart_body(metadata, MODULES)
    upload_url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{WORKER_NAME}"

    print(f"Uploading Worker '{WORKER_NAME}' to Cloudflare Account {account_id}...")
    res = cf_request("PUT", upload_url, api_token, data=body, content_type=content_type)
    if not res.get("success"):
        print("Upload failed:", res, file=sys.stderr)
        sys.exit(1)

    # Enable workers.dev subdomain route for the script
    subdomain_toggle_url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{WORKER_NAME}/subdomain"
    try:
        cf_request(
            "POST",
            subdomain_toggle_url,
            api_token,
            data=json.dumps({"enabled": True}).encode("utf-8"),
        )
    except Exception as e:
        print(f"Note on enabling workers.dev subdomain: {e}")

    # Fetch the account's workers.dev subdomain name
    sub_url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/subdomain"
    try:
        sub_res = cf_request("GET", sub_url, api_token, content_type=None)
        subdomain = sub_res.get("result", {}).get("subdomain")
        if subdomain:
            live_url = f"https://{WORKER_NAME}.{subdomain}.workers.dev"
            print(f"\nSUCCESS! Deployed live at:\n  Root:     {live_url}/\n  Manifest: {live_url}/manifest.json\n  Health:   {live_url}/health")
            return
    except Exception:
        pass

    print(f"\nSUCCESS! Worker '{WORKER_NAME}' deployed.")


if __name__ == "__main__":
    main()
