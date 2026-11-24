// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package config

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// repoFile reads a file relative to the repository root (this package is apps/runner/internal/config).
func repoFile(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", rel))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(b)
}

func randomHex(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

func randomB64(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(b)
}

// usableEnv is the environment the self-host overlay and deploy/install.sh give the bundled runner.
func usableEnv(t *testing.T) map[string]string {
	return map[string]string{
		DeploymentModeEnv:                   "self-managed",
		"ALETHIA_WEB_ORIGIN":                "http://app:3000",
		"ALETHIA_STORAGE_ACCESS_KEY_ID":     randomHex(t, 16),
		"ALETHIA_STORAGE_SECRET_ACCESS_KEY": randomHex(t, 32),
		"ALETHIA_RUNNER_BOOTSTRAP_TOKEN":    randomHex(t, 32),
		"ALETHIA_RECEIPT_SIGNING_KEY":       randomB64(t, 64),
	}
}

func getenv(env map[string]string) func(string) string {
	return func(k string) string { return env[k] }
}

// refusal is Check's message for env, or "" when it does not refuse.
func refusal(env map[string]string) string {
	err := Check(getenv(env))
	if err == nil {
		return ""
	}
	var cfgErr *Error
	if !errors.As(err, &cfgErr) {
		return "unexpected error type: " + err.Error()
	}
	return err.Error()
}

func TestRunnerSecretsMatchTheManifest(t *testing.T) {
	var want []string
	for _, line := range strings.Split(repoFile(t, "deploy/selfhost/secrets.manifest"), "\n") {
		f := strings.Fields(line)
		if len(f) >= 6 && f[0] == "secret" && slices.Contains(strings.Split(f[5], ","), "runner") {
			want = append(want, f[1])
		}
	}
	got := slices.Clone(runnerSecrets)
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("runnerSecrets = %v, the manifest's runner consumers are %v", got, want)
	}
}

func TestPlaceholderDigestsMatchSecretsSh(t *testing.T) {
	m := regexp.MustCompile(`(?m)^PLACEHOLDER_DIGESTS="([0-9a-f ]+)"$`).FindStringSubmatch(repoFile(t, "deploy/selfhost/secrets.sh"))
	if m == nil {
		t.Fatal("PLACEHOLDER_DIGESTS not found in deploy/selfhost/secrets.sh")
	}
	want := strings.Fields(m[1])
	var got []string
	for d := range placeholderDigests {
		got = append(got, d)
	}
	slices.Sort(got)
	slices.Sort(want)
	if len(want) == 0 || !slices.Equal(got, want) {
		t.Fatalf("placeholderDigests differ from deploy/selfhost/secrets.sh: got %d, want %d", len(got), len(want))
	}
}

func TestApplies(t *testing.T) {
	cases := map[string]bool{"self-managed": true, "": false, "hosted": false}
	for mode, want := range cases {
		if got := Applies(getenv(map[string]string{DeploymentModeEnv: mode})); got != want {
			t.Errorf("Applies(%q) = %v, want %v", mode, got, want)
		}
	}
	// A hand-registered runner with nothing else set is not checked.
	if err := Check(getenv(map[string]string{})); err != nil {
		t.Fatalf("Check without the self-managed declaration refused: %v", err)
	}
}

func TestAcceptsAGeneratedConfiguration(t *testing.T) {
	if msg := refusal(usableEnv(t)); msg != "" {
		t.Fatalf("refused a generated configuration:\n%s", msg)
	}
	// Issued credentials stand in for the bootstrap token.
	env := usableEnv(t)
	delete(env, "ALETHIA_RUNNER_BOOTSTRAP_TOKEN")
	env["ALETHIA_RUNNER_ID"] = "r-1"
	env["ALETHIA_RUNNER_TOKEN"] = randomHex(t, 32)
	if msg := refusal(env); msg != "" {
		t.Fatalf("refused issued credentials without a bootstrap token:\n%s", msg)
	}
}

func TestRefusesAPlaceholderInEachRunnerSecret(t *testing.T) {
	const value = "<replace with a generated value>"
	for _, name := range append(slices.Clone(runnerSecrets), "ALETHIA_RUNNER_ID", "ALETHIA_RUNNER_TOKEN") {
		t.Run(name, func(t *testing.T) {
			env := usableEnv(t)
			env[name] = value
			msg := refusal(env)
			if !strings.Contains(msg, name+" holds a template placeholder") {
				t.Fatalf("did not name %s:\n%s", name, msg)
			}
			if strings.Contains(msg, value) {
				t.Fatalf("echoed the value:\n%s", msg)
			}
		})
	}
}

func TestRefusesMissingOrMalformedValues(t *testing.T) {
	cases := []struct {
		name, value, want string
	}{
		{"ALETHIA_WEB_ORIGIN", "", "ALETHIA_WEB_ORIGIN is not set"},
		{"ALETHIA_WEB_ORIGIN", "console.internal:4000", "ALETHIA_WEB_ORIGIN must be an http:// or https:// URL"},
		{"ALETHIA_RUNNER_BOOTSTRAP_TOKEN", "", "ALETHIA_RUNNER_BOOTSTRAP_TOKEN is not set"},
		{"ALETHIA_RECEIPT_SIGNING_KEY", "", "ALETHIA_RECEIPT_SIGNING_KEY is not set"},
		{"ALETHIA_RECEIPT_SIGNING_KEY", randomB64(t, 32), "ALETHIA_RECEIPT_SIGNING_KEY must be the base64 of a 64-byte"},
		{"ALETHIA_RECEIPT_SIGNING_KEY", "not base64!", "ALETHIA_RECEIPT_SIGNING_KEY must be the base64 of a 64-byte"},
	}
	for _, c := range cases {
		t.Run(c.name+"="+c.value, func(t *testing.T) {
			env := usableEnv(t)
			env[c.name] = c.value
			msg := refusal(env)
			if !strings.Contains(msg, c.want) {
				t.Fatalf("want %q in:\n%s", c.want, msg)
			}
			if c.value != "" && strings.Contains(msg, c.value) {
				t.Fatalf("echoed the value:\n%s", msg)
			}
		})
	}
}

func TestNamesEveryProblemInOneRefusal(t *testing.T) {
	env := usableEnv(t)
	delete(env, "ALETHIA_WEB_ORIGIN")
	delete(env, "ALETHIA_RECEIPT_SIGNING_KEY")
	msg := refusal(env)
	for _, want := range []string{"ALETHIA_WEB_ORIGIN is not set", "ALETHIA_RECEIPT_SIGNING_KEY is not set"} {
		if !strings.Contains(msg, want) {
			t.Errorf("want %q in:\n%s", want, msg)
		}
	}
}
