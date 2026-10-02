// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package kubeaccess

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"testing"
	"time"
)

// tableResolver answers from a map; a missing host is an NXDOMAIN-like error.
type tableResolver map[string][]string

// LookupNetIP answers host from the table.
func (r tableResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	addrs, ok := r[host]
	if !ok {
		return nil, errors.New("no such host")
	}
	out := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		out = append(out, netip.MustParseAddr(a))
	}
	return out, nil
}

// hangingResolver ignores ctx and never answers until released.
type hangingResolver struct{ release chan struct{} }

// LookupNetIP blocks until released, whatever ctx says.
func (r hangingResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	<-r.release
	return nil, errors.New("released")
}

// panicResolver fails the test if a lookup happens.
type panicResolver struct{ t *testing.T }

// LookupNetIP must not be reached.
func (r panicResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	r.t.Errorf("unexpected DNS lookup of %q", host)
	return nil, errors.New("unexpected")
}

// TestClassifyEndpoint_Table covers IP literals, URL and host:port forms, private hostname patterns
// and DNS answers.
func TestClassifyEndpoint_Table(t *testing.T) {
	dns := tableResolver{
		"eks-private.gr7.eu-west-1.eks.amazonaws.com": {"10.0.12.7", "10.0.44.9"},
		"eks-public.gr7.eu-west-1.eks.amazonaws.com":  {"3.248.10.1"},
		"mixed.example.com":                           {"10.0.0.5", "52.1.2.3"},
		"cgnat.example.com":                           {"100.100.1.1"},
		"v6-ula.example.com":                          {"fd12:3456::1"},
		"v6-public.example.com":                       {"2606:4700::6810:84e5"},
		"mapped.example.com":                          {"::ffff:192.168.1.1"},
		"empty.example.com":                           {},
	}
	cases := []struct {
		endpoint string
		want     EndpointReach
	}{
		// IP literals, every private range and its public neighbour.
		{"https://10.1.2.3", EndpointPrivate},
		{"https://172.16.0.1:6443", EndpointPrivate},
		{"https://172.31.255.254", EndpointPrivate},
		{"https://172.32.0.1", EndpointPublic},
		{"https://192.168.10.10/", EndpointPrivate},
		{"https://100.64.0.1", EndpointPrivate},
		{"https://100.127.255.254", EndpointPrivate},
		{"https://100.128.0.1", EndpointPublic},
		{"https://169.254.169.254", EndpointPrivate},
		{"https://127.0.0.1:6443", EndpointPrivate},
		{"https://0.0.0.0", EndpointPrivate},
		{"https://[::1]:6443", EndpointPrivate},
		{"https://[fd00::1]", EndpointPrivate},
		{"https://[fe80::1%25en0]:443", EndpointPrivate},
		{"https://[::ffff:10.0.0.1]", EndpointPrivate},
		{"https://[::ffff:100.64.0.1]", EndpointPrivate}, // CGNAT has no netip predicate; it needs the Unmap
		{"https://[2606:4700::1]", EndpointPublic},
		{"https://34.77.1.2", EndpointPublic},
		{"8.8.8.8", EndpointPublic},
		{"10.0.0.1:6443", EndpointPrivate},
		// Known private hostname patterns, no lookup needed.
		{"https://web-shop-dns-1a2b3c.privatelink.westeurope.azmk8s.io:443", EndpointPrivate},
		{"https://api.cluster.internal", EndpointPrivate},
		{"https://kubernetes.default.svc", EndpointPrivate},
		{"https://kubernetes.default.svc.cluster.local:443", EndpointPrivate},
		{"https://k8s.home.arpa", EndpointPrivate},
		{"https://LOCALHOST:6443", EndpointPrivate},
		{"https://api.k8s.local.", EndpointPrivate},
		// DNS.
		{"https://eks-private.gr7.eu-west-1.eks.amazonaws.com", EndpointPrivate},
		{"eks-public.gr7.eu-west-1.eks.amazonaws.com:443", EndpointPublic},
		{"https://mixed.example.com", EndpointPublic},
		{"https://cgnat.example.com", EndpointPrivate},
		{"https://v6-ula.example.com", EndpointPrivate},
		{"https://v6-public.example.com", EndpointPublic},
		{"https://mapped.example.com", EndpointPrivate},
		{"https://empty.example.com", EndpointUnknown},
		{"https://nxdomain.example.com", EndpointUnknown},
		// Not an endpoint.
		{"", EndpointUnknown},
		{"   ", EndpointUnknown},
		{"https://", EndpointUnknown},
		{"https://bad host/", EndpointUnknown},
	}
	for _, c := range cases {
		got := ClassifyEndpoint(context.Background(), c.endpoint, dns)
		if got.Reach != c.want {
			t.Errorf("ClassifyEndpoint(%q) = %s (%s), want %s", c.endpoint, got.Reach, got.Reason, c.want)
		}
		if got.Reason == "" {
			t.Errorf("ClassifyEndpoint(%q) gave no reason", c.endpoint)
		}
	}
}

// TestClassifyEndpoint_PatternsSkipDNS: an IP literal or a private-pattern hostname never queries.
func TestClassifyEndpoint_PatternsSkipDNS(t *testing.T) {
	for _, e := range []string{"https://10.0.0.1", "https://x.privatelink.eastus.azmk8s.io", "https://api.internal", "https://localhost"} {
		ClassifyEndpoint(context.Background(), e, panicResolver{t})
	}
}

// TestClassifyEndpoint_NeverBlocks: a resolver that ignores its context still cannot hold the caller
// past the caller's deadline, and the answer is Unknown.
func TestClassifyEndpoint_NeverBlocks(t *testing.T) {
	r := hangingResolver{release: make(chan struct{})}
	defer close(r.release)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	got := ClassifyEndpoint(ctx, "https://slow.example.com", r)
	if got.Reach != EndpointUnknown {
		t.Fatalf("got %s", got.Reach)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("blocked for %s", d)
	}
	// A nil resolver means the system one; a cancelled context makes the answer deterministic.
	done, stop := context.WithCancel(context.Background())
	stop()
	if got := ClassifyEndpoint(done, "https://example.com", nil); got.Reach != EndpointUnknown {
		t.Fatalf("cancelled lookup = %s", got.Reach)
	}
}

// TestPublicDNSResolver sends the query to the named server and nowhere else.
func TestPublicDNSResolver(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("no UDP listener: %v", err)
	}
	defer func() { _ = pc.Close() }()
	got := make(chan bool, 1)
	go func() {
		buf := make([]byte, 512)
		_ = pc.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _, err := pc.ReadFrom(buf)
		got <- err == nil
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if c := ClassifyEndpoint(ctx, "https://api.example.com", PublicDNSResolver(pc.LocalAddr().String())); c.Reach != EndpointUnknown {
		t.Fatalf("a server that never answers gave %s", c.Reach)
	}
	if !<-got {
		t.Fatal("the query never reached the configured DNS server")
	}
}

// TestEndpointReach_PrivateEndpoint maps onto the wire's nullable bool.
func TestEndpointReach_PrivateEndpoint(t *testing.T) {
	if p := EndpointPrivate.PrivateEndpoint(); p == nil || !*p {
		t.Error("private → true")
	}
	if p := EndpointPublic.PrivateEndpoint(); p == nil || *p {
		t.Error("public → false")
	}
	if EndpointUnknown.PrivateEndpoint() != nil || EndpointReach("garbage").PrivateEndpoint() != nil {
		t.Error("unknown → nil")
	}
}
