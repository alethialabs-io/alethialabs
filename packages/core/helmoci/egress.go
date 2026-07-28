// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package helmoci

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
	"time"

	"oras.land/oras-go/v2/registry/remote/retry"
)

// A chart reference is CUSTOMER-CONTROLLED (project_addons.chart_repo) and the pull runs in the
// runner's trusted PARENT — outside the deny-all-egress sandbox, in the process that on the managed
// fleet holds the storage master key and the bootstrap token. That makes an unrestricted dial here
// a server-side request forgery primitive aimed at exactly the target the sandbox exists to deny:
// 169.254.169.254, "the metadata firehose" (see packages/core/sandbox/container.go and the
// managed-runner note in apps/runner/internal/agent/runner.go).
//
// So the dial is filtered at CONNECT time, on the resolved address rather than the hostname. That
// closes DNS-based bypasses — a name that resolves to 169.254.169.254, and the rebinding case where
// resolution changes between check and connect — because Dialer.Control sees the address the socket
// is actually about to reach.
const allowPrivateEnv = "ALETHIA_HELM_REGISTRY_ALLOW_PRIVATE"

// allowInsecureLocalRegistries is a TEST-ONLY escape hatch letting a test reach an httptest server
// on loopback over plain HTTP. It is never set from configuration and never from a chart reference,
// so a customer cannot turn it on.
var allowInsecureLocalRegistries = false

// cleanuper is the sliver of *testing.T this package needs. Taking it (rather than *testing.T)
// keeps `testing` out of the production dependency graph while still making
// AllowLocalRegistriesForTesting effectively uncallable from non-test code.
type cleanuper interface{ Cleanup(func()) }

// AllowLocalRegistriesForTesting relaxes the chart-registry egress guard for the duration of one
// test, so a test can pull from an httptest registry on loopback over plain HTTP. It restores the
// previous state on cleanup.
//
// It is exported ONLY so tests in other packages (the runner's chart-scan tests) can stand up a fake
// registry. Production code must never call it: doing so would re-open the server-side request
// forgery path this guard exists to close.
func AllowLocalRegistriesForTesting(t cleanuper) {
	prev := allowInsecureLocalRegistries
	allowInsecureLocalRegistries = true
	t.Cleanup(func() { allowInsecureLocalRegistries = prev })
}

// allowPrivateRegistries reports whether the operator opted into private-network chart registries.
// A self-hosted deployment pulling from an internal Harbor or JFrog on RFC1918 space is a legitimate,
// catalogued scenario ("Harbor, JFrog, a self-hosted distribution"), so it must remain reachable —
// but only when the operator says so, and never on the managed fleet's default.
//
// Loopback and link-local are blocked even then: neither is ever a real chart registry, and
// link-local is the metadata address itself.
func allowPrivateRegistries() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(allowPrivateEnv)))
	return v == "1" || v == "true" || v == "yes"
}

// blockedRegistryAddress returns a non-empty reason when an address must not be dialed for a chart
// pull. Split out as a pure function so the policy is unit-testable without a network.
func blockedRegistryAddress(ip net.IP, allowPrivate bool) string {
	if ip == nil {
		return "the address could not be parsed"
	}
	// Normalise IPv4-in-IPv6 (::ffff:169.254.169.254) so a mapped address cannot slip past.
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	switch {
	case ip.IsLoopback():
		return "it is a loopback address"
	case ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast():
		// 169.254.0.0/16 and fe80::/10 — the cloud metadata service lives here.
		return "it is a link-local address (cloud instance metadata)"
	case ip.IsUnspecified():
		return "it is the unspecified address"
	case ip.IsMulticast(), ip.IsInterfaceLocalMulticast():
		return "it is a multicast address"
	case ip.IsPrivate():
		if allowPrivate {
			return ""
		}
		return "it is a private address (set " + allowPrivateEnv + "=1 to allow an internal registry)"
	}
	return ""
}

// registryHTTPClient builds the HTTP client used for every chart-registry request: oras's retry
// policy over a transport whose dialer refuses non-public addresses.
func registryHTTPClient() *http.Client {
	allowPrivate := allowPrivateRegistries()
	dialer := &net.Dialer{
		Timeout:   15 * time.Second,
		KeepAlive: 30 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			if allowInsecureLocalRegistries {
				return nil
			}
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return fmt.Errorf("refusing to dial chart registry address %q: %w", address, err)
			}
			if reason := blockedRegistryAddress(net.ParseIP(host), allowPrivate); reason != "" {
				return fmt.Errorf("refusing to dial chart registry at %s: %s", host, reason)
			}
			return nil
		},
	}

	base := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	return &http.Client{
		Transport: retry.NewTransport(base),
		Timeout:   5 * time.Minute,
	}
}
