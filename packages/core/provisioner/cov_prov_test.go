// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Day-2 spine coverage — drift detection, state import and teardown.
//
// These three entry points (RunDriftDetection, RunStateImport, RunDestroy/RunDestroyPlan)
// share one shape: rebuild the tofu workdir, wire the console HTTP state proxy, drive the
// `tofu` CLI, interpret what came back. Everything but the last step is already hermetic;
// the `tofu` child was the only reason the happy paths were unreachable off a cloud.
//
// A RECORDING `tofu` stand-in on PATH closes that. packages/core/tofu's ensureBinary
// prefers a `tofu` already on PATH, so a shell script that logs its argv and answers each
// subcommand with canned JSON drives the real spine with no OpenTofu, no network and no
// cloud account. That is the same technique packages/core/tofu/exec_args_test.go uses for
// the wrappers; here it is applied one layer up, to the provisioner flows that call them.

package provisioner

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ─────────────────────────── the recording `tofu` stand-in ───────────────────────────

// provTofuScript is a `tofu` stand-in for the provisioner flows. It appends its argv to
// LOGPATH and answers each subcommand with the canned JSON that subcommand's parser wants:
//
//	version  the terraform-exec version probe (must parse or every wrapper errors)
//	plan     exit 2 — `-detailed-exitcode` for "there are changes", not a failure
//	show     a plan read when a trailing plan file is present, a state read otherwise
//	output   one sensitive + one plain output, so the drift outputs tail has something
//	         real to decode
//
// STATEADDR is substituted with the address the state read reports; it is what makes the
// "import verified" vs "import silently no-op'd" branch selectable from a test.
const provTofuScript = `#!/bin/sh
printf '%s\n' "$*" >> "LOGPATH"
case "$1" in
  version)
    echo '{"terraform_version":"1.9.0","platform":"linux_amd64","provider_selections":{},"terraform_outdated":false}'
    ;;
  output)
    echo '{"kubeconfig":{"sensitive":true,"type":"string","value":"PROV-FAKE-KUBECONFIG"},"cluster_name":{"sensitive":false,"type":"string","value":"prov-cluster"}}'
    ;;
  plan)
    exit 2
    ;;
  show)
    if [ -n "$4" ]; then
      echo '{"format_version":"1.2","terraform_version":"1.9.0","resource_changes":[{"address":"terraform_data.probe","mode":"managed","type":"terraform_data","name":"probe","provider_name":"terraform.io/builtin/terraform","change":{"actions":["update"],"before":{},"after":{}}}]}'
    else
      echo '{"format_version":"1.0","terraform_version":"1.9.0","values":{"root_module":{"resources":[{"address":"STATEADDR","mode":"managed","type":"terraform_data","name":"probe","provider_name":"terraform.io/builtin/terraform","values":{}}]}}}'
    fi
    ;;
esac
exit 0
`

// provFailScript is the same stand-in with one subcommand wired to fail, so the wrapper's
// error branch (which is what the provisioner flows wrap and report) is reachable.
const provFailScript = `#!/bin/sh
printf '%s\n' "$*" >> "LOGPATH"
case "$1" in
  version)
    echo '{"terraform_version":"1.9.0","platform":"linux_amd64","provider_selections":{},"terraform_outdated":false}'
    ;;
  FAILCMD)
    echo 'the fake tofu was told to fail this subcommand' >&2
    exit 1
    ;;
  output)
    echo '{}'
    ;;
  plan)
    exit 2
    ;;
  show)
    echo '{"format_version":"1.0","terraform_version":"1.9.0","values":{"root_module":{"resources":[]}}}'
    ;;
esac
exit 0
`

// provFakeTofu puts a `tofu` stand-in first on PATH and isolates HOME, so the flow under
// test can never reach a real OpenTofu, a real plugin cache or a developer's credentials.
// It returns a reader for the argv the child was invoked with.
//
// PATH is the seam because packages/core/tofu's lookPath hook is package-private; PATH is
// what ensureBinary consults and it is settable from here. binDir is PREPENDED, so the fake
// always wins the lookup (this Mac has OpenTofu installed, CI does not — the fake makes both
// behave the same) while `git` stays reachable for the BYO IaC fixtures.
func provFakeTofu(t *testing.T, script string) func() string {
	t.Helper()
	binDir := t.TempDir()
	logPath := filepath.Join(binDir, "argv.log")
	body := strings.ReplaceAll(script, "LOGPATH", logPath)
	if err := os.WriteFile(filepath.Join(binDir, "tofu"), []byte(body), 0o755); err != nil {
		t.Fatalf("write fake tofu: %v", err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("TF_PLUGIN_CACHE_DIR", filepath.Join(home, "plugin-cache"))

	if _, err := exec.LookPath("tofu"); err != nil {
		t.Fatalf("the fake tofu is not resolvable on PATH: %v", err)
	}
	return func() string {
		data, err := os.ReadFile(logPath)
		if err != nil {
			return ""
		}
		return string(data)
	}
}

// provTofuAt returns provTofuScript with the state read reporting `addr` as the single
// managed resource.
func provTofuAt(addr string) string {
	return strings.ReplaceAll(provTofuScript, "STATEADDR", addr)
}

// provFailingTofu returns provFailScript with `cmd` wired to exit non-zero.
func provFailingTofu(cmd string) string {
	return strings.ReplaceAll(provFailScript, "FAILCMD", cmd)
}

// ─────────────────────────── shared fixtures ───────────────────────────

// provTemplates writes a minimal template dir. copyDir is the only thing that reads it —
// the fake `tofu` never parses HCL — so one file is enough to prove the copy happened.
func provTemplates(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte("# provisioner coverage fixture\n"), 0o644); err != nil {
		t.Fatalf("write template: %v", err)
	}
	return dir
}

// provConfig is a minimal ProjectConfig: no connectors, so categories.Compose composes
// nothing, and a pinned IacVersion so the fake binary is asked for a fixed version.
func provConfig() *types.ProjectConfig {
	return &types.ProjectConfig{
		ID:               "cov-prov",
		ProjectName:      "covprov",
		EnvironmentStage: types.EnvironmentStage("dev"),
		Region:           "us-east-1",
		IacVersion:       "1.9.0",
	}
}

// provBackend points a flow at an in-test state proxy. The fake `tofu` never calls it, but
// every flow requires the config and writes its backend.hcl from it.
func provBackend(t *testing.T) *cloud.HTTPBackendConfig {
	t.Helper()
	srv := startTestStateServer(t)
	return &cloud.HTTPBackendConfig{ConsoleURL: srv.URL, JobID: "cov-prov", Token: "cov-token"}
}

// provAPIClient builds an api.Client pointed at an in-test console. The client resolves its
// origin through types.ResolveWebOrigin, so ALETHIA_WEB_ORIGIN is the seam — and setting it
// also stops the client falling back to the real hosted default.
func provAPIClient(t *testing.T, origin string) *api.Client {
	t.Helper()
	t.Setenv("ALETHIA_WEB_ORIGIN", origin)
	return api.NewClient("cov-token")
}

// ─────────────────────────── drift detection ───────────────────────────

// TestProv_DriftDetectionOverTemplates drives the whole refresh-only drift spine against
// the recording `tofu`: workdir rebuild, backend wiring, `plan -refresh-only`, `show -json`,
// posture analysis, and the best-effort outputs tail day-2 inspection depends on.
func TestProv_DriftDetectionOverTemplates(t *testing.T) {
	argv := provFakeTofu(t, provTofuAt("terraform_data.probe"))
	var out strings.Builder

	posture, outputs, err := RunDriftDetection(context.Background(), DriftParams{
		ProjectConfig: provConfig(),
		Provider:      "aws",
		TemplatesDir:  provTemplates(t),
		StateBackend:  provBackend(t),
		Stdout:        &out,
		Stderr:        io.Discard,
	})
	if err != nil {
		t.Fatalf("RunDriftDetection: %v\nargv:\n%s", err, argv())
	}
	if posture == nil {
		t.Fatal("a successful drift run must return a posture")
	}
	log := argv()
	for _, want := range []string{"init", "-refresh-only", "show", "output"} {
		if !strings.Contains(log, want) {
			t.Errorf("the drift run never issued %q; argv:\n%s", want, log)
		}
	}
	if got, _ := outputs["kubeconfig"].(string); got != "PROV-FAKE-KUBECONFIG" {
		t.Errorf("outputs must ride along for day-2 inspection, got %#v", outputs)
	}
	if !strings.Contains(out.String(), "Drift posture:") {
		t.Errorf("the posture was never reported to the job log:\n%s", out.String())
	}
}

// TestProv_DriftDetectionOutputsAreBestEffort pins that a failing `tofu output` DEGRADES
// inspection rather than failing the drift job — the posture is the job's product, the
// outputs are a convenience.
func TestProv_DriftDetectionOutputsAreBestEffort(t *testing.T) {
	provFakeTofu(t, provFailingTofu("output"))
	var errBuf strings.Builder

	posture, outputs, err := RunDriftDetection(context.Background(), DriftParams{
		ProjectConfig: provConfig(),
		Provider:      "aws",
		TemplatesDir:  provTemplates(t),
		StateBackend:  provBackend(t),
		Stdout:        io.Discard,
		Stderr:        &errBuf,
	})
	if err != nil {
		t.Fatalf("a failed output read must not fail the drift job: %v", err)
	}
	if posture == nil {
		t.Fatal("the posture is still the job's product")
	}
	if outputs != nil {
		t.Errorf("a failed output read must yield nil outputs, got %#v", outputs)
	}
	if !strings.Contains(errBuf.String(), "could not read tofu outputs") {
		t.Errorf("the degradation must be warned about, got:\n%s", errBuf.String())
	}
}

// TestProv_DriftDetectionRejectsIncompleteParams pins the preconditions. Each refusal is a
// missing input the flow cannot substitute a default for.
func TestProv_DriftDetectionRejectsIncompleteParams(t *testing.T) {
	cases := []struct {
		name   string
		params DriftParams
		want   string
	}{
		{
			name:   "no project config",
			params: DriftParams{StateBackend: &cloud.HTTPBackendConfig{}},
			want:   "ProjectConfig is required",
		},
		{
			name:   "no state backend",
			params: DriftParams{ProjectConfig: provConfig()},
			want:   "StateBackend config is required",
		},
		{
			name:   "no templates dir and not BYO IaC",
			params: DriftParams{ProjectConfig: provConfig(), StateBackend: &cloud.HTTPBackendConfig{}},
			want:   "TemplatesDir is required",
		},
		{
			name: "unknown cloud",
			params: DriftParams{
				ProjectConfig: provConfig(),
				StateBackend:  &cloud.HTTPBackendConfig{},
				TemplatesDir:  t.TempDir(),
				Provider:      "not-a-cloud",
			},
			want: "not-a-cloud",
		},
		{
			name: "templates dir does not exist",
			params: DriftParams{
				ProjectConfig: provConfig(),
				StateBackend:  &cloud.HTTPBackendConfig{},
				TemplatesDir:  filepath.Join(t.TempDir(), "absent"),
				Provider:      "aws",
			},
			want: "failed to copy templates",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			posture, outputs, err := RunDriftDetection(context.Background(), tc.params)
			if err == nil {
				t.Fatalf("want an error containing %q, got posture %#v", tc.want, posture)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got: %v", tc.want, err)
			}
			if posture != nil || outputs != nil {
				t.Errorf("a rejected drift run must return nothing, got %#v / %#v", posture, outputs)
			}
		})
	}
}

// TestProv_DriftDetectionReportsTofuFailures pins that each `tofu` step's failure is
// reported as itself rather than swallowed — a drift job that reports "in sync" because the
// plan never ran is the worst possible outcome for a "keep proving it" check.
func TestProv_DriftDetectionReportsTofuFailures(t *testing.T) {
	cases := []struct{ failCmd, want string }{
		{failCmd: "init", want: "tofu init failed"},
		{failCmd: "plan", want: "tofu plan -refresh-only failed"},
		{failCmd: "show", want: "tofu show -json failed"},
	}
	for _, tc := range cases {
		t.Run(tc.failCmd, func(t *testing.T) {
			provFakeTofu(t, provFailingTofu(tc.failCmd))
			posture, _, err := RunDriftDetection(context.Background(), DriftParams{
				ProjectConfig: provConfig(),
				Provider:      "aws",
				TemplatesDir:  provTemplates(t),
				StateBackend:  provBackend(t),
				Stdout:        io.Discard,
				Stderr:        io.Discard,
			})
			if err == nil {
				t.Fatalf("a failing `tofu %s` must fail the drift job, got posture %#v", tc.failCmd, posture)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got: %v", tc.want, err)
			}
		})
	}
}

// ─────────────────────────── state import ───────────────────────────

// TestProv_StateImportUnwedgesTheEnvironment drives the orphan repair end to end and pins
// the VERIFY step: success is claimed only because the address was read back OUT OF STATE,
// not because `tofu import` exited zero.
func TestProv_StateImportUnwedgesTheEnvironment(t *testing.T) {
	const addr = "module.azure_cache[0].azurerm_managed_redis.this"
	argv := provFakeTofu(t, provTofuAt(addr))
	var out strings.Builder

	res, err := RunStateImport(context.Background(), ImportParams{
		ProjectConfig: provConfig(),
		Provider:      "azure",
		TemplatesDir:  provTemplates(t),
		StateBackend:  provBackend(t),
		Address:       addr,
		CloudID:       "/subscriptions/x/resourceGroups/y/providers/Microsoft.Cache/redis/z",
		Stdout:        &out,
		Stderr:        io.Discard,
	})
	if err != nil {
		t.Fatalf("RunStateImport: %v\nargv:\n%s", err, argv())
	}
	if res == nil || !res.Imported {
		t.Fatalf("want Imported=true after the address was read back from state, got %#v", res)
	}
	if res.Address != addr {
		t.Errorf("the result must echo the repaired address, got %q", res.Address)
	}
	log := argv()
	if !strings.Contains(log, "import") {
		t.Errorf("the repair never ran `tofu import`; argv:\n%s", log)
	}
	if !strings.Contains(log, "show") {
		t.Errorf("the repair never read state back to verify itself; argv:\n%s", log)
	}
	if !strings.Contains(out.String(), "no longer wedged") {
		t.Errorf("a verified repair must say so on the job log:\n%s", out.String())
	}
}

// TestProv_StateImportRefusesToClaimAnUnverifiedRepair is the whole point of the verify
// step: `tofu import` exits zero but the address is NOT in state afterwards. The flow must
// report the environment still wedged rather than a success.
func TestProv_StateImportRefusesToClaimAnUnverifiedRepair(t *testing.T) {
	provFakeTofu(t, provTofuAt("some.other.resource"))

	res, err := RunStateImport(context.Background(), ImportParams{
		ProjectConfig: provConfig(),
		Provider:      "aws",
		TemplatesDir:  provTemplates(t),
		StateBackend:  provBackend(t),
		Address:       "aws_vpc.main",
		CloudID:       "vpc-0123456789",
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err == nil {
		t.Fatal("an import that did not land in state must be reported as a failure")
	}
	if !strings.Contains(err.Error(), "still wedged") {
		t.Errorf("the error must say the environment is still wedged, got: %v", err)
	}
	if res == nil || res.Imported {
		t.Fatalf("want a result carrying Imported=false alongside the error, got %#v", res)
	}
}

// TestProv_StateImportRejectsIncompleteParams pins the preconditions, including the pair
// rule: an address without a cloud id (or vice versa) cannot address anything, and the
// refusal names where both are supposed to come from.
func TestProv_StateImportRejectsIncompleteParams(t *testing.T) {
	cases := []struct {
		name   string
		params ImportParams
		want   string
	}{
		{
			name:   "no project config",
			params: ImportParams{StateBackend: &cloud.HTTPBackendConfig{}},
			want:   "ProjectConfig is required",
		},
		{
			name:   "no state backend",
			params: ImportParams{ProjectConfig: provConfig()},
			want:   "StateBackend config is required",
		},
		{
			name: "address without a cloud id",
			params: ImportParams{
				ProjectConfig: provConfig(),
				StateBackend:  &cloud.HTTPBackendConfig{},
				Address:       "aws_vpc.main",
			},
			want: "orphan finding",
		},
		{
			name: "cloud id without an address",
			params: ImportParams{
				ProjectConfig: provConfig(),
				StateBackend:  &cloud.HTTPBackendConfig{},
				CloudID:       "vpc-1",
			},
			want: "orphan finding",
		},
		{
			name: "no templates dir and not BYO IaC",
			params: ImportParams{
				ProjectConfig: provConfig(),
				StateBackend:  &cloud.HTTPBackendConfig{},
				Address:       "aws_vpc.main",
				CloudID:       "vpc-1",
			},
			want: "TemplatesDir is required",
		},
		{
			name: "unknown cloud",
			params: ImportParams{
				ProjectConfig: provConfig(),
				StateBackend:  &cloud.HTTPBackendConfig{},
				TemplatesDir:  t.TempDir(),
				Address:       "aws_vpc.main",
				CloudID:       "vpc-1",
				Provider:      "not-a-cloud",
			},
			want: "not-a-cloud",
		},
		{
			name: "templates dir does not exist",
			params: ImportParams{
				ProjectConfig: provConfig(),
				StateBackend:  &cloud.HTTPBackendConfig{},
				TemplatesDir:  filepath.Join(t.TempDir(), "absent"),
				Address:       "aws_vpc.main",
				CloudID:       "vpc-1",
				Provider:      "aws",
			},
			want: "failed to copy templates",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := RunStateImport(context.Background(), tc.params)
			if err == nil {
				t.Fatalf("want an error containing %q, got %#v", tc.want, res)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got: %v", tc.want, err)
			}
			if res != nil {
				t.Errorf("a rejected import must return no result, got %#v", res)
			}
		})
	}
}

// TestProv_StateImportReportsTofuFailures pins that each step reports itself: an init that
// never wired state, an import that the provider refused, and a state read that could not
// verify the repair are three different findings, not one generic failure.
func TestProv_StateImportReportsTofuFailures(t *testing.T) {
	cases := []struct{ failCmd, want string }{
		{failCmd: "init", want: "tofu init failed"},
		{failCmd: "import", want: "tofu import of aws_vpc.main failed"},
		{failCmd: "show", want: "state could not be read back to verify"},
	}
	for _, tc := range cases {
		t.Run(tc.failCmd, func(t *testing.T) {
			provFakeTofu(t, provFailingTofu(tc.failCmd))
			res, err := RunStateImport(context.Background(), ImportParams{
				ProjectConfig: provConfig(),
				Provider:      "aws",
				TemplatesDir:  provTemplates(t),
				StateBackend:  provBackend(t),
				Address:       "aws_vpc.main",
				CloudID:       "vpc-1",
				Stdout:        io.Discard,
				Stderr:        io.Discard,
			})
			if err == nil {
				t.Fatalf("a failing `tofu %s` must fail the repair, got %#v", tc.failCmd, res)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got: %v", tc.want, err)
			}
		})
	}
}

// ─────────────────────────── teardown ───────────────────────────

// TestProv_DestroyTearsDownAndUnregisters drives RunDestroy end to end, including the
// control-plane unregister that must happen BEFORE the resources go.
func TestProv_DestroyTearsDownAndUnregisters(t *testing.T) {
	argv := provFakeTofu(t, provTofuAt("terraform_data.probe"))
	unregistered := make(chan string, 4)
	console := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		unregistered <- r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	t.Cleanup(console.Close)

	var out strings.Builder
	err := RunDestroy(context.Background(), DestroyParams{
		ProjectConfig: provConfig(),
		Provider:      "aws",
		TemplatesDir:  provTemplates(t),
		StateBackend:  provBackend(t),
		ApiClient:     provAPIClient(t, console.URL),
		Stdout:        &out,
		Stderr:        io.Discard,
	})
	if err != nil {
		t.Fatalf("RunDestroy: %v\nargv:\n%s", err, argv())
	}
	if !strings.Contains(argv(), "destroy") {
		t.Errorf("the teardown never ran `tofu destroy`; argv:\n%s", argv())
	}
	select {
	case path := <-unregistered:
		if path == "" {
			t.Error("the unregister call reached the console with no path")
		}
	default:
		t.Error("RunDestroy never unregistered the cluster from the control plane")
	}
	if !strings.Contains(out.String(), "Environment destroyed successfully") {
		t.Errorf("a completed teardown must say so:\n%s", out.String())
	}
}

// TestProv_DestroyContinuesWhenUnregisterFails pins the ordering choice: a control plane
// that refuses the unregister must NOT block the teardown, or a failed console call would
// strand real cloud resources. The warning is the record that it happened.
func TestProv_DestroyContinuesWhenUnregisterFails(t *testing.T) {
	provFakeTofu(t, provTofuAt("terraform_data.probe"))
	console := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(console.Close)

	var out strings.Builder
	err := RunDestroy(context.Background(), DestroyParams{
		ProjectConfig: provConfig(),
		Provider:      "aws",
		TemplatesDir:  provTemplates(t),
		StateBackend:  provBackend(t),
		ApiClient:     provAPIClient(t, console.URL),
		Stdout:        &out,
		Stderr:        io.Discard,
	})
	if err != nil {
		t.Fatalf("a failed unregister must not abort the teardown: %v", err)
	}
	if !strings.Contains(out.String(), "Failed to unregister cluster") {
		t.Errorf("the failed unregister must be warned about:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "Continuing with resource destruction") {
		t.Errorf("the teardown must state that it continued anyway:\n%s", out.String())
	}
}

// TestProv_DestroyReportsTofuFailures pins that a failed `tofu destroy` is surfaced — a
// teardown that reports success while resources still bill is the expensive failure mode.
func TestProv_DestroyReportsTofuFailures(t *testing.T) {
	cases := []struct{ failCmd, want string }{
		{failCmd: "init", want: "tofu init failed"},
		{failCmd: "destroy", want: "tofu destroy failed"},
	}
	for _, tc := range cases {
		t.Run(tc.failCmd, func(t *testing.T) {
			provFakeTofu(t, provFailingTofu(tc.failCmd))
			err := RunDestroy(context.Background(), DestroyParams{
				ProjectConfig: provConfig(),
				Provider:      "aws",
				TemplatesDir:  provTemplates(t),
				StateBackend:  provBackend(t),
				Stdout:        io.Discard,
				Stderr:        io.Discard,
			})
			if err == nil {
				t.Fatalf("a failing `tofu %s` must fail the teardown", tc.failCmd)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got: %v", tc.want, err)
			}
		})
	}
}

// TestProv_DestroyPlanReturnsThePlanWithoutApplying drives the read-only teardown: it must
// produce a plan and must never invoke `tofu destroy`.
func TestProv_DestroyPlanReturnsThePlanWithoutApplying(t *testing.T) {
	argv := provFakeTofu(t, provTofuAt("terraform_data.probe"))

	plan, err := RunDestroyPlan(context.Background(), DestroyParams{
		DryRun:        true,
		ProjectConfig: provConfig(),
		Provider:      "aws",
		TemplatesDir:  provTemplates(t),
		StateBackend:  provBackend(t),
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err != nil {
		t.Fatalf("RunDestroyPlan: %v\nargv:\n%s", err, argv())
	}
	if plan == nil || len(plan.ResourceChanges) == 0 {
		t.Fatalf("want a decoded destroy plan, got %#v", plan)
	}
	log := argv()
	if !strings.Contains(log, "-destroy") {
		t.Errorf("the plan was not a destroy plan; argv:\n%s", log)
	}
	for _, line := range strings.Split(log, "\n") {
		if strings.HasPrefix(line, "destroy ") {
			t.Fatalf("a plan-only teardown must never apply; argv:\n%s", log)
		}
	}
}

// TestProv_DestroyPlanReportsTofuFailures pins that a plan or show failure is reported
// rather than returned as an empty teardown — "nothing to destroy" and "we could not ask"
// are opposite findings for the day-2 gate.
func TestProv_DestroyPlanReportsTofuFailures(t *testing.T) {
	cases := []struct{ failCmd, want string }{
		{failCmd: "init", want: "tofu init failed"},
		{failCmd: "plan", want: "tofu plan -destroy failed"},
		{failCmd: "show", want: "tofu show -json of the destroy plan failed"},
	}
	for _, tc := range cases {
		t.Run(tc.failCmd, func(t *testing.T) {
			provFakeTofu(t, provFailingTofu(tc.failCmd))
			plan, err := RunDestroyPlan(context.Background(), DestroyParams{
				DryRun:        true,
				ProjectConfig: provConfig(),
				Provider:      "aws",
				TemplatesDir:  provTemplates(t),
				StateBackend:  provBackend(t),
				Stdout:        io.Discard,
				Stderr:        io.Discard,
			})
			if err == nil {
				t.Fatalf("a failing `tofu %s` must fail the plan, got %#v", tc.failCmd, plan)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got: %v", tc.want, err)
			}
			if plan != nil {
				t.Errorf("a failed plan must return nil, got %#v", plan)
			}
		})
	}
}

// TestProv_DestroyRejectsIncompleteParams covers RunDestroy's own preconditions — the ones
// it checks BEFORE the unregister, so a bad call can never leave the control plane out of
// step with a cloud it then failed to touch.
func TestProv_DestroyRejectsIncompleteParams(t *testing.T) {
	cases := []struct {
		name   string
		params DestroyParams
		want   string
	}{
		{
			name:   "no project config",
			params: DestroyParams{StateBackend: &cloud.HTTPBackendConfig{}},
			want:   "ProjectConfig is required for RunDestroy",
		},
		{
			name:   "no state backend",
			params: DestroyParams{ProjectConfig: provConfig()},
			want:   "StateBackend config is required",
		},
		{
			name: "no templates dir and not BYO IaC",
			params: DestroyParams{
				ProjectConfig: provConfig(),
				StateBackend:  &cloud.HTTPBackendConfig{},
			},
			want: "TemplatesDir is required",
		},
		{
			name: "unknown cloud",
			params: DestroyParams{
				ProjectConfig: provConfig(),
				StateBackend:  &cloud.HTTPBackendConfig{},
				TemplatesDir:  t.TempDir(),
				Provider:      "not-a-cloud",
			},
			want: "not-a-cloud",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.params.Stdout = io.Discard
			tc.params.Stderr = io.Discard
			if err := RunDestroy(context.Background(), tc.params); err == nil {
				t.Fatalf("want an error containing %q, got nil", tc.want)
			} else if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got: %v", tc.want, err)
			}
		})
	}
}

// TestProv_PrepareDestroyWorkdirUnwindsOnFailure pins the cleanup contract: every failure
// past the temp-dir creation must undo what was already set up. The observable proof is that
// the state-auth env the setup publishes is NOT left behind when init fails.
func TestProv_PrepareDestroyWorkdirUnwindsOnFailure(t *testing.T) {
	provFakeTofu(t, provFailingTofu("init"))
	t.Setenv("TF_HTTP_PASSWORD", "sentinel-before")

	wd, err := prepareDestroyWorkdir(context.Background(), DestroyParams{
		ProjectConfig: provConfig(),
		Provider:      "aws",
		TemplatesDir:  provTemplates(t),
		StateBackend:  provBackend(t),
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err == nil {
		t.Fatalf("want the init failure to propagate, got %#v", wd)
	}
	if wd != nil {
		t.Errorf("a failed setup must return no workdir, got %#v", wd)
	}
	if got := os.Getenv("TF_HTTP_PASSWORD"); got != "sentinel-before" {
		t.Errorf("the unwind must restore the state-auth env, got %q", got)
	}
}

// ─────────────────────────── BYO IaC workdirs ───────────────────────────

// provByoConfig builds a ProjectConfig whose workdir comes from a customer's own OpenTofu
// module: a local git repo, cloned over file:// through the in-package test escape, pinned to
// a real commit. Every day-2 flow must rebuild the workdir this way rather than from the
// bundled templates, and each one has its own copy of that branch.
func provByoConfig(t *testing.T) *types.ProjectConfig {
	t.Helper()
	allowInsecureRepoURLForTest = true
	t.Cleanup(func() { allowInsecureRepoURLForTest = false })
	repo, branch, sha := gitInitModuleRepo(t, validModuleTF)

	vc := provConfig()
	vc.IacSource = &types.ProjectIacSourceConfig{
		RepoURL:   "file://" + repo,
		Ref:       branch,
		CommitSHA: sha,
		Path:      "module",
		VarValues: map[string]any{"replicas": float64(2)},
	}
	return vc
}

// provByoConfigUnclonable is a BYO source pinned to a repo that does not exist, so the clone
// fails — the branch every day-2 flow needs for "the customer's module could not be fetched".
func provByoConfigUnclonable(t *testing.T) *types.ProjectConfig {
	t.Helper()
	allowInsecureRepoURLForTest = true
	t.Cleanup(func() { allowInsecureRepoURLForTest = false })

	vc := provConfig()
	vc.IacSource = &types.ProjectIacSourceConfig{
		RepoURL:   "file://" + filepath.Join(t.TempDir(), "no-such-repo"),
		Ref:       "main",
		CommitSHA: "0000000000000000000000000000000000000000",
		Path:      "module",
	}
	return vc
}

// TestProv_DriftDetectionOverByoIacModule pins that refresh-only drift runs the CUSTOMER's
// module at its pinned commit, not the bundled templates — drift measured against different
// HCL than was applied is not drift.
func TestProv_DriftDetectionOverByoIacModule(t *testing.T) {
	vc := provByoConfig(t)
	argv := provFakeTofu(t, provTofuAt("null_resource.x"))
	var out strings.Builder

	posture, _, err := RunDriftDetection(context.Background(), DriftParams{
		ProjectConfig:  vc,
		Provider:       "aws",
		StateBackend:   provBackend(t),
		GitAccessToken: "",
		Stdout:         &out,
		Stderr:         io.Discard,
	})
	if err != nil {
		t.Fatalf("RunDriftDetection over a BYO module: %v\nlog:\n%s", err, out.String())
	}
	if posture == nil {
		t.Fatal("want a posture from the BYO drift run")
	}
	if !strings.Contains(out.String(), "BYO IaC: cloning") {
		t.Errorf("the BYO clone never ran — the drift used the wrong workdir:\n%s", out.String())
	}
	if !strings.Contains(argv(), "-refresh-only") {
		t.Errorf("the BYO drift run never planned refresh-only; argv:\n%s", argv())
	}
}

// TestProv_StateImportOverByoIacModule pins the same rule for the orphan repair: the address
// only resolves inside the module that OWNS it, so the repair must clone the customer's.
func TestProv_StateImportOverByoIacModule(t *testing.T) {
	vc := provByoConfig(t)
	provFakeTofu(t, provTofuAt("null_resource.x"))
	var out strings.Builder

	res, err := RunStateImport(context.Background(), ImportParams{
		ProjectConfig: vc,
		Provider:      "aws",
		StateBackend:  provBackend(t),
		Address:       "null_resource.x",
		CloudID:       "id-1",
		Stdout:        &out,
		Stderr:        io.Discard,
	})
	if err != nil {
		t.Fatalf("RunStateImport over a BYO module: %v\nlog:\n%s", err, out.String())
	}
	if res == nil || !res.Imported {
		t.Fatalf("want a verified import, got %#v", res)
	}
	if !strings.Contains(out.String(), "BYO IaC: cloning") {
		t.Errorf("the BYO clone never ran — the import used the wrong workdir:\n%s", out.String())
	}
}

// TestProv_DestroyOverByoIacModule pins that a teardown re-clones the customer's module at
// the SAME pinned commit: destroying with drifted HCL orphans resources.
func TestProv_DestroyOverByoIacModule(t *testing.T) {
	vc := provByoConfig(t)
	argv := provFakeTofu(t, provTofuAt("null_resource.x"))
	var out strings.Builder

	if err := RunDestroy(context.Background(), DestroyParams{
		ProjectConfig: vc,
		Provider:      "aws",
		StateBackend:  provBackend(t),
		Stdout:        &out,
		Stderr:        io.Discard,
	}); err != nil {
		t.Fatalf("RunDestroy over a BYO module: %v\nlog:\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "BYO IaC: cloning") {
		t.Errorf("the teardown never re-cloned the pinned module:\n%s", out.String())
	}
	if !strings.Contains(argv(), "destroy") {
		t.Errorf("the BYO teardown never ran `tofu destroy`; argv:\n%s", argv())
	}
}

// TestProv_ByoIacCloneFailureStopsEveryDay2Flow pins that a module that cannot be fetched
// stops each flow BEFORE `tofu` — the fail-closed rule: no day-2 operation ever runs against
// a module the platform could not obtain at its pinned commit.
func TestProv_ByoIacCloneFailureStopsEveryDay2Flow(t *testing.T) {
	cases := []struct {
		name string
		run  func(t *testing.T, vc *types.ProjectConfig, backend *cloud.HTTPBackendConfig) error
	}{
		{
			name: "drift",
			run: func(_ *testing.T, vc *types.ProjectConfig, backend *cloud.HTTPBackendConfig) error {
				_, _, err := RunDriftDetection(context.Background(), DriftParams{
					ProjectConfig: vc, Provider: "aws", StateBackend: backend,
					Stdout: io.Discard, Stderr: io.Discard,
				})
				return err
			},
		},
		{
			name: "state import",
			run: func(_ *testing.T, vc *types.ProjectConfig, backend *cloud.HTTPBackendConfig) error {
				_, err := RunStateImport(context.Background(), ImportParams{
					ProjectConfig: vc, Provider: "aws", StateBackend: backend,
					Address: "null_resource.x", CloudID: "id-1",
					Stdout: io.Discard, Stderr: io.Discard,
				})
				return err
			},
		},
		{
			name: "destroy",
			run: func(_ *testing.T, vc *types.ProjectConfig, backend *cloud.HTTPBackendConfig) error {
				return RunDestroy(context.Background(), DestroyParams{
					ProjectConfig: vc, Provider: "aws", StateBackend: backend,
					Stdout: io.Discard, Stderr: io.Discard,
				})
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vc := provByoConfigUnclonable(t)
			argv := provFakeTofu(t, provTofuAt("null_resource.x"))
			err := tc.run(t, vc, provBackend(t))
			if err == nil {
				t.Fatal("an unfetchable BYO module must stop the flow")
			}
			if !strings.Contains(err.Error(), "BYO IaC clone/checkout failed") {
				t.Errorf("want the clone failure named, got: %v", err)
			}
			if log := argv(); strings.Contains(log, "init") {
				t.Errorf("the flow reached `tofu` on an unfetched module; argv:\n%s", log)
			}
		})
	}
}

// ─────────────────────────── workdir setup failures ───────────────────────────

// provNoTempDir points os.MkdirTemp at a directory that does not exist, so the very first
// step of every workdir rebuild fails.
func provNoTempDir(t *testing.T) {
	t.Helper()
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "absent"))
}

// provNoTofuBinary removes every way to obtain OpenTofu: nothing named `tofu` on PATH and no
// home directory to cache a download in. ensureBinary then fails WITHOUT attempting a
// network fetch, which is what makes this usable in a hermetic suite.
func provNoTofuBinary(t *testing.T) {
	t.Helper()
	t.Setenv("PATH", t.TempDir())
	t.Setenv("HOME", "")
}

// provTemplatesWithDirNamed writes a template tree in which `name` is a DIRECTORY. copyDir
// reproduces it in the workdir, so the flow's later os.WriteFile to that exact path fails —
// a hermetic way to reach the "could not write the workdir" branches.
func provTemplatesWithDirNamed(t *testing.T, name string) string {
	t.Helper()
	dir := provTemplates(t)
	if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
		t.Fatalf("seed blocking dir: %v", err)
	}
	return dir
}

// provBadConnectorConfig selects a DNS connector that is not in the category registry, so
// categories.Compose refuses to compose the workdir.
func provBadConnectorConfig() *types.ProjectConfig {
	vc := provConfig()
	vc.DNS.Enabled = true
	vc.DNS.Provider = "not-a-registered-dns-provider"
	return vc
}

// TestProv_Day2WorkdirSetupFailuresAreReported walks every way the workdir rebuild can fail
// and pins that each flow reports the step that failed instead of proceeding. All three day-2
// flows carry their own copy of this setup, so all three are driven through each case.
func TestProv_Day2WorkdirSetupFailuresAreReported(t *testing.T) {
	type flow struct {
		name string
		run  func(vc *types.ProjectConfig, templates string, backend *cloud.HTTPBackendConfig) error
	}
	flows := []flow{
		{
			name: "drift",
			run: func(vc *types.ProjectConfig, templates string, backend *cloud.HTTPBackendConfig) error {
				_, _, err := RunDriftDetection(context.Background(), DriftParams{
					ProjectConfig: vc, Provider: "aws", TemplatesDir: templates, StateBackend: backend,
				})
				return err
			},
		},
		{
			name: "state import",
			run: func(vc *types.ProjectConfig, templates string, backend *cloud.HTTPBackendConfig) error {
				_, err := RunStateImport(context.Background(), ImportParams{
					ProjectConfig: vc, Provider: "aws", TemplatesDir: templates, StateBackend: backend,
					Address: "aws_vpc.main", CloudID: "vpc-1",
				})
				return err
			},
		},
		{
			name: "destroy",
			run: func(vc *types.ProjectConfig, templates string, backend *cloud.HTTPBackendConfig) error {
				return RunDestroy(context.Background(), DestroyParams{
					ProjectConfig: vc, Provider: "aws", TemplatesDir: templates, StateBackend: backend,
				})
			},
		},
	}
	cases := []struct {
		name      string
		config    func(t *testing.T) *types.ProjectConfig
		templates func(t *testing.T) string
		// break_ perturbs the environment so one setup step fails.
		break_ func(t *testing.T)
		want   string
	}{
		{
			name:   "no temp dir to build the workdir in",
			break_: provNoTempDir,
			want:   "failed to create temp dir",
		},
		{
			name:   "a connector the registry does not know",
			config: func(*testing.T) *types.ProjectConfig { return provBadConnectorConfig() },
			want:   "connector composition failed",
		},
		{
			name:   "no OpenTofu binary obtainable",
			break_: provNoTofuBinary,
			want:   "failed to ensure OpenTofu binary",
		},
		{
			name:      "the tfvars path is blocked",
			templates: func(t *testing.T) string { return provTemplatesWithDirNamed(t, "tofu.tfvars.json") },
			want:      "failed to write tfvars",
		},
		{
			name:      "the backend config path is blocked",
			templates: func(t *testing.T) string { return provTemplatesWithDirNamed(t, "backend.hcl") },
			want:      "failed to write backend config",
		},
	}

	for _, tc := range cases {
		for _, f := range flows {
			t.Run(tc.name+"/"+f.name, func(t *testing.T) {
				vc := provConfig()
				if tc.config != nil {
					vc = tc.config(t)
				}
				templates := provTemplates(t)
				if tc.templates != nil {
					templates = tc.templates(t)
				}
				backend := provBackend(t)
				provFakeTofu(t, provTofuAt("aws_vpc.main"))
				if tc.break_ != nil {
					tc.break_(t)
				}
				err := f.run(vc, templates, backend)
				if err == nil {
					t.Fatalf("want an error containing %q, got nil", tc.want)
				}
				if !strings.Contains(err.Error(), tc.want) {
					t.Errorf("want an error containing %q, got: %v", tc.want, err)
				}
			})
		}
	}
}

// TestProv_DestroyRoutesVclusterAwayFromTofu pins the placement routing: a vcluster env owns
// no OpenTofu state, so its teardown must be handled BEFORE the tofu path — running `tofu
// destroy` against a workspace that never existed is how a teardown reports a false failure.
func TestProv_DestroyRoutesVclusterAwayFromTofu(t *testing.T) {
	argv := provFakeTofu(t, provTofuAt("terraform_data.probe"))
	vc := provConfig()
	vc.PlacementMode = types.PlacementModeVcluster

	// The outcome depends on what the snapshot carries; the routing property is that `tofu`
	// is never reached, and that is what this pins.
	_ = RunDestroy(context.Background(), DestroyParams{
		ProjectConfig: vc,
		Provider:      "aws",
		TemplatesDir:  provTemplates(t),
		StateBackend:  provBackend(t),
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if log := argv(); log != "" {
		t.Errorf("a vcluster teardown must never invoke tofu; argv:\n%s", log)
	}
}

// ─────────────────────────── reading state outputs ───────────────────────────

// provKubectlScript answers the probe's three kubectl calls distinctly: `/readyz` says the
// cluster is alive, `version` fails, and `get nodes` answers with unparseable JSON. That one
// stub therefore drives the reachable path AND both best-effort enrichments' give-up branches.
const provKubectlScript = `#!/bin/sh
for a in "$@"; do
  case "$a" in
    --raw=/readyz) echo ok; exit 0 ;;
    nodes) echo 'not json at all' ; exit 0 ;;
  esac
done
exit 1
`

// provStubTool installs a stand-in for an external binary first on PATH.
func provStubTool(t *testing.T, name, body string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755); err != nil {
		t.Fatalf("write %s stub: %v", name, err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// TestProv_ReadStateOutputsReadsWithoutPersisting drives the cheap in-process state read the
// probe path depends on, and pins the security invariant it exists for: the sensitive values
// reach the CALLER but never the job-log writer.
func TestProv_ReadStateOutputsReadsWithoutPersisting(t *testing.T) {
	argv := provFakeTofu(t, provTofuAt("terraform_data.probe"))
	var out strings.Builder

	outputs, err := ReadStateOutputs(context.Background(), ReadStateOutputsParams{
		IacVersion:   "1.9.0",
		StateBackend: provBackend(t),
		Stdout:       &out,
		Stderr:       io.Discard,
	})
	if err != nil {
		t.Fatalf("ReadStateOutputs: %v\nargv:\n%s", err, argv())
	}
	if got, _ := outputs["kubeconfig"].(string); got != "PROV-FAKE-KUBECONFIG" {
		t.Fatalf("the sensitive output never reached the caller, got %#v", outputs)
	}
	if strings.Contains(out.String(), "PROV-FAKE-KUBECONFIG") {
		t.Errorf("the sensitive output leaked to the job log:\n%s", out.String())
	}
	if !strings.Contains(argv(), "output") {
		t.Errorf("the read never ran `tofu output`; argv:\n%s", argv())
	}
}

// TestProv_ReadStateOutputsRejectsAndReportsFailures pins the preconditions and that each
// failing step is named — an unreadable state proxy must never look like "no outputs".
func TestProv_ReadStateOutputsRejectsAndReportsFailures(t *testing.T) {
	t.Run("no state backend", func(t *testing.T) {
		if _, err := ReadStateOutputs(context.Background(), ReadStateOutputsParams{}); err == nil ||
			!strings.Contains(err.Error(), "StateBackend config is required") {
			t.Fatalf("want the StateBackend precondition, got: %v", err)
		}
	})

	cases := []struct {
		name   string
		break_ func(t *testing.T)
		script string
		want   string
	}{
		{name: "no temp dir", break_: provNoTempDir, script: "", want: "failed to create temp dir"},
		{name: "no OpenTofu binary", break_: provNoTofuBinary, script: "", want: "tofu init failed"},
		{name: "init fails", script: "init", want: "tofu init failed"},
		{name: "output fails", script: "output", want: "failed to read tofu outputs from state"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			backend := provBackend(t)
			script := provTofuAt("terraform_data.probe")
			if tc.script != "" {
				script = provFailingTofu(tc.script)
			}
			provFakeTofu(t, script)
			if tc.break_ != nil {
				tc.break_(t)
			}
			// Stdout/Stderr left nil on purpose: the flow must default them rather than panic.
			outputs, err := ReadStateOutputs(context.Background(), ReadStateOutputsParams{
				StateBackend: backend,
			})
			if err == nil {
				t.Fatalf("want an error containing %q, got %#v", tc.want, outputs)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got: %v", tc.want, err)
			}
		})
	}
}

// ─────────────────────────── cluster probe ───────────────────────────

// TestProv_ProbeReportsAnHonestDownWhenKubeconfigIsUnavailable pins the fail-closed-to-
// honest-down rule: a cluster we cannot build a kubeconfig for is a SUCCESSFUL probe saying
// "unreachable", never a job error. Reporting it as an error would make a dead cluster
// indistinguishable from a broken control plane.
func TestProv_ProbeReportsAnHonestDownWhenKubeconfigIsUnavailable(t *testing.T) {
	// The `output` subcommand answers `{}` — no kubeconfig, no cluster name — so the aws
	// provider cannot configure access.
	provFakeTofu(t, provFailingTofu("never-fails"))
	var errBuf strings.Builder

	res, err := RunProbe(context.Background(), ProbeParams{
		ProjectConfig: provConfig(),
		Provider:      "aws",
		IacVersion:    "1.9.0",
		StateBackend:  provBackend(t),
		Timeout:       3 * time.Second,
		Stdout:        io.Discard,
		Stderr:        &errBuf,
	})
	if err != nil {
		t.Fatalf("an unreachable cluster must not be a probe error: %v", err)
	}
	if res == nil || res.Reachable {
		t.Fatalf("want an honest Reachable=false, got %#v", res)
	}
	if res.Detail.Method != probeMethod {
		t.Errorf("the probe method must still be recorded, got %q", res.Detail.Method)
	}
	if res.Detail.Error == "" {
		t.Error("an unreachable result must carry a non-secret reason")
	}
	if !strings.Contains(errBuf.String(), "kubeconfig unavailable") {
		t.Errorf("the reason must be reported, got:\n%s", errBuf.String())
	}
}

// TestProv_ProbeReachableClusterEnrichesBestEffort drives the reachable path: `/readyz`
// answers ok, and the two enrichments (server version, node readiness) fail — which must
// leave the result reachable, because the API server DID answer.
func TestProv_ProbeReachableClusterEnrichesBestEffort(t *testing.T) {
	provFakeTofu(t, provTofuAt("terraform_data.probe"))
	provStubTool(t, "kubectl", provKubectlScript)

	res, err := RunProbe(context.Background(), ProbeParams{
		ProjectConfig: provConfig(),
		Provider:      "aws",
		IacVersion:    "1.9.0",
		StateBackend:  provBackend(t),
		// Under the 4s floor on purpose: runKubectlBounded must clamp the per-call
		// --request-timeout rather than hand kubectl a negative one.
		Timeout: 3 * time.Second,
		Stdout:  io.Discard,
		Stderr:  io.Discard,
	})
	if err != nil {
		t.Fatalf("RunProbe: %v", err)
	}
	if res == nil || !res.Reachable {
		t.Fatalf("want Reachable=true when /readyz answers ok, got %#v", res)
	}
	if res.Detail.StatusCode != 200 {
		t.Errorf("a reachable cluster must record the answered status, got %d", res.Detail.StatusCode)
	}
	if res.Detail.ServerVersion != "" {
		t.Errorf("a failed version read must leave the field empty, got %q", res.Detail.ServerVersion)
	}
	if res.Detail.NodeCount != 0 || res.Detail.ReadyNodeCount != 0 {
		t.Errorf("an unparseable node list must leave the counts unset, got %d/%d",
			res.Detail.ReadyNodeCount, res.Detail.NodeCount)
	}
}

// TestProv_ProbeCannotRunIsAnError is the other half of the rule: the probe being UNABLE TO
// RUN — bad params, or a state proxy it cannot read — is an operational error, distinct from
// an honest "the cluster is down".
func TestProv_ProbeCannotRunIsAnError(t *testing.T) {
	t.Run("state is unreadable", func(t *testing.T) {
		provFakeTofu(t, provFailingTofu("init"))
		res, err := RunProbe(context.Background(), ProbeParams{
			ProjectConfig: provConfig(),
			Provider:      "aws",
			StateBackend:  provBackend(t),
			Stdout:        io.Discard,
			Stderr:        io.Discard,
		})
		if err == nil {
			t.Fatalf("an unreadable state proxy must be an error, got %#v", res)
		}
		if !strings.Contains(err.Error(), "could not read environment state") {
			t.Errorf("want the state-read failure named, got: %v", err)
		}
		if res != nil {
			t.Errorf("a probe that could not run must return no result, got %#v", res)
		}
	})
}

// ─────────────────────────── karpenter node class ───────────────────────────

// provKarpenterOutputs are the tofu outputs an AWS+Karpenter cluster emits: the node role,
// security group, subnets and the sweep-handle tags without which launched EC2 would be
// invisible to the environment sweeper.
func provKarpenterOutputs() map[string]interface{} {
	return map[string]interface{}{
		"node_iam_role_name":  "cov-node-role",
		"node_security_group": "sg-0123456789",
		"subnet1":             "subnet-a",
		"subnet2":             "subnet-b",
		"karpenter_node_tags": map[string]interface{}{
			"alethia.io/environment": "cov-dev",
			"alethia.io/project":     "covprov",
			// A non-string value must be dropped by the projection, not rendered.
			"replicas": 3,
		},
	}
}

// TestProv_KarpenterNodeClassAppliesWithSweepTags drives the render+apply: the node class
// reaches kubectl and carries the sweep-handle tags that are the whole reason this renderer
// exists.
func TestProv_KarpenterNodeClassAppliesWithSweepTags(t *testing.T) {
	applied := filepath.Join(t.TempDir(), "applied.yaml")
	provStubTool(t, "kubectl", "#!/bin/sh\ncat \"$3\" > "+applied+"\nexit 0\n")

	err := applyKarpenterNodeClass(
		context.Background(),
		provKarpenterOutputs(),
		&argocd.InfraFacts{Provider: "aws", EnableKarpenter: true},
		io.Discard, io.Discard,
	)
	if err != nil {
		t.Fatalf("applyKarpenterNodeClass: %v", err)
	}
	body, readErr := os.ReadFile(applied)
	if readErr != nil {
		t.Fatalf("the node class never reached kubectl: %v", readErr)
	}
	for _, want := range []string{"cov-node-role", "sg-0123456789", "subnet-a", "alethia.io/environment"} {
		if !strings.Contains(string(body), want) {
			t.Errorf("the applied node class is missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(string(body), "replicas") {
		t.Errorf("a non-string tag value was rendered:\n%s", body)
	}
}

// TestProv_KarpenterNodeClassStopsOnACancelledContext pins the retry loop's exit: the apply
// races Karpenter's CRDs landing via ArgoCD, so it retries — but a cancelled job must stop
// immediately rather than sit out the backoff.
func TestProv_KarpenterNodeClassStopsOnACancelledContext(t *testing.T) {
	provStubTool(t, "kubectl", "#!/bin/sh\nexit 1\n")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := applyKarpenterNodeClass(ctx, provKarpenterOutputs(),
		&argocd.InfraFacts{Provider: "aws", EnableKarpenter: true}, io.Discard, io.Discard)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want the context's own error so the job stops, got: %v", err)
	}
}

// TestProv_ExtractStringTagMapIgnoresNonMaps pins the projection's give-up cases: a tofu
// output that is not a map yields no tags, which the caller turns into a refusal rather than
// launching untagged EC2.
func TestProv_ExtractStringTagMapIgnoresNonMaps(t *testing.T) {
	cases := []struct {
		name    string
		outputs map[string]interface{}
	}{
		{name: "absent", outputs: map[string]interface{}{}},
		{name: "null", outputs: map[string]interface{}{"karpenter_node_tags": nil}},
		{name: "a scalar", outputs: map[string]interface{}{"karpenter_node_tags": "not-a-map"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractStringTagMap(tc.outputs, "karpenter_node_tags"); got != nil {
				t.Fatalf("want nil tags, got %#v", got)
			}
		})
	}
	// The defensive `{"value": {...}}` wrapping must still unwrap.
	wrapped := map[string]interface{}{
		"karpenter_node_tags": map[string]interface{}{
			"value": map[string]interface{}{"k": "v"},
		},
	}
	if got := extractStringTagMap(wrapped, "karpenter_node_tags"); got["k"] != "v" {
		t.Fatalf("the wrapped form was not unwrapped, got %#v", got)
	}
}

// ─────────────────────────── BYO chart trust boundary ───────────────────────────

// provByoChartConfig is a project with two bring-your-own (git-source) charts sharing one repo
// plus a marketplace chart, so the per-repo credential lane's dedup and the marketplace
// pass-through are both exercised.
func provByoChartConfig() *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName: "Acme Corp",
		AddOns: []types.AddOnInstall{
			{ID: "api", Source: "git", ChartRepo: "https://github.com/acme/charts.git", Path: "charts/api", Namespace: "apps"},
			{ID: "web", Source: "git", ChartRepo: "https://github.com/acme/charts.git", Path: "charts/web"},
			{ID: "grafana", Chart: "grafana"},
		},
	}
}

// TestProv_PrepareByoChartsRegistersOneCredentialPerRepo drives the hardened-project + per-repo
// credential lane with a token present, and pins the dedup: two charts from one repo register
// ONE credential, not two.
func TestProv_PrepareByoChartsRegistersOneCredentialPerRepo(t *testing.T) {
	calls := filepath.Join(t.TempDir(), "kubectl.log")
	provStubTool(t, "kubectl", "#!/bin/sh\nprintf '%s\\n' \"$*\" >> "+calls+"\nexit 0\n")

	vc := provByoChartConfig()
	var errOut strings.Builder
	if !prepareByoCharts(vc, "shared-token", map[string]string{}, map[string]string{"env": "prod"}, io.Discard, &errOut) {
		t.Fatal("prepareByoCharts did not report the BYO charts")
	}
	if vc.AddOns[0].Project == "" || vc.AddOns[0].Project != vc.AddOns[1].Project {
		t.Errorf("both BYO charts must be pinned to the same hardened project, got %q / %q",
			vc.AddOns[0].Project, vc.AddOns[1].Project)
	}
	if vc.AddOns[2].Project != "" {
		t.Errorf("the marketplace chart must keep the infra project, got %q", vc.AddOns[2].Project)
	}
	body, err := os.ReadFile(calls)
	if err != nil {
		t.Fatalf("nothing reached kubectl: %v", err)
	}
	if n := strings.Count(string(body), "apply"); n < 2 {
		t.Errorf("want the AppProject plus one repo credential applied, got %d applies:\n%s", n, body)
	}
	if errOut.String() != "" {
		t.Errorf("a fully-credentialed BYO setup must warn about nothing, got:\n%s", errOut.String())
	}
}

// TestProv_PrepareByoChartsIsBestEffort pins the fail-closed-but-non-fatal posture: when the
// AppProject and the repo credential cannot be applied, the deploy continues and the operator
// is told — the charts simply do not sync.
func TestProv_PrepareByoChartsIsBestEffort(t *testing.T) {
	provStubTool(t, "kubectl", "#!/bin/sh\necho 'connection refused' >&2\nexit 1\n")

	vc := provByoChartConfig()
	var errOut strings.Builder
	if !prepareByoCharts(vc, "shared-token", nil, nil, io.Discard, &errOut) {
		t.Fatal("prepareByoCharts did not report the BYO charts")
	}
	if !strings.Contains(errOut.String(), "could not apply BYO AppProject") {
		t.Errorf("the failed AppProject apply must be warned about, got:\n%s", errOut.String())
	}
	if !strings.Contains(errOut.String(), "could not configure credentials for BYO repo") {
		t.Errorf("the failed credential registration must be warned about, got:\n%s", errOut.String())
	}
}

// TestProv_ByoChartBindingsApplyKeylessExternalSecrets drives the credential-facet lane: the
// chart's value-path receives a SECRET NAME (never a plaintext credential) and the backing
// ExternalSecret is applied out-of-band, tagged so a removed binding's Secret can be swept.
func TestProv_ByoChartBindingsApplyKeylessExternalSecrets(t *testing.T) {
	applied := filepath.Join(t.TempDir(), "es.yaml")
	provStubTool(t, "kubectl", "#!/bin/sh\ncat \"$3\" >> "+applied+"\nexit 0\n")

	vc := &types.ProjectConfig{
		AddOns: []types.AddOnInstall{{
			ID:        "acme-api",
			Namespace: "apps",
			Workloads: []types.ChartWorkloadBinding{{
				Name: "api",
				Bindings: []types.ServiceBinding{{
					Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"},
					Inject: []types.ServiceBindingInjection{{Env: "DB_PASSWORD", From: "password"}},
				}},
				ValuePaths: map[string]string{"bind:database:primary:password": "api.existingSecret"},
			}},
		}},
	}
	outputs := map[string]interface{}{"rds_master_credentials_secret_name": "acme/rds/master"}

	names := applyByoChartBindings(vc, outputs, "aws", io.Discard, io.Discard)
	if len(names) != 1 {
		t.Fatalf("want one applied binding Secret name, got %#v", names)
	}
	body, err := os.ReadFile(applied)
	if err != nil {
		t.Fatalf("the ExternalSecret never reached kubectl: %v", err)
	}
	if !strings.Contains(string(body), "ExternalSecret") {
		t.Errorf("what reached kubectl is not an ExternalSecret:\n%s", body)
	}
	if !strings.Contains(string(body), "acme/rds/master") {
		t.Errorf("the ExternalSecret does not point at the provisioned master secret:\n%s", body)
	}
	// The chart values must carry the SECRET NAME, never the credential itself.
	api, ok := vc.AddOns[0].Values["api"].(map[string]interface{})
	if !ok {
		t.Fatalf("values[api] = %#v, want a nested map", vc.AddOns[0].Values["api"])
	}
	if got, _ := api["existingSecret"].(string); got != names[0] {
		t.Errorf("values[api][existingSecret] = %q, want the applied Secret name %q", got, names[0])
	}
}

// TestProv_ByoChartBindingsSurviveAFailedApply pins that a binding whose ExternalSecret cannot
// be applied is reported and DROPPED from the swept set — reporting it as applied would make
// the pruner sweep a Secret it never created.
func TestProv_ByoChartBindingsSurviveAFailedApply(t *testing.T) {
	provStubTool(t, "kubectl", "#!/bin/sh\nexit 1\n")

	vc := &types.ProjectConfig{
		AddOns: []types.AddOnInstall{{
			ID:        "acme-api",
			Namespace: "apps",
			Workloads: []types.ChartWorkloadBinding{{
				Name: "api",
				Bindings: []types.ServiceBinding{{
					Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"},
					Inject: []types.ServiceBindingInjection{{Env: "DB_PASSWORD", From: "password"}},
				}},
				ValuePaths: map[string]string{"bind:database:primary:password": "api.existingSecret"},
			}},
		}},
	}
	var errOut strings.Builder
	names := applyByoChartBindings(vc, map[string]interface{}{
		"rds_master_credentials_secret_name": "acme/rds/master",
	}, "aws", io.Discard, &errOut)

	if len(names) != 0 {
		t.Fatalf("a failed apply must not be reported as applied, got %#v", names)
	}
	if !strings.Contains(errOut.String(), "ExternalSecret apply failed") {
		t.Errorf("the failed apply must be warned about, got:\n%s", errOut.String())
	}
}

// ─────────────────────────── GitOps add-on manifests ───────────────────────────

// provGitopsAddOn is a gitops-mode add-on — the mode writeAddOnGitOps seeds into the
// customer's apps repo.
func provGitopsAddOn(id string) types.AddOnInstall {
	return types.AddOnInstall{ID: id, Mode: "gitops", Chart: id, ChartRepo: "https://charts.example.com", Version: "1.0.0"}
}

// TestProv_WriteAddOnGitOpsReportsEveryFailureMode walks the seed lane's failure modes. Each
// one must be REPORTED: a silent failure here leaves the customer's repo missing the add-on
// the console says is enabled.
func TestProv_WriteAddOnGitOpsReportsEveryFailureMode(t *testing.T) {
	t.Run("no temp dir to stage the clone", func(t *testing.T) {
		bare := newBareAppsRepo(t, nil)
		vc := &types.ProjectConfig{AddOns: []types.AddOnInstall{provGitopsAddOn("grafana")}}
		vc.Repositories.AppsDestinationRepo = "file://" + bare
		provNoTempDir(t)

		if err := writeAddOnGitOps(context.Background(), vc, "tok", nil, io.Discard, io.Discard); err == nil {
			t.Fatal("want the temp-dir failure to propagate")
		}
	})

	t.Run("the addons path is blocked by a customer file", func(t *testing.T) {
		bare := newBareAppsRepo(t, map[string]string{addonsRepoDir: "not a directory\n"})
		vc := &types.ProjectConfig{AddOns: []types.AddOnInstall{provGitopsAddOn("grafana")}}
		vc.Repositories.AppsDestinationRepo = "file://" + bare

		if err := writeAddOnGitOps(context.Background(), vc, "tok", nil, io.Discard, io.Discard); err == nil {
			t.Fatal("want the addons-directory failure to propagate")
		}
	})

	t.Run("an unrenderable add-on", func(t *testing.T) {
		bare := newBareAppsRepo(t, nil)
		bad := provGitopsAddOn("grafana")
		// A value YAML cannot marshal — the render must fail rather than write a broken manifest.
		bad.Values = map[string]interface{}{"ch": make(chan int)}
		vc := &types.ProjectConfig{AddOns: []types.AddOnInstall{bad}}
		vc.Repositories.AppsDestinationRepo = "file://" + bare

		err := writeAddOnGitOps(context.Background(), vc, "tok", nil, io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "render gitops add-on") {
			t.Fatalf("want the render failure named, got: %v", err)
		}
	})

	t.Run("a manifest path outside the addons directory", func(t *testing.T) {
		bare := newBareAppsRepo(t, nil)
		// An id carrying a separator resolves under a directory that does not exist, so the
		// write fails. The failure must surface rather than silently seed nothing.
		vc := &types.ProjectConfig{AddOns: []types.AddOnInstall{provGitopsAddOn("nested/grafana")}}
		vc.Repositories.AppsDestinationRepo = "file://" + bare

		if err := writeAddOnGitOps(context.Background(), vc, "tok", nil, io.Discard, io.Discard); err == nil {
			t.Fatal("want the manifest write failure to propagate")
		}
	})

	t.Run("no git identity to commit with", func(t *testing.T) {
		bare := newBareAppsRepo(t, nil)
		vc := &types.ProjectConfig{AddOns: []types.AddOnInstall{provGitopsAddOn("grafana")}}
		vc.Repositories.AppsDestinationRepo = "file://" + bare
		// newBareAppsRepo installed a HOME holding a .gitconfig; take it away so the commit
		// cannot resolve an author. CI has no global identity either — this is that case.
		t.Setenv("HOME", t.TempDir())

		err := writeAddOnGitOps(context.Background(), vc, "tok", nil, io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "commit add-on manifests") {
			t.Fatalf("want the commit failure named, got: %v", err)
		}
	})
}

// TestProv_PruneOrphanAddOnManifestsOnlyTouchesOurOwn pins the ownership rule the prune lane
// exists for: only files WE authored are removable, and anything unreadable or not a manifest
// is left alone.
func TestProv_PruneOrphanAddOnManifestsOnlyTouchesOurOwn(t *testing.T) {
	dir := t.TempDir()
	ours := "metadata:\n  labels:\n    alethia.io/managed-by: addon-marketplace\n"
	writeFileT(t, dir, "orphan.yaml", ours)
	writeFileT(t, dir, "kept.yaml", ours)          // still desired
	writeFileT(t, dir, "customer.yaml", "kind: X") // not ours
	writeFileT(t, dir, "notes.txt", ours)          // not a manifest
	if err := os.MkdirAll(filepath.Join(dir, "nested.yaml"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A dangling symlink: listed by ReadDir, unreadable by ReadFile — must be skipped, not fatal.
	if err := os.Symlink(filepath.Join(dir, "absent"), filepath.Join(dir, "broken.yaml")); err != nil {
		t.Fatal(err)
	}

	desired := map[string]types.AddOnInstall{"kept": provGitopsAddOn("kept")}
	var out strings.Builder
	removed := pruneOrphanAddOnManifests(dir, desired, &out, io.Discard)
	if removed != 1 {
		t.Fatalf("removed = %d, want only our own orphan", removed)
	}
	for _, keep := range []string{"kept.yaml", "customer.yaml", "notes.txt", "nested.yaml", "broken.yaml"} {
		if _, err := os.Lstat(filepath.Join(dir, keep)); err != nil {
			t.Errorf("%s must be left alone: %v", keep, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "orphan.yaml")); !os.IsNotExist(err) {
		t.Errorf("our orphan should be gone, got: %v", err)
	}
	if !strings.Contains(out.String(), "Pruned GitOps add-on manifest") {
		t.Errorf("the prune must be reported:\n%s", out.String())
	}
}

// TestProv_PruneOrphanAddOnManifestsIsNonFatal pins that an unreadable directory (or a file we
// cannot remove) degrades to "pruned nothing" rather than failing a deploy.
func TestProv_PruneOrphanAddOnManifestsIsNonFatal(t *testing.T) {
	if got := pruneOrphanAddOnManifests(filepath.Join(t.TempDir(), "absent"), nil, io.Discard, io.Discard); got != 0 {
		t.Fatalf("an unreadable addons dir must prune nothing, got %d", got)
	}
}
