// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guards for the namespace-placement teardown path (#2016). A namespace env owns no OpenTofu state,
// so the risk here is the same one the vcluster path already guards: a teardown routed into
// `tofu destroy` against the full-cluster template changes nothing, reports SUCCESS, and leaves the
// namespace, its guardrails, its ArgoCD Application and its per-namespace cloud IAM principal live.
//
// A real teardown needs a cluster and a cloud, so the happy path belongs to the main-gated nightly.
// Everything reachable without one — the routing, the validation and the per-cloud identity dispatch
// — is asserted here.

package provisioner

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestRunDestroyPlanNamespaceOwnsNoTofu is the issue's own reproduction, kept as the regression.
// Before #2016 only `vcluster` was recognised as owning no tofu, so a namespace placement fell
// through to prepareDestroyWorkdir and RunDestroyPlan returned an empty-but-successful plan — which
// ErrDestroyPlanNoTofu's doc calls out as the vacuous pass a day-2 gate cannot distinguish from "a
// teardown that changes nothing". The vcluster control is asserted alongside it so a future change
// that breaks one and not the other is visible.
func TestRunDestroyPlanNamespaceOwnsNoTofu(t *testing.T) {
	for _, mode := range []types.PlacementMode{types.PlacementModeVcluster, types.PlacementModeNamespace} {
		t.Run(string(mode), func(t *testing.T) {
			plan, err := RunDestroyPlan(context.Background(), DestroyParams{
				DryRun: true,
				ProjectConfig: &types.ProjectConfig{
					ProjectName:      "p",
					EnvironmentStage: types.EnvironmentStage("dev"),
					PlacementMode:    mode,
				},
				Provider:     "aws",
				TemplatesDir: t.TempDir(),
				StateBackend: &cloud.HTTPBackendConfig{ConsoleURL: "http://127.0.0.1:1", JobID: "j", Token: "tok"},
				Stdout:       io.Discard,
				Stderr:       io.Discard,
			})
			if !errors.Is(err, ErrDestroyPlanNoTofu) {
				t.Fatalf("placement %q: err = %v, want ErrDestroyPlanNoTofu — the env owns no tofu state, so the plan must not be routed into the full-cluster tofu teardown", mode, err)
			}
			if plan != nil {
				t.Errorf("placement %q: want a nil plan alongside the typed error, got %#v", mode, plan)
			}
		})
	}
}

// TestRunDestroyRoutesNamespaceAwayFromTofu proves the APPLY side is routed too — the half that
// actually leaks. The config carries no serving cluster, so the namespace path refuses with its own
// message. That is the assertion: if the placement switch stopped routing, the call would instead
// reach prepareDestroyWorkdir and fail (or worse, succeed) somewhere in the tofu setup, and the
// error would name a workdir or a state backend rather than a serving cluster.
func TestRunDestroyRoutesNamespaceAwayFromTofu(t *testing.T) {
	err := RunDestroy(context.Background(), DestroyParams{
		ProjectConfig: &types.ProjectConfig{
			ProjectName:      "p",
			EnvironmentStage: types.EnvironmentStage("dev"),
			PlacementMode:    types.PlacementModeNamespace,
			Namespace:        "team-ns",
		},
		Provider:     "aws",
		TemplatesDir: t.TempDir(),
		StateBackend: &cloud.HTTPBackendConfig{ConsoleURL: "http://127.0.0.1:1", JobID: "j", Token: "tok"},
		Stdout:       io.Discard,
		Stderr:       io.Discard,
	})
	if err == nil {
		t.Fatal("RunDestroy reported success for a namespace placement it could not reach — this is exactly the false success #2016 is about")
	}
	if !strings.Contains(err.Error(), "namespace teardown") {
		t.Fatalf("the failure should come from the namespace teardown path, not the tofu setup; got: %v", err)
	}
}

// TestRunDestroyNamespaceValidatesTheSnapshotLikeDeployDoes pins that a teardown does not relax the
// trust boundary the deploy path enforces. `ns` and the cluster name reach `bash -c` kubectl
// invocations, and a destroy job's snapshot is no less project-influenced than a deploy's.
func TestRunDestroyNamespaceValidatesTheSnapshotLikeDeployDoes(t *testing.T) {
	cases := []struct {
		name    string
		cluster string
		ns      string
		want    string
	}{
		{"no serving cluster", "", "team-ns", "no valid serving cluster"},
		{"hostile cluster name", "cluster-a; rm -rf /", "team-ns", "no valid serving cluster"},
		{"hostile namespace", "cluster-a", "ns; curl evil", "not a valid DNS-1123 label"},
		{"empty namespace", "cluster-a", "", "not a valid DNS-1123 label"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &types.ProjectConfig{
				ProjectName:      "p",
				EnvironmentStage: types.EnvironmentStage("dev"),
				PlacementMode:    types.PlacementModeNamespace,
				Namespace:        tc.ns,
			}
			cfg.Cluster.ClusterName = tc.cluster
			err := RunDestroy(context.Background(), DestroyParams{
				ProjectConfig: cfg,
				Provider:      "aws",
				TemplatesDir:  t.TempDir(),
				StateBackend:  &cloud.HTTPBackendConfig{ConsoleURL: "http://127.0.0.1:1", JobID: "j", Token: "tok"},
				Stdout:        io.Discard,
				Stderr:        io.Discard,
			})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}
}

// TestDeprovisionNamespaceIdentityNeedsItsInjectedSeam pins the fail-closed wiring check for the two
// clouds whose identity teardown the runner performs. Returning nil when the seam is missing would
// report a reclaimed identity that is still live — the exact shape of the bug being fixed.
func TestDeprovisionNamespaceIdentityNeedsItsInjectedSeam(t *testing.T) {
	for _, provider := range []string{"gcp", "azure"} {
		t.Run(provider, func(t *testing.T) {
			err := deprovisionNamespaceIdentity(context.Background(), nil, provider, "eu-central-1",
				&types.ProjectConfig{}, "cluster-a", "team-ns", io.Discard, io.Discard)
			if err == nil {
				t.Fatal("a missing deprovisioner returned success — the tenant's cloud identity would be left live")
			}
			if !strings.Contains(err.Error(), "runner wiring bug") {
				t.Errorf("the refusal should name the wiring bug, got: %v", err)
			}
		})
	}
}

// TestDeprovisionNamespaceIdentityCallsTheInjectedSeam checks the runner-injected clouds actually
// reach the seam, with the cluster/namespace pair the derived identity name is built from.
func TestDeprovisionNamespaceIdentityCallsTheInjectedSeam(t *testing.T) {
	for _, provider := range []string{"gcp", "azure"} {
		t.Run(provider, func(t *testing.T) {
			var gotProvider, gotCluster, gotNS string
			calls := 0
			stub := func(_ context.Context, slug string, _ *types.ProjectConfig, cluster, ns string) error {
				calls++
				gotProvider, gotCluster, gotNS = slug, cluster, ns
				return nil
			}
			if err := deprovisionNamespaceIdentity(context.Background(), stub, provider, "eu-central-1",
				&types.ProjectConfig{}, "cluster-a", "team-ns", io.Discard, io.Discard); err != nil {
				t.Fatalf("deprovisionNamespaceIdentity: %v", err)
			}
			if calls != 1 {
				t.Fatalf("deprovisioner called %d times, want exactly 1", calls)
			}
			if gotProvider != provider || gotCluster != "cluster-a" || gotNS != "team-ns" {
				t.Errorf("seam got (%q, %q, %q), want (%q, cluster-a, team-ns)", gotProvider, gotCluster, gotNS, provider)
			}
		})
	}
}

// TestDeprovisionNamespaceIdentityHetznerIsADocumentedExclusion pins the one cloud that legitimately
// reclaims nothing. hetzner-talos has no cloud IAM, so its deploy minted no identity. Asserted rather
// than assumed, because "returns nil" is also what a forgotten cloud would do — the difference is
// that this one is named in both the provision and the teardown switch.
func TestDeprovisionNamespaceIdentityHetznerIsADocumentedExclusion(t *testing.T) {
	if err := deprovisionNamespaceIdentity(context.Background(), nil, "hetzner", "fsn1",
		&types.ProjectConfig{}, "cluster-a", "team-ns", io.Discard, io.Discard); err != nil {
		t.Fatalf("hetzner has no cloud IAM to reclaim, so teardown must succeed: %v", err)
	}
}

// TestDeprovisionNamespaceIdentityCoversEveryActivatedCloud is the parity guard. namespaceRemintProviders
// is the single control that activates a cloud for namespace placement — so every cloud in it provisions
// a per-namespace identity, and every one of them must have a teardown arm. A cloud added to that map
// without a case here would fall to the default arm and silently keep its IAM principal forever.
//
// The context is cancelled up front so the in-core clouds (aws, alibaba) fail fast at their first cloud
// call instead of reaching the network — the assertion is only ever "not the not-wired error", never a
// live cloud result, so it does not depend on whatever credentials happen to be in the environment.
func TestDeprovisionNamespaceIdentityCoversEveryActivatedCloud(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	notWired := namespaceRemintNotWired("zzz-unknown").Error()
	// Strip the provider name so the comparison is against the SHAPE of the not-wired refusal.
	marker := strings.TrimSpace(strings.ReplaceAll(notWired, "zzz-unknown", ""))

	for provider := range namespaceRemintProviders {
		t.Run(provider, func(t *testing.T) {
			// A non-nil stub keeps the runner-injected clouds off the wiring-bug arm; it returns an
			// error so every arm here yields "attempted and failed", never a fabricated success.
			stub := func(context.Context, string, *types.ProjectConfig, string, string) error {
				return errors.New("stub: not attempted")
			}
			err := deprovisionNamespaceIdentity(ctx, stub, provider, "eu-central-1",
				&types.ProjectConfig{}, "cluster-a", "team-ns", io.Discard, io.Discard)
			if err != nil && marker != "" && strings.Contains(err.Error(), marker) {
				t.Fatalf("provider %q is activated for namespace placement but has NO identity-teardown arm — its tenants keep a live cloud IAM principal after destroy. err = %v", provider, err)
			}
		})
	}

	// The other half of the same guard: a cloud that is NOT activated must still be refused loudly
	// rather than treated as "nothing to do".
	if err := deprovisionNamespaceIdentity(ctx, nil, "zzz-unknown", "r",
		&types.ProjectConfig{}, "cluster-a", "team-ns", io.Discard, io.Discard); err == nil {
		t.Fatal("an unrecognized provider must fail closed, not return success")
	}
}
