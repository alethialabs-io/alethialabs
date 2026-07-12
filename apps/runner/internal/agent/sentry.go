// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Sentry error tracking for the runner — the "when a provision breaks, we see it" half of the
// observability substrate. It is STRICTLY DSN-gated, exactly like the OTel layer (internal/obs)
// and the console analytics: when SENTRY_DSN is unset InitSentry registers NOTHING, every
// capture helper is a no-op, and there is zero overhead. It never blocks or fails a job — capture
// is best-effort on a cloned hub with no flush, and can never panic into the caller. The transport
// is Sentry-protocol-generic, so a self-hosted GlitchTip DSN works unchanged.
//
// Secret hygiene: Go's SDK does NOT capture local-variable values in stack frames, so the only
// leak vector is the error MESSAGE text. Every captured message is run through scrubSecrets, which
// redacts the process's secret env VALUES (runner token, cloud credentials, storage keys, …). The
// set of "what is secret" reuses the audited output-scrub denylist (sensitiveOutputSubstrings)
// extended with the env-name shapes that carry credentials — one source of truth, never hand-rolled
// per call site. A BeforeSend/BeforeBreadcrumb pass re-scrubs as last-line defense.

package agent

import (
	"errors"
	"os"
	"strings"
	"time"

	"github.com/getsentry/sentry-go"
)

// sentryEnabled reports whether Sentry was initialized (SENTRY_DSN set). When false the capture
// helpers skip all scrub/scope work; sentry-go's own CaptureException is additionally a no-op
// without a client, so this is defense in depth, not the only gate.
var sentryEnabled bool

// InitSentry initializes the Sentry error tracker when SENTRY_DSN is set. Unset ⇒ a COMPLETE
// no-op: no client is created, the returned flush is a no-op, and every capture helper short-
// circuits. Mirrors obs.Setup — never fatal (an init error is returned for the caller to log and
// continue provisioning without error tracking).
func InitSentry(release string) (func(), error) {
	noop := func() {}
	dsn := strings.TrimSpace(os.Getenv("SENTRY_DSN"))
	if dsn == "" {
		return noop, nil
	}
	if err := sentry.Init(sentry.ClientOptions{
		Dsn:         dsn,
		Environment: sentryEnvironment(),
		Release:     release,
		// Error tracking ONLY: the runner's distributed traces already flow through OTel
		// (internal/obs), so Sentry performance tracing stays OFF — no double instrumentation,
		// no sampling overhead, and Sentry never installs a competing tracer/propagator.
		TracesSampleRate: 0,
		BeforeSend:       scrubSentryEvent,
		BeforeBreadcrumb: scrubSentryBreadcrumb,
	}); err != nil {
		return noop, err
	}
	sentryEnabled = true
	// Flush buffered events on a clean drain (SIGTERM → agent returns → main's defer runs).
	return func() { sentry.Flush(2 * time.Second) }, nil
}

// sentryEnvironment resolves the deployment environment tag (SENTRY_ENVIRONMENT), defaulting to
// "production" so hosted events are grouped sensibly.
func sentryEnvironment() string {
	if v := strings.TrimSpace(os.Getenv("SENTRY_ENVIRONMENT")); v != "" {
		return v
	}
	return "production"
}

// captureError ships a scrubbed exception to Sentry with correlation tags (trace_id / job_id /
// runner_id / job_type / op). Best-effort and non-blocking: it runs on a CLONED hub, does not
// flush, and recovers from any panic — so it can never slow, block, or crash the job/loop that
// called it. A no-op when Sentry is disabled or err is nil. NOTE: user cancels are NOT failures —
// callers must not route them here.
func captureError(err error, tags map[string]string) {
	if !sentryEnabled || err == nil {
		return
	}
	// Capture must never panic into the caller (a job/loop is more important than a telemetry event).
	defer func() { _ = recover() }()
	hub := sentry.CurrentHub().Clone()
	hub.ConfigureScope(func(scope *sentry.Scope) {
		for k, v := range tags {
			if v != "" {
				scope.SetTag(k, scrubSecrets(v))
			}
		}
	})
	hub.CaptureException(scrubbedError(err))
}

// scrubbedError returns err with any known secret VALUE stripped from its message. If nothing was
// redacted the original error is returned unchanged (preserving any wrapped chain / stack marker).
func scrubbedError(err error) error {
	msg := err.Error()
	cleaned := scrubSecrets(msg)
	if cleaned == msg {
		return err
	}
	return errors.New(cleaned)
}

// secretEnvKeySubstrings extends the audited output-scrub denylist (sensitiveOutputSubstrings)
// with the env-var NAME shapes that carry secrets, so their values can be redacted out of any
// captured message. Reusing sensitiveOutputSubstrings keeps ONE source of truth for "what is
// secret" across the persisted-metadata scrub and the error-capture scrub.
var secretEnvKeySubstrings = append(append([]string{}, sensitiveOutputSubstrings...),
	"token",
	"secret",
	"password",
	"passphrase",
	"credential",
	"api_key",
	"apikey",
	"access_key",
	"session",
	"dsn",
)

// isSecretEnvKey reports whether an env-var name looks like it holds a credential (case-insensitive
// substring match against the shared denylist).
func isSecretEnvKey(key string) bool {
	lower := strings.ToLower(key)
	for _, s := range secretEnvKeySubstrings {
		if strings.Contains(lower, s) {
			return true
		}
	}
	return false
}

// secretValues returns the process's secret env VALUES (those whose key matches the denylist and
// are long enough to be a real secret). These verbatim strings are redacted from anything shipped
// to Sentry. Recomputed per call — capture is rare (only on real errors), so the cost is
// irrelevant and it stays correct if credentials are injected into the env mid-run (the Activate*
// paths export AWS_*/token vars just before a job runs).
func secretValues() []string {
	var out []string
	for _, kv := range os.Environ() {
		i := strings.IndexByte(kv, '=')
		if i < 0 {
			continue
		}
		key, val := kv[:i], kv[i+1:]
		// A short value (< 6 chars) is too generic to safely blanket-redact (would nuke unrelated
		// substrings); real tokens/keys are far longer.
		if len(val) >= 6 && isSecretEnvKey(key) {
			out = append(out, val)
		}
	}
	return out
}

// scrubSecrets replaces every known secret env value in s with [REDACTED].
func scrubSecrets(s string) string {
	if s == "" {
		return s
	}
	for _, secret := range secretValues() {
		if secret != "" {
			s = strings.ReplaceAll(s, secret, "[REDACTED]")
		}
	}
	return s
}

// scrubSentryEvent is the last-line defense hook: it redacts secret values from the event message,
// every exception value, and tag values before the event leaves the process.
func scrubSentryEvent(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
	if event == nil {
		return event
	}
	event.Message = scrubSecrets(event.Message)
	for i := range event.Exception {
		event.Exception[i].Value = scrubSecrets(event.Exception[i].Value)
	}
	for k, v := range event.Tags {
		event.Tags[k] = scrubSecrets(v)
	}
	if event.Request != nil {
		event.Request.QueryString = scrubSecrets(event.Request.QueryString)
		event.Request.Data = scrubSecrets(event.Request.Data)
	}
	return event
}

// scrubSentryBreadcrumb redacts secret values from a breadcrumb message before capture.
func scrubSentryBreadcrumb(breadcrumb *sentry.Breadcrumb, _ *sentry.BreadcrumbHint) *sentry.Breadcrumb {
	if breadcrumb == nil {
		return breadcrumb
	}
	breadcrumb.Message = scrubSecrets(breadcrumb.Message)
	return breadcrumb
}
