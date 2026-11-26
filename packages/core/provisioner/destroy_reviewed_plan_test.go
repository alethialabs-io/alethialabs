// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The reviewed destroy plan (#7455): RunDestroyPlan keeps the saved plan file for the caller, and
// RunDestroy given that file applies exactly it — never a fresh `tofu destroy`, and never a retry
// that would compute one.

package provisioner

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// reviewedPlanTofuScript is provTofuScript, except that `plan` writes the file named by `-out=` (so
// a saved plan exists to keep) and `apply` exits APPLYEXIT.
const reviewedPlanTofuScript = `#!/bin/sh
printf '%s\n' "$*" >> "LOGPATH"
case "$1" in
  version)
    echo '{"terraform_version":"1.9.0","platform":"linux_amd64","provider_selections":{},"terraform_outdated":false}'
    ;;
  output)
    echo '{}'
    ;;
  plan)
    for a in "$@"; do
      case "$a" in
        -out=*) printf 'saved-destroy-plan' > "${a#-out=}" ;;
      esac
    done
    exit 2
    ;;
  apply)
    exit APPLYEXIT
    ;;
  show)
    echo '{"format_version":"1.2","terraform_version":"1.9.0","resource_changes":[{"address":"terraform_data.probe","mode":"managed","type":"terraform_data","name":"probe","provider_name":"terraform.io/builtin/terraform","change":{"actions":["delete"],"before":{},"after":null}}]}'
    ;;
esac
exit 0
`

// reviewedPlanTofu returns reviewedPlanTofuScript with `apply` exiting `code`.
func reviewedPlanTofu(code string) string {
	return strings.ReplaceAll(reviewedPlanTofuScript, "APPLYEXIT", code)
}

// writeReviewedPlan writes a stand-in reviewed plan file and returns its path.
func writeReviewedPlan(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "plan-apply.out")
	if err := os.WriteFile(p, []byte("saved-destroy-plan"), 0o600); err != nil {
		t.Fatalf("write plan: %v", err)
	}
	return p
}

// argvLines returns the fake tofu's argv log lines that start with `sub `.
func argvLines(log, sub string) []string {
	var out []string
	for _, line := range strings.Split(log, "\n") {
		if strings.HasPrefix(line, sub+" ") {
			out = append(out, line)
		}
	}
	return out
}

// TestRunDestroyPlanKeepsThePlanFile pins that the saved destroy plan survives the workdir cleanup
// at PlanOutFile, byte for byte: it is the file a later DESTROY is bound to by digest.
func TestRunDestroyPlanKeepsThePlanFile(t *testing.T) {
	argv := provFakeTofu(t, reviewedPlanTofu("0"))
	dst := filepath.Join(t.TempDir(), "destroy.plan")

	plan, err := RunDestroyPlan(context.Background(), DestroyParams{
		DryRun:        true,
		PlanOutFile:   dst,
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
	if plan == nil {
		t.Fatal("want a decoded destroy plan")
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("the plan file was not kept at PlanOutFile: %v", err)
	}
	if !bytes.Equal(got, []byte("saved-destroy-plan")) {
		t.Errorf("kept plan = %q, want the saved plan's bytes", got)
	}
	if len(argvLines(argv(), "apply")) != 0 || len(argvLines(argv(), "destroy")) != 0 {
		t.Fatalf("planning a teardown must never apply; argv:\n%s", argv())
	}
}

// TestRunDestroyAppliesTheReviewedPlan pins the bound teardown: `tofu apply <the reviewed plan>`,
// and no `tofu destroy`, which would compute a teardown nobody reviewed.
func TestRunDestroyAppliesTheReviewedPlan(t *testing.T) {
	argv := provFakeTofu(t, reviewedPlanTofu("0"))
	planFile := writeReviewedPlan(t)

	err := RunDestroy(context.Background(), DestroyParams{
		PlanFile:      planFile,
		ProjectConfig: provConfig(),
		Provider:      "aws",
		TemplatesDir:  provTemplates(t),
		StateBackend:  provBackend(t),
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err != nil {
		t.Fatalf("RunDestroy: %v\nargv:\n%s", err, argv())
	}
	applies := argvLines(argv(), "apply")
	if len(applies) != 1 || !strings.HasSuffix(applies[0], planFile) {
		t.Fatalf("want exactly one `tofu apply %s`; argv:\n%s", planFile, argv())
	}
	if d := argvLines(argv(), "destroy"); len(d) != 0 {
		t.Fatalf("a destroy bound to a reviewed plan ran `tofu destroy`; argv:\n%s", argv())
	}
}

// TestRunDestroyNeverRetriesAReviewedPlan pins that a failed apply of the reviewed plan is reported,
// not retried: the only retry available is a fresh `tofu destroy`, which nobody reviewed.
func TestRunDestroyNeverRetriesAReviewedPlan(t *testing.T) {
	argv := provFakeTofu(t, reviewedPlanTofu("1"))

	err := RunDestroy(context.Background(), DestroyParams{
		PlanFile:      writeReviewedPlan(t),
		ProjectConfig: provConfig(),
		Provider:      "aws",
		TemplatesDir:  provTemplates(t),
		StateBackend:  provBackend(t),
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err == nil {
		t.Fatal("a failed apply of the reviewed plan must fail the teardown")
	}
	if n := len(argvLines(argv(), "apply")); n != 1 {
		t.Errorf("want one apply attempt, got %d; argv:\n%s", n, argv())
	}
	if d := argvLines(argv(), "destroy"); len(d) != 0 {
		t.Fatalf("a failed reviewed teardown fell back to `tofu destroy`; argv:\n%s", argv())
	}
}

// TestRunDestroyRefusesAReviewedPlanForAPlacedEnvironment pins that a placed environment, which owns
// no OpenTofu state, refuses a reviewed plan before any work rather than tearing itself down without
// the plan the destroy was bound to.
func TestRunDestroyRefusesAReviewedPlanForAPlacedEnvironment(t *testing.T) {
	for _, mode := range []types.PlacementMode{types.PlacementModeVcluster, types.PlacementModeNamespace} {
		t.Run(string(mode), func(t *testing.T) {
			argv := provFakeTofu(t, reviewedPlanTofu("0"))
			cfg := provConfig()
			cfg.PlacementMode = mode
			err := RunDestroy(context.Background(), DestroyParams{
				PlanFile:      writeReviewedPlan(t),
				ProjectConfig: cfg,
				Provider:      "aws",
				TemplatesDir:  provTemplates(t),
				StateBackend:  provBackend(t),
				Stdout:        io.Discard,
				Stderr:        io.Discard,
			})
			if !errors.Is(err, ErrDestroyPlanNoTofu) {
				t.Fatalf("err = %v, want ErrDestroyPlanNoTofu", err)
			}
			if log := argv(); log != "" {
				t.Fatalf("the refusal must come before any tofu call; argv:\n%s", log)
			}
		})
	}
}
