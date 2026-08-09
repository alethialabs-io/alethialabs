// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

// mysqlConnPhaseExchange drives one connection through the MySQL connection phase against
// handleMySQLConn and returns the sequence id of the server's reply to HandshakeResponse41.
//
// It speaks the protocol rather than asserting on internals: the sequence id is a WIRE property, and
// a client is what validates it. Reuses mysqlHandshakeResponseFixture from authproxy_test.go rather
// than building a second response encoder.
func mysqlConnPhaseExchange(t *testing.T, src tokenSource) (seq byte, payload []byte) {
	t.Helper()

	client, server := net.Pipe()
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })

	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = handleMySQLConn(context.Background(), authProxyConfig{}, server, src)
	}()

	_ = client.SetDeadline(time.Now().Add(5 * time.Second))

	// Server → client: initial handshake, sequence 0.
	if _, s, err := mysqlReadPacket(client); err != nil {
		t.Fatalf("read initial handshake: %v", err)
	} else if s != 0 {
		t.Fatalf("initial handshake sequence = %d, want 0", s)
	}

	// Client → server: HandshakeResponse41, sequence 1. mysqlAcceptClient rejects anything else, so
	// this pins the position the reply's sequence is measured from.
	if err := mysqlWritePacket(client, 1, mysqlHandshakeResponseFixture(mysqlCapProtocol41|mysqlCapSecureConn, 0x21, "app", "")); err != nil {
		t.Fatalf("write handshake response: %v", err)
	}

	p, s, err := mysqlReadPacket(client)
	if err != nil {
		t.Fatalf("read server reply: %v", err)
	}
	<-done
	return s, p
}

// TestMySQLErrorPacketUsesTheConnectionPhaseSequence is #2043's repro, kept.
//
// Both failure paths wrote the ERR packet with sequence 3 while the OK beside them used 2. The client
// sent HandshakeResponse41 as 1, so the reply must be 2. go-sql-driver's readPacket compares the byte
// against its own counter and returns ErrPktSyncMul ("commands out of sync") on a higher value,
// DISCARDING the packet without reading its payload — so a token-mint failure surfaced to the
// application as an error about its own query usage rather than the credential path.
func TestMySQLErrorPacketUsesTheConnectionPhaseSequence(t *testing.T) {
	failingSource := func(context.Context) (string, error) {
		return "", errors.New("mint failed")
	}

	seq, payload := mysqlConnPhaseExchange(t, failingSource)

	if seq != 2 {
		t.Errorf("ERR_Packet sequence id = %d, want 2 — the client sent seq 1, and a MySQL client rejects a non-consecutive sequence with \"commands out of sync\" and never sees the reason", seq)
	}
	if len(payload) == 0 || payload[0] != 0xFF {
		t.Fatalf("expected an ERR_Packet (0xFF), got % x", payload)
	}
	// The whole point of the packet is that the app can READ the reason.
	if msg := mysqlErrText(payload); msg == "" {
		t.Error("ERR_Packet carries no readable message")
	}
}

// TestMySQLConnPhaseReplySeqIsShared pins the relationship rather than the number: the OK and both
// ERR replies occupy the same position in the exchange, so they must use the same sequence. Three
// hand-written literals is how they came to disagree.
func TestMySQLConnPhaseReplySeqIsShared(t *testing.T) {
	if mysqlConnPhaseReplySeq != 2 {
		t.Fatalf("mysqlConnPhaseReplySeq = %d, want 2 (server 0 → client 1 → server 2)", mysqlConnPhaseReplySeq)
	}
}
