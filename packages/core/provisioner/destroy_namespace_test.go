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
	"os"
	"path/filepath"
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

// TestRunNamespaceDestroyNeverReportsSuccessItCannotDeliver is the core anti-regression property,
// stated directly rather than through RunDestroy. Whatever stops the teardown — no kubectl, an
// unreachable API server, a cancelled job — the ONE answer it may never give is nil. The bug being
// fixed was precisely a teardown that returned nil having done nothing.
//
// The context is cancelled so the mint fails deterministically without a network call, and the
// assertion is only "not nil", so it holds whether the runner image has kubectl on PATH or not.
// That keeps it from depending on ambient laptop state the way a message assertion would.
func TestRunNamespaceDestroyNeverReportsSuccessItCannotDeliver(t *testing.T) {
	provider, err := cloud.NewCloudProvider("aws")
	if err != nil {
		t.Fatalf("NewCloudProvider: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	cfg := &types.ProjectConfig{
		ProjectName:      "p",
		EnvironmentStage: types.EnvironmentStage("dev"),
		PlacementMode:    types.PlacementModeNamespace,
		Namespace:        "team-ns",
	}
	cfg.Cluster.ClusterName = "cluster-a"

	if err := runNamespaceDestroy(ctx, provider, DestroyParams{
		ProjectConfig: cfg,
		Provider:      "aws",
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	}); err == nil {
		t.Fatal("runNamespaceDestroy returned nil without reaching the cluster — a teardown that reports success having done nothing is the defect itself")
	}
}

// TestRunNamespaceDestroyFailsOpenOnAnUnactivatedCloud is the one case where nil IS correct:
// selectPlacementPath would never have deployed a namespace env onto a cloud that is not in
// namespaceRemintProviders, so there is nothing of ours there to reclaim. Mirrors
// runVClusterDestroy's fail-open, and is asserted so the distinction from the test above — where
// nil is a bug — stays deliberate rather than incidental.
func TestRunNamespaceDestroyFailsOpenOnAnUnactivatedCloud(t *testing.T) {
	provider, err := cloud.NewCloudProvider("aws")
	if err != nil {
		t.Fatalf("NewCloudProvider: %v", err)
	}
	if namespaceRemintWired("zzz-unknown") {
		t.Fatal("test premise broken: zzz-unknown must not be an activated cloud")
	}
	cfg := &types.ProjectConfig{ProjectName: "p", PlacementMode: types.PlacementModeNamespace, Namespace: "team-ns"}
	cfg.Cluster.ClusterName = "cluster-a"

	if err := runNamespaceDestroy(context.Background(), provider, DestroyParams{
		ProjectConfig: cfg,
		Provider:      "zzz-unknown",
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	}); err != nil {
		t.Fatalf("nothing was ever provisioned on an unactivated cloud, so teardown has nothing to reclaim: %v", err)
	}
}

// fakeNamespaceProvider is a cloud.CloudProvider whose ConfigureKubeconfig succeeds without a cloud,
// so the teardown's happy path can be exercised end to end in-process. Everything else the interface
// requires is inert — this fake exists only to get past the kube mint.
type fakeNamespaceProvider struct {
	configureErr error
}

func (f fakeNamespaceProvider) Name() string           { return "fake" }
func (f fakeNamespaceProvider) RequiredCLIs() []string { return nil }
func (f fakeNamespaceProvider) ProviderTfvars(*types.ProjectConfig) map[string]interface{} {
	return map[string]interface{}{}
}
func (f fakeNamespaceProvider) ValidateConfig(*types.ProjectConfig) error { return nil }
func (f fakeNamespaceProvider) ConfigureKubeconfig(context.Context, *types.ProjectConfig, map[string]interface{}, io.Writer) error {
	return f.configureErr
}

// stubKubectlOnPath puts an executable named `kubectl` on PATH for the duration of the test.
// runNamespaceDestroy preflights with exec.LookPath, and CI's Go job installs helm and tofu but NOT
// kubectl — so a test that relied on the runner image happening to ship it would pass here and
// silently stop covering this path there. The stub is never executed; executeCommand is stubbed too.
func stubKubectlOnPath(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write kubectl stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// TestRunNamespaceDestroyDeletesTheAppBeforeTheNamespace walks the whole teardown in-process and
// pins the ORDER, which is the part that is easy to get wrong and invisible when it is: the tenant
// Application must be deleted BEFORE the Namespace. Delete them the other way round and ArgoCD
// re-syncs the tenant's resources into a namespace that is already terminating, which wedges it in
// Terminating behind its own finalizers.
//
// Hermetic: fake provider, stub kube-conn resolver, stub identity deprovisioner, stubbed
// executeCommand and a stub kubectl on PATH. No cloud, no cluster, no network.
func TestRunNamespaceDestroyDeletesTheAppBeforeTheNamespace(t *testing.T) {
	stubKubectlOnPath(t)
	orig := executeCommand
	t.Cleanup(func() { executeCommand = orig })

	var manifests []string
	executeCommand = func(cmd, _ string, _ []string, _, _ io.Writer) error {
		fields := strings.Fields(cmd)
		b, err := os.ReadFile(fields[len(fields)-1])
		if err != nil {
			t.Errorf("could not read the manifest passed to %q: %v", cmd, err)
			return nil
		}
		manifests = append(manifests, string(b))
		return nil
	}

	deprovisioned := 0
	cfg := &types.ProjectConfig{
		ProjectName:      "acme",
		EnvironmentStage: types.EnvironmentStage("dev"),
		PlacementMode:    types.PlacementModeNamespace,
		Namespace:        "team-web",
	}
	cfg.Cluster.ClusterName = "acme-prod-cluster"
	cfg.Repositories.AppsDestinationRepo = "https://github.com/acme/apps"

	err := runNamespaceDestroy(context.Background(), fakeNamespaceProvider{}, DestroyParams{
		ProjectConfig: cfg,
		Provider:      "gcp",
		KubeConn: func(context.Context, string, *types.ProjectConfig, string) (string, string, error) {
			return "https://api.example.invalid", "Y2E=", nil
		},
		NamespaceIdentity: func(context.Context, string, *types.ProjectConfig, string, string) error {
			deprovisioned++
			return nil
		},
		Stdout: io.Discard,
		Stderr: io.Discard,
	})
	if err != nil {
		t.Fatalf("runNamespaceDestroy: %v", err)
	}

	if len(manifests) != 2 {
		t.Fatalf("issued %d deletes, want 2 (the Application, then the Namespace + AppProject)", len(manifests))
	}
	if !strings.Contains(manifests[0], "kind: Application") {
		t.Errorf("the FIRST delete must be the Application, so ArgoCD stops re-syncing into a namespace being removed; got:\n%s", manifests[0])
	}
	if !strings.Contains(manifests[1], "kind: Namespace") {
		t.Errorf("the SECOND delete must carry the Namespace; got:\n%s", manifests[1])
	}
	if deprovisioned != 1 {
		t.Errorf("the per-namespace cloud identity was deprovisioned %d times, want exactly 1 — a teardown that skips it leaves a live IAM principal", deprovisioned)
	}
}

// TestRunNamespaceDestroyKeepsGoingAndStillReportsTheFailure pins the best-effort contract. A failed
// Application delete must NOT stop the namespace delete or the identity deprovision — stopping at the
// first error would strand exactly the resources this reclaims — and the call must still report the
// failure so nobody reads a partial teardown as a complete one.
func TestRunNamespaceDestroyKeepsGoingAndStillReportsTheFailure(t *testing.T) {
	stubKubectlOnPath(t)
	orig := executeCommand
	t.Cleanup(func() { executeCommand = orig })

	calls := 0
	executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
		calls++
		if calls == 1 {
			return errors.New("the api server said no")
		}
		return nil
	}

	deprovisioned := 0
	cfg := &types.ProjectConfig{ProjectName: "acme", PlacementMode: types.PlacementModeNamespace, Namespace: "team-web"}
	cfg.Cluster.ClusterName = "acme-prod-cluster"
	cfg.Repositories.AppsDestinationRepo = "https://github.com/acme/apps"

	err := runNamespaceDestroy(context.Background(), fakeNamespaceProvider{}, DestroyParams{
		ProjectConfig: cfg,
		Provider:      "gcp",
		KubeConn: func(context.Context, string, *types.ProjectConfig, string) (string, string, error) {
			return "https://api.example.invalid", "Y2E=", nil
		},
		NamespaceIdentity: func(context.Context, string, *types.ProjectConfig, string, string) error {
			deprovisioned++
			return nil
		},
		Stdout: io.Discard,
		Stderr: io.Discard,
	})
	if err == nil {
		t.Fatal("a failed delete was reported as a successful teardown")
	}
	if calls != 2 {
		t.Errorf("issued %d deletes, want 2 — the namespace delete must be attempted even after the Application delete failed", calls)
	}
	if deprovisioned != 1 {
		t.Errorf("the cloud identity was deprovisioned %d times, want 1 — a leaked IAM principal outlives a leaked namespace, so it is attempted regardless", deprovisioned)
	}
}

// TestRunNamespaceDestroyAttemptsEveryStepWhenEveryStepFails is the best-effort contract at its
// limit: when all three reclaim steps fail, all three must still have been ATTEMPTED, and the call
// must report failure. This is the case where giving up early would strand the most.
//
// It also passes nil writers, which is how the runner calls it when a job has no captured streams —
// the defaults must hold rather than nil-panic mid-teardown.
func TestRunNamespaceDestroyAttemptsEveryStepWhenEveryStepFails(t *testing.T) {
	stubKubectlOnPath(t)
	orig := executeCommand
	t.Cleanup(func() { executeCommand = orig })

	deletes := 0
	executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
		deletes++
		return errors.New("the api server said no")
	}

	identityAttempts := 0
	cfg := &types.ProjectConfig{ProjectName: "acme", PlacementMode: types.PlacementModeNamespace, Namespace: "team-web"}
	cfg.Cluster.ClusterName = "acme-prod-cluster"
	cfg.Repositories.AppsDestinationRepo = "https://github.com/acme/apps"

	err := runNamespaceDestroy(context.Background(), fakeNamespaceProvider{}, DestroyParams{
		ProjectConfig: cfg,
		Provider:      "gcp",
		KubeConn: func(context.Context, string, *types.ProjectConfig, string) (string, string, error) {
			return "https://api.example.invalid", "Y2E=", nil
		},
		NamespaceIdentity: func(context.Context, string, *types.ProjectConfig, string, string) error {
			identityAttempts++
			return errors.New("IAM said no")
		},
		// nil Stdout/Stderr on purpose — the defaults must hold.
	})
	if err == nil {
		t.Fatal("every reclaim step failed and the teardown still reported success")
	}
	if !strings.Contains(err.Error(), "re-run the destroy to converge") {
		t.Errorf("the error should tell the operator a re-run converges, got: %v", err)
	}
	if deletes != 2 {
		t.Errorf("issued %d deletes, want 2 — a failing Application delete must not skip the Namespace delete", deletes)
	}
	if identityAttempts != 1 {
		t.Errorf("identity deprovision attempted %d times, want 1 — it must be tried even when both kube deletes failed", identityAttempts)
	}
}

// TestRunNamespaceDestroyRefusesWithoutKubectl pins the preflight. Without kubectl there is no way
// to delete anything, so the teardown must refuse rather than fall through and report whatever the
// later steps returned.
func TestRunNamespaceDestroyRefusesWithoutKubectl(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // an empty directory: nothing is on PATH, including kubectl
	cfg := &types.ProjectConfig{ProjectName: "acme", PlacementMode: types.PlacementModeNamespace, Namespace: "team-web"}
	cfg.Cluster.ClusterName = "acme-prod-cluster"

	err := runNamespaceDestroy(context.Background(), fakeNamespaceProvider{}, DestroyParams{
		ProjectConfig: cfg,
		Provider:      "gcp",
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err == nil || !strings.Contains(err.Error(), "preflight") {
		t.Fatalf("err = %v, want a preflight refusal naming the missing dependency", err)
	}
}

// TestRunNamespaceDestroyFailsClosedWhenItCannotMintKubeAccess pins the one step that is NOT
// best-effort. Without a kubeconfig nothing downstream can run, so continuing would delete nothing
// and report whatever the later steps happened to return.
func TestRunNamespaceDestroyFailsClosedWhenItCannotMintKubeAccess(t *testing.T) {
	stubKubectlOnPath(t)
	orig := executeCommand
	t.Cleanup(func() { executeCommand = orig })
	executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
		t.Error("no kubectl should run when the kube mint failed")
		return nil
	}

	cfg := &types.ProjectConfig{ProjectName: "acme", PlacementMode: types.PlacementModeNamespace, Namespace: "team-web"}
	cfg.Cluster.ClusterName = "acme-prod-cluster"

	err := runNamespaceDestroy(context.Background(), fakeNamespaceProvider{configureErr: errors.New("no credentials")}, DestroyParams{
		ProjectConfig: cfg,
		Provider:      "gcp",
		KubeConn: func(context.Context, string, *types.ProjectConfig, string) (string, string, error) {
			return "https://api.example.invalid", "Y2E=", nil
		},
		Stdout: io.Discard,
		Stderr: io.Discard,
	})
	if err == nil || !strings.Contains(err.Error(), "kubeconfig mint failed") {
		t.Fatalf("err = %v, want a fail-closed kubeconfig-mint error", err)
	}
}

// TestKubectlDeleteManifestIsIdempotentAndDeletesTheRenderedDoc pins the two properties the
// teardown depends on: it deletes the DOCUMENT (not a hand-written resource name, which is how the
// teardown's idea of a name drifts from the apply's), and it passes --ignore-not-found so a re-run
// after a partial teardown converges instead of failing on the half that already succeeded.
func TestKubectlDeleteManifestIsIdempotentAndDeletesTheRenderedDoc(t *testing.T) {
	orig := executeCommand
	t.Cleanup(func() { executeCommand = orig })

	var gotCmd, gotFileContents string
	executeCommand = func(cmd, _ string, _ []string, _, _ io.Writer) error {
		gotCmd = cmd
		fields := strings.Fields(cmd)
		if b, err := os.ReadFile(fields[len(fields)-1]); err == nil {
			gotFileContents = string(b)
		}
		return nil
	}

	const manifest = "kind: Namespace\nmetadata:\n  name: team-ns\n"
	if err := kubectlDeleteManifest(manifest, "namespace isolation", io.Discard, io.Discard); err != nil {
		t.Fatalf("kubectlDeleteManifest: %v", err)
	}
	if !strings.HasPrefix(gotCmd, "kubectl delete ") {
		t.Errorf("command = %q, want a kubectl delete", gotCmd)
	}
	if !strings.Contains(gotCmd, "--ignore-not-found") {
		t.Errorf("command = %q — without --ignore-not-found a re-run of a partial teardown fails on what it already removed", gotCmd)
	}
	if !strings.Contains(gotCmd, " -f ") {
		t.Errorf("command = %q, want a -f <manifest> delete rather than a by-name delete", gotCmd)
	}
	if gotFileContents != manifest {
		t.Errorf("the applied file held %q, want the rendered manifest %q", gotFileContents, manifest)
	}
}

// TestKubectlDeleteManifestReportsAnUnwritableWorkdir mirrors the apply twin's guard: the teardown
// must fail rather than report a delete it never issued.
func TestKubectlDeleteManifestReportsAnUnwritableWorkdir(t *testing.T) {
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "does-not-exist"))
	if err := kubectlDeleteManifest("kind: Namespace\n", "cov", io.Discard, io.Discard); err == nil {
		t.Error("kubectlDeleteManifest with an unusable TMPDIR = nil, want an error")
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
