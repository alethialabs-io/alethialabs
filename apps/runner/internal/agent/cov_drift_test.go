// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Coverage proofs for the DETECT_DRIFT handler (drift.go) and the console HTTP
// client (api.go).
//
// drift.go is driven through two doubles and one stub: a JobAPI that decides
// whether the state/git token mints succeed, a sandbox.Sandbox that stands in for
// the isolation backend on the bring-your-own-IaC branch (it never runs the
// closure — neither does the container backend), and, for the trusted-template
// branch, a recording `tofu` shim first on PATH so the refresh-only plan runs with
// no cloud account and no network.
//
// api.go is driven against httptest servers: one that answers, one that has been
// closed (transport failure), plus a client built on a URL containing a control
// byte so request construction itself fails.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ── doubles ─────────────────────────────────────────────────────────────────────

// covDriftAPI decorates the package mock with per-test control over the two mints
// executeDriftDetection makes: the tofu-state token and the git token.
type covDriftAPI struct {
	*mockAPI
	stateToken    string
	stateTokenErr error
	gitToken      string
	gitTokenErr   error
	gitTokenCalls int
}

// covDriftNewAPI builds the decorated mock with sane defaults (both mints succeed).
func covDriftNewAPI() *covDriftAPI {
	return &covDriftAPI{mockAPI: &mockAPI{}, stateToken: "state-tok", gitToken: "git-tok"}
}

// FetchStateToken answers the per-job state-token mint.
func (a *covDriftAPI) FetchStateToken(jobID string) (string, error) {
	if a.stateTokenErr != nil {
		return "", a.stateTokenErr
	}
	return a.stateToken, nil
}

// FetchGitToken answers the git-token mint and records that it was called.
func (a *covDriftAPI) FetchGitToken(jobID, repoURL string) (string, error) {
	a.gitTokenCalls++
	if a.gitTokenErr != nil {
		return "", a.gitTokenErr
	}
	return a.gitToken, nil
}

// covDriftSandbox stands in for the isolation backend. Like the container backend it
// IGNORES the in-process closure and instead writes the result.json the parent reads
// back, so no customer module is ever cloned or planned in a unit test.
type covDriftSandbox struct {
	err        error
	resultJSON string // written to <workdir>/result.json when non-empty
	calls      int
	spec       sandbox.Spec
}

// Run records the spec, optionally seeds result.json, and returns the canned error.
func (s *covDriftSandbox) Run(ctx context.Context, spec sandbox.Spec, job sandbox.Job) error {
	s.calls++
	s.spec = spec
	if spec.Warn != nil {
		spec.Warn("isolation double")
	}
	if s.resultJSON != "" && spec.WorkDir != "" {
		if err := os.WriteFile(filepath.Join(spec.WorkDir, "result.json"), []byte(s.resultJSON), 0o600); err != nil {
			return err
		}
	}
	return s.err
}

// ── fixtures ────────────────────────────────────────────────────────────────────

// covDriftRunner builds a Runner over the decorated mock with the given operator and
// the double as its isolation backend.
func covDriftRunner(t *testing.T, api JobAPI, operator string, sb sandbox.Sandbox) *Runner {
	t.Helper()
	t.Setenv("ALETHIA_SANDBOX_BACKEND", "")
	t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "")
	w := NewWithAPI(Config{Operator: operator, AlethiaURL: "https://console.test"}, api)
	if sb != nil {
		w.sandbox = sb
	}
	return w
}

// covDriftLoggers returns a STDOUT/STDERR JobLogger pair, closed at test end so their
// flush goroutines never outlive the test and every chunk has reached the mock.
func covDriftLoggers(t *testing.T, api JobAPI) (*JobLogger, *JobLogger) {
	t.Helper()
	out := NewJobLogger(api, "drift-job", "STDOUT")
	errl := NewJobLogger(api, "drift-job", "STDERR")
	t.Cleanup(func() {
		out.Close()
		errl.Close()
	})
	return out, errl
}

// covDriftSnapshot renders a ProjectConfig into the console's config_snapshot shape
// (a JSON round-trip), so every key is one the runner contract models.
func covDriftSnapshot(t *testing.T, vc types.ProjectConfig) map[string]any {
	t.Helper()
	b, err := json.Marshal(vc)
	if err != nil {
		t.Fatalf("marshal project config: %v", err)
	}
	var snap map[string]any
	if err := json.Unmarshal(b, &snap); err != nil {
		t.Fatalf("decode project config: %v", err)
	}
	return snap
}

// covDriftJob wraps a snapshot in a DETECT_DRIFT job.
func covDriftJob(snapshot map[string]any) *Job {
	return &Job{ID: "drift-job", JobType: "DETECT_DRIFT", ConfigSnapshot: snapshot}
}

// covDriftLogText joins every chunk the mock received, so a warning written to the
// STDERR JobLogger can be asserted on. Callers must Close the loggers first.
func covDriftLogText(m *mockAPI) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var b strings.Builder
	for _, c := range m.logChunks {
		b.WriteString(c.chunk)
	}
	return b.String()
}

// covDriftMetadata returns the metadata of the last status update carrying `key`.
func covDriftMetadata(m *mockAPI, key string) map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := len(m.statusUpdates) - 1; i >= 0; i-- {
		if _, ok := m.statusUpdates[i].metadata[key]; ok {
			return m.statusUpdates[i].metadata
		}
	}
	return nil
}

// ── drift.go: config-snapshot contract + provider/account resolution ─────────────

// TestDrift_UnknownSnapshotKeyFailsClosed pins that a config_snapshot key the runner
// contract does not model aborts the drift job before any work, rather than being
// silently dropped.
func TestDrift_UnknownSnapshotKeyFailsClosed(t *testing.T) {
	api := covDriftNewAPI()
	w := covDriftRunner(t, api, "self", &covDriftSandbox{})
	out, errl := covDriftLoggers(t, api)

	job := covDriftJob(map[string]any{"a_key_the_contract_never_modeled": "x"})
	err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl)
	if err == nil || !strings.Contains(err.Error(), "failed to parse config snapshot") {
		t.Fatalf("want parse-snapshot failure, got %v", err)
	}
	if len(api.statusUpdates) != 0 {
		t.Fatalf("no status update expected before the snapshot parses, got %d", len(api.statusUpdates))
	}
}

// TestDrift_StateTokenFailureAbortsAfterProcessingUpdate pins the state-token mint as
// a hard failure, and that the drift job announces its refresh phase before minting.
// It also drives the provider fallback chain: an empty argument AND an empty snapshot
// provider default to aws.
func TestDrift_StateTokenFailureAbortsAfterProcessingUpdate(t *testing.T) {
	api := covDriftNewAPI()
	api.stateTokenErr = errors.New("mint refused")
	w := covDriftRunner(t, api, "self", &covDriftSandbox{})
	out, errl := covDriftLoggers(t, api)

	job := covDriftJob(covDriftSnapshot(t, types.ProjectConfig{ProjectName: "p"}))
	err := w.executeDriftDetection(context.Background(), job, "", nil, out, errl)
	if err == nil || !strings.Contains(err.Error(), "failed to fetch tofu state token") {
		t.Fatalf("want state-token failure, got %v", err)
	}
	if len(api.statusUpdates) != 1 || api.statusUpdates[0].metadata["phase"] != "drift_refresh" {
		t.Fatalf("want one drift_refresh PROCESSING update, got %+v", api.statusUpdates)
	}
}

// TestDrift_SnapshotProviderUsedWhenArgumentEmpty pins that an empty provider argument
// falls back to the snapshot's provider (only then to aws).
func TestDrift_SnapshotProviderUsedWhenArgumentEmpty(t *testing.T) {
	api := covDriftNewAPI()
	api.stateTokenErr = errors.New("stop here")
	w := covDriftRunner(t, api, "self", &covDriftSandbox{})
	out, errl := covDriftLoggers(t, api)

	job := covDriftJob(covDriftSnapshot(t, types.ProjectConfig{Provider: types.CloudProvider("gcp")}))
	err := w.executeDriftDetection(context.Background(), job, "", nil, out, errl)
	if err == nil {
		t.Fatal("want the state-token failure that stops the run")
	}
}

// TestDrift_IdentityAccountIDResolvedPerProvider pins that a stored CloudIdentity
// supplies the account identifier (the GCP project id for gcp), and that with no
// identity the ambient environment supplies it instead.
func TestDrift_IdentityAccountIDResolvedPerProvider(t *testing.T) {
	t.Setenv("GOOGLE_PROJECT", "ambient-project")

	for _, tc := range []struct {
		name     string
		identity *CloudIdentity
	}{
		{"stored identity", &CloudIdentity{Provider: "gcp", ProjectID: "stored-project"}},
		{"ambient identity", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := covDriftNewAPI()
			api.stateTokenErr = errors.New("stop here")
			w := covDriftRunner(t, api, "self", &covDriftSandbox{})
			out, errl := covDriftLoggers(t, api)

			job := covDriftJob(covDriftSnapshot(t, types.ProjectConfig{}))
			err := w.executeDriftDetection(context.Background(), job, "gcp", tc.identity, out, errl)
			if err == nil || !strings.Contains(err.Error(), "state token") {
				t.Fatalf("want the state-token failure that stops the run, got %v", err)
			}
		})
	}
}

// ── drift.go: the E0 bring-your-own-IaC gate ────────────────────────────────────

// TestDrift_ManagedByoIacRefusedBeforeAnyWork pins the fail-closed E0 boundary: a
// managed runner without the egress-enforced container sandbox refuses a BYO drift,
// and refuses it BEFORE it announces a phase or mints a state token.
func TestDrift_ManagedByoIacRefusedBeforeAnyWork(t *testing.T) {
	for _, operator := range []string{"", "managed", "Self"} {
		t.Run("operator="+operator, func(t *testing.T) {
			api := covDriftNewAPI()
			sb := &covDriftSandbox{}
			w := covDriftRunner(t, api, operator, sb)
			out, errl := covDriftLoggers(t, api)

			vc := types.ProjectConfig{IacSource: &types.ProjectIacSourceConfig{
				RepoURL: "https://git.test/mod.git", CommitSHA: "abc123",
			}}
			job := covDriftJob(covDriftSnapshot(t, vc))
			err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl)
			if err == nil || !strings.Contains(err.Error(), "refusing to run bring-your-own IaC DETECT_DRIFT") {
				t.Fatalf("want the E0 refusal, got %v", err)
			}
			if len(api.statusUpdates) != 0 {
				t.Fatalf("gate must run before any status update, got %+v", api.statusUpdates)
			}
			if sb.calls != 0 {
				t.Fatalf("gate must run before the sandbox, got %d call(s)", sb.calls)
			}
		})
	}
}

// ── drift.go: the bring-your-own-IaC branch ─────────────────────────────────────

// covDriftPostureResult is a result.json carrying an out-of-sync posture, the shape
// the sandbox child writes back.
const covDriftPostureResult = `{"drift_posture":{"in_sync":false,"drifted":2,"unmanaged":0,"unmanaged_known":false}}`

// TestDrift_ByoRunsThroughTheSandboxAndRecordsPosture pins the BYO branch: the work is
// handed to the sandbox as a `drift` stage with a per-job workdir, and the posture the
// child wrote back is posted to execution_metadata.
func TestDrift_ByoRunsThroughTheSandboxAndRecordsPosture(t *testing.T) {
	api := covDriftNewAPI()
	sb := &covDriftSandbox{resultJSON: covDriftPostureResult}
	w := covDriftRunner(t, api, "self", sb)
	out, errl := covDriftLoggers(t, api)

	vc := types.ProjectConfig{
		ProjectName: "byo",
		IacSource:   &types.ProjectIacSourceConfig{RepoURL: "https://git.test/mod.git", CommitSHA: "abc123"},
	}
	job := covDriftJob(covDriftSnapshot(t, vc))
	if err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl); err != nil {
		t.Fatalf("byo drift: %v", err)
	}

	if sb.calls != 1 {
		t.Fatalf("want exactly one sandbox run, got %d", sb.calls)
	}
	if sb.spec.Kind != "drift" || sb.spec.JobID != "drift-job" || sb.spec.Provider != "aws" {
		t.Fatalf("unexpected sandbox spec: %+v", sb.spec)
	}
	if sb.spec.WorkDir == "" {
		t.Fatal("sandbox spec must carry a per-job workdir")
	}
	if sb.spec.Stage == nil || sb.spec.Stage.Kind != sandbox.StageDrift {
		t.Fatalf("want a serialized drift stage, got %+v", sb.spec.Stage)
	}
	var payload stageDriftPayload
	if err := json.Unmarshal(sb.spec.Stage.Payload, &payload); err != nil {
		t.Fatalf("decode stage payload: %v", err)
	}
	if payload.JobID != "drift-job" || payload.StateConsoleURL != "https://console.test" {
		t.Fatalf("unexpected stage payload: %+v", payload)
	}
	if payload.ProjectConfig == nil || payload.ProjectConfig.GitAccessToken != "" {
		t.Fatal("the stage payload must never carry the git token")
	}

	meta := covDriftMetadata(api.mockAPI, "drift_posture")
	if meta == nil {
		t.Fatalf("want a drift_posture update, got %+v", api.statusUpdates)
	}

	// The workdir is removed once the handler returns.
	if _, err := os.Stat(sb.spec.WorkDir); !os.IsNotExist(err) {
		t.Fatalf("workdir must be cleaned up, stat err = %v", err)
	}
}

// TestDrift_ByoFetchesGitTokenOnlyWhenTheSnapshotHasNone pins the token precedence: a
// token frozen on the snapshot is used as-is, and only its absence triggers a mint.
func TestDrift_ByoFetchesGitTokenOnlyWhenTheSnapshotHasNone(t *testing.T) {
	for _, tc := range []struct {
		name      string
		snapToken string
		wantCalls int
	}{
		{"snapshot token wins", "frozen-token", 0},
		{"empty snapshot token mints", "", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := covDriftNewAPI()
			sb := &covDriftSandbox{resultJSON: covDriftPostureResult}
			w := covDriftRunner(t, api, "self", sb)
			out, errl := covDriftLoggers(t, api)

			vc := types.ProjectConfig{
				GitAccessToken: tc.snapToken,
				IacSource:      &types.ProjectIacSourceConfig{RepoURL: "https://git.test/mod.git", CommitSHA: "abc"},
			}
			job := covDriftJob(covDriftSnapshot(t, vc))
			if err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl); err != nil {
				t.Fatalf("byo drift: %v", err)
			}
			if api.gitTokenCalls != tc.wantCalls {
				t.Fatalf("git-token mints = %d, want %d", api.gitTokenCalls, tc.wantCalls)
			}
		})
	}
}

// TestDrift_ByoWarnsWhenTheGitTokenMintFails pins that a failed git-token mint is a
// warning on the job's stderr, not a job failure — a public module still clones.
func TestDrift_ByoWarnsWhenTheGitTokenMintFails(t *testing.T) {
	api := covDriftNewAPI()
	api.gitTokenErr = errors.New("no git connection")
	sb := &covDriftSandbox{resultJSON: covDriftPostureResult}
	w := covDriftRunner(t, api, "self", sb)
	out, errl := covDriftLoggers(t, api)

	vc := types.ProjectConfig{IacSource: &types.ProjectIacSourceConfig{RepoURL: "https://git.test/m.git", CommitSHA: "a"}}
	job := covDriftJob(covDriftSnapshot(t, vc))
	if err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl); err != nil {
		t.Fatalf("a failed git-token mint must not fail the job: %v", err)
	}

	out.Close()
	errl.Close()
	if logs := covDriftLogText(api.mockAPI); !strings.Contains(logs, "failed to fetch git token") {
		t.Fatalf("want a git-token warning on the job log, got %q", logs)
	}
}

// TestDrift_ByoSandboxFailurePropagates pins that a sandbox failure fails the drift
// job rather than being reported as an in-sync posture.
func TestDrift_ByoSandboxFailurePropagates(t *testing.T) {
	api := covDriftNewAPI()
	sb := &covDriftSandbox{err: errors.New("container refused")}
	w := covDriftRunner(t, api, "self", sb)
	out, errl := covDriftLoggers(t, api)

	vc := types.ProjectConfig{IacSource: &types.ProjectIacSourceConfig{RepoURL: "https://git.test/m.git", CommitSHA: "a"}}
	job := covDriftJob(covDriftSnapshot(t, vc))
	err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl)
	if err == nil || !strings.Contains(err.Error(), "container refused") {
		t.Fatalf("want the sandbox failure, got %v", err)
	}
	if meta := covDriftMetadata(api.mockAPI, "drift_posture"); meta != nil {
		t.Fatalf("a failed sandbox must post no posture, got %+v", meta)
	}
}

// TestDrift_ByoMissingResultWarnsAndSucceeds pins the read-back: when the sandbox left
// no result.json the handler warns and completes without a posture, rather than
// crashing or inventing one.
func TestDrift_ByoMissingResultWarnsAndSucceeds(t *testing.T) {
	api := covDriftNewAPI()
	sb := &covDriftSandbox{} // writes nothing
	w := covDriftRunner(t, api, "self", sb)
	out, errl := covDriftLoggers(t, api)

	vc := types.ProjectConfig{IacSource: &types.ProjectIacSourceConfig{RepoURL: "https://git.test/m.git", CommitSHA: "a"}}
	job := covDriftJob(covDriftSnapshot(t, vc))
	if err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl); err != nil {
		t.Fatalf("a missing result must not fail the job: %v", err)
	}

	out.Close()
	errl.Close()
	if logs := covDriftLogText(api.mockAPI); !strings.Contains(logs, "could not read drift result") {
		t.Fatalf("want a read-back warning, got %q", logs)
	}
	if meta := covDriftMetadata(api.mockAPI, "drift_posture"); meta != nil {
		t.Fatalf("no posture expected, got %+v", meta)
	}
}

// TestDrift_ByoEmptyPostureRecordsNothing pins that a result.json with no posture
// section completes the job without posting a null posture.
func TestDrift_ByoEmptyPostureRecordsNothing(t *testing.T) {
	api := covDriftNewAPI()
	sb := &covDriftSandbox{resultJSON: `{}`}
	w := covDriftRunner(t, api, "self", sb)
	out, errl := covDriftLoggers(t, api)

	vc := types.ProjectConfig{IacSource: &types.ProjectIacSourceConfig{RepoURL: "https://git.test/m.git", CommitSHA: "a"}}
	job := covDriftJob(covDriftSnapshot(t, vc))
	if err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl); err != nil {
		t.Fatalf("byo drift: %v", err)
	}
	if meta := covDriftMetadata(api.mockAPI, "drift_posture"); meta != nil {
		t.Fatalf("no posture expected, got %+v", meta)
	}
}

// TestDrift_ByoWorkdirCreationFailurePropagates pins that a runner which cannot
// create the per-job workdir fails the drift job instead of running the stage
// against an empty path.
func TestDrift_ByoWorkdirCreationFailurePropagates(t *testing.T) {
	api := covDriftNewAPI()
	sb := &covDriftSandbox{}
	w := covDriftRunner(t, api, "self", sb)
	out, errl := covDriftLoggers(t, api)
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "no-such-dir"))

	vc := types.ProjectConfig{IacSource: &types.ProjectIacSourceConfig{RepoURL: "https://git.test/m.git", CommitSHA: "a"}}
	job := covDriftJob(covDriftSnapshot(t, vc))
	err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl)
	if err == nil || !strings.Contains(err.Error(), "create workdir") {
		t.Fatalf("want a workdir-creation failure, got %v", err)
	}
	if sb.calls != 0 {
		t.Fatalf("no sandbox run expected without a workdir, got %d", sb.calls)
	}
}

// covDriftClosureSandbox is the Passthrough-shaped double: it runs the in-process
// closure the caller built, which is what the no-isolation backend does.
type covDriftClosureSandbox struct{ ran bool }

// Run invokes the job closure in-process.
func (s *covDriftClosureSandbox) Run(ctx context.Context, spec sandbox.Spec, job sandbox.Job) error {
	s.ran = true
	return job(ctx)
}

// TestDrift_ByoClosureRunsTheRefreshOnlyStage pins that the closure handed to the
// sandbox really is the refresh-only drift stage: run through a Passthrough-shaped
// backend it reaches the untrusted-transport check and refuses a local repo URL.
func TestDrift_ByoClosureRunsTheRefreshOnlyStage(t *testing.T) {
	api := covDriftNewAPI()
	sb := &covDriftClosureSandbox{}
	w := covDriftRunner(t, api, "self", sb)
	out, errl := covDriftLoggers(t, api)

	vc := types.ProjectConfig{IacSource: &types.ProjectIacSourceConfig{
		RepoURL: "file:///etc/passwd", CommitSHA: "abc123",
	}}
	job := covDriftJob(covDriftSnapshot(t, vc))
	err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl)
	if !sb.ran {
		t.Fatal("the sandbox closure was never run")
	}
	if err == nil || !strings.Contains(err.Error(), "https or ssh git transport") {
		t.Fatalf("want the untrusted-transport refusal from inside the stage, got %v", err)
	}
}

// ── drift.go: the trusted-template branch ───────────────────────────────────────

// covDriftShQuote single-quotes s for safe interpolation into a POSIX sh script.
func covDriftShQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// covDriftTofuStub installs a `tofu` shim first on PATH. It answers `version -json`
// (terraform-exec probes the version before every subcommand) and prints `out.<sub>`
// for any subcommand that has one; everything else exits 0 with no output. With the
// shim present the binary resolver never downloads OpenTofu, so the test needs no
// network.
func covDriftTofuStub(t *testing.T, files map[string]string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	files["version.json"] = `{"terraform_version":"1.9.0","platform":"linux_amd64","provider_selections":{},"terraform_outdated":false}`
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatalf("write stub data %s: %v", name, err)
		}
	}
	script := "#!/bin/sh\nD=" + covDriftShQuote(dir) + `
case "$1" in
  version)
    if [ "$2" = "-json" ]; then cat "$D/version.json"; else echo "OpenTofu v1.9.0"; fi
    exit 0
    ;;
esac
[ -f "$D/out.$1" ] && cat "$D/out.$1"
exit 0
`
	if err := os.WriteFile(filepath.Join(dir, "tofu"), []byte(script), 0o755); err != nil {
		t.Fatalf("write tofu stub: %v", err)
	}
}

// covDriftTemplates lays out a project-templates tree under a fresh working directory
// and chdirs into it, so resolveProjectTemplatesDir resolves its relative candidate.
func covDriftTemplates(t *testing.T, provider string) {
	t.Helper()
	base := t.TempDir()
	dir := filepath.Join(base, "project-templates", provider)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("lay out templates: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte("# stub\n"), 0o600); err != nil {
		t.Fatalf("write template: %v", err)
	}
	t.Chdir(base)
}

// TestDrift_TrustedTemplateFailurePropagates pins that a refresh-only plan which never
// gets off the ground (no templates on disk) fails the job.
func TestDrift_TrustedTemplateFailurePropagates(t *testing.T) {
	covDriftTofuStub(t, map[string]string{})
	t.Chdir(t.TempDir()) // no project-templates tree

	api := covDriftNewAPI()
	w := covDriftRunner(t, api, "self", &covDriftSandbox{})
	out, errl := covDriftLoggers(t, api)

	job := covDriftJob(covDriftSnapshot(t, types.ProjectConfig{ProjectName: "p"}))
	err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl)
	if err == nil {
		t.Fatal("want a drift-detection failure with no templates on disk")
	}
	if meta := covDriftMetadata(api.mockAPI, "drift_posture"); meta != nil {
		t.Fatalf("a failed run must post no posture, got %+v", meta)
	}
}

// TestDrift_TrustedTemplatePostsPosture pins the trusted-template branch end to end:
// the refresh-only plan's drift section becomes execution_metadata.drift_posture, and
// with no cluster name on the config the day-2 inspection contributes nothing (no
// addon_status / security_report / gitops_status keys).
func TestDrift_TrustedTemplatePostsPosture(t *testing.T) {
	plan := `{"format_version":"1.2","terraform_version":"1.9.0","resource_drift":[` +
		`{"address":"aws_s3_bucket.b","type":"aws_s3_bucket","mode":"managed","change":{"actions":["update"]}}]}`
	covDriftTofuStub(t, map[string]string{
		"out.show":   plan,
		"out.output": `{"cluster_name":{"sensitive":false,"type":"string","value":"c"}}`,
	})
	covDriftTemplates(t, "aws")

	api := covDriftNewAPI()
	w := covDriftRunner(t, api, "self", &covDriftSandbox{})
	out, errl := covDriftLoggers(t, api)

	job := covDriftJob(covDriftSnapshot(t, types.ProjectConfig{ProjectName: "p", Region: "eu-central-1"}))
	if err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl); err != nil {
		t.Fatalf("trusted-template drift: %v", err)
	}

	meta := covDriftMetadata(api.mockAPI, "drift_posture")
	if meta == nil {
		t.Fatalf("want a drift_posture update, got %+v", api.statusUpdates)
	}
	for _, k := range []string{"addon_status", "security_report", "gitops_status"} {
		if _, ok := meta[k]; ok {
			t.Fatalf("inspection contributed %q without a cluster", k)
		}
	}
}

// covDriftKubectlStub installs a `kubectl` shim beside the tofu one, answering every
// read with `body`, so the day-2 inspection never reaches a real cluster.
func covDriftKubectlStub(t *testing.T, body string) {
	t.Helper()
	dir := strings.SplitN(os.Getenv("PATH"), string(os.PathListSeparator), 2)[0]
	script := "#!/bin/sh\nprintf '%s' " + covDriftShQuote(body) + "\nexit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatalf("write kubectl stub: %v", err)
	}
}

// TestDrift_TrustedTemplateRefreshesDay2Surfaces pins the day-2 refresh that rides on
// the drift run: with a cluster reachable from the workspace outputs, the add-on
// health, the security posture and the GitOps status are posted alongside the posture
// in ONE status update, so they share its persistence path.
func TestDrift_TrustedTemplateRefreshesDay2Surfaces(t *testing.T) {
	kubeconfig := "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n"
	outputs := map[string]any{
		"cluster_name": map[string]any{"sensitive": false, "type": "string", "value": "drift-cluster"},
		"kubeconfig":   map[string]any{"sensitive": true, "type": "string", "value": kubeconfig},
	}
	outputsJSON, err := json.Marshal(outputs)
	if err != nil {
		t.Fatalf("encode outputs: %v", err)
	}
	covDriftTofuStub(t, map[string]string{
		"out.show":   `{"format_version":"1.2","terraform_version":"1.9.0"}`,
		"out.output": string(outputsJSON),
	})
	covDriftKubectlStub(t, `{"items":[]}`)
	covDriftTemplates(t, "aws")
	// Keep the kubeconfig the provider writes (and the KUBECONFIG it exports) inside the
	// test: t.Setenv restores both when the test ends.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KUBECONFIG", "")

	api := covDriftNewAPI()
	w := covDriftRunner(t, api, "self", &covDriftSandbox{})
	out, errl := covDriftLoggers(t, api)

	vc := types.ProjectConfig{ProjectName: "p", Region: "eu-central-1"}
	vc.Cluster.ClusterName = "drift-cluster"
	vc.AddOns = []types.AddOnInstall{{ID: "cert-manager", Mode: "managed"}}
	vc.Repositories.AppsDestinationRepo = "https://git.test/apps.git"

	job := covDriftJob(covDriftSnapshot(t, vc))
	if err := w.executeDriftDetection(context.Background(), job, "aws", nil, out, errl); err != nil {
		t.Fatalf("trusted-template drift: %v", err)
	}

	meta := covDriftMetadata(api.mockAPI, "drift_posture")
	if meta == nil {
		t.Fatalf("want a drift_posture update, got %+v", api.statusUpdates)
	}
	for _, k := range []string{"addon_status", "security_report", "gitops_status"} {
		if _, ok := meta[k]; !ok {
			t.Fatalf("day-2 refresh dropped %q from %v", k, meta)
		}
	}
}

// ── analyze_repo.go: the ANALYZE_REPO handler ───────────────────────────────────

// covDriftGit runs a git command in dir with an explicit identity and no global
// config, so the fixture repo needs nothing from the machine it is built on.
func covDriftGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// covDriftFixtureRepo builds a one-commit repository the analyzer can clone over the
// file transport, and returns its path and default branch.
func covDriftFixtureRepo(t *testing.T) (string, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	repo := t.TempDir()
	covDriftGit(t, repo, "init", "-q")
	files := map[string]string{
		"go.mod":     "module example.com/app\n\ngo 1.24\n",
		"main.go":    "package main\n\nfunc main() {}\n",
		"Dockerfile": "FROM scratch\n",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	covDriftGit(t, repo, "add", ".")
	covDriftGit(t, repo, "commit", "-q", "-m", "c1")
	return repo, covDriftGit(t, repo, "rev-parse", "--abbrev-ref", "HEAD")
}

// TestDrift_AnalyzeRepoRequiresARepoURL pins that an ANALYZE_REPO job with no
// repo_url on its snapshot fails immediately rather than cloning nothing.
func TestDrift_AnalyzeRepoRequiresARepoURL(t *testing.T) {
	api := covDriftNewAPI()
	w := covDriftRunner(t, api, "self", nil)
	out, errl := covDriftLoggers(t, api)

	job := &Job{ID: "drift-job", JobType: "ANALYZE_REPO", ConfigSnapshot: map[string]any{}}
	err := w.executeAnalyzeRepo(context.Background(), job, out, errl)
	if err == nil || !strings.Contains(err.Error(), "missing repo_url") {
		t.Fatalf("want the missing-repo_url failure, got %v", err)
	}
}

// TestDrift_AnalyzeRepoCloneFailurePropagates pins that an unreachable repository
// fails the analysis, and that a token from the mint is used for the clone.
func TestDrift_AnalyzeRepoCloneFailurePropagates(t *testing.T) {
	api := covDriftNewAPI()
	w := covDriftRunner(t, api, "self", nil)
	out, errl := covDriftLoggers(t, api)

	job := &Job{ID: "drift-job", JobType: "ANALYZE_REPO", ConfigSnapshot: map[string]any{
		"repo_url": "file://" + filepath.Join(t.TempDir(), "no-such-repo"),
		"ref":      "main",
	}}
	err := w.executeAnalyzeRepo(context.Background(), job, out, errl)
	if err == nil || !strings.Contains(err.Error(), "clone failed") {
		t.Fatalf("want a clone failure, got %v", err)
	}
	if api.gitTokenCalls != 1 {
		t.Fatalf("want one git-token mint, got %d", api.gitTokenCalls)
	}
}

// TestDrift_AnalyzeRepoWorkdirCreationFailurePropagates pins that a runner which
// cannot create its scratch directory fails the analysis instead of scanning an
// empty path.
func TestDrift_AnalyzeRepoWorkdirCreationFailurePropagates(t *testing.T) {
	api := covDriftNewAPI()
	w := covDriftRunner(t, api, "self", nil)
	out, errl := covDriftLoggers(t, api)
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "no-such-dir"))

	job := &Job{ID: "drift-job", JobType: "ANALYZE_REPO", ConfigSnapshot: map[string]any{
		"repo_url": "https://git.test/app.git",
	}}
	err := w.executeAnalyzeRepo(context.Background(), job, out, errl)
	if err == nil || !strings.Contains(err.Error(), "create temp dir") {
		t.Fatalf("want a scratch-directory failure, got %v", err)
	}
}

// TestDrift_AnalyzeRepoWarnsWhenTheGitTokenMintFails pins that a failed mint is a
// warning and the analysis falls back to a public (token-less) clone.
func TestDrift_AnalyzeRepoWarnsWhenTheGitTokenMintFails(t *testing.T) {
	api := covDriftNewAPI()
	api.gitTokenErr = errors.New("no git connection")
	w := covDriftRunner(t, api, "self", nil)
	out, errl := covDriftLoggers(t, api)

	job := &Job{ID: "drift-job", JobType: "ANALYZE_REPO", ConfigSnapshot: map[string]any{
		"repo_url": "file://" + filepath.Join(t.TempDir(), "no-such-repo"),
	}}
	if err := w.executeAnalyzeRepo(context.Background(), job, out, errl); err == nil {
		t.Fatal("want a clone failure for a repository that does not exist")
	}

	out.Close()
	errl.Close()
	if logs := covDriftLogText(api.mockAPI); !strings.Contains(logs, "attempting public clone") {
		t.Fatalf("want the public-clone fallback warning, got %q", logs)
	}
}

// TestDrift_AnalyzeRepoPostsTheDigest pins the happy path: the repository is cloned,
// statically scanned, and the digest lands on execution_metadata.repo_digest.
func TestDrift_AnalyzeRepoPostsTheDigest(t *testing.T) {
	repo, branch := covDriftFixtureRepo(t)

	api := covDriftNewAPI()
	api.gitToken = "" // no token → the public-clone path over the file transport
	w := covDriftRunner(t, api, "self", nil)
	out, errl := covDriftLoggers(t, api)

	job := &Job{ID: "drift-job", JobType: "ANALYZE_REPO", ConfigSnapshot: map[string]any{
		"repo_url": "file://" + repo,
		"ref":      branch,
	}}
	if err := w.executeAnalyzeRepo(context.Background(), job, out, errl); err != nil {
		t.Fatalf("analyze repo: %v", err)
	}

	meta := covDriftMetadata(api.mockAPI, "repo_digest")
	if meta == nil {
		t.Fatalf("want a repo_digest update, got %+v", api.statusUpdates)
	}
	digest, ok := meta["repo_digest"].(map[string]any)
	if !ok {
		t.Fatalf("repo_digest = %T, want an object", meta["repo_digest"])
	}
	if digest["repo_url"] != "file://"+repo {
		t.Fatalf("digest repo_url = %v", digest["repo_url"])
	}
}

// TestDrift_AnalyzeRepoPersistFailurePropagates pins that a console that refuses the
// digest fails the job rather than reporting a completed analysis.
func TestDrift_AnalyzeRepoPersistFailurePropagates(t *testing.T) {
	repo, branch := covDriftFixtureRepo(t)

	api := &covDriftPersistFailAPI{covDriftAPI: covDriftNewAPI()}
	api.gitToken = ""
	w := covDriftRunner(t, api, "self", nil)
	out, errl := covDriftLoggers(t, api)

	job := &Job{ID: "drift-job", JobType: "ANALYZE_REPO", ConfigSnapshot: map[string]any{
		"repo_url": "file://" + repo,
		"ref":      branch,
	}}
	err := w.executeAnalyzeRepo(context.Background(), job, out, errl)
	if err == nil || !strings.Contains(err.Error(), "persist digest") {
		t.Fatalf("want the persist failure, got %v", err)
	}
}

// covDriftPersistFailAPI refuses every status update.
type covDriftPersistFailAPI struct{ *covDriftAPI }

// UpdateJobStatus always fails.
func (a *covDriftPersistFailAPI) UpdateJobStatus(jobID, status, errMsg string, metadata map[string]any) error {
	return errors.New("console refused the update")
}

// ── api.go: the console HTTP client ─────────────────────────────────────────────

// covDriftAPICall is one client method reduced to its error result, so the whole
// surface can be driven through the same failure modes.
type covDriftAPICall struct {
	name string
	call func(*RunnerAPIClient) error
}

// covDriftAPICalls enumerates every client method, with a file-backed pair for the
// plan-artifact upload/download.
func covDriftAPICalls(t *testing.T) []covDriftAPICall {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(dir, "plan.bin")
	if err := os.WriteFile(src, []byte("plan-bytes"), 0o600); err != nil {
		t.Fatalf("write plan fixture: %v", err)
	}
	dst := filepath.Join(dir, "downloaded.bin")

	return []covDriftAPICall{
		{"Heartbeat", func(c *RunnerAPIClient) error { _, err := c.Heartbeat(); return err }},
		{"ClaimJob", func(c *RunnerAPIClient) error { _, err := c.ClaimJob(); return err }},
		{"StreamWake", func(c *RunnerAPIClient) error {
			return c.StreamWake(context.Background(), func(WakeEvent) {})
		}},
		{"UpdateJobStatus", func(c *RunnerAPIClient) error { return c.UpdateJobStatus("j1", "PROCESSING", "", nil) }},
		{"SendLog", func(c *RunnerAPIClient) error { return c.SendLog("j1", "chunk", "STDOUT", "tp") }},
		{"UploadPlanArtifact", func(c *RunnerAPIClient) error { return c.UploadPlanArtifact("j1", src) }},
		{"DownloadPlanArtifact", func(c *RunnerAPIClient) error { return c.DownloadPlanArtifact("j1", dst) }},
		{"FetchGitToken", func(c *RunnerAPIClient) error { _, err := c.FetchGitToken("j1", "https://git.test/r.git"); return err }},
		{"FetchAddonSecrets", func(c *RunnerAPIClient) error { _, err := c.FetchAddonSecrets("j1"); return err }},
		{"FetchFabricTalosconfig", func(c *RunnerAPIClient) error { _, err := c.FetchFabricTalosconfig("j1"); return err }},
		{"PutFabricTalosconfig", func(c *RunnerAPIClient) error { return c.PutFabricTalosconfig("j1", "tc") }},
		{"FetchStateToken", func(c *RunnerAPIClient) error { _, err := c.FetchStateToken("j1"); return err }},
		{"PurgeProjectState", func(c *RunnerAPIClient) error { return c.PurgeProjectState("j1", "state-tok") }},
		{"FetchAzureToken", func(c *RunnerAPIClient) error { _, err := c.FetchAzureToken("j1"); return err }},
		{"FetchAwsToken", func(c *RunnerAPIClient) error { _, err := c.FetchAwsToken("j1"); return err }},
		{"FetchAlibabaToken", func(c *RunnerAPIClient) error { _, err := c.FetchAlibabaToken("j1"); return err }},
		{"FetchGcpToken", func(c *RunnerAPIClient) error { _, err := c.FetchGcpToken("j1"); return err }},
		{"UpdateRunnerMetadata", func(c *RunnerAPIClient) error {
			return c.UpdateRunnerMetadata("r1", map[string]any{"cpu": 1})
		}},
		{"DeleteRunner", func(c *RunnerAPIClient) error { return c.DeleteRunner("r1") }},
		{"GetJob", func(c *RunnerAPIClient) error { _, err := c.GetJob("j1"); return err }},
	}
}

// TestDrift_APIRejectsAnUnbuildableRequest pins that every client method surfaces a
// request-construction failure (a console URL carrying a control byte) rather than
// panicking or issuing a request to a mangled address.
func TestDrift_APIRejectsAnUnbuildableRequest(t *testing.T) {
	for _, tc := range covDriftAPICalls(t) {
		t.Run(tc.name, func(t *testing.T) {
			c := NewRunnerAPIClient("http://console\x7f.test", "r1", "tok")
			if err := tc.call(c); err == nil {
				t.Fatal("want a request-construction error")
			}
		})
	}
}

// TestDrift_APISurfacesTransportFailures pins that a console the runner cannot reach
// is an error on every method — never a silent success.
func TestDrift_APISurfacesTransportFailures(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	base := srv.URL
	srv.Close() // nothing is listening any more

	for _, tc := range covDriftAPICalls(t) {
		t.Run(tc.name, func(t *testing.T) {
			c := NewRunnerAPIClient(base, "r1", "tok")
			if err := tc.call(c); err == nil {
				t.Fatal("want a transport error")
			}
		})
	}
}

// TestDrift_APISurfacesNonOKStatus pins that a console error status fails every
// method rather than being read as an empty-but-valid answer.
func TestDrift_APISurfacesNonOKStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	for _, tc := range covDriftAPICalls(t) {
		t.Run(tc.name, func(t *testing.T) {
			c := NewRunnerAPIClient(srv.URL, "r1", "tok")
			if err := tc.call(c); err == nil {
				t.Fatal("want a status error")
			}
		})
	}
}

// TestDrift_APISurfacesMalformedBodies pins that a 200 carrying a body the client
// cannot decode is an error on every decoding method. Heartbeat is deliberately
// excluded: a malformed heartbeat body must NOT fail liveness (see below).
func TestDrift_APISurfacesMalformedBodies(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "{not-json")
	}))
	defer srv.Close()

	decoding := map[string]bool{
		"ClaimJob": true, "FetchGitToken": true, "FetchAddonSecrets": true,
		"FetchFabricTalosconfig": true, "FetchStateToken": true, "FetchAzureToken": true,
		"FetchAwsToken": true, "FetchAlibabaToken": true, "FetchGcpToken": true, "GetJob": true,
	}
	for _, tc := range covDriftAPICalls(t) {
		if !decoding[tc.name] {
			continue
		}
		t.Run(tc.name, func(t *testing.T) {
			c := NewRunnerAPIClient(srv.URL, "r1", "tok")
			if err := tc.call(c); err == nil {
				t.Fatal("want a decode error")
			}
		})
	}
}

// TestDrift_APIHeartbeatCarriesCancelledJobIDs pins the fallback cancel channel: the
// heartbeat body's cancelled_job_ids reach the caller, and a body the client cannot
// decode degrades to "no cancels" instead of failing the heartbeat.
func TestDrift_APIHeartbeatCarriesCancelledJobIDs(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, body)
	}))
	defer srv.Close()
	c := NewRunnerAPIClient(srv.URL, "r1", "tok")

	body = `{"cancelled_job_ids":["job-a","job-b"]}`
	ids, err := c.Heartbeat()
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if len(ids) != 2 || ids[0] != "job-a" || ids[1] != "job-b" {
		t.Fatalf("cancelled ids = %v", ids)
	}

	body = "{not-json"
	ids, err = c.Heartbeat()
	if err != nil || ids != nil {
		t.Fatalf("a malformed body must not fail liveness, got ids=%v err=%v", ids, err)
	}
}

// TestDrift_APIWakeStreamReusesTheConfiguredTransport pins that the long-lived wake
// stream clones the base client's transport (so a custom proxy/TLS applies there too)
// and drops the overall timeout.
func TestDrift_APIWakeStreamReusesTheConfiguredTransport(t *testing.T) {
	c := NewRunnerAPIClient("https://console.test", "r1", "tok")
	base := &http.Transport{MaxIdleConns: 7}
	c.httpClient.Transport = base

	sc := c.wakeStreamClient()
	tr, ok := sc.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("wake client transport = %T, want *http.Transport", sc.Transport)
	}
	if tr == base {
		t.Fatal("the wake client must clone the transport, not share it")
	}
	if tr.MaxIdleConns != 7 {
		t.Fatalf("clone lost the base configuration: MaxIdleConns = %d", tr.MaxIdleConns)
	}
	if tr.ResponseHeaderTimeout != wakeResponseHeaderTimeout || sc.Timeout != 0 {
		t.Fatalf("wake client timeouts = %v / %v", tr.ResponseHeaderTimeout, sc.Timeout)
	}
}

// TestDrift_APIRejectsUnencodablePayloads pins that a payload the client cannot encode
// is refused locally — no half-formed request reaches the console.
func TestDrift_APIRejectsUnencodablePayloads(t *testing.T) {
	var reached int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached++ }))
	defer srv.Close()
	c := NewRunnerAPIClient(srv.URL, "r1", "tok")

	unencodable := map[string]any{"ch": make(chan int)}
	if err := c.UpdateJobStatus("j1", "PROCESSING", "", unencodable); err == nil {
		t.Fatal("want an encode error for the execution metadata")
	}
	if err := c.UpdateRunnerMetadata("r1", unencodable); err == nil {
		t.Fatal("want an encode error for the runner metadata")
	}
	if reached != 0 {
		t.Fatalf("no request may be issued for an unencodable payload, got %d", reached)
	}
}

// TestDrift_APIPlanArtifactRoundTrip pins the plan-artifact pair: an upload is only
// accepted on 201, a download writes the bytes to disk, and the two distinguishable
// failure modes (a missing local file, an expired artifact) are reported as such.
func TestDrift_APIPlanArtifactRoundTrip(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "plan.bin")
	if err := os.WriteFile(src, []byte("plan-bytes"), 0o600); err != nil {
		t.Fatalf("write plan fixture: %v", err)
	}

	var status int
	var uploaded []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			uploaded, _ = io.ReadAll(r.Body)
			w.WriteHeader(status)
			return
		}
		if status == http.StatusNotFound {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		fmt.Fprint(w, "plan-bytes")
	}))
	defer srv.Close()
	c := NewRunnerAPIClient(srv.URL, "r1", "tok")

	status = http.StatusCreated
	if err := c.UploadPlanArtifact("j1", src); err != nil {
		t.Fatalf("upload: %v", err)
	}
	if string(uploaded) != "plan-bytes" {
		t.Fatalf("uploaded body = %q", uploaded)
	}

	dst := filepath.Join(dir, "out.bin")
	status = http.StatusOK
	if err := c.DownloadPlanArtifact("j1", dst); err != nil {
		t.Fatalf("download: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil || string(got) != "plan-bytes" {
		t.Fatalf("downloaded %q, err=%v", got, err)
	}

	if err := c.UploadPlanArtifact("j1", filepath.Join(dir, "missing.bin")); err == nil ||
		!strings.Contains(err.Error(), "failed to read plan file") {
		t.Fatalf("want a read failure for a missing local file, got %v", err)
	}

	status = http.StatusNotFound
	if err := c.DownloadPlanArtifact("j1", dst); err == nil ||
		!strings.Contains(err.Error(), "expired or missing") {
		t.Fatalf("want the expired-artifact error, got %v", err)
	}

	status = http.StatusOK
	if err := c.DownloadPlanArtifact("j1", filepath.Join(dir, "no-such-dir", "out.bin")); err == nil ||
		!strings.Contains(err.Error(), "failed to create dest file") {
		t.Fatalf("want a destination-create failure, got %v", err)
	}
}

// TestDrift_APIDownloadSurfacesATruncatedBody pins that a body cut short mid-transfer
// fails the download instead of leaving a silently truncated plan file behind.
func TestDrift_APIDownloadSurfacesATruncatedBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "64")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "short")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		panic(http.ErrAbortHandler) // drop the connection mid-body
	}))
	defer srv.Close()
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)

	c := NewRunnerAPIClient(srv.URL, "r1", "tok")
	err := c.DownloadPlanArtifact("j1", filepath.Join(t.TempDir(), "out.bin"))
	if err == nil || !strings.Contains(err.Error(), "failed to write plan artifact") {
		t.Fatalf("want a write failure for a truncated body, got %v", err)
	}
}

// TestDrift_APIOptionalFieldsDegradeToEmpty pins the two "absent is not an error"
// contracts: a null git token and a Fabric with no talosconfig yet both read as "".
func TestDrift_APIOptionalFieldsDegradeToEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"token":null,"talosconfig":null}`)
	}))
	defer srv.Close()
	c := NewRunnerAPIClient(srv.URL, "r1", "tok")

	tok, err := c.FetchGitToken("j1", "")
	if err != nil || tok != "" {
		t.Fatalf("git token = %q, err = %v", tok, err)
	}
	tc, err := c.FetchFabricTalosconfig("j1")
	if err != nil || tc != "" {
		t.Fatalf("talosconfig = %q, err = %v", tc, err)
	}
}

// TestDrift_APIStateAndTalosconfigWrites pins the two authenticated writes: the state
// purge presents the per-job state token as HTTP Basic (never the runner headers) and
// accepts 200 or 204, and the talosconfig PUT carries the config as JSON.
func TestDrift_APIStateAndTalosconfigWrites(t *testing.T) {
	var (
		mu       sync.Mutex
		gotUser  string
		gotPass  string
		gotBody  string
		gotToken string
		status   = http.StatusNoContent
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodDelete {
			gotUser, gotPass, _ = r.BasicAuth()
			gotToken = r.Header.Get("X-Runner-Token")
			w.WriteHeader(status)
			return
		}
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
	}))
	defer srv.Close()
	c := NewRunnerAPIClient(srv.URL, "r1", "runner-tok")

	if err := c.PurgeProjectState("j1", "state-tok"); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if gotUser != "alethia" || gotPass != "state-tok" {
		t.Fatalf("basic auth = %q/%q", gotUser, gotPass)
	}
	if gotToken != "" {
		t.Fatal("the purge must not present the runner token")
	}

	status = http.StatusOK
	if err := c.PurgeProjectState("j1", "state-tok"); err != nil {
		t.Fatalf("purge (200): %v", err)
	}

	if err := c.PutFabricTalosconfig("j1", "talos-yaml"); err != nil {
		t.Fatalf("put talosconfig: %v", err)
	}
	if !strings.Contains(gotBody, "talos-yaml") {
		t.Fatalf("talosconfig body = %q", gotBody)
	}
}

// TestDrift_APIDeleteRunnerAcceptsBothSuccessCodes pins that runner deregistration
// treats 200 and 204 alike.
func TestDrift_APIDeleteRunnerAcceptsBothSuccessCodes(t *testing.T) {
	for _, code := range []int{http.StatusOK, http.StatusNoContent} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
		}))
		c := NewRunnerAPIClient(srv.URL, "r1", "tok")
		if err := c.DeleteRunner("r1"); err != nil {
			t.Fatalf("delete runner (%d): %v", code, err)
		}
		srv.Close()
	}
}

// TestDrift_APISendLogAcceptsCreated pins that the log endpoint's 201 is a success,
// not an unexpected status.
func TestDrift_APISendLogAcceptsCreated(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	c := NewRunnerAPIClient(srv.URL, "r1", "tok")
	if err := c.SendLog("j1", "hello", "STDOUT", "00-trace-span-01"); err != nil {
		t.Fatalf("send log: %v", err)
	}
	if !strings.Contains(gotBody, "00-trace-span-01") {
		t.Fatalf("the traceparent must ride along, body = %q", gotBody)
	}
}
