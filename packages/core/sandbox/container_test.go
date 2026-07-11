// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package sandbox

import (
	"context"
	"strings"
	"testing"
)

func envHas(env []string, kv string) bool {
	for _, e := range env {
		if e == kv {
			return true
		}
	}
	return false
}

func envHasKey(env []string, key string) bool {
	p := key + "="
	for _, e := range env {
		if strings.HasPrefix(e, p) {
			return true
		}
	}
	return false
}

func TestBuildChildEnv_AllowlistsAndStripsSecrets(t *testing.T) {
	parent := []string{
		// theft targets — must be dropped
		"ALETHIA_RUNNER_TOKEN=super-secret",
		"ALETHIA_RUNNER_ID=runner-1",
		"ALETHIA_RUNNER_BOOTSTRAP_TOKEN=boot",
		"ALETHIA_STORAGE_ACCESS_KEY_ID=AKIA",
		"ALETHIA_STORAGE_SECRET_ACCESS_KEY=shhh",
		"ALETHIA_RECEIPT_SIGNING_KEY=priv",
		"AWS_SECRET_ACCESS_KEY=static-key", // static AWS keys denied
		"AWS_ACCESS_KEY_ID=AKIA",
		"RANDOM_UNRELATED=x", // not allowlisted → dropped
		// allowlisted cloud-auth + toolchain
		"AWS_CONFIG_FILE=/tmp/alethia-aws-abc/config",
		"AWS_PROFILE=alethia-customer",
		"AZURE_FEDERATED_TOKEN_FILE=/tmp/alethia-azure-xyz/oidc-token",
		"TF_HTTP_PASSWORD=state-token",
		"TF_HTTP_USERNAME=alethia",
		"PATH=/usr/bin",
		// egress forward-proxy (Step 3b) — must cross so the child routes through the proxy
		"HTTPS_PROXY=http://alethia-egress-proxy:3128",
		"HTTP_PROXY=http://alethia-egress-proxy:3128",
		"NO_PROXY=localhost,127.0.0.1",
		// a per-job stage secret the parent stashed for the child
		"ALETHIA_STAGE_GIT_TOKEN=ghp_x",
	}

	child := buildChildEnv(parent, "/work/job-1")

	// The guard MUST pass on the produced env.
	if err := assertNoSecrets(child); err != nil {
		t.Fatalf("assertNoSecrets on buildChildEnv output: %v", err)
	}

	mustHave := []string{
		"AWS_CONFIG_FILE", "AWS_PROFILE", "AZURE_FEDERATED_TOKEN_FILE",
		"TF_HTTP_PASSWORD", "TF_HTTP_USERNAME", "PATH",
		"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
		"ALETHIA_STAGE_GIT_TOKEN", "ALETHIA_RUNNER_EXEC_STAGE", "ALETHIA_STAGE_WORKDIR", "HOME",
	}
	for _, k := range mustHave {
		if !envHasKey(child, k) {
			t.Errorf("child env missing allowlisted key %q", k)
		}
	}
	mustNotHave := []string{
		"ALETHIA_RUNNER_TOKEN", "ALETHIA_RUNNER_ID", "ALETHIA_RUNNER_BOOTSTRAP_TOKEN",
		"ALETHIA_STORAGE_ACCESS_KEY_ID", "ALETHIA_STORAGE_SECRET_ACCESS_KEY",
		"ALETHIA_RECEIPT_SIGNING_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "RANDOM_UNRELATED",
	}
	for _, k := range mustNotHave {
		if envHasKey(child, k) {
			t.Errorf("child env LEAKED denylisted/unallowlisted key %q", k)
		}
	}
	if !envHas(child, "ALETHIA_RUNNER_EXEC_STAGE=1") {
		t.Error("child env must set ALETHIA_RUNNER_EXEC_STAGE=1")
	}
	if !envHas(child, "ALETHIA_STAGE_WORKDIR=/work/job-1") {
		t.Error("child env must set ALETHIA_STAGE_WORKDIR to the workdir")
	}
	if !envHas(child, "HOME=/work/job-1/home") {
		t.Error("child HOME must be a writable path under the workdir")
	}
}

func TestAssertNoSecrets(t *testing.T) {
	cases := []struct {
		name    string
		env     []string
		wantErr bool
	}{
		{"clean", []string{"AWS_CONFIG_FILE=/x", "PATH=/usr/bin", "ALETHIA_STAGE_GIT_TOKEN=t", "ALETHIA_RUNNER_EXEC_STAGE=1"}, false},
		{"runner token", []string{"ALETHIA_RUNNER_TOKEN=x"}, true},
		{"storage key", []string{"ALETHIA_STORAGE_SECRET_ACCESS_KEY=x"}, true},
		{"signing key", []string{"ALETHIA_RECEIPT_SIGNING_KEY=x"}, true},
		{"static aws", []string{"AWS_SECRET_ACCESS_KEY=x"}, true},
		{"arbitrary alethia", []string{"ALETHIA_ANYTHING=x"}, true},
		{"stage keys ok", []string{"ALETHIA_STAGE_WORKDIR=/w", "ALETHIA_RUNNER_EXEC_STAGE=1"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := assertNoSecrets(tc.env)
			if (err != nil) != tc.wantErr {
				t.Fatalf("assertNoSecrets(%v) err=%v, wantErr=%v", tc.env, err, tc.wantErr)
			}
		})
	}
}

func TestIsDeniedEnvKey(t *testing.T) {
	denied := []string{"ALETHIA_RUNNER_TOKEN", "ALETHIA_STORAGE_ACCESS_KEY_ID", "ALETHIA_RECEIPT_SIGNING_KEY", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN"}
	allowed := []string{"ALETHIA_STAGE_GIT_TOKEN", "ALETHIA_RUNNER_EXEC_STAGE", "AWS_CONFIG_FILE", "PATH", "TF_HTTP_PASSWORD"}
	for _, k := range denied {
		if !isDeniedEnvKey(k) {
			t.Errorf("%q should be denied", k)
		}
	}
	for _, k := range allowed {
		if isDeniedEnvKey(k) {
			t.Errorf("%q should be allowed", k)
		}
	}
}

func TestCredMountDirs(t *testing.T) {
	workDir := "/work/job-1"
	child := []string{
		"AWS_CONFIG_FILE=/tmp/alethia-aws-abc/config",
		"AZURE_FEDERATED_TOKEN_FILE=/tmp/alethia-azure-xyz/oidc-token",
		"GOOGLE_APPLICATION_CREDENTIALS=/tmp/alethia-gcp-1/wif.json",
		"ALIBABA_CLOUD_OIDC_TOKEN_FILE=" + workDir + "/creds/token", // under workdir → excluded
		"PATH=/usr/bin",
	}
	dirs := credMountDirs(child, workDir)
	want := map[string]bool{
		"/tmp/alethia-aws-abc":   true,
		"/tmp/alethia-azure-xyz": true,
		"/tmp/alethia-gcp-1":     true,
	}
	if len(dirs) != len(want) {
		t.Fatalf("credMountDirs = %v, want %d dirs", dirs, len(want))
	}
	for _, d := range dirs {
		if !want[d] {
			t.Errorf("unexpected mount dir %q (workdir-relative paths must be excluded)", d)
		}
	}
}

func TestContainerRun_FailClosedManagedEgress(t *testing.T) {
	c := Container{Runtime: "docker", Image: "x", Operator: "managed", EgressEnforced: false}
	spec := Spec{
		Kind: "deploy", JobID: "job-1", WorkDir: t.TempDir(),
		Stage: &Stage{Kind: StageDeploy, Payload: []byte("{}")},
		// NoEgress false + managed + !EgressEnforced → must refuse BEFORE exec.
	}
	err := c.Run(context.Background(), spec, func(context.Context) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "egress enforcement") {
		t.Fatalf("expected fail-closed managed-egress refusal, got: %v", err)
	}
}

func TestContainerRun_RequiresStageAndWorkDir(t *testing.T) {
	c := Container{Runtime: "docker", Image: "x", Operator: "self"}
	if err := c.Run(context.Background(), Spec{Kind: "deploy", JobID: "j", WorkDir: t.TempDir()}, nil); err == nil {
		t.Error("expected error when spec.Stage is nil")
	}
	if err := c.Run(context.Background(), Spec{Kind: "deploy", JobID: "j", Stage: &Stage{}}, nil); err == nil {
		t.Error("expected error when spec.WorkDir is empty")
	}
}
