// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Wire-level proofs for the db-authproxy halves that only ran against a live database:
// the upstream handshake builders, the server-handshake reader's fail-closed cases, the
// TLS refusal on both engines, and the client-facing error packets both engines emit when
// the token mint fails. Every case drives a real socket (net.Pipe / a loopback listener)
// so the framing is exercised, not asserted about.
package agent

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

// mysqlServerHandshake builds a minimal Protocol::HandshakeV10 payload advertising caps.
func mysqlServerHandshake(caps uint32) []byte {
	var b []byte
	b = append(b, 10)
	b = append(b, []byte("8.0.36-test")...)
	b = append(b, 0)
	b = binary.LittleEndian.AppendUint32(b, 7) // connection id
	b = append(b, []byte("12345678")...)       // auth-plugin-data-part-1
	b = append(b, 0)                           // filler
	b = binary.LittleEndian.AppendUint16(b, uint16(caps&0xFFFF))
	b = append(b, mysqlDefaultCharset)
	b = binary.LittleEndian.AppendUint16(b, 2) // status
	b = binary.LittleEndian.AppendUint16(b, uint16(caps>>16))
	b = append(b, 21)
	b = append(b, make([]byte, 10)...)
	return b
}

// TestMySQLReadServerHandshake reads the capability flags off a well-formed server
// handshake and fail-closes on every malformed / rejecting shape.
func TestMySQLReadServerHandshake(t *testing.T) {
	caps := mysqlCapProtocol41 | mysqlCapSSL | mysqlCapSecureConn | mysqlCapDeprecateEOF

	cases := []struct {
		name    string
		payload []byte
		want    uint32
		errText string
	}{
		{name: "well-formed", payload: mysqlServerHandshake(caps), want: caps},
		{name: "server ERR packet", payload: append([]byte{0xFF, 0x15, 0x04, '#', 'H', 'Y', '0', '0', '0'},
			[]byte("Too many connections")...), errText: "server rejected the connection"},
		{name: "wrong protocol version", payload: []byte{9, 0}, errText: "want protocol version 10"},
		{name: "unterminated version", payload: []byte{10, 'x', 'y'}, errText: "unterminated version"},
		{name: "truncated capabilities", payload: []byte{10, 'x', 0, 1, 2, 3}, errText: "truncated capabilities"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cli, srv := net.Pipe()
			defer cli.Close()
			defer srv.Close()
			go func() { _ = mysqlWritePacket(srv, 0, tc.payload) }()

			got, err := mysqlReadServerHandshake(cli)
			if tc.errText != "" {
				if err == nil || !strings.Contains(err.Error(), tc.errText) {
					t.Fatalf("err = %v, want one containing %q", err, tc.errText)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("caps = %#08x, want %#08x", got, tc.want)
			}
		})
	}
}

// TestMySQLSSLRequestAndHandshakeResponse locks the two upstream packet builders: the
// SSLRequest is exactly the 32-byte prefix, and the handshake response carries the
// PLATFORM login with an EMPTY auth response (so the token rides the AuthSwitchResponse's
// unbounded string<EOF> field instead of a 255-byte length prefix).
func TestMySQLSSLRequestAndHandshakeResponse(t *testing.T) {
	hs := mysqlClientHandshake{
		Caps:      mysqlCapProtocol41 | mysqlCapConnectWithDB | mysqlCapSecureConn,
		Charset:   33,
		MaxPacket: 4096,
		Database:  "appdb",
	}
	caps := mysqlProxyCaps | mysqlCapSSL | mysqlCapPluginAuth | mysqlCapSecureConn

	ssl := mysqlSSLRequest(caps, hs)
	if len(ssl) != 32 {
		t.Fatalf("SSLRequest is %d bytes, want exactly 32", len(ssl))
	}
	if got := binary.LittleEndian.Uint32(ssl[0:4]); got != caps {
		t.Errorf("SSLRequest caps = %#08x, want %#08x", got, caps)
	}
	if got := binary.LittleEndian.Uint32(ssl[4:8]); got != hs.MaxPacket {
		t.Errorf("SSLRequest max-packet = %d, want the client's %d", got, hs.MaxPacket)
	}
	if ssl[8] != hs.Charset {
		t.Errorf("SSLRequest charset = %d, want the client's %d", ssl[8], hs.Charset)
	}

	resp := mysqlHandshakeResponse(caps, hs, "alethia_app")
	if !strings.HasPrefix(string(resp), string(ssl)) {
		t.Fatal("HandshakeResponse41 must start with the same 32-byte prefix as SSLRequest")
	}
	tail := resp[32:]
	userEnd := indexByteFrom(tail, 0, 0)
	if userEnd < 0 || string(tail[:userEnd]) != "alethia_app" {
		t.Fatalf("upstream login = %q, want the platform user", string(tail[:max(userEnd, 0)]))
	}
	if tail[userEnd+1] != 0 {
		t.Fatalf("auth-response length = %d, want 0 (an empty response forces the AuthSwitch path)", tail[userEnd+1])
	}
	if !strings.Contains(string(resp), "appdb") {
		t.Error("the app's database must be mirrored upstream")
	}
	if !strings.Contains(string(resp), mysqlClearPasswordPlugin) {
		t.Errorf("the requested plugin must be %s", mysqlClearPasswordPlugin)
	}
}

// TestMySQLMaxPacketAndCharsetDefaults covers the "keep the app's preference, default when
// it sent none" helpers on both branches.
func TestMySQLMaxPacketAndCharsetDefaults(t *testing.T) {
	if got := mysqlMaxPacketOr(0); got != mysqlMaxPacket {
		t.Errorf("mysqlMaxPacketOr(0) = %d, want the %d default", got, mysqlMaxPacket)
	}
	if got := mysqlMaxPacketOr(1234); got != 1234 {
		t.Errorf("mysqlMaxPacketOr(1234) = %d, want the client's value", got)
	}
	if got := mysqlCharsetOr(0); got != mysqlDefaultCharset {
		t.Errorf("mysqlCharsetOr(0) = %d, want the %d default", got, mysqlDefaultCharset)
	}
	if got := mysqlCharsetOr(33); got != 33 {
		t.Errorf("mysqlCharsetOr(33) = %d, want the client's value", got)
	}
}

// TestMySQLReadLenEnc walks every length-encoded-integer width plus the truncated forms
// that must fail rather than read past the buffer.
func TestMySQLReadLenEnc(t *testing.T) {
	cases := []struct {
		name    string
		in      []byte
		pos     int
		want    uint64
		wantAdv int
		wantErr bool
	}{
		{name: "1-byte", in: []byte{0x07}, want: 7, wantAdv: 1},
		{name: "2-byte", in: []byte{0xFC, 0x34, 0x12}, want: 0x1234, wantAdv: 3},
		{name: "3-byte", in: []byte{0xFD, 0x03, 0x02, 0x01}, want: 0x010203, wantAdv: 4},
		{name: "8-byte", in: []byte{0xFE, 1, 0, 0, 0, 0, 0, 0, 0}, want: 1, wantAdv: 9},
		{name: "past end", in: []byte{0x01}, pos: 5, wantErr: true},
		{name: "truncated 2-byte", in: []byte{0xFC, 0x34}, wantErr: true},
		{name: "truncated 8-byte", in: []byte{0xFE, 1, 2}, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, adv, err := mysqlReadLenEnc(tc.in, tc.pos)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected an error, got %d/%d", got, adv)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want || adv != tc.wantAdv {
				t.Fatalf("= (%d, %d), want (%d, %d)", got, adv, tc.want, tc.wantAdv)
			}
		})
	}
}

// TestMySQLDialUpstream_RefusesPlaintextServer proves the fail-closed rule that matters
// most on this leg: a server that does not advertise CLIENT_SSL never receives the token.
func TestMySQLDialUpstream_RefusesPlaintextServer(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, aerr := ln.Accept()
		if aerr != nil {
			return
		}
		defer conn.Close()
		// No CLIENT_SSL in the advertised capabilities.
		_ = mysqlWritePacket(conn, 0, mysqlServerHandshake(mysqlCapProtocol41|mysqlCapSecureConn))
		time.Sleep(50 * time.Millisecond)
	}()

	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEngineMySQL,
		Upstream: ln.Addr().String(), Listen: "127.0.0.1:3306", User: "alethia_app", Region: "eu-west-1"}
	hs := mysqlClientHandshake{Caps: mysqlCapProtocol41 | mysqlCapSecureConn}

	conn, err := mysqlDialUpstream(context.Background(), cfg, hs, "super-secret-token")
	if conn != nil {
		conn.Close()
		t.Fatal("a connection was returned to a server that cannot do TLS")
	}
	if err == nil || !strings.Contains(err.Error(), "does not advertise CLIENT_SSL") {
		t.Fatalf("err = %v, want the plaintext refusal", err)
	}
}

// TestMySQLDialUpstream_RefusesMissingFramingCap proves the splice-safety gate: a framing
// flag the app negotiated but the server lacks is refused rather than spliced.
func TestMySQLDialUpstream_RefusesMissingFramingCap(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, aerr := ln.Accept()
		if aerr != nil {
			return
		}
		defer conn.Close()
		// TLS-capable but WITHOUT CLIENT_DEPRECATE_EOF, which the client below negotiates.
		_ = mysqlWritePacket(conn, 0, mysqlServerHandshake(mysqlCapProtocol41|mysqlCapSSL|mysqlCapSecureConn))
		time.Sleep(50 * time.Millisecond)
	}()

	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEngineMySQL,
		Upstream: ln.Addr().String(), Listen: "127.0.0.1:3306", User: "alethia_app", Region: "eu-west-1"}
	hs := mysqlClientHandshake{Caps: mysqlCapProtocol41 | mysqlCapDeprecateEOF}

	conn, err := mysqlDialUpstream(context.Background(), cfg, hs, "super-secret-token")
	if conn != nil {
		conn.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "framing-critical capability") {
		t.Fatalf("err = %v, want the framing-capability refusal", err)
	}
}

// TestHandleMySQLConn_MintFailureTellsTheApp drives the whole client-facing path for a
// failed token mint: the local handshake completes, an ERR_Packet reaches the app instead
// of a bare closed socket, and the mint error propagates to the caller.
func TestHandleMySQLConn_MintFailureTellsTheApp(t *testing.T) {
	cli, srv := net.Pipe()
	defer cli.Close()
	defer srv.Close()

	cfg := authProxyConfig{Provider: "azure", Engine: authProxyEngineMySQL,
		Upstream: "db.example.test:3306", Listen: "127.0.0.1:3306", User: "alethia_app"}
	mintErr := errors.New("identity endpoint unavailable")

	errCh := make(chan error, 1)
	go func() {
		errCh <- handleMySQLConn(context.Background(), cfg, srv,
			func(context.Context) (string, error) { return "", mintErr })
	}()

	if _, _, err := mysqlReadPacket(cli); err != nil {
		t.Fatalf("read initial handshake: %v", err)
	}
	resp := make([]byte, 32)
	caps := mysqlCapProtocol41 | mysqlCapSecureConn
	binary.LittleEndian.PutUint32(resp[0:4], caps)
	resp = append(resp, []byte("app")...)
	resp = append(resp, 0, 0)
	if err := mysqlWritePacket(cli, 1, resp); err != nil {
		t.Fatalf("write handshake response: %v", err)
	}

	_ = cli.SetReadDeadline(time.Now().Add(5 * time.Second))
	p, _, err := mysqlReadPacket(cli)
	if err != nil {
		t.Fatalf("read ERR packet: %v", err)
	}
	if len(p) == 0 || p[0] != 0xFF {
		t.Fatalf("payload % x is not an ERR_Packet", p)
	}
	if !strings.Contains(mysqlErrText(p), "could not mint a database token") {
		t.Errorf("ERR text = %q, want the mint-failure reason", mysqlErrText(p))
	}
	if got := <-errCh; !errors.Is(got, mintErr) {
		t.Errorf("handleMySQLConn returned %v, want the mint error", got)
	}
}

// TestPGDialUpstream_RefusesPlaintextServer is the PostgreSQL twin: a server answering the
// SSLRequest with 'N' never receives the token.
func TestPGDialUpstream_RefusesPlaintextServer(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, aerr := ln.Accept()
		if aerr != nil {
			return
		}
		defer conn.Close()
		hdr := make([]byte, 8)
		if _, rerr := readFullConn(conn, hdr); rerr != nil {
			return
		}
		_, _ = conn.Write([]byte{'N'}) // TLS declined
		time.Sleep(50 * time.Millisecond)
	}()

	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEnginePostgres,
		Upstream: ln.Addr().String(), Listen: "127.0.0.1:5432", User: "alethia_app", Region: "eu-west-1"}

	conn, err := pgDialUpstream(context.Background(), cfg, map[string]string{"database": "appdb"}, "tok")
	if conn != nil {
		conn.Close()
		t.Fatal("a connection was returned to a server that declined TLS")
	}
	if err == nil || !strings.Contains(err.Error(), "refusing to send a token over an unencrypted connection") {
		t.Fatalf("err = %v, want the plaintext refusal", err)
	}
}

// readFullConn fills buf from c, so the stub servers above can consume a fixed prefix.
func readFullConn(c net.Conn, buf []byte) (int, error) {
	read := 0
	for read < len(buf) {
		n, err := c.Read(buf[read:])
		read += n
		if err != nil {
			return read, err
		}
	}
	return read, nil
}

// TestHandlePostgresConn_MintFailureTellsTheApp drives the PostgreSQL client-facing path
// for a failed mint: SSL is declined on the loopback hop, the startup is consumed, and an
// ErrorResponse carrying SQLSTATE 28000 reaches the driver.
func TestHandlePostgresConn_MintFailureTellsTheApp(t *testing.T) {
	cli, srv := net.Pipe()
	defer cli.Close()
	defer srv.Close()

	cfg := authProxyConfig{Provider: "azure", Engine: authProxyEnginePostgres,
		Upstream: "db.example.test:5432", Listen: "127.0.0.1:5432", User: "alethia_app"}
	mintErr := errors.New("federated token file missing")

	errCh := make(chan error, 1)
	go func() {
		errCh <- handlePostgresConn(context.Background(), cfg, srv,
			func(context.Context) (string, error) { return "", mintErr })
	}()

	// SSLRequest, expect the 'N' decline.
	ssl := binary.BigEndian.AppendUint32(nil, 8)
	ssl = binary.BigEndian.AppendUint32(ssl, pgSSLRequestCode)
	if _, err := cli.Write(ssl); err != nil {
		t.Fatalf("write SSLRequest: %v", err)
	}
	var declined [1]byte
	_ = cli.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := cli.Read(declined[:]); err != nil {
		t.Fatalf("read SSL decline: %v", err)
	}
	if declined[0] != 'N' {
		t.Fatalf("SSL response = %q, want 'N'", declined[0])
	}

	// StartupMessage.
	body := binary.BigEndian.AppendUint32(nil, pgProtocolVersion3)
	body = append(body, []byte("user\x00app\x00database\x00appdb\x00")...)
	body = append(body, 0)
	if _, err := cli.Write(append(binary.BigEndian.AppendUint32(nil, uint32(len(body)+4)), body...)); err != nil {
		t.Fatalf("write startup: %v", err)
	}

	typ, errBody, err := pgReadMessage(cli)
	if err != nil {
		t.Fatalf("read ErrorResponse: %v", err)
	}
	if typ != 'E' {
		t.Fatalf("message type = %q, want 'E'", typ)
	}
	if !strings.Contains(string(errBody), "28000") {
		t.Errorf("ErrorResponse %q must carry SQLSTATE 28000", string(errBody))
	}
	if got := pgErrText(errBody); !strings.Contains(got, "could not mint a database token") {
		t.Errorf("ErrorResponse message = %q, want the mint-failure reason", got)
	}
	if got := <-errCh; !errors.Is(got, mintErr) {
		t.Errorf("handlePostgresConn returned %v, want the mint error", got)
	}
}

// TestHandleAuthProxyConn_UnknownEngine covers the dispatcher's fail-closed default: a
// config that somehow reaches it with an unsupported engine gets no handler, not a splice.
func TestHandleAuthProxyConn_UnknownEngine(t *testing.T) {
	cli, srv := net.Pipe()
	defer cli.Close()
	defer srv.Close()

	cfg := authProxyConfig{Provider: "aws", Engine: "cassandra"}
	err := handleAuthProxyConn(context.Background(), cfg, srv,
		func(context.Context) (string, error) { return "tok", nil })
	if err == nil || !strings.Contains(err.Error(), "no handler for engine") {
		t.Fatalf("err = %v, want the no-handler refusal", err)
	}
}

// TestServeAuthProxy_ShutsDownCleanlyOnCancel proves the accept loop treats a cancelled
// context as a clean shutdown (nil), not an accept failure, and drains its handlers.
func TestServeAuthProxy_ShutsDownCleanlyOnCancel(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cfg := authProxyConfig{Provider: "aws", Engine: "cassandra"} // handler errors, logged not fatal

	done := make(chan error, 1)
	go func() {
		done <- serveAuthProxy(ctx, cfg, ln, func(context.Context) (string, error) { return "tok", nil })
	}()

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = conn.Close()

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveAuthProxy returned %v, want nil on a cancelled context", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serveAuthProxy did not return after the context was cancelled")
	}
}

// TestRunDBAuthProxy_ValidationAndShutdown covers the subcommand entry point end to end
// without a database: a bad flag set fails closed, and a valid one listens and returns
// cleanly when the context is cancelled.
func TestRunDBAuthProxy_ValidationAndShutdown(t *testing.T) {
	if err := RunDBAuthProxy(context.Background(), []string{"--provider", "gcp", "--engine", "postgres"}); err == nil ||
		!strings.Contains(err.Error(), "gcp is not served here") {
		t.Fatalf("err = %v, want the gcp refusal", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- RunDBAuthProxy(ctx, []string{
			"--provider", "azure", "--engine", "mysql",
			"--upstream", "db.example.test:3306",
			"--listen", "127.0.0.1:0",
			"--user", "alethia_app",
		})
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("RunDBAuthProxy returned %v, want nil on shutdown", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RunDBAuthProxy did not shut down")
	}
}

// TestMySQLWriteError covers the ERR_Packet builder's shape: the 0xFF marker, the error
// code, the '#' SQLSTATE marker and the human-readable tail.
func TestMySQLWriteError(t *testing.T) {
	cli, srv := net.Pipe()
	defer cli.Close()
	defer srv.Close()

	go func() { mysqlWriteError(srv, 2, 1045, "28000", "access denied") }()

	p, _, err := mysqlReadPacket(cli)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if p[0] != 0xFF {
		t.Fatalf("marker = %#x, want 0xFF", p[0])
	}
	if code := binary.LittleEndian.Uint16(p[1:3]); code != 1045 {
		t.Errorf("error code = %d, want 1045", code)
	}
	if p[3] != '#' || string(p[4:9]) != "28000" {
		t.Errorf("SQLSTATE section = %q, want \"#28000\"", string(p[3:9]))
	}
	if got := mysqlErrText(p); got != "access denied" {
		t.Errorf("message = %q, want \"access denied\"", got)
	}
}

// TestPGWriteError covers the ErrorResponse builder: severity, SQLSTATE and message
// fields, all NUL-terminated with the trailing terminator the protocol requires.
func TestPGWriteError(t *testing.T) {
	cli, srv := net.Pipe()
	defer cli.Close()
	defer srv.Close()

	go func() { pgWriteError(srv, "28000", "no token") }()

	typ, body, err := pgReadMessage(cli)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != 'E' {
		t.Fatalf("type = %q, want 'E'", typ)
	}
	for _, want := range []string{"SFATAL\x00", "C28000\x00", "Mno token\x00"} {
		if !strings.Contains(string(body), want) {
			t.Errorf("body %q is missing field %q", string(body), want)
		}
	}
	if body[len(body)-1] != 0 {
		t.Error("ErrorResponse must end with the field terminator")
	}
	if got := pgErrText(body); got != "no token" {
		t.Errorf("pgErrText = %q, want \"no token\"", got)
	}
}
