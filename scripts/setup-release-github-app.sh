#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# One-time setup of the GitHub App that CI uses to publish the Alethia CLI:
#   - push the Homebrew formula   → alethialabs-io/homebrew-tap
#   - push the Scoop manifest     → alethialabs-io/scoop-bucket
#   - push the read-only mirror   → alethialabs-io/alethia
#
# It uses GitHub's App Manifest flow so the App is created with exactly the right
# settings (Contents: write, no webhook) and stores its credentials as the
# TAP_APP_ID / TAP_APP_PRIVATE_KEY secrets on the monorepo — no copy/paste.
#
# Run it once (you must be a github.com org owner of alethialabs-io and logged into
# `gh`). The only manual clicks are "Create GitHub App" and, at the end, "Install"
# (pick the three repos). Re-run any time to rotate the key.
#
# Usage:  bash scripts/setup-release-github-app.sh
# Env:    ORG (default alethialabs-io) · SECRETS_REPO (default alethialabs-io/alethialabs)
#         APP_NAME (default "Alethia Labs CI"; must be globally unique on GitHub)

set -euo pipefail

ORG="${ORG:-alethialabs-io}"
SECRETS_REPO="${SECRETS_REPO:-alethialabs-io/alethialabs}"
APP_NAME="${APP_NAME:-Alethia Labs CI}"
PORT="${PORT:-8917}"

err() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m%s\033[0m\n' "$*" >&2; }

command -v gh >/dev/null 2>&1 || err "the GitHub CLI (gh) is required — https://cli.github.com"
command -v python3 >/dev/null 2>&1 || err "python3 is required"
gh auth status >/dev/null 2>&1 || err "run 'gh auth login' first"

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

info "Creating the GitHub App \"$APP_NAME\" for org '$ORG' via the manifest flow…"
info "A browser window will open — click \"Create GitHub App for $ORG\"."

# The python helper: serves the auto-submitting manifest form at '/', catches the
# redirect at '/cb', exchanges the code for the App id + private key (no auth needed),
# writes them to $OUT, and shuts down.
ORG="$ORG" APP_NAME="$APP_NAME" PORT="$PORT" OUT="$OUT" python3 - <<'PY'
import http.server, json, os, socketserver, threading, urllib.request, webbrowser, sys

ORG, APP_NAME, PORT, OUT = os.environ["ORG"], os.environ["APP_NAME"], int(os.environ["PORT"]), os.environ["OUT"]

manifest = {
    "name": APP_NAME,
    "url": "https://alethialabs.io",
    "redirect_url": f"http://localhost:{PORT}/cb",
    "public": False,
    "default_permissions": {"contents": "write", "metadata": "read"},
    "default_events": [],
}
create_url = f"https://github.com/organizations/{ORG}/settings/apps/new"
done = threading.Event()
result = {}

FORM = f"""<!doctype html><html><body onload="document.forms[0].submit()">
<p>Redirecting to GitHub to create <b>{APP_NAME}</b>…</p>
<form action="{create_url}" method="post">
<input type="hidden" name="manifest" value='{json.dumps(manifest).replace("'", "&#39;")}'>
</form></body></html>"""

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, body, code=200):
        self.send_response(code); self.send_header("Content-Type", "text/html"); self.end_headers()
        self.wfile.write(body.encode())
    def do_GET(self):
        if self.path == "/":
            self._send(FORM); return
        if self.path.startswith("/cb"):
            from urllib.parse import urlparse, parse_qs
            code = parse_qs(urlparse(self.path).query).get("code", [None])[0]
            if not code:
                self._send("<p>No code returned — did you cancel?</p>", 400); return
            try:
                req = urllib.request.Request(
                    f"https://api.github.com/app-manifests/{code}/conversions",
                    method="POST", headers={"Accept": "application/vnd.github+json", "User-Agent": "alethia-setup"})
                data = json.load(urllib.request.urlopen(req))
                result.update(data)
                open(os.path.join(OUT, "app_id"), "w").write(str(data["id"]))
                open(os.path.join(OUT, "app.pem"), "w").write(data["pem"])
                open(os.path.join(OUT, "slug"), "w").write(data.get("slug", ""))
                self._send(f"<h2>✓ Created {data.get('name','the App')}</h2>"
                           "<p>You can close this tab and return to the terminal.</p>")
            except Exception as e:
                self._send(f"<p>Exchange failed: {e}</p>", 500)
            finally:
                done.set()

with socketserver.TCPServer(("127.0.0.1", PORT), H) as httpd:
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    if not webbrowser.open(f"http://localhost:{PORT}/"):
        print(f"Open this URL manually: http://localhost:{PORT}/", file=sys.stderr)
    if not done.wait(timeout=300):
        print("timed out waiting for GitHub", file=sys.stderr); sys.exit(1)
    httpd.shutdown()
PY

[ -s "$OUT/app_id" ] && [ -s "$OUT/app.pem" ] || err "app creation did not complete"
APP_ID="$(cat "$OUT/app_id")"
SLUG="$(cat "$OUT/slug" 2>/dev/null || true)"

info "Storing credentials as secrets on $SECRETS_REPO…"
gh secret set TAP_APP_ID --repo "$SECRETS_REPO" --body "$APP_ID"
gh secret set TAP_APP_PRIVATE_KEY --repo "$SECRETS_REPO" < "$OUT/app.pem"

cat >&2 <<EOF

$(printf '\033[32m✓ App created (id %s) and TAP_APP_ID / TAP_APP_PRIVATE_KEY set on %s.\033[0m' "$APP_ID" "$SECRETS_REPO")

Last step — install the App on the three publish repos:
  https://github.com/apps/${SLUG:-<your-app>}/installations/new
  → Install on '$ORG' → Only select repositories → homebrew-tap, scoop-bucket, alethia

Then trigger it: Actions → "Mirror CLI" → Run workflow (on main), and the next
cli-v* release will publish the formula + scoop manifest.

You can now delete the old HOMEBREW_TAP_GITHUB_TOKEN PAT secret — it's unused.
EOF
