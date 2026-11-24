// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

// The repository URLs a runner clones from, pulls from and pushes to.
//
// A repository URL reaches the runner inside a job (ANALYZE_REPO's config_snapshot.repo_url, a BYO
// IaC source, a chart or app repository, the GitOps apps repository), so the runner holds the rule
// itself rather than trusting whatever enqueued the job. The rule mirrors the console's check for a
// scan URL (apps/console/lib/scanner/repo-url.ts, whose address classes come from
// apps/console/lib/net/ssrf-guard.ts), so both sides agree on what a public repository host is:
//
//   - transport: https:// only, plus ssh:// and scp-style git@host:path where the caller sets
//     RepoURLOptions.AllowSSH. Every other scheme (file://, git://, http://, …) is refused.
//   - no credentials in the URL: an https URL carries no userinfo at all; an ssh URL may name its
//     login user (git@…) but never a password. Tokens travel as auth, never inside the URL.
//   - the host is a public name: not localhost / *.localhost / *.local / internal / *.internal, a
//     syntactically valid DNS name (so numeric forms such as 2130706433 or 0x7f.1 never reach a
//     resolver that would read them as an address), or a literal public unicast IP.
//   - every address the name resolves to is public unicast (see isPublicUnicast).
//
// Operators of a self-hosted runner whose Git server lives on a private network allow it explicitly
// with ALETHIA_GIT_ALLOWED_HOSTS (AllowedHostsEnv). It is empty by default.
//
// Where the rule is enforced: GIT.Clone, GIT.CloneAndCheckoutCommit, GIT.Pull and GIT.Push check
// their remote before any network call, so every clone path in the runner and the provisioner holds
// it. For https the rule is ALSO enforced at connect time: the go-git https/http transport is
// replaced with one whose dialer resolves the host, checks every address and connects to an address
// it checked, so a second DNS answer cannot steer the connection elsewhere, and a redirect to
// another host is checked the same way. go-git's ssh transport dials by host name and offers no
// dialer seam, so for ssh the check runs immediately before the clone; that window is the residual.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-git/go-git/v5/plumbing/transport/client"
	githttp "github.com/go-git/go-git/v5/plumbing/transport/http"
)

// AllowedHostsEnv names the operator allowlist: a comma- or space-separated list of entries, each an
// exact host name (git.corp.example), a wildcard suffix (*.corp.example), an IP address or a CIDR
// (10.20.0.0/16, fd00::/8). A host named by a name entry is cloned without the local-name and
// address checks; an address inside an IP/CIDR entry passes the address check. Transport and
// credential rules still apply to allowed hosts. An entry that is none of these refuses every clone,
// so a typo is visible instead of silently ignored.
const AllowedHostsEnv = "ALETHIA_GIT_ALLOWED_HOSTS"

// ErrRepoURLRefused is wrapped by every refusal of a repository URL.
var ErrRepoURLRefused = errors.New("repository URL not accepted")

// RepoURLOptions are the per-call-site choices of the repository URL rule.
type RepoURLOptions struct {
	// AllowSSH admits ssh:// and scp-style git@host:path remotes. Only the BYO IaC paths set it
	// (IAC_SCAN and the BYO deploy/destroy/drift/import clone), because those are the remotes a
	// customer may reach with a deploy key through a self-hosted runner's SSH agent. Every other path
	// clones over https.
	AllowSSH bool
}

// Resolver resolves a host name to addresses. *net.Resolver satisfies it; tests pass a fake.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// resolveTimeout bounds one resolution, so a slow resolver cannot hold a job past its own budget.
const resolveTimeout = 10 * time.Second

// forcedChecks counts the tests that asked for the rule to be enforced in a test binary.
var forcedChecks atomic.Int32

// resolverBox lets a Resolver interface value live in an atomic.Pointer.
type resolverBox struct{ r Resolver }

// testResolver, when set, replaces net.DefaultResolver (EnforceRepoURLChecksForTest).
var testResolver atomic.Pointer[resolverBox]

// checksActive reports whether the repository URL rule is enforced. It always is in a production
// binary. In a test binary (testing.Testing) it is enforced only while a test holds
// EnforceRepoURLChecksForTest: the package tests across the tree clone file:// fixtures and talk to
// loopback httptest servers, which is exactly what the rule refuses. testing.Testing is false in
// every binary that is not built by `go test`, so this cannot relax the rule in a runner.
func checksActive() bool {
	return !testing.Testing() || forcedChecks.Load() > 0
}

// currentResolver returns the resolver the rule uses.
func currentResolver() Resolver {
	if b := testResolver.Load(); b != nil {
		return b.r
	}
	return net.DefaultResolver
}

// EnforceRepoURLChecksForTest enforces the repository URL rule for the rest of the calling test,
// resolving names with r (nil keeps net.DefaultResolver). It is the only way to turn the rule on in a
// test binary; tests that call it must not run in parallel with fixture tests in the same package.
func EnforceRepoURLChecksForTest(t testing.TB, r Resolver) {
	t.Helper()
	prev := testResolver.Load()
	if r != nil {
		testResolver.Store(&resolverBox{r: r})
	}
	forcedChecks.Add(1)
	t.Cleanup(func() {
		forcedChecks.Add(-1)
		testResolver.Store(prev)
	})
}

// ValidateRepoURL checks raw against the repository URL rule and returns an error wrapping
// ErrRepoURLRefused when it does not pass. It resolves the host. In a test binary it accepts every
// URL unless EnforceRepoURLChecksForTest is active (see checksActive).
func ValidateRepoURL(ctx context.Context, raw string, opts RepoURLOptions) error {
	if !checksActive() {
		return nil
	}
	allow, err := envAllowlist()
	if err != nil {
		return err
	}
	installPinnedTransport()
	return validateRepoURL(ctx, raw, opts, currentResolver(), allow)
}

// refused builds a refusal that wraps ErrRepoURLRefused.
func refused(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrRepoURLRefused, fmt.Sprintf(format, args...))
}

// useHTTPS is the sentence a transport refusal ends with: it says what to pass instead.
const useHTTPS = "use the repository's https:// URL, for example https://github.com/owner/name"

// validateRepoURL is ValidateRepoURL with its resolver and allowlist passed in.
func validateRepoURL(ctx context.Context, raw string, opts RepoURLOptions, r Resolver, allow allowlist) error {
	host, err := remoteHost(raw, opts)
	if err != nil {
		return err
	}
	_, err = checkHost(ctx, host, r, allow)
	return err
}

// remoteHost applies the transport and credential rules to raw and returns its host name.
func remoteHost(raw string, opts RepoURLOptions) (string, error) {
	s := normalizeRepoURL(raw)
	if s == "" {
		return "", refused("the repository URL is empty; %s", useHTTPS)
	}
	if !strings.Contains(s, "://") {
		// normalizeRepoURL keeps only the scp-style git@host:path form without a scheme.
		if !opts.AllowSSH {
			return "", refused("only https:// repository URLs are cloned here; %s", useHTTPS)
		}
		rest := strings.TrimPrefix(s, "git@")
		i := strings.Index(rest, ":")
		if i <= 0 || strings.ContainsAny(rest[:i], "@/[]") {
			return "", refused("the repository URL %s has no valid host", RedactURL(raw))
		}
		return rest[:i], nil
	}
	u, err := url.Parse(s)
	if err != nil || u.Opaque != "" {
		return "", refused("the repository URL could not be parsed; %s", useHTTPS)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		if u.User != nil {
			return "", refused("leave credentials out of the repository URL; a private repository is read through its connected git account")
		}
	case "ssh":
		if !opts.AllowSSH {
			return "", refused("only https:// repository URLs are cloned here; %s", useHTTPS)
		}
		if u.User != nil {
			if _, hasPassword := u.User.Password(); hasPassword {
				return "", refused("leave the password out of the repository URL; ssh remotes authenticate with a key")
			}
		}
	default:
		if opts.AllowSSH {
			return "", refused("only https:// and ssh:// repository URLs are cloned here; %s", useHTTPS)
		}
		return "", refused("only https:// repository URLs are cloned here; %s", useHTTPS)
	}
	if u.Hostname() == "" {
		return "", refused("the repository URL %s has no host", RedactURL(raw))
	}
	return u.Hostname(), nil
}

// checkHost applies the host rules to host and returns the addresses it may be reached at. A nil
// slice with a nil error means the host is admitted by name through the operator allowlist and is
// dialled as is.
func checkHost(ctx context.Context, host string, r Resolver, allow allowlist) ([]netip.Addr, error) {
	h := strings.ToLower(strings.TrimSuffix(host, "."))
	if h == "" {
		return nil, refused("the repository URL has no host")
	}
	if addr, err := netip.ParseAddr(strings.Trim(h, "[]")); err == nil {
		addr = addr.WithZone("")
		if allow.admitsAddr(addr) || isPublicUnicast(addr) {
			return []netip.Addr{addr}, nil
		}
		return nil, refused("%s is not a public repository host; %s", h, useHTTPS)
	}
	if allow.admitsName(h) {
		return nil, nil
	}
	if isLocalName(h) || !isDNSName(h) {
		return nil, refused("%s is not a public repository host; %s", h, useHTTPS)
	}
	rctx, cancel := context.WithTimeout(ctx, resolveTimeout)
	defer cancel()
	addrs, err := r.LookupNetIP(rctx, "ip", h)
	if err != nil || len(addrs) == 0 {
		return nil, refused("the repository host %s could not be resolved", h)
	}
	out := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		a = a.WithZone("")
		if !allow.admitsAddr(a) && !isPublicUnicast(a) {
			// The refusal never says what the host resolved to.
			return nil, refused("%s is not a public repository host; %s", h, useHTTPS)
		}
		out = append(out, a)
	}
	return out, nil
}

// isLocalName reports whether h is a name that never names a public repository host.
func isLocalName(h string) bool {
	return h == "localhost" || strings.HasSuffix(h, ".localhost") ||
		strings.HasSuffix(h, ".local") ||
		h == "internal" || strings.HasSuffix(h, ".internal")
}

// isDNSName reports whether h is an ASCII DNS host name: dot-separated labels of letters, digits and
// inner hyphens, at most 253 characters, whose last label is not all digits. The last rule keeps
// numeric host forms (2130706433, 127.1, 0x7f.1) away from resolvers that would read them as an
// address.
func isDNSName(h string) bool {
	if h == "" || len(h) > 253 {
		return false
	}
	labels := strings.Split(h, ".")
	for _, l := range labels {
		if l == "" || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
			return false
		}
		for i := 0; i < len(l); i++ {
			c := l[i]
			if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
				return false
			}
		}
	}
	last := labels[len(labels)-1]
	return strings.Trim(last, "0123456789") != ""
}

// mustPrefixes parses a fixed list of CIDRs; it panics on a malformed literal, which a test catches.
func mustPrefixes(cidrs ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(cidrs))
	for i, c := range cidrs {
		out[i] = netip.MustParsePrefix(c)
	}
	return out
}

// nonPublicV4 is every IPv4 range that is not public unicast — the same list as the console's
// isPublicUnicastV4 (apps/console/lib/net/ssrf-guard.ts).
var nonPublicV4 = mustPrefixes(
	"0.0.0.0/8",       // "this network" / unspecified
	"10.0.0.0/8",      // private
	"127.0.0.0/8",     // loopback
	"169.254.0.0/16",  // link-local, including the cloud metadata address 169.254.169.254
	"172.16.0.0/12",   // private
	"192.168.0.0/16",  // private
	"100.64.0.0/10",   // carrier-grade NAT
	"192.0.0.0/24",    // IETF protocol assignments
	"192.0.2.0/24",    // TEST-NET-1
	"192.88.99.0/24",  // 6to4 relay anycast
	"198.18.0.0/15",   // benchmarking
	"198.51.100.0/24", // TEST-NET-2
	"203.0.113.0/24",  // TEST-NET-3
	"224.0.0.0/4",     // multicast
	"240.0.0.0/4",     // reserved, including broadcast
)

// nonPublicV6 is every IPv6 range that is not public unicast and carries no embedded IPv4 to
// re-classify — the same list as the console's isPublicUnicastV6.
var nonPublicV6 = mustPrefixes(
	"fc00::/7",      // unique-local (ULA)
	"fe80::/10",     // link-local
	"fec0::/10",     // site-local (deprecated)
	"ff00::/8",      // multicast
	"2001:db8::/32", // documentation
	"2001::/32",     // Teredo
	"100::/64",      // discard
)

// nat64 is the well-known NAT64 prefix; its last 32 bits are an IPv4 address.
var nat64 = netip.MustParsePrefix("64:ff9b::/96")

// sixToFour is the 6to4 prefix; its next 32 bits are an IPv4 address.
var sixToFour = netip.MustParsePrefix("2002::/16")

// isPublicUnicast reports whether a is a public, globally routable unicast address. IPv4-mapped,
// IPv4-compatible, NAT64 and 6to4 IPv6 forms are unwrapped and their IPv4 re-classified.
func isPublicUnicast(a netip.Addr) bool {
	a = a.WithZone("")
	if !a.IsValid() {
		return false
	}
	if a.Is4In6() {
		a = a.Unmap()
	}
	if a.Is4() {
		return isPublicV4(a)
	}
	b := a.As16()
	if allZero(b[:12]) {
		v4 := netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]})
		if v4 == netip.AddrFrom4([4]byte{}) || v4 == netip.AddrFrom4([4]byte{0, 0, 0, 1}) {
			return false // :: unspecified, ::1 loopback
		}
		return isPublicV4(v4) // IPv4-compatible (deprecated)
	}
	if nat64.Contains(a) {
		return isPublicV4(netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
	}
	if sixToFour.Contains(a) {
		return isPublicV4(netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]}))
	}
	for _, p := range nonPublicV6 {
		if p.Contains(a) {
			return false
		}
	}
	// The rest of 0000::/8 is reserved; global unicast is 2000::/3.
	return b[0] != 0
}

// isPublicV4 reports whether the IPv4 address a is public unicast.
func isPublicV4(a netip.Addr) bool {
	for _, p := range nonPublicV4 {
		if p.Contains(a) {
			return false
		}
	}
	return true
}

// allZero reports whether every byte of b is zero.
func allZero(b []byte) bool {
	for _, x := range b {
		if x != 0 {
			return false
		}
	}
	return true
}

// allowlist is the parsed operator allowlist (AllowedHostsEnv).
type allowlist struct {
	names    []string
	suffixes []string
	prefixes []netip.Prefix
}

// parseAllowlist parses AllowedHostsEnv's value. An entry it cannot read is an error that wraps
// ErrRepoURLRefused, so a misconfigured allowlist refuses clones instead of being ignored.
func parseAllowlist(v string) (allowlist, error) {
	var a allowlist
	for _, f := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' }) {
		e := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(f), "."))
		if p, err := netip.ParsePrefix(e); err == nil {
			a.prefixes = append(a.prefixes, p.Masked())
			continue
		}
		if ip, err := netip.ParseAddr(e); err == nil {
			ip = ip.WithZone("").Unmap()
			a.prefixes = append(a.prefixes, netip.PrefixFrom(ip, ip.BitLen()))
			continue
		}
		if strings.HasPrefix(e, "*.") && isDNSName(e[2:]) {
			a.suffixes = append(a.suffixes, e[1:])
			continue
		}
		if isDNSName(e) {
			a.names = append(a.names, e)
			continue
		}
		return allowlist{}, refused("%s entry %q is not a host name, *.suffix, IP address or CIDR", AllowedHostsEnv, f)
	}
	return a, nil
}

// admitsName reports whether the allowlist names host h.
func (a allowlist) admitsName(h string) bool {
	for _, n := range a.names {
		if h == n {
			return true
		}
	}
	for _, s := range a.suffixes {
		if strings.HasSuffix(h, s) {
			return true
		}
	}
	return false
}

// admitsAddr reports whether addr falls inside an allowlisted IP or CIDR.
func (a allowlist) admitsAddr(addr netip.Addr) bool {
	addr = addr.WithZone("")
	for _, p := range a.prefixes {
		if p.Contains(addr) || (addr.Is4In6() && p.Contains(addr.Unmap())) {
			return true
		}
	}
	return false
}

// pinOnce installs the connect-time transport once per process.
var pinOnce sync.Once

// installPinnedTransport replaces go-git's https and http transports with one whose dialer applies
// the host rules at connect time (pinnedDialer). It runs on the first enforced check, so a process
// that never clones keeps go-git's default transport, and so does a test binary that never enforces.
func installPinnedTransport() {
	pinOnce.Do(func() {
		d := &pinnedDialer{
			dial:     (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			resolver: currentResolver,
			allow:    envAllowlist,
		}
		c := githttp.NewClient(&http.Client{Transport: newPinnedTransport(http.DefaultTransport, d)})
		client.InstallProtocol("https", c)
		client.InstallProtocol("http", c)
	})
}

// envAllowlist parses the operator allowlist from AllowedHostsEnv.
func envAllowlist() (allowlist, error) {
	return parseAllowlist(os.Getenv(AllowedHostsEnv))
}

// newPinnedTransport returns a clone of base (keeping its proxy, TLS and timeout settings; a base
// that is not an *http.Transport is replaced by one that reads the proxy from the environment) whose
// connections go through d. The proxy hook records every proxy address the transport picks, so d
// connects to a configured proxy as is: with a proxy in the path the proxy resolves the repository
// host, and the check made before the clone is what holds the rule.
func newPinnedTransport(base http.RoundTripper, d *pinnedDialer) *http.Transport {
	var tr *http.Transport
	if b, ok := base.(*http.Transport); ok {
		tr = b.Clone()
	} else {
		tr = &http.Transport{Proxy: http.ProxyFromEnvironment}
	}
	proxyFn := tr.Proxy
	tr.Proxy = func(req *http.Request) (*url.URL, error) {
		if proxyFn == nil {
			return nil, nil
		}
		u, err := proxyFn(req)
		if u != nil {
			d.proxies.Store(proxyAddr(u), struct{}{})
		}
		return u, err
	}
	tr.DialContext = d.DialContext
	return tr
}

// proxyAddr is the host:port net/http dials for proxy URL u.
func proxyAddr(u *url.URL) string {
	port := u.Port()
	if port == "" {
		switch strings.ToLower(u.Scheme) {
		case "https":
			port = "443"
		case "socks5", "socks5h":
			port = "1080"
		default:
			port = "80"
		}
	}
	return net.JoinHostPort(u.Hostname(), port)
}

// pinnedDialer connects only to addresses the host rules admit. It resolves the host itself, checks
// every address, and dials one of the checked addresses — never the name — so the address that was
// checked is the address that is connected to.
type pinnedDialer struct {
	dial     func(ctx context.Context, network, addr string) (net.Conn, error)
	resolver func() Resolver
	allow    func() (allowlist, error)
	proxies  sync.Map // host:port of every proxy the transport chose
}

// DialContext applies the host rules to addr and connects to a checked address.
func (d *pinnedDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if !checksActive() {
		return d.dial(ctx, network, addr)
	}
	if _, isProxy := d.proxies.Load(addr); isProxy {
		return d.dial(ctx, network, addr)
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, refused("cannot dial %q: %v", addr, err)
	}
	allow, err := d.allow()
	if err != nil {
		return nil, err
	}
	addrs, err := checkHost(ctx, host, d.resolver(), allow)
	if err != nil {
		return nil, err
	}
	if addrs == nil { // admitted by name through the operator allowlist
		return d.dial(ctx, network, addr)
	}
	var lastErr error
	for _, a := range addrs {
		conn, err := d.dial(ctx, network, net.JoinHostPort(a.String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}
