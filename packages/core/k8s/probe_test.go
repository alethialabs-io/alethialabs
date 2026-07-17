// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

func TestCountReadyNodes(t *testing.T) {
	cases := []struct {
		name               string
		raw                string
		wantReady, wantTot int
		wantErr            bool
	}{
		{
			name:      "two ready",
			raw:       `{"items":[{"status":{"conditions":[{"type":"MemoryPressure","status":"False"},{"type":"Ready","status":"True"}]}},{"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}`,
			wantReady: 2, wantTot: 2,
		},
		{
			name:      "one ready one notready",
			raw:       `{"items":[{"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"status":{"conditions":[{"type":"Ready","status":"False"}]}}]}`,
			wantReady: 1, wantTot: 2,
		},
		{
			name:      "zero nodes (karpenter-only)",
			raw:       `{"items":[]}`,
			wantReady: 0, wantTot: 0,
		},
		{
			name:      "node with no Ready condition",
			raw:       `{"items":[{"status":{"conditions":[{"type":"DiskPressure","status":"False"}]}}]}`,
			wantReady: 0, wantTot: 1,
		},
		{
			name:    "garbage",
			raw:     `not json`,
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ready, total, err := CountReadyNodes([]byte(tc.raw))
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
			if tc.wantErr {
				return
			}
			if ready != tc.wantReady || total != tc.wantTot {
				t.Errorf("got ready=%d total=%d, want ready=%d total=%d", ready, total, tc.wantReady, tc.wantTot)
			}
		})
	}
}

func TestPodToAPIServerJob(t *testing.T) {
	y := podToAPIServerJob("alethia-apiserver-probe", "10.0.96.1", "busybox:1.36")
	for _, want := range []string{
		"name: alethia-apiserver-probe",
		"image: busybox:1.36",
		"nc -w 3 10.0.96.1 443",                 // TCP-connect to the ClusterIP datapath
		"node-role.kubernetes.io/control-plane", // prefer a non-control-plane node
		"operator: DoesNotExist",
		"runAsNonRoot: true", // restricted-PSA compliant
		"readOnlyRootFilesystem: true",
		"restartPolicy: Never",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("probe Job manifest missing %q\n---\n%s", want, y)
		}
	}
}

func TestWaitPodToAPIServerSkip(t *testing.T) {
	t.Setenv("ALETHIA_CLUSTER_SKIP_INCLUSTER_PROBE", "1")
	if err := WaitPodToAPIServer(context.Background(), time.Second, io.Discard); err != nil {
		t.Fatalf("skip env should short-circuit to nil, got %v", err)
	}
}

func TestClassifyReachability(t *testing.T) {
	cases := []struct {
		name string
		err  error
		out  string
		want reachClass
	}{
		{"nil err = api not ready", nil, "", reachNotReady},
		{"unauthorized = auth", errString("error: You must be logged in to the server (Unauthorized)"), "", reachAuth},
		{"forbidden = auth", errString("Error from server (Forbidden): clusterroles.rbac.authorization.k8s.io is forbidden"), "", reachAuth},
		{"dial timeout = network", errString("Unable to connect to the server: dial tcp 1.2.3.4:443: i/o timeout"), "", reachNetwork},
		{"no route = network", errString("dial tcp: lookup x: no such host"), "", reachNetwork},
		{"tls handshake = network", errString("net/http: TLS handshake timeout"), "", reachNetwork},
		{"503 = not ready", errString("an error on the server (\"[+]ping ok\\n[-]etcd failed\") has prevented the request from succeeding"), "503 readyz", reachNotReady},
		{"other = unknown", errString("some unexpected kubectl failure"), "", reachUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := classifyReachability(c.err, c.out); got != c.want {
				t.Fatalf("classifyReachability(%q,%q) = %q, want %q", c.err, c.out, got, c.want)
			}
		})
	}
}

type errString string

func (e errString) Error() string { return string(e) }

func TestNotReadyReasons(t *testing.T) {
	raw := []byte(`{"items":[
		{"status":{"conditions":[{"type":"Ready","status":"False","reason":"KubeletNotReady","message":"container runtime network not ready: NetworkReady=false"}]}},
		{"status":{"conditions":[{"type":"Ready","status":"False","reason":"KubeletNotReady","message":"container runtime network not ready: NetworkReady=false"}]}},
		{"status":{"conditions":[{"type":"Ready","status":"True","reason":"KubeletReady"}]}}
	]}`)
	got := NotReadyReasons(raw)
	// Distinct — the two identical NotReady nodes collapse to one; the Ready node is excluded.
	if len(got) != 1 || !strings.Contains(got[0], "KubeletNotReady") || !strings.Contains(got[0], "NetworkReady=false") {
		t.Fatalf("NotReadyReasons = %#v", got)
	}
	if r := NotReadyReasons([]byte(`{"items":[{"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}`)); len(r) != 0 {
		t.Fatalf("all-ready should be empty, got %#v", r)
	}
	if r := NotReadyReasons([]byte("not json")); r != nil {
		t.Fatalf("bad json should be nil, got %#v", r)
	}
}
