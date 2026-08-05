// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/categories"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestApplyApplicationsFailsFastOnANonRaceError locks that a real validation/authz error is NOT
// retried — only the "the operator isn't up yet" markers are (isOperatorNotReady).
func TestApplyApplicationsFailsFastOnANonRaceError(t *testing.T) {
	newKubectlStub(t, 1)
	var stdout, stderr bytes.Buffer
	start := time.Now()
	err := ApplyApplications(t.TempDir(), &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "kubectl apply failed") {
		t.Fatalf("ApplyApplications() error = %v, want a kubectl apply failure", err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("a non-race failure was retried (took %s); only operator-not-ready markers should retry", elapsed)
	}
}

// TestApplyAddOnsSkipsAnEmptyDir locks the no-op: an empty rendered dir must not shell out at all.
func TestApplyAddOnsSkipsAnEmptyDir(t *testing.T) {
	stub := newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	if err := ApplyAddOns(t.TempDir(), &stdout, &stderr); err != nil {
		t.Fatalf("ApplyAddOns() error = %v, want nil", err)
	}
	if len(stub.calls()) != 0 {
		t.Errorf("an empty add-on dir still shelled out: %v", stub.calls())
	}
}

// TestApplyAddOnsReportsAMissingDir locks that an unreadable rendered dir is an error, not a silent
// "nothing to apply".
func TestApplyAddOnsReportsAMissingDir(t *testing.T) {
	newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	err := ApplyAddOns(filepath.Join(t.TempDir(), "does-not-exist"), &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "failed to read add-on dir") {
		t.Fatalf("ApplyAddOns() error = %v, want a read failure", err)
	}
}

// TestApplyAddOnsInWaves covers the wave rail: ascending wave order, a per-wave CRD wait, and the
// fail-soft contract (a failed apply is reported but the remaining waves still run).
func TestApplyAddOnsInWaves(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"addon-cnpg-operator.yaml", "addon-db-primary.yaml"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("kind: Application\n"), 0o600); err != nil {
			t.Fatalf("seed rendered dir: %v", err)
		}
	}

	addons := []types.AddOnInstall{
		{ID: "db-primary", Mode: "managed", SyncWave: 1},
		{ID: "cnpg-operator", Mode: "managed", SyncWave: 0, CRDs: []string{"clusters.postgresql.cnpg.io"}},
		{ID: "written-to-repo", Mode: "gitops", SyncWave: 0},
		{ID: "rabbit-operator", Mode: "managed", Source: "manifest", SyncWave: 0},
	}

	stub := newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	if err := ApplyAddOnsInWaves(addons, dir, &stdout, &stderr); err != nil {
		t.Fatalf("ApplyAddOnsInWaves() error = %v, want nil", err)
	}

	calls := strings.Join(stub.calls(), "\n")
	operatorAt := strings.Index(calls, "addon-cnpg-operator.yaml")
	waitAt := strings.Index(calls, "wait --for=condition=established")
	dbAt := strings.Index(calls, "addon-db-primary.yaml")
	switch {
	case operatorAt < 0 || waitAt < 0 || dbAt < 0:
		t.Fatalf("missing an expected call:\n%s", calls)
	case operatorAt >= waitAt || waitAt >= dbAt:
		t.Errorf("wave order broken — want operator apply, then the CRD wait, then wave 1:\n%s", calls)
	}
	// A gitops add-on has no Application here, and a manifest add-on is applied by the operator rail.
	if strings.Contains(calls, "addon-written-to-repo") || strings.Contains(calls, "addon-rabbit-operator") {
		t.Errorf("a gitops/manifest add-on was applied as an Application:\n%s", calls)
	}
}

// TestApplyAddOnsInWavesIsFailSoft locks that a wave whose apply fails still reports the failure and
// returns the FIRST error, rather than aborting the remaining waves.
func TestApplyAddOnsInWavesIsFailSoft(t *testing.T) {
	newKubectlStub(t, 1)
	var stdout, stderr bytes.Buffer
	addons := []types.AddOnInstall{
		{ID: "a", Mode: "managed", SyncWave: 0},
		{ID: "b", Mode: "managed", SyncWave: 1},
	}
	err := ApplyAddOnsInWaves(addons, t.TempDir(), &stdout, &stderr)
	if err == nil {
		t.Fatal("ApplyAddOnsInWaves() returned nil, want the first apply error")
	}
	for _, id := range []string{"add-on a failed to apply", "add-on b failed to apply"} {
		if !strings.Contains(stderr.String(), id) {
			t.Errorf("stderr = %q, want it to contain %q (later waves must still run)", stderr.String(), id)
		}
	}
}

// TestApplyAddOnsInWavesNoManagedApplications locks the early return when nothing renders.
func TestApplyAddOnsInWavesNoManagedApplications(t *testing.T) {
	stub := newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	if err := ApplyAddOnsInWaves([]types.AddOnInstall{{ID: "x", Mode: "gitops"}}, t.TempDir(), &stdout, &stderr); err != nil {
		t.Fatalf("ApplyAddOnsInWaves() error = %v, want nil", err)
	}
	if len(stub.calls()) != 0 {
		t.Errorf("no managed Applications should mean no kubectl at all: %v", stub.calls())
	}
}

// TestWaitAddOnsHealthy covers the convergence wait's three exits: nothing to wait for, everything
// already converged, and a timeout that still returns the last honest read.
func TestWaitAddOnsHealthy(t *testing.T) {
	const converged = `{"items":[{"metadata":{"name":"addon-cnpg"},"status":{"health":{"status":"Healthy"},"sync":{"status":"Synced"}}}]}`
	const progressing = `{"items":[{"metadata":{"name":"addon-cnpg"},"status":{"health":{"status":"Progressing"},"sync":{"status":"OutOfSync"}}}]}`

	tests := []struct {
		name     string
		names    []string
		stdout   string
		timeout  time.Duration
		want     map[string]AddOnHealth
		wantNote string
	}{
		{name: "nothing to wait for", names: nil, want: map[string]AddOnHealth{}},
		{
			name: "already converged returns immediately", names: []string{"addon-cnpg"},
			stdout: converged, timeout: time.Minute,
			want:     map[string]AddOnHealth{"addon-cnpg": {Health: "Healthy", Sync: "Synced"}},
			wantNote: "All add-ons Healthy + Synced.",
		},
		{
			name: "a timeout returns the last read, never an error", names: []string{"addon-cnpg"},
			stdout: progressing, timeout: 0,
			want: map[string]AddOnHealth{"addon-cnpg": {Health: "Progressing", Sync: "OutOfSync"}},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			newKubectlStub(t, 0, stubRule{Match: "get applications.argoproj.io", Stdout: tc.stdout})
			var stdout, stderr bytes.Buffer
			got := WaitAddOnsHealthy(context.Background(), tc.names, tc.timeout, &stdout, &stderr)

			if len(got) != len(tc.want) {
				t.Fatalf("WaitAddOnsHealthy() = %#v, want %#v", got, tc.want)
			}
			for k, v := range tc.want {
				if got[k] != v {
					t.Errorf("health[%q] = %#v, want %#v", k, got[k], v)
				}
			}
			if tc.wantNote != "" && !strings.Contains(stdout.String(), tc.wantNote) {
				t.Errorf("stdout = %q, want it to contain %q", stdout.String(), tc.wantNote)
			}
		})
	}
}

// TestCleanupSkippedInfraServices covers the orphan reaper: an infra service that no longer renders
// for these facts is deleted, and one that DOES render is left alone.
func TestCleanupSkippedInfraServices(t *testing.T) {
	tests := []struct {
		name      string
		facts     *InfraFacts
		wantDeny  []string
		wantAllow []string
	}{
		{
			name:  "hetzner with no DNS reaps external-dns, the issuer and every cloud store",
			facts: &InfraFacts{Provider: "hetzner"},
			wantDeny: []string{
				"delete application external-dns",
				"delete clusterissuer " + CertManagerIssuerName,
				"delete clustersecretstore secretstore-aws",
				"delete clustersecretstore secretstore-gcp",
			},
		},
		{
			name: "an AWS deploy with an external-secrets identity keeps its own store",
			facts: &InfraFacts{
				Provider:               "aws",
				IRSAExternalSecretsArn: "arn:aws:iam::1:role/eso",
			},
			wantDeny:  []string{"delete clustersecretstore secretstore-gcp "},
			wantAllow: []string{"delete clustersecretstore secretstore-aws "},
		},
		{
			name: "a selected SaaS store is kept while the other SaaS stores are reaped",
			facts: &InfraFacts{
				Provider:    "hetzner",
				SecretsSaaS: &categories.SecretsSaaSStore{Kind: "doppler", StoreName: "secretstore-doppler"},
			},
			wantDeny:  []string{"delete clustersecretstore secretstore-vault "},
			wantAllow: []string{"delete clustersecretstore secretstore-doppler "},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, 0)
			var stdout, stderr bytes.Buffer
			CleanupSkippedInfraServices(tc.facts, &stdout, &stderr)

			for _, want := range tc.wantDeny {
				if !stub.calledWith(want) {
					t.Errorf("missing %q; calls: %v", want, stub.calls())
				}
			}
			for _, unwanted := range tc.wantAllow {
				if stub.calledWith(unwanted) {
					t.Errorf("a rendering object was reaped (%q); calls: %v", unwanted, stub.calls())
				}
			}
		})
	}
}

// TestEnsureExternalSecretsStoreIsANoOpWithoutAStore locks that hetzner (no native cloud store, no
// SaaS store) shells out to nothing at all.
func TestEnsureExternalSecretsStoreIsANoOpWithoutAStore(t *testing.T) {
	stub := newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	if err := EnsureExternalSecretsStore(&InfraFacts{Provider: "hetzner"}, &stdout, &stderr); err != nil {
		t.Fatalf("EnsureExternalSecretsStore() error = %v, want nil", err)
	}
	if len(stub.calls()) != 0 {
		t.Errorf("no store should mean no kubectl: %v", stub.calls())
	}
}

// TestConfigureRepoCredentialsNamedNeverLogsTheToken locks the credential discipline on the ArgoCD
// repository Secret: the name and URL are logged, the token never is.
func TestConfigureRepoCredentialsNamedNeverLogsTheToken(t *testing.T) {
	const token = "ghp_do_not_log_me"
	stub := newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	if err := ConfigureRepoCredentialsNamed("https://github.com/acme/apps", token, "repo-byo-abc123", &stdout, &stderr); err != nil {
		t.Fatalf("ConfigureRepoCredentialsNamed() error = %v", err)
	}
	if !stub.calledWith("apply -f") {
		t.Errorf("the repo Secret was never applied: %v", stub.calls())
	}
	if strings.Contains(stdout.String()+stderr.String(), token) {
		t.Errorf("the git token leaked into the job log:\nstdout=%q\nstderr=%q", &stdout, &stderr)
	}
	if !strings.Contains(stdout.String(), "repo-byo-abc123") {
		t.Errorf("stdout = %q, want the secret name reported", stdout.String())
	}
}

// TestEnsureVClusterClusterSecretRegisters covers the happy path of the vcluster registration: the
// exported kubeconfig Secret is read, parsed, and re-written as an ArgoCD cluster Secret — with the
// bearer token never reaching the log.
func TestEnsureVClusterClusterSecretRegisters(t *testing.T) {
	const token = "vcluster-bearer-token"
	kubeconfig := "apiVersion: v1\nclusters:\n- cluster:\n    server: https://vc.example:443\n    certificate-authority-data: Q0FEQVRB\nusers:\n- user:\n    token: " + token + "\n"
	exported := `{"data":{"config":"` + base64.StdEncoding.EncodeToString([]byte(kubeconfig)) + `"}}`

	stub := newKubectlStub(t, 0, stubRule{Match: "get secret vc-preview-kubeconfig", Stdout: exported})
	var stdout, stderr bytes.Buffer
	if err := EnsureVClusterClusterSecret("preview-env", "vc-preview-kubeconfig", "vcluster-preview", &stdout, &stderr); err != nil {
		t.Fatalf("EnsureVClusterClusterSecret() error = %v", err)
	}
	if !stub.calledWith("apply -f") {
		t.Errorf("the cluster Secret was never applied: %v", stub.calls())
	}
	if !strings.Contains(stdout.String(), "Registering vcluster preview-env with ArgoCD (server https://vc.example:443)") {
		t.Errorf("stdout = %q, want the registration reported", stdout.String())
	}
	if strings.Contains(stdout.String()+stderr.String(), token) {
		t.Errorf("the vcluster bearer token leaked into the job log:\nstdout=%q\nstderr=%q", &stdout, &stderr)
	}
}

// TestEnsureHelmRepoCredentialApplies covers the seed path past the fail-closed guards, and locks
// that the password never reaches the job log.
func TestEnsureHelmRepoCredentialApplies(t *testing.T) {
	const password = "oci-registry-password"
	stub := newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	if err := EnsureHelmRepoCredential("repo-helm-abc123", "oci://ghcr.io/acme", "acme", password, true, &stdout, &stderr); err != nil {
		t.Fatalf("EnsureHelmRepoCredential() error = %v", err)
	}
	if !stub.calledWith("apply -f") {
		t.Errorf("the credential was never applied: %v", stub.calls())
	}
	if strings.Contains(stdout.String()+stderr.String(), password) {
		t.Errorf("the registry password leaked into the job log:\nstdout=%q\nstderr=%q", &stdout, &stderr)
	}
}

// TestEnsureRegistryPullSecretApplies covers the seed path past the fail-closed guards, and locks
// that the dockerconfigjson payload never reaches the job log.
func TestEnsureRegistryPullSecretApplies(t *testing.T) {
	const payload = `{"auths":{"ghcr.io":{"auth":"c2VjcmV0"}}}`
	stub := newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	if err := EnsureRegistryPullSecret("ghcr-pull", "apps", payload, &stdout, &stderr); err != nil {
		t.Fatalf("EnsureRegistryPullSecret() error = %v", err)
	}
	if !stub.calledWith("apply -f") {
		t.Errorf("the pull secret was never applied: %v", stub.calls())
	}
	if strings.Contains(stdout.String()+stderr.String(), "c2VjcmV0") {
		t.Errorf("the registry credential leaked into the job log:\nstdout=%q\nstderr=%q", &stdout, &stderr)
	}
}

// TestEnsureSecretsStoreCredentialGuards covers the fail-closed branches that return BEFORE kubectl:
// no keys at all, and a two-key store (infisical) with one empty value — a half-written credential
// would render an authenticating store that can never authenticate.
func TestEnsureSecretsStoreCredentialGuards(t *testing.T) {
	tests := []struct {
		name string
		data []SecretsStoreCredential
	}{
		{name: "no keys", data: nil},
		{name: "the first value is empty", data: []SecretsStoreCredential{{Key: "token", Value: ""}}},
		{
			name: "a later value is empty",
			data: []SecretsStoreCredential{{Key: "clientId", Value: "id"}, {Key: "clientSecret", Value: ""}},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, 0)
			var stdout, stderr bytes.Buffer
			if err := EnsureSecretsStoreCredential("external-secrets-operator", "secretstore-vault-creds", tc.data, &stdout, &stderr); err == nil {
				t.Fatal("EnsureSecretsStoreCredential() returned nil, want a fail-closed refusal")
			}
			if len(stub.calls()) != 0 {
				t.Errorf("a refused credential must never reach kubectl: %v", stub.calls())
			}
		})
	}
}

// TestEnsureSecretsStoreCredentialSeedsEveryKey covers the seed path: both Universal-Auth keys land
// in one Secret and neither value reaches the job log.
func TestEnsureSecretsStoreCredentialSeedsEveryKey(t *testing.T) {
	data := []SecretsStoreCredential{
		{Key: "clientId", Value: "uid-1234"},
		{Key: "clientSecret", Value: "shhh-1234"},
	}
	manifest := secretsSaaSCredentialManifest("external-secrets-operator", "secretstore-infisical-creds", data)
	for _, want := range []string{
		"name: secretstore-infisical-creds",
		"clientId: " + base64.StdEncoding.EncodeToString([]byte("uid-1234")),
		"clientSecret: " + base64.StdEncoding.EncodeToString([]byte("shhh-1234")),
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("manifest missing %q:\n%s", want, manifest)
		}
	}
	if strings.Contains(manifest, "shhh-1234") {
		t.Errorf("a credential appears in plaintext:\n%s", manifest)
	}

	stub := newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	if err := EnsureSecretsStoreCredential("external-secrets-operator", "secretstore-infisical-creds", data, &stdout, &stderr); err != nil {
		t.Fatalf("EnsureSecretsStoreCredential() error = %v", err)
	}
	if !stub.calledWith("apply -f") {
		t.Errorf("the credential was never applied: %v", stub.calls())
	}
	if strings.Contains(stdout.String()+stderr.String(), "shhh-1234") {
		t.Errorf("a credential leaked into the job log:\nstdout=%q\nstderr=%q", &stdout, &stderr)
	}
}
