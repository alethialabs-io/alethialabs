#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
"""Assert the declared required-vault-key list matches the deploy's own assertions.

`deploy/prod/required-vault-keys.txt` is the single source of truth for what the production
deploy refuses to run without. `.github/workflows/deploy-console.yml` separately gates on those
keys inline. Two places, so they can drift — and a list that has drifted is worse than no list,
because it looks authoritative.

This compares them and fails on any difference in EITHER direction:

  * declared but not asserted -> the list promises a gate that does not exist;
  * asserted but not declared -> a new gate was added without recording it, which is exactly how
    #2375 took production down for two weeks.

Run with no arguments to check; `--print` to list the parsed assertions.

WHY PYTHON AND NOT AWK: the mapping needs a second regex over the same file, and the 3-argument
`match()` that makes this pleasant in awk is a GNU extension. ubuntu-latest ships mawk, where that
form parses NOTHING — and nothing would make the comparison vacuously pass, which is the failure
mode this check exists to prevent.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIST = ROOT / "deploy/prod/required-vault-keys.txt"
WORKFLOW = ROOT / ".github/workflows/deploy-console.yml"


def declared() -> set[str]:
    """Keys listed in deploy/prod/required-vault-keys.txt (comments and blanks ignored)."""
    out = set()
    for line in LIST.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.add(line)
    return out


def asserted() -> set[str]:
    """Vault keys the deploy workflow hard-gates on.

    A gate is `X="$(val KEY)"` plus, somewhere in the same file, `[ -n "$X" ] || ... exit 1`.
    """
    src = WORKFLOW.read_text()
    var_to_key = dict(re.findall(r'^\s*(\w+)="\$\(val (\w+)\)"', src, re.M))
    gated_vars = re.findall(r'\[ -n "\$(\w+)" \]\s*\|\|', src)
    return {var_to_key[v] for v in gated_vars if v in var_to_key}


def main() -> int:
    d, a = declared(), asserted()

    # VACUITY FIRST. An empty side would make the comparison below pass while proving nothing —
    # the "found nothing / nothing wrong" shape. Both sides are known non-empty in this repo, so
    # an empty one means a broken parser or a truncated file, not a clean bill of health.
    if not d:
        print(f"::error::{LIST.relative_to(ROOT)} declares no keys — refusing to pass vacuously")
        return 1
    if not a:
        print("::error::parsed ZERO assertions from the deploy workflow — the parser is broken, not the workflow")
        return 1

    if "--print" in sys.argv:
        print("\n".join(sorted(a)))
        return 0

    if d == a:
        print(f"✓ required-vault-keys: {len(d)} key(s), list and deploy assertions agree")
        return 0

    print("::error::deploy/prod/required-vault-keys.txt and the deploy's assertions disagree.")
    for k in sorted(d - a):
        print(f"  declared but NOT asserted: {k}")
    for k in sorted(a - d):
        print(f"  asserted but NOT declared: {k}  <- add it to the list, or drop the gate")
    return 1


if __name__ == "__main__":
    sys.exit(main())
