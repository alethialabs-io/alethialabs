// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"reflect"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// #5151: every sandbox.Run caller that holds per-job secrets must hand them to the backend on
// sandbox.Spec.Secrets. Before, they reached only the in-process closure, so the container
// backend's child ran with no state token, git token, add-on secrets or talosconfig.

// childSecrets decodes a Spec.Secrets exactly as the container child will: each entry becomes
// the child's env and stageSecretsFromEnv reads it back.
func childSecrets(t *testing.T, spec sandbox.Spec) stageSecrets {
	t.Helper()
	for _, k := range []string{sandbox.EnvStateToken, sandbox.EnvGitToken, sandbox.EnvGitTokens, sandbox.EnvAddonSecrets, sandbox.EnvTalosConfig} {
		t.Setenv(k, spec.Secrets[k])
	}
	return stageSecretsFromEnv()
}

// TestStageSecrets_SpecSecretsRoundTripsThroughTheChild pins that specSecrets is the exact
// inverse of stageSecretsFromEnv: the child reconstructs the very value the parent held.
func TestStageSecrets_SpecSecretsRoundTripsThroughTheChild(t *testing.T) {
	full := stageSecrets{
		GitToken:     "git",
		StateToken:   "state",
		GitTokens:    map[string]string{"https://gitlab.example/c": "glpat"},
		AddonSecrets: map[string]map[string]string{"a1": {"apiKey": "plain"}},
		TalosConfig:  "talos-yaml",
	}
	if got := childSecrets(t, sandbox.Spec{Secrets: full.specSecrets()}); !reflect.DeepEqual(got, full) {
		t.Fatalf("round trip:\n got %+v\nwant %+v", got, full)
	}

	// An empty value is omitted rather than sent as an empty variable.
	if got := (stageSecrets{StateToken: "only"}).specSecrets(); len(got) != 1 || got[sandbox.EnvStateToken] != "only" {
		t.Fatalf("specSecrets of a state-token-only job = %v", got)
	}
}

// TestRun_ExecuteDeploy_HandsItsSecretsToTheSandbox proves a DEPLOY puts the state token, the git
// token, the add-on secrets and (for a hetzner placement) the Fabric talosconfig on Spec.Secrets.
func TestRun_ExecuteDeploy_HandsItsSecretsToTheSandbox(t *testing.T) {
	api := newCovRunAPI()
	api.gitTokenFn = func(string, string) (string, error) { return "covrun-git-token", nil }
	api.addonSecretFn = func(string) (map[string]map[string]string, error) {
		return map[string]map[string]string{"a6": {"apiKey": "covrun-addon"}}, nil
	}
	api.talosFetchFn = func(string) (string, error) { return "COVRUN-FABRIC-TALOS", nil }
	sb := &covRunSandbox{}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-secrets"}, api)
	w.sandbox = sb

	stdout := NewJobLogger(api, "covrun-secrets", "STDOUT")
	stderr := NewJobLogger(api, "covrun-secrets", "STDERR")
	err := w.executeDeploy(t.Context(),
		&Job{ID: "covrun-secrets", JobType: string(types.JobTypeDeploy), ConfigSnapshot: covRunDeploySnapshot("namespace")},
		"hetzner", nil, nil, stdout, stderr)
	stdout.Close()
	stderr.Close()
	if err != nil {
		t.Fatalf("deploy: %v", err)
	}
	if sb.runs() != 1 {
		t.Fatalf("want one stage run, got %d", sb.runs())
	}

	got := childSecrets(t, sb.lastSpec())
	if got.StateToken != "covrun-state-token" {
		t.Errorf("state token = %q, want the job's minted token", got.StateToken)
	}
	if got.GitToken != "covrun-git-token" {
		t.Errorf("git token = %q, want the job's BYO git token", got.GitToken)
	}
	if got.AddonSecrets["a6"]["apiKey"] != "covrun-addon" {
		t.Errorf("add-on secrets = %v, want a6.apiKey", got.AddonSecrets)
	}
	if got.TalosConfig != "COVRUN-FABRIC-TALOS" {
		t.Errorf("talosconfig = %q, want the Fabric's admin talosconfig", got.TalosConfig)
	}
}

// TestRun_ExecuteDestroy_HandsItsSecretsToTheSandbox proves a DESTROY puts the state token and (for a
// hetzner placement) the Fabric talosconfig on Spec.Secrets — the path #5150 fixed only in-process.
func TestRun_ExecuteDestroy_HandsItsSecretsToTheSandbox(t *testing.T) {
	api := newCovRunAPI()
	api.talosFetchFn = func(string) (string, error) { return placementDestroyTalos, nil }
	sb := &covRunSandbox{}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-secrets"}, api)
	w.sandbox = sb

	stdout := NewJobLogger(api, "covrun-destroy-secrets", "STDOUT")
	stderr := NewJobLogger(api, "covrun-destroy-secrets", "STDERR")
	err := w.executeDestroy(t.Context(),
		&Job{ID: "covrun-destroy-secrets", JobType: string(types.JobTypeDestroy), ConfigSnapshot: placementDestroySnapshot("vcluster")},
		"hetzner", nil, nil, stdout, stderr)
	stdout.Close()
	stderr.Close()
	if err != nil {
		t.Fatalf("destroy: %v", err)
	}
	if sb.runs() != 1 {
		t.Fatalf("want one stage run, got %d", sb.runs())
	}
	got := childSecrets(t, sb.lastSpec())
	if got.StateToken != "covrun-state-token" {
		t.Errorf("state token = %q, want the job's minted token", got.StateToken)
	}
	if got.TalosConfig != placementDestroyTalos {
		t.Errorf("talosconfig = %q, want the Fabric's admin talosconfig", got.TalosConfig)
	}
}

// TestRun_ExecutePlan_HandsItsStateTokenToTheSandbox proves a PLAN puts its state token on Spec.Secrets.
func TestRun_ExecutePlan_HandsItsStateTokenToTheSandbox(t *testing.T) {
	api := newCovRunAPI()
	sb := &covRunSandbox{onRun: func(spec sandbox.Spec) error {
		covRunWriteResult(t, spec.WorkDir, covRunFullPlanResult)
		return nil
	}}
	w := NewWithAPI(Config{Operator: "self", AlethiaURL: "https://console.invalid"}, api)
	w.sandbox = sb

	stdout := NewJobLogger(api, "covrun-plan-secrets", "STDOUT")
	stderr := NewJobLogger(api, "covrun-plan-secrets", "STDERR")
	err := w.executePlan(t.Context(),
		&Job{ID: "covrun-plan-secrets", JobType: string(types.JobTypePlan), ConfigSnapshot: covRunSnapshot()},
		"aws", nil, nil, stdout, stderr)
	stdout.Close()
	stderr.Close()
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if got := childSecrets(t, sb.lastSpec()); got.StateToken != "covrun-state-token" {
		t.Errorf("state token = %q, want the job's minted token", got.StateToken)
	}
}

// TestDrift_ByoHandsItsSecretsToTheSandbox proves a BYO DRIFT puts its state and git tokens on Spec.Secrets.
func TestDrift_ByoHandsItsSecretsToTheSandbox(t *testing.T) {
	api := covDriftNewAPI()
	sb := &covDriftSandbox{resultJSON: covDriftPostureResult}
	w := covDriftRunner(t, api, "self", sb)
	out, errl := covDriftLoggers(t, api)

	vc := types.ProjectConfig{
		ProjectName: "byo",
		IacSource:   &types.ProjectIacSourceConfig{RepoURL: "https://git.test/mod.git", CommitSHA: "abc123"},
	}
	if err := w.executeDriftDetection(context.Background(), covDriftJob(covDriftSnapshot(t, vc)), "aws", nil, out, errl); err != nil {
		t.Fatalf("byo drift: %v", err)
	}
	got := childSecrets(t, sb.spec)
	if got.StateToken != "state-tok" || got.GitToken != "git-tok" {
		t.Errorf("drift secrets = state %q git %q, want state-tok / git-tok", got.StateToken, got.GitToken)
	}
}
