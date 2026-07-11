// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// gitInitScanRepo builds a git repo with a provider-less `good/` module and a `bad/`
// module (local-exec provisioner → static-gate error), returning (repoDir, branch).
func gitInitScanRepo(t *testing.T) (string, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	repo := t.TempDir()
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e.com",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e.com",
			"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	write := func(rel, body string) {
		p := filepath.Join(repo, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run("init", "-q")
	// Provider-less module: static gate OK, `tofu validate` clean (no plugin downloads).
	write("good/main.tf", `variable "name" {
  type    = string
  default = "acme"
}

output "name" {
  value = var.name
}
`)
	// local-exec provisioner → iacsafety RuleProvisionerBlock (error) → gate blocks, no tofu.
	write("bad/main.tf", `resource "null_resource" "x" {
  provisioner "local-exec" {
    command = "echo pwned > /tmp/pwned"
  }
}
`)
	run("add", ".")
	run("commit", "-q", "-m", "init")
	branch := run("rev-parse", "--abbrev-ref", "HEAD")
	return repo, branch
}

// runnerForScan builds a Runner over the mock API with the default Passthrough sandbox
// (operator=self, so the scan runs in-process without a container).
func runnerForScan(t *testing.T, api JobAPI) *Runner {
	t.Helper()
	t.Setenv("ALETHIA_SANDBOX_BACKEND", "")         // default Passthrough
	t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "") // don't refuse
	return NewWithAPI(Config{Operator: "self", AlethiaURL: "https://console.test"}, api)
}

// TestExecuteIacScan_BadModule: a module with a provisioner is BLOCKED by the static gate
// (ok=false) before any tofu runs, the report carries findings + the pinned commit_sha,
// and it is posted on execution_metadata.iac_scan_result with the console JSON keys.
func TestExecuteIacScan_BadModule(t *testing.T) {
	repo, branch := gitInitScanRepo(t)
	api := &mockAPI{}
	w := runnerForScan(t, api)

	job := &Job{
		ID:      "job-bad",
		JobType: "IAC_SCAN",
		ConfigSnapshot: map[string]any{
			"repo_url": "file://" + repo,
			"ref":      branch,
			"path":     "bad",
		},
	}
	stdout := NewJobLogger(api, job.ID, "STDOUT")
	stderr := NewJobLogger(api, job.ID, "STDERR")
	if err := w.executeIacScan(context.Background(), job, stdout, stderr); err != nil {
		t.Fatalf("executeIacScan returned error: %v", err)
	}
	stdout.Close()
	stderr.Close()

	report := lastIacScanResult(t, api)
	if report.OK {
		t.Error("ok must be false for a module with a provisioner block")
	}
	if len(report.Findings) == 0 {
		t.Error("expected at least one finding for the provisioner block")
	}
	if len(report.CommitSHA) != 40 {
		t.Errorf("commit_sha must be a full 40-char SHA, got %q", report.CommitSHA)
	}
	assertConsoleJSONKeys(t, report)
}

// TestExecuteIacScan_ValidModule: a clean provider-less module passes the static gate and
// `tofu validate` → ok=true, validated=true, no findings, pinned commit. Requires the
// tofu binary (skipped otherwise — never triggers a network download in CI).
func TestExecuteIacScan_ValidModule(t *testing.T) {
	if _, err := exec.LookPath("tofu"); err != nil {
		t.Skip("tofu binary not available — skipping the validate path (would require a download)")
	}
	repo, branch := gitInitScanRepo(t)
	api := &mockAPI{}
	w := runnerForScan(t, api)

	job := &Job{
		ID:      "job-good",
		JobType: "IAC_SCAN",
		ConfigSnapshot: map[string]any{
			"repo_url": "file://" + repo,
			"ref":      branch,
			"path":     "good",
		},
	}
	stdout := NewJobLogger(api, job.ID, "STDOUT")
	stderr := NewJobLogger(api, job.ID, "STDERR")
	if err := w.executeIacScan(context.Background(), job, stdout, stderr); err != nil {
		t.Fatalf("executeIacScan returned error: %v", err)
	}
	stdout.Close()
	stderr.Close()

	report := lastIacScanResult(t, api)
	if !report.OK {
		t.Errorf("ok must be true for a clean module; findings=%+v", report.Findings)
	}
	if !report.Validated {
		t.Error("validated must be true when tofu validate ran clean")
	}
	if len(report.Findings) != 0 {
		t.Errorf("expected no findings, got %+v", report.Findings)
	}
	if len(report.CommitSHA) != 40 {
		t.Errorf("commit_sha must be a full 40-char SHA, got %q", report.CommitSHA)
	}
}

// lastIacScanResult extracts the *types.IacScanReport posted on the most recent
// UpdateJobStatus metadata under "iac_scan_result".
func lastIacScanResult(t *testing.T, api *mockAPI) *types.IacScanReport {
	t.Helper()
	api.mu.Lock()
	defer api.mu.Unlock()
	for i := len(api.statusUpdates) - 1; i >= 0; i-- {
		if v, ok := api.statusUpdates[i].metadata["iac_scan_result"]; ok {
			rep, ok := v.(*types.IacScanReport)
			if !ok {
				t.Fatalf("iac_scan_result is %T, want *types.IacScanReport", v)
			}
			return rep
		}
	}
	t.Fatal("no iac_scan_result posted")
	return nil
}

// assertConsoleJSONKeys pins the runner↔console contract: the report must serialize with
// the exact snake_case keys finalizeIacScan reads, and findings/providers/modules must be
// arrays (never null).
func assertConsoleJSONKeys(t *testing.T, report *types.IacScanReport) {
	t.Helper()
	b, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"ok", "validated", "findings", "providers", "modules", "commit_sha"} {
		if _, ok := m[k]; !ok {
			t.Errorf("report JSON missing key %q (console finalizeIacScan reads it): %s", k, b)
		}
	}
	for _, k := range []string{"findings", "providers", "modules"} {
		if string(m[k]) == "null" {
			t.Errorf("key %q must serialize as [] not null", k)
		}
	}
}

// TestByoManagedGate is the fail-closed E0 boundary matrix: (operator, sandbox backend,
// egress-enforced, ENFORCE_MANAGED flag) × IacSource-present → refuse vs allow.
func TestByoManagedGate(t *testing.T) {
	byo := &types.ProjectConfig{IacSource: &types.ProjectIacSourceConfig{RepoURL: "https://x/r.git", CommitSHA: strings.Repeat("a", 40)}}
	nonByo := &types.ProjectConfig{}

	containerEgress := sandbox.Container{Operator: "managed", EgressEnforced: true}
	containerNoEgress := sandbox.Container{Operator: "managed", EgressEnforced: false}
	passManaged := sandbox.Passthrough{Operator: "managed"}
	passSelf := sandbox.Passthrough{Operator: "self"}

	cases := []struct {
		name       string
		operator   string
		sb         sandbox.Sandbox
		enforce    bool
		vc         *types.ProjectConfig
		wantRefuse bool
	}{
		{"self + BYO + passthrough → allow (customer risk boundary)", "self", passSelf, false, byo, false},
		{"self + BYO + container-no-egress → allow", "self", containerNoEgress, false, byo, false},
		{"managed + non-BYO (trusted template) → allow", "managed", passManaged, false, nonByo, false},
		{"managed + BYO + passthrough → refuse", "managed", passManaged, true, byo, true},
		{"managed + BYO + container + egress + enforce → allow", "managed", containerEgress, true, byo, false},
		{"managed + BYO + container + egress but enforce OFF → refuse", "managed", containerEgress, false, byo, true},
		{"managed + BYO + container no-egress + enforce → refuse", "managed", containerNoEgress, true, byo, true},
		// Fail-closed: an empty/unknown operator is NOT the explicit "self", so BYO must refuse.
		{"empty-operator + BYO + passthrough + enforce → refuse (fail-closed)", "", sandbox.Passthrough{Operator: ""}, true, byo, true},
		{"empty-operator + non-BYO (trusted template) → allow", "", sandbox.Passthrough{Operator: ""}, false, nonByo, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.enforce {
				t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "1")
			} else {
				t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "")
			}
			w := &Runner{config: Config{Operator: tc.operator}, sandbox: tc.sb}
			err := w.byoManagedGate(tc.vc, "DEPLOY")
			if tc.wantRefuse && err == nil {
				t.Fatal("expected the gate to REFUSE, got nil")
			}
			if !tc.wantRefuse && err != nil {
				t.Fatalf("expected the gate to ALLOW, got: %v", err)
			}
		})
	}
}

// TestRequireManagedContainerSandbox is the enforcement-half matrix (independent of any
// ProjectConfig): the E0 managed-strict requirement over (operator, sandbox, egress, enforce).
// It is exercised directly by executeIacScan (untrusted BYO by definition, no ProjectConfig)
// and via byoManagedGate for deploy/plan/destroy/drift. Only an EXPLICIT "self" operator is
// lenient — "" / unknown fail closed.
func TestRequireManagedContainerSandbox(t *testing.T) {
	containerEgress := sandbox.Container{Operator: "managed", EgressEnforced: true}
	containerNoEgress := sandbox.Container{Operator: "managed", EgressEnforced: false}

	cases := []struct {
		name       string
		operator   string
		sb         sandbox.Sandbox
		enforce    bool
		wantRefuse bool
	}{
		{"self + passthrough → allow (customer risk boundary)", "self", sandbox.Passthrough{Operator: "self"}, false, false},
		{"self + container-no-egress → allow", "self", containerNoEgress, false, false},
		{"managed + passthrough + enforce → refuse", "managed", sandbox.Passthrough{Operator: "managed"}, true, true},
		{"managed + container + egress + enforce → allow", "managed", containerEgress, true, false},
		{"managed + container + egress but enforce OFF → refuse", "managed", containerEgress, false, true},
		{"managed + container no-egress + enforce → refuse", "managed", containerNoEgress, true, true},
		// Fail-closed: empty/unknown operator is NOT "self" → treated as managed-strict.
		{"empty-operator + passthrough + enforce → refuse (fail-closed)", "", sandbox.Passthrough{Operator: ""}, true, true},
		{"unknown-operator (Managed) + passthrough + enforce → refuse (fail-closed)", "Managed", sandbox.Passthrough{Operator: "Managed"}, true, true},
		{"empty-operator + container + egress + enforce → allow", "", sandbox.Container{Operator: "", EgressEnforced: true}, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.enforce {
				t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "1")
			} else {
				t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "")
			}
			w := &Runner{config: Config{Operator: tc.operator}, sandbox: tc.sb}
			err := w.requireManagedContainerSandbox("IAC_SCAN")
			if tc.wantRefuse && err == nil {
				t.Fatal("expected REFUSE, got nil")
			}
			if !tc.wantRefuse && err != nil {
				t.Fatalf("expected ALLOW, got: %v", err)
			}
		})
	}
}

// TestExecuteIacScan_ManagedPassthroughRefuses proves an IAC_SCAN (untrusted BYO by
// definition — its config_snapshot is flat, no ProjectConfig) is refused on a managed runner
// with the default Passthrough BEFORE any clone / git-token fetch, matching deploy/plan/
// destroy/drift. Otherwise `tofu init`+`validate` would run provider-plugin code in-process
// with the host env + IMDS reachable.
func TestExecuteIacScan_ManagedPassthroughRefuses(t *testing.T) {
	t.Setenv("ALETHIA_SANDBOX_BACKEND", "")         // default Passthrough
	t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "") // even unset, the gate refuses managed BYO
	api := &mockAPI{}
	w := NewWithAPI(Config{Operator: "managed", AlethiaURL: "https://console.test"}, api)

	job := &Job{
		ID:      "job-managed-scan",
		JobType: "IAC_SCAN",
		ConfigSnapshot: map[string]any{
			"repo_url": "file:///nonexistent/repo", // never reached — the gate refuses first
			"ref":      "main",
			"path":     "good",
		},
	}
	stdout := NewJobLogger(api, job.ID, "STDOUT")
	stderr := NewJobLogger(api, job.ID, "STDERR")
	err := w.executeIacScan(context.Background(), job, stdout, stderr)
	stdout.Close()
	stderr.Close()
	if err == nil {
		t.Fatal("expected executeIacScan to REFUSE on a managed passthrough runner")
	}
	// The refusal must be the E0 gate (before clone), not a clone/parse failure.
	if !strings.Contains(err.Error(), "bring-your-own IaC IAC_SCAN") {
		t.Fatalf("expected the E0 gate refusal, got: %v", err)
	}
	// Nothing must have been posted (no scan ran).
	api.mu.Lock()
	defer api.mu.Unlock()
	for _, u := range api.statusUpdates {
		if _, ok := u.metadata["iac_scan_result"]; ok {
			t.Fatal("no iac_scan_result must be posted when the gate refuses")
		}
	}
}

// TestExecuteIacScan_ManagedContainerEgressEnforceAllowsGate proves the gate PASSES for a
// managed runner when the egress-enforced container sandbox is active + enforcement is on, so
// executeIacScan proceeds past the E0 gate (it then fails later trying to run the container
// runtime, which is unavailable in unit tests — but crucially NOT with the gate refusal).
func TestExecuteIacScan_ManagedContainerEgressEnforceAllowsGate(t *testing.T) {
	repo, branch := gitInitScanRepo(t)
	t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "1")
	api := &mockAPI{}
	w := &Runner{
		config:  Config{Operator: "managed", AlethiaURL: "https://console.test"},
		api:     api,
		sandbox: sandbox.Container{Runtime: "definitely-not-a-real-runtime", Image: "x", Operator: "managed", EgressEnforced: true},
	}
	job := &Job{
		ID:      "job-managed-container-scan",
		JobType: "IAC_SCAN",
		ConfigSnapshot: map[string]any{
			"repo_url": "file://" + repo,
			"ref":      branch,
			"path":     "good",
		},
	}
	stdout := NewJobLogger(api, job.ID, "STDOUT")
	stderr := NewJobLogger(api, job.ID, "STDERR")
	err := w.executeIacScan(context.Background(), job, stdout, stderr)
	stdout.Close()
	stderr.Close()
	if err == nil {
		return // gate passed and the (fake-runtime) container somehow no-op'd — still not a gate refusal
	}
	if strings.Contains(err.Error(), "bring-your-own IaC IAC_SCAN") {
		t.Fatalf("gate must PASS for managed+container+egress+enforce; got a gate refusal: %v", err)
	}
}

// TestIacScanStageRoundTrip is the anti-divergence guard for the container path: the
// StageIacScan payload survives the JSON round-trip the container backend performs.
func TestIacScanStageRoundTrip(t *testing.T) {
	payload := stageIacScanPayload{
		ModuleDir:  "/work/clone/module",
		CommitSHA:  strings.Repeat("a", 40),
		IacVersion: "1.9.0",
		JobID:      "job-1",
	}
	stage, err := newStage(sandbox.StageIacScan, payload)
	if err != nil {
		t.Fatal(err)
	}
	if stage.Kind != sandbox.StageIacScan {
		t.Fatalf("stage kind = %q, want %q", stage.Kind, sandbox.StageIacScan)
	}
	var got stageIacScanPayload
	if err := json.Unmarshal(stage.Payload, &got); err != nil {
		t.Fatal(err)
	}
	if got != payload {
		t.Fatalf("round-trip mismatch: got %+v, want %+v", got, payload)
	}
}
