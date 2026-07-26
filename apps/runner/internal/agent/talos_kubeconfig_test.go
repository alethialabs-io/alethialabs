// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"testing"

	talosconfig "github.com/siderolabs/talos/pkg/machinery/client/config"
)

// TestAssertSafeTalosEndpoints locks the SSRF guard (runner-parent-ssrf rule): a link-local (cloud
// metadata) / loopback / unspecified endpoint from a customer-influenced talosconfig must be refused
// before the trusted runner dials, while public and private (self-hosted) control-plane IPs pass.
func TestAssertSafeTalosEndpoints(t *testing.T) {
	mk := func(eps ...string) *talosconfig.Config {
		return &talosconfig.Config{
			Context:  "c",
			Contexts: map[string]*talosconfig.Context{"c": {Endpoints: eps}},
		}
	}

	reject := map[string]*talosconfig.Config{
		"link-local cloud metadata": mk("169.254.169.254"),
		"link-local with port":      mk("169.254.169.254:50000"),
		"loopback":                  mk("127.0.0.1:50000"),
		"unspecified":               mk("0.0.0.0"),
		"empty endpoints":           mk(),
		"missing active context":    {Context: "missing", Contexts: map[string]*talosconfig.Context{}},
		"one bad among good":        mk("203.0.113.10", "169.254.169.254"),
	}
	for name, cfg := range reject {
		if err := assertSafeTalosEndpoints(cfg); err == nil {
			t.Errorf("%s: expected rejection, got nil", name)
		}
	}

	allow := map[string]*talosconfig.Config{
		"public ip":           mk("203.0.113.10"),
		"public ip with port": mk("203.0.113.10:50000"),
		"private rfc1918":     mk("10.0.0.5"), // self-hosted private control plane is legitimate
		"private 172.16":      mk("172.16.4.4:50000"),
	}
	for name, cfg := range allow {
		if err := assertSafeTalosEndpoints(cfg); err != nil {
			t.Errorf("%s: expected pass, got %v", name, err)
		}
	}
}
