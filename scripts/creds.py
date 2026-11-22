#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
"""Credential broker: run a command WITH a secret, without the secret reaching the transcript.

    pnpm creds <profile>[,<profile>…] -- <command> [args…]   run with the profile's vars in env
    pnpm creds --list                                          profiles, and which are stored
    pnpm creds --set <profile> [VAR…]                          store values (TTY only, no echo)
    pnpm creds --self-test                                     hermetic tests (no Keychain, no AWS)

WHY THIS EXISTS. An agent that needs a token used to get it the only ways a shell offers —
an exported variable, a dotfile, `aws secretsmanager get-secret-value` — and each of those
prints it somewhere a transcript captures (a lane once ran `bash -x` over a script and wrote
hcloud and Cloudflare tokens into a tool-result file). The broker resolves the values itself,
puts them ONLY in the child's environment (never argv, so `ps` and the command line the
harness logs never carry them), and passes the child's stdout and stderr through a redactor
that replaces every resolved value — and its base64 and URL-encoded forms, and every
well-known token shape — with ‹redacted:NAME›. `.claude/hooks/guard-secrets.sh` is the other
half: it refuses the commands that would print a secret outside the broker.

BOUNDARIES — what the redactor cannot see, stated so nobody widens trust in it by accident:
  · a value the child TRANSFORMS (hashes, reverses, hex-encodes, splits across lines) before
    printing it. The broker defends against accidents, not against a child written to leak.
  · a value the child writes to a FILE. Reading that file later is outside the broker.
  · values shorter than MIN_LEN characters are not redacted (they would mask ordinary words);
    no real credential is that short.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import threading
import urllib.parse
from pathlib import Path
from typing import IO

KEYCHAIN_SERVICE = "alethia-creds"
MIN_LEN = 8
REPO_PROFILES = Path(__file__).resolve().parent / "creds" / "profiles.json"
LOCAL_PROFILES = Path.home() / ".alethia" / "creds-profiles.json"

# Well-known token shapes, redacted even when no profile resolved them — a child may print a
# credential it fetched on its own (a `vercel env pull`, an API response echoing a key).
GENERIC_PATTERNS: list[tuple[str, re.Pattern[bytes]]] = [
    ("stripe-key", re.compile(rb"\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}")),
    ("stripe-webhook-secret", re.compile(rb"\bwhsec_[A-Za-z0-9]{10,}")),
    ("github-token", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})")),
    ("aws-access-key-id", re.compile(rb"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("anthropic-key", re.compile(rb"\bsk-ant-[A-Za-z0-9_-]{10,}")),
    ("openai-key", re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}")),
    ("slack-token", re.compile(rb"\bxox[abposr]-[A-Za-z0-9-]{10,}")),
    ("private-key", re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]


def die(msg: str, code: int = 2) -> None:
    """Print an error to stderr and exit."""
    print(f"creds: {msg}", file=sys.stderr)
    sys.exit(code)


def load_profiles() -> dict[str, dict]:
    """Repo profiles, overlaid by the machine-local file (local wins on a name clash)."""
    profiles = json.loads(REPO_PROFILES.read_text())["profiles"]
    if LOCAL_PROFILES.exists():
        try:
            profiles.update(json.loads(LOCAL_PROFILES.read_text()).get("profiles", {}))
        except (OSError, ValueError) as exc:
            die(f"{LOCAL_PROFILES} does not parse: {exc}")
    return profiles


def keychain_get(account: str) -> str | None:
    """Read one value from the login Keychain; None when it is not stored."""
    res = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        capture_output=True, text=True,
    )
    return res.stdout.rstrip("\n") if res.returncode == 0 else None


def keychain_set(account: str, value: str) -> None:
    """Store one value in the login Keychain (replacing any existing one)."""
    # The value is passed on argv of `security`, a short-lived local process; it never reaches
    # the transcript (this path only runs from a TTY the maintainer is typing into).
    res = subprocess.run(
        ["security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        die(f"could not store {account} in the Keychain (security exited {res.returncode}).")


def resolve(name: str, profile: dict) -> dict[str, str]:
    """Return {VAR: value} for one profile. Never prints a value."""
    source = profile.get("source")
    if source == "keychain":
        out: dict[str, str] = {}
        missing = []
        for var in profile.get("vars", []):
            val = keychain_get(f"{name}/{var}")
            if val is None:
                missing.append(var)
            else:
                out[var] = val
        if missing:
            die(
                f"profile '{name}' has no stored value for {', '.join(missing)}. "
                f"Ask the maintainer to run:  ! pnpm creds --set {name}"
            )
        return out
    if source == "aws-secret":
        cmd = ["aws", "secretsmanager", "get-secret-value", "--secret-id", profile["asm_path"],
               "--query", "SecretString", "--output", "text"]
        if profile.get("region"):
            cmd += ["--region", profile["region"]]
        env = dict(os.environ)
        if profile.get("aws_profile") and "AWS_PROFILE" not in env:
            env["AWS_PROFILE"] = profile["aws_profile"]
        res = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if res.returncode != 0:
            # stderr from aws never contains the secret value (the call failed before it).
            die(f"profile '{name}': aws secretsmanager failed: {res.stderr.strip()[:400]}")
        try:
            data = json.loads(res.stdout)
        except ValueError:
            die(f"profile '{name}': the secret is not a JSON object.")
        if not isinstance(data, dict):
            die(f"profile '{name}': the secret is not a JSON object.")
        keys = profile.get("keys", "*")
        wanted = data.keys() if keys == "*" else keys
        return {k: str(data[k]) for k in wanted if k in data and data[k] not in (None, "")}
    die(f"profile '{name}' has unknown source {source!r}.")
    return {}


def encoded_forms(value: str) -> list[bytes]:
    """A value and the encodings a tool commonly prints it in."""
    raw = value.encode()
    forms = {raw, base64.b64encode(raw), base64.urlsafe_b64encode(raw),
             base64.b64encode(raw).rstrip(b"="), urllib.parse.quote(value, safe="").encode()}
    # A multi-line value (a PEM) is printed line by line; mask each substantial line.
    for line in value.splitlines():
        if len(line.strip()) >= MIN_LEN:
            forms.add(line.strip().encode())
    return [f for f in forms if len(f) >= MIN_LEN]


class Redactor:
    """Replaces known secret values and generic token shapes in a byte stream."""

    def __init__(self, secrets: dict[str, str]):
        pairs: list[tuple[bytes, str]] = []
        for var, val in secrets.items():
            if len(val) < MIN_LEN:
                continue
            for form in encoded_forms(val):
                pairs.append((form, var))
        # Longest first, so a value is masked before any substring of it.
        pairs.sort(key=lambda p: len(p[0]), reverse=True)
        self.literal = pairs
        self.literal_re = (
            re.compile(b"|".join(re.escape(p[0]) for p in pairs)) if pairs else None
        )
        self.name_for = {p[0]: p[1] for p in pairs}

    def __call__(self, chunk: bytes) -> bytes:
        """Redact one chunk (a line, in practice)."""
        if self.literal_re is not None:
            chunk = self.literal_re.sub(
                lambda m: f"‹redacted:{self.name_for[m.group(0)]}›".encode(), chunk
            )
        for label, pat in GENERIC_PATTERNS:
            chunk = pat.sub(f"‹redacted:{label}›".encode(), chunk)
        return chunk


def pump(src: IO[bytes], dst: IO[bytes], redact: Redactor) -> None:
    """Copy src to dst line by line through the redactor."""
    for line in iter(src.readline, b""):
        dst.write(redact(line))
        dst.flush()
    src.close()


def run(profile_names: list[str], argv: list[str]) -> int:
    """Resolve profiles, run argv with them in env, redact its output, return its exit code."""
    profiles = load_profiles()
    secrets: dict[str, str] = {}
    for name in profile_names:
        if name not in profiles:
            die(f"no profile '{name}'. Known: {', '.join(sorted(profiles))}")
        secrets.update(resolve(name, profiles[name]))
    env = dict(os.environ)
    env.update(secrets)
    # Tracing would print every expanded variable; refuse to pass it through.
    for var in ("BASH_XTRACEFD", "SHELLOPTS", "PS4"):
        env.pop(var, None)
    redact = Redactor(secrets)
    try:
        child = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        die(f"command not found: {argv[0]}", 127)
    threads = [
        threading.Thread(target=pump, args=(child.stdout, sys.stdout.buffer, redact)),
        threading.Thread(target=pump, args=(child.stderr, sys.stderr.buffer, redact)),
    ]
    for t in threads:
        t.start()
    rc = child.wait()
    for t in threads:
        t.join()
    return rc


def cmd_list() -> None:
    """Print each profile, its source and whether its values are stored. Never a value."""
    for name, p in sorted(load_profiles().items()):
        if p.get("source") == "keychain":
            stored = [v for v in p.get("vars", []) if keychain_get(f"{name}/{v}") is not None]
            state = "stored" if len(stored) == len(p.get("vars", [])) else (
                f"missing {', '.join(v for v in p['vars'] if v not in stored)}")
        else:
            state = f"{p.get('source')} {p.get('asm_path', '')}".strip()
        print(f"{name:16} {state:40} {p.get('description', '')}")


def cmd_set(name: str, extra_vars: list[str]) -> None:
    """Store a keychain profile's values, read from the TTY without echo."""
    import getpass

    if not sys.stdin.isatty():
        die("--set reads values from a terminal only (so an agent cannot pipe one in). "
            f"The maintainer runs:  ! pnpm creds --set {name}")
    profiles = load_profiles()
    profile = profiles.get(name)
    if profile is None:
        if not extra_vars:
            die(f"no profile '{name}'. To create a local one: pnpm creds --set {name} VAR [VAR…]")
        profile = {"source": "keychain", "vars": extra_vars, "description": "local profile"}
        local = {"profiles": {}}
        if LOCAL_PROFILES.exists():
            local = json.loads(LOCAL_PROFILES.read_text())
        local.setdefault("profiles", {})[name] = profile
        LOCAL_PROFILES.parent.mkdir(parents=True, exist_ok=True)
        LOCAL_PROFILES.write_text(json.dumps(local, indent=2) + "\n")
        print(f"created local profile '{name}' in {LOCAL_PROFILES}")
    if profile.get("source") != "keychain":
        die(f"profile '{name}' is {profile.get('source')}; only keychain profiles are stored here.")
    for var in extra_vars or profile["vars"]:
        val = getpass.getpass(f"{name}/{var} (input hidden): ")
        if not val:
            print(f"  skipped {var}")
            continue
        keychain_set(f"{name}/{var}", val)
        print(f"  stored {var}")


def self_test() -> int:
    """Hermetic tests of the redactor and the run path. Exit 0 on pass."""
    fails = 0

    def check(desc: str, ok: bool) -> None:
        nonlocal fails
        if not ok:
            fails += 1
            print(f"  ✗ {desc}")

    secret = "s3cr3t-VALUE-0123456789"
    r = Redactor({"TOKEN": secret})
    check("plain value", r(f"x {secret} y\n".encode()) == "x ‹redacted:TOKEN› y\n".encode())
    check("base64 value", secret.encode() not in r(base64.b64encode(secret.encode())) and
          base64.b64encode(secret.encode()) not in r(base64.b64encode(secret.encode())))
    check("url-encoded value", urllib.parse.quote(secret, safe="").encode() not in
          r(urllib.parse.quote(secret, safe="").encode()))
    check("short value ignored", Redactor({"X": "abc"})(b"abc") == b"abc")
    # Token-shaped fixtures are assembled at run time so this file carries no literal
    # credential shape for the secret scanner (gitleaks) to flag.
    sl = b"sk_" + b"live_" + b"abcdefghijklmnop"
    gp = b"gh" + b"p_" + b"a" * 36
    ak = b"AK" + b"IA" + b"ABCDEFGHIJKLMNOP"
    check("stripe live key shape", sl not in r(b"key=" + sl))
    check("github token shape", gp not in r(gp))
    check("aws key id shape", ak not in r(ak))
    check("ordinary text untouched", r(b"hello world 42\n") == b"hello world 42\n")
    head, body = "-----BEGIN " + "PRIVATE KEY-----", "pem-body-line-for-the-redactor-test"
    pem = head + "\n" + body + "\n-----END " + "PRIVATE KEY-----"
    rp = Redactor({"PEM": pem})
    check("pem body line", body.encode() not in rp(pem.encode()))

    # The run path end to end: a child that prints its secret must not get it out.
    import io

    out = io.BytesIO()
    child = subprocess.Popen(
        [sys.executable, "-c", "import os,sys;print(os.environ['TOKEN']);"
         "print(os.environ['TOKEN'],file=sys.stderr);sys.exit(3)"],
        env={**os.environ, "TOKEN": secret}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    pump(child.stdout, out, r)
    rc = child.wait()
    check("child exit code preserved", rc == 3)
    check("child output redacted", secret.encode() not in out.getvalue()
          and b"redacted:TOKEN" in out.getvalue())

    print("✓ creds self-test passed" if fails == 0 else f"✗ creds self-test: {fails} failed")
    return 0 if fails == 0 else 1


def main(argv: list[str]) -> int:
    """CLI entry point."""
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "--self-test":
        return self_test()
    if argv[0] == "--list":
        cmd_list()
        return 0
    if argv[0] == "--set":
        if len(argv) < 2:
            die("usage: pnpm creds --set <profile> [VAR…]")
        cmd_set(argv[1], argv[2:])
        return 0
    if "--" not in argv:
        die("usage: pnpm creds <profile>[,<profile>…] -- <command> [args…]")
    sep = argv.index("--")
    names = [n for part in argv[:sep] for n in part.split(",") if n]
    cmd = argv[sep + 1:]
    if not names or not cmd:
        die("usage: pnpm creds <profile>[,<profile>…] -- <command> [args…]")
    return run(names, cmd)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
