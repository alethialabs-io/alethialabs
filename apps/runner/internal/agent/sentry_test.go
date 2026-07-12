// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"errors"
	"strings"
	"testing"

	"github.com/getsentry/sentry-go"
)

// TestInitSentryNoOpWhenUnset proves the DSN gate: with SENTRY_DSN unset InitSentry does not
// initialize (returns a usable no-op flush + nil error, leaves sentryEnabled false), and the
// capture helpers are safe no-ops that never panic.
func TestInitSentryNoOpWhenUnset(t *testing.T) {
	t.Setenv("SENTRY_DSN", "")
	sentryEnabled = false

	flush, err := InitSentry("test")
	if err != nil {
		t.Fatalf("InitSentry returned error when DSN unset: %v", err)
	}
	if flush == nil {
		t.Fatal("InitSentry returned a nil flush func")
	}
	if sentryEnabled {
		t.Fatal("sentryEnabled must stay false when SENTRY_DSN is unset")
	}
	// Must be callable and must not panic even though nothing was initialized.
	flush()
	captureError(errors.New("boom"), map[string]string{"op": "test"})
	captureError(nil, nil)
}

// TestScrubSecretsRedactsEnvValue proves the scrub reuses the denylist over env NAMES and strips
// the matching VALUE from any string — so a token echoed into an error never reaches Sentry.
func TestScrubSecretsRedactsEnvValue(t *testing.T) {
	const secret = "supersecrettokenvalue-abc123"
	t.Setenv("ALETHIA_RUNNER_TOKEN", secret)

	msg := "AssumeRole failed for token " + secret + " (expired)"
	got := scrubSecrets(msg)

	if strings.Contains(got, secret) {
		t.Fatalf("scrubSecrets leaked the secret: %q", got)
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("scrubSecrets did not redact: %q", got)
	}
}

// TestScrubbedErrorStripsSecret proves the error-message path (what captureError ships) is scrubbed.
func TestScrubbedErrorStripsSecret(t *testing.T) {
	const secret = "clientsecret-9f8e7d6c5b4a3210"
	t.Setenv("AZURE_CLIENT_SECRET", secret)

	err := scrubbedError(errors.New("azure login rejected " + secret))
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("scrubbedError leaked the secret: %q", err.Error())
	}
	if !strings.Contains(err.Error(), "[REDACTED]") {
		t.Fatalf("scrubbedError did not redact: %q", err.Error())
	}

	// A message with no secret is returned unchanged (same error instance).
	clean := errors.New("plain failure")
	if scrubbedError(clean) != clean {
		t.Fatal("scrubbedError should return the original error when nothing is redacted")
	}
}

// TestScrubSentryEventRedactsExceptionValue proves the BeforeSend last-line defense scrubs the
// exception value + tags on the outgoing event.
func TestScrubSentryEventRedactsExceptionValue(t *testing.T) {
	const secret = "awssecretaccesskey-ABCDEF1234567890"
	t.Setenv("AWS_SECRET_ACCESS_KEY", secret)

	event := &sentry.Event{
		Message: "failed with " + secret,
		Exception: []sentry.Exception{
			{Value: "boom " + secret},
		},
		Tags: map[string]string{"detail": secret},
	}
	out := scrubSentryEvent(event, nil)

	if strings.Contains(out.Message, secret) {
		t.Fatalf("event message leaked secret: %q", out.Message)
	}
	if strings.Contains(out.Exception[0].Value, secret) {
		t.Fatalf("exception value leaked secret: %q", out.Exception[0].Value)
	}
	if strings.Contains(out.Tags["detail"], secret) {
		t.Fatalf("tag leaked secret: %q", out.Tags["detail"])
	}

	// nil-safe.
	if scrubSentryEvent(nil, nil) != nil {
		t.Fatal("scrubSentryEvent(nil) should return nil")
	}
	if scrubSentryBreadcrumb(nil, nil) != nil {
		t.Fatal("scrubSentryBreadcrumb(nil) should return nil")
	}
}

// TestIsSecretEnvKeyReusesOutputDenylist proves the extended denylist still covers the audited
// output-scrub substrings (one source of truth) plus the env-name shapes.
func TestIsSecretEnvKeyReusesOutputDenylist(t *testing.T) {
	// Inherited from sensitiveOutputSubstrings (output_scrub.go).
	for _, k := range []string{"KUBECONFIG", "gke_kubeconfig", "TALOSCONFIG", "client_key"} {
		if !isSecretEnvKey(k) {
			t.Fatalf("expected %q to be treated as secret (output denylist)", k)
		}
	}
	// Env-name extensions.
	for _, k := range []string{"ALETHIA_RUNNER_TOKEN", "AWS_SECRET_ACCESS_KEY", "SOME_PASSWORD", "SENTRY_DSN"} {
		if !isSecretEnvKey(k) {
			t.Fatalf("expected %q to be treated as secret (env-name shape)", k)
		}
	}
	if isSecretEnvKey("ALETHIA_WEB_ORIGIN") {
		t.Fatal("ALETHIA_WEB_ORIGIN must not be treated as secret")
	}
}
