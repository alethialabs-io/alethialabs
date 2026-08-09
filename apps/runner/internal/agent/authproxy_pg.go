// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

// The PostgreSQL half of db-authproxy. Same shape as the MySQL half: terminate the app's startup
// locally, authenticate upstream over TLS with a minted token as a cleartext password, then splice.
//
// The ordering here is deliberate and worth stating, because it is what lets a raw pipe work. A
// PostgreSQL server answers a successful startup with AuthenticationOk, then a run of
// ParameterStatus messages, BackendKeyData, and finally ReadyForQuery — and a driver depends on
// those. So we authenticate upstream FIRST, consume only its AuthenticationOk, send our own
// AuthenticationOk to the app, and then splice: the upstream's ParameterStatus / BackendKeyData /
// ReadyForQuery flow straight through to the app untouched. The app therefore sees the real
// server's parameters (server_version, client_encoding, integer_datetimes, …) rather than anything
// we invented.

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
)

const (
	// pgProtocolVersion3 is the StartupMessage version for protocol 3.0.
	pgProtocolVersion3 = 196608
	// pgSSLRequestCode / pgCancelRequestCode / pgGSSENCRequestCode are the pseudo-versions a client
	// may send in place of a real startup packet.
	pgSSLRequestCode    = 80877103
	pgCancelRequestCode = 80877102
	pgGSSENCRequestCode = 80877104
	// pgMaxStartupSize bounds the startup packet we are willing to buffer.
	pgMaxStartupSize = 1 << 20

	// Authentication sub-codes we care about.
	pgAuthOK        = 0
	pgAuthCleartext = 3
	pgAuthMD5       = 5
	pgAuthSASL      = 10
)

// handlePostgresConn runs one app connection: local startup, token mint, upstream TLS auth, splice.
func handlePostgresConn(ctx context.Context, cfg authProxyConfig, client net.Conn, src tokenSource) error {
	params, err := pgAcceptClient(client)
	if err != nil {
		return fmt.Errorf("postgres: local startup: %w", err)
	}

	token, err := src(ctx)
	if err != nil {
		pgWriteError(client, "28000", "alethia db-authproxy could not mint a database token")
		return err
	}

	upstream, err := pgDialUpstream(ctx, cfg, params, token)
	if err != nil {
		pgWriteError(client, "28000", "alethia db-authproxy could not authenticate upstream")
		return fmt.Errorf("postgres: upstream: %w", err)
	}
	defer func() { _ = upstream.Close() }()

	// Our own AuthenticationOk; everything the server said after ITS AuthenticationOk (parameters,
	// backend key, ReadyForQuery) is still queued upstream and reaches the app via the splice.
	if err := pgWriteMessage(client, 'R', binary.BigEndian.AppendUint32(nil, pgAuthOK)); err != nil {
		return fmt.Errorf("postgres: send AuthenticationOk: %w", err)
	}
	spliceConns(client, upstream)
	return nil
}

// pgAcceptClient completes the startup phase facing the app and returns the startup parameters it
// asked for. No credential is demanded: reaching this proxy over loopback inside the app's own pod
// is the authorization.
func pgAcceptClient(client net.Conn) (map[string]string, error) {
	for {
		body, code, err := pgReadStartup(client)
		if err != nil {
			return nil, err
		}
		switch code {
		case pgSSLRequestCode, pgGSSENCRequestCode:
			// Decline transport encryption on the loopback hop and let the client retry in the
			// clear. The UPSTREAM hop is always TLS — that is where the token travels.
			if _, err := client.Write([]byte{'N'}); err != nil {
				return nil, fmt.Errorf("decline SSL: %w", err)
			}
			continue
		case pgCancelRequestCode:
			// Cancellation opens a fresh connection keyed by the backend secret we never tracked, so
			// we cannot forward it correctly. Ending the connection is honest; the query simply runs
			// to completion.
			return nil, errors.New("cancel request is not supported by the auth proxy")
		case pgProtocolVersion3:
			return pgParseStartupParams(body)
		default:
			return nil, fmt.Errorf("unsupported startup protocol version %d", code)
		}
	}
}

// pgReadStartup reads one startup-style packet (length-prefixed, no type byte), returning the body
// after the version field and the version/pseudo-version code itself.
func pgReadStartup(c net.Conn) ([]byte, uint32, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(c, lenBuf[:]); err != nil {
		return nil, 0, fmt.Errorf("read startup length: %w", err)
	}
	n := binary.BigEndian.Uint32(lenBuf[:])
	if n < 8 || n > pgMaxStartupSize {
		return nil, 0, fmt.Errorf("implausible startup length %d", n)
	}
	buf := make([]byte, n-4)
	if _, err := io.ReadFull(c, buf); err != nil {
		return nil, 0, fmt.Errorf("read startup body: %w", err)
	}
	return buf[4:], binary.BigEndian.Uint32(buf[:4]), nil
}

// pgParseStartupParams decodes the NUL-separated key/value pairs of a StartupMessage.
func pgParseStartupParams(body []byte) (map[string]string, error) {
	params := map[string]string{}
	parts := strings.Split(string(body), "\x00")
	for i := 0; i+1 < len(parts); i += 2 {
		if parts[i] == "" {
			break
		}
		params[parts[i]] = parts[i+1]
	}
	if len(params) == 0 {
		return nil, errors.New("startup message carried no parameters")
	}
	return params, nil
}

// pgDialUpstream connects to the real database over TLS and authenticates as cfg.User with the
// minted token as a cleartext password. The app's startup parameters are forwarded so the session
// behaves the same on both legs; only the login identity is replaced.
func pgDialUpstream(ctx context.Context, cfg authProxyConfig, params map[string]string, token string) (net.Conn, error) {
	d := net.Dialer{}
	raw, err := d.DialContext(ctx, "tcp", cfg.Upstream)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", cfg.Upstream, err)
	}
	ok := false
	defer func() {
		if !ok {
			_ = raw.Close()
		}
	}()

	// SSLRequest — the token must never touch an unencrypted socket.
	req := binary.BigEndian.AppendUint32(nil, 8)
	req = binary.BigEndian.AppendUint32(req, pgSSLRequestCode)
	if _, err := raw.Write(req); err != nil {
		return nil, fmt.Errorf("send SSLRequest: %w", err)
	}
	var resp [1]byte
	if _, err := io.ReadFull(raw, resp[:]); err != nil {
		return nil, fmt.Errorf("read SSLRequest response: %w", err)
	}
	if resp[0] != 'S' {
		return nil, errors.New("upstream refused TLS; refusing to send a token over an unencrypted connection")
	}
	tlsConn := tls.Client(raw, upstreamTLSConfig(cfg.upstreamHost()))
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		return nil, fmt.Errorf("upstream TLS handshake: %w", err)
	}

	if _, err := tlsConn.Write(pgStartupMessage(params, cfg.User)); err != nil {
		return nil, fmt.Errorf("send startup: %w", err)
	}
	if err := pgFinishAuth(tlsConn, token); err != nil {
		return nil, err
	}
	ok = true
	return tlsConn, nil
}

// pgStartupMessage builds the upstream StartupMessage: the app's parameters with `user` replaced by
// the platform-managed login. `replication` is dropped — this proxy fronts ordinary sessions.
func pgStartupMessage(params map[string]string, user string) []byte {
	var body []byte
	body = binary.BigEndian.AppendUint32(body, pgProtocolVersion3)
	appendParam := func(k, v string) {
		body = append(body, []byte(k)...)
		body = append(body, 0)
		body = append(body, []byte(v)...)
		body = append(body, 0)
	}
	appendParam("user", user)
	// Deterministic order for the rest so the packet is byte-stable and unit-testable.
	for _, k := range pgSortedKeys(params) {
		if k == "user" || k == "replication" {
			continue
		}
		appendParam(k, params[k])
	}
	body = append(body, 0)
	return append(binary.BigEndian.AppendUint32(nil, uint32(len(body)+4)), body...)
}

// pgSortedKeys returns the parameter names in sorted order.
func pgSortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

// pgFinishAuth answers the server's authentication request with the token and returns once the
// server reports AuthenticationOk. Hashing methods fail closed: a token is a bearer credential and
// cannot satisfy a challenge the server expects to verify against a stored password.
func pgFinishAuth(c net.Conn, token string) error {
	for {
		typ, body, err := pgReadMessage(c)
		if err != nil {
			return fmt.Errorf("read auth response: %w", err)
		}
		switch typ {
		case 'E':
			return fmt.Errorf("upstream authentication failed: %s", pgErrText(body))
		case 'R':
			if len(body) < 4 {
				return errors.New("truncated authentication message")
			}
			switch code := binary.BigEndian.Uint32(body[:4]); code {
			case pgAuthOK:
				return nil
			case pgAuthCleartext:
				msg := append([]byte(token), 0)
				if err := pgWriteMessage(c, 'p', msg); err != nil {
					return fmt.Errorf("send cleartext token: %w", err)
				}
			case pgAuthMD5:
				return errors.New("upstream requested MD5 authentication; an IAM/Entra token requires " +
					"cleartext password auth (is the configured --user an IAM database user?)")
			case pgAuthSASL:
				return errors.New("upstream requested SCRAM/SASL authentication; an IAM/Entra token requires " +
					"cleartext password auth (is the configured --user an IAM database user?)")
			default:
				return fmt.Errorf("unsupported authentication method %d", code)
			}
		default:
			return fmt.Errorf("unexpected message %q during authentication", typ)
		}
	}
}

// pgReadMessage reads one typed protocol message, returning its type byte and payload.
func pgReadMessage(c net.Conn) (byte, []byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(c, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[1:5])
	if n < 4 || n > pgMaxStartupSize {
		return 0, nil, fmt.Errorf("implausible message length %d", n)
	}
	body := make([]byte, n-4)
	if _, err := io.ReadFull(c, body); err != nil {
		return 0, nil, err
	}
	return hdr[0], body, nil
}

// pgWriteMessage writes one typed protocol message.
func pgWriteMessage(c net.Conn, typ byte, body []byte) error {
	buf := []byte{typ}
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(body)+4))
	buf = append(buf, body...)
	_, err := c.Write(buf)
	return err
}

// pgWriteError sends an ErrorResponse so the app's driver reports a real failure rather than a bare
// closed socket. Best-effort — the connection is being torn down regardless.
func pgWriteError(c net.Conn, sqlState, msg string) {
	var b []byte
	b = append(b, 'S')
	b = append(b, []byte("FATAL")...)
	b = append(b, 0)
	b = append(b, 'C')
	b = append(b, []byte(sqlState)...)
	b = append(b, 0)
	b = append(b, 'M')
	b = append(b, []byte(msg)...)
	b = append(b, 0)
	b = append(b, 0)
	_ = pgWriteMessage(c, 'E', b)
}

// pgErrText pulls the human-readable message out of an ErrorResponse.
func pgErrText(body []byte) string {
	for _, f := range strings.Split(string(body), "\x00") {
		if len(f) > 1 && f[0] == 'M' {
			return f[1:]
		}
	}
	return "unknown error"
}
