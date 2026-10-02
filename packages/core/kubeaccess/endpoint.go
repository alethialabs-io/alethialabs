// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package kubeaccess

import (
	"context"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// Private-endpoint detection (#5250 decision 6): a mint goes ahead whatever the answer, and the CLI
// and the console card say plainly when reaching the API server needs network access (VPN,
// bastion) the user may not have. So the classifier is advisory and must never block a mint: it
// has a hard time budget, and any failure is Unknown, not an error.

// EndpointReach is the tri-state answer.
type EndpointReach string

const (
	// EndpointPublic means the endpoint resolves to at least one publicly routable address.
	EndpointPublic EndpointReach = "public"
	// EndpointPrivate means every address it resolves to is private (RFC 1918, ULA fc00::/7, CGNAT
	// 100.64.0.0/10, link-local, loopback or unspecified), or its hostname is a known private-endpoint
	// pattern.
	EndpointPrivate EndpointReach = "private"
	// EndpointUnknown means it could not be decided: unparsable, unresolvable, or out of time.
	EndpointUnknown EndpointReach = "unknown"
)

// PrivateEndpoint maps the answer onto the wire's nullable private_endpoint (types.
// KubeconfigMintPollResponse): true, false, or nil when unknown.
func (r EndpointReach) PrivateEndpoint() *bool {
	var v bool
	switch r {
	case EndpointPrivate:
		v = true
	case EndpointPublic:
		v = false
	case EndpointUnknown:
		return nil
	default:
		return nil
	}
	return &v
}

// EndpointClassification is the answer with a one-line reason a person can read.
type EndpointClassification struct {
	Reach  EndpointReach
	Reason string
}

// Resolver looks a host up. *net.Resolver satisfies it; tests inject a table.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// EndpointClassifyTimeout is the most ClassifyEndpoint spends resolving, whatever ctx allows.
const EndpointClassifyTimeout = 2 * time.Second

// cgnat is the RFC 6598 shared address space, which netip has no predicate for.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// privateHostSuffixes are hostnames that only resolve inside a private network: Azure Private Link
// for AKS private clusters (<name>.privatelink.<region>.azmk8s.io), the cloud-internal and mDNS
// zones, in-cluster service DNS and the RFC 8375 home zone.
var privateHostSuffixes = []string{
	".internal", ".local", ".localdomain", ".home.arpa", ".svc", ".cluster.local",
}

// privateHostMarkers are hostname fragments that identify a private endpoint wherever they appear.
var privateHostMarkers = []string{".privatelink."}

// isPrivateAddr reports whether a is not publicly routable.
func isPrivateAddr(a netip.Addr) bool {
	a = a.Unmap()
	return a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() || a.IsUnspecified() || cgnat.Contains(a)
}

// endpointHost extracts the host from an API endpoint given as a URL (https://host:443/path) or as
// a bare host[:port], the forms clouds report. IPv6 brackets and zones are removed.
func endpointHost(endpoint string) string {
	s := strings.TrimSpace(endpoint)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	h := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if i := strings.IndexByte(h, '%'); i >= 0 {
		h = h[:i]
	}
	return h
}

// PublicDNSResolver returns a resolver that sends every query to one DNS server (host:port, e.g.
// "1.1.1.1:53") instead of the machine's own. The runner needs it: it runs INSIDE the cluster's
// network (decision 8), where a split-horizon zone answers differently from the internet — an EKS
// cluster with both public and private access resolves to private addresses from inside its VPC,
// and would read as private to a user who can in fact reach it. Classify as the user would see it.
func PublicDNSResolver(server string) *net.Resolver {
	return &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, server)
		},
	}
}

// ClassifyEndpoint decides whether an API server endpoint is reachable only from a private network.
// An IP literal is classified directly; a hostname matching a known private pattern is private
// without a lookup; any other hostname is resolved through resolver (nil means net.DefaultResolver)
// within EndpointClassifyTimeout, and is private only if EVERY address is private. It never returns
// an error and never waits past the budget: anything undecidable is EndpointUnknown.
func ClassifyEndpoint(ctx context.Context, endpoint string, resolver Resolver) EndpointClassification {
	host := endpointHost(endpoint)
	if host == "" {
		return EndpointClassification{EndpointUnknown, "the endpoint has no host"}
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		if isPrivateAddr(addr) {
			return EndpointClassification{EndpointPrivate, "the endpoint is the private address " + addr.String()}
		}
		return EndpointClassification{EndpointPublic, "the endpoint is the public address " + addr.String()}
	}
	if host == "localhost" {
		return EndpointClassification{EndpointPrivate, "the endpoint is localhost"}
	}
	for _, suf := range privateHostSuffixes {
		if strings.HasSuffix(host, suf) {
			return EndpointClassification{EndpointPrivate, "the hostname is in the private zone " + strings.TrimPrefix(suf, ".")}
		}
	}
	for _, m := range privateHostMarkers {
		if strings.Contains(host, m) {
			return EndpointClassification{EndpointPrivate, "the hostname is a Private Link endpoint"}
		}
	}
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	ctx, cancel := context.WithTimeout(ctx, EndpointClassifyTimeout)
	defer cancel()
	type result struct {
		addrs []netip.Addr
		err   error
	}
	// The lookup runs in its own goroutine so a resolver that ignores ctx still cannot hold the
	// caller past the budget; the buffered channel lets it finish and be collected.
	done := make(chan result, 1)
	go func() {
		addrs, err := resolver.LookupNetIP(ctx, "ip", host)
		done <- result{addrs, err}
	}()
	var res result
	select {
	case res = <-done:
	case <-ctx.Done():
		return EndpointClassification{EndpointUnknown, "resolving " + host + " did not finish in time"}
	}
	if res.err != nil || len(res.addrs) == 0 {
		return EndpointClassification{EndpointUnknown, host + " did not resolve"}
	}
	for _, a := range res.addrs {
		if !isPrivateAddr(a) {
			return EndpointClassification{EndpointPublic, host + " resolves to the public address " + a.Unmap().String()}
		}
	}
	return EndpointClassification{EndpointPrivate, host + " resolves only to private addresses"}
}
