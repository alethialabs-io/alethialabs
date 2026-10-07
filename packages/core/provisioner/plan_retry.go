// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"
)

// transientPlanErrorPatterns are the error texts that mark a failed `tofu plan` as a
// TRANSIENT network failure worth exactly one retry (#5644). tfexec appends tofu's stderr
// to the error it returns, so the match is on the text tofu printed for the provider's
// diagnostic. Each pattern is a fixed string from Go's standard library (net, net/http,
// syscall). The providers our templates use today are written in Go, so they surface these
// strings — but nothing enforces that a provider is a Go binary: one that words a network
// failure differently is simply not matched and fails immediately, as before #5644.
// Anything not listed here fails the plan immediately, as it did before #5644.
//
// Matching is a case-sensitive substring test over the error text with every run of
// whitespace collapsed to one space, so a diagnostic that tofu word-wrapped across two
// lines still matches.
//
// ACCEPTED COST: these patterns cannot tell a blip from a deterministic failure with the
// same text. A `connection refused` from a kubernetes/helm provider pointed at a localhost
// endpoint that is not there, or an `i/o timeout` against a firewalled address, fails the
// same way every time; it is retried once anyway, costing the backoff plus one more plan
// before it fails exactly as it would have. One wasted plan was judged cheaper than a red
// nightly from a real blip.
var transientPlanErrorPatterns = []struct {
	pattern string
	source  string
}{
	{
		pattern: "net/http: TLS handshake timeout",
		source: "Go net/http transport's TLS handshake deadline. Seen in the 2026-10-07 hetzner " +
			"floor nightly, run 37605979423: data.talos_image_factory_extensions_versions failed " +
			"with Get \"https://factory.talos.dev/...\": net/http: TLS handshake timeout",
	},
	{
		pattern: "i/o timeout",
		source:  "Go net package: a dial, read or write passed its deadline (os.ErrDeadlineExceeded)",
	},
	{
		pattern: "connection reset by peer",
		source:  "ECONNRESET as Go's syscall package renders it",
	},
	{
		pattern: "connection refused",
		source:  "ECONNREFUSED as Go's syscall package renders it",
	},
	{
		pattern: "Temporary failure in name resolution",
		source: "EAI_AGAIN from the glibc resolver (Go's cgo DNS path). Go's pure-Go resolver has " +
			"no such text: its DNS timeout surfaces as `i/o timeout` (above), and its " +
			"`server misbehaving` is deliberately NOT listed: net/dnsclient_unix.go renders the " +
			"same text for a temporary SERVFAIL (errServerTemporarilyMisbehaving) and a " +
			"non-temporary bad response (errServerMisbehaving), and the text cannot tell them apart",
	},
}

// planRetryPolicy is how a failed `tofu plan` is retried. Backoff is the wait before the
// single retry; Sleep performs that wait and returns early with ctx's error if the job is
// cancelled. Both are fields so tests run without waiting.
type planRetryPolicy struct {
	Backoff time.Duration
	Sleep   func(ctx context.Context, d time.Duration) error
}

// defaultPlanRetry is the policy RunDeployV2 plans with: one retry after 10s, long enough
// for a TLS/DNS blip to clear and short enough not to matter on a run that takes minutes.
var defaultPlanRetry = planRetryPolicy{Backoff: 10 * time.Second, Sleep: sleepCtx}

// sleepCtx waits for d, or returns ctx's error as soon as ctx is done.
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// transientPlanErrorReason returns the transientPlanErrorPatterns entry err's text
// matches, and false when err is nil or matches none of them.
func transientPlanErrorReason(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	text := strings.Join(strings.Fields(err.Error()), " ")
	for _, p := range transientPlanErrorPatterns {
		if strings.Contains(text, p.pattern) {
			return p.pattern, true
		}
	}
	return "", false
}

// run calls plan, and when it fails on a transient network error (see
// transientPlanErrorPatterns) logs the reason to stdout, waits Backoff and calls it ONCE
// more. A non-transient error, a cancelled ctx, or a second failure of any kind is
// returned as is — the second wrapped so the log and error both say a retry happened.
//
// This is for PLAN only. Apply is never retried: it is not idempotent here, and a
// half-applied run re-applied blind can double-create resources.
func (p planRetryPolicy) run(ctx context.Context, stdout io.Writer, plan func(context.Context) error) error {
	err := plan(ctx)
	if err == nil || ctx.Err() != nil {
		return err
	}
	reason, transient := transientPlanErrorReason(err)
	if !transient {
		return err
	}
	fmt.Fprintf(stdout, "tofu plan failed on a transient network error (%q); retrying once in %s\n", reason, p.Backoff)
	if sleepErr := p.Sleep(ctx, p.Backoff); sleepErr != nil {
		return err
	}
	if retryErr := plan(ctx); retryErr != nil {
		return fmt.Errorf("failed again after one retry on a transient network error (%q): %w", reason, retryErr)
	}
	fmt.Fprintln(stdout, "tofu plan succeeded on retry")
	return nil
}
