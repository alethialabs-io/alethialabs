// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Coverage proofs for the runner's BUILD handler (build.go), the serialized stage
// contract (stage.go) and the runner-lifecycle DEPLOY_RUNNER / DESTROY_RUNNER handlers
// (deploy_runner.go, destroy_runner.go).
//
// The three shell-outs these paths make — `tofu`, `kubectl` and `git` — are exercised
// against RECORDING STUBS installed first on PATH, so every branch runs with no cluster,
// no cloud account and no network. The stubs answer canned stdout per subcommand and
// record every invocation, which lets a test assert BOTH what the handler parsed and
// which commands it issued.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ── stub plumbing ───────────────────────────────────────────────────────────────

// covBuildStubs is a directory of recording executables placed first on PATH for the
// lifetime of one test.
type covBuildStubs struct {
	dir     string
	logPath string
}

// covBuildShQuote single-quotes s for safe interpolation into a POSIX sh script.
func covBuildShQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// covBuildNewStubs creates the stub directory and prepends it to PATH.
func covBuildNewStubs(t *testing.T) *covBuildStubs {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return &covBuildStubs{dir: dir, logPath: filepath.Join(dir, "calls.log")}
}

// write puts a data file inside the stub directory (canned stdout / exit codes).
func (s *covBuildStubs) write(t *testing.T, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(s.dir, name), []byte(body), 0o600); err != nil {
		t.Fatalf("write stub data %s: %v", name, err)
	}
}

// install writes an executable shim named `name` running the given sh body.
func (s *covBuildStubs) install(t *testing.T, name, body string) {
	t.Helper()
	script := "#!/bin/sh\nprintf '%s\\n' \"$0 $*\" >> " + covBuildShQuote(s.logPath) + "\nD=" +
		covBuildShQuote(s.dir) + "\n" + body
	if err := os.WriteFile(filepath.Join(s.dir, name), []byte(script), 0o755); err != nil {
		t.Fatalf("write stub %s: %v", name, err)
	}
}

// calls returns every recorded stub invocation, in order.
func (s *covBuildStubs) calls() []string {
	body, err := os.ReadFile(s.logPath)
	if err != nil {
		return nil
	}
	var out []string
	for _, ln := range strings.Split(strings.TrimRight(string(body), "\n"), "\n") {
		if ln != "" {
			out = append(out, ln)
		}
	}
	return out
}

// sawCall reports whether any recorded invocation contains every one of `parts`.
func (s *covBuildStubs) sawCall(parts ...string) bool {
	for _, c := range s.calls() {
		hit := true
		for _, p := range parts {
			if !strings.Contains(c, p) {
				hit = false
				break
			}
		}
		if hit {
			return true
		}
	}
	return false
}

// covBuildTofuStub installs a `tofu` shim. It answers `version` from a fixed JSON body
// (terraform-exec probes the version before every subcommand) and, for any other
// subcommand, prints `out.<sub>` when present and exits with `code.<sub>` when present.
func covBuildTofuStub(t *testing.T, s *covBuildStubs) {
	t.Helper()
	s.write(t, "version.json", `{"terraform_version":"1.9.0","platform":"linux_amd64","provider_selections":{},"terraform_outdated":false}`)
	s.install(t, "tofu", `case "$1" in
  version)
    if [ "$2" = "-json" ]; then cat "$D/version.json"; else echo "OpenTofu v1.9.0"; fi
    exit 0
    ;;
esac
[ -f "$D/out.$1" ] && cat "$D/out.$1"
[ -f "$D/code.$1" ] && exit "$(cat "$D/code.$1")"
exit 0
`)
}

// covBuildKubectlStub installs a `kubectl` shim that prints `kout.<n>` for the n-th rule
// whose match string appears in the joined arguments, exiting with that rule's code.
type covBuildKubeRule struct {
	match  string
	stdout string
	exit   int
}

func covBuildKubectlStub(t *testing.T, s *covBuildStubs, defaultExit int, rules ...covBuildKubeRule) {
	t.Helper()
	var b strings.Builder
	if len(rules) > 0 {
		b.WriteString("case \"$*\" in\n")
		for i, r := range rules {
			name := fmt.Sprintf("kout-%d", i)
			s.write(t, name, r.stdout)
			fmt.Fprintf(&b, "  *%s*) cat %s; exit %d;;\n",
				covBuildShQuote(r.match), covBuildShQuote(filepath.Join(s.dir, name)), r.exit)
		}
		b.WriteString("esac\n")
	}
	fmt.Fprintf(&b, "exit %d\n", defaultExit)
	s.install(t, "kubectl", b.String())
}

// ── API double ──────────────────────────────────────────────────────────────────

// covBuildAPI decorates the package mock with per-test failure injection for exactly the
// calls the build / runner-lifecycle handlers make.
type covBuildAPI struct {
	*mockAPI
	stateTokenErr error
	purgeErr      error
	deleteErr     error
	metadataErr   error
	gitToken      string
	gitTokenErr   error
	metadata      []map[string]any
	deleted       []string
}

func (a *covBuildAPI) FetchStateToken(jobID string) (string, error) {
	if a.stateTokenErr != nil {
		return "", a.stateTokenErr
	}
	return "cov-state-token", nil
}

func (a *covBuildAPI) PurgeProjectState(jobID, stateToken string) error { return a.purgeErr }

func (a *covBuildAPI) DeleteRunner(runnerID string) error {
	a.deleted = append(a.deleted, runnerID)
	return a.deleteErr
}

func (a *covBuildAPI) UpdateRunnerMetadata(runnerID string, metadata map[string]any) error {
	a.metadata = append(a.metadata, metadata)
	return a.metadataErr
}

func (a *covBuildAPI) FetchGitToken(jobID, repoURL string) (string, error) {
	if a.gitTokenErr != nil {
		return "", a.gitTokenErr
	}
	return a.gitToken, nil
}

// covBuildRunner builds a Runner over the decorated mock with the default Passthrough
// sandbox and a console URL the state backend can render.
func covBuildRunner(t *testing.T, api JobAPI) *Runner {
	t.Helper()
	t.Setenv("ALETHIA_SANDBOX_BACKEND", "")
	t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "")
	return NewWithAPI(Config{Operator: "self", AlethiaURL: "https://console.test"}, api)
}

// covBuildLoggers returns a STDOUT/STDERR JobLogger pair, closed at test end so their
// flush goroutines never outlive the test.
func covBuildLoggers(t *testing.T, api JobAPI) (*JobLogger, *JobLogger) {
	t.Helper()
	out := NewJobLogger(api, "cov-job", "STDOUT")
	errl := NewJobLogger(api, "cov-job", "STDERR")
	t.Cleanup(func() {
		out.Close()
		errl.Close()
	})
	return out, errl
}

// covBuildTemplates lays out a runner-templates tree under a fresh working directory and
// chdirs into it, so resolveRunnerTemplatesDir resolves the relative "runner-templates"
// candidate deterministically.
func covBuildTemplates(t *testing.T, providers ...string) string {
	t.Helper()
	base := t.TempDir()
	for _, p := range providers {
		dir := filepath.Join(base, "runner-templates", p)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte("# stub\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Chdir(base)
	return base
}

// ── deploy_runner.go / destroy_runner.go: config parsing ────────────────────────

// TestBuild_ParseRunnerConfigs pins the runner-lifecycle snapshot contract: DEPLOY needs
// both a runner id and a token, DESTROY needs only the id, and a snapshot that cannot be
// marshalled or that types a field wrongly is a parse error rather than a zero config.
func TestBuild_ParseRunnerConfigs(t *testing.T) {
	if _, err := parseRunnerDeployConfig(map[string]any{"runner_id": "r1"}); err == nil {
		t.Error("deploy config without a runner_token must fail")
	}
	cfg, err := parseRunnerDeployConfig(map[string]any{"runner_id": "r1", "runner_token": "tok"})
	if err != nil || cfg.RunnerID != "r1" || cfg.RunnerToken != "tok" {
		t.Fatalf("deploy config = %+v, err=%v", cfg, err)
	}
	if _, err := parseRunnerDestroyConfig(map[string]any{"runner_token": "tok"}); err == nil {
		t.Error("destroy config without a runner_id must fail")
	}
	dcfg, err := parseRunnerDestroyConfig(map[string]any{"runner_id": "r1"})
	if err != nil || dcfg.RunnerID != "r1" {
		t.Fatalf("destroy config = %+v, err=%v", dcfg, err)
	}

	// A value JSON cannot encode fails at marshal; a wrongly typed field fails at decode.
	unmarshalable := map[string]any{"runner_id": make(chan int)}
	if _, err := parseRunnerDeployConfig(unmarshalable); err == nil {
		t.Error("un-marshalable snapshot must fail")
	}
	if _, err := parseRunnerDestroyConfig(unmarshalable); err == nil {
		t.Error("un-marshalable snapshot must fail for destroy too")
	}
	badType := map[string]any{"runner_id": "r1", "runner_token": "t", "cpu": "not-a-number"}
	if _, err := parseRunnerDeployConfig(badType); err == nil {
		t.Error("wrongly typed cpu must fail to decode")
	}
	if _, err := parseRunnerDestroyConfig(badType); err == nil {
		t.Error("wrongly typed cpu must fail to decode for destroy too")
	}
}

// TestBuild_ResolveRunnerTemplatesDir pins the candidate search: the first EXISTING
// directory wins, and an absent tree resolves to "" (which the handlers turn into a
// job error rather than a silent no-op).
func TestBuild_ResolveRunnerTemplatesDir(t *testing.T) {
	t.Chdir(t.TempDir())
	if got := resolveRunnerTemplatesDir(); got != "" {
		t.Fatalf("no templates anywhere should resolve to \"\", got %q", got)
	}
	covBuildTemplates(t, "aws")
	if got := resolveRunnerTemplatesDir(); got != "runner-templates" {
		t.Fatalf("resolveRunnerTemplatesDir = %q, want runner-templates", got)
	}
}

// TestBuild_CopyDir pins the template copier: a tree is reproduced file-for-file under
// the destination, and a missing source is surfaced as an error (never a silent empty
// workdir, which would make tofu plan an empty module).
func TestBuild_CopyDir(t *testing.T) {
	src := t.TempDir()
	if err := os.MkdirAll(filepath.Join(src, "modules", "net"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "main.tf"), []byte("root"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "modules", "net", "net.tf"), []byte("net"), 0o644); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), "work")
	if err := copyDir(src, dst); err != nil {
		t.Fatalf("copyDir: %v", err)
	}
	body, err := os.ReadFile(filepath.Join(dst, "modules", "net", "net.tf"))
	if err != nil || string(body) != "net" {
		t.Fatalf("nested file not copied: %q err=%v", body, err)
	}

	if err := copyDir(filepath.Join(src, "does-not-exist"), dst); err == nil {
		t.Error("copyDir over a missing source must fail")
	}

	// An unreadable member is an error, never a silently truncated copy: a workdir missing
	// one .tf file would plan a DIFFERENT module than the template describes.
	if os.Geteuid() == 0 {
		t.Skip("running as root: file modes do not deny reads")
	}
	locked := t.TempDir()
	if err := os.WriteFile(filepath.Join(locked, "main.tf"), []byte("x"), 0o000); err != nil {
		t.Fatal(err)
	}
	if err := copyDir(locked, filepath.Join(t.TempDir(), "work")); err == nil {
		t.Error("copyDir over an unreadable file must fail")
	}
}

// covBuildLockedTemplates lays out a runner-templates tree whose single template file
// cannot be read, so the handlers' copyDir step fails. Skips when the test process can
// read anything regardless of mode.
func covBuildLockedTemplates(t *testing.T, provider string) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("running as root: file modes do not deny reads")
	}
	base := t.TempDir()
	dir := filepath.Join(base, "runner-templates", provider)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte("# stub\n"), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Chdir(base)
}

// ── destroy_runner.go ───────────────────────────────────────────────────────────

func covBuildDestroyJob() *Job {
	return &Job{
		ID:      "job-destroy",
		JobType: "DESTROY_RUNNER",
		ConfigSnapshot: map[string]any{
			"runner_id":      "11111111-2222-3333-4444-555555555555",
			"runner_name":    "fleet-a",
			"region":         "eu-central-1",
			"alethia_url":    "https://console.test",
			"cloud_provider": "aws",
		},
	}
}

// TestBuild_ExecuteDestroyRunner_Guards pins every pre-tofu refusal of DESTROY_RUNNER:
// an unparseable snapshot, a missing templates tree, an unknown provider, and a state
// token the console refuses to mint all fail the job before any teardown is attempted.
func TestBuild_ExecuteDestroyRunner_Guards(t *testing.T) {
	ctx := context.Background()

	t.Run("bad snapshot", func(t *testing.T) {
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		job := &Job{ID: "j", ConfigSnapshot: map[string]any{"runner_name": "x"}}
		if err := w.executeDestroyRunner(ctx, job, "aws", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "parse runner destroy config") {
			t.Fatalf("want a parse error, got %v", err)
		}
	})

	t.Run("no templates dir", func(t *testing.T) {
		t.Chdir(t.TempDir())
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDestroyRunner(ctx, covBuildDestroyJob(), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "templates directory not found") {
			t.Fatalf("want a templates-not-found error, got %v", err)
		}
	})

	t.Run("provider without templates", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		job := covBuildDestroyJob()
		job.ConfigSnapshot["cloud_provider"] = "nimbus"
		if err := w.executeDestroyRunner(ctx, job, "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "no templates for provider nimbus") {
			t.Fatalf("want a per-provider templates error, got %v", err)
		}
	})

	t.Run("provider defaults to aws", func(t *testing.T) {
		covBuildTemplates(t, "gcp")
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		job := covBuildDestroyJob()
		delete(job.ConfigSnapshot, "cloud_provider")
		// No snapshot provider and no job provider ⇒ "aws", which this tree lacks.
		if err := w.executeDestroyRunner(ctx, job, "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "no templates for provider aws") {
			t.Fatalf("want the aws default, got %v", err)
		}
	})

	t.Run("temp dir unavailable", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "absent"))
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDestroyRunner(ctx, covBuildDestroyJob(), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "create temp dir") {
			t.Fatalf("want a temp-dir error, got %v", err)
		}
	})

	t.Run("state token refused", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		api := &covBuildAPI{mockAPI: &mockAPI{}, stateTokenErr: errors.New("nope")}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDestroyRunner(ctx, covBuildDestroyJob(), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "fetch state token") {
			t.Fatalf("want a state-token error, got %v", err)
		}
	})

	t.Run("templates uncopyable", func(t *testing.T) {
		covBuildLockedTemplates(t, "aws")
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDestroyRunner(ctx, covBuildDestroyJob(), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "copy runner templates") {
			t.Fatalf("want a template-copy error, got %v", err)
		}
	})
}

// TestBuild_ExecuteDestroyRunner_Tofu drives DESTROY_RUNNER through the stubbed OpenTofu
// CLI: an init or destroy that exits non-zero fails the job, and a clean teardown purges
// the state object and deletes the runner record.
func TestBuild_ExecuteDestroyRunner_Tofu(t *testing.T) {
	ctx := context.Background()

	t.Run("init fails", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "code.init", "1")
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDestroyRunner(ctx, covBuildDestroyJob(), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "tofu init failed") {
			t.Fatalf("want a tofu init error, got %v", err)
		}
	})

	t.Run("destroy fails", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "code.destroy", "1")
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDestroyRunner(ctx, covBuildDestroyJob(), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "tofu destroy failed") {
			t.Fatalf("want a tofu destroy error, got %v", err)
		}
	})

	t.Run("clean teardown", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		// Both best-effort cleanups fail: the job must still SUCCEED (they are warnings).
		api := &covBuildAPI{mockAPI: &mockAPI{}, purgeErr: errors.New("purge boom"), deleteErr: errors.New("delete boom")}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDestroyRunner(ctx, covBuildDestroyJob(), "", nil, out, errl); err != nil {
			t.Fatalf("a failing purge/delete must stay a warning, got %v", err)
		}
		if !s.sawCall("tofu", "destroy") {
			t.Errorf("no tofu destroy issued: %v", s.calls())
		}
		if len(api.deleted) != 1 {
			t.Errorf("runner record delete not attempted: %v", api.deleted)
		}
	})

	t.Run("happy path", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDestroyRunner(ctx, covBuildDestroyJob(), "", nil, out, errl); err != nil {
			t.Fatalf("destroy: %v", err)
		}
	})
}

// ── deploy_runner.go ────────────────────────────────────────────────────────────

func covBuildDeployJob() *Job {
	return &Job{
		ID:      "job-deploy",
		JobType: "DEPLOY_RUNNER",
		ConfigSnapshot: map[string]any{
			"runner_id":        "11111111-2222-3333-4444-555555555555",
			"runner_token":     "runner-bearer-token",
			"runner_name":      "fleet-a",
			"region":           "eu-central-1",
			"alethia_url":      "https://console.test",
			"image_repository": "ghcr.io/alethia/runner",
			"cloud_provider":   "aws",
		},
	}
}

// TestBuild_ExecuteDeployRunner_Guards pins DEPLOY_RUNNER's pre-tofu refusals and the
// defaulted fields (image tag / cpu / memory / provider) the console may omit.
func TestBuild_ExecuteDeployRunner_Guards(t *testing.T) {
	ctx := context.Background()

	t.Run("bad snapshot", func(t *testing.T) {
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		job := &Job{ID: "j", ConfigSnapshot: map[string]any{"runner_id": "r1"}}
		if err := w.executeDeployRunner(ctx, job, "aws", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "parse runner deploy config") {
			t.Fatalf("want a parse error, got %v", err)
		}
	})

	t.Run("no templates dir", func(t *testing.T) {
		t.Chdir(t.TempDir())
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDeployRunner(ctx, covBuildDeployJob(), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "templates directory not found") {
			t.Fatalf("want a templates-not-found error, got %v", err)
		}
	})

	t.Run("provider from the job when the snapshot omits it", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		job := covBuildDeployJob()
		delete(job.ConfigSnapshot, "cloud_provider")
		if err := w.executeDeployRunner(ctx, job, "nimbus", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "no templates for provider nimbus") {
			t.Fatalf("want the job provider to win, got %v", err)
		}
	})

	t.Run("temp dir unavailable", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "absent"))
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDeployRunner(ctx, covBuildDeployJob(), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "create temp dir") {
			t.Fatalf("want a temp-dir error, got %v", err)
		}
	})

	t.Run("state token refused", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		api := &covBuildAPI{mockAPI: &mockAPI{}, stateTokenErr: errors.New("nope")}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDeployRunner(ctx, covBuildDeployJob(), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "fetch state token") {
			t.Fatalf("want a state-token error, got %v", err)
		}
	})

	t.Run("provider defaults to aws", func(t *testing.T) {
		covBuildTemplates(t, "gcp")
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		job := covBuildDeployJob()
		delete(job.ConfigSnapshot, "cloud_provider")
		if err := w.executeDeployRunner(ctx, job, "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "no templates for provider aws") {
			t.Fatalf("want the aws default, got %v", err)
		}
	})

	t.Run("templates uncopyable", func(t *testing.T) {
		covBuildLockedTemplates(t, "aws")
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDeployRunner(ctx, covBuildDeployJob(), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "copy runner templates") {
			t.Fatalf("want a template-copy error, got %v", err)
		}
	})
}

// TestBuild_ExecuteDeployRunner_Tofu drives DEPLOY_RUNNER through the stubbed OpenTofu
// CLI: init / plan / apply failures each fail the job, and a clean apply posts the tofu
// outputs plus a redeploy-able config that MUST NOT carry the runner's bearer token.
func TestBuild_ExecuteDeployRunner_Tofu(t *testing.T) {
	ctx := context.Background()

	for _, tc := range []struct {
		name, failing, want string
	}{
		{"init fails", "init", "tofu init failed"},
		{"plan fails", "plan", "tofu plan failed"},
		{"apply fails", "apply", "tofu apply failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			covBuildTemplates(t, "aws")
			s := covBuildNewStubs(t)
			covBuildTofuStub(t, s)
			s.write(t, "code."+tc.failing, "1")
			api := &covBuildAPI{mockAPI: &mockAPI{}}
			w := covBuildRunner(t, api)
			out, errl := covBuildLoggers(t, api)
			if err := w.executeDeployRunner(ctx, covBuildDeployJob(), "", nil, out, errl); err == nil ||
				!strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
		})
	}

	t.Run("outputs unreadable is only a warning", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "code.output", "1")
		api := &covBuildAPI{mockAPI: &mockAPI{}, metadataErr: errors.New("metadata boom")}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDeployRunner(ctx, covBuildDeployJob(), "", nil, out, errl); err != nil {
			t.Fatalf("unreadable outputs / metadata write must not fail the job, got %v", err)
		}
	})

	t.Run("happy path", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.output", `{"runner_service_arn":{"sensitive":false,"type":"string","value":"arn:aws:ecs:svc"}}`)
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDeployRunner(ctx, covBuildDeployJob(), "", nil, out, errl); err != nil {
			t.Fatalf("deploy: %v", err)
		}

		var posted map[string]any
		for _, u := range api.getStatusUpdates() {
			if _, ok := u.metadata["runner_outputs"]; ok {
				posted = u.metadata
			}
		}
		if posted == nil {
			t.Fatalf("tofu outputs were never posted: %v", api.getStatusUpdates())
		}
		if len(api.metadata) != 1 {
			t.Fatalf("deploy config not persisted: %v", api.metadata)
		}
		blob, err := json.Marshal(api.metadata[0])
		if err != nil {
			t.Fatal(err)
		}
		// #945: runners.metadata is plaintext JSONB — the bearer token must never land there.
		if strings.Contains(string(blob), "runner-bearer-token") {
			t.Errorf("runner token leaked into runner metadata: %s", blob)
		}
	})

	t.Run("defaults fill in for an omitted image tag and size", func(t *testing.T) {
		covBuildTemplates(t, "aws")
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeDeployRunner(ctx, covBuildDeployJob(), "", nil, out, errl); err != nil {
			t.Fatalf("deploy: %v", err)
		}
		if len(api.metadata) != 1 {
			t.Fatalf("deploy config not persisted: %v", api.metadata)
		}
		cfg, ok := api.metadata[0]["deploy_config"].(map[string]any)
		if !ok {
			t.Fatalf("no deploy_config: %v", api.metadata[0])
		}
		if cfg["image_tag"] != "latest" || cfg["cpu"] != 512 || cfg["memory"] != 1024 {
			t.Errorf("defaults not applied: %v", cfg)
		}
	})
}

// ── stage.go ────────────────────────────────────────────────────────────────────

// TestBuild_CostCeilingFromEnv pins the opt-in real-apply cost ceiling: only a positive,
// parseable value arms the guard; anything else means "disabled" (0), never a panic or a
// guard that blocks every apply.
func TestBuild_CostCeilingFromEnv(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want float64
	}{
		{"", 0}, {"  ", 0}, {"abc", 0}, {"-5", 0}, {"0", 0}, {" 250.5 ", 250.5},
	} {
		t.Setenv("ALETHIA_COST_CEILING_MONTHLY_USD", tc.raw)
		if got := costCeilingFromEnv(); got != tc.want {
			t.Errorf("costCeilingFromEnv(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

// TestBuild_StageSecretsFromEnv_AddonSecrets pins the W4.5 add-on secret channel: the
// parent JSON-encodes addon id → field → plaintext into the child's allowlisted env and
// the child decodes it back; malformed JSON degrades to an empty map, never a nil deref.
func TestBuild_StageSecretsFromEnv_AddonSecrets(t *testing.T) {
	t.Setenv("ALETHIA_STAGE_ADDON_SECRETS", `{"grafana":{"admin_password":"s3cr3t"}}`)
	t.Setenv("ALETHIA_STAGE_TALOS_CONFIG", "talos-yaml")
	sec := stageSecretsFromEnv()
	if sec.AddonSecrets["grafana"]["admin_password"] != "s3cr3t" {
		t.Fatalf("add-on secret lost: %#v", sec.AddonSecrets)
	}
	if sec.TalosConfig != "talos-yaml" {
		t.Errorf("talosconfig lost: %q", sec.TalosConfig)
	}

	t.Setenv("ALETHIA_STAGE_ADDON_SECRETS", "{not json")
	if sec := stageSecretsFromEnv(); sec.AddonSecrets == nil || len(sec.AddonSecrets) != 0 {
		t.Fatalf("malformed add-on secrets must degrade to an empty map, got %#v", sec.AddonSecrets)
	}
}

// TestBuild_NewStage pins the container-backend envelope: a payload that JSON encodes
// becomes a sandbox.Stage carrying the kind and the encoded bytes; one that cannot be
// encoded is an error rather than an empty stage.
func TestBuild_NewStage(t *testing.T) {
	st, err := newStage(sandbox.StageKind("deploy"), map[string]string{"a": "b"})
	if err != nil || st.Kind != sandbox.StageKind("deploy") || !strings.Contains(string(st.Payload), `"a":"b"`) {
		t.Fatalf("newStage = %+v, err=%v", st, err)
	}
	if _, err := newStage(sandbox.StageKind("deploy"), make(chan int)); err == nil {
		t.Error("an un-encodable payload must be an error")
	}
}

// TestBuild_BuildDestroyAndDriftPayloads pins the two remaining stage projections: the
// caller's ProjectConfig is never mutated, the git token is blanked (it crosses via the
// child's env), and the json:"-" fields are carried explicitly.
func TestBuild_BuildDestroyAndDriftPayloads(t *testing.T) {
	vc := &types.ProjectConfig{
		ProjectName:          "web",
		GitAccessToken:       "ghp_secret",
		CloudAccountID:       "123456789012",
		ConnectorCredentials: []types.ConnectorCredential{{Category: "dns", Slug: "cloudflare"}},
	}

	dp := buildDestroyPayload(vc, "aws", "/tpl", "/cat", "https://console", "job-1")
	if dp.ProjectConfig.GitAccessToken != "" || vc.GitAccessToken != "ghp_secret" {
		t.Error("destroy payload must blank the token without mutating the caller")
	}
	if dp.CloudAccountID != "123456789012" || len(dp.ConnectorCredentials) != 1 {
		t.Errorf("destroy payload lost the json:- fields: %+v", dp)
	}

	drp := buildDriftPayload(vc, "aws", "/tpl", "/cat", "https://console", "job-1")
	if drp.ProjectConfig.GitAccessToken != "" || vc.GitAccessToken != "ghp_secret" {
		t.Error("drift payload must blank the token without mutating the caller")
	}
	if drp.CloudAccountID != "123456789012" || drp.JobID != "job-1" {
		t.Errorf("drift payload lost its fields: %+v", drp)
	}
}

// TestBuild_NonNilStrings pins the console-contract JSON shape: a nil slice serializes as
// [] rather than null, so a report consumer never has to null-check.
func TestBuild_NonNilStrings(t *testing.T) {
	if got := nonNilStrings(nil); got == nil || len(got) != 0 {
		t.Fatalf("nonNilStrings(nil) = %#v, want an empty non-nil slice", got)
	}
	if got := nonNilStrings([]string{"a"}); len(got) != 1 {
		t.Fatalf("nonNilStrings passed through wrongly: %#v", got)
	}
}

// TestBuild_WriteStageResult pins the stage's failure signalling: the error is recorded
// into result.json AND returned, and when result.json itself cannot be written the stage
// error still wins (a write failure must never mask the real cause).
func TestBuild_WriteStageResult(t *testing.T) {
	dir := t.TempDir()
	stageErr := errors.New("apply exploded")
	if err := writeStageResult(dir, stageResult{}, stageErr); !errors.Is(err, stageErr) {
		t.Fatalf("writeStageResult must return the stage error, got %v", err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "result.json"))
	if err != nil {
		t.Fatal(err)
	}
	var res stageResult
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatal(err)
	}
	if res.Error != "apply exploded" {
		t.Errorf("result.json error = %q", res.Error)
	}

	// An un-writable workdir: the stage error still wins…
	missing := filepath.Join(dir, "absent")
	if err := writeStageResult(missing, stageResult{}, stageErr); !errors.Is(err, stageErr) {
		t.Errorf("a write failure must not mask the stage error, got %v", err)
	}
	// …and with no stage error the write failure itself is surfaced.
	if err := writeStageResult(missing, stageResult{}, nil); err == nil ||
		!strings.Contains(err.Error(), "write result.json") {
		t.Errorf("want a write result.json error, got %v", err)
	}
}

// TestBuild_ReadStageResults pins every result.json reader the parent uses after the
// sandbox runs: an absent file is an error, a malformed file is an error, an empty slot
// is (nil, nil) — "the stage emitted none" — and a populated slot decodes.
func TestBuild_ReadStageResults(t *testing.T) {
	empty := t.TempDir()
	if err := os.WriteFile(filepath.Join(empty, "result.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	bad := t.TempDir()
	if err := os.WriteFile(filepath.Join(bad, "result.json"), []byte(`{`), 0o600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(t.TempDir(), "absent")

	full := t.TempDir()
	body, err := json.Marshal(stageResult{
		PlanResult:     json.RawMessage(`{"has_changes":true}`),
		VerifyReport:   json.RawMessage(`{"ok":true}`),
		IacReport:      json.RawMessage(`{"ok":true,"commit_sha":"abc"}`),
		DriftPosture:   json.RawMessage(`{"drifted":2}`),
		ChartWorkloads: json.RawMessage(`[{"name":"web"}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(full, "result.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}

	// Each reader, over each workdir shape. The typed value is checked separately below.
	readers := map[string]func(string) error{
		"plan": func(d string) error { _, err := readPlanResult(d); return err },
		"verify": func(d string) error {
			_, err := readVerifyReport(d)
			return err
		},
		"chart": func(d string) error { _, err := readChartWorkloads(d); return err },
		"iac":   func(d string) error { _, err := readIacScanReport(d); return err },
		"drift": func(d string) error { _, err := readDriftPosture(d); return err },
	}
	for name, read := range readers {
		if err := read(missing); err == nil {
			t.Errorf("%s: an absent result.json must be an error", name)
		}
		if err := read(bad); err == nil {
			t.Errorf("%s: a malformed result.json must be an error", name)
		}
		if err := read(empty); err != nil {
			t.Errorf("%s: an empty slot must be (nil, nil), got %v", name, err)
		}
		if err := read(full); err != nil {
			t.Errorf("%s: populated slot failed to decode: %v", name, err)
		}
	}

	if pr, err := readPlanResult(empty); pr != nil || err != nil {
		t.Errorf("empty plan slot = %v, %v", pr, err)
	}
	if rep, err := readVerifyReport(empty); rep != nil || err != nil {
		t.Errorf("empty verify slot = %v, %v", rep, err)
	}
	if wl, err := readChartWorkloads(empty); wl != nil || err != nil {
		t.Errorf("empty workloads slot = %v, %v", wl, err)
	}
	if rep, err := readIacScanReport(empty); rep != nil || err != nil {
		t.Errorf("empty iac slot = %v, %v", rep, err)
	}
	if p, err := readDriftPosture(empty); p != nil || err != nil {
		t.Errorf("empty drift slot = %v, %v", p, err)
	}

	wl, err := readChartWorkloads(full)
	if err != nil || len(wl) != 1 || wl[0].Name != "web" {
		t.Errorf("chart workloads = %+v, err=%v", wl, err)
	}
	rep, err := readIacScanReport(full)
	if err != nil || rep == nil || rep.CommitSHA != "abc" {
		t.Errorf("iac report = %+v, err=%v", rep, err)
	}
}

// TestBuild_ReadStageResults_TypeMismatch pins the second decode: a slot whose bytes are
// valid JSON but the WRONG shape is an error, not a zero-value report the parent would
// then treat as a real (empty) result.
func TestBuild_ReadStageResults_TypeMismatch(t *testing.T) {
	dir := t.TempDir()
	body, err := json.Marshal(stageResult{
		PlanResult:     json.RawMessage(`"a string"`),
		VerifyReport:   json.RawMessage(`"a string"`),
		IacReport:      json.RawMessage(`"a string"`),
		DriftPosture:   json.RawMessage(`"a string"`),
		ChartWorkloads: json.RawMessage(`"a string"`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "result.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readPlanResult(dir); err == nil {
		t.Error("plan: a wrongly shaped slot must be an error")
	}
	if _, err := readVerifyReport(dir); err == nil {
		t.Error("verify: a wrongly shaped slot must be an error")
	}
	if _, err := readChartWorkloads(dir); err == nil {
		t.Error("chart: a wrongly shaped slot must be an error")
	}
	if _, err := readIacScanReport(dir); err == nil {
		t.Error("iac: a wrongly shaped slot must be an error")
	}
	if _, err := readDriftPosture(dir); err == nil {
		t.Error("drift: a wrongly shaped slot must be an error")
	}
}

// TestBuild_RunDeployDestroyDriftStages pins the shared parent/child stage entry points:
// each reconstructs its provisioner params, and a provisioner failure is written into
// result.json AND returned, so the container child and the in-process closure signal a
// failure identically.
func TestBuild_RunDeployDestroyDriftStages(t *testing.T) {
	ctx := context.Background()
	vc := &types.ProjectConfig{ProjectName: "web", Provider: types.CloudProvider("aws")}

	t.Run("deploy", func(t *testing.T) {
		dir := t.TempDir()
		p := buildDeployPayload(vc, "no-such-cloud", true, "", filepath.Join(dir, "tpl"),
			filepath.Join(dir, "cat"), "", nil, nil, "https://console.test", "job-1")
		err := runDeployStage(ctx, p, stageSecrets{}, dir, os.Stdout, os.Stderr)
		if err == nil {
			t.Fatal("an unknown provider must fail the deploy stage")
		}
		covBuildAssertStageError(t, dir, err)
	})

	t.Run("destroy", func(t *testing.T) {
		dir := t.TempDir()
		p := buildDestroyPayload(vc, "no-such-cloud", filepath.Join(dir, "tpl"),
			filepath.Join(dir, "cat"), "https://console.test", "job-1")
		err := runDestroyStage(ctx, p, stageSecrets{}, dir, os.Stdout, os.Stderr)
		if err == nil {
			t.Fatal("an unknown provider must fail the destroy stage")
		}
		covBuildAssertStageError(t, dir, err)
	})

	t.Run("drift", func(t *testing.T) {
		dir := t.TempDir()
		p := buildDriftPayload(vc, "no-such-cloud", filepath.Join(dir, "tpl"),
			filepath.Join(dir, "cat"), "https://console.test", "job-1")
		err := runDriftStage(ctx, p, stageSecrets{}, dir, os.Stdout, os.Stderr)
		if err == nil {
			t.Fatal("an unknown provider must fail the drift stage")
		}
		covBuildAssertStageError(t, dir, err)
	})
}

// covBuildAssertStageError checks result.json recorded the same failure the stage returned.
func covBuildAssertStageError(t *testing.T, workDir string, stageErr error) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(workDir, "result.json"))
	if err != nil {
		t.Fatalf("stage wrote no result.json: %v", err)
	}
	var res stageResult
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatal(err)
	}
	if res.Error == "" || res.Error != stageErr.Error() {
		t.Errorf("result.json error = %q, want %q", res.Error, stageErr.Error())
	}
}

// TestBuild_RunIacScanStage drives the bring-your-own IaC gate over a real module dir with
// a stubbed `tofu`: a module the static gate rejects is NEVER handed to tofu, a validate
// failure is recorded as a finding (OK=false) rather than a stage error, and a clean run
// reports Validated=true.
func TestBuild_RunIacScanStage(t *testing.T) {
	ctx := context.Background()

	writeModule := func(t *testing.T, body string) string {
		t.Helper()
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	const cleanModule = `variable "name" {
  type    = string
  default = "acme"
}

output "name" {
  value = var.name
}
`
	const blockedModule = `resource "null_resource" "x" {
  provisioner "local-exec" {
    command = "echo pwned"
  }
}
`

	t.Run("static gate blocks before tofu", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		work := t.TempDir()
		mod := writeModule(t, blockedModule)
		p := stageIacScanPayload{ModuleDir: mod, CommitSHA: "deadbeef", JobID: "job-1"}
		if err := runIacScanStage(ctx, p, work, os.Stdout, os.Stderr); err != nil {
			t.Fatalf("a blocked module is a report, not a stage error: %v", err)
		}
		rep, err := readIacScanReport(work)
		if err != nil || rep == nil {
			t.Fatalf("no report: %v", err)
		}
		if rep.OK || rep.Validated {
			t.Errorf("a provisioner block must fail the gate: %+v", rep)
		}
		if s.sawCall("tofu", "init") {
			t.Errorf("tofu must never run on a module the static gate rejected: %v", s.calls())
		}
	})

	t.Run("scan setup failure is a stage error", func(t *testing.T) {
		work := t.TempDir()
		p := stageIacScanPayload{ModuleDir: filepath.Join(t.TempDir(), "absent"), JobID: "job-1"}
		if err := runIacScanStage(ctx, p, work, os.Stdout, os.Stderr); err == nil ||
			!strings.Contains(err.Error(), "static scan failed") {
			t.Fatalf("want a scan-setup error, got %v", err)
		}
	})

	t.Run("tofu validate failure is a finding", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.validate", `{"format_version":"1.0","valid":false,"error_count":1,"warning_count":0,"diagnostics":[{"severity":"error","summary":"bad reference"}]}`)
		work := t.TempDir()
		mod := writeModule(t, cleanModule)
		p := stageIacScanPayload{ModuleDir: mod, CommitSHA: "deadbeef", IacVersion: "1.9.0", JobID: "job-1"}
		if err := runIacScanStage(ctx, p, work, os.Stdout, os.Stderr); err != nil {
			t.Fatalf("a validate failure is a finding, not a stage error: %v", err)
		}
		rep, err := readIacScanReport(work)
		if err != nil || rep == nil {
			t.Fatalf("no report: %v", err)
		}
		if rep.OK || rep.Validated {
			t.Errorf("validate errors must flip OK=false: %+v", rep)
		}
		var found bool
		for _, f := range rep.Findings {
			if f.Rule == "tofu-validate" && strings.Contains(f.Detail, "bad reference") {
				found = true
			}
		}
		if !found {
			t.Errorf("no tofu-validate finding: %+v", rep.Findings)
		}
	})

	t.Run("tofu init failure is a finding", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "code.init", "1")
		work := t.TempDir()
		p := stageIacScanPayload{ModuleDir: writeModule(t, cleanModule), JobID: "job-1"}
		if err := runIacScanStage(ctx, p, work, os.Stdout, os.Stderr); err != nil {
			t.Fatalf("an init failure is a finding, not a stage error: %v", err)
		}
		rep, err := readIacScanReport(work)
		if err != nil || rep == nil || rep.OK {
			t.Fatalf("want OK=false, got %+v (err=%v)", rep, err)
		}
	})

	t.Run("clean module validates", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.validate", `{"format_version":"1.0","valid":true,"error_count":0,"warning_count":0,"diagnostics":[]}`)
		work := t.TempDir()
		p := stageIacScanPayload{ModuleDir: writeModule(t, cleanModule), CommitSHA: "cafe", JobID: "job-1"}
		if err := runIacScanStage(ctx, p, work, os.Stdout, os.Stderr); err != nil {
			t.Fatalf("clean scan: %v", err)
		}
		rep, err := readIacScanReport(work)
		if err != nil || rep == nil {
			t.Fatalf("no report: %v", err)
		}
		if !rep.OK || !rep.Validated || rep.CommitSHA != "cafe" {
			t.Errorf("clean module report = %+v", rep)
		}
		if rep.Findings == nil || rep.Resources == nil || rep.Providers == nil || rep.Modules == nil || rep.Outputs == nil {
			t.Errorf("console-contract slices must be non-nil: %+v", rep)
		}
	})
}

// TestBuild_RunIacTofuValidate pins the BYO validate helper's own error ladder: an
// unusable module directory fails at tofu setup, a `tofu validate` that cannot run at all
// is distinct from one that runs and reports diagnostics, and MULTIPLE diagnostics are
// joined into one detail line rather than the first one silently winning.
func TestBuild_RunIacTofuValidate(t *testing.T) {
	ctx := context.Background()

	t.Run("setup failure", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		p := stageIacScanPayload{ModuleDir: filepath.Join(t.TempDir(), "absent"), JobID: "job-1"}
		if err := runIacTofuValidate(ctx, p, os.Stdout, os.Stderr); err == nil {
			t.Fatal("a missing module dir must fail tofu setup")
		}
	})

	t.Run("validate cannot run", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "code.validate", "1")
		p := stageIacScanPayload{ModuleDir: t.TempDir(), JobID: "job-1"}
		if err := runIacTofuValidate(ctx, p, os.Stdout, os.Stderr); err == nil ||
			!strings.Contains(err.Error(), "tofu validate:") {
			t.Fatalf("want a validate-invocation error, got %v", err)
		}
	})

	t.Run("every diagnostic is reported", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.validate", `{"format_version":"1.0","valid":false,"error_count":2,"warning_count":0,"diagnostics":[{"severity":"error","summary":"first"},{"severity":"error","summary":"second"}]}`)
		p := stageIacScanPayload{ModuleDir: t.TempDir(), JobID: "job-1"}
		err := runIacTofuValidate(ctx, p, os.Stdout, os.Stderr)
		if err == nil {
			t.Fatal("invalid config must be an error")
		}
		if !strings.Contains(err.Error(), "first") || !strings.Contains(err.Error(), "second") ||
			!strings.Contains(err.Error(), "; ") {
			t.Errorf("every diagnostic must be joined into the detail: %v", err)
		}
	})
}

// ── build.go: the kubectl seams ─────────────────────────────────────────────────

// TestBuild_KubectlSeams pins the three bounded kubectl invocations BUILD makes: a
// non-zero exit is an error with the subcommand named, stdout is trimmed and returned,
// and an applied manifest reaches kubectl on stdin.
func TestBuild_KubectlSeams(t *testing.T) {
	ctx := context.Background()
	api := &covBuildAPI{mockAPI: &mockAPI{}}
	w := covBuildRunner(t, api)
	_, errl := covBuildLoggers(t, api)

	s := covBuildNewStubs(t)
	covBuildKubectlStub(t, s, 0,
		covBuildKubeRule{match: "get job boom", stdout: "not found", exit: 1},
		covBuildKubeRule{match: "get job ok", stdout: "  Complete=True  \n", exit: 0},
		covBuildKubeRule{match: "delete job bad", stdout: "cannot delete", exit: 1},
	)

	if err := w.runKubectl(ctx, errl, "delete", "job", "good"); err != nil {
		t.Errorf("a zero-exit kubectl must succeed: %v", err)
	}
	if err := w.runKubectl(ctx, errl, "delete", "job", "bad"); err == nil ||
		!strings.Contains(err.Error(), "kubectl delete") {
		t.Errorf("want a named kubectl error, got %v", err)
	}

	out, err := w.kubectlOutput(ctx, "get", "job", "ok")
	if err != nil || out != "Complete=True" {
		t.Errorf("kubectlOutput = %q, err=%v (want trimmed stdout)", out, err)
	}
	if _, err := w.kubectlOutput(ctx, "get", "job", "boom"); err == nil {
		t.Error("a non-zero kubectl must surface an error")
	}

	if err := w.kubectlApplyManifest(ctx, namespaceManifest("alethia-build"), errl); err != nil {
		t.Errorf("apply: %v", err)
	}
	if !s.sawCall("apply", "-f", "-") {
		t.Errorf("manifest was not applied from stdin: %v", s.calls())
	}

	// Every invocation must carry the request timeout that bounds a wedged API server.
	for _, c := range s.calls() {
		if !strings.Contains(c, "--request-timeout=30s") {
			t.Errorf("unbounded kubectl call: %s", c)
		}
	}
}

// TestBuild_KubectlApplyManifest_Failure pins the apply error path: kubectl's own output
// is echoed to the job log and the failure is returned (never swallowed, which would let
// BUILD schedule a Job that was never created).
func TestBuild_KubectlApplyManifest_Failure(t *testing.T) {
	api := &covBuildAPI{mockAPI: &mockAPI{}}
	w := covBuildRunner(t, api)
	_, errl := covBuildLoggers(t, api)
	s := covBuildNewStubs(t)
	covBuildKubectlStub(t, s, 1)
	if err := w.kubectlApplyManifest(context.Background(), "kind: Namespace", errl); err == nil ||
		!strings.Contains(err.Error(), "kubectl apply") {
		t.Fatalf("want a kubectl apply error, got %v", err)
	}
}

// TestBuild_WaitForJob pins the build watcher's three terminal answers: Complete=True is
// success, Failed=True is a build failure, an unreadable Job is a watch error, and an
// already-cancelled job returns the context error without issuing a single kubectl call.
func TestBuild_WaitForJob(t *testing.T) {
	api := &covBuildAPI{mockAPI: &mockAPI{}}
	w := covBuildRunner(t, api)
	out, errl := covBuildLoggers(t, api)

	t.Run("complete", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildKubectlStub(t, s, 0, covBuildKubeRule{match: "get job", stdout: "Complete=True ", exit: 0})
		if err := w.waitForJob(context.Background(), "build-web", "ns", out, errl); err != nil {
			t.Fatalf("Complete=True must succeed: %v", err)
		}
	})

	t.Run("failed", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildKubectlStub(t, s, 0, covBuildKubeRule{match: "get job", stdout: "Failed=True ", exit: 0})
		if err := w.waitForJob(context.Background(), "build-web", "ns", out, errl); err == nil ||
			!strings.Contains(err.Error(), "kaniko exited non-zero") {
			t.Fatalf("want a build-failed error, got %v", err)
		}
	})

	t.Run("unreadable job", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildKubectlStub(t, s, 1)
		if err := w.waitForJob(context.Background(), "build-web", "ns", out, errl); err == nil ||
			!strings.Contains(err.Error(), "watch build job") {
			t.Fatalf("want a watch error, got %v", err)
		}
	})

	t.Run("cancelled before the first poll", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildKubectlStub(t, s, 0)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := w.waitForJob(ctx, "build-web", "ns", out, errl); !errors.Is(err, context.Canceled) {
			t.Fatalf("want context.Canceled, got %v", err)
		}
		if len(s.calls()) != 0 {
			t.Errorf("a cancelled job must issue no kubectl call: %v", s.calls())
		}
	})

	t.Run("in progress then complete", func(t *testing.T) {
		covBuildFastPoll(t)
		s := covBuildNewStubs(t)
		// The stub flips to Complete=True after the first read, so the poll branch runs.
		s.install(t, "kubectl", `n=0
if [ -f "$D/polls" ]; then n=$(cat "$D/polls"); fi
n=$((n+1)); printf '%s' "$n" > "$D/polls"
if [ "$n" -ge 2 ]; then echo "Complete=True "; else echo "Running=True "; fi
exit 0
`)
		if err := w.waitForJob(context.Background(), "build-web", "ns", out, errl); err != nil {
			t.Fatalf("poll then complete: %v", err)
		}
		if len(s.calls()) < 2 {
			t.Errorf("expected the watcher to poll twice: %v", s.calls())
		}
	})

	t.Run("deadline", func(t *testing.T) {
		covBuildFastPoll(t)
		covBuildShortWait(t)
		s := covBuildNewStubs(t)
		covBuildKubectlStub(t, s, 0, covBuildKubeRule{match: "get job", stdout: "Running=True ", exit: 0})
		if err := w.waitForJob(context.Background(), "build-web", "ns", out, errl); err == nil ||
			!strings.Contains(err.Error(), "did not complete within") {
			t.Fatalf("want a deadline error, got %v", err)
		}
	})
}

// covBuildFastPoll shortens the build watcher's poll interval for the lifetime of a test.
func covBuildFastPoll(t *testing.T) {
	t.Helper()
	prev := buildPollInterval
	buildPollInterval = time.Millisecond
	t.Cleanup(func() { buildPollInterval = prev })
}

// covBuildShortWait shortens the build watcher's overall deadline for one test.
func covBuildShortWait(t *testing.T) {
	t.Helper()
	prev := buildWaitTimeout
	buildWaitTimeout = time.Millisecond
	t.Cleanup(func() { buildWaitTimeout = prev })
}

// ── build.go: resolveHeadSHA ────────────────────────────────────────────────────

// covBuildGitRepo creates a one-commit git repository and returns its file:// URL. The
// file transport is a real git transport, so the runner's clone path runs unchanged with
// no network. The git identity is passed explicitly (CI has no global one).
func covBuildGitRepo(t *testing.T) (dir, fileURL string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	dir = t.TempDir()
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
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
	run("init", "-q")
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM scratch\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-q", "-m", "init")
	return dir, "file://" + dir
}

// TestBuild_ResolveHeadSHA pins the commit-pinning clone: an empty repo URL is refused
// outright, an unreachable repo is a clone error, and a reachable one yields the full
// 40-char HEAD sha the kaniko job is pinned to.
func TestBuild_ResolveHeadSHA(t *testing.T) {
	ctx := context.Background()
	api := &covBuildAPI{mockAPI: &mockAPI{}}
	w := covBuildRunner(t, api)
	_, errl := covBuildLoggers(t, api)

	if _, err := w.resolveHeadSHA(ctx, "job-1", "", errl); err == nil ||
		!strings.Contains(err.Error(), "no repo_url") {
		t.Fatalf("want a no-repo_url error, got %v", err)
	}

	if _, err := w.resolveHeadSHA(ctx, "job-1", "file://"+filepath.Join(t.TempDir(), "absent"), errl); err == nil {
		t.Error("an unreachable repo must fail the pinning clone")
	}

	_, url := covBuildGitRepo(t)
	// A git-token fetch failure must degrade to a public clone, not fail the build.
	api.gitTokenErr = errors.New("no token for this repo")
	sha, err := w.resolveHeadSHA(ctx, "job-1", url, errl)
	if err != nil {
		t.Fatalf("resolveHeadSHA: %v", err)
	}
	if len(sha) != 40 {
		t.Errorf("HEAD sha = %q, want a full 40-char sha", sha)
	}
	if got := shortSHA12(sha); got != sha[:12] {
		t.Errorf("shortSHA12 = %q", got)
	}

	// No scratch space for the pinning clone is an error, never an unpinned build.
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "absent"))
	if _, err := w.resolveHeadSHA(ctx, "job-1", url, errl); err == nil {
		t.Error("an unusable temp dir must fail the pinning clone")
	}
}

// ── build.go: executeBuild ──────────────────────────────────────────────────────

// covBuildTofuOutputs is the `tofu output -json` envelope the BUILD handler reads: the ECR
// destination map, the build-SA contract, and (for the hetzner provider used here) the
// kubeconfig ConfigureKubeconfig writes out.
func covBuildTofuOutputs(repoURL string) string {
	return fmt.Sprintf(`{
  "ecr_repository_urls_map": {"sensitive": false, "type": ["map","string"], "value": {"web": %q}},
  "ecr_build_service_account": {"sensitive": false, "type": "string", "value": "alethia-build:kaniko-builder"},
  "cluster_name": {"sensitive": false, "type": "string", "value": "cov-cluster"},
  "kubeconfig": {"sensitive": true, "type": "string", "value": "apiVersion: v1\nkind: Config\n"}
}`, repoURL)
}

// covBuildJob returns a BUILD job whose environment has one repo-sourced service.
func covBuildJob(repoURL string) *Job {
	return &Job{
		ID:      "job-build",
		JobType: "BUILD",
		ConfigSnapshot: map[string]any{
			"project_name": "web",
			"provider":     "hetzner",
			"region":       "eu-central-1",
			"services": []any{
				map[string]any{
					"name":   "web",
					"type":   "deployment",
					"source": map[string]any{"kind": "repo", "repo_url": repoURL},
				},
				map[string]any{
					"name":   "worker",
					"type":   "deployment",
					"source": map[string]any{"kind": "image", "image": "ghcr.io/acme/worker:1"},
				},
			},
		},
	}
}

// TestBuild_ExecuteBuild_Guards pins BUILD's refusals before any Job is scheduled: an
// unparseable snapshot, an environment with nothing buildable (a no-op that still posts an
// empty digest map), an unreadable state, a state with no ECR wiring, and an unsupported
// provider.
func TestBuild_ExecuteBuild_Guards(t *testing.T) {
	ctx := context.Background()

	t.Run("bad snapshot", func(t *testing.T) {
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		job := &Job{ID: "j", ConfigSnapshot: map[string]any{"totally_unknown_key": 1}}
		if err := w.executeBuild(ctx, job, "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "parse config snapshot") {
			t.Fatalf("want a snapshot parse error, got %v", err)
		}
	})

	t.Run("nothing to build", func(t *testing.T) {
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		job := &Job{ID: "job-empty", ConfigSnapshot: map[string]any{"project_name": "web"}}
		if err := w.executeBuild(ctx, job, "", nil, out, errl); err != nil {
			t.Fatalf("an environment with no repo services is a no-op: %v", err)
		}
		var posted bool
		for _, u := range api.getStatusUpdates() {
			if m, ok := u.metadata[buildResultKey].(map[string]string); ok && len(m) == 0 {
				posted = true
			}
		}
		if !posted {
			t.Errorf("an empty digest map must still be posted: %v", api.getStatusUpdates())
		}
	})

	t.Run("state token refused", func(t *testing.T) {
		api := &covBuildAPI{mockAPI: &mockAPI{}, stateTokenErr: errors.New("nope")}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeBuild(ctx, covBuildJob("https://example.test/acme/web"), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "state token") {
			t.Fatalf("want a state-token error, got %v", err)
		}
	})

	t.Run("state unreadable", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "code.init", "1")
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeBuild(ctx, covBuildJob("https://example.test/acme/web"), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "could not read environment state") {
			t.Fatalf("want a state-read error, got %v", err)
		}
	})

	t.Run("no ECR wiring", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.output", `{"cluster_name":{"sensitive":false,"type":"string","value":"c"}}`)
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeBuild(ctx, covBuildJob("https://example.test/acme/web"), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "no ecr_repository_urls_map") {
			t.Fatalf("want an ECR-wiring error, got %v", err)
		}
	})

	t.Run("unsupported provider", func(t *testing.T) {
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.output", covBuildTofuOutputs("registry.test/web"))
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		job := covBuildJob("https://example.test/acme/web")
		job.ConfigSnapshot["provider"] = ""
		if err := w.executeBuild(ctx, job, "nimbus", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "build cannot run") {
			t.Fatalf("want an unsupported-provider error, got %v", err)
		}
	})

	t.Run("cluster access unavailable", func(t *testing.T) {
		t.Setenv("KUBECONFIG", "")
		t.Setenv("HOME", t.TempDir())
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		// hetzner's ConfigureKubeconfig needs a `kubeconfig` output; without one it refuses.
		s.write(t, "out.output", `{"ecr_repository_urls_map":{"sensitive":false,"type":["map","string"],"value":{"web":"registry.test/web"}}}`)
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeBuild(ctx, covBuildJob("https://example.test/acme/web"), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "could not configure cluster access") {
			t.Fatalf("want a kubeconfig error, got %v", err)
		}
	})

	t.Run("build namespace cannot be ensured", func(t *testing.T) {
		t.Setenv("KUBECONFIG", "")
		t.Setenv("HOME", t.TempDir())
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.output", covBuildTofuOutputs("registry.test/web"))
		covBuildKubectlStub(t, s, 1)
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeBuild(ctx, covBuildJob("https://example.test/acme/web"), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "ensure build namespace") {
			t.Fatalf("want a namespace error, got %v", err)
		}
	})
}

// covBuildKubectlForBuild installs the kubectl stub a full BUILD needs: the Job reports
// Complete=True and the pod's termination message carries `terminated`.
func covBuildKubectlForBuild(t *testing.T, s *covBuildStubs, terminated, logs string) {
	t.Helper()
	covBuildKubectlStub(t, s, 0,
		covBuildKubeRule{match: "get job", stdout: "Complete=True ", exit: 0},
		covBuildKubeRule{match: "get pods", stdout: terminated, exit: 0},
		covBuildKubeRule{match: "logs", stdout: logs, exit: 0},
	)
}

// TestBuild_ExecuteBuild_Digest drives a full in-cluster build and pins the digest capture
// ladder: the pod's termination message first, the kaniko log line second, and — loudly —
// the immutable git-SHA tag last. The per-service map reaches execution_metadata under the
// W2 seam key in every case.
func TestBuild_ExecuteBuild_Digest(t *testing.T) {
	ctx := context.Background()
	const digest = "sha256:aa11bb22cc33dd44ee55ff667788990011223344556677889900aabbccddeeff"

	run := func(t *testing.T, terminated, logs string) (map[string]string, string, error) {
		t.Helper()
		t.Setenv("KUBECONFIG", "")
		t.Setenv("HOME", t.TempDir())
		_, url := covBuildGitRepo(t)
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.output", covBuildTofuOutputs("registry.test/web"))
		covBuildKubectlForBuild(t, s, terminated, logs)

		api := &covBuildAPI{mockAPI: &mockAPI{}, gitToken: "ghp_test"}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		identity := &CloudIdentity{Provider: "hetzner", AccountID: "acct-1"}
		err := w.executeBuild(ctx, covBuildJob(url), "", identity, out, errl)

		var result map[string]string
		for _, u := range api.getStatusUpdates() {
			if m, ok := u.metadata[buildResultKey].(map[string]string); ok {
				result = m
			}
		}
		return result, url, err
	}

	t.Run("termination message", func(t *testing.T) {
		result, _, err := run(t, "image pushed "+digest, "")
		if err != nil {
			t.Fatalf("build: %v", err)
		}
		if result["web"] != "registry.test/web@"+digest {
			t.Errorf("digest = %q", result["web"])
		}
		if _, built := result["worker"]; built {
			t.Error("an image-sourced service must never be built")
		}
	})

	t.Run("kaniko log fallback", func(t *testing.T) {
		result, _, err := run(t, "no digest here", "INFO pushed registry.test/web@"+digest)
		if err != nil {
			t.Fatalf("build: %v", err)
		}
		if result["web"] != "registry.test/web@"+digest {
			t.Errorf("digest = %q, want the log-derived one", result["web"])
		}
	})

	t.Run("git-sha tag fallback", func(t *testing.T) {
		result, _, err := run(t, "no digest", "no digest in the logs either")
		if err != nil {
			t.Fatalf("build: %v", err)
		}
		ref, ok := result["web"]
		if !ok || !strings.HasPrefix(ref, "registry.test/web:") {
			t.Fatalf("want an immutable git-SHA tag fallback, got %q", ref)
		}
		if len(strings.TrimPrefix(ref, "registry.test/web:")) != 40 {
			t.Errorf("the fallback tag must be the full commit sha: %q", ref)
		}
	})
}

// TestBuild_ExecuteBuild_Failures pins BUILD's fail-closed contract: a service with no
// provisioned ECR repository, an unreachable source repo, a kaniko Job that fails, and a
// digest that cannot be read at all each fail the whole job — the console must never treat
// an unbuilt service as built.
func TestBuild_ExecuteBuild_Failures(t *testing.T) {
	ctx := context.Background()

	t.Run("service has no ECR repository", func(t *testing.T) {
		t.Setenv("KUBECONFIG", "")
		t.Setenv("HOME", t.TempDir())
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.output", covBuildTofuOutputs("registry.test/other"))
		covBuildKubectlStub(t, s, 0)
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)

		// Rename the map's only entry so `web` has no destination.
		s.write(t, "out.output", `{
  "ecr_repository_urls_map": {"sensitive": false, "type": ["map","string"], "value": {"other": "registry.test/other"}},
  "kubeconfig": {"sensitive": true, "type": "string", "value": "apiVersion: v1\n"}
}`)
		if err := w.executeBuild(ctx, covBuildJob("https://example.test/acme/web"), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "no ECR repository provisioned") {
			t.Fatalf("want a missing-destination error, got %v", err)
		}
	})

	t.Run("source repo unreachable", func(t *testing.T) {
		t.Setenv("KUBECONFIG", "")
		t.Setenv("HOME", t.TempDir())
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.output", covBuildTofuOutputs("registry.test/web"))
		covBuildKubectlStub(t, s, 0)
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		job := covBuildJob("file://" + filepath.Join(t.TempDir(), "absent"))
		if err := w.executeBuild(ctx, job, "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "resolve HEAD of") {
			t.Fatalf("want a commit-pinning error, got %v", err)
		}
	})

	t.Run("kaniko job fails", func(t *testing.T) {
		t.Setenv("KUBECONFIG", "")
		t.Setenv("HOME", t.TempDir())
		_, url := covBuildGitRepo(t)
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.output", covBuildTofuOutputs("registry.test/web"))
		covBuildKubectlStub(t, s, 0,
			covBuildKubeRule{match: "get job", stdout: "Failed=True ", exit: 0},
			covBuildKubeRule{match: "logs", stdout: "ERROR building image", exit: 0},
		)
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeBuild(ctx, covBuildJob(url), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "build web:") {
			t.Fatalf("want a per-service build error, got %v", err)
		}
		if !s.sawCall("logs", "job/build-web") {
			t.Errorf("the kaniko log tail must be surfaced: %v", s.calls())
		}
	})

	t.Run("digest unreadable", func(t *testing.T) {
		t.Setenv("KUBECONFIG", "")
		t.Setenv("HOME", t.TempDir())
		_, url := covBuildGitRepo(t)
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.output", covBuildTofuOutputs("registry.test/web"))
		covBuildKubectlStub(t, s, 0,
			covBuildKubeRule{match: "get job", stdout: "Complete=True ", exit: 0},
			covBuildKubeRule{match: "get pods", stdout: "", exit: 1},
			covBuildKubeRule{match: "logs", stdout: "", exit: 1},
		)
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeBuild(ctx, covBuildJob(url), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "read build digest") {
			t.Fatalf("want a digest-read error, got %v", err)
		}
	})
}

// TestBuild_ExecuteBuild_RenderAndApply pins the two remaining per-service failures: a
// service whose name cannot render a DNS-1123 Job is refused before anything is applied,
// and a kaniko Job that kubectl rejects fails the build rather than leaving the watcher
// polling for a Job that was never created.
func TestBuild_ExecuteBuild_RenderAndApply(t *testing.T) {
	ctx := context.Background()

	t.Run("unrenderable service name", func(t *testing.T) {
		t.Setenv("KUBECONFIG", "")
		t.Setenv("HOME", t.TempDir())
		_, url := covBuildGitRepo(t)
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.output", `{
  "ecr_repository_urls_map": {"sensitive": false, "type": ["map","string"], "value": {"___": "registry.test/web"}},
  "kubeconfig": {"sensitive": true, "type": "string", "value": "apiVersion: v1\n"}
}`)
		covBuildKubectlStub(t, s, 0)
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)

		job := covBuildJob(url)
		job.ConfigSnapshot["services"] = []any{
			map[string]any{"name": "___", "type": "deployment",
				"source": map[string]any{"kind": "repo", "repo_url": url}},
		}
		if err := w.executeBuild(ctx, job, "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "render kaniko job") {
			t.Fatalf("want a render error, got %v", err)
		}
	})

	t.Run("kaniko job rejected by the API server", func(t *testing.T) {
		t.Setenv("KUBECONFIG", "")
		t.Setenv("HOME", t.TempDir())
		_, url := covBuildGitRepo(t)
		s := covBuildNewStubs(t)
		covBuildTofuStub(t, s)
		s.write(t, "out.output", covBuildTofuOutputs("registry.test/web"))
		// The namespace apply (the first) succeeds; the kaniko Job apply (the second) fails.
		s.install(t, "kubectl", `case "$1" in
  apply)
    n=0
    if [ -f "$D/applies" ]; then n=$(cat "$D/applies"); fi
    n=$((n+1)); printf '%s' "$n" > "$D/applies"
    if [ "$n" -ge 2 ]; then echo "admission webhook denied the request"; exit 1; fi
    exit 0
    ;;
esac
exit 0
`)
		api := &covBuildAPI{mockAPI: &mockAPI{}}
		w := covBuildRunner(t, api)
		out, errl := covBuildLoggers(t, api)
		if err := w.executeBuild(ctx, covBuildJob(url), "", nil, out, errl); err == nil ||
			!strings.Contains(err.Error(), "apply kaniko job") {
			t.Fatalf("want a kaniko-apply error, got %v", err)
		}
	})
}

// TestBuild_ShortID pins the panic-safe id abbreviator: a shorter-than-n id is returned
// whole (never a slice-bounds panic in a log line) and a negative n is a no-op.
func TestBuild_ShortID(t *testing.T) {
	if got := shortID("abc", 8); got != "abc" {
		t.Errorf("shortID(short) = %q", got)
	}
	if got := shortID("abcdefghij", 4); got != "abcd" {
		t.Errorf("shortID = %q", got)
	}
	if got := shortID("abc", -1); got != "abc" {
		t.Errorf("shortID(negative n) = %q", got)
	}
}

// TestBuild_ExtractOutputStr pins the tofu string-output unwrapping: the {value: …}
// envelope, a bare string, a missing key and a non-string value all resolve without a
// panic — a wrongly typed output must degrade to "" (which splitBuildServiceAccount then
// turns into the documented defaults), never crash the job.
func TestBuild_ExtractOutputStr(t *testing.T) {
	outputs := map[string]interface{}{
		"enveloped": map[string]interface{}{"value": "alethia-build:kaniko-builder"},
		"bare":      "plain",
		"wrong":     42,
		"nested":    map[string]interface{}{"no_value_key": 1},
	}
	if got := extractOutputStr(outputs, "enveloped"); got != "alethia-build:kaniko-builder" {
		t.Errorf("enveloped = %q", got)
	}
	if got := extractOutputStr(outputs, "bare"); got != "plain" {
		t.Errorf("bare = %q", got)
	}
	for _, k := range []string{"wrong", "nested", "absent"} {
		if got := extractOutputStr(outputs, k); got != "" {
			t.Errorf("extractOutputStr(%q) = %q, want empty", k, got)
		}
	}
	// A non-map output for a map key, and a map with non-string members.
	if got := extractOutputStringMap(map[string]interface{}{"k": "not a map"}, "k"); got != nil {
		t.Errorf("non-map output = %v, want nil", got)
	}
	got := extractOutputStringMap(map[string]interface{}{
		"k": map[string]interface{}{"value": map[string]interface{}{"a": "x", "b": 1, "c": ""}},
	}, "k")
	if len(got) != 1 || got["a"] != "x" {
		t.Errorf("non-string / empty members must be dropped: %v", got)
	}
}
