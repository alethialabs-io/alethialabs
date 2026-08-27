// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #2829: the pod dump assumed ArgoCD's tracking label was on the PODS. It is on the workload —
// pods only carry it when the chart puts it in the pod template. So "NONE match" was a statement
// about the selector, and on hetzner/addons run 32970696343 it was printed for `addon-minio`,
// whose Deployment was running the whole time under `app=minio,release=addon-minio`.
//
// The fix asks each workload for the selector IT owns its pods by. These are the pure halves of
// that: no cluster, no kubectl, so they run on every PR.

package e2e

import "testing"

func TestSelectorFromMatchLabels(t *testing.T) {
	t.Parallel()

	t.Run("builds a deterministic, sorted selector", func(t *testing.T) {
		t.Parallel()
		// minio's real shape — the case the old hard-coded label could never match.
		got, err := selectorFromMatchLabels(`{"release":"addon-minio","app":"minio"}`)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if want := "app=minio,release=addon-minio"; got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
		// Sorted, so two runs of the same cluster produce a comparable log line. Go randomises map
		// iteration, so ONE re-check would catch an unsorted implementation only about half the
		// time — which is a test that reports green for the wrong reason. Repeat until that is
		// negligible.
		for i := 0; i < 50; i++ {
			again, err := selectorFromMatchLabels(`{"app":"minio","release":"addon-minio"}`)
			if err != nil {
				t.Fatalf("unexpected error on iteration %d: %v", i, err)
			}
			if again != got {
				t.Fatalf("key order changed the selector on iteration %d: %q vs %q", i, again, got)
			}
		}
	})

	t.Run("falco's shape still works — the tracking label is legitimate when the chart sets it", func(t *testing.T) {
		t.Parallel()
		got, err := selectorFromMatchLabels(
			`{"app.kubernetes.io/instance":"addon-falco","app.kubernetes.io/name":"falco"}`)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := "app.kubernetes.io/instance=addon-falco,app.kubernetes.io/name=falco"
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	// THE IMPORTANT ONES. `kubectl get pods -l ""` matches EVERYTHING in the namespace, so any
	// input that cannot yield a real selector must ERROR. Returning "" would turn "I could not
	// work out the selector" into a dump of unrelated pods presented as this workload's — the
	// exact confusion this whole change exists to remove.
	for _, tc := range []struct {
		name string
		raw  string
	}{
		{"empty output", ""},
		{"whitespace only", "  \n\t "},
		{"empty object", "{}"},
		{"not JSON", "map[app:minio]"},
		{"blank value", `{"app":""}`},
		{"blank key", `{"":"minio"}`},
	} {
		t.Run("errors on "+tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := selectorFromMatchLabels(tc.raw)
			if err == nil {
				t.Fatalf("expected an error, got selector %q", got)
			}
			if got != "" {
				t.Fatalf("an error must not also return a selector, got %q", got)
			}
		})
	}
}

func TestParseManagedWorkloads(t *testing.T) {
	t.Parallel()

	t.Run("keeps pod-producing kinds and drops the rest", func(t *testing.T) {
		t.Parallel()
		ws := parseManagedWorkloads(`
Deployment|addon-minio|minio|Degraded
ConfigMap|addon-minio|minio|
Secret|addon-minio|minio|
DaemonSet|addon-falco|falco|Progressing
Service|addon-falco|falco|
`)
		if len(ws) != 2 {
			t.Fatalf("got %d workloads, want 2: %+v", len(ws), ws)
		}
		// Sorted, so the dump is stable between runs.
		if ws[0].Kind != "DaemonSet" || ws[0].Name != "addon-falco" || ws[0].Namespace != "falco" {
			t.Fatalf("unexpected first workload: %+v", ws[0])
		}
		if ws[0].Health != "Progressing" {
			t.Fatalf("health not carried: %+v", ws[0])
		}
		if ws[1].Kind != "Deployment" || ws[1].Namespace != "minio" {
			t.Fatalf("unexpected second workload: %+v", ws[1])
		}
	})

	t.Run("drops a workload with no namespace rather than widening the search", func(t *testing.T) {
		t.Parallel()
		// A namespace is how the pod query is scoped. Keeping one without a namespace would make
		// the fallback query every namespace and attribute someone else's pods to this app.
		ws := parseManagedWorkloads("Deployment|addon-minio||Degraded\nDeployment||minio|Degraded")
		if len(ws) != 0 {
			t.Fatalf("expected none, got %+v", ws)
		}
	})

	t.Run("empty and malformed input yield no workloads, not a panic", func(t *testing.T) {
		t.Parallel()
		for _, raw := range []string{"", "   ", "garbage", "Deployment", "Deployment|only-two"} {
			if ws := parseManagedWorkloads(raw); len(ws) != 0 {
				t.Fatalf("raw %q yielded %+v", raw, ws)
			}
		}
	})

	t.Run("health is optional — a workload with no health column is still returned", func(t *testing.T) {
		t.Parallel()
		ws := parseManagedWorkloads("StatefulSet|addon-loki|loki")
		if len(ws) != 1 || ws[0].Health != "" {
			t.Fatalf("got %+v", ws)
		}
	})
}

func TestManagedWorkloadString(t *testing.T) {
	t.Parallel()
	w := managedWorkload{Kind: "DaemonSet", Name: "addon-falco", Namespace: "falco", Health: "Progressing"}
	if got, want := w.String(), "DaemonSet/addon-falco in falco Progressing"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
