// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// stalledRegistry accepts the connection and never answers.
//
// The handler waits on a channel the TEST closes, not only on r.Context(): httptest's Close() blocks
// until every outstanding handler returns, and a client-side timeout does not reliably cancel the
// SERVER's request context — so keying the handler solely off r.Context().Done() deadlocked Close()
// and hung the package to its 600s cap. Found the hard way.
func stalledRegistry(t *testing.T) (*httptest.Server, func()) {
	t.Helper()
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	return srv, func() { close(release); srv.Close() }
}

// TestACRExchangeClientIsBounded pins the client the production path actually wires in.
//
// http.DefaultClient has no timeout, and the ctx this path receives has none either — it comes from
// runRegistryTokenLoop, the refresher sidecar's LIFETIME context. Together that meant a stalled
// registry endpoint hung the refresh loop forever (#2037).
func TestACRExchangeClientIsBounded(t *testing.T) {
	if acrExchangeClient.Timeout <= 0 {
		t.Fatal("the ACR exchange client has no timeout; a stalled registry would hang the refresher forever")
	}
	if acrExchangeClient == http.DefaultClient {
		t.Fatal("the ACR exchange must not use http.DefaultClient — it is process-wide, so bounding it would change every other caller in the runner")
	}
	// A ceiling, not an exact value: the point is that it is short enough to fail a refresh cycle
	// rather than outlive one.
	if acrExchangeClient.Timeout > 2*time.Minute {
		t.Errorf("timeout %s is too long to bound a single token exchange", acrExchangeClient.Timeout)
	}
}

// TestACRExchangeGivesUpOnAStalledRegistry is the behavioural half: with a DEADLINE-LESS context —
// exactly what runRegistryTokenLoop passes — the exchange must still return.
//
// The assertion is that it terminates at all. Without the client timeout there is nothing to stop
// it: no ctx deadline, no transport bound.
func TestACRExchangeGivesUpOnAStalledRegistry(t *testing.T) {
	srv, stop := stalledRegistry(t)
	defer stop()

	// A short-timeout stand-in for acrExchangeClient, so the test does not wait the production 30s.
	// The production client's own bound is asserted above; this exercises the code path.
	client := &http.Client{Timeout: 200 * time.Millisecond}

	done := make(chan error, 1)
	go func() {
		// context.Background(): no deadline, mirroring the refresher loop.
		_, err := exchangeACRRefreshTokenAt(context.Background(), client, srv.URL+"/oauth2/exchange", "acme.azurecr.io", "aad-token")
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("the exchange returned nil against a registry that never answered")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("HUNG: the ACR exchange did not return against a stalled registry with a deadline-less context — the refresher would stop refreshing and image pulls would 401 once the token expired")
	}
}

// TestStalledRegistryStubActuallyStalls guards the fixture: if the stub answered, the test above
// would pass against the unfixed code and prove nothing.
func TestStalledRegistryStubActuallyStalls(t *testing.T) {
	srv, stop := stalledRegistry(t)
	defer stop()

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	resp, err := http.DefaultClient.Do(req) //nolint:bodyclose // never completes
	if err == nil {
		resp.Body.Close()
		t.Fatal("the stub answered — it is not stalling, so the timeout test would prove nothing")
	}
}
