// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

// db-authproxy is the KEYLESS database-auth PROXY sidecar (#722, epic #1500). It runs next to a
// workload whose bound database uses cloud-native (tokenless) auth and gives that workload an
// ordinary, password-free database endpoint on 127.0.0.1 — the app connects with no credential and
// no awareness that tokens exist.
//
// When a new upstream connection is needed it obtains a short-lived DB token from the pod's own
// Workload Identity (AWS IRSA / Azure federated identity), dials the real database over TLS
// presenting that token as a CLEARTEXT password, and then byte-splices the two connections. It is
// handshake + pipe: no pooling, no routing, no query parsing.
//
// Why mint in-process rather than refresh a shared file:
//   - Nothing is ever at rest. There is no token file, no rotation store, no admin socket — the
//     token lives only in this process's memory. It is held just long enough to be reused across
//     connections while it is still valid (see tokenCache), because minting once per connection
//     would let a pool open or a reconnect storm throttle the cloud identity endpoint.
//   - It deletes the rotation problem class outright. Both engines authenticate ONCE at connect, so
//     an expiring token can never invalidate an established session; the next connection simply
//     authenticates with a fresh one.
//
// This REPLACES the pgbouncer sidecar, which never worked: the rendered PGB_UPSTREAM_HOST /
// PGB_TOKEN_FILE env vars are not understood by the stock bitnami/pgbouncer image and nothing in
// this repo ever consumed them. ProxySQL was evaluated for the MySQL half and is structurally unable
// to do this — it uses ONE (username, password) pair for both its frontend and backend legs, so the
// app's local credential would have to BE the rotating token (sysown/proxysql#3446, open since 2021).
//
// GCP is deliberately NOT served here: Cloud SQL has a native auth proxy (--auto-iam-authn) that
// mints its own token, for both MySQL and PostgreSQL. Asking for --provider gcp is a hard error, not
// a silent fallback.

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

// upstreamTLSConfig builds the client TLS configuration for the upstream database hop — the real
// server name, verified against the platform trust store, TLS 1.2 or better. Both engine halves go
// through it.
//
// It is a package-level var solely so a test can substitute the TRUST ANCHOR (RootCAs) and drive the
// legs that only run after a successful handshake — the token exchange and the splice — against a
// stub database. Verification itself is never disabled, and nothing reassigns this outside tests.
var upstreamTLSConfig = func(serverName string) *tls.Config {
	return &tls.Config{ServerName: serverName, MinVersion: tls.VersionTLS12}
}

const (
	// authProxyEnginePostgres / authProxyEngineMySQL are the two supported wire protocols.
	authProxyEnginePostgres = "postgres"
	authProxyEngineMySQL    = "mysql"

	// authProxyDialTimeout bounds a single upstream dial + handshake, so a wedged database can't
	// pile up half-open client connections forever.
	authProxyDialTimeout = 30 * time.Second
	// authProxyMintTimeout bounds one token mint (IMDS/IRSA or Entra round-trip).
	authProxyMintTimeout = 20 * time.Second
	// authProxyTokenLead is how much validity a cached token must have left to be handed to a new
	// connection. An AWS RDS token lives 15 minutes and an Entra token about an hour, so this trades
	// a little early re-minting for never handing out a credential that is about to expire.
	authProxyTokenLead = 2 * time.Minute
)

// authProxyConfig is the fully-resolved db-authproxy invocation. It is produced by
// parseAuthProxyFlags and validated before any listener is opened, so a misconfigured sidecar dies
// at startup rather than accepting connections it can never authenticate.
type authProxyConfig struct {
	Provider string // aws | azure
	Engine   string // postgres | mysql
	Upstream string // host:port of the real database
	Listen   string // local address to serve, e.g. 127.0.0.1:3306
	User     string // the database login the token authenticates as
	Region   string // AWS only — the region the RDS token is signed for
}

// authProxyMint mints one short-lived database access token and reports when it expires. It is a
// function so tests can supply a deterministic token without cloud credentials.
type authProxyMint func(ctx context.Context) (string, time.Time, error)

// tokenSource hands out a currently-valid token. It is what the per-engine handlers consume; the
// caching and timeout policy lives behind it.
type tokenSource func(ctx context.Context) (string, error)

// tokenCache reuses a minted token for the part of its lifetime that is safely left, refreshing
// early. It exists for availability, not convenience: a driver opening a 50-connection pool — or a
// pod-wide reconnect storm — would otherwise fire one identity-endpoint call per connection and get
// throttled (GCP documents 12k logins/min/instance; IMDS and Entra rate-limit too), turning a
// transient blip into an outage.
//
// This does not weaken the "nothing at rest" property: the token lives only in this process's
// memory, is never written to disk, and is exactly the reuse window the previous shared-token-file
// design had — with the file, and everything that could read it, removed.
type tokenCache struct {
	mint authProxyMint

	mu    sync.Mutex
	token string
	exp   time.Time
}

// newTokenCache wraps a raw minter with the reuse policy.
func newTokenCache(mint authProxyMint) *tokenCache {
	return &tokenCache{mint: mint}
}

// get returns a valid token, minting a fresh one when the cached token is missing or close enough to
// expiry that a connection opened now might outlive its own authentication.
func (t *tokenCache) get(ctx context.Context) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.token != "" && time.Until(t.exp) > authProxyTokenLead {
		return t.token, nil
	}
	ctx, cancel := context.WithTimeout(ctx, authProxyMintTimeout)
	defer cancel()
	tok, exp, err := t.mint(ctx)
	if err != nil {
		return "", fmt.Errorf("mint database token: %w", err)
	}
	if tok == "" {
		return "", errors.New("mint database token: empty token")
	}
	t.token, t.exp = tok, exp
	return tok, nil
}

// RunDBAuthProxy parses the db-authproxy flags and serves until the context is cancelled. Invoked as
// a subcommand from main (a sidecar container's entrypoint).
func RunDBAuthProxy(ctx context.Context, args []string) error {
	cfg, err := parseAuthProxyFlags(args)
	if err != nil {
		return err
	}
	mint, err := authProxyMinter(cfg)
	if err != nil {
		return err
	}
	src := newTokenCache(mint).get
	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("db-authproxy: listen on %s: %w", cfg.Listen, err)
	}
	defer func() { _ = ln.Close() }()
	return serveAuthProxy(ctx, cfg, ln, src)
}

// parseAuthProxyFlags turns argv into a validated authProxyConfig. Pure + deterministic (no cloud,
// no sockets) so the fail-closed rules are unit-testable.
func parseAuthProxyFlags(args []string) (authProxyConfig, error) {
	fs := flag.NewFlagSet("db-authproxy", flag.ContinueOnError)
	provider := fs.String("provider", "", "cloud provider (aws|azure)")
	engine := fs.String("engine", "", "database engine (postgres|mysql)")
	upstream := fs.String("upstream", "", "upstream database address (host:port)")
	listen := fs.String("listen", "", "local address to serve (e.g. 127.0.0.1:3306)")
	user := fs.String("user", "", "database user the token authenticates as")
	region := fs.String("region", "", "cloud region (AWS — the region the RDS token is signed for)")
	if err := fs.Parse(args); err != nil {
		return authProxyConfig{}, fmt.Errorf("db-authproxy: %w", err)
	}
	cfg := authProxyConfig{
		Provider: strings.TrimSpace(*provider),
		Engine:   strings.TrimSpace(*engine),
		Upstream: strings.TrimSpace(*upstream),
		Listen:   strings.TrimSpace(*listen),
		User:     strings.TrimSpace(*user),
		Region:   strings.TrimSpace(*region),
	}
	if err := cfg.validate(); err != nil {
		return authProxyConfig{}, err
	}
	return cfg, nil
}

// validate enforces the fail-closed contract: every unsupported or half-specified combination is a
// startup error with a reason, never a proxy that listens and then cannot authenticate. Getting this
// wrong is worse than not shipping keyless at all — a wrong-wire proxy renders green and fails in
// the customer's cluster.
func (c authProxyConfig) validate() error {
	switch c.Provider {
	case "aws", "azure":
		// token-as-password clouds — this proxy is exactly for them
	case "gcp":
		return errors.New("db-authproxy: gcp is not served here — Cloud SQL has a native auth proxy " +
			"(cloud-sql-proxy --auto-iam-authn) that mints its own token for both engines")
	case "":
		return errors.New("db-authproxy: --provider is required (aws|azure)")
	default:
		return fmt.Errorf("db-authproxy: unsupported provider %q (want aws|azure)", c.Provider)
	}
	switch c.Engine {
	case authProxyEnginePostgres, authProxyEngineMySQL:
		// supported wires
	case "":
		return errors.New("db-authproxy: --engine is required (postgres|mysql)")
	default:
		return fmt.Errorf("db-authproxy: unsupported engine %q (want postgres|mysql)", c.Engine)
	}
	if c.Upstream == "" {
		return errors.New("db-authproxy: --upstream is required (host:port)")
	}
	if _, _, err := net.SplitHostPort(c.Upstream); err != nil {
		return fmt.Errorf("db-authproxy: --upstream %q is not host:port: %w", c.Upstream, err)
	}
	if c.Listen == "" {
		return errors.New("db-authproxy: --listen is required (e.g. 127.0.0.1:3306)")
	}
	listenHost, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return fmt.Errorf("db-authproxy: --listen %q is not host:port: %w", c.Listen, err)
	}
	// The listener is deliberately UNAUTHENTICATED — the app holds no credential, and reaching this
	// socket is itself the authorization. That is only safe on loopback, where the peer is another
	// container in the same pod. Bound to a routable address it would be an open database gateway
	// logging in as the app's cloud identity, reachable by anything on the pod network. Refuse.
	if !isLoopbackHost(listenHost) {
		return fmt.Errorf("db-authproxy: --listen %q must be a loopback address (127.0.0.1 / ::1) — "+
			"the listener is unauthenticated by design and must not be reachable off-pod", c.Listen)
	}
	if c.User == "" {
		return errors.New("db-authproxy: --user is required (the database login the token authenticates as)")
	}
	// AWS signs the RDS token for a specific region + endpoint; without the region the token is
	// unusable, so refuse at startup rather than mint garbage per connection.
	if c.Provider == "aws" && c.Region == "" {
		return errors.New("db-authproxy: --region is required for provider aws (the RDS token is region-signed)")
	}
	return nil
}

// isLoopbackHost reports whether a --listen host is the loopback interface. An empty host (":3306")
// means "all interfaces" and is therefore NOT loopback. Names are rejected rather than resolved: DNS
// is not a security boundary, so only literal loopback addresses and "localhost" are accepted.
func isLoopbackHost(host string) bool {
	if host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// upstreamHost returns the upstream hostname without its port — the TLS server name.
func (c authProxyConfig) upstreamHost() string {
	host, _, err := net.SplitHostPort(c.Upstream)
	if err != nil {
		return c.Upstream
	}
	return host
}

// authProxyMinter selects the per-cloud token minter. AWS signs an RDS IAM token for the exact
// endpoint + user; Azure mints an Entra token for the shared OSS-RDBMS resource (the same token
// serves PostgreSQL and MySQL, so the engine does not enter into it).
func authProxyMinter(cfg authProxyConfig) (authProxyMint, error) {
	switch cfg.Provider {
	case "aws":
		return func(ctx context.Context) (string, time.Time, error) {
			return mintAWSDBToken(ctx, cfg.Upstream, cfg.Region, cfg.User)
		}, nil
	case "azure":
		return func(ctx context.Context) (string, time.Time, error) {
			return mintAzureDBToken(ctx)
		}, nil
	}
	return nil, fmt.Errorf("db-authproxy: no token minter for provider %q", cfg.Provider)
}

// serveAuthProxy accepts local connections until ctx is cancelled or the listener fails, handling
// each in its own goroutine. One failed connection never takes the sidecar down: the app's driver
// reconnects, and the next attempt mints a fresh token.
func serveAuthProxy(ctx context.Context, cfg authProxyConfig, ln net.Listener, src tokenSource) error {
	var wg sync.WaitGroup
	defer wg.Wait()

	// Unblock a blocked Accept when the context is cancelled (SIGTERM in a pod).
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil // clean shutdown
			}
			return fmt.Errorf("db-authproxy: accept: %w", err)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { _ = conn.Close() }()
			if err := handleAuthProxyConn(ctx, cfg, conn, src); err != nil {
				// Never log the token or the error's raw upstream payload — just the reason.
				fmt.Fprintf(os.Stderr, "db-authproxy: connection failed: %v\n", err)
			}
		}()
	}
}

// handleAuthProxyConn runs one client connection end to end: complete the local handshake, mint a
// token, authenticate upstream over TLS, then splice. The token never leaves this function.
func handleAuthProxyConn(ctx context.Context, cfg authProxyConfig, client net.Conn, src tokenSource) error {
	ctx, cancel := context.WithTimeout(ctx, authProxyDialTimeout)
	defer cancel()

	switch cfg.Engine {
	case authProxyEngineMySQL:
		return handleMySQLConn(ctx, cfg, client, src)
	case authProxyEnginePostgres:
		return handlePostgresConn(ctx, cfg, client, src)
	}
	return fmt.Errorf("db-authproxy: no handler for engine %q", cfg.Engine)
}

// spliceConns copies bytes in both directions until either side closes, then returns. Post-auth both
// wire protocols are opaque request/response streams, so a byte pipe is sufficient and — unlike a
// protocol-aware proxy — cannot corrupt a payload it does not understand.
func spliceConns(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	cp := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		// Half-close so the peer sees EOF instead of hanging until a timeout.
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		} else {
			_ = dst.Close()
		}
	}
	go cp(a, b)
	go cp(b, a)
	wg.Wait()
}
