// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package tofu

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every TofuCLI method is a thin wrapper whose whole job is ARGUMENT CONSTRUCTION: which
// flags reach the `tofu` child. The lifecycle tests prove the wrappers work against a real
// binary, but they skip wherever OpenTofu is absent — which is most CI images, so the entire
// exec surface goes unexercised there. The fake binary below closes that gap: it records its
// own argv and answers each subcommand with canned JSON, so the flags every wrapper emits are
// asserted hermetically, with no OpenTofu and no network.

// fakeTofuScript is a `tofu` stand-in. It appends its argv to logPath and prints the canned
// JSON each subcommand's parser expects. `show` distinguishes a plan read (a plan file is
// passed as the trailing argument) from a state read (no trailing argument).
const fakeTofuScript = `#!/bin/sh
printf '%s\n' "$*" >> "LOGPATH"
case "$1" in
  version)
    echo '{"terraform_version":"1.9.0","platform":"linux_amd64","provider_selections":{},"terraform_outdated":false}'
    ;;
  validate)
    echo '{"format_version":"1.0","valid":true,"error_count":0,"warning_count":0,"diagnostics":[]}'
    ;;
  output)
    echo '{"kubeconfig":{"sensitive":true,"type":"string","value":"FAKE-KUBECONFIG-VALUE"},"raw":{"sensitive":false,"type":"string","value":"plain"}}'
    ;;
  plan)
    # -detailed-exitcode: 2 means "there are changes", which is not a failure.
    exit 2
    ;;
  show)
    if [ -n "$4" ]; then
      echo '{"format_version":"1.2","terraform_version":"1.9.0","resource_changes":[{"address":"terraform_data.probe","mode":"managed","type":"terraform_data","name":"probe","provider_name":"terraform.io/builtin/terraform","change":{"actions":["create"],"before":null,"after":{}}}]}'
    else
      echo '{"format_version":"1.0","terraform_version":"1.9.0","values":{"root_module":{"resources":[{"address":"terraform_data.probe","mode":"managed","type":"terraform_data","name":"probe","provider_name":"terraform.io/builtin/terraform","values":{}}],"child_modules":[{"address":"module.net","resources":[{"address":"module.net.terraform_data.vpc","mode":"managed","type":"terraform_data","name":"vpc","provider_name":"terraform.io/builtin/terraform","values":{}}]}]}}}'
    fi
    ;;
esac
exit 0
`

// fakeTofuCLI installs the recording `tofu` stand-in on the lookPath seam and returns a
// TofuCLI over a scratch workdir, the job-log writer it streams to, and a reader for the
// argv the child was invoked with.
func fakeTofuCLI(t *testing.T) (*TofuCLI, *bytes.Buffer, func() []string) {
	t.Helper()
	resetTofuSeams(t)

	binDir := t.TempDir()
	logPath := filepath.Join(binDir, "argv.log")
	binPath := filepath.Join(binDir, "tofu")
	script := strings.ReplaceAll(fakeTofuScript, "LOGPATH", logPath)
	if err := os.WriteFile(binPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake tofu: %v", err)
	}
	lookPath = func(string) (string, error) { return binPath, nil }
	httpGet = func(context.Context, string) ([]byte, error) {
		t.Fatal("the fake tofu is on PATH; no download should be attempted")
		return nil, nil
	}

	workDir := t.TempDir()
	var logBuf bytes.Buffer
	tf, err := NewTofuCLI(context.Background(), "1.9.0", workDir, &logBuf, &logBuf)
	if err != nil {
		t.Fatalf("NewTofuCLI: %v", err)
	}

	invocations := func() []string {
		data, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatalf("read argv log: %v", err)
		}
		var out []string
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			// The version probe fires before the first real subcommand; it is not
			// part of any wrapper's argument construction.
			if line != "" && !strings.HasPrefix(line, "version ") {
				out = append(out, line)
			}
		}
		return out
	}
	return tf, &logBuf, invocations
}

// TestTofuCLI_ArgumentConstruction asserts the flags every lifecycle wrapper puts on the
// `tofu` command line, hermetically.
func TestTofuCLI_ArgumentConstruction(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		name string
		// run drives one wrapper against the fake binary.
		run func(t *testing.T, tf *TofuCLI) error
		// wantAll must all appear in the recorded argv.
		wantAll []string
		// wantNone must not appear.
		wantNone []string
	}{
		{
			name: "Init passes every backend-config pair and reconfigures",
			run: func(_ *testing.T, tf *TofuCLI) error {
				return tf.Init(ctx, map[string]string{"bucket": "alethia-state", "key": "env/1.tfstate"}, true)
			},
			wantAll: []string{
				"init", "-reconfigure", "-upgrade=true",
				"-backend-config=bucket=alethia-state",
				"-backend-config=key=env/1.tfstate",
			},
		},
		{
			name: "Init without upgrade leaves the providers pinned",
			run: func(_ *testing.T, tf *TofuCLI) error {
				return tf.Init(ctx, nil, false)
			},
			wantAll:  []string{"init", "-upgrade=false"},
			wantNone: []string{"-upgrade=true", "-backend-config="},
		},
		{
			name: "InitWithBackendFile points -backend-config at the file",
			run: func(_ *testing.T, tf *TofuCLI) error {
				return tf.InitWithBackendFile(ctx, "/work/backend.hcl", true)
			},
			wantAll: []string{"init", "-reconfigure", "-backend-config=/work/backend.hcl", "-upgrade=true"},
		},
		{
			name: "InitNoBackend disables the backend and configures none",
			run: func(_ *testing.T, tf *TofuCLI) error {
				return tf.InitNoBackend(ctx)
			},
			wantAll:  []string{"init", "-backend=false", "-reconfigure"},
			wantNone: []string{"-backend-config=", "-backend=true"},
		},
		{
			name: "Plan writes the plan file and reads the var file",
			run: func(_ *testing.T, tf *TofuCLI) error {
				_, err := tf.Plan(ctx, "/work/tofu.tfvars.json", "/work/tofu.plan.out")
				return err
			},
			wantAll:  []string{"plan", "-out=/work/tofu.plan.out", "-var-file=/work/tofu.tfvars.json", "-detailed-exitcode"},
			wantNone: []string{"-destroy", "-refresh-only"},
		},
		{
			name: "Plan omits -var-file when no vars were rendered",
			run: func(_ *testing.T, tf *TofuCLI) error {
				_, err := tf.Plan(ctx, "", "/work/tofu.plan.out")
				return err
			},
			wantAll:  []string{"plan", "-out=/work/tofu.plan.out"},
			wantNone: []string{"-var-file="},
		},
		{
			name: "PlanRefreshOnly reconciles state without proposing changes",
			run: func(_ *testing.T, tf *TofuCLI) error {
				_, err := tf.PlanRefreshOnly(ctx, "/work/tofu.tfvars.json", "/work/refresh.plan")
				return err
			},
			wantAll:  []string{"plan", "-refresh-only", "-out=/work/refresh.plan", "-var-file=/work/tofu.tfvars.json"},
			wantNone: []string{"-destroy"},
		},
		{
			name: "PlanDestroy proposes the teardown without performing it",
			run: func(_ *testing.T, tf *TofuCLI) error {
				_, err := tf.PlanDestroy(ctx, "/work/tofu.tfvars.json", "/work/destroy.plan")
				return err
			},
			wantAll:  []string{"plan", "-destroy", "-out=/work/destroy.plan", "-var-file=/work/tofu.tfvars.json"},
			wantNone: []string{"-refresh-only"},
		},
		{
			name: "Apply applies the reviewed plan file, not the directory",
			run: func(_ *testing.T, tf *TofuCLI) error {
				return tf.Apply(ctx, "/work/tofu.plan.out")
			},
			wantAll:  []string{"apply", "-auto-approve", "/work/tofu.plan.out"},
			wantNone: []string{"-var-file="},
		},
		{
			name: "Destroy passes the var file",
			run: func(_ *testing.T, tf *TofuCLI) error {
				return tf.Destroy(ctx, "/work/tofu.tfvars.json")
			},
			wantAll: []string{"destroy", "-auto-approve", "-var-file=/work/tofu.tfvars.json"},
		},
		{
			name: "Destroy without a var file",
			run: func(_ *testing.T, tf *TofuCLI) error {
				return tf.Destroy(ctx, "")
			},
			wantAll:  []string{"destroy", "-auto-approve"},
			wantNone: []string{"-var-file="},
		},
		{
			name: "Import names the address and the cloud id last",
			run: func(_ *testing.T, tf *TofuCLI) error {
				return tf.Import(ctx, "aws_vpc.main", "vpc-0123456789")
			},
			wantAll: []string{"import", "aws_vpc.main vpc-0123456789"},
		},
		{
			name: "Validate asks for machine-readable diagnostics",
			run: func(_ *testing.T, tf *TofuCLI) error {
				_, err := tf.Validate(ctx)
				return err
			},
			wantAll: []string{"validate", "-json"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tf, logBuf, invocations := fakeTofuCLI(t)
			if err := tt.run(t, tf); err != nil {
				t.Fatalf("wrapper returned %v\nlog: %s", err, logBuf)
			}
			argv := strings.Join(invocations(), "\n")
			if argv == "" {
				t.Fatal("the wrapper never invoked the tofu binary")
			}
			for _, want := range tt.wantAll {
				if !strings.Contains(argv, want) {
					t.Fatalf("argv %q is missing %q", argv, want)
				}
			}
			for _, unwanted := range tt.wantNone {
				if strings.Contains(argv, unwanted) {
					t.Fatalf("argv %q must not contain %q", argv, unwanted)
				}
			}
		})
	}
}

// TestPlan_ReportsPendingChanges covers the -detailed-exitcode mapping: exit 2 is "there are
// changes", not a failure, for all three plan wrappers.
func TestPlan_ReportsPendingChanges(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name string
		run  func(tf *TofuCLI) (bool, error)
	}{
		{name: "Plan", run: func(tf *TofuCLI) (bool, error) { return tf.Plan(ctx, "", "/work/p.out") }},
		{name: "PlanRefreshOnly", run: func(tf *TofuCLI) (bool, error) { return tf.PlanRefreshOnly(ctx, "", "/work/p.out") }},
		{name: "PlanDestroy", run: func(tf *TofuCLI) (bool, error) { return tf.PlanDestroy(ctx, "", "/work/p.out") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tf, logBuf, _ := fakeTofuCLI(t)
			changes, err := tt.run(tf)
			if err != nil {
				t.Fatalf("%s: %v\nlog: %s", tt.name, err, logBuf)
			}
			if !changes {
				t.Fatalf("%s reported no changes for exit code 2", tt.name)
			}
		})
	}
}

// TestStateResources_WalksChildModules covers the recursive walk: a resource nested in a
// child module is managed too, so it must not be reported as an orphan.
func TestStateResources_WalksChildModules(t *testing.T) {
	tf, logBuf, _ := fakeTofuCLI(t)

	addrs, err := tf.StateResources(context.Background())
	if err != nil {
		t.Fatalf("StateResources: %v\nlog: %s", err, logBuf)
	}
	want := []string{"terraform_data.probe", "module.net.terraform_data.vpc"}
	if len(addrs) != len(want) {
		t.Fatalf("StateResources = %v, want %v", addrs, want)
	}
	for i, w := range want {
		if addrs[i] != w {
			t.Fatalf("StateResources[%d] = %q, want %q", i, addrs[i], w)
		}
	}
}

// TestShowPlanJSON_ParsesTheProposedChanges covers the plan read: the wrapper must decode
// the plan file the elench gate verifies.
func TestShowPlanJSON_ParsesTheProposedChanges(t *testing.T) {
	tf, logBuf, invocations := fakeTofuCLI(t)

	plan, err := tf.ShowPlanJSON(context.Background(), "/work/tofu.plan.out")
	if err != nil {
		t.Fatalf("ShowPlanJSON: %v\nlog: %s", err, logBuf)
	}
	if plan == nil || len(plan.ResourceChanges) != 1 {
		t.Fatalf("ShowPlanJSON = %+v, want one resource change", plan)
	}
	if got := plan.ResourceChanges[0].Address; got != "terraform_data.probe" {
		t.Fatalf("planned address = %q, want terraform_data.probe", got)
	}
	if argv := strings.Join(invocations(), "\n"); !strings.Contains(argv, "/work/tofu.plan.out") {
		t.Fatalf("argv %q does not name the plan file", argv)
	}
}

// TestOutput_ReturnsValuesWithoutStreamingThem re-proves the SEC-TFOUTPUT-SCRUB seam without
// needing a real OpenTofu: the values reach the caller, the job-log writer sees nothing.
func TestOutput_ReturnsValuesWithoutStreamingThem(t *testing.T) {
	tf, logBuf, _ := fakeTofuCLI(t)

	outputs, err := tf.Output(context.Background())
	if err != nil {
		t.Fatalf("Output: %v\nlog: %s", err, logBuf)
	}
	if got, _ := outputs["kubeconfig"].(string); got != "FAKE-KUBECONFIG-VALUE" {
		t.Fatalf("kubeconfig = %q, want the decoded value", got)
	}
	if strings.Contains(logBuf.String(), "FAKE-KUBECONFIG-VALUE") {
		t.Fatalf("sensitive output reached the job-log writer:\n%s", logBuf)
	}
	// The lifecycle writer must be restored for the next command.
	if tf.stdout != io.Writer(logBuf) {
		t.Fatal("Output did not restore the lifecycle writer")
	}
}
