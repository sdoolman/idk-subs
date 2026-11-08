#!/usr/bin/env python3
"""
GitHub Repository & CI/CD Provisioner (`scripts/publish_github.py`)

Reads credentials from:
  - `~/.github/config` (`username`, `token`)
  - `~/.cloudflare/config` (`account_id`, `api_token`)

Performs a complete Git-less GitHub deployment via the GitHub REST API:
1. Creates (or updates) the `idk-subs` repository under the user's GitHub account.
2. Encrypts and uploads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` to GitHub Actions Secrets
   using LibsodiumSealedBox (`PyNaCl`).
3. Uploads all project files (`src/*`, `test/*`, `scripts/*`, `.github/workflows/deploy.yml`,
   `wrangler.toml`, `package.json`, `README.md`, `.gitignore`) in a single atomic commit on `main`.
4. Verifies that the GitHub Actions CI/CD workflow (`Test & Deploy Cloudflare Worker`) is triggered.
"""

import base64
import configparser
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from nacl import encoding, public

ROOT_DIR = Path(__file__).resolve().parent.parent
REPO_NAME = "idk-subs"

FILES_TO_PUBLISH = [
    ".gitignore",
    "LICENSE",
    "package.json",
    "wrangler.toml",
    "README.md",
    "src/index.js",
    "src/subedit.js",
    "src/sources.js",
    "src/translator.js",
    "test/subedit.test.js",
    "scripts/deploy_cloudflare.py",
    "scripts/publish_github.py",
    ".github/workflows/deploy.yml",
]


def load_configs():
    gh_cp = configparser.ConfigParser()
    gh_cp.read(Path.home() / ".github" / "config", encoding="utf-8")
    gh_user = gh_cp["default"]["username"].strip()
    gh_token = gh_cp["default"]["token"].strip()

    cf_cp = configparser.ConfigParser()
    cf_cp.read(Path.home() / ".cloudflare" / "config", encoding="utf-8")
    cf_acc = cf_cp["default"]["account_id"].strip()
    cf_tok = cf_cp["default"]["api_token"].strip()

    return gh_user, gh_token, cf_acc, cf_tok


def gh_request(method, path, token, data=None):
    url = f"https://api.github.com{path}"
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "idk-subs-provisioner")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err_text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API {method} {path} -> HTTP {e.code}: {err_text}") from e


def encrypt_secret(public_key_b64: str, secret_value: str) -> str:
    pk = public.PublicKey(public_key_b64.encode("utf-8"), encoding.Base64Encoder())
    sealed_box = public.SealedBox(pk)
    encrypted = sealed_box.encrypt(secret_value.encode("utf-8"))
    return base64.b64encode(encrypted).decode("utf-8")


def ensure_repo(gh_user, gh_token):
    try:
        repo = gh_request("GET", f"/repos/{gh_user}/{REPO_NAME}", gh_token)
        print(f"Found existing repository: {repo['html_url']}")
        return repo
    except RuntimeError as e:
        if "HTTP 404" not in str(e):
            raise

    print(f"Creating repository '{gh_user}/{REPO_NAME}'...")
    repo = gh_request(
        "POST",
        "/user/repos",
        gh_token,
        {
            "name": REPO_NAME,
            "description": "Zero-maintenance Cloudflare Worker Stremio addon for AI-adapted Hebrew subtitles (Gemma 4 + SubtitleEdit libse)",
            "private": False,
            "auto_init": True,
        },
    )
    print(f"Created repository: {repo['html_url']}")
    time.sleep(2)
    return repo


def set_actions_secrets(gh_user, gh_token, cf_acc, cf_tok):
    pk_info = gh_request(
        "GET", f"/repos/{gh_user}/{REPO_NAME}/actions/secrets/public-key", gh_token
    )
    key_id = pk_info["key_id"]
    key_b64 = pk_info["key"]

    secrets = {
        "CLOUDFLARE_ACCOUNT_ID": cf_acc,
        "CLOUDFLARE_API_TOKEN": cf_tok,
    }
    for name, val in secrets.items():
        enc_val = encrypt_secret(key_b64, val)
        gh_request(
            "PUT",
            f"/repos/{gh_user}/{REPO_NAME}/actions/secrets/{name}",
            gh_token,
            {"encrypted_value": enc_val, "key_id": key_id},
        )
        print(f"Configured GitHub Actions secret: {name}")


def push_all_files_atomic(gh_user, gh_token, default_branch="main"):
    # Get current HEAD reference
    ref = gh_request(
        "GET", f"/repos/{gh_user}/{REPO_NAME}/git/ref/heads/{default_branch}", gh_token
    )
    latest_commit_sha = ref["object"]["sha"]
    latest_commit = gh_request(
        "GET",
        f"/repos/{gh_user}/{REPO_NAME}/git/commits/{latest_commit_sha}",
        gh_token,
    )
    base_tree_sha = latest_commit["tree"]["sha"]

    tree_items = []
    for rel_path in FILES_TO_PUBLISH:
        full_path = ROOT_DIR / rel_path
        content = full_path.read_text(encoding="utf-8")
        blob = gh_request(
            "POST",
            f"/repos/{gh_user}/{REPO_NAME}/git/blobs",
            gh_token,
            {"content": content, "encoding": "utf-8"},
        )
        tree_items.append(
            {
                "path": rel_path,
                "mode": "100644",
                "type": "blob",
                "sha": blob["sha"],
            }
        )
        print(f"Staged blob: {rel_path} ({blob['sha'][:7]})")

    new_tree = gh_request(
        "POST",
        f"/repos/{gh_user}/{REPO_NAME}/git/trees",
        gh_token,
        {"base_tree": base_tree_sha, "tree": tree_items},
    )

    new_commit = gh_request(
        "POST",
        f"/repos/{gh_user}/{REPO_NAME}/git/commits",
        gh_token,
        {
            "message": "feat: idk-subs v3.0 (Cloudflare Workers AI Gemma 4 + SubtitleEdit libse + CI/CD)",
            "tree": new_tree["sha"],
            "parents": [latest_commit_sha],
        },
    )

    gh_request(
        "PATCH",
        f"/repos/{gh_user}/{REPO_NAME}/git/refs/heads/{default_branch}",
        gh_token,
        {"sha": new_commit["sha"], "force": False},
    )
    print(f"Pushed commit {new_commit['sha'][:7]} to {default_branch}!")
    return new_commit["sha"]


def main():
    gh_user, gh_token, cf_acc, cf_tok = load_configs()
    repo = ensure_repo(gh_user, gh_token)
    default_branch = repo.get("default_branch", "main")

    set_actions_secrets(gh_user, gh_token, cf_acc, cf_tok)
    commit_sha = push_all_files_atomic(gh_user, gh_token, default_branch)

    print(f"\nRepository URL: https://github.com/{gh_user}/{REPO_NAME}")
    print(f"Actions URL:    https://github.com/{gh_user}/{REPO_NAME}/actions")


if __name__ == "__main__":
    main()
