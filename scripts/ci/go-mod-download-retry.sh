#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Fetch Go modules, retrying ONLY a failure that means "the module proxy did not answer" (#6031).
#
# USAGE
#   go-mod-download-retry.sh <dir>...           `go mod download` in each dir, under whatever GOWORK
#                                               the caller exported
#   go-mod-download-retry.sh -- <command>...    run one module-fetching command (`go list -m …`,
#                                               `go install pkg@ver`, `go mod tidy`) under the same
#                                               retry; its
#                                               stdout is passed through untouched, so a caller can
#                                               parse it (scripts/release-compliance.mjs does)
#   go-mod-download-retry.sh --self-test
#
# WHY IT EXISTS. Inside GitHub runners, proxy.golang.org intermittently resets an HTTP/2 stream:
#
#   go: …: read "https://proxy.golang.org/…zip": stream error: stream ID N; INTERNAL_ERROR; received from peer
#
# On 2026-10-14 that redded four runs across three jobs and dequeued #6002 twice. Go's own
# `GOPROXY=…,direct` fallback does not fire on it — the fallback is for 404/410 only — so nothing
# between the runner and the red step retries it.
#
# WHAT A PRE-FETCH WRITES. A plain `go mod download` fills the module cache and, in workspace mode,
# the gitignored go.work.sum; it leaves go.mod and go.sum alone (measured on all four modules from an
# empty GOMODCACHE: `git status --porcelain` stayed empty). It does NOT fetch everything `go mod
# tidy` loads — tidy also loads the tests of dependencies — so a tidy step runs its own `go mod tidy`
# through `--` instead. `go mod download all` would cover it, but it also writes module-zip hashes
# into go.sum that the committed, tidy go.sum does not carry, and fetches modules no step uses.
#
# WHAT IT REFUSES TO DO. A failure is retried only when ONE LINE of the output carries both a
# transport error from the list below AND a URL — a fetch that did not complete. Anything else fails
# on the FIRST attempt with the command's own exit code: a missing go.sum entry, a 404 for a version
# that does not exist, a compile error. Retrying a real failure is how a gate stops gating, and the
# --self-test below fails if that is ever introduced.
#
# WHAT IT DOES NOT HIDE. Every retry prints a `::warning`, and a retry that eventually succeeds
# prints one more saying so, so a proxy that keeps flaking stays visible on the run's summary instead
# of being absorbed by a green step. The last failure is an `::error` that calls it a FETCH failure.

set -uo pipefail

# Transport-level shapes only, one POSIX ERE alternative each, matched case-insensitively. The bar for
# adding one: the TRANSPORT produces it, never Go deciding a module is wrong. That is why `404`/`410`
# (a version that is not there) and `unexpected EOF` (also a plugin- and parser-crash message) are not
# here, and why the 5xx entries carry their status text — a bare `502` matches `main.go:502:3`.
NET_ERR='stream error|INTERNAL_ERROR|connection reset|TLS handshake timeout|i/o timeout|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out'

# ── --self-test ───────────────────────────────────────────────────────────────────────────────────
#
# A stub `go` on PATH replays a scenario and appends every invocation (its cwd and argv) to a FILE.
# The count is asserted, not only the exit code: a script that gives up after one attempt exits with
# the same code as one that tried three times. A file and not a shell variable, because each case
# runs the script in another process and a counter there would never come back.
#
# Every case invokes the script as `bash -e`, which is what a `run:` step with no `shell:` uses. A
# retry loop whose failing command aborts the script under -e makes one attempt and never classifies
# anything, while passing a harness that runs it under plain `bash`.
#
# The run's exit code IS the test: any failed case makes it exit 1.
if [ "${1:-}" = "--self-test" ]; then
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  pass=0 fail=0

  mkdir -p "$tmp/bin" "$tmp/modA" "$tmp/modB"
  cat > "$tmp/bin/go" <<'STUB'
#!/usr/bin/env bash
echo "$(basename "$PWD") $*" >> "$STUB_CALLS"
n=$(grep -c . "$STUB_CALLS")
case "$STUB_SCENARIO" in
  pass)
    echo '{"Path":"example.com/m","Main":true}'
    echo 'go: downloading example.com/dep v1.0.0' >&2
    exit 0 ;;
  real)
    echo "$STUB_LINE" >&2
    exit 1 ;;
  flaky_always)
    echo 'go: downloading golang.org/x/net v0.30.0' >&2
    echo "$STUB_LINE" >&2
    exit 1 ;;
  flaky_once)
    if [ "$n" -lt 2 ]; then
      echo '{"partial":' # a failed attempt's stdout must never reach the caller's stdout
      echo "$STUB_LINE" >&2
      exit 1
    fi
    echo '{"Path":"example.com/m","Main":true}'
    exit 0 ;;
esac
STUB
  chmod +x "$tmp/bin/go"

  # run LABEL WANT_RC WANT_CALLS SCENARIO LINE ARGS...  — stdout and stderr are kept apart on purpose.
  run() {
    local label="$1" want_rc="$2" want_calls="$3" scenario="$4" line="$5"; shift 5
    : > "$tmp/calls"
    local rc=0
    (cd "$tmp" && env PATH="$tmp/bin:$PATH" STUB_CALLS="$tmp/calls" STUB_SCENARIO="$scenario" \
      STUB_LINE="$line" GO_MOD_RETRY_ATTEMPTS=3 GO_MOD_RETRY_SLEEP_BASE=0 \
      bash -e "$self" "$@" >"$tmp/out" 2>"$tmp/err") || rc=$?
    local calls; calls=$(grep -c . "$tmp/calls" || true)
    if [ "$rc" = "$want_rc" ] && [ "$calls" = "$want_calls" ]; then
      echo "ok   - $label"; pass=$((pass + 1))
    else
      echo "FAIL - $label: rc=$rc (want $want_rc), attempts=$calls (want $want_calls)"
      sed 's/^/         /' "$tmp/err" | head -8
      fail=$((fail + 1))
    fi
  }
  says() { # LABEL FILE NEEDLE
    if grep -qF -- "$3" "$tmp/$2"; then echo "ok   - $1"; pass=$((pass + 1));
    else echo "FAIL - $1: $2 did not contain: $3"; fail=$((fail + 1)); fi
  }

  # The negatives first: retrying any of these is the entire cost of being wrong here.
  run "a missing go.sum entry is NOT retried" 1 1 real \
    'go: example.com/dep@v1.0.0: missing go.sum entry for go.mod file; to add it: go mod download example.com/dep' -- go list -m all
  says "...and it says it is not retrying" err "not a network or stream error — not retrying"
  run "a 404 from the proxy (a version that does not exist) is NOT retried" 1 1 real \
    'go: example.com/dep@v9.9.9: reading https://proxy.golang.org/example.com/dep/@v/v9.9.9.mod: 404 Not Found' -- go list -m all
  run "a transport word with no URL on its line (a test name, a log line) is NOT retried" 1 1 real \
    '--- FAIL: TestDialer: want "connection reset", got nil' -- go list -m all
  run "a bare 502 (a line number) is NOT retried" 1 1 real \
    'https://example.com/x/main.go:502:3: undefined: proxyClient' -- go list -m all

  run "a passing command runs once" 0 1 pass "" -- go list -m -json all
  says "...and its stdout is passed through" out '{"Path":"example.com/m","Main":true}'
  if grep -q 'downloading' "$tmp/out"; then
    echo "FAIL - stderr leaked into stdout"; fail=$((fail + 1))
  else echo "ok   - ...and its stderr stays on stderr"; pass=$((pass + 1)); fi

  stream='go: golang.org/x/net@v0.30.0: read "https://proxy.golang.org/golang.org/x/net/@v/v0.30.0.zip": stream error: stream ID 7; INTERNAL_ERROR; received from peer'
  run "a stream error that persists is retried to the ceiling, then fails" 1 3 flaky_always "$stream" modA
  says "...and the last attempt calls it a FETCH failure" err "This is a FETCH failure"
  says "...and every retry is logged" err "attempt 2/3 failed on a transient fetch error"

  run "a stream error that clears is a pass" 0 2 flaky_once "$stream" -- go list -m -json all
  says "...and the success says it retried, so a flaky proxy stays visible" err "succeeded on attempt 2/3 after 1 transient fetch failure"
  if [ "$(cat "$tmp/out")" = '{"Path":"example.com/m","Main":true}' ]; then
    echo "ok   - ...and only the successful attempt's stdout reaches the caller"; pass=$((pass + 1))
  else echo "FAIL - a failed attempt's stdout leaked to the caller: $(cat "$tmp/out")"; fail=$((fail + 1)); fi

  for line in \
    'go: verifying example.com/dep@v1.0.0: Get "https://sum.golang.org/lookup/example.com/dep@v1.0.0": net/http: TLS handshake timeout' \
    'go: example.com/dep@v1.0.0: Get "https://proxy.golang.org/example.com/dep/@v/v1.0.0.mod": dial tcp 142.250.0.1:443: i/o timeout' \
    'go: example.com/dep@v1.0.0: read "https://proxy.golang.org/example.com/dep/@v/v1.0.0.zip": read tcp: connection reset by peer' \
    'go: example.com/dep@v1.0.0: reading https://proxy.golang.org/example.com/dep/@v/v1.0.0.zip: 502 Bad Gateway' \
    'go: example.com/dep@v1.0.0: reading https://proxy.golang.org/example.com/dep/@v/v1.0.0.zip: 503 Service Unavailable' \
    'go: example.com/dep@v1.0.0: reading https://proxy.golang.org/example.com/dep/@v/v1.0.0.zip: 504 Gateway Timeout'; do
    run "retried: ${line##*: }" 0 2 flaky_once "$line" -- go list -m all
  done

  run "dir mode runs go mod download in every dir" 0 2 pass "" modA modB
  if [ "$(cat "$tmp/calls")" = "$(printf 'modA mod download\nmodB mod download')" ]; then
    echo "ok   - ...in that dir, with no extra arguments"; pass=$((pass + 1))
  else echo "FAIL - dir mode invoked: $(tr '\n' ';' < "$tmp/calls")"; fail=$((fail + 1)); fi

  run "no arguments is a usage error, not a silent pass" 2 0 pass ""
  run "a dir that does not exist fails, not a silent pass" 1 0 pass "" no-such-dir

  echo
  if [ "$fail" -eq 0 ]; then echo "go-mod-download-retry self-test: all $pass passed"; exit 0; fi
  echo "go-mod-download-retry self-test: $fail of $((pass + fail)) FAILED"; exit 1
fi

attempts="${GO_MOD_RETRY_ATTEMPTS:-3}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Print the first output line that is a fetch which did not complete: a transport error AND a URL on
# the same line. Prints nothing (and returns 1) for anything else. Here-strings rather than pipes into
# `grep -q`, because under `pipefail` an early-exiting `grep -q` can SIGPIPE the writer and turn a
# match into a failure.
fetch_error_line() {
  local hits
  hits="$(grep -Ei -- "$NET_ERR" "$1" || true)"
  [ -n "$hits" ] || return 1
  hits="$(grep -E -- 'https?://' <<<"$hits" || true)"
  [ -n "$hits" ] || return 1
  head -n 1 <<<"$hits"
}

# Run "$@" in directory $1 until it succeeds, a non-fetch failure occurs, or the attempts run out.
# Only the successful attempt's stdout reaches our stdout; everything else goes to stderr.
retry_in() {
  local dir="$1"; shift
  local label="(${dir}) $*" attempt=1 rc line backoff
  while :; do
    # `if` keeps a failing command from ending the script under `bash -e`.
    if (cd "$dir" && "$@") >"$work/out" 2>"$work/err"; then rc=0; else rc=$?; fi
    if [ "$rc" -eq 0 ]; then
      cat "$work/out"
      cat "$work/err" >&2
      if [ "$attempt" -gt 1 ]; then
        echo "::warning title=Go module fetch retried (#6031)::${label}: succeeded on attempt ${attempt}/${attempts} after $((attempt - 1)) transient fetch failure(s). Nothing failed, but the proxy is flaking — see the warnings above." >&2
      fi
      return 0
    fi
    cat "$work/out" "$work/err" >&2
    cat "$work/out" "$work/err" > "$work/both"
    if ! line="$(fetch_error_line "$work/both")"; then
      echo "::error title=Go command failed::${label}: exited ${rc}, and that is not a network or stream error — not retrying." >&2
      return "$rc"
    fi
    line="${line//%/%25}"
    if [ "$attempt" -ge "$attempts" ]; then
      echo "::error title=Go module fetch failed (#6031)::${label}: could not fetch modules in ${attempts} attempts. This is a FETCH failure, not a build failure. Last error: ${line}" >&2
      return "$rc"
    fi
    # The base is a variable only so --self-test can drive it to zero; CI leaves it at 10s.
    backoff=$((attempt * ${GO_MOD_RETRY_SLEEP_BASE:-10}))
    echo "::warning title=Go module fetch retried (#6031)::${label}: attempt ${attempt}/${attempts} failed on a transient fetch error — retrying in ${backoff}s. ${line}" >&2
    sleep "$backoff"
    attempt=$((attempt + 1))
  done
}

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <dir>... | -- <command>... | --self-test" >&2
  exit 2
fi

if [ "$1" = "--" ]; then
  shift
  if [ "$#" -eq 0 ]; then echo "$0: -- needs a command" >&2; exit 2; fi
  retry_in . "$@"
  exit $?
fi

for dir in "$@"; do
  if [ ! -d "$dir" ]; then
    echo "::error title=Go module fetch::${dir} is not a directory." >&2
    exit 1
  fi
  retry_in "$dir" go mod download || exit $?
done
