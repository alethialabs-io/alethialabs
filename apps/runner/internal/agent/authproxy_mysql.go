// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

// The MySQL half of db-authproxy. We speak just enough of the MySQL client/server protocol to
// terminate the app's connection phase locally, authenticate upstream with a minted token as a
// CLEARTEXT password over TLS, and then get out of the way (byte splice). Nothing after the
// connection phase is parsed.
//
// Two protocol facts make this safe and are the reason the design works at all:
//
//   - The token is delivered in an AuthSwitchResponse, whose payload is `string<EOF>` — i.e. it runs
//     to the end of the packet and is bounded only by max_allowed_packet. The 255-byte ceiling that
//     applies to the length-prefixed auth-response field in HandshakeResponse41 therefore never
//     applies to us. This matters: an RDS token is ~1 KB and an Entra JWT is commonly 1–2 KB, so a
//     1-byte length prefix would silently truncate the credential. We send an EMPTY auth response in
//     the handshake and let the server's AuthSwitchRequest carry us into the unbounded field.
//   - Sequence ids reset at the start of every command, so once both sides are authenticated the
//     streams are independent and a raw pipe cannot desynchronise them.
//
// Capability reconciliation is the real hazard (a flag negotiated downstream but absent upstream
// changes the framing mid-stream). We handle it by advertising a deliberately conservative set to
// the app, intersecting it with what the app asks for, and then requiring the upstream server to
// support every framing-critical flag that survived — otherwise we fail closed rather than splice
// two subtly different dialects together.

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

// MySQL capability flags (subset — only what we negotiate).
const (
	mysqlCapLongPassword    uint32 = 0x00000001
	mysqlCapFoundRows       uint32 = 0x00000002
	mysqlCapLongFlag        uint32 = 0x00000004
	mysqlCapConnectWithDB   uint32 = 0x00000008
	mysqlCapNoSchema        uint32 = 0x00000010
	mysqlCapCompress        uint32 = 0x00000020
	mysqlCapLocalFiles      uint32 = 0x00000080
	mysqlCapIgnoreSpace     uint32 = 0x00000100
	mysqlCapProtocol41      uint32 = 0x00000200
	mysqlCapSSL             uint32 = 0x00000800
	mysqlCapTransactions    uint32 = 0x00002000
	mysqlCapSecureConn      uint32 = 0x00008000
	mysqlCapMultiStatements uint32 = 0x00010000
	mysqlCapMultiResults    uint32 = 0x00020000
	mysqlCapPSMultiResults  uint32 = 0x00040000
	mysqlCapPluginAuth      uint32 = 0x00080000
	mysqlCapConnectAttrs    uint32 = 0x00100000
	mysqlCapDeprecateEOF    uint32 = 0x01000000
	mysqlCapQueryAttributes uint32 = 0x08000000
)

const (
	// mysqlClearPasswordPlugin is the only client auth plugin we can satisfy: it sends the secret
	// verbatim (NUL-terminated), which is exactly how both AWS RDS IAM and Azure Entra expect their
	// token. Any other plugin (caching_sha2_password, mysql_native_password, …) hashes the secret and
	// cannot be driven from a token, so we fail closed on it.
	mysqlClearPasswordPlugin = "mysql_clear_password"
	// mysqlProxyServerVersion is what we announce to the app. The suffix makes the hop visible in
	// client logs / SHOW VARIABLES-style probes rather than pretending to be the real server.
	mysqlProxyServerVersion = "8.0.0-alethia-authproxy"
	// mysqlDefaultCharset is utf8mb4_general_ci — used only for our own handshake announcement; the
	// app's chosen charset is forwarded upstream verbatim.
	mysqlDefaultCharset = 45
	// mysqlMaxPacket bounds a single protocol packet we are willing to read during the connection
	// phase. The token rides an AuthSwitchResponse well under this.
	mysqlMaxPacket = 16 << 20
)

// mysqlProxyCaps is what we advertise to the app. Deliberately conservative — every flag here is one
// we can honour end to end:
//
//   - CLIENT_COMPRESS is EXCLUDED: compression reframes the whole stream, so a compressed client and
//     an uncompressed upstream cannot be spliced.
//   - CLIENT_SSL is EXCLUDED: the app talks to us over loopback inside its own pod; TLS there buys
//     nothing and would require us to hold a certificate. The UPSTREAM hop is always TLS.
//   - CLIENT_LOCAL_FILES is EXCLUDED: LOAD DATA LOCAL INFILE through a credential-injecting proxy is
//     a needless file-disclosure surface.
//   - CLIENT_QUERY_ATTRIBUTES is EXCLUDED: it changes COM_QUERY framing and is not universally
//     supported upstream; excluding it downstream means it can never be negotiated asymmetrically.
//   - CLIENT_CONNECT_ATTRS is EXCLUDED: we do not forward attributes, so we must not invite them.
var mysqlProxyCaps = mysqlCapLongPassword | mysqlCapFoundRows | mysqlCapLongFlag |
	mysqlCapConnectWithDB | mysqlCapNoSchema | mysqlCapIgnoreSpace | mysqlCapProtocol41 |
	mysqlCapTransactions | mysqlCapSecureConn | mysqlCapMultiStatements | mysqlCapMultiResults |
	mysqlCapPSMultiResults | mysqlCapPluginAuth | mysqlCapDeprecateEOF

// mysqlFramingCriticalCaps are the negotiated flags that change how every subsequent packet is
// framed. If the app negotiates one of these and the upstream server lacks it, splicing would
// desynchronise the stream, so we refuse the connection instead.
var mysqlFramingCriticalCaps = mysqlCapProtocol41 | mysqlCapDeprecateEOF

// mysqlClientHandshake is what the app told us during its connection phase — the parts we must
// mirror upstream so the spliced stream behaves identically on both sides.
type mysqlClientHandshake struct {
	Caps      uint32
	Charset   byte
	MaxPacket uint32
	Database  string
}

// handleMySQLConn runs one app connection: local handshake, token mint, upstream TLS handshake with
// the token as a cleartext password, then splice.
func handleMySQLConn(ctx context.Context, cfg authProxyConfig, client net.Conn, src tokenSource) error {
	hs, err := mysqlAcceptClient(client)
	if err != nil {
		return fmt.Errorf("mysql: local handshake: %w", err)
	}

	token, err := src(ctx)
	if err != nil {
		mysqlWriteError(client, 3, 1045, "28000", "alethia db-authproxy could not mint a database token")
		return err
	}

	upstream, err := mysqlDialUpstream(ctx, cfg, hs, token)
	if err != nil {
		mysqlWriteError(client, 3, 1045, "28000", "alethia db-authproxy could not authenticate upstream")
		return fmt.Errorf("mysql: upstream: %w", err)
	}
	defer func() { _ = upstream.Close() }()

	// Both sides are authenticated; tell the app it is in and step aside.
	if err := mysqlWritePacket(client, 2, mysqlOKPacket()); err != nil {
		return fmt.Errorf("mysql: send OK to client: %w", err)
	}
	spliceConns(client, upstream)
	return nil
}

// mysqlAcceptClient completes the connection phase facing the app: announce ourselves, read the
// app's HandshakeResponse41, and accept it unconditionally. The app holds no credential by design —
// reaching this proxy at all (loopback, inside its own pod) is the authorization.
func mysqlAcceptClient(client net.Conn) (mysqlClientHandshake, error) {
	if err := mysqlWritePacket(client, 0, mysqlInitialHandshake()); err != nil {
		return mysqlClientHandshake{}, fmt.Errorf("write initial handshake: %w", err)
	}
	payload, seq, err := mysqlReadPacket(client)
	if err != nil {
		return mysqlClientHandshake{}, fmt.Errorf("read handshake response: %w", err)
	}
	if seq != 1 {
		return mysqlClientHandshake{}, fmt.Errorf("unexpected handshake response sequence %d", seq)
	}
	return mysqlParseHandshakeResponse(payload)
}

// mysqlInitialHandshake builds the Protocol::HandshakeV10 packet we send to the app. The auth-plugin
// data is present because the protocol requires it, but it is never verified — we accept any
// response.
func mysqlInitialHandshake() []byte {
	var b []byte
	b = append(b, 10) // protocol version
	b = append(b, []byte(mysqlProxyServerVersion)...)
	b = append(b, 0)
	b = binary.LittleEndian.AppendUint32(b, 1) // connection id
	// auth-plugin-data-part-1 (8 bytes) + filler. Fixed, non-secret: nothing verifies it.
	b = append(b, []byte("ALETHIA1")...)
	b = append(b, 0)
	caps := mysqlProxyCaps
	b = binary.LittleEndian.AppendUint16(b, uint16(caps&0xFFFF))
	b = append(b, mysqlDefaultCharset)
	b = binary.LittleEndian.AppendUint16(b, 2) // status flags: SERVER_STATUS_AUTOCOMMIT
	b = binary.LittleEndian.AppendUint16(b, uint16(caps>>16))
	b = append(b, 21) // auth-plugin-data total length
	b = append(b, make([]byte, 10)...)
	b = append(b, []byte("ALETHIAPROXY1")...) // part-2: 12 bytes + NUL
	b = append(b, 0)
	b = append(b, []byte("mysql_native_password")...)
	b = append(b, 0)
	return b
}

// mysqlParseHandshakeResponse reads the fields of HandshakeResponse41 we need to mirror upstream.
func mysqlParseHandshakeResponse(p []byte) (mysqlClientHandshake, error) {
	if len(p) < 32 {
		return mysqlClientHandshake{}, errors.New("handshake response too short")
	}
	hs := mysqlClientHandshake{
		Caps:      binary.LittleEndian.Uint32(p[0:4]),
		MaxPacket: binary.LittleEndian.Uint32(p[4:8]),
		Charset:   p[8],
	}
	if hs.Caps&mysqlCapProtocol41 == 0 {
		return mysqlClientHandshake{}, errors.New("client did not negotiate CLIENT_PROTOCOL_41 (pre-4.1 clients are unsupported)")
	}
	pos := 32
	// username (NUL-terminated) — discarded: the upstream login is the platform-managed identity
	// from --user, never whatever the app happened to send.
	i := indexByteFrom(p, pos, 0)
	if i < 0 {
		return mysqlClientHandshake{}, errors.New("handshake response: unterminated username")
	}
	pos = i + 1
	// auth-response, length depends on the negotiated flags.
	switch {
	case hs.Caps&mysqlCapPluginAuth != 0 && hs.Caps&0x00200000 != 0: // PLUGIN_AUTH_LENENC_CLIENT_DATA
		n, adv, err := mysqlReadLenEnc(p, pos)
		if err != nil {
			return mysqlClientHandshake{}, fmt.Errorf("handshake response: auth data: %w", err)
		}
		pos = adv + int(n)
	case hs.Caps&mysqlCapSecureConn != 0:
		if pos >= len(p) {
			return mysqlClientHandshake{}, errors.New("handshake response: truncated auth data")
		}
		pos += 1 + int(p[pos])
	default:
		i := indexByteFrom(p, pos, 0)
		if i < 0 {
			return mysqlClientHandshake{}, errors.New("handshake response: unterminated auth data")
		}
		pos = i + 1
	}
	if hs.Caps&mysqlCapConnectWithDB != 0 {
		if pos > len(p) {
			return mysqlClientHandshake{}, errors.New("handshake response: truncated database")
		}
		i := indexByteFrom(p, pos, 0)
		if i < 0 {
			return mysqlClientHandshake{}, errors.New("handshake response: unterminated database")
		}
		hs.Database = string(p[pos:i])
	}
	return hs, nil
}

// mysqlDialUpstream connects to the real database over TLS and authenticates as cfg.User using the
// minted token as a cleartext password. Returns the authenticated connection, ready to splice.
func mysqlDialUpstream(ctx context.Context, cfg authProxyConfig, hs mysqlClientHandshake, token string) (net.Conn, error) {
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

	serverCaps, err := mysqlReadServerHandshake(raw)
	if err != nil {
		return nil, err
	}
	if serverCaps&mysqlCapSSL == 0 {
		// Both RDS IAM and Entra require the token to travel over TLS; a server that cannot offer it
		// would put the credential on the wire in clear. Refuse.
		return nil, errors.New("upstream does not advertise CLIENT_SSL; refusing to send a token over an unencrypted connection")
	}
	// A framing flag the app negotiated but the server lacks would desynchronise the splice.
	negotiated := hs.Caps & mysqlProxyCaps
	if missing := negotiated & mysqlFramingCriticalCaps &^ serverCaps; missing != 0 {
		return nil, fmt.Errorf("upstream lacks framing-critical capability bits 0x%08x negotiated by the client", missing)
	}
	upstreamCaps := (negotiated & serverCaps) | mysqlCapSSL | mysqlCapPluginAuth | mysqlCapSecureConn

	// TLS: the SSLRequest packet is the handshake-response prefix, sent in the clear, after which the
	// socket is upgraded and everything else — including the token — is encrypted.
	if err := mysqlWritePacket(raw, 1, mysqlSSLRequest(upstreamCaps, hs)); err != nil {
		return nil, fmt.Errorf("send SSLRequest: %w", err)
	}
	tlsConn := tls.Client(raw, upstreamTLSConfig(cfg.upstreamHost()))
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		return nil, fmt.Errorf("upstream TLS handshake: %w", err)
	}

	// Empty auth response here on purpose: the server's AuthSwitchRequest carries us into
	// AuthSwitchResponse, whose payload is string<EOF> and therefore not subject to the 255-byte
	// length-prefix ceiling that would truncate a multi-kilobyte token.
	if err := mysqlWritePacket(tlsConn, 2, mysqlHandshakeResponse(upstreamCaps, hs, cfg.User)); err != nil {
		return nil, fmt.Errorf("send handshake response: %w", err)
	}
	if err := mysqlFinishAuth(tlsConn, token); err != nil {
		return nil, err
	}
	ok = true
	return tlsConn, nil
}

// mysqlReadServerHandshake reads the server's HandshakeV10 and returns its capability flags.
func mysqlReadServerHandshake(c net.Conn) (uint32, error) {
	p, _, err := mysqlReadPacket(c)
	if err != nil {
		return 0, fmt.Errorf("read server handshake: %w", err)
	}
	if len(p) > 0 && p[0] == 0xFF {
		return 0, fmt.Errorf("server rejected the connection: %s", mysqlErrText(p))
	}
	if len(p) < 2 || p[0] != 10 {
		return 0, errors.New("unsupported server handshake (want protocol version 10)")
	}
	i := indexByteFrom(p, 1, 0) // server version
	if i < 0 {
		return 0, errors.New("server handshake: unterminated version")
	}
	pos := i + 1 + 4 + 8 + 1 // conn id + auth-data-1 + filler
	if pos+2 > len(p) {
		return 0, errors.New("server handshake: truncated capabilities")
	}
	caps := uint32(binary.LittleEndian.Uint16(p[pos : pos+2]))
	pos += 2
	// charset(1) + status(2) then the upper capability half — absent on very old servers.
	if pos+3+2 <= len(p) {
		caps |= uint32(binary.LittleEndian.Uint16(p[pos+3:pos+5])) << 16
	}
	return caps, nil
}

// mysqlSSLRequest builds the SSLRequest packet — the first 32 bytes of a handshake response, which
// tells the server to upgrade before any credential is sent.
func mysqlSSLRequest(caps uint32, hs mysqlClientHandshake) []byte {
	b := make([]byte, 0, 32)
	b = binary.LittleEndian.AppendUint32(b, caps)
	b = binary.LittleEndian.AppendUint32(b, mysqlMaxPacketOr(hs.MaxPacket))
	b = append(b, mysqlCharsetOr(hs.Charset))
	b = append(b, make([]byte, 23)...)
	return b
}

// mysqlHandshakeResponse builds HandshakeResponse41 for the upstream leg: our platform login, an
// EMPTY auth response (see mysqlDialUpstream), and the app's database + charset mirrored so the
// spliced session behaves the same on both sides.
func mysqlHandshakeResponse(caps uint32, hs mysqlClientHandshake, user string) []byte {
	b := mysqlSSLRequest(caps, hs)
	b = append(b, []byte(user)...)
	b = append(b, 0)
	b = append(b, 0) // auth-response length 0 (CLIENT_SECURE_CONNECTION framing)
	if caps&mysqlCapConnectWithDB != 0 {
		b = append(b, []byte(hs.Database)...)
		b = append(b, 0)
	}
	if caps&mysqlCapPluginAuth != 0 {
		b = append(b, []byte(mysqlClearPasswordPlugin)...)
		b = append(b, 0)
	}
	return b
}

// mysqlFinishAuth drives the rest of the connection phase, answering the server's AuthSwitchRequest
// with the token. Any plugin other than mysql_clear_password hashes the secret and cannot be
// satisfied by a token, so it fails closed with the plugin named.
func mysqlFinishAuth(c net.Conn, token string) error {
	for {
		p, seq, err := mysqlReadPacket(c)
		if err != nil {
			return fmt.Errorf("read auth response: %w", err)
		}
		if len(p) == 0 {
			return errors.New("empty auth packet")
		}
		switch p[0] {
		case 0x00: // OK
			return nil
		case 0xFF: // ERR
			return fmt.Errorf("upstream authentication failed: %s", mysqlErrText(p))
		case 0xFE: // AuthSwitchRequest
			name := ""
			if i := indexByteFrom(p, 1, 0); i > 0 {
				name = string(p[1:i])
			}
			if name != mysqlClearPasswordPlugin {
				return fmt.Errorf("upstream requested auth plugin %q; only %s can carry a token "+
					"(is the configured --user an IAM/Entra database user?)", name, mysqlClearPasswordPlugin)
			}
			// string<EOF> — the token is NOT length-prefixed here, so its size is bounded only by
			// max_allowed_packet. This is what makes multi-kilobyte Entra JWTs safe.
			body := append([]byte(token), 0)
			if err := mysqlWritePacket(c, seq+1, body); err != nil {
				return fmt.Errorf("send cleartext token: %w", err)
			}
		case 0x01: // AuthMoreData — only meaningful for challenge/response plugins
			return errors.New("upstream sent AuthMoreData; a cleartext token cannot satisfy a challenge-response plugin")
		default:
			return fmt.Errorf("unexpected auth packet type 0x%02x", p[0])
		}
	}
}

// mysqlReadPacket reads one length-prefixed protocol packet, returning its payload and sequence id.
func mysqlReadPacket(c net.Conn) ([]byte, byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(c, hdr[:]); err != nil {
		return nil, 0, err
	}
	n := int(hdr[0]) | int(hdr[1])<<8 | int(hdr[2])<<16
	if n > mysqlMaxPacket {
		return nil, 0, fmt.Errorf("packet too large (%d bytes)", n)
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(c, p); err != nil {
		return nil, 0, err
	}
	return p, hdr[3], nil
}

// mysqlWritePacket writes one protocol packet with the given sequence id.
func mysqlWritePacket(c net.Conn, seq byte, payload []byte) error {
	hdr := []byte{byte(len(payload)), byte(len(payload) >> 8), byte(len(payload) >> 16), seq}
	if _, err := c.Write(append(hdr, payload...)); err != nil {
		return err
	}
	return nil
}

// mysqlOKPacket is a minimal OK_Packet (affected rows 0, last insert id 0, autocommit).
func mysqlOKPacket() []byte {
	return []byte{0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00}
}

// mysqlWriteError sends an ERR_Packet so the app's driver reports a real failure instead of a closed
// socket. Errors here are best-effort — the connection is being torn down regardless.
func mysqlWriteError(c net.Conn, seq byte, code uint16, state, msg string) {
	b := []byte{0xFF}
	b = binary.LittleEndian.AppendUint16(b, code)
	b = append(b, '#')
	b = append(b, []byte(state)...)
	b = append(b, []byte(msg)...)
	_ = mysqlWritePacket(c, seq, b)
}

// mysqlErrText extracts the human-readable message from an ERR_Packet.
func mysqlErrText(p []byte) string {
	if len(p) < 4 {
		return "unknown error"
	}
	body := p[3:]
	if len(body) > 6 && body[0] == '#' {
		body = body[6:]
	}
	return strings.TrimSpace(string(body))
}

// mysqlReadLenEnc decodes a length-encoded integer, returning its value and the offset just past it.
func mysqlReadLenEnc(p []byte, pos int) (uint64, int, error) {
	if pos >= len(p) {
		return 0, 0, errors.New("truncated length-encoded integer")
	}
	switch c := p[pos]; {
	case c < 0xFB:
		return uint64(c), pos + 1, nil
	case c == 0xFC && pos+3 <= len(p):
		return uint64(binary.LittleEndian.Uint16(p[pos+1 : pos+3])), pos + 3, nil
	case c == 0xFD && pos+4 <= len(p):
		return uint64(p[pos+1]) | uint64(p[pos+2])<<8 | uint64(p[pos+3])<<16, pos + 4, nil
	case c == 0xFE && pos+9 <= len(p):
		return binary.LittleEndian.Uint64(p[pos+1 : pos+9]), pos + 9, nil
	}
	return 0, 0, errors.New("malformed length-encoded integer")
}

// mysqlMaxPacketOr keeps the app's max-packet preference, defaulting when it sent none.
func mysqlMaxPacketOr(v uint32) uint32 {
	if v == 0 {
		return mysqlMaxPacket
	}
	return v
}

// mysqlCharsetOr keeps the app's charset so text encoding is identical on both legs.
func mysqlCharsetOr(v byte) byte {
	if v == 0 {
		return mysqlDefaultCharset
	}
	return v
}

// indexByteFrom finds b in p at or after start, or -1.
func indexByteFrom(p []byte, start int, b byte) int {
	if start < 0 || start > len(p) {
		return -1
	}
	if i := strings.IndexByte(string(p[start:]), b); i >= 0 {
		return start + i
	}
	return -1
}
