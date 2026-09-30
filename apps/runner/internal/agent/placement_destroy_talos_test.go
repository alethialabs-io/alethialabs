// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// A hetzner namespace/vcluster placement DESTROY reaches its Fabric exactly as its deploy did: through a
// kubeconfig minted from the Fabric's persisted admin talosconfig. #5137 fetched that credential for the
// placement DEPLOY only, so every placement teardown on hetzner failed with "hetzner-talos needs an
// injected Talos kubeconfig minter … none was provided" (#845, run 36646962419).

// placementDestroyTalos is a stand-in talosconfig. It is not a parseable talosconfig, so a stage that WAS
// handed a minter fails at the parse — past the point that proves the minter was wired — without dialling
// anything.
const placementDestroyTalos = "COVRUN-PLACEMENT-DESTROY-TALOS"

// closureSandbox is a sandbox.Sandbox that RUNS the in-process closure, as Passthrough does, so a test
// observes what the stage was actually built with rather than what the runner meant to pass it.
type closureSandbox struct {
	mu   sync.Mutex
	runs int
}

// Run counts the call and runs the closure.
func (s *closureSandbox) Run(ctx context.Context, _ sandbox.Spec, job sandbox.Job) error {
	s.mu.Lock()
	s.runs++
	s.mu.Unlock()
	return job(ctx)
}

// count reports how many times a stage ran.
func (s *closureSandbox) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs
}

// placementDestroySnapshot is a namespace/vcluster placement's DESTROY config_snapshot: no cluster shape,
// only the existing Fabric cluster it is placed on and its destination namespace.
func placementDestroySnapshot(mode string) map[string]any {
	snap := covRunSnapshot()
	snap["provider"] = "hetzner"
	snap["placement_mode"] = mode
	snap["namespace"] = "boutique-staging"
	snap["cluster"] = map[string]any{"cluster_name": "alethia-nl-1"}
	return snap
}

// fakeKubeTooling puts no-op kubectl and helm binaries first on PATH, so the teardown's tooling
// preflight passes and the stage proceeds to the kubeconfig mint the test is about.
func fakeKubeTooling(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	for _, bin := range []string{"kubectl", "helm"} {
		if err := os.WriteFile(filepath.Join(dir, bin), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatalf("write fake %s: %v", bin, err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// TestRun_ExecuteDestroy_PlacementTeardownGetsTalosMinter proves a hetzner placement DESTROY fetches the
// Fabric's talosconfig and that the stage it runs is built with a Talos kubeconfig minter: the teardown
// reaches the minter (and fails at its parse of the stand-in value) instead of refusing for want of one.
func TestRun_ExecuteDestroy_PlacementTeardownGetsTalosMinter(t *testing.T) {
	for _, mode := range []string{"namespace", "vcluster"} {
		t.Run(mode, func(t *testing.T) {
			fakeKubeTooling(t)
			api := newCovRunAPI()
			var fetches []string
			api.talosFetchFn = func(jobID string) (string, error) {
				fetches = append(fetches, jobID)
				return placementDestroyTalos, nil
			}
			w := NewWithAPI(Config{Operator: "self", RunnerID: "r-placement-destroy"}, api)
			sb := &closureSandbox{}
			w.sandbox = sb

			stdout := NewJobLogger(api, "covrun-placement-destroy", "STDOUT")
			stderr := NewJobLogger(api, "covrun-placement-destroy", "STDERR")
			err := w.executeDestroy(t.Context(),
				&Job{ID: "covrun-placement-destroy", JobType: string(types.JobTypeDestroy), ConfigSnapshot: placementDestroySnapshot(mode)},
				"hetzner", nil, nil, stdout, stderr)
			stdout.Close()
			stderr.Close()

			if len(fetches) != 1 || fetches[0] != "covrun-placement-destroy" {
				t.Fatalf("a hetzner %s DESTROY must fetch its Fabric's talosconfig once through its own job, got %v", mode, fetches)
			}
			if sb.count() != 1 {
				t.Fatalf("the teardown stage ran %d time(s), want 1", sb.count())
			}
			if err == nil {
				t.Fatal("the stand-in talosconfig cannot mint, so the teardown must fail at the mint")
			}
			if strings.Contains(err.Error(), "none was provided") {
				t.Fatalf("the %s teardown stage was built with no Talos minter: %v", mode, err)
			}
			if !strings.Contains(err.Error(), "parse talosconfig") {
				t.Errorf("error = %q, want the minter's parse of the fetched talosconfig", err)
			}
			if strings.Contains(err.Error(), placementDestroyTalos) {
				t.Errorf("the admin talosconfig reached the error: %q", err)
			}
			for _, l := range api.getLogChunks() {
				if strings.Contains(l.chunk, placementDestroyTalos) {
					t.Fatalf("the admin talosconfig reached the job log: %q", l.chunk)
				}
			}
		})
	}
}

// TestRun_ExecuteDestroy_PlacementTeardownFailsClosedWithoutTalosconfig proves a hetzner placement
// DESTROY that cannot fetch the Fabric's talosconfig is refused BEFORE any stage runs, naming the cause.
func TestRun_ExecuteDestroy_PlacementTeardownFailsClosedWithoutTalosconfig(t *testing.T) {
	for _, tc := range []struct {
		name    string
		fetchFn func(string) (string, error)
		wantErr string
	}{
		{"fetch refused", func(string) (string, error) { return "", errors.New("fetch talosconfig returned status 403") }, "status 403"},
		{"fabric has none", func(string) (string, error) { return "", nil }, talosWriteBackFailedMarker},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := newCovRunAPI()
			api.talosFetchFn = tc.fetchFn
			w := NewWithAPI(Config{Operator: "self"}, api)
			sb := &covRunSandbox{}
			w.sandbox = sb

			stdout := NewJobLogger(api, "covrun-placement-destroy", "STDOUT")
			stderr := NewJobLogger(api, "covrun-placement-destroy", "STDERR")
			err := w.executeDestroy(t.Context(),
				&Job{ID: "covrun-placement-destroy", JobType: string(types.JobTypeDestroy), ConfigSnapshot: placementDestroySnapshot("vcluster")},
				"hetzner", nil, nil, stdout, stderr)
			stdout.Close()
			stderr.Close()
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want it to name %q", err, tc.wantErr)
			}
			if sb.runs() != 0 {
				t.Errorf("the teardown stage ran %d time(s) for a placement that cannot reach its Fabric", sb.runs())
			}
		})
	}
}

// TestRun_ExecuteDestroy_NonPlacementNeverFetchesTalosconfig proves the admin credential is fetched only
// for a hetzner placement: a dedicated hetzner destroy runs tofu and a non-hetzner placement mints from
// its cloud's API, so neither asks for it.
func TestRun_ExecuteDestroy_NonPlacementNeverFetchesTalosconfig(t *testing.T) {
	dedicated := placementDestroySnapshot("dedicated")
	for _, tc := range []struct {
		name     string
		provider string
		snap     map[string]any
	}{
		{"hetzner dedicated", "hetzner", dedicated},
		{"hetzner legacy (no placement mode)", "hetzner", covRunSnapshot()},
		{"aws vcluster", "aws", placementDestroySnapshot("vcluster")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := newCovRunAPI()
			fetched := false
			api.talosFetchFn = func(string) (string, error) {
				fetched = true
				return placementDestroyTalos, nil
			}
			w := NewWithAPI(Config{Operator: "self"}, api)
			w.sandbox = &covRunSandbox{}
			stdout := NewJobLogger(api, "covrun-nonplacement", "STDOUT")
			stderr := NewJobLogger(api, "covrun-nonplacement", "STDERR")
			if err := w.executeDestroy(t.Context(),
				&Job{ID: "covrun-nonplacement", JobType: string(types.JobTypeDestroy), ConfigSnapshot: tc.snap},
				tc.provider, nil, nil, stdout, stderr); err != nil {
				t.Fatalf("destroy must succeed: %v", err)
			}
			stdout.Close()
			stderr.Close()
			if fetched {
				t.Errorf("a %s destroy fetched the Fabric's admin talosconfig", tc.name)
			}
		})
	}
}
