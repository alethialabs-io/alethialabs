// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"testing"

	gogit "github.com/go-git/go-git/v5"
)

// fakeResolver answers LookupNetIP from a fixed table; a name not in it fails to resolve.
type fakeResolver map[string][]string

// LookupNetIP returns the table's addresses for host.
func (f fakeResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	ips, ok := f[host]
	if !ok {
		return nil, errors.New("no such host")
	}
	out := make([]netip.Addr, 0, len(ips))
	for _, ip := range ips {
		out = append(out, netip.MustParseAddr(ip))
	}
	return out, nil
}

// publicDNS resolves the public names the tests accept, and the names that resolve somewhere they
// must not.
var publicDNS = fakeResolver{
	"github.com":             {"140.82.112.3"},
	"gitlab.com":             {"172.65.251.78", "2606:4700:90:0:f22e:fbec:5bed:a9b9"},
	"loopback.example.com":   {"127.0.0.1"},
	"private.example.com":    {"10.1.2.3"},
	"rfc1918b.example.com":   {"172.20.0.1"},
	"rfc1918c.example.com":   {"192.168.1.10"},
	"metadata.example.com":   {"169.254.169.254"},
	"cgnat.example.com":      {"100.64.0.7"},
	"ula.example.com":        {"fd00::1"},
	"linklocal6.example.com": {"fe80::1"},
	"loopback6.example.com":  {"::1"},
	"mixed.example.com":      {"140.82.112.3", "10.0.0.1"},
	"empty.example.com":      {},
	"git.corp.example":       {"10.20.0.5"},
	"mirror.corp.example":    {"10.20.0.6"},
}

// mustNotPass asserts err is a repository URL refusal.
func mustNotPass(t *testing.T, raw string, err error) {
	t.Helper()
	if err == nil {
		t.Fatalf("%q was accepted; want a refusal", raw)
	}
	if !errors.Is(err, ErrRepoURLRefused) {
		t.Fatalf("%q: error %v does not wrap ErrRepoURLRefused", raw, err)
	}
}

func TestValidateRepoURL_RefusedClasses(t *testing.T) {
	https := RepoURLOptions{}
	ssh := RepoURLOptions{AllowSSH: true}
	cases := []struct {
		name string
		raw  string
		opts RepoURLOptions
	}{
		{"empty", "  ", https},
		{"file scheme", "file:///etc/repo", https},
		{"file scheme with ssh allowed", "file:///etc/repo", ssh},
		{"git scheme", "git://github.com/owner/repo.git", https},
		{"git scheme with ssh allowed", "git://github.com/owner/repo.git", ssh},
		{"http scheme", "http://github.com/owner/repo", https},
		{"ssh where not allowed", "ssh://git@github.com/owner/repo.git", https},
		{"scp where not allowed", "git@github.com:owner/repo.git", https},
		{"scp with no host", "git@:owner/repo.git", ssh},
		{"scp with no colon", "git@github.com", ssh},
		{"scp with a slash in the host", "git@a/b:owner/repo", ssh},
		{"userinfo user and password", "https://user:secret@github.com/owner/repo", https},
		{"userinfo token only", "https://ghp_token@github.com/owner/repo", https},
		{"ssh password", "ssh://git:secret@github.com/owner/repo.git", ssh},
		{"unparseable", "https://github.com:port/owner/repo", https},
		{"no host", "https:///owner/repo", https},
		{"localhost", "https://localhost/owner/repo", https},
		{"localhost trailing dot", "https://localhost./owner/repo", https},
		{"dot localhost", "https://git.localhost/owner/repo", https},
		{"dot local", "https://gitserver.local/owner/repo", https},
		{"internal", "https://internal/owner/repo", https},
		{"dot internal", "https://metadata.google.internal/owner/repo", https},
		{"ssh to localhost", "ssh://git@localhost/owner/repo.git", ssh},
		{"scp to an internal name", "git@git.internal:owner/repo.git", ssh},
		{"decimal IPv4 host", "https://2130706433/owner/repo", https},
		{"short IPv4 host", "https://127.1/owner/repo", https},
		{"hex IPv4 host", "https://0x7f.1/owner/repo", https},
		{"non-ascii host", "https://gïthub.com/owner/repo", https},
		{"leading hyphen label", "https://-github.com/owner/repo", https},
		{"empty label", "https://github..com/owner/repo", https},
		{"overlong host", "https://" + strings.Repeat("a.", 130) + "com/owner/repo", https},
		{"overlong label", "https://" + strings.Repeat("a", 64) + ".com/owner/repo", https},
		{"loopback literal", "https://127.0.0.1/owner/repo", https},
		{"private literal 10", "https://10.0.0.1/owner/repo", https},
		{"private literal 172", "https://172.16.0.1/owner/repo", https},
		{"private literal 192", "https://192.168.0.1/owner/repo", https},
		{"metadata literal", "https://169.254.169.254/latest/meta-data", https},
		{"CGNAT literal", "https://100.64.0.1/owner/repo", https},
		{"IPv6 loopback literal", "https://[::1]/owner/repo", https},
		{"IPv6 link-local literal", "https://[fe80::1]/owner/repo", https},
		{"IPv6 ULA literal", "https://[fd12:3456::1]/owner/repo", https},
		{"IPv4-mapped loopback literal", "https://[::ffff:127.0.0.1]/owner/repo", https},
		{"NAT64 private literal", "https://[64:ff9b::a00:1]/owner/repo", https},
		{"6to4 private literal", "https://[2002:a00:1::]/owner/repo", https},
		{"resolves to loopback", "https://loopback.example.com/owner/repo", https},
		{"resolves to RFC1918 10/8", "https://private.example.com/owner/repo", https},
		{"resolves to RFC1918 172.16/12", "https://rfc1918b.example.com/owner/repo", https},
		{"resolves to RFC1918 192.168/16", "https://rfc1918c.example.com/owner/repo", https},
		{"resolves to the metadata address", "https://metadata.example.com/owner/repo", https},
		{"resolves to CGNAT", "https://cgnat.example.com/owner/repo", https},
		{"resolves to ULA", "https://ula.example.com/owner/repo", https},
		{"resolves to IPv6 link-local", "https://linklocal6.example.com/owner/repo", https},
		{"resolves to IPv6 loopback", "https://loopback6.example.com/owner/repo", https},
		{"resolves to one private among public", "https://mixed.example.com/owner/repo", https},
		{"resolves to nothing", "https://empty.example.com/owner/repo", https},
		{"does not resolve", "https://nonexistent.example.com/owner/repo", https},
		{"ssh resolving to a private address", "ssh://git@private.example.com/owner/repo.git", ssh},
		{"scp resolving to a private address", "git@private.example.com:owner/repo.git", ssh},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mustNotPass(t, tc.raw, validateRepoURL(context.Background(), tc.raw, tc.opts, publicDNS, allowlist{}))
		})
	}
}

func TestValidateRepoURL_Accepted(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		opts RepoURLOptions
	}{
		{"public https", "https://github.com/owner/repo", RepoURLOptions{}},
		{"public https trailing dot", "https://github.com./owner/repo.git", RepoURLOptions{}},
		{"bare host path completes to https", "github.com/owner/repo", RepoURLOptions{}},
		{"public https dual-stack", "https://gitlab.com/group/repo.git", RepoURLOptions{}},
		{"public IPv4 literal", "https://140.82.112.3/owner/repo", RepoURLOptions{}},
		{"public IPv6 literal", "https://[2606:4700::1]/owner/repo", RepoURLOptions{}},
		{"ssh where allowed", "ssh://git@github.com/owner/repo.git", RepoURLOptions{AllowSSH: true}},
		{"ssh with a port where allowed", "ssh://git@github.com:2222/owner/repo.git", RepoURLOptions{AllowSSH: true}},
		{"scp where allowed", "git@github.com:owner/repo.git", RepoURLOptions{AllowSSH: true}},
		{"https where ssh is also allowed", "https://github.com/owner/repo", RepoURLOptions{AllowSSH: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateRepoURL(context.Background(), tc.raw, tc.opts, publicDNS, allowlist{}); err != nil {
				t.Fatalf("%q refused: %v", tc.raw, err)
			}
		})
	}
}

func TestValidateRepoURL_OperatorAllowlist(t *testing.T) {
	allow, err := parseAllowlist("git.corp.example, *.build.corp.example 10.20.0.0/16\tfd00::/8,192.168.7.9")
	if err != nil {
		t.Fatalf("parseAllowlist: %v", err)
	}
	accepted := []string{
		"https://git.corp.example/team/repo",      // exact name, skips the address check
		"https://ci.build.corp.example/team/repo", // wildcard suffix
		"https://mirror.corp.example/team/repo",   // resolves into an allowed CIDR
		"https://10.20.3.4/team/repo",             // literal inside an allowed CIDR
		"https://192.168.7.9/team/repo",           // a single allowed IP
		"https://[fd00::5]/team/repo",             // IPv6 CIDR
		"https://[::ffff:10.20.0.9]/team/repo",    // IPv4-mapped form of an allowed address
		"https://github.com/owner/repo",           // public hosts still pass
	}
	for _, raw := range accepted {
		if err := validateRepoURL(context.Background(), raw, RepoURLOptions{}, publicDNS, allow); err != nil {
			t.Errorf("%q refused with the allowlist: %v", raw, err)
		}
	}
	refusedURLs := []string{
		"http://git.corp.example/team/repo",          // transport rules still apply
		"https://user:pw@git.corp.example/team/repo", // credential rules still apply
		"https://private.example.com/team/repo",      // 10.1.2.3 is outside 10.20.0.0/16
		"https://192.168.7.10/team/repo",             // next to the single IP, not it
		"https://build.corp.example/team/repo",       // *.suffix does not name the apex
	}
	for _, raw := range refusedURLs {
		mustNotPass(t, raw, validateRepoURL(context.Background(), raw, RepoURLOptions{}, publicDNS, allow))
	}
}

func TestParseAllowlist(t *testing.T) {
	if a, err := parseAllowlist(""); err != nil || len(a.names)+len(a.suffixes)+len(a.prefixes) != 0 {
		t.Fatalf("empty allowlist = %+v, %v; want empty", a, err)
	}
	a, err := parseAllowlist("Git.Corp.Example., gitea")
	if err != nil {
		t.Fatal(err)
	}
	if !a.admitsName("git.corp.example") || !a.admitsName("gitea") || a.admitsName("corp.example") {
		t.Fatalf("names = %v", a.names)
	}
	for _, bad := range []string{"https://git.corp.example", "*.", "*.-bad", "10.0.0.0/33", "bad_host"} {
		_, err := parseAllowlist(bad)
		mustNotPass(t, bad, err)
	}
}

func TestIsPublicUnicast(t *testing.T) {
	cases := map[string]bool{
		"8.8.8.8":                true,
		"140.82.112.3":           true,
		"2606:4700::1":           true,
		"::8.8.8.8":              true, // IPv4-compatible, public v4
		"::ffff:8.8.8.8":         true,
		"64:ff9b::808:808":       true, // NAT64 of 8.8.8.8
		"2002:808:808::1":        true, // 6to4 of 8.8.8.8
		"0.0.0.0":                false,
		"127.0.0.1":              false,
		"10.0.0.1":               false,
		"172.31.255.255":         false,
		"192.168.0.1":            false,
		"169.254.169.254":        false,
		"100.127.0.1":            false,
		"192.0.0.1":              false,
		"192.0.2.1":              false,
		"192.88.99.1":            false,
		"198.18.0.1":             false,
		"198.51.100.1":           false,
		"203.0.113.1":            false,
		"224.0.0.1":              false,
		"255.255.255.255":        false,
		"::":                     false,
		"::1":                    false,
		"::10.0.0.1":             false,
		"::ffff:169.254.169.254": false,
		"64:ff9b::a9fe:a9fe":     false, // NAT64 of the metadata address
		"2002:a9fe:a9fe::":       false, // 6to4 of the metadata address
		"fc00::1":                false,
		"fe80::1%eth0":           false,
		"fec0::1":                false,
		"ff02::1":                false,
		"2001:db8::1":            false,
		"2001::1":                false,
		"100::1":                 false,
		"::ffff:0:8.8.8.8":       false, // the rest of 0000::/8
	}
	for ip, want := range cases {
		if got := isPublicUnicast(netip.MustParseAddr(ip)); got != want {
			t.Errorf("isPublicUnicast(%s) = %v, want %v", ip, got, want)
		}
	}
	if isPublicUnicast(netip.Addr{}) {
		t.Error("the zero Addr must not be public")
	}
}

func TestValidateRepoURL_TestBinaryBypassAndEnforcement(t *testing.T) {
	// A test binary without EnforceRepoURLChecksForTest accepts fixtures, which is what every
	// file:// clone test in the tree relies on.
	if err := ValidateRepoURL(context.Background(), "file:///tmp/fixture", RepoURLOptions{}); err != nil {
		t.Fatalf("unenforced test binary refused a fixture: %v", err)
	}

	t.Run("enforced", func(t *testing.T) {
		EnforceRepoURLChecksForTest(t, publicDNS)
		mustNotPass(t, "file:///tmp/fixture", ValidateRepoURL(context.Background(), "file:///tmp/fixture", RepoURLOptions{}))
		mustNotPass(t, "private", ValidateRepoURL(context.Background(), "https://private.example.com/o/r", RepoURLOptions{}))
		if err := ValidateRepoURL(context.Background(), "https://github.com/o/r", RepoURLOptions{}); err != nil {
			t.Fatalf("public URL refused: %v", err)
		}

		t.Setenv(AllowedHostsEnv, "*.example.com")
		if err := ValidateRepoURL(context.Background(), "https://private.example.com/o/r", RepoURLOptions{}); err != nil {
			t.Fatalf("allowlisted host refused: %v", err)
		}
		t.Setenv(AllowedHostsEnv, "not a/host")
		mustNotPass(t, "bad allowlist", ValidateRepoURL(context.Background(), "https://github.com/o/r", RepoURLOptions{}))
	})

	t.Run("enforced with the default resolver", func(t *testing.T) {
		EnforceRepoURLChecksForTest(t, nil)
		if _, ok := currentResolver().(*net.Resolver); !ok {
			t.Fatalf("currentResolver = %T, want *net.Resolver", currentResolver())
		}
		// A literal needs no resolver at all.
		mustNotPass(t, "loopback", ValidateRepoURL(context.Background(), "https://127.0.0.1/o/r", RepoURLOptions{}))
	})

	if err := ValidateRepoURL(context.Background(), "file:///tmp/fixture", RepoURLOptions{}); err != nil {
		t.Fatalf("enforcement leaked past its test: %v", err)
	}
}

func TestGIT_RemoteCheckedBeforeEveryNetworkOperation(t *testing.T) {
	EnforceRepoURLChecksForTest(t, publicDNS)
	ctx := context.Background()
	dir := t.TempDir()

	g := NewGIT("file://"+dir, t.TempDir(), false)
	mustNotPass(t, "Clone", g.Clone(ctx, "", true))
	mustNotPass(t, "CloneAndCheckoutCommit", g.CloneAndCheckoutCommit(ctx, "main", strings.Repeat("a", 40), true))

	repo, err := gogit.PlainInit(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	g.Repo = repo
	mustNotPass(t, "Pull", g.Pull(ctx))
	mustNotPass(t, "Push", g.Push(ctx))

	// ssh is refused unless the call site allows it, and then the host rules still apply.
	s := NewGIT("git@private.example.com:owner/repo.git", t.TempDir(), false)
	mustNotPass(t, "ssh Clone", s.Clone(ctx, "", true))
	s.AllowSSH = true
	mustNotPass(t, "ssh Clone to a private host", s.Clone(ctx, "", true))

	// A token clone is checked on the URL it will actually fetch.
	tok := NewGITWithToken("https://localhost/owner/repo", t.TempDir(), false, "tok", "github")
	mustNotPass(t, "token Clone", tok.Clone(ctx, "", true))
}

// recordingDial records the address it was asked to dial and returns a canned result.
type recordingDial struct {
	addrs []string
	fail  map[string]bool
}

// dial records addr and fails when fail[addr] is set.
func (r *recordingDial) dial(_ context.Context, _, addr string) (net.Conn, error) {
	r.addrs = append(r.addrs, addr)
	if r.fail[addr] {
		return nil, errors.New("connection refused")
	}
	c1, c2 := net.Pipe()
	_ = c2.Close()
	return c1, nil
}

// newTestDialer returns a pinnedDialer over rec, publicDNS and allow.
func newTestDialer(rec *recordingDial, allow string) *pinnedDialer {
	return &pinnedDialer{
		dial:     rec.dial,
		resolver: func() Resolver { return publicDNS },
		allow:    func() (allowlist, error) { return parseAllowlist(allow) },
	}
}

func TestPinnedDialer(t *testing.T) {
	ctx := context.Background()

	t.Run("unenforced dials as asked", func(t *testing.T) {
		rec := &recordingDial{}
		conn, err := newTestDialer(rec, "").DialContext(ctx, "tcp", "127.0.0.1:8080")
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.Close()
		if rec.addrs[0] != "127.0.0.1:8080" {
			t.Fatalf("dialled %v", rec.addrs)
		}
	})

	EnforceRepoURLChecksForTest(t, publicDNS)

	t.Run("dials the checked address, not the name", func(t *testing.T) {
		rec := &recordingDial{}
		conn, err := newTestDialer(rec, "").DialContext(ctx, "tcp", "github.com:443")
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.Close()
		if len(rec.addrs) != 1 || rec.addrs[0] != "140.82.112.3:443" {
			t.Fatalf("dialled %v, want the pinned address", rec.addrs)
		}
	})

	t.Run("falls through to the next checked address", func(t *testing.T) {
		rec := &recordingDial{fail: map[string]bool{"172.65.251.78:443": true}}
		conn, err := newTestDialer(rec, "").DialContext(ctx, "tcp", "gitlab.com:443")
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.Close()
		if len(rec.addrs) != 2 || !strings.HasPrefix(rec.addrs[1], "[2606:4700:90:") {
			t.Fatalf("dialled %v", rec.addrs)
		}
	})

	t.Run("reports the last dial error", func(t *testing.T) {
		rec := &recordingDial{fail: map[string]bool{"140.82.112.3:443": true}}
		if _, err := newTestDialer(rec, "").DialContext(ctx, "tcp", "github.com:443"); err == nil || errors.Is(err, ErrRepoURLRefused) {
			t.Fatalf("err = %v, want the dial error", err)
		}
	})

	t.Run("refuses a redirect or rebinding target", func(t *testing.T) {
		rec := &recordingDial{}
		for _, addr := range []string{":443", "metadata.example.com:80", "169.254.169.254:80", "localhost:443", "[::1]:443"} {
			_, err := newTestDialer(rec, "").DialContext(ctx, "tcp", addr)
			mustNotPass(t, addr, err)
		}
		if len(rec.addrs) != 0 {
			t.Fatalf("dialled %v after a refusal", rec.addrs)
		}
	})

	t.Run("refuses an address it cannot split", func(t *testing.T) {
		_, err := newTestDialer(&recordingDial{}, "").DialContext(ctx, "tcp", "github.com")
		mustNotPass(t, "no port", err)
	})

	t.Run("refuses under a malformed allowlist", func(t *testing.T) {
		_, err := newTestDialer(&recordingDial{}, "a/b").DialContext(ctx, "tcp", "github.com:443")
		mustNotPass(t, "bad allowlist", err)
	})

	t.Run("dials an allowlisted name as is", func(t *testing.T) {
		rec := &recordingDial{}
		conn, err := newTestDialer(rec, "git.corp.example").DialContext(ctx, "tcp", "git.corp.example:443")
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.Close()
		if rec.addrs[0] != "git.corp.example:443" {
			t.Fatalf("dialled %v", rec.addrs)
		}
	})

	t.Run("dials a proxy the transport chose as is", func(t *testing.T) {
		rec := &recordingDial{}
		d := newTestDialer(rec, "")
		proxy, _ := url.Parse("http://10.0.0.9:3128")
		tr := newPinnedTransport(&http.Transport{Proxy: http.ProxyURL(proxy)}, d)
		req, _ := http.NewRequest(http.MethodGet, "https://github.com/owner/repo/info/refs", nil)
		if u, err := tr.Proxy(req); err != nil || u.Host != "10.0.0.9:3128" {
			t.Fatalf("Proxy = %v, %v", u, err)
		}
		conn, err := tr.DialContext(ctx, "tcp", "10.0.0.9:3128")
		if err != nil {
			t.Fatalf("proxy dial refused: %v", err)
		}
		_ = conn.Close()
		// A private address the transport did not choose as a proxy is still refused.
		_, err = tr.DialContext(ctx, "tcp", "10.0.0.10:3128")
		mustNotPass(t, "non-proxy private", err)
	})
}

func TestNewPinnedTransport_BaseShapes(t *testing.T) {
	d := &pinnedDialer{}
	noProxy := newPinnedTransport(&http.Transport{}, d)
	req, _ := http.NewRequest(http.MethodGet, "https://github.com/", nil)
	if u, err := noProxy.Proxy(req); u != nil || err != nil {
		t.Fatalf("a base with no proxy grew one: %v, %v", u, err)
	}
	other := newPinnedTransport(http.NewFileTransport(http.Dir(t.TempDir())), d)
	if other.Proxy == nil || other.DialContext == nil {
		t.Fatal("a non-*http.Transport base must still get the proxy hook and the pinned dialer")
	}
}

func TestProxyAddr(t *testing.T) {
	cases := map[string]string{
		"http://proxy.corp:3128": "proxy.corp:3128",
		"http://proxy.corp":      "proxy.corp:80",
		"https://proxy.corp":     "proxy.corp:443",
		"socks5://proxy.corp":    "proxy.corp:1080",
		"socks5h://proxy.corp":   "proxy.corp:1080",
		"http://[fd00::1]":       "[fd00::1]:80",
	}
	for raw, want := range cases {
		u, _ := url.Parse(raw)
		if got := proxyAddr(u); got != want {
			t.Errorf("proxyAddr(%s) = %s, want %s", raw, got, want)
		}
	}
}

func TestEnvAllowlist(t *testing.T) {
	t.Setenv(AllowedHostsEnv, "git.corp.example")
	a, err := envAllowlist()
	if err != nil || !a.admitsName("git.corp.example") {
		t.Fatalf("envAllowlist = %+v, %v", a, err)
	}
}
