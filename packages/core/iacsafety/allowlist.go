// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package iacsafety

import (
	"os"
	"strings"
)

// AllowlistEnvVar is the environment variable read by AllowlistFromEnv:
// a comma-separated list of provider source addresses.
const AllowlistEnvVar = "ALETHIA_BYO_IAC_PROVIDER_ALLOWLIST"

// DefaultProviderAllowlist returns the built-in allowed provider source set.
// Addresses are namespace/name; registry-host prefixes are stripped during
// normalization, so registry.opentofu.org/hashicorp/aws and
// registry.terraform.io/hashicorp/aws both match "hashicorp/aws".
func DefaultProviderAllowlist() []string {
	return []string{
		"hashicorp/aws",
		"hashicorp/google",
		"hashicorp/google-beta",
		"hashicorp/azurerm",
		"hashicorp/azuread",
		"hashicorp/alicloud",
		"hashicorp/kubernetes",
		"hashicorp/helm",
		"hashicorp/tls",
		"hashicorp/random",
		"hashicorp/time",
		"hashicorp/cloudinit",
		"hashicorp/dns",
		"hashicorp/local",
		"hashicorp/null",
		"hashicorp/template",
		"aliyun/alicloud",
		"hetznercloud/hcloud",
	}
}

// AllowlistFromEnv reads ALETHIA_BYO_IAC_PROVIDER_ALLOWLIST (comma-separated
// provider source addresses) and falls back to the default set when the
// variable is unset or contains no usable entries.
func AllowlistFromEnv() []string {
	raw := os.Getenv(AllowlistEnvVar)
	if strings.TrimSpace(raw) == "" {
		return DefaultProviderAllowlist()
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return DefaultProviderAllowlist()
	}
	return out
}

// normalizeProviderSource canonicalizes a provider source address for
// allowlist comparison: lowercase, strip a known public registry host
// (registry.terraform.io / registry.opentofu.org), and expand a bare name to
// the implied hashicorp/<name>. Addresses on any OTHER registry host keep the
// host and therefore never match the host-less allowlist entries — unknown
// registries fail closed.
func normalizeProviderSource(src string) string {
	s := strings.ToLower(strings.TrimSpace(src))
	s = strings.TrimPrefix(s, "registry.terraform.io/")
	s = strings.TrimPrefix(s, "registry.opentofu.org/")
	if s != "" && !strings.Contains(s, "/") {
		s = "hashicorp/" + s
	}
	return s
}
