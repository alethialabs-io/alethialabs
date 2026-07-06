// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"fmt"
	"os"
)

// Token clouds (DigitalOcean, Hetzner, Civo) have no role-federation, so they
// authenticate with a scoped API token. The token is decrypted by the console at
// claim time and handed to the runner here — never stored on disk. We export it to
// the provider-specific env var that the OpenTofu provider + CLI read.

// tokenCloudEnvVars maps a provider to the env vars its tooling expects.
var tokenCloudEnvVars = map[string][]string{
	"digitalocean": {"DIGITALOCEAN_ACCESS_TOKEN", "DIGITALOCEAN_TOKEN"},
	"hetzner":      {"HCLOUD_TOKEN"},
	"civo":         {"CIVO_TOKEN"},
}

// tokenFromEnv returns the first non-empty provider env var already set on this
// runner — the self-managed path, where the customer's self-hosted runner carries
// the token in its own environment and Alethia stores nothing.
func tokenFromEnv(provider string) string {
	for _, e := range tokenCloudEnvVars[provider] {
		if v := os.Getenv(e); v != "" {
			return v
		}
	}
	return ""
}

// ActivateTokenCloud prepares the provider's auth env vars and returns a cleanup
// func. In self-managed mode no token is supplied by Alethia: the token must already
// be present in this (self-hosted) runner's environment, and we leave it untouched.
func ActivateTokenCloud(provider, token string, selfManaged bool) (func(), error) {
	envs, ok := tokenCloudEnvVars[provider]
	if !ok {
		return nil, fmt.Errorf("unsupported token cloud: %s", provider)
	}
	if selfManaged {
		if tokenFromEnv(provider) == "" {
			return nil, fmt.Errorf(
				"self-managed %s: expected %s to be set in this runner's environment",
				provider, envs[0],
			)
		}
		// Customer-provided env token already present — never overwrite or clear it.
		return func() {}, nil
	}
	if token == "" {
		return nil, fmt.Errorf("empty API token for %s", provider)
	}
	for _, e := range envs {
		_ = os.Setenv(e, token)
	}
	return func() {
		for _, e := range envs {
			_ = os.Unsetenv(e)
		}
	}, nil
}
