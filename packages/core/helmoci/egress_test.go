// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package helmoci

import (
	"context"
	"net"
	"strings"
	"testing"
)

// allowLocalRegistriesForTest opens the test-only escape hatch for the duration of one test, so the
// package's httptest registries on loopback are reachable. Restored automatically.
func allowLocalRegistriesForTest(t *testing.T) {
	t.Helper()
	AllowLocalRegistriesForTesting(t)
}

// TestBlockedRegistryAddress is the SSRF policy table. A chart reference is customer-controlled and
// the pull runs in the runner's TRUSTED PARENT — outside the deny-all-egress sandbox, in the process
// that on the managed fleet holds the storage master key and bootstrap token. Every address family
// the sandbox exists to deny must be refused here too.
func TestBlockedRegistryAddress(t *testing.T) {
	tests := []struct {
		name         string
		ip           string
		allowPrivate bool
		wantBlocked  bool
		wantReason   string
	}{
		// The whole point: 169.254.169.254 is the cloud metadata service.
		{name: "IMDS", ip: "169.254.169.254", wantBlocked: true, wantReason: "link-local"},
		{name: "IMDS even with private allowed", ip: "169.254.169.254", allowPrivate: true, wantBlocked: true, wantReason: "link-local"},
		{name: "IPv4-mapped IMDS", ip: "::ffff:169.254.169.254", wantBlocked: true, wantReason: "link-local"},
		{name: "IPv6 link-local", ip: "fe80::1", wantBlocked: true, wantReason: "link-local"},

		{name: "loopback v4", ip: "127.0.0.1", wantBlocked: true, wantReason: "loopback"},
		{name: "loopback v4 alt", ip: "127.9.9.9", wantBlocked: true, wantReason: "loopback"},
		{name: "loopback v6", ip: "::1", wantBlocked: true, wantReason: "loopback"},
		{name: "loopback even with private allowed", ip: "127.0.0.1", allowPrivate: true, wantBlocked: true, wantReason: "loopback"},

		{name: "unspecified", ip: "0.0.0.0", wantBlocked: true, wantReason: "unspecified"},
		// 224.0.0.0/24 is link-local multicast, so it trips the link-local case first; 239/8 is
		// organization-local multicast and reaches the multicast case. Both must be blocked.
		{name: "link-local multicast", ip: "224.0.0.1", wantBlocked: true, wantReason: "link-local"},
		{name: "multicast", ip: "239.1.2.3", wantBlocked: true, wantReason: "multicast"},
		// ff02:: is link-local scope (caught earlier); ff0e:: is global-scope multicast.
		{name: "ipv6 link-local multicast", ip: "ff02::1", wantBlocked: true, wantReason: "link-local"},
		{name: "ipv6 global multicast", ip: "ff0e::1", wantBlocked: true, wantReason: "multicast"},

		// Private space is blocked by default (managed fleet) but is a legitimate self-hosted
		// registry location, so the operator can opt in.
		{name: "rfc1918 10/8 default", ip: "10.0.0.5", wantBlocked: true, wantReason: "private"},
		{name: "rfc1918 172.16/12 default", ip: "172.16.0.5", wantBlocked: true, wantReason: "private"},
		{name: "rfc1918 192.168/16 default", ip: "192.168.1.5", wantBlocked: true, wantReason: "private"},
		{name: "ipv6 ULA default", ip: "fd00::1", wantBlocked: true, wantReason: "private"},
		{name: "rfc1918 allowed by operator", ip: "10.0.0.5", allowPrivate: true, wantBlocked: false},
		{name: "ipv6 ULA allowed by operator", ip: "fd00::1", allowPrivate: true, wantBlocked: false},

		// Real registries.
		{name: "public v4", ip: "140.82.121.4", wantBlocked: false},
		{name: "public v6", ip: "2606:50c0::1", wantBlocked: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			reason := blockedRegistryAddress(net.ParseIP(tc.ip), tc.allowPrivate)
			if tc.wantBlocked && reason == "" {
				t.Fatalf("blockedRegistryAddress(%s, allowPrivate=%v) allowed it, want blocked", tc.ip, tc.allowPrivate)
			}
			if !tc.wantBlocked && reason != "" {
				t.Fatalf("blockedRegistryAddress(%s, allowPrivate=%v) blocked it (%s), want allowed", tc.ip, tc.allowPrivate, reason)
			}
			if tc.wantReason != "" && !strings.Contains(reason, tc.wantReason) {
				t.Fatalf("reason = %q, want it to mention %q", reason, tc.wantReason)
			}
		})
	}
}

// TestBlockedRegistryAddress_UnparseableFailsClosed proves the guard denies rather than allows when
// it cannot make sense of an address.
func TestBlockedRegistryAddress_UnparseableFailsClosed(t *testing.T) {
	if reason := blockedRegistryAddress(nil, true); reason == "" {
		t.Fatal("an unparseable address was allowed, want fail-closed")
	}
}

// TestAllowPrivateRegistries covers the operator opt-in parsing, including that anything else means
// "no" — a typo'd value must not silently open private-network egress.
func TestAllowPrivateRegistries(t *testing.T) {
	for _, v := range []string{"1", "true", "TRUE", "yes", " true "} {
		t.Setenv(allowPrivateEnv, v)
		if !allowPrivateRegistries() {
			t.Errorf("allowPrivateRegistries() = false for %q, want true", v)
		}
	}
	for _, v := range []string{"", "0", "false", "no", "maybe", "on"} {
		t.Setenv(allowPrivateEnv, v)
		if allowPrivateRegistries() {
			t.Errorf("allowPrivateRegistries() = true for %q, want false", v)
		}
	}
}

// TestPullRefusesMetadataService is the end-to-end proof that a hostile chart reference cannot make
// the runner dial the cloud metadata service. The dial is filtered at CONNECT time on the resolved
// address, so this holds for a hostname that resolves there too, not just the literal IP.
func TestPullRefusesMetadataService(t *testing.T) {
	ref, err := ParseChartRef("oci://169.254.169.254/acme/charts/demo", "1.0.0")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	_, err = Pull(context.Background(), ref, Creds{}, t.TempDir())
	if err == nil {
		t.Fatal("pull from the metadata address succeeded, want it refused")
	}
	if !strings.Contains(err.Error(), "refusing to dial") {
		t.Fatalf("error = %v, want the egress guard to refuse it", err)
	}
}

// TestPullRefusesLoopback proves a customer cannot point the scan at a service on the runner host.
func TestPullRefusesLoopback(t *testing.T) {
	ref, err := ParseChartRef("oci://127.0.0.1:9/acme/charts/demo", "1.0.0")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	_, err = Pull(context.Background(), ref, Creds{}, t.TempDir())
	if err == nil {
		t.Fatal("pull from loopback succeeded, want it refused")
	}
	if !strings.Contains(err.Error(), "refusing to dial") {
		t.Fatalf("error = %v, want the egress guard to refuse it", err)
	}
}

// TestRegistryClientKeepsTLSByDefault locks the transport shape: a customer-supplied reference must
// never be able to select plain HTTP, which would put the chart-repo credential on the wire in the
// clear.
func TestRegistryClientKeepsTLSByDefault(t *testing.T) {
	if allowInsecureLocalRegistries {
		t.Fatal("the plain-HTTP escape hatch is on by default — it must be test-only")
	}
	ref, err := ParseChartRef("oci://ghcr.io/acme/redis", "1.0.0")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	repo, err := newRepository(ref, Creds{Username: "u", Password: "p"})
	if err != nil {
		t.Fatalf("newRepository: %v", err)
	}
	if repo.PlainHTTP {
		t.Fatal("PlainHTTP is set for a public registry — the credential would go out unencrypted")
	}
}
