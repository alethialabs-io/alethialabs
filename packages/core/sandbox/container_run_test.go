// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package sandbox

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Coverage for the container backend's construction, argv-independent helpers, and the
// full Run path — the parts the docker canaries in container_docker_test.go can only
// reach when docker is present. A stub "runtime CLI" (a shell script standing in for
// `docker|podman`) drives Run end to end with no container engine, so the stage.json
// write, the result.json read-back and the exit-code fallback are all exercised in a
// plain `go test`.

// stubRuntime writes an executable shell script that impersonates the container runtime
// CLI: it recovers the workdir from the `ALETHIA_STAGE_WORKDIR=` argv element the backend
// emits, optionally writes result.json there, then exits with the given code. It returns
// the script's absolute path for use as Container.Runtime.
func stubRuntime(t *testing.T, resultJSON string, exitCode int) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "stub-runtime.sh")
	var write string
	if resultJSON != "" {
		write = "printf '%s' " + shellQuote(resultJSON) + ` > "$wd/result.json"` + "\n"
	}
	script := "#!/bin/sh\n" +
		"wd=\n" +
		"for a in \"$@\"; do\n" +
		"  case \"$a\" in\n" +
		"    ALETHIA_STAGE_WORKDIR=*) wd=${a#ALETHIA_STAGE_WORKDIR=} ;;\n" +
		"  esac\n" +
		"done\n" +
		"[ -n \"$wd\" ] || exit 90\n" +
		write +
		"exit " + itoa(exitCode) + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write stub runtime: %v", err)
	}
	return path
}

// shellQuote single-quotes s for safe interpolation into the stub script.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// itoa renders a small non-negative int without pulling in strconv at the call site.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// TestNewContainerFromEnv covers the ALETHIA_SANDBOX_* projection: the docker default,
// each override, and the two refusals (runtime absent from PATH, no derivable image).
func TestNewContainerFromEnv(t *testing.T) {
	cases := []struct {
		name     string
		env      map[string]string
		operator string
		wantErr  string
		want     Container
	}{
		{
			name:     "defaults to docker + the baked self image",
			env:      map[string]string{"ALETHIA_RUNNER_SELF_IMAGE": "ghcr.io/alethia/runner:1.2.3"},
			operator: "self",
			want: Container{
				Runtime: "docker", Image: "ghcr.io/alethia/runner:1.2.3", Operator: "self",
				PidsLimit: 512, MemLimit: "2g",
			},
		},
		{
			name: "every override applied",
			env: map[string]string{
				"ALETHIA_SANDBOX_RUNTIME":         "sh",
				"ALETHIA_SANDBOX_IMAGE":           "registry.local/runner:pin",
				"ALETHIA_SANDBOX_EGRESS_ENFORCED": "yes",
				"ALETHIA_SANDBOX_NETWORK":         "alethia-egress",
				"ALETHIA_SANDBOX_MEMORY":          "8g",
			},
			operator: "managed",
			want: Container{
				Runtime: "sh", Image: "registry.local/runner:pin", Operator: "managed",
				EgressEnforced: true, Network: "alethia-egress", PidsLimit: 512, MemLimit: "8g",
			},
		},
		{
			name:     "sandbox image overrides the baked ref",
			env:      map[string]string{"ALETHIA_SANDBOX_IMAGE": "override:1", "ALETHIA_RUNNER_SELF_IMAGE": "baked:1"},
			operator: "self",
			want: Container{
				Runtime: "docker", Image: "override:1", Operator: "self",
				PidsLimit: 512, MemLimit: "2g",
			},
		},
		{
			name:     "runtime missing from PATH refuses",
			env:      map[string]string{"ALETHIA_SANDBOX_RUNTIME": "definitely-not-a-real-container-cli"},
			operator: "self",
			wantErr:  "not found on PATH",
		},
		{
			name:     "no derivable image refuses and names both remedies",
			env:      map[string]string{},
			operator: "self",
			wantErr:  "sandbox image is required",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Neutralize every input this constructor reads, then apply the case's env.
			for _, k := range []string{
				"ALETHIA_SANDBOX_RUNTIME", "ALETHIA_SANDBOX_IMAGE", "ALETHIA_SANDBOX_EGRESS_ENFORCED",
				"ALETHIA_SANDBOX_NETWORK", "ALETHIA_SANDBOX_MEMORY",
				"ALETHIA_RUNNER_IMAGE", "ALETHIA_RUNNER_SELF_IMAGE",
			} {
				t.Setenv(k, "")
			}
			for k, v := range tc.env {
				t.Setenv(k, v)
			}

			got, err := NewContainerFromEnv(tc.operator)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want one containing %q", err, tc.wantErr)
				}
				if got != (Container{}) {
					t.Errorf("a refusal must return the zero Container, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("Container = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// TestContainerName pins the per-job container name: the fixed prefix plus a jobID with
// every character outside [A-Za-z0-9_-] mapped to '-', so a hostile job id can never
// inject an extra runtime flag or a path.
func TestContainerName(t *testing.T) {
	cases := []struct {
		name  string
		jobID string
		want  string
	}{
		{"plain uuid", "9f1c2d3e-4a5b", "alethia-stage-9f1c2d3e-4a5b"},
		{"alphanumeric and underscore kept", "Job_42", "alethia-stage-Job_42"},
		{"slashes and spaces sanitized", "a/b c", "alethia-stage-a-b-c"},
		{"shell metacharacters sanitized", "j;rm -rf $(x)", "alethia-stage-j-rm--rf---x-"},
		{"unicode sanitized", "jöb", "alethia-stage-j-b"},
		{"empty id still yields the prefix", "", "alethia-stage-"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := containerName(tc.jobID); got != tc.want {
				t.Errorf("containerName(%q) = %q, want %q", tc.jobID, got, tc.want)
			}
		})
	}
}

// TestCredMountDirs_Edges covers the paths the happy-path test never reaches: a value
// whose parent is the filesystem root or the current directory is skipped rather than
// bind-mounted, an unset key contributes nothing, and duplicates collapse.
func TestCredMountDirs_Edges(t *testing.T) {
	cases := []struct {
		name     string
		childEnv []string
		workDir  string
		want     []string
	}{
		{
			name:     "root and relative parents are refused",
			childEnv: []string{"AWS_CONFIG_FILE=/config", "GOOGLE_APPLICATION_CREDENTIALS=wif.json"},
			workDir:  "/work/job-1",
			want:     nil,
		},
		{
			name:     "empty values contribute nothing",
			childEnv: []string{"AWS_CONFIG_FILE=", "ARM_OIDC_TOKEN_FILE_PATH=", "PATH=/usr/bin"},
			workDir:  "/work/job-1",
			want:     nil,
		},
		{
			name: "two keys in one dir collapse to a single mount",
			childEnv: []string{
				"AWS_CONFIG_FILE=/creds/aws",
				"ALIBABA_CLOUD_OIDC_TOKEN_FILE=/creds/ali",
			},
			workDir: "/work/job-1",
			want:    []string{"/creds"},
		},
		{
			name:     "a sibling prefix of the workdir is NOT treated as inside it",
			childEnv: []string{"AWS_CONFIG_FILE=/work/job-10/config"},
			workDir:  "/work/job-1",
			want:     []string{"/work/job-10"},
		},
		{
			name:     "the workdir itself is already covered by the RW mount",
			childEnv: []string{"AWS_CONFIG_FILE=/work/job-1/config"},
			workDir:  "/work/job-1",
			want:     nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := credMountDirs(tc.childEnv, tc.workDir)
			if len(got) != len(tc.want) {
				t.Fatalf("credMountDirs = %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("credMountDirs = %v, want %v", got, tc.want)
				}
			}
		})
	}
}

// TestAssertNoSecrets_MalformedEntries pins that an env entry with no usable key (no '='
// at all, or a leading '=') is skipped rather than panicking on a bad slice index.
func TestAssertNoSecrets_MalformedEntries(t *testing.T) {
	env := []string{"NO_EQUALS_SIGN", "=leading-equals", "PATH=/usr/bin"}
	if err := assertNoSecrets(env); err != nil {
		t.Fatalf("malformed entries must be skipped, got %v", err)
	}
	if err := assertNoSecrets([]string{"NO_EQUALS_SIGN", "ALETHIA_RUNNER_TOKEN=x"}); err == nil {
		t.Fatal("a malformed entry must not stop the scan short of a real secret")
	}
}

// TestBuildChildEnv_StageSecretRail covers the ALETHIA_STAGE_* rail additions the
// allowlist test does not: the add-on secret map (#640) and the Talos admin config
// (#1389) cross, and nothing else ALETHIA_-prefixed does.
func TestBuildChildEnv_StageSecretRail(t *testing.T) {
	parent := []string{
		`ALETHIA_STAGE_ADDON_SECRETS={"addon-1":{"apiKey":"plain"}}`,
		"ALETHIA_STAGE_TALOS_CONFIG=talos-yaml",
		"ALETHIA_STAGE_NOT_A_REAL_KEY=nope",
		"ALETHIA_RECEIPT_SIGNING_KEY=priv",
		"PATH=/usr/bin",
	}
	child := buildChildEnv(parent, "/work/job-1")
	if err := assertNoSecrets(child); err != nil {
		t.Fatalf("assertNoSecrets on buildChildEnv output: %v", err)
	}
	if !envHas(child, `ALETHIA_STAGE_ADDON_SECRETS={"addon-1":{"apiKey":"plain"}}`) {
		t.Error("add-on secret map must cross on the ALETHIA_STAGE_* rail")
	}
	if !envHas(child, "ALETHIA_STAGE_TALOS_CONFIG=talos-yaml") {
		t.Error("talosconfig must cross on the ALETHIA_STAGE_* rail")
	}
	for _, k := range []string{"ALETHIA_STAGE_NOT_A_REAL_KEY", "ALETHIA_RECEIPT_SIGNING_KEY"} {
		if envHasKey(child, k) {
			t.Errorf("key %q must not cross: only the enumerated stage keys do", k)
		}
	}
	// The projection is sorted so the argv is byte-stable across runs.
	for i := 1; i < len(child); i++ {
		if child[i-1] > child[i] {
			t.Fatalf("child env must be sorted for a stable argv: %v", child)
		}
	}
}

// TestReadStageError covers the result.json read-back: absent file, unparsable JSON, a
// failed stage and a successful one.
func TestReadStageError(t *testing.T) {
	cases := []struct {
		name     string
		contents string // "" means: write no file at all
		want     string
		wantErr  bool
	}{
		{name: "missing file", wantErr: true},
		{name: "unparsable json", contents: "{not json", wantErr: true},
		{name: "stage failed", contents: `{"error":"tofu apply failed"}`, want: "tofu apply failed"},
		{name: "stage succeeded", contents: `{"error":""}`},
		{name: "no error field", contents: `{"plan_result":{}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if tc.contents != "" {
				if err := os.WriteFile(filepath.Join(dir, "result.json"), []byte(tc.contents), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			got, err := readStageError(dir)
			if (err != nil) != tc.wantErr {
				t.Fatalf("readStageError err = %v, wantErr = %v", err, tc.wantErr)
			}
			if got != tc.want {
				t.Errorf("readStageError = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestEnvTrue covers the truthy vocabulary the sandbox gates read.
func TestEnvTrue(t *testing.T) {
	cases := []struct {
		value string
		want  bool
	}{
		{"1", true}, {"true", true}, {"TRUE", true}, {"Yes", true}, {"on", true},
		{" 1 ", true}, {"", false}, {"0", false}, {"false", false}, {"enabled", false},
	}
	for _, tc := range cases {
		t.Run("value="+tc.value, func(t *testing.T) {
			t.Setenv("ALETHIA_TEST_ENV_TRUE", tc.value)
			if got := envTrue("ALETHIA_TEST_ENV_TRUE"); got != tc.want {
				t.Errorf("envTrue(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

// TestEnvOr covers the defaulting helper: set, blank and whitespace-only all resolve
// predictably.
func TestEnvOr(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  string
	}{
		{"set", "4g", "4g"},
		{"trimmed", "  4g  ", "4g"},
		{"empty falls back", "", "2g"},
		{"whitespace only falls back", "   ", "2g"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ALETHIA_TEST_ENV_OR", tc.value)
			if got := envOr("ALETHIA_TEST_ENV_OR", "2g"); got != tc.want {
				t.Errorf("envOr = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestContainerRun_StubRuntime drives Run end to end against a stub runtime CLI: the
// stage is serialized to stage.json (0600), the result.json error wins over the process
// exit status, and a non-zero exit with no result surfaces as a runtime failure.
func TestContainerRun_StubRuntime(t *testing.T) {
	cases := []struct {
		name       string
		resultJSON string
		exitCode   int
		wantErr    string
	}{
		{
			name:       "stage succeeded",
			resultJSON: `{"error":""}`,
		},
		{
			name:       "stage error is surfaced verbatim",
			resultJSON: `{"error":"tofu apply failed: quota exceeded"}`,
			exitCode:   1,
			wantErr:    `stage "deploy" failed: tofu apply failed: quota exceeded`,
		},
		{
			name:     "runtime failure with no result falls back to the exit status",
			exitCode: 7,
			wantErr:  "run failed",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			workDir := t.TempDir()
			c := Container{
				Runtime: stubRuntime(t, tc.resultJSON, tc.exitCode),
				Image:   "registry.local/runner:test", Operator: "self",
				PidsLimit: 512, MemLimit: "2g",
			}
			spec := Spec{
				Kind: "deploy", JobID: "job-stub", WorkDir: workDir,
				Stage: &Stage{Kind: StageDeploy, Payload: []byte(`{"provider":"aws"}`)},
			}

			err := c.Run(context.Background(), spec, nil)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want one containing %q", err, tc.wantErr)
			}

			// stage.json is the child's only input and carries the serialized work; it must
			// exist and be owner-only.
			info, serr := os.Stat(filepath.Join(workDir, "stage.json"))
			if serr != nil {
				t.Fatalf("stage.json was not written: %v", serr)
			}
			if perm := info.Mode().Perm(); perm != 0o600 {
				t.Errorf("stage.json mode = %O, want 0600", perm)
			}
			raw, rerr := os.ReadFile(filepath.Join(workDir, "stage.json"))
			if rerr != nil {
				t.Fatal(rerr)
			}
			if !strings.Contains(string(raw), `"kind":"deploy"`) {
				t.Errorf("stage.json = %s, want the serialized deploy stage", raw)
			}
		})
	}
}

// TestContainerRun_CancelledContext pins that an already-cancelled context never starts
// the runtime CLI and surfaces the cancellation instead of a silent success.
func TestContainerRun_CancelledContext(t *testing.T) {
	workDir := t.TempDir()
	c := Container{Runtime: stubRuntime(t, `{"error":""}`, 0), Image: "img", Operator: "self"}
	spec := Spec{
		Kind: "deploy", JobID: "job-cancel", WorkDir: workDir,
		Stage: &Stage{Kind: StageDeploy, Payload: []byte("{}")},
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := c.Run(ctx, spec, nil)
	if err == nil {
		t.Fatal("a cancelled context must not report success")
	}
	if _, serr := os.Stat(filepath.Join(workDir, "result.json")); serr == nil {
		t.Error("the stub runtime must not have run under a cancelled context")
	}
}

// TestContainerRun_MidFlightCancel pins the graceful-cancel wiring: a cancel while the
// runtime CLI is in flight signals its process group (SIGINT, escalating to SIGKILL after
// the grace window) and Run surfaces the interruption instead of reporting success. The
// grace window is pinned to 0 so the escalation is immediate and the test is bounded.
func TestContainerRun_MidFlightCancel(t *testing.T) {
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "0")

	workDir := t.TempDir()
	started := filepath.Join(workDir, "started")
	dir := t.TempDir()
	runtimePath := filepath.Join(dir, "sleepy-runtime.sh")
	script := "#!/bin/sh\n" +
		"trap '' INT\n" + // ignore the graceful signal so the SIGKILL escalation is what stops us
		"touch " + shellQuote(started) + "\n" +
		"sleep 60\n"
	if err := os.WriteFile(runtimePath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	c := Container{Runtime: runtimePath, Image: "img", Operator: "self"}
	spec := Spec{
		Kind: "deploy", JobID: "job-cancel-midflight", WorkDir: workDir,
		Stage: &Stage{Kind: StageDeploy, Payload: []byte("{}")},
	}
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() { done <- c.Run(ctx, spec, nil) }()

	// Wait for the stub to actually be running before cancelling, so the cancel is
	// mid-flight rather than pre-start.
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatal("stub runtime never started")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a mid-flight cancel must not report success")
		}
	case <-time.After(60 * time.Second):
		t.Fatal("Run did not return after the cancel escalation")
	}
}

// TestContainerRun_RefusesUnwritableWorkDir pins the stage.json write failure path: a
// workdir that does not exist is a refusal, never a silent run.
func TestContainerRun_RefusesUnwritableWorkDir(t *testing.T) {
	c := Container{Runtime: stubRuntime(t, `{"error":""}`, 0), Image: "img", Operator: "self"}
	spec := Spec{
		Kind: "deploy", JobID: "job-nodir", WorkDir: filepath.Join(t.TempDir(), "does-not-exist"),
		Stage: &Stage{Kind: StageDeploy, Payload: []byte("{}")},
	}
	err := c.Run(context.Background(), spec, nil)
	if err == nil || !strings.Contains(err.Error(), "write stage.json") {
		t.Fatalf("err = %v, want a stage.json write refusal", err)
	}
}

// TestContainerRun_UnmarshalableStageRefuses pins the marshal-failure path: a payload
// that cannot be serialized must refuse before any container starts.
func TestContainerRun_UnmarshalableStageRefuses(t *testing.T) {
	workDir := t.TempDir()
	c := Container{Runtime: stubRuntime(t, `{"error":""}`, 0), Image: "img", Operator: "self"}
	spec := Spec{
		Kind: "deploy", JobID: "job-badstage", WorkDir: workDir,
		// json.RawMessage must hold valid JSON; invalid bytes fail at marshal time.
		Stage: &Stage{Kind: StageDeploy, Payload: []byte("{not json")},
	}
	err := c.Run(context.Background(), spec, nil)
	if err == nil || !strings.Contains(err.Error(), "marshal stage") {
		t.Fatalf("err = %v, want a marshal refusal", err)
	}
	if _, serr := os.Stat(filepath.Join(workDir, "stage.json")); serr == nil {
		t.Error("stage.json must not be written when the stage cannot be serialized")
	}
}

// TestCancelGracePeriod_NegativeAndHuge covers the parse guards the happy-path test does
// not reach: a negative value is rejected in favour of the safe default.
func TestCancelGracePeriod_NegativeAndHuge(t *testing.T) {
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "-5")
	if got := cancelGracePeriod(); got != DefaultCancelGracePeriod {
		t.Errorf("grace = %v, want the default %v for a negative value", got, DefaultCancelGracePeriod)
	}
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "  30  ")
	if got := cancelGracePeriod(); got != 30*time.Second {
		t.Errorf("grace = %v, want 30s (surrounding whitespace trimmed)", got)
	}
	t.Setenv("ALETHIA_CANCEL_GRACE_SECONDS", "")
	if got := cancelGracePeriod(); got != DefaultCancelGracePeriod {
		t.Errorf("grace = %v, want the default %v for an unset value", got, DefaultCancelGracePeriod)
	}
}

// TestContainerRunFailsWithoutResultJSON is the #2033 regression: the runtime CLI
// exiting 0 without the child ever writing result.json must be a FAILURE, not a
// success — "true" stands in for an image whose entrypoint exits clean without
// dispatching the stage (wrong ALETHIA_SANDBOX_IMAGE, an older image that ignores
// ALETHIA_RUNNER_EXEC_STAGE). Before the fix Run returned nil and the job posted
// COMPLETED with no tofu run, no state and no cloud resources.
func TestContainerRunFailsWithoutResultJSON(t *testing.T) {
	workDir := t.TempDir()
	c := Container{Runtime: "true", Image: "img", Operator: "self"}
	spec := Spec{
		Kind: "deploy", JobID: "job-noresult", WorkDir: workDir,
		Stage: &Stage{Kind: StageDeploy, Payload: []byte("{}")},
	}
	err := c.Run(context.Background(), spec, func(context.Context) error { return nil })
	if _, serr := os.Stat(filepath.Join(workDir, "result.json")); serr == nil {
		t.Fatal("precondition: result.json must not exist")
	}
	if err == nil {
		t.Fatal("Run reported SUCCESS although the stage produced no result.json (nothing ran)")
	}
	if !strings.Contains(err.Error(), "result.json") {
		t.Errorf("error %q should name the missing proof", err)
	}
}

// TestBuildArgsKeepsSecretValuesOffArgv is the #2041 regression: a secret-valued
// env key must cross to the runtime as `--env KEY` (name only), never
// `--env KEY=VALUE`, so the plaintext never lands on the world-readable process
// table (/proc/<pid>/cmdline, ps auxww, and docker inspect for the docker runtime).
func TestBuildArgsKeepsSecretValuesOffArgv(t *testing.T) {
	workDir := t.TempDir()
	parent := []string{
		"PATH=/usr/bin",
		"TF_HTTP_USERNAME=job-user",
		"TF_HTTP_PASSWORD=STATE-TOKEN-CANARY",
		"HCLOUD_TOKEN=HCLOUD-CANARY",
		"DIGITALOCEAN_ACCESS_TOKEN=DO-CANARY",
		"CIVO_TOKEN=CIVO-CANARY",
		"ALETHIA_STAGE_GIT_TOKEN=GHP-CANARY",
		"ALETHIA_STAGE_GIT_TOKENS=GHP-MAP-CANARY",
		`ALETHIA_STAGE_ADDON_SECRETS={"a":{"k":"ADDON-PLAINTEXT-CANARY"}}`,
		"ALETHIA_STAGE_TALOS_CONFIG=TALOS-ADMIN-CANARY",
	}
	childEnv := buildChildEnv(parent, workDir)
	c := Container{Runtime: "docker", Image: "img", Operator: "self"}
	args := c.buildArgs(Spec{Kind: "deploy", JobID: "j", WorkDir: workDir}, childEnv)
	joined := strings.Join(args, " ")

	for _, canary := range []string{
		"STATE-TOKEN-CANARY", "HCLOUD-CANARY", "DO-CANARY", "CIVO-CANARY",
		"GHP-CANARY", "GHP-MAP-CANARY", "ADDON-PLAINTEXT-CANARY", "TALOS-ADMIN-CANARY",
	} {
		if strings.Contains(joined, canary) {
			t.Errorf("secret %q appears verbatim in the runtime argv", canary)
		}
	}
	// The keys must still cross by NAME so the runtime inherits the value from cmd.Env.
	for _, key := range []string{"TF_HTTP_PASSWORD", "HCLOUD_TOKEN", "ALETHIA_STAGE_TALOS_CONFIG"} {
		if !argvHasEnvName(args, key) {
			t.Errorf("secret key %q was not passed by name (--env %s) — the runtime cannot inherit it", key, key)
		}
	}
	// A non-secret key keeps its value on the argv (nothing sensitive, exact value).
	if !strings.Contains(joined, "TF_HTTP_USERNAME=job-user") {
		t.Error("non-secret TF_HTTP_USERNAME should keep --env KEY=VALUE")
	}
	// The values ride on cmd.Env instead, so the runtime actually forwards them.
	pairs := secretEnvPairs(childEnv)
	if !containsPair(pairs, "TF_HTTP_PASSWORD=STATE-TOKEN-CANARY") {
		t.Errorf("secretEnvPairs = %v, want the state-token pair for cmd.Env inheritance", pairs)
	}
	if containsPrefix(pairs, "TF_HTTP_USERNAME=") {
		t.Error("secretEnvPairs must not carry the non-secret TF_HTTP_USERNAME")
	}
}

func argvHasEnvName(args []string, name string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--env" && args[i+1] == name {
			return true
		}
	}
	return false
}

func containsPair(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

func containsPrefix(xs []string, prefix string) bool {
	for _, x := range xs {
		if strings.HasPrefix(x, prefix) {
			return true
		}
	}
	return false
}
