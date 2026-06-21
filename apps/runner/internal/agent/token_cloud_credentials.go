// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"
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

// tokenCloudVerifyURL is a cheap authenticated GET that confirms the token works.
var tokenCloudVerifyURL = map[string]string{
	"digitalocean": "https://api.digitalocean.com/v2/account",
	"hetzner":      "https://api.hetzner.cloud/v1/datacenters",
	"civo":         "https://api.civo.com/v2/regions",
}

// VerifyTokenCloud confirms the scoped token authenticates, without provisioning
// anything. Used by the CONNECTION_TEST job for DigitalOcean/Hetzner/Civo.
func VerifyTokenCloud(ctx context.Context, provider, token string, selfManaged bool) error {
	url, ok := tokenCloudVerifyURL[provider]
	if !ok {
		return fmt.Errorf("unsupported token cloud: %s", provider)
	}
	// Self-managed: Alethia holds no token — verify with the one in the runner's env.
	if selfManaged {
		token = tokenFromEnv(provider)
		if token == "" {
			return fmt.Errorf(
				"self-managed %s: expected %s in this runner's environment",
				provider, tokenCloudEnvVars[provider][0],
			)
		}
	}
	if token == "" {
		return fmt.Errorf("empty API token for %s", provider)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%s API call failed: %w", provider, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("invalid or unauthorized %s token (HTTP %d)", provider, resp.StatusCode)
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s API returned HTTP %d", provider, resp.StatusCode)
	}
	return nil
}
