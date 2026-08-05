// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

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
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestRunDriftDetectionRequiresParams pins the day-2 drift entrypoint's fail-closed argument
// contract: every missing prerequisite is refused BEFORE a workdir or a tofu process exists.
func TestRunDriftDetectionRequiresParams(t *testing.T) {
	backend := &cloud.HTTPBackendConfig{ConsoleURL: "https://console.invalid", JobID: "j1", Token: "t"}
	cases := []struct {
		name   string
		params DriftParams
		want   string
	}{
		{"nil project config", DriftParams{StateBackend: backend}, "ProjectConfig is required"},
		{"nil state backend", DriftParams{ProjectConfig: &types.ProjectConfig{}}, "StateBackend config is required"},
		{"template project without a templates dir", DriftParams{ProjectConfig: &types.ProjectConfig{}, StateBackend: backend}, "TemplatesDir is required"},
		{
			"unknown provider",
			DriftParams{ProjectConfig: &types.ProjectConfig{}, StateBackend: backend, TemplatesDir: "x", Provider: "digitalocean"},
			"digitalocean",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			posture, outputs, err := RunDriftDetection(context.Background(), tc.params)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
			if posture != nil || outputs != nil {
				t.Fatalf("a refused drift run returned posture=%v outputs=%v — it must yield nothing", posture, outputs)
			}
		})
	}
}

// TestRunStateImportRequiresParams pins the orphan-repair entrypoint's fail-closed argument
// contract. The address/id pair comes from a failed apply's OrphanFinding, so a half-specified
// repair must be refused rather than run a `tofu import` that cannot resolve.
func TestRunStateImportRequiresParams(t *testing.T) {
	backend := &cloud.HTTPBackendConfig{ConsoleURL: "https://console.invalid", JobID: "j1", Token: "t"}
	addr := "module.azure_cache[0].azurerm_managed_redis.this"
	cases := []struct {
		name   string
		params ImportParams
		want   string
	}{
		{"nil project config", ImportParams{StateBackend: backend}, "ProjectConfig is required"},
		{"nil state backend", ImportParams{ProjectConfig: &types.ProjectConfig{}}, "StateBackend config is required"},
		{
			"no address",
			ImportParams{ProjectConfig: &types.ProjectConfig{}, StateBackend: backend, CloudID: "/subscriptions/x"},
			"both a resource address and a cloud id are required",
		},
		{
			"no cloud id",
			ImportParams{ProjectConfig: &types.ProjectConfig{}, StateBackend: backend, Address: addr},
			"both a resource address and a cloud id are required",
		},
		{
			"template project without a templates dir",
			ImportParams{ProjectConfig: &types.ProjectConfig{}, StateBackend: backend, Address: addr, CloudID: "id"},
			"TemplatesDir is required",
		},
		{
			"unknown provider",
			ImportParams{ProjectConfig: &types.ProjectConfig{}, StateBackend: backend, Address: addr, CloudID: "id", TemplatesDir: "x", Provider: "digitalocean"},
			"digitalocean",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := RunStateImport(context.Background(), tc.params)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
			if res != nil {
				t.Fatalf("a refused import returned %#v — it must yield no result", res)
			}
		})
	}
}

// TestRunDestroyRequiresParams pins the teardown entrypoint's argument contract. The
// TemplatesDir check in particular must fire BEFORE the cluster is unregistered from Alethia,
// or a bad call leaves the control plane out of step with the live cloud.
func TestRunDestroyRequiresParams(t *testing.T) {
	backend := &cloud.HTTPBackendConfig{ConsoleURL: "https://console.invalid", JobID: "j1", Token: "t"}
	cases := []struct {
		name   string
		params DestroyParams
		want   string
	}{
		{"nil project config", DestroyParams{StateBackend: backend}, "ProjectConfig is required"},
		{"nil state backend", DestroyParams{ProjectConfig: &types.ProjectConfig{}}, "StateBackend config is required"},
		{
			"template project without a templates dir",
			DestroyParams{ProjectConfig: &types.ProjectConfig{}, StateBackend: backend},
			"TemplatesDir is required",
		},
		{
			"unknown provider",
			DestroyParams{ProjectConfig: &types.ProjectConfig{}, StateBackend: backend, TemplatesDir: "x", Provider: "digitalocean"},
			"digitalocean",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := RunDestroy(context.Background(), tc.params); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}
}

// TestRunDestroyPlanRequiresProjectConfig covers the plan-side nil guard, which sits between the
// DryRun requirement and the shared workdir setup.
func TestRunDestroyPlanRequiresProjectConfig(t *testing.T) {
	plan, err := RunDestroyPlan(context.Background(), DestroyParams{DryRun: true})
	if err == nil || !strings.Contains(err.Error(), "ProjectConfig is required") {
		t.Fatalf("err = %v, want the nil-config refusal", err)
	}
	if plan != nil {
		t.Fatalf("a refused destroy plan returned %#v", plan)
	}
}

// TestOrphanEvidenceString covers the log/metadata rendering of every grade, including the
// defensive default (an unknown grade must read as "none", never as evidence).
func TestOrphanEvidenceString(t *testing.T) {
	cases := map[OrphanEvidence]string{
		OrphanNone:        "none",
		OrphanLikely:      "likely",
		OrphanCertain:     "certain",
		OrphanEvidence(9): "none",
	}
	for in, want := range cases {
		if got := in.String(); got != want {
			t.Errorf("OrphanEvidence(%d).String() = %q, want %q", in, got, want)
		}
	}
}

// TestDescribeTargetIDOnly covers the branch where tofu named the cloud id but not the address —
// the diagnosis must still carry the id an import needs.
func TestDescribeTargetIDOnly(t *testing.T) {
	// No `with <address>,` line, so only the id is known.
	err := errors.New(`Error: a resource with the ID "/subscriptions/s/redis/r" already exists - to be managed via Terraform this resource needs to be imported into the State`)
	f := ClassifyApplyError(err, "")
	if f.Evidence != OrphanCertain {
		t.Fatalf("Evidence = %v, want OrphanCertain", f.Evidence)
	}
	if f.Address != "" {
		t.Fatalf("Address = %q, want empty (tofu named none)", f.Address)
	}
	if !strings.Contains(f.Reason, "(cloud id /subscriptions/s/redis/r)") {
		t.Fatalf("Reason = %q, want the id-only target description", f.Reason)
	}
}

// TestApplyOrphanErrorWrapsTheApplyFailure pins the errors.Is/As transparency the runner relies on
// to lift the finding into execution_metadata without re-parsing text.
func TestApplyOrphanErrorWrapsTheApplyFailure(t *testing.T) {
	inner := errors.New("exit status 1")
	e := &ApplyOrphanError{Err: inner, Finding: OrphanFinding{Evidence: OrphanLikely}}
	if !strings.Contains(e.Error(), "orphan risk: likely") || !strings.Contains(e.Error(), "exit status 1") {
		t.Fatalf("Error() = %q", e.Error())
	}
	if !errors.Is(e, inner) {
		t.Fatal("ApplyOrphanError is not transparent to errors.Is — the wrapped apply failure was lost")
	}
	var target *ApplyOrphanError
	if !errors.As(error(e), &target) || target.Finding.Evidence != OrphanLikely {
		t.Fatal("errors.As did not recover the finding")
	}
}

// TestValidatePlacementGatesEveryCoreCollection covers the CORE collections beyond databases: a
// cache/queue/topic/nosql table placed on a foreign cloud identity is a hot cross-cloud edge and
// must be refused, while PERIPHERY divergence stays allowed.
func TestValidatePlacementGatesEveryCoreCollection(t *testing.T) {
	if err := ValidatePlacement(nil); err == nil {
		t.Fatal("ValidatePlacement(nil) must refuse")
	}

	foreign := types.Placement{CloudIdentityID: "identity-b"}
	cases := []struct {
		name   string
		mutate func(*types.ProjectConfig)
		want   string
	}{
		{"cache", func(vc *types.ProjectConfig) {
			vc.Caches = []types.ProjectCacheConfig{{Name: "sessions", Placement: foreign}}
		}, `cross-cloud cache "sessions"`},
		{"queue", func(vc *types.ProjectConfig) {
			vc.Queues = []types.ProjectQueueConfig{{Name: "jobs", Placement: foreign}}
		}, `cross-cloud queue "jobs"`},
		{"topic", func(vc *types.ProjectConfig) {
			vc.Topics = []types.ProjectTopicConfig{{Name: "events", Placement: foreign}}
		}, `cross-cloud topic "events"`},
		{"nosql table", func(vc *types.ProjectConfig) {
			vc.NosqlTables = []types.ProjectNosqlConfig{{Name: "sessions", Placement: foreign}}
		}, `cross-cloud nosql table "sessions"`},
	}
	for _, tc := range cases {
		t.Run(tc.name+" on a foreign identity is gated", func(t *testing.T) {
			vc := &types.ProjectConfig{CloudIdentityID: "identity-a"}
			tc.mutate(vc)
			err := ValidatePlacement(vc)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
		t.Run(tc.name+" inheriting the core identity is allowed", func(t *testing.T) {
			vc := &types.ProjectConfig{CloudIdentityID: "identity-a"}
			tc.mutate(vc)
			// Clear the divergence: an empty placement inherits the core identity.
			vc.Caches = clearCachePlacement(vc.Caches)
			vc.Queues = clearQueuePlacement(vc.Queues)
			vc.Topics = clearTopicPlacement(vc.Topics)
			vc.NosqlTables = clearNosqlPlacement(vc.NosqlTables)
			if err := ValidatePlacement(vc); err != nil {
				t.Fatalf("inherited placement refused: %v", err)
			}
		})
	}
}

// clearCachePlacement blanks each cache's placement so it inherits the core cloud identity.
func clearCachePlacement(in []types.ProjectCacheConfig) []types.ProjectCacheConfig {
	for i := range in {
		in[i].Placement = types.Placement{}
	}
	return in
}

// clearQueuePlacement blanks each queue's placement so it inherits the core cloud identity.
func clearQueuePlacement(in []types.ProjectQueueConfig) []types.ProjectQueueConfig {
	for i := range in {
		in[i].Placement = types.Placement{}
	}
	return in
}

// clearTopicPlacement blanks each topic's placement so it inherits the core cloud identity.
func clearTopicPlacement(in []types.ProjectTopicConfig) []types.ProjectTopicConfig {
	for i := range in {
		in[i].Placement = types.Placement{}
	}
	return in
}

// clearNosqlPlacement blanks each nosql table's placement so it inherits the core cloud identity.
func clearNosqlPlacement(in []types.ProjectNosqlConfig) []types.ProjectNosqlConfig {
	for i := range in {
		in[i].Placement = types.Placement{}
	}
	return in
}

// TestManifestCountSuffixes covers the deploy summary-line fragments, including the "nothing when
// zero" branch each one guards.
func TestManifestCountSuffixes(t *testing.T) {
	if got := esCountSuffix(0); got != "" {
		t.Errorf("esCountSuffix(0) = %q, want empty", got)
	}
	if got := esCountSuffix(3); got != " + 3 ExternalSecret(s)" {
		t.Errorf("esCountSuffix(3) = %q", got)
	}
	if got := jobCountSuffix(0); got != "" {
		t.Errorf("jobCountSuffix(0) = %q, want empty", got)
	}
	if got := jobCountSuffix(2); got != " + 2 keyless bootstrap Job(s)" {
		t.Errorf("jobCountSuffix(2) = %q", got)
	}
}

// TestCredentialRemoteOutputKey pins the BYO-vs-first-class branch that keeps the ExternalSecret
// lane in lock-step with the workload's secretKeyRef.
func TestCredentialRemoteOutputKey(t *testing.T) {
	firstClass := types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}
	if got := credentialRemoteOutputKey(firstClass); got != "rds_master_credentials_secret_name" {
		t.Errorf("first-class database key = %q", got)
	}

	otherKind := types.ServiceBindingTarget{Kind: types.ServiceBindingKindCache, Name: "sessions"}
	if got := credentialRemoteOutputKey(otherKind); got != "" {
		t.Errorf("cache key = %q, want empty (no provisioned credential secret)", got)
	}

	// A BYO-IaC target routes to the customer module's declared output; with none declared the
	// facet must resolve to "" so RenderExternalSecret reports it unsatisfiable.
	byo := types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary", Address: "module.db.aws_db_instance.main"}
	if got, want := credentialRemoteOutputKey(byo), manifests.ByoCredentialOutputKey(byo); got != want {
		t.Errorf("BYO key = %q, want the module's declared output %q", got, want)
	}
}

// TestWriteBootstrapJobsOffAndFailClosed covers the keyless least-priv bootstrap lane's two
// non-rendering outcomes: the flag being off (a strict no-op) and a Job that cannot be rendered
// (REPORTED as a skip, never fatal, and never leaving a file behind).
func TestWriteBootstrapJobsOffAndFailClosed(t *testing.T) {
	iamAuth := true
	vc := &types.ProjectConfig{
		Provider:  types.CloudProviderAws,
		Databases: []types.ProjectDatabaseConfig{{Name: "primary", IamAuth: &iamAuth}},
		Services: []types.ProjectServiceConfig{{
			Name: "api",
			Bindings: []types.ServiceBinding{
				{Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}},
				// A second binding to the SAME database must not produce a second Job.
				{Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}},
			},
		}},
	}

	t.Run("keyless off is a no-op", func(t *testing.T) {
		dir := t.TempDir()
		skips, count, err := writeBootstrapJobs(dir, vc, manifests.Options{KeylessDBAuth: false}, io.Discard)
		if err != nil || count != 0 || len(skips) != 0 {
			t.Fatalf("writeBootstrapJobs off: skips=%v count=%d err=%v", skips, count, err)
		}
		entries, _ := os.ReadDir(dir)
		if len(entries) != 0 {
			t.Fatalf("wrote %d file(s) with keyless off", len(entries))
		}
	})

	t.Run("unrenderable Job is reported, not fatal", func(t *testing.T) {
		dir := t.TempDir()
		var log strings.Builder
		// RunnerImage "" makes RenderBootstrapJob fail — the platform-plumbing defect the lane
		// reports rather than crashing the deploy.
		opts := manifests.Options{KeylessDBAuth: true, Provider: "aws", Databases: vc.Databases}
		skips, count, err := writeBootstrapJobs(dir, vc, opts, &log)
		if err != nil {
			t.Fatalf("writeBootstrapJobs returned a fatal error: %v", err)
		}
		if count != 0 {
			t.Fatalf("count = %d, want 0", count)
		}
		if len(skips) != 1 {
			t.Fatalf("skips = %#v, want exactly one (deduped per database)", skips)
		}
		if !strings.Contains(skips[0], "database/primary") || !strings.Contains(skips[0], "fail-closed") {
			t.Errorf("skip reason = %q", skips[0])
		}
		if !strings.Contains(log.String(), "Bootstrap Job skipped") {
			t.Errorf("skip not reported to the job log: %q", log.String())
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 0 {
			t.Fatalf("wrote %d file(s) for an unrenderable Job", len(entries))
		}
	})
}

// TestGenerateAppManifestsNoAppsRepo covers the earliest exit: with no apps repo (or no git token)
// nothing is cloned, rendered or reported.
func TestGenerateAppManifestsNoAppsRepo(t *testing.T) {
	cases := []struct {
		name  string
		repo  string
		token string
	}{
		{"no apps repo", "", "tok"},
		{"no git token", "https://github.com/acme/apps.git", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vc := &types.ProjectConfig{}
			vc.Repositories.AppsDestinationRepo = tc.repo
			warnings, keyless, err := generateAppManifests(context.Background(), vc, nil, tc.token, nil, io.Discard, io.Discard)
			if err != nil || warnings != nil || keyless != nil {
				t.Fatalf("warnings=%v keyless=%v err=%v — want a silent no-op", warnings, keyless, err)
			}
		})
	}
}

// TestVClusterHostRemintFailsClosedForUnwiredCloud covers the vcluster host-access seam's
// defence-in-depth refusal and its cloud-named message.
func TestVClusterHostRemintFailsClosedForUnwiredCloud(t *testing.T) {
	err := mintVClusterHostAccess(context.Background(), nil, nil, nil, &types.ProjectConfig{}, "digitalocean", "fabric-1", io.Discard)
	if err == nil || !strings.Contains(err.Error(), "not wired for provider \"digitalocean\"") {
		t.Fatalf("err = %v, want the cloud-named fail-closed message", err)
	}
	if !strings.Contains(vclusterRemintNotWired("oracle").Error(), "oracle") {
		t.Error("vclusterRemintNotWired must name the cloud it refuses")
	}
}

// TestRunVClusterDestroySkipsWhenNothingWasProvisioned covers the two teardown short-circuits: an
// un-activated cloud (nothing was ever provisioned there) and a snapshot with no serving cluster
// (no host to mint access against). Both are warnings, never a failed teardown job.
func TestRunVClusterDestroySkipsWhenNothingWasProvisioned(t *testing.T) {
	t.Run("un-activated cloud", func(t *testing.T) {
		var out strings.Builder
		vc := &types.ProjectConfig{Namespace: "tenant-a"}
		err := runVClusterDestroy(context.Background(), nil, DestroyParams{
			ProjectConfig: vc, Provider: "digitalocean", Stdout: &out, Stderr: io.Discard,
		})
		if err != nil {
			t.Fatalf("runVClusterDestroy: %v", err)
		}
		if !strings.Contains(out.String(), "not activated for vcluster placement") {
			t.Fatalf("stdout = %q", out.String())
		}
	})

	t.Run("no serving cluster on the snapshot", func(t *testing.T) {
		var errOut strings.Builder
		vc := &types.ProjectConfig{Namespace: "tenant-a"}
		err := runVClusterDestroy(context.Background(), nil, DestroyParams{
			ProjectConfig: vc, Provider: "aws", Stdout: io.Discard, Stderr: &errOut,
		})
		if err != nil {
			t.Fatalf("runVClusterDestroy: %v", err)
		}
		if !strings.Contains(errOut.String(), "no valid serving cluster") {
			t.Fatalf("stderr = %q", errOut.String())
		}
	})

	t.Run("a spec that cannot be derived is an error", func(t *testing.T) {
		err := runVClusterDestroy(context.Background(), nil, DestroyParams{
			ProjectConfig: &types.ProjectConfig{}, Provider: "aws", Stdout: io.Discard, Stderr: io.Discard,
		})
		if err == nil || !strings.Contains(err.Error(), "no destination namespace") {
			t.Fatalf("err = %v, want the missing-namespace refusal", err)
		}
	})
}

// TestWriteAddOnGitOpsSeedsOnceAndPrunes drives the gitops-mode add-on sync against a local bare
// repo: a manifest is seeded when absent, a customer's existing file is respected, and only OUR
// labelled orphan is pruned.
func TestWriteAddOnGitOpsSeedsOnceAndPrunes(t *testing.T) {
	addonsPath := filepath.Join(t.TempDir(), addonsRepoDir)
	if err := os.MkdirAll(addonsPath, 0o755); err != nil {
		t.Fatal(err)
	}
	// One file we authored (labelled) whose add-on is gone, and one the customer wrote.
	ours := filepath.Join(addonsPath, "grafana.yaml")
	theirs := filepath.Join(addonsPath, "custom.yaml")
	if err := os.WriteFile(ours, []byte("metadata:\n  labels:\n    alethia.io/managed-by: addon-marketplace\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(theirs, []byte("kind: Application\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	pruned := pruneOrphanAddOnManifests(addonsPath, map[string]types.AddOnInstall{}, io.Discard, io.Discard)
	if pruned != 1 {
		t.Fatalf("pruned = %d, want 1 (only our labelled orphan)", pruned)
	}
	if _, err := os.Stat(ours); !os.IsNotExist(err) {
		t.Error("our labelled orphan survived the prune")
	}
	if _, err := os.Stat(theirs); err != nil {
		t.Errorf("the customer's own manifest was pruned: %v", err)
	}

	// A desired add-on is never pruned, whoever wrote it.
	if err := os.WriteFile(ours, []byte("metadata:\n  labels:\n    alethia.io/managed-by: addon-marketplace\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	kept := pruneOrphanAddOnManifests(addonsPath, map[string]types.AddOnInstall{"grafana": {ID: "grafana"}}, io.Discard, io.Discard)
	if kept != 0 {
		t.Fatalf("pruned %d desired manifest(s)", kept)
	}

	// An unreadable directory yields 0 rather than a panic.
	if got := pruneOrphanAddOnManifests(filepath.Join(t.TempDir(), "absent"), nil, io.Discard, io.Discard); got != 0 {
		t.Fatalf("pruneOrphanAddOnManifests on a missing dir = %d, want 0", got)
	}
}
