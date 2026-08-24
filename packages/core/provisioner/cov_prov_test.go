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
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/selfimage"
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
		// A namespace carrying an unclosed YAML flow sequence renders a manifest the label
		// injector cannot re-parse. That is the reachable render failure: it must be REPORTED
		// rather than committing a manifest ArgoCD would reject.
		bad.Namespace = "[unclosed"
		vc := &types.ProjectConfig{AddOns: []types.AddOnInstall{bad}}
		vc.Repositories.AppsDestinationRepo = "file://" + bare

		labels := map[string]string{"alethia.io/environment-id": "env-1"}
		err := writeAddOnGitOps(context.Background(), vc, "tok", labels, io.Discard, io.Discard)
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

// ─────────────────────────── apps-repo scaffold failures ───────────────────────────

// provAppsRepoConfig is a project that scaffolds `services` into the bare apps repo at `bare`.
func provAppsRepoConfig(bare string, services ...types.ProjectServiceConfig) *types.ProjectConfig {
	vc := &types.ProjectConfig{ProjectName: "acme", Provider: types.CloudProviderAws}
	vc.Repositories.AppsDestinationRepo = "file://" + bare
	vc.Services = services
	return vc
}

// provFreezeTree makes every directory under root read-only (r-x) and restores it before the
// enclosing t.TempDir cleanup runs, so a git PUSH into it cannot create objects and a file inside
// it cannot be unlinked. Cleanups run LIFO and t.TempDir registered its own earlier, so the
// restore always wins the race.
func provFreezeTree(t *testing.T, root string) {
	t.Helper()
	var dirs []string
	if err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			dirs = append(dirs, path)
		}
		return nil
	}); err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	t.Cleanup(func() {
		for _, d := range dirs {
			_ = os.Chmod(d, 0o755)
		}
	})
	// Deepest first, so a parent is still writable while its children are being locked.
	for i := len(dirs) - 1; i >= 0; i-- {
		if err := os.Chmod(dirs[i], 0o500); err != nil {
			t.Fatalf("chmod %s: %v", dirs[i], err)
		}
	}
}

// blockManifestPath makes `name` inside dir a DIRECTORY, so os.WriteFile to that exact path fails.
func blockManifestPath(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
		t.Fatalf("block %s: %v", name, err)
	}
}

// TestProv_GenerateAppManifestsReportsEveryRepoFailure walks the scaffold lane's failure modes.
// Each one must be REPORTED: a silent failure here leaves the customer's GitOps repo without the
// manifests the console says were deployed, and ArgoCD syncing nothing looks exactly like success.
func TestProv_GenerateAppManifestsReportsEveryRepoFailure(t *testing.T) {
	t.Run("no temp dir to stage the clone", func(t *testing.T) {
		bare := newBareAppsRepo(t, nil)
		vc := provAppsRepoConfig(bare, imageService("web", "nginx:1.27"))
		provNoTempDir(t) // after the fixture — the fixture needs a working TMPDIR of its own

		if _, _, err := generateAppManifests(context.Background(), vc, nil, "tok", nil, io.Discard, io.Discard); err == nil {
			t.Fatal("want the temp-dir failure to propagate")
		}
	})

	t.Run("the apps repo cannot be cloned", func(t *testing.T) {
		hermeticGitIdentity(t)
		vc := provAppsRepoConfig(filepath.Join(t.TempDir(), "no-such-repo"), imageService("web", "nginx:1.27"))

		_, _, err := generateAppManifests(context.Background(), vc, nil, "tok", nil, io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "clone apps repo") {
			t.Fatalf("want the clone failure named, got: %v", err)
		}
	})

	t.Run("a manifest path is blocked by a customer directory", func(t *testing.T) {
		// `web.yaml` exists as a DIRECTORY in the repo. hasManifests only counts FILES, so the
		// bring-your-own guard does not trip and the write is attempted — and must fail loudly
		// rather than push a commit missing the service the console promised.
		bare := newBareAppsRepo(t, map[string]string{"web.yaml/keep.txt": "customer file\n"})
		vc := provAppsRepoConfig(bare, imageService("web", "nginx:1.27"))

		if _, _, err := generateAppManifests(context.Background(), vc, nil, "tok", nil, io.Discard, io.Discard); err == nil {
			t.Fatal("want the manifest write failure to propagate")
		}
	})

	t.Run("no git identity to commit with", func(t *testing.T) {
		bare := newBareAppsRepo(t, nil)
		vc := provAppsRepoConfig(bare, imageService("web", "nginx:1.27"))
		// Take the fixture's .gitconfig away: go-git then cannot resolve an author. CI has no
		// global identity either — this is that case.
		t.Setenv("HOME", t.TempDir())

		_, _, err := generateAppManifests(context.Background(), vc, nil, "tok", nil, io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "commit generated manifests") {
			t.Fatalf("want the commit failure named, got: %v", err)
		}
	})

	t.Run("the apps repo cannot be pushed to", func(t *testing.T) {
		bare := newBareAppsRepo(t, nil)
		vc := provAppsRepoConfig(bare, imageService("web", "nginx:1.27"))
		provFreezeTree(t, bare) // readable (the clone works), unwritable (the push does not)

		_, _, err := generateAppManifests(context.Background(), vc, nil, "tok", nil, io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "push generated manifests") {
			t.Fatalf("want the push failure named, got: %v", err)
		}
	})
}

// TestProv_GenerateAppManifestsAttachesTheRegistryPullSecret pins #1007's last hop: a project
// pulling from a PRIVATE pluggable registry must render imagePullSecrets onto the generated pods,
// or the dockerconfigjson Secret the registry module creates is orphaned and every pull 401s.
func TestProv_GenerateAppManifestsAttachesTheRegistryPullSecret(t *testing.T) {
	bare := newBareAppsRepo(t, nil)
	vc := provAppsRepoConfig(bare, imageService("web", "private.example.com/web:1.0"))
	vc.ContainerRegistries = []types.ProjectContainerRegistryConfig{{Name: "app", Provider: "dockerhub"}}

	if _, _, err := generateAppManifests(context.Background(), vc, nil, "tok", nil, io.Discard, io.Discard); err != nil {
		t.Fatalf("generateAppManifests: %v", err)
	}
	body := readBareRepo(t, bare)["web.yaml"]
	if !strings.Contains(body, "dockerhub-pull") {
		t.Errorf("the generated pod does not reference the registry pull secret:\n%s", body)
	}
}

// TestProv_GenerateAppManifestsLogsKeylessBindingDecisions pins that a keyless DB binding's
// decision reaches the JOB LOG, not only the returned record. A fail-closed keyless binding is the
// one outcome nobody should have to go digging through execution_metadata for.
func TestProv_GenerateAppManifestsLogsKeylessBindingDecisions(t *testing.T) {
	t.Setenv("ALETHIA_KEYLESS_DB_AUTH_ENABLED", "true")
	bare := newBareAppsRepo(t, nil)

	iam := true
	svc := imageService("web", "nginx:1.27")
	svc.Bindings = []types.ServiceBinding{{
		Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"},
		Inject: []types.ServiceBindingInjection{{Env: "DB_PASSWORD", From: "password"}},
	}}
	vc := provAppsRepoConfig(bare, svc)
	vc.Databases = []types.ProjectDatabaseConfig{{Name: "primary", EngineFamily: "postgres", IamAuth: &iam}}

	var out strings.Builder
	_, keyless, err := generateAppManifests(context.Background(), vc, nil, "tok", nil, &out, io.Discard)
	if err != nil {
		t.Fatalf("generateAppManifests: %v\nlog:\n%s", err, out.String())
	}
	if len(keyless) == 0 {
		t.Fatal("a binding to an iam_auth database must produce a keyless decision record")
	}
	if !strings.Contains(out.String(), "Keyless DB binding web→database/primary") {
		t.Errorf("the keyless decision never reached the job log:\n%s", out.String())
	}
}

// ─────────────────────────── keyless bootstrap Jobs ───────────────────────────

// provKeylessBootstrapOpts are the render inputs an AWS keyless bootstrap Job needs: the RDS
// endpoint, its database name and the master-credentials secret the admin ExternalSecret reads.
func provKeylessBootstrapOpts() manifests.Options {
	return manifests.Options{
		Namespace:     appNamespace,
		Provider:      "aws",
		KeylessDBAuth: true,
		RunnerImage:   "ghcr.io/alethialabs-io/runner:cov",
		Databases:     []types.ProjectDatabaseConfig{{Name: "primary", EngineFamily: "postgres"}},
		Outputs: map[string]string{
			"rds_cluster_endpoint":               "db.example.internal",
			"rds_database_name":                  "appdb",
			"rds_master_credentials_secret_name": "acme/rds/master",
		},
	}
}

// provKeylessBoundProject is a project whose two services both bind the SAME iam_auth database, so
// the bootstrap lane's per-database dedup is observable.
func provKeylessBoundProject() *types.ProjectConfig {
	iam := true
	bind := []types.ServiceBinding{{
		Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"},
		Inject: []types.ServiceBindingInjection{{Env: "DB_PASSWORD", From: "password"}},
	}}
	web := imageService("web", "nginx:1.27")
	web.Bindings = bind
	api := imageService("api", "api:1.0")
	api.Bindings = bind
	return &types.ProjectConfig{
		Services:  []types.ProjectServiceConfig{web, api},
		Databases: []types.ProjectDatabaseConfig{{Name: "primary", EngineFamily: "postgres", IamAuth: &iam}},
	}
}

// TestProv_WriteBootstrapJobsRendersOnePerKeylessDatabase drives the #722 R5 lane: without the
// one-shot PreSync Job a keyless app has an identity but no role to log in as. Two services
// binding one database must share ONE Job — two would race to create the same role.
func TestProv_WriteBootstrapJobsRendersOnePerKeylessDatabase(t *testing.T) {
	dir := t.TempDir()
	skips, count, err := writeBootstrapJobs(dir, provKeylessBoundProject(), provKeylessBootstrapOpts(), io.Discard)
	if err != nil {
		t.Fatalf("writeBootstrapJobs: %v", err)
	}
	if len(skips) != 0 {
		t.Errorf("a fully-resolved keyless database must not be skipped: %v", skips)
	}
	if count != 1 {
		t.Fatalf("two services binding one database must share ONE bootstrap Job, got %d", count)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var job, adminES bool
	for _, e := range entries {
		switch {
		case strings.HasSuffix(e.Name(), "-admin-externalsecret.yaml"):
			adminES = true
		case strings.HasSuffix(e.Name(), ".yaml"):
			job = true
		}
	}
	if !job || !adminES {
		t.Errorf("want the Job and its admin ExternalSecret written, got %v", entries)
	}
}

// TestProv_WriteBootstrapJobsReportsWhatItCannotRender pins the fail-closed-but-non-fatal rule:
// an unrenderable Job is REPORTED (the app still deploys, its binding fail-closes in lock-step),
// and a Job that cannot be WRITTEN is fatal — a half-written manifest set must not be committed.
func TestProv_WriteBootstrapJobsReportsWhatItCannotRender(t *testing.T) {
	t.Run("keyless off renders nothing", func(t *testing.T) {
		opts := provKeylessBootstrapOpts()
		opts.KeylessDBAuth = false
		skips, count, err := writeBootstrapJobs(t.TempDir(), provKeylessBoundProject(), opts, io.Discard)
		if err != nil || count != 0 || len(skips) != 0 {
			t.Fatalf("keyless off must be a no-op, got skips=%v count=%d err=%v", skips, count, err)
		}
	})

	t.Run("an unsupported cloud is reported, not fatal", func(t *testing.T) {
		opts := provKeylessBootstrapOpts()
		opts.Provider = "hetzner"
		var out strings.Builder
		skips, count, err := writeBootstrapJobs(t.TempDir(), provKeylessBoundProject(), opts, &out)
		if err != nil {
			t.Fatalf("an unrenderable Job must never be fatal: %v", err)
		}
		if count != 0 || len(skips) != 1 {
			t.Fatalf("want exactly one reported skip and no Job, got skips=%v count=%d", skips, count)
		}
		if !strings.Contains(out.String(), "Bootstrap Job skipped") {
			t.Errorf("the skip never reached the job log:\n%s", out.String())
		}
	})

	t.Run("a Job that cannot be written is fatal", func(t *testing.T) {
		dir := t.TempDir()
		// Block the Job's own filename with a directory: the write fails, and a partially seeded
		// manifest set must stop the deploy rather than be committed.
		blockManifestPath(t, dir, manifests.BootstrapJobName(
			types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"})+".yaml")

		if _, _, err := writeBootstrapJobs(dir, provKeylessBoundProject(), provKeylessBootstrapOpts(), io.Discard); err == nil {
			t.Fatal("want the Job write failure to propagate")
		}
	})
}

// ─────────────────────────── cross-account registry refresher ───────────────────────────

// provKeylessRegistryProject selects one cross-account keyless registry with the given
// provider_config (keyless connectors carry no credentials — only provider_config).
func provKeylessRegistryProject(slug string, pc map[string]any) *types.ProjectConfig {
	return &types.ProjectConfig{
		ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "app", Provider: slug, ProviderConfig: pc}},
	}
}

// provEcrXacctConfig is a complete cross-account ECR provider_config.
func provEcrXacctConfig() map[string]any {
	return map[string]any{
		"target_account_id": "111111111111", "region": "us-east-1",
		"registry_host":   "111111111111.dkr.ecr.us-east-1.amazonaws.com",
		"target_role_arn": "arn:aws:iam::111111111111:role/pull",
	}
}

// TestProv_WriteRegistryRefresherIsDarkUntilFlagged pins the "byte-identical with the flag off"
// contract: no ALETHIA_XACCT_REGISTRY_ENABLED, no rendered refresher, whatever is connected.
func TestProv_WriteRegistryRefresherIsDarkUntilFlagged(t *testing.T) {
	dir := t.TempDir()
	vc := provKeylessRegistryProject("ecr-xacct", provEcrXacctConfig())

	skips, err := writeRegistryRefresher(dir, vc, map[string]string{"ecr_pull_irsa_arn": "arn:aws:iam::222:role/cluster"}, io.Discard)
	if err != nil || len(skips) != 0 {
		t.Fatalf("the flag is off — nothing may render: skips=%v err=%v", skips, err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("the flag is off but files were written: %v", entries)
	}
}

// provKeylessRegistryCase is one cloud's cross-account registry: its connector config, the tofu
// pull-identity output the refresher needs, and the KSA annotation that proves it was wired.
type provKeylessRegistryCase struct {
	slug        string
	pc          map[string]any
	outputKey   string
	outputValue string
	wantAnn     string
}

// provKeylessRegistryCases covers all three keyless registry clouds.
func provKeylessRegistryCases() []provKeylessRegistryCase {
	return []provKeylessRegistryCase{
		{
			slug:        "ecr-xacct",
			pc:          provEcrXacctConfig(),
			outputKey:   "ecr_pull_irsa_arn",
			outputValue: "arn:aws:iam::222222222222:role/cluster-pull",
			wantAnn:     "eks.amazonaws.com/role-arn",
		},
		{
			slug: "gar-xacct",
			pc: map[string]any{
				"target_project_id": "acme-prod", "region": "europe-west1",
				"registry_host":          "europe-west1-docker.pkg.dev",
				"target_service_account": "reader@acme-prod.iam.gserviceaccount.com",
			},
			outputKey:   "gar_pull_gsa_email",
			outputValue: "pull@cluster.iam.gserviceaccount.com",
			wantAnn:     "iam.gke.io/gcp-service-account",
		},
		{
			slug: "acr-xacct",
			pc: map[string]any{
				"target_subscription_id":    "00000000-0000-0000-0000-000000000000",
				"registry_host":             "acme.azurecr.io",
				"target_identity_client_id": "11111111-1111-1111-1111-111111111111",
			},
			outputKey:   "acr_pull_client_id",
			outputValue: "22222222-2222-2222-2222-222222222222",
			wantAnn:     "azure.workload.identity/client-id",
		},
	}
}

// TestProv_WriteRegistryRefresherFailsClosedPerCloud walks each keyless registry cloud with its
// pull-identity output ABSENT. Every one must be reported and render nothing: a refresher without
// its Workload Identity cannot mint a token, and a silent no-op would leave the pull 401ing with
// nothing in the job log to explain it.
func TestProv_WriteRegistryRefresherFailsClosedPerCloud(t *testing.T) {
	t.Setenv("ALETHIA_XACCT_REGISTRY_ENABLED", "true")
	for _, tc := range provKeylessRegistryCases() {
		t.Run(tc.slug, func(t *testing.T) {
			dir := t.TempDir()
			var out strings.Builder
			skips, err := writeRegistryRefresher(dir, provKeylessRegistryProject(tc.slug, tc.pc), nil, &out)
			if err != nil {
				t.Fatalf("a missing pull identity must be reported, not fatal: %v", err)
			}
			if len(skips) != 1 || !strings.Contains(skips[0], tc.outputKey) {
				t.Fatalf("want the missing output %q named, got %v", tc.outputKey, skips)
			}
			if !strings.Contains(out.String(), "Registry refresher skipped") {
				t.Errorf("the skip never reached the job log:\n%s", out.String())
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 0 {
				t.Errorf("fail-closed must write nothing, got %v", entries)
			}
		})
	}
}

// TestProv_WriteRegistryRefresherRendersEachCloudWhenWired is the other half: with the pull
// identity present each cloud renders its refresher, annotated to that cloud's Workload Identity.
func TestProv_WriteRegistryRefresherRendersEachCloudWhenWired(t *testing.T) {
	t.Setenv("ALETHIA_XACCT_REGISTRY_ENABLED", "true")
	t.Setenv(selfimage.EnvOverride, "ghcr.io/alethialabs-io/runner:cov")
	// The pull Secret is seeded against the CLUSTER since #2435 rather than committed to the apps
	// repo — stub it, there is no kubectl here.
	stubPullSecretSeed(t, nil)
	for _, tc := range provKeylessRegistryCases() {
		t.Run(tc.slug, func(t *testing.T) {
			dir := t.TempDir()
			outputs := map[string]string{tc.outputKey: tc.outputValue}
			skips, err := writeRegistryRefresher(dir, provKeylessRegistryProject(tc.slug, tc.pc), outputs, io.Discard)
			if err != nil || len(skips) != 0 {
				t.Fatalf("a fully-wired keyless registry must render: skips=%v err=%v", skips, err)
			}
			body, readErr := os.ReadFile(filepath.Join(dir, "registry-pull-refresher.yaml"))
			if readErr != nil {
				t.Fatalf("no refresher was written: %v", readErr)
			}
			if !strings.Contains(string(body), tc.wantAnn) {
				t.Errorf("the KSA is not annotated to the %s pull identity:\n%s", tc.slug, body)
			}
		})
	}
}

// TestProv_WriteRegistryRefresherReportsRenderAndWriteFailures covers the remaining exits: a
// misconfigured connector (fail-closed, reported), a render that cannot complete without a runner
// image (reported), and a manifest that cannot be written (fatal — never a half-seeded repo).
func TestProv_WriteRegistryRefresherReportsRenderAndWriteFailures(t *testing.T) {
	t.Setenv("ALETHIA_XACCT_REGISTRY_ENABLED", "true")
	wired := map[string]string{"ecr_pull_irsa_arn": "arn:aws:iam::222222222222:role/cluster-pull"}

	t.Run("a misconfigured keyless connector is reported", func(t *testing.T) {
		var out strings.Builder
		skips, err := writeRegistryRefresher(t.TempDir(), provKeylessRegistryProject("ecr-xacct", nil), wired, &out)
		if err != nil {
			t.Fatalf("a misconfigured connector must be reported, not fatal: %v", err)
		}
		if len(skips) != 1 || !strings.Contains(skips[0], "keyless registry:") {
			t.Fatalf("want the connector misconfiguration reported, got %v", skips)
		}
		if !strings.Contains(out.String(), "Registry refresher skipped") {
			t.Errorf("the skip never reached the job log:\n%s", out.String())
		}
	})

	t.Run("no runner image to run the refresher with", func(t *testing.T) {
		// selfimage.Ref() resolves from the environment; with both keys empty the refresher has no
		// image to run, which must fail CLOSED (reported, nothing rendered) rather than emit a
		// Deployment with an empty image reference.
		t.Setenv(selfimage.EnvOverride, "")
		t.Setenv(selfimage.EnvBaked, "")
		dir := t.TempDir()
		skips, err := writeRegistryRefresher(dir, provKeylessRegistryProject("ecr-xacct", provEcrXacctConfig()), wired, io.Discard)
		if err != nil {
			t.Fatalf("a render failure must be reported, not fatal: %v", err)
		}
		if len(skips) != 1 || !strings.Contains(skips[0], "pull refresher not rendered") {
			t.Fatalf("want the render failure reported, got %v", skips)
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 0 {
			t.Errorf("a failed render must write nothing, got %v", entries)
		}
	})

	t.Run("the manifest cannot be written", func(t *testing.T) {
		t.Setenv(selfimage.EnvOverride, "ghcr.io/alethialabs-io/runner:cov")
		stubPullSecretSeed(t, nil)
		dir := t.TempDir()
		blockManifestPath(t, dir, "registry-pull-refresher.yaml")

		if _, err := writeRegistryRefresher(dir, provKeylessRegistryProject("ecr-xacct", provEcrXacctConfig()), wired, io.Discard); err == nil {
			t.Fatal("want the refresher write failure to propagate")
		}
	})
}

// TestProv_RenderKeylessHelmRefreshersReportsARenderFailure pins the last fail-closed exit of the
// #1185 lane: targets and a pull identity present, but nothing to run the refresher with. It must
// report a Skip and render no manifest — never a Deployment with an empty image.
func TestProv_RenderKeylessHelmRefreshersReportsARenderFailure(t *testing.T) {
	res := renderKeylessHelmRefreshers(ecrHelmProject(), "arn:aws:iam::111:role/helm-pull", "")
	if res.Manifest != "" {
		t.Fatal("a failed render must produce no manifest (fail-closed)")
	}
	if !strings.Contains(res.Skip, "not rendered (fail-closed)") {
		t.Fatalf("want the render failure reported as a fail-closed skip, got %q", res.Skip)
	}
	if len(res.DesiredSecrets) != 0 || len(res.DesiredRefreshers) != 0 {
		t.Errorf("nothing rendered ⇒ nothing desired, got %+v", res)
	}
}

// ─────────────────────────── binding ExternalSecrets ───────────────────────────

// provBoundService returns a service named `name` carrying one binding to `target` injecting
// exactly the facets in `from`.
func provBoundService(name string, target types.ServiceBindingTarget, from ...string) types.ProjectServiceConfig {
	inj := make([]types.ServiceBindingInjection, 0, len(from))
	for _, f := range from {
		inj = append(inj, types.ServiceBindingInjection{Env: strings.ToUpper(f), From: types.ServiceBindingFacet(f)})
	}
	s := imageService(name, "nginx:1.27")
	s.Bindings = []types.ServiceBinding{{Target: target, Inject: inj}}
	return s
}

// TestProv_WriteBindingExternalSecretsSkipsFacetlessBindings pins that a binding with no
// CREDENTIAL facet needs no Secret at all — an endpoint/port injection is a templated tofu output,
// and writing an empty ExternalSecret for it would block the pod on a Secret ESO never fills.
func TestProv_WriteBindingExternalSecretsSkipsFacetlessBindings(t *testing.T) {
	dir := t.TempDir()
	vc := &types.ProjectConfig{
		Provider: types.CloudProviderAws,
		Services: []types.ProjectServiceConfig{
			provBoundService("web", types.ServiceBindingTarget{Kind: types.ServiceBindingKindSecret, Name: "api-key"}, "endpoint"),
			provBoundService("api", types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}, "endpoint"),
		},
	}
	skips, count, err := writeBindingExternalSecrets(dir, vc, nil, false, nil, io.Discard)
	if err != nil {
		t.Fatalf("writeBindingExternalSecrets: %v", err)
	}
	if count != 0 || len(skips) != 0 {
		t.Fatalf("a facet-less binding needs no ExternalSecret and no report, got count=%d skips=%v", count, skips)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("nothing should have been written, got %v", entries)
	}
}

// TestProv_WriteBindingExternalSecretsFailsOnAnUnwritableManifest pins that a Secret manifest that
// cannot be written stops the scaffold. Continuing would commit app manifests whose secretKeyRef
// points at a Secret this lane never created — a pod stuck on CreateContainerConfigError forever.
func TestProv_WriteBindingExternalSecretsFailsOnAnUnwritableManifest(t *testing.T) {
	t.Run("a project-secret binding", func(t *testing.T) {
		dir := t.TempDir()
		target := types.ServiceBindingTarget{Kind: types.ServiceBindingKindSecret, Name: "api-key"}
		blockManifestPath(t, dir, manifests.BindingSecretName("web", target)+"-externalsecret.yaml")

		vc := &types.ProjectConfig{
			Provider: types.CloudProviderAws,
			Services: []types.ProjectServiceConfig{provBoundService("web", target, "value")},
		}
		stores := map[string]manifests.SecretStoreRef{"api-key": {StoreName: "secretstore-vault", ValueProperty: "value"}}
		if _, _, err := writeBindingExternalSecrets(dir, vc, nil, false, stores, io.Discard); err == nil {
			t.Fatal("want the ExternalSecret write failure to propagate")
		}
	})

	t.Run("a cloud credential binding", func(t *testing.T) {
		dir := t.TempDir()
		target := types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}
		blockManifestPath(t, dir, manifests.BindingSecretName("web", target)+"-externalsecret.yaml")

		vc := &types.ProjectConfig{
			Provider: types.CloudProviderAws,
			Services: []types.ProjectServiceConfig{provBoundService("web", target, "password")},
		}
		outputs := map[string]string{"rds_master_credentials_secret_name": "acme/rds/master"}
		if _, _, err := writeBindingExternalSecrets(dir, vc, outputs, false, nil, io.Discard); err == nil {
			t.Fatal("want the ExternalSecret write failure to propagate")
		}
	})
}

// ─────────────────────────── BYO IaC workdir edges ───────────────────────────

// TestProv_PrepareByoIacWorkdirRejectsAMalformedSource pins the two preconditions ahead of the
// URL transport gate: a call with no source at all, and a source with no repo to fetch.
func TestProv_PrepareByoIacWorkdirRejectsAMalformedSource(t *testing.T) {
	cases := []struct {
		name string
		src  *types.ProjectIacSourceConfig
		want string
	}{
		{name: "no IaC source", src: nil, want: "without an IacSource"},
		{name: "no repo url", src: &types.ProjectIacSourceConfig{Ref: "main", CommitSHA: "abc"}, want: "missing repo_url"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vc := provConfig()
			vc.IacSource = tc.src
			_, _, _, err := prepareByoIacWorkdir(context.Background(), vc, "", t.TempDir(), io.Discard, io.Discard)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want an error containing %q, got: %v", tc.want, err)
			}
		})
	}
}

// TestProv_PrepareByoIacWorkdirClonesWithAToken drives the tokened clone transport — the
// production shape, a PRIVATE customer repo — and pins that the token never reaches the job log.
// It also covers the module-resolution exit past it: a path that is not in the repo must stop the
// flow BEFORE `tofu`, because a module we could not fully prepare is a module we never vetted.
func TestProv_PrepareByoIacWorkdirClonesWithAToken(t *testing.T) {
	allowInsecureRepoURLForTest = true
	t.Cleanup(func() { allowInsecureRepoURLForTest = false })
	repo, branch, sha := gitInitModuleRepo(t, validModuleTF)

	newVC := func(path string) *types.ProjectConfig {
		vc := provConfig()
		vc.IacSource = &types.ProjectIacSourceConfig{
			RepoURL: "file://" + repo, Ref: branch, CommitSHA: sha, Path: path,
		}
		return vc
	}

	t.Run("a tokened clone reaches the module", func(t *testing.T) {
		var out strings.Builder
		tfDir, _, restore, err := prepareByoIacWorkdir(context.Background(), newVC("module"), "ghp_covtoken", filepath.Join(t.TempDir(), "clone"), &out, io.Discard)
		if err != nil {
			t.Fatalf("prepareByoIacWorkdir with a token: %v\nlog:\n%s", err, out.String())
		}
		if restore != nil {
			restore()
		}
		if _, statErr := os.Stat(filepath.Join(tfDir, byoBackendOverrideFile)); statErr != nil {
			t.Errorf("the platform backend override was not written: %v", statErr)
		}
		if strings.Contains(out.String(), "ghp_covtoken") {
			t.Errorf("the git token leaked into the job log:\n%s", out.String())
		}
	})

	t.Run("the module path is not in the repo", func(t *testing.T) {
		_, _, _, err := prepareByoIacWorkdir(context.Background(), newVC("no-such-module"), "", filepath.Join(t.TempDir(), "clone"), io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "not found in repository") {
			t.Fatalf("want the missing module path named, got: %v", err)
		}
	})
}

// TestProv_ResolveByoModuleDirRejectsANonDirectory pins that a module path pointing at a FILE is
// rejected — running tofu in a non-directory would fail late and opaquely.
func TestProv_ResolveByoModuleDirRejectsANonDirectory(t *testing.T) {
	clone := t.TempDir()
	if err := os.WriteFile(filepath.Join(clone, "main.tf"), []byte("# not a module dir\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveByoModuleDir(clone, "main.tf"); err == nil ||
		!strings.Contains(err.Error(), "is not a directory") {
		t.Fatalf("want the not-a-directory refusal, got: %v", err)
	}
}

// TestProv_WriteByoBackendOverrideReportsAWriteFailure pins that an override the platform cannot
// write is an ERROR: silently continuing would run the customer's own backend, putting the
// environment's state somewhere Alethia can neither read nor protect.
func TestProv_WriteByoBackendOverrideReportsAWriteFailure(t *testing.T) {
	dir := t.TempDir()
	blockManifestPath(t, dir, byoBackendOverrideFile)

	err := writeByoBackendOverride(dir)
	if err == nil || !strings.Contains(err.Error(), byoBackendOverrideFile) {
		t.Fatalf("want the blocked override file named, got: %v", err)
	}
}

// TestProv_ScanByoIacFailClosedRunsAndWarns pins both halves of the inline gate: a module it
// cannot even scan BLOCKS (fail-closed), and a warning-severity finding is SURFACED without
// blocking — a customer declaring their own backend is told, not refused.
func TestProv_ScanByoIacFailClosedRunsAndWarns(t *testing.T) {
	t.Run("an unscannable module blocks", func(t *testing.T) {
		err := scanByoIacFailClosed(filepath.Join(t.TempDir(), "absent"), io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "failed to run (fail-closed)") {
			t.Fatalf("want the fail-closed scan error, got: %v", err)
		}
	})

	t.Run("a warning is surfaced without blocking", func(t *testing.T) {
		dir := t.TempDir()
		// A customer-declared backend is a WARNING: the platform override replaces it, so the deploy
		// proceeds — but the operator must be told their backend block is being ignored.
		body := "terraform {\n  backend \"local\" {}\n}\n\nresource \"null_resource\" \"x\" {}\n"
		if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		var out, errOut strings.Builder
		if err := scanByoIacFailClosed(dir, &out, &errOut); err != nil {
			t.Fatalf("a warning-only module must pass the gate: %v", err)
		}
		if !strings.Contains(errOut.String(), "BYO IaC gate warning") {
			t.Errorf("the warning was never surfaced:\n%s", errOut.String())
		}
		if !strings.Contains(out.String(), "BYO IaC static gate: OK") {
			t.Errorf("the gate result was never reported:\n%s", out.String())
		}
	})
}

// TestProv_SetByoAlethiaTFVarsRestoresWhatItReplaced pins the restore contract for a var that was
// ALREADY set: the frozen context must be published for the child tofu and then put back exactly,
// so one job's TF_VAR_ can never leak into the next on a long-lived runner.
func TestProv_SetByoAlethiaTFVarsRestoresWhatItReplaced(t *testing.T) {
	t.Setenv("TF_VAR_alethia_project", "someone-elses-project")
	if _, had := os.LookupEnv("TF_VAR_alethia_region"); had {
		t.Skip("TF_VAR_alethia_region is set in the ambient environment")
	}

	vc := provConfig()
	restore := setByoAlethiaTFVars(vc)
	if got := os.Getenv("TF_VAR_alethia_project"); got != vc.ProjectName {
		t.Fatalf("TF_VAR_alethia_project = %q, want the frozen contract value %q", got, vc.ProjectName)
	}
	restore()

	if got := os.Getenv("TF_VAR_alethia_project"); got != "someone-elses-project" {
		t.Errorf("a pre-existing TF_VAR must be restored, got %q", got)
	}
	if _, had := os.LookupEnv("TF_VAR_alethia_region"); had {
		t.Errorf("a TF_VAR that did not exist must be unset again, got %q", os.Getenv("TF_VAR_alethia_region"))
	}
}

// ─────────────────────────── GitOps add-on seed edges ───────────────────────────

// TestProv_WriteAddOnGitOpsReportsAPushFailure pins that a seed which committed but could not be
// pushed is an ERROR. Returning nil would tell the console the add-on is deployed while the
// customer's repo — the only thing the app-of-apps syncs — never received it.
func TestProv_WriteAddOnGitOpsReportsAPushFailure(t *testing.T) {
	bare := newBareAppsRepo(t, nil)
	vc := &types.ProjectConfig{AddOns: []types.AddOnInstall{provGitopsAddOn("grafana")}}
	vc.Repositories.AppsDestinationRepo = "file://" + bare
	provFreezeTree(t, bare)

	err := writeAddOnGitOps(context.Background(), vc, "tok", nil, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "push add-on manifests") {
		t.Fatalf("want the push failure named, got: %v", err)
	}
}

// TestProv_PruneOrphanAddOnManifestsWarnsWhenRemoveFails pins that a manifest we own but cannot
// delete is WARNED about and not counted — reporting it as pruned would claim a sweep that never
// happened, and the stale Application would keep syncing.
func TestProv_PruneOrphanAddOnManifestsWarnsWhenRemoveFails(t *testing.T) {
	dir := t.TempDir()
	writeFileT(t, dir, "orphan.yaml", "metadata:\n  labels:\n    alethia.io/managed-by: addon-marketplace\n")
	provFreezeTree(t, dir) // the file stays readable; its directory denies the unlink

	var errOut strings.Builder
	if got := pruneOrphanAddOnManifests(dir, nil, io.Discard, &errOut); got != 0 {
		t.Fatalf("a manifest that could not be removed must not be counted, got %d", got)
	}
	if !strings.Contains(errOut.String(), "could not prune add-on manifest") {
		t.Errorf("the failed prune must be warned about, got:\n%s", errOut.String())
	}
}

// ─────────────────────────── destroy-plan workdir edges ───────────────────────────

// TestProv_DestroyPlanRejectsAnUnbuildableWorkdir pins that the read-only teardown refuses the
// same way the applying one does. A plan built from a workdir we could not assemble would not
// describe the teardown RunDestroy performs — which is the whole invariant the shared setup holds.
func TestProv_DestroyPlanRejectsAnUnbuildableWorkdir(t *testing.T) {
	cases := []struct {
		name      string
		provider  string
		absentDir bool
		want      string
	}{
		{name: "unknown cloud", provider: "not-a-cloud", want: "not-a-cloud"},
		{name: "templates dir is absent", provider: "aws", absentDir: true, want: "failed to copy templates"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			templatesDir := t.TempDir()
			if tc.absentDir {
				templatesDir = filepath.Join(templatesDir, "absent")
			}
			plan, err := RunDestroyPlan(context.Background(), DestroyParams{
				DryRun:        true,
				ProjectConfig: provConfig(),
				Provider:      tc.provider,
				TemplatesDir:  templatesDir,
				StateBackend:  provBackend(t),
				Stdout:        io.Discard,
				Stderr:        io.Discard,
			})
			if err == nil {
				t.Fatalf("want an error containing %q, got plan %#v", tc.want, plan)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got: %v", tc.want, err)
			}
			if plan != nil {
				t.Errorf("a workdir that could not be built must return no plan, got %#v", plan)
			}
		})
	}
}

// ─────────────────────────── probe cluster-name synthesis ───────────────────────────

// provTofuNoClusterNameScript answers `output` with the kubeconfig alone — no cluster_name — which
// is the shape that forces the probe to synthesize the name from the config.
const provTofuNoClusterNameScript = `#!/bin/sh
printf '%s\n' "$*" >> "LOGPATH"
case "$1" in
  version)
    echo '{"terraform_version":"1.9.0","platform":"linux_amd64","provider_selections":{},"terraform_outdated":false}'
    ;;
  output)
    echo '{"kubeconfig":{"sensitive":true,"type":"string","value":"PROV-FAKE-KUBECONFIG"}}'
    ;;
esac
exit 0
`

// TestProv_ProbeSynthesizesTheClusterNameWhenTheOutputIsAbsent pins the merge the probe does before
// asking the provider for a kubeconfig: aws/gcp/azure build an exec-plugin kubeconfig from the
// cluster NAME, so an environment whose state does not carry that output must still be probeable
// from the name the config already holds — otherwise a healthy cluster reports as unreachable.
func TestProv_ProbeSynthesizesTheClusterNameWhenTheOutputIsAbsent(t *testing.T) {
	provFakeTofu(t, provTofuNoClusterNameScript)
	provStubTool(t, "kubectl", provKubectlScript)

	vc := provConfig()
	vc.Cluster.ClusterName = "cov-prov-cluster"

	res, err := RunProbe(context.Background(), ProbeParams{
		ProjectConfig: vc,
		Provider:      "aws",
		IacVersion:    "1.9.0",
		StateBackend:  provBackend(t),
		Timeout:       3 * time.Second,
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err != nil {
		t.Fatalf("RunProbe: %v", err)
	}
	if res == nil || !res.Reachable {
		t.Fatalf("the synthesized cluster name must still yield a reachable probe, got %#v", res)
	}
}

// ─────────────────────────── BYO chart binding + project edges ───────────────────────────

// TestProv_PrepareByoChartsWarnsWhenTheAppProjectCannotRender pins the best-effort posture at the
// render step: a namespace that produces an unparseable AppProject is warned about and the deploy
// continues. The charts then fail closed (no project ⇒ nothing syncs) rather than failing a cluster.
func TestProv_PrepareByoChartsWarnsWhenTheAppProjectCannotRender(t *testing.T) {
	provStubTool(t, "kubectl", "#!/bin/sh\nexit 0\n")

	vc := &types.ProjectConfig{
		ProjectName: "Acme Corp",
		AddOns: []types.AddOnInstall{
			// The namespace is emitted into a quoted YAML scalar; an embedded quote makes the
			// rendered AppProject unparseable, which the label injector reports.
			{ID: "api", Source: "git", ChartRepo: "https://github.com/acme/charts.git", Path: "charts/api", Namespace: `a"b`},
		},
	}
	var errOut strings.Builder
	if !prepareByoCharts(vc, "tok", nil, map[string]string{"alethia.io/environment-id": "env-1"}, io.Discard, &errOut) {
		t.Fatal("prepareByoCharts did not report the BYO chart")
	}
	if !strings.Contains(errOut.String(), "could not render BYO AppProject") {
		t.Errorf("the failed render must be warned about, got:\n%s", errOut.String())
	}
}
