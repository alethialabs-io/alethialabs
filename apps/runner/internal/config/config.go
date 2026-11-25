// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package config is the runner's start-up configuration check for a self-hosted instance (EDN-H2).
//
// Before it registers or claims anything, the bundled runner of a self-hosted instance checks that
// every value it needs is present and of the shape the code that reads it expects, and refuses to
// start with one error naming every variable that is not usable and how to fix it. No value is ever
// part of that error.
//
// WHEN IT APPLIES: the process environment DECLARES ALETHIA_DEPLOYMENT_MODE=self-managed. The
// self-hosted runner reads the box's .env (env_file in docker-compose.yml), which deploy/install.sh
// copies from .env.example, which declares it. A runner an operator registers by hand against any
// control plane does not carry that line and keeps today's behaviour. The console makes the same
// decision (apps/console/lib/config/selfhost-secrets.ts).
//
// The instance secrets are those of deploy/selfhost/secrets.manifest whose consumers include
// `runner`; a template placeholder is recognised the way deploy/selfhost/secrets.sh recognises one.
// Unit tests hold both equal to those files.
package config

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
)

// DeploymentModeEnv names the variable a self-hosted instance declares itself with.
const DeploymentModeEnv = "ALETHIA_DEPLOYMENT_MODE"

// placeholderDigests is the SHA-256 of each placeholder value a template has carried for an
// instance secret: PLACEHOLDER_DIGESTS in deploy/selfhost/secrets.sh (a test holds them equal).
// Add to it; never remove from it.
var placeholderDigests = map[string]bool{
	"660599fcee9088125a9c926aeff66776919d35087651ad2badbce191dac83692": true,
	"7e9886e3832c2875145a9fb5fc5148afa5c501e07209ca2222175df80390105c": true,
	"88de4c7de8ca1ef22b59faaf1e939954caa1a74ce2570fd9296edab041c3e7dc": true,
	"b35dd74e6920a52dc01f24d238c9344e066f64c6a2197edae3ac89228fec3295": true,
	"bcd6860363c05e59bc10b5b81ddf32a4806d8a664953016e82db22bb6b2b8160": true,
	"f8d0d021b95e78c7bb4e5be8b05b0c9cfdbb8c9d02a014528795c0461a4ca3f2": true,
}

// runnerSecrets are the manifest entries whose consumers include `runner`. A test holds this list
// equal to deploy/selfhost/secrets.manifest. The storage keys are passed to the runner by the
// overlay but read by nothing in the runner binary, so they are checked for a placeholder only.
var runnerSecrets = []string{
	"ALETHIA_STORAGE_ACCESS_KEY_ID",
	"ALETHIA_STORAGE_SECRET_ACCESS_KEY",
	"ALETHIA_RUNNER_BOOTSTRAP_TOKEN",
	"ALETHIA_RECEIPT_SIGNING_KEY",
}

// Applies reports whether the self-hosted start-up check applies to this environment.
func Applies(getenv func(string) string) bool {
	return getenv(DeploymentModeEnv) == "self-managed"
}

// IsPlaceholder reports whether value is a template placeholder: an angle-bracketed `<…>` marker,
// or a value whose SHA-256 a template has carried. An empty value is not a placeholder.
func IsPlaceholder(value string) bool {
	if value == "" {
		return false
	}
	if strings.HasPrefix(value, "<") && strings.HasSuffix(value, ">") {
		return true
	}
	sum := sha256.Sum256([]byte(value))
	return placeholderDigests[hex.EncodeToString(sum[:])]
}

// Error is the refusal: every unusable variable with how to fix it. It never holds a value.
type Error struct {
	Problems []string
}

// Error renders the refusal as one message, one problem per line.
func (e *Error) Error() string {
	var b strings.Builder
	b.WriteString("refusing to start: this self-hosted runner's configuration is not usable.\n")
	for _, p := range e.Problems {
		b.WriteString("  - ")
		b.WriteString(p)
		b.WriteString("\n")
	}
	b.WriteString("Instance secrets are generated per install from deploy/selfhost/secrets.manifest: " +
		"re-run deploy/install.sh to fill a missing one, and replace a set one with deploy/selfhost/rotate-secret.sh.")
	return b.String()
}

const rotateHint = "Replace it with: sh deploy/selfhost/rotate-secret.sh "

// Problems lists every reason this environment cannot run a self-hosted runner, empty when the
// configuration is usable. Messages name variables, never values.
func Problems(getenv func(string) string) []string {
	var problems []string
	get := func(name string) string { return strings.TrimSpace(getenv(name)) }

	// No instance secret may be a template placeholder, whether or not it is required below.
	for _, name := range runnerSecrets {
		if IsPlaceholder(get(name)) {
			problems = append(problems, fmt.Sprintf(
				"%s holds a template placeholder, not a value generated for this install. %s%s", name, rotateHint, name))
		}
	}
	for _, name := range []string{"ALETHIA_RUNNER_ID", "ALETHIA_RUNNER_TOKEN"} {
		if IsPlaceholder(get(name)) {
			problems = append(problems, fmt.Sprintf(
				"%s holds a template placeholder. Remove it to let the runner register with ALETHIA_RUNNER_BOOTSTRAP_TOKEN, "+
					"or set the id and token the console issued.", name))
		}
	}

	origin := get("ALETHIA_WEB_ORIGIN")
	if origin == "" {
		problems = append(problems, "ALETHIA_WEB_ORIGIN is not set. The self-host overlay sets it to the bundled console (http://app:3000).")
	} else if u, err := url.Parse(origin); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		problems = append(problems, "ALETHIA_WEB_ORIGIN must be an http:// or https:// URL with a host, e.g. http://app:3000.")
	}

	// Credentials: an issued id and token, or the bootstrap token to register with.
	hasIssued := get("ALETHIA_RUNNER_ID") != "" && get("ALETHIA_RUNNER_TOKEN") != ""
	if !hasIssued && get("ALETHIA_RUNNER_BOOTSTRAP_TOKEN") == "" {
		problems = append(problems, "ALETHIA_RUNNER_BOOTSTRAP_TOKEN is not set, and no ALETHIA_RUNNER_ID and ALETHIA_RUNNER_TOKEN "+
			"are either. The bundled runner registers with the bootstrap token; re-run deploy/install.sh to generate it.")
	}

	// The receipt-signing key: required, and a 64-byte ed25519 private key (packages/core/verify).
	switch key := get("ALETHIA_RECEIPT_SIGNING_KEY"); {
	case key == "":
		problems = append(problems, "ALETHIA_RECEIPT_SIGNING_KEY is not set. Every required instance secret is generated per install; "+
			"re-run deploy/install.sh to generate it.")
	case IsPlaceholder(key):
		// Reported above.
	default:
		if b, err := base64.StdEncoding.DecodeString(key); err != nil || len(b) != 64 {
			problems = append(problems, "ALETHIA_RECEIPT_SIGNING_KEY must be the base64 of a 64-byte ed25519 private key. "+
				rotateHint+"ALETHIA_RECEIPT_SIGNING_KEY")
		}
	}
	return problems
}

// Check returns the refusal for this environment, or nil when the check does not apply or the
// configuration is usable.
func Check(getenv func(string) string) error {
	if !Applies(getenv) {
		return nil
	}
	if problems := Problems(getenv); len(problems) > 0 {
		return &Error{Problems: problems}
	}
	return nil
}
