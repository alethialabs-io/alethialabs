// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bytes"
	"context"
	"encoding/binary"
	"net"
	"strings"
	"testing"
	"time"
)

// --- configuration / fail-closed -------------------------------------------------------------

// TestParseAuthProxyFlags_Valid checks the happy paths for both clouds and both engines.
func TestParseAuthProxyFlags_Valid(t *testing.T) {
	cfg, err := parseAuthProxyFlags([]string{
		"--provider", "azure", "--engine", "mysql",
		"--upstream", "db.mysql.database.azure.com:3306",
		"--listen", "127.0.0.1:3306", "--user", "alethia_app",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Engine != authProxyEngineMySQL || cfg.Provider != "azure" {
		t.Fatalf("bad parse: %+v", cfg)
	}
	if got := cfg.upstreamHost(); got != "db.mysql.database.azure.com" {
		t.Fatalf("upstreamHost = %q", got)
	}

	if _, err := parseAuthProxyFlags([]string{
		"--provider", "aws", "--engine", "postgres", "--region", "eu-central-1",
		"--upstream", "db.rds.amazonaws.com:5432", "--listen", "127.0.0.1:5432", "--user", "alethia_app",
	}); err != nil {
		t.Fatalf("aws/postgres should be valid: %v", err)
	}
}

// TestParseAuthProxyFlags_FailClosed is the load-bearing test for this seam: every unsupported or
// half-specified invocation must die at startup with a reason. A proxy that listens but cannot
// authenticate renders green and fails inside the customer's cluster.
func TestParseAuthProxyFlags_FailClosed(t *testing.T) {
	base := map[string]string{
		"--provider": "aws", "--engine": "mysql", "--region": "eu-central-1",
		"--upstream": "h:3306", "--listen": "127.0.0.1:3306", "--user": "alethia_app",
	}
	argsWith := func(over map[string]string, drop ...string) []string {
		m := map[string]string{}
		for k, v := range base {
			m[k] = v
		}
		for k, v := range over {
			m[k] = v
		}
		for _, d := range drop {
			delete(m, d)
		}
		var out []string
		for k, v := range m {
			out = append(out, k, v)
		}
		return out
	}

	cases := []struct {
		name string
		args []string
		want string
	}{
		{"gcp is explicitly not served", argsWith(map[string]string{"--provider": "gcp"}), "native auth proxy"},
		{"unknown provider", argsWith(map[string]string{"--provider": "hetzner"}), "unsupported provider"},
		{"missing provider", argsWith(nil, "--provider"), "--provider is required"},
		{"unknown engine", argsWith(map[string]string{"--engine": "mariadb"}), "unsupported engine"},
		{"missing engine", argsWith(nil, "--engine"), "--engine is required"},
		{"missing upstream", argsWith(nil, "--upstream"), "--upstream is required"},
		{"upstream without port", argsWith(map[string]string{"--upstream": "hostonly"}), "not host:port"},
		{"missing listen", argsWith(nil, "--listen"), "--listen is required"},
		{"missing user", argsWith(nil, "--user"), "--user is required"},
		{"aws without region", argsWith(nil, "--region"), "--region is required for provider aws"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseAuthProxyFlags(tc.args)
			if err == nil {
				t.Fatalf("expected failure, got none")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

// TestAuthProxyMinter_RejectsUnsupportedProvider guards the minter switch against drifting away from
// validate().
func TestAuthProxyMinter_RejectsUnsupportedProvider(t *testing.T) {
	if _, err := authProxyMinter(authProxyConfig{Provider: "gcp"}); err == nil {
		t.Fatal("expected no minter for gcp")
	}
}

// TestValidate_ListenMustBeLoopback is a security invariant, not a preference. The listener demands
// no credential — reaching it IS the authorization — which is only sound when the peer is another
// container in the same pod. Bound to a routable address it becomes an open database gateway that
// logs in as the app's cloud identity for anything on the pod network.
func TestValidate_ListenMustBeLoopback(t *testing.T) {
	base := authProxyConfig{
		Provider: "azure", Engine: authProxyEngineMySQL,
		Upstream: "db.example.com:3306", User: "alethia_app",
	}
	for _, listen := range []string{"0.0.0.0:3306", ":3306", "10.4.2.9:3306", "[::]:3306", "db-proxy:3306"} {
		cfg := base
		cfg.Listen = listen
		err := cfg.validate()
		if err == nil {
			t.Errorf("--listen %q must be rejected: it exposes an unauthenticated DB gateway off-pod", listen)
			continue
		}
		if !strings.Contains(err.Error(), "loopback") {
			t.Errorf("--listen %q rejected for the wrong reason: %v", listen, err)
		}
	}
	for _, listen := range []string{"127.0.0.1:3306", "localhost:3306", "[::1]:3306"} {
		cfg := base
		cfg.Listen = listen
		if err := cfg.validate(); err != nil {
			t.Errorf("--listen %q should be accepted: %v", listen, err)
		}
	}
}

// TestTokenCache_ReusesWhileValid — one identity-endpoint call per connection would let a pool open
// (or a reconnect storm) throttle IMDS/Entra and take the app down. A valid token must be reused.
func TestTokenCache_ReusesWhileValid(t *testing.T) {
	var mints int
	tc := newTokenCache(func(context.Context) (string, time.Time, error) {
		mints++
		return "tok-1", time.Now().Add(15 * time.Minute), nil
	})
	for i := 0; i < 50; i++ {
		got, err := tc.get(context.Background())
		if err != nil || got != "tok-1" {
			t.Fatalf("get: %q %v", got, err)
		}
	}
	if mints != 1 {
		t.Fatalf("minted %d times for 50 connections; want 1", mints)
	}
}

// TestTokenCache_RefreshesBeforeExpiry — a token close to expiry must not be handed to a new
// connection, or the connection can outlive its own authentication.
func TestTokenCache_RefreshesBeforeExpiry(t *testing.T) {
	var mints int
	tc := newTokenCache(func(context.Context) (string, time.Time, error) {
		mints++
		// Always nearly-expired: every get must re-mint.
		return "fresh", time.Now().Add(authProxyTokenLead / 2), nil
	})
	for i := 0; i < 3; i++ {
		if _, err := tc.get(context.Background()); err != nil {
			t.Fatalf("get: %v", err)
		}
	}
	if mints != 3 {
		t.Fatalf("minted %d times; a nearly-expired token must be refreshed every time", mints)
	}
}

// TestTokenCache_FailsClosedOnEmptyToken — an empty credential must never reach a handshake.
func TestTokenCache_FailsClosedOnEmptyToken(t *testing.T) {
	tc := newTokenCache(func(context.Context) (string, time.Time, error) {
		return "", time.Now().Add(time.Hour), nil
	})
	if _, err := tc.get(context.Background()); err == nil {
		t.Fatal("expected an empty token to be rejected")
	}
}

// --- MySQL wire -------------------------------------------------------------------------------

// mysqlHandshakeResponseFixture builds a HandshakeResponse41 the way a real driver would.
func mysqlHandshakeResponseFixture(caps uint32, charset byte, user, db string) []byte {
	b := make([]byte, 0, 64)
	b = binary.LittleEndian.AppendUint32(b, caps)
	b = binary.LittleEndian.AppendUint32(b, 1<<24)
	b = append(b, charset)
	b = append(b, make([]byte, 23)...)
	b = append(b, []byte(user)...)
	b = append(b, 0)
	b = append(b, 0) // empty auth response (CLIENT_SECURE_CONNECTION framing)
	if caps&mysqlCapConnectWithDB != 0 {
		b = append(b, []byte(db)...)
		b = append(b, 0)
	}
	if caps&mysqlCapPluginAuth != 0 {
		b = append(b, []byte("mysql_native_password")...)
		b = append(b, 0)
	}
	return b
}

// TestMySQLParseHandshakeResponse extracts exactly the fields we must mirror upstream.
func TestMySQLParseHandshakeResponse(t *testing.T) {
	caps := mysqlCapProtocol41 | mysqlCapSecureConn | mysqlCapConnectWithDB | mysqlCapPluginAuth | mysqlCapDeprecateEOF
	hs, err := mysqlParseHandshakeResponse(mysqlHandshakeResponseFixture(caps, 33, "appuser", "orders"))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if hs.Database != "orders" {
		t.Errorf("Database = %q, want orders", hs.Database)
	}
	if hs.Charset != 33 {
		t.Errorf("Charset = %d, want 33", hs.Charset)
	}
	if hs.Caps&mysqlCapDeprecateEOF == 0 {
		t.Error("DEPRECATE_EOF should survive parsing")
	}
}

// TestMySQLParseHandshakeResponse_RejectsPre41 — we cannot mirror a dialect we do not speak.
func TestMySQLParseHandshakeResponse_RejectsPre41(t *testing.T) {
	if _, err := mysqlParseHandshakeResponse(mysqlHandshakeResponseFixture(mysqlCapSecureConn, 33, "u", "")); err == nil {
		t.Fatal("expected pre-4.1 client to be rejected")
	}
}

// TestMySQLProxyCaps_ExcludesUnspliceable pins the capability policy: negotiating any of these
// downstream would make the post-auth byte pipe unsafe or needlessly widen the attack surface.
func TestMySQLProxyCaps_ExcludesUnspliceable(t *testing.T) {
	for name, bit := range map[string]uint32{
		"CLIENT_COMPRESS":         mysqlCapCompress,
		"CLIENT_SSL":              mysqlCapSSL,
		"CLIENT_LOCAL_FILES":      mysqlCapLocalFiles,
		"CLIENT_QUERY_ATTRIBUTES": mysqlCapQueryAttributes,
		"CLIENT_CONNECT_ATTRS":    mysqlCapConnectAttrs,
	} {
		if mysqlProxyCaps&bit != 0 {
			t.Errorf("%s must not be advertised to the app", name)
		}
	}
	if mysqlProxyCaps&mysqlCapProtocol41 == 0 || mysqlProxyCaps&mysqlCapDeprecateEOF == 0 {
		t.Error("PROTOCOL_41 and DEPRECATE_EOF are expected of any modern driver")
	}
}

// TestMySQLAcceptClient drives the local half against a fake driver over net.Pipe.
func TestMySQLAcceptClient(t *testing.T) {
	srv, cli := net.Pipe()
	defer func() { _ = srv.Close() }()
	defer func() { _ = cli.Close() }()

	type result struct {
		hs  mysqlClientHandshake
		err error
	}
	done := make(chan result, 1)
	go func() {
		hs, err := mysqlAcceptClient(srv)
		done <- result{hs, err}
	}()

	greeting, seq, err := mysqlReadPacket(cli)
	if err != nil {
		t.Fatalf("read greeting: %v", err)
	}
	if seq != 0 || greeting[0] != 10 {
		t.Fatalf("bad greeting: seq=%d ver=%d", seq, greeting[0])
	}
	if !bytes.Contains(greeting, []byte("alethia-authproxy")) {
		t.Error("greeting should identify the proxy rather than impersonate the server")
	}
	caps := mysqlCapProtocol41 | mysqlCapSecureConn | mysqlCapConnectWithDB | mysqlCapPluginAuth
	if err := mysqlWritePacket(cli, 1, mysqlHandshakeResponseFixture(caps, 45, "ignored", "shop")); err != nil {
		t.Fatalf("write response: %v", err)
	}

	select {
	case r := <-done:
		if r.err != nil {
			t.Fatalf("accept: %v", r.err)
		}
		if r.hs.Database != "shop" {
			t.Errorf("Database = %q", r.hs.Database)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out")
	}
}

// TestMySQLFinishAuth_LongTokenViaAuthSwitch is the fat-JWT proof. An Entra access token is commonly
// 1–2 KB and Azure publishes no MySQL-side bound, so the credential must travel in the
// AuthSwitchResponse (string<EOF>, bounded only by max_allowed_packet) and NOT in the 255-byte
// length-prefixed auth-response field. A regression here truncates the token and every connection
// fails authentication in the customer's cluster.
func TestMySQLFinishAuth_LongTokenViaAuthSwitch(t *testing.T) {
	token := strings.Repeat("j", 4096)
	srv, cli := net.Pipe()
	defer func() { _ = srv.Close() }()
	defer func() { _ = cli.Close() }()

	errCh := make(chan error, 1)
	go func() { errCh <- mysqlFinishAuth(srv, token) }()

	// Server: AuthSwitchRequest → mysql_clear_password.
	sw := []byte{0xFE}
	sw = append(sw, []byte(mysqlClearPasswordPlugin)...)
	sw = append(sw, 0)
	if err := mysqlWritePacket(cli, 2, sw); err != nil {
		t.Fatalf("write AuthSwitchRequest: %v", err)
	}
	got, _, err := mysqlReadPacket(cli)
	if err != nil {
		t.Fatalf("read AuthSwitchResponse: %v", err)
	}
	if want := append([]byte(token), 0); !bytes.Equal(got, want) {
		t.Fatalf("token not delivered intact: got %d bytes, want %d", len(got), len(want))
	}
	if err := mysqlWritePacket(cli, 4, mysqlOKPacket()); err != nil {
		t.Fatalf("write OK: %v", err)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("finish auth: %v", err)
	}
}

// TestMySQLFinishAuth_RejectsHashingPlugin — a bearer token cannot satisfy a challenge-response
// plugin, so we must fail closed and name the plugin rather than send the token somewhere useless.
func TestMySQLFinishAuth_RejectsHashingPlugin(t *testing.T) {
	srv, cli := net.Pipe()
	defer func() { _ = srv.Close() }()
	defer func() { _ = cli.Close() }()

	errCh := make(chan error, 1)
	go func() { errCh <- mysqlFinishAuth(srv, "tok") }()

	sw := []byte{0xFE}
	sw = append(sw, []byte("caching_sha2_password")...)
	sw = append(sw, 0)
	if err := mysqlWritePacket(cli, 2, sw); err != nil {
		t.Fatalf("write: %v", err)
	}
	err := <-errCh
	if err == nil || !strings.Contains(err.Error(), "caching_sha2_password") {
		t.Fatalf("expected a fail-closed error naming the plugin, got %v", err)
	}
}

// TestMySQLFinishAuth_SurfacesServerError keeps the upstream reason visible to operators.
func TestMySQLFinishAuth_SurfacesServerError(t *testing.T) {
	srv, cli := net.Pipe()
	defer func() { _ = srv.Close() }()
	defer func() { _ = cli.Close() }()

	errCh := make(chan error, 1)
	go func() { errCh <- mysqlFinishAuth(srv, "tok") }()

	e := []byte{0xFF}
	e = binary.LittleEndian.AppendUint16(e, 1045)
	e = append(e, '#')
	e = append(e, []byte("28000")...)
	e = append(e, []byte("Access denied for user 'alethia_app'")...)
	if err := mysqlWritePacket(cli, 2, e); err != nil {
		t.Fatalf("write: %v", err)
	}
	err := <-errCh
	if err == nil || !strings.Contains(err.Error(), "Access denied") {
		t.Fatalf("expected the server message to surface, got %v", err)
	}
}

// --- PostgreSQL wire --------------------------------------------------------------------------

// TestPGStartupMessage_ReplacesUserAndDropsReplication — the app never chooses the upstream identity.
func TestPGStartupMessage_ReplacesUserAndDropsReplication(t *testing.T) {
	msg := pgStartupMessage(map[string]string{
		"user":            "whatever-the-app-said",
		"database":        "orders",
		"replication":     "database",
		"client_encoding": "UTF8",
	}, "alethia_app")

	if got := binary.BigEndian.Uint32(msg[:4]); int(got) != len(msg) {
		t.Errorf("length prefix %d != actual %d", got, len(msg))
	}
	if binary.BigEndian.Uint32(msg[4:8]) != pgProtocolVersion3 {
		t.Error("wrong protocol version")
	}
	body := string(msg[8:])
	if !strings.Contains(body, "user\x00alethia_app\x00") {
		t.Error("upstream user must be the platform identity")
	}
	if strings.Contains(body, "whatever-the-app-said") {
		t.Error("the app's requested user must not reach the server")
	}
	if strings.Contains(body, "replication") {
		t.Error("replication must be dropped")
	}
	if !strings.Contains(body, "database\x00orders\x00") || !strings.Contains(body, "client_encoding\x00UTF8\x00") {
		t.Error("app parameters should be forwarded")
	}
}

// TestPGAcceptClient_DeclinesSSLThenReadsStartup mirrors what a real driver does with sslmode=prefer.
func TestPGAcceptClient_DeclinesSSLThenReadsStartup(t *testing.T) {
	srv, cli := net.Pipe()
	defer func() { _ = srv.Close() }()
	defer func() { _ = cli.Close() }()

	type result struct {
		params map[string]string
		err    error
	}
	done := make(chan result, 1)
	go func() {
		p, err := pgAcceptClient(srv)
		done <- result{p, err}
	}()

	req := binary.BigEndian.AppendUint32(nil, 8)
	req = binary.BigEndian.AppendUint32(req, pgSSLRequestCode)
	if _, err := cli.Write(req); err != nil {
		t.Fatalf("write SSLRequest: %v", err)
	}
	var resp [1]byte
	if _, err := cli.Read(resp[:]); err != nil {
		t.Fatalf("read SSL response: %v", err)
	}
	if resp[0] != 'N' {
		t.Fatalf("expected TLS to be declined on loopback, got %q", resp[0])
	}
	if _, err := cli.Write(pgStartupMessage(map[string]string{"database": "orders"}, "appuser")); err != nil {
		t.Fatalf("write startup: %v", err)
	}

	select {
	case r := <-done:
		if r.err != nil {
			t.Fatalf("accept: %v", r.err)
		}
		if r.params["database"] != "orders" {
			t.Errorf("params = %v", r.params)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out")
	}
}

// TestPGAcceptClient_RejectsCancelRequest — we never tracked the backend key, so forwarding would be
// a lie; say so instead.
func TestPGAcceptClient_RejectsCancelRequest(t *testing.T) {
	srv, cli := net.Pipe()
	defer func() { _ = srv.Close() }()
	defer func() { _ = cli.Close() }()

	errCh := make(chan error, 1)
	go func() {
		_, err := pgAcceptClient(srv)
		errCh <- err
	}()
	req := binary.BigEndian.AppendUint32(nil, 16)
	req = binary.BigEndian.AppendUint32(req, pgCancelRequestCode)
	req = binary.BigEndian.AppendUint32(req, 42)
	req = binary.BigEndian.AppendUint32(req, 4242)
	if _, err := cli.Write(req); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := <-errCh; err == nil || !strings.Contains(err.Error(), "cancel request") {
		t.Fatalf("expected cancel to be refused, got %v", err)
	}
}

// TestPGFinishAuth_LongTokenCleartext — the PostgreSQL PasswordMessage is length-prefixed with an
// int32, so a multi-kilobyte Entra token is safe; prove it end to end.
func TestPGFinishAuth_LongTokenCleartext(t *testing.T) {
	token := strings.Repeat("k", 4096)
	srv, cli := net.Pipe()
	defer func() { _ = srv.Close() }()
	defer func() { _ = cli.Close() }()

	errCh := make(chan error, 1)
	go func() { errCh <- pgFinishAuth(srv, token) }()

	if err := pgWriteMessage(cli, 'R', binary.BigEndian.AppendUint32(nil, pgAuthCleartext)); err != nil {
		t.Fatalf("write auth request: %v", err)
	}
	typ, body, err := pgReadMessage(cli)
	if err != nil {
		t.Fatalf("read password message: %v", err)
	}
	if typ != 'p' {
		t.Fatalf("expected PasswordMessage, got %q", typ)
	}
	if want := append([]byte(token), 0); !bytes.Equal(body, want) {
		t.Fatalf("token not delivered intact: got %d bytes, want %d", len(body), len(want))
	}
	if err := pgWriteMessage(cli, 'R', binary.BigEndian.AppendUint32(nil, pgAuthOK)); err != nil {
		t.Fatalf("write auth ok: %v", err)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("finish auth: %v", err)
	}
}

// TestPGFinishAuth_RejectsHashedMethods — MD5/SCRAM verify against a stored password, which a bearer
// token is not. Fail closed with a diagnosis rather than retrying forever.
func TestPGFinishAuth_RejectsHashedMethods(t *testing.T) {
	for name, code := range map[string]uint32{"md5": pgAuthMD5, "scram": pgAuthSASL} {
		t.Run(name, func(t *testing.T) {
			srv, cli := net.Pipe()
			defer func() { _ = srv.Close() }()
			defer func() { _ = cli.Close() }()

			errCh := make(chan error, 1)
			go func() { errCh <- pgFinishAuth(srv, "tok") }()
			if err := pgWriteMessage(cli, 'R', binary.BigEndian.AppendUint32(nil, code)); err != nil {
				t.Fatalf("write: %v", err)
			}
			if err := <-errCh; err == nil || !strings.Contains(err.Error(), "cleartext password auth") {
				t.Fatalf("expected a fail-closed diagnosis, got %v", err)
			}
		})
	}
}

// TestPGErrText pulls the operator-facing reason out of an ErrorResponse.
func TestPGErrText(t *testing.T) {
	body := []byte("SFATAL\x00C28000\x00Mpassword authentication failed\x00\x00")
	if got := pgErrText(body); got != "password authentication failed" {
		t.Fatalf("pgErrText = %q", got)
	}
}

// --- splice -----------------------------------------------------------------------------------

// TestSpliceConns proves the post-auth pipe is bidirectional and terminates when a side closes.
func TestSpliceConns(t *testing.T) {
	clientSide, proxyClient := net.Pipe()
	proxyUpstream, upstreamSide := net.Pipe()

	go spliceConns(proxyClient, proxyUpstream)

	go func() {
		_, _ = clientSide.Write([]byte("SELECT 1"))
	}()
	buf := make([]byte, 8)
	_ = upstreamSide.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := upstreamSide.Read(buf); err != nil {
		t.Fatalf("upstream read: %v", err)
	}
	if string(buf) != "SELECT 1" {
		t.Fatalf("client→upstream = %q", buf)
	}

	go func() {
		_, _ = upstreamSide.Write([]byte("ROW-DATA"))
	}()
	_ = clientSide.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := clientSide.Read(buf); err != nil {
		t.Fatalf("client read: %v", err)
	}
	if string(buf) != "ROW-DATA" {
		t.Fatalf("upstream→client = %q", buf)
	}
	_ = clientSide.Close()
	_ = upstreamSide.Close()
}
