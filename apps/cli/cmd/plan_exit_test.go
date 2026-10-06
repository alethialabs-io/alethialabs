// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// #5600: a pipeline gates on `alethia plan`'s exit code, so every code is pinned here, through the
// real cobra tree, in every output form (table, json, csv). Before #5600 `--output json` exited 0 on a plan apply
// refuses, and the table form exited 1 — the code of an unreachable API.

// planExitHarness is applyEnv with the exit code recorded: run returns the code the command exited
// with, 0 when it returned normally.
func planExitHarness(t *testing.T, s *projServer) func(args ...string) int {
	t.Helper()
	h := applyEnv(t, s)
	inner := exitFunc
	code := 0
	exitFunc = func(c int) {
		code = c
		inner(c)
	}
	return func(args ...string) int {
		code = 0
		if !h.run(args...) {
			return 0
		}
		return code
	}
}

// planExitServer serves `web` with one production environment: the project every case but the new
// one reconciles against.
func planExitServer() *projServer {
	return &projServer{envs: []map[string]any{
		{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "lifecycle": "persistent", "status": "ACTIVE", "is_default": true},
	}}
}

const (
	// planExitSame is the server's project exactly: nothing to change.
	planExitSame = "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: production\n    stage: production\n"
	// planExitAdds adds an environment to the existing project: a change, no problem.
	planExitAdds = planExitSame + "  - name: dev-1\n    stage: development\n"
	// planExitMismatch changes production's stage, which apply cannot do: a problem, no change.
	planExitMismatch = "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: production\n    stage: staging\n"
	// planExitBoth is a problem AND a change; the problem wins.
	planExitBoth = planExitMismatch + "  - name: dev-1\n    stage: development\n"
)

func TestPlanExit_EveryCodeInBothForms(t *testing.T) {
	cases := []struct {
		name     string
		manifest string // "" means a file that does not exist: an error
		def      int    // without --detailed-exitcode
		detailed int    // with it
	}{
		{"no changes", planExitSame, 0, 0},
		{"changes", planExitAdds, 0, exitPlanChanges},
		{"problems", planExitMismatch, exitPlanRefused, exitPlanProblems},
		{"problems and changes", planExitBoth, exitPlanRefused, exitPlanProblems},
		{"error", "", 1, 1},
	}
	for _, tc := range cases {
		for _, output := range []string{"table", "json", "csv"} {
			for _, detailed := range []bool{false, true} {
				name := tc.name + "/" + output
				want := tc.def
				if detailed {
					name += "/detailed"
					want = tc.detailed
				}
				t.Run(name, func(t *testing.T) {
					s := planExitServer()
					run := planExitHarness(t, s)
					path := filepath.Join(t.TempDir(), "missing.yaml")
					if tc.manifest != "" {
						path = applyWriteManifest(t, tc.manifest)
					}
					args := []string{"plan", "--file", path, "--no-input", "--output", output}
					if detailed {
						args = append(args, "--detailed-exitcode")
					}
					if got := run(args...); got != want {
						t.Errorf("alethia %v exited %d, want %d", args, got, want)
					}
					if len(s.posts) != 0 {
						t.Errorf("plan wrote to the control plane: %+v", s.posts)
					}
				})
			}
		}
	}
}

func TestPlanExit_JSONWithProblemsIsStillTheWholeDocument(t *testing.T) {
	// The exit code says the plan has problems; stdout still carries the typed plan and nothing
	// else, with the problems in it, so a script can read why.
	run := planExitHarness(t, planExitServer())
	read := projCaptureStdout(t)
	if got := run("plan", "--file", applyWriteManifest(t, planExitBoth), "--no-input", "--output", "json"); got != exitPlanRefused {
		t.Errorf("exited %d, want %d", got, exitPlanRefused)
	}
	out := read()
	var got ApplyPlan
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("stdout is not the typed plan alone: %v\n%s", err, out)
	}
	if len(got.Environments) != 2 || len(got.Environments[0].Problems) == 0 || got.Environments[1].Action != ActionCreate {
		t.Errorf("the document does not carry the problem and the change: %+v", got)
	}
}

func TestPlanExit_ApplyRefusesWithThePlanCode(t *testing.T) {
	// apply refuses the file the default plan exits 2 on, with the same 2 and before any write; an
	// error that is not a refusal stays 1.
	for _, output := range []string{"table", "json", "csv"} {
		t.Run(output, func(t *testing.T) {
			s := planExitServer()
			run := planExitHarness(t, s)
			if got := run("apply", "--file", applyWriteManifest(t, planExitMismatch), "--yes", "--no-input", "--output", output); got != exitPlanRefused {
				t.Errorf("apply of a refused plan exited %d, want %d", got, exitPlanRefused)
			}
			if len(s.posts) != 0 {
				t.Errorf("a refused apply wrote: %+v", s.posts)
			}
			run = planExitHarness(t, planExitServer())
			if got := run("apply", "--file", filepath.Join(t.TempDir(), "missing.yaml"), "--yes", "--no-input", "--output", output); got != 1 {
				t.Errorf("apply over a missing file exited %d, want 1", got)
			}
		})
	}
}

func TestPlanExit_EveryKindOfWriteIsAChange(t *testing.T) {
	unchanged := func() *ApplyPlan {
		return &ApplyPlan{ProjectID: "p1", Environments: []EnvPlan{{
			Name: "prod", Action: ActionUnchanged,
			Components: []ComponentPlan{{Kind: "cluster", Action: ActionUnchanged}},
			Addons:     []AddonPlan{{ID: "loki", Action: ActionUnchanged}},
		}}}
	}
	if p := unchanged(); p.hasChanges() {
		t.Error("a plan where everything matches reported a change")
	}
	// Unmanaged things are left alone, so they are not changes either.
	p := unchanged()
	p.Unmanaged = []string{"staging"}
	p.Environments[0].UnmanagedAddons = []string{"reloader"}
	if p.hasChanges() {
		t.Error("an unmanaged environment or add-on was counted as a change")
	}
	for name, mutate := range map[string]func(*ApplyPlan){
		"new project":      func(p *ApplyPlan) { p.ProjectID = "" },
		"new environment":  func(p *ApplyPlan) { p.Environments[0].Action = ActionCreate },
		"new component":    func(p *ApplyPlan) { p.Environments[0].Components[0].Action = ActionCreate },
		"component update": func(p *ApplyPlan) { p.Environments[0].Components[0].Action = ActionUpdate },
		"new add-on":       func(p *ApplyPlan) { p.Environments[0].Addons[0].Action = ActionCreate },
		"add-on update":    func(p *ApplyPlan) { p.Environments[0].Addons[0].Action = ActionUpdate },
	} {
		p := unchanged()
		mutate(p)
		if !p.hasChanges() {
			t.Errorf("%s is not counted as a change", name)
		}
		if got := planExitCode(p, true); got != exitPlanChanges {
			t.Errorf("%s: detailed exit %d, want %d", name, got, exitPlanChanges)
		}
		if got := planExitCode(p, false); got != 0 {
			t.Errorf("%s: default exit %d, want 0 — changes alone must not stop a plan-then-apply pipeline", name, got)
		}
	}
}
