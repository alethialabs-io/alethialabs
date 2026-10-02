// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

// ackTempServer stubs DescribeClustersV1 (one cluster named "fabric" → ack-1) and the user_config call,
// recording the TemporaryDurationMinutes each user_config request carried.
func ackTempServer(t *testing.T, raw string, durations *[]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case ackClustersListPath:
			body, _ := json.Marshal(map[string]any{"clusters": []map[string]string{
				{"cluster_id": "ack-1", "name": "fabric", "region_id": "eu-central-1"},
			}})
			_, _ = w.Write(body)
		case ackUserConfigPath:
			*durations = append(*durations, r.URL.Query().Get("TemporaryDurationMinutes"))
			body, _ := json.Marshal(map[string]string{"config": raw})
			_, _ = w.Write(body)
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

// TestResolveACKTemporaryKubeconfig_SendsTheRequestedDuration pins the mint path (#5283): the cluster is
// resolved by name, and the certificate is requested for EXACTLY the minutes the caller asked for, not
// the placement path's fixed 60.
func TestResolveACKTemporaryKubeconfig_SendsTheRequestedDuration(t *testing.T) {
	raw := ackKubeconfig("https://1.2.3.4:6443", "BASE64CA==")
	for _, minutes := range []int{ACKTempKubeconfigMinMinutes, 120, 480} {
		var durations []string
		srv := ackTempServer(t, raw, &durations)
		got, err := resolveACKTemporaryKubeconfig(context.Background(), ackClientTo(srv), "eu-central-1", "fabric", minutes)
		srv.Close()
		if err != nil {
			t.Fatalf("minutes=%d: %v", minutes, err)
		}
		if got != raw {
			t.Fatalf("minutes=%d: kubeconfig not returned verbatim", minutes)
		}
		want := strconv.Itoa(minutes)
		if len(durations) != 1 || durations[0] != want {
			t.Fatalf("minutes=%d: TemporaryDurationMinutes sent = %v, want %v", minutes, durations, want)
		}
	}
}

// TestResolveACKTemporaryKubeconfig_RefusesOutOfRangeDurations proves a duration ACK would not honour is
// refused before any request, so the caller never gets a certificate of some other lifetime.
func TestResolveACKTemporaryKubeconfig_RefusesOutOfRangeDurations(t *testing.T) {
	var durations []string
	srv := ackTempServer(t, ackKubeconfig("https://1.2.3.4:6443", "CA"), &durations)
	defer srv.Close()
	for _, minutes := range []int{0, ACKTempKubeconfigMinMinutes - 1, ACKTempKubeconfigMaxMinutes + 1} {
		if _, err := resolveACKTemporaryKubeconfig(context.Background(), ackClientTo(srv), "eu-central-1", "fabric", minutes); err == nil {
			t.Fatalf("minutes=%d: expected a refusal", minutes)
		}
	}
	if len(durations) != 0 {
		t.Fatalf("an out-of-range duration still reached ACK: %v", durations)
	}
}

// TestResolveACKTemporaryKubeconfig_UnknownClusterIsNotReady proves a name with no cluster behind it
// surfaces ErrACKClusterNotReady (the runner maps it to "not found"), never a kubeconfig.
func TestResolveACKTemporaryKubeconfig_UnknownClusterIsNotReady(t *testing.T) {
	var durations []string
	srv := ackTempServer(t, ackKubeconfig("https://1.2.3.4:6443", "CA"), &durations)
	defer srv.Close()
	_, err := resolveACKTemporaryKubeconfig(context.Background(), ackClientTo(srv), "eu-central-1", "no-such-cluster", 60)
	if !errors.Is(err, ErrACKClusterNotReady) {
		t.Fatalf("want ErrACKClusterNotReady, got %v", err)
	}
	if len(durations) != 0 {
		t.Fatalf("user_config was requested for an unresolved cluster")
	}
}

// TestResolveACKTemporaryKubeconfig_NoRegion refuses before building a signing client.
func TestResolveACKTemporaryKubeconfig_NoRegion(t *testing.T) {
	if _, err := ResolveACKTemporaryKubeconfig(context.Background(), "", "fabric", 60); err == nil {
		t.Fatal("expected a refusal for an empty region")
	}
}
