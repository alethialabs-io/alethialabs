// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// #5095: the cli-demo cluster's NAME and the teardown's TARGET come from one source.
//
// E2E run 36135826614 deployed `alethia-nl-development` through the CLI while the harness asserted,
// captured load balancers for and destroyed `alethia-nl-36135826614-1`. The CLI's cluster carried no
// run tag, because a beat overwrote CLIDemoRun.EnvName with the project's default environment. The
// destroy only worked because RunDestroy reads the job's state. The label-scoped sweep
// (`cluster=<project>-<env>`) would have found nothing to reclaim.
//
// These tests pin the three halves together without a cloud:
//   - every beat that names the project or the environment takes it from CLIDemoRun.Project/EnvName;
//   - nothing in the cli-demo code WRITES those two fields, and the spine writes them exactly once;
//   - the spine's teardown, LB capture and cluster_name assertion all read t2ClusterTarget, which on
//     the cli-demo path returns those same two fields.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// namingRun is a run as the spine leaves it before the first beat: the harness's project and its
// run-tagged env, plus the ids later beats would have minted.
func namingRun() *CLIDemoRun {
	return &CLIDemoRun{
		Provider: "hetzner", Region: "nbg1",
		Project: "alethia-nl", EnvName: "36135826614-1",
		ProjectID: "p-1", RunnerID: "r-1", ApplyJobID: "j-1", IdentityLabel: "HETZNER",
	}
}

// beatArgs returns the argv of the beat performing stepID, failing when there is not exactly one.
func beatArgs(t *testing.T, stepID string, r *CLIDemoRun) []string {
	t.Helper()
	var found [][]string
	for _, b := range CLIDemoBeats {
		if b.StepID == stepID {
			found = append(found, b.Args(r))
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly one beat for step %q, found %d", stepID, len(found))
	}
	return found[0]
}

// flagValue returns the value that follows flag in argv, and whether the flag was there.
func flagValue(argv []string, flag string) (string, bool) {
	for i, a := range argv {
		if a == flag && i+1 < len(argv) {
			return argv[i+1], true
		}
	}
	return "", false
}

// TestCLIDemoBeatsNameTheClusterFromTheRun: the project the CLI creates and the environment it adds
// are the run's Project and EnvName, and every beat that addresses an environment addresses THAT one.
func TestCLIDemoBeatsNameTheClusterFromTheRun(t *testing.T) {
	r := namingRun()

	create := beatArgs(t, "project-create", r)
	if len(create) < 3 || create[0] != "project" || create[1] != "create" || create[2] != r.Project {
		t.Errorf("project-create argv = %v, want `project create %s …` — the project name is half the cluster name", create, r.Project)
	}

	// `cluster get` reads the cluster back by the project NAME: its selector does not take a
	// project id, which is what it used to be handed.
	if get := beatArgs(t, "cluster-get", r); len(get) < 3 || get[2] != r.Project {
		t.Errorf("cluster-get argv = %v, want `clusters get %s …`", get, r.Project)
	}

	add := beatArgs(t, "project-env", r)
	if len(add) < 4 || !slices.Equal(add[:3], []string{"project", "env", "add"}) || add[3] != r.EnvName {
		t.Errorf("project-env argv = %v, want `project env add %s …` — the environment NAME is the run tag in the cluster name", add, r.EnvName)
	}
	if pm, _ := flagValue(add, "--placement-mode"); pm != "dedicated" {
		t.Errorf("project-env argv = %v, want --placement-mode dedicated — a shared placement is not a cluster of its own", add)
	}

	// Every beat that names an environment names the run's. Counted, so a table that stopped
	// passing --env at all could not make this vacuous.
	addressed := 0
	for _, b := range CLIDemoBeats {
		if v, ok := flagValue(b.Args(r), "--env"); ok {
			addressed++
			if v != r.EnvName {
				t.Errorf("beat %q passes --env %q, want the run's %q — it would act on a cluster the teardown does not target", b.StepID, v, r.EnvName)
			}
		}
	}
	// component-add, plan, apply, drift, cost, addons, destroy.
	if addressed < 7 {
		t.Errorf("only %d beat(s) pass --env; this test is no longer examining the beats it was written for", addressed)
	}
}

// TestCLIDemoClusterNameIsTheSeededPathsName: the CLI-built cluster carries the same
// `<project>-<env>` the seeded path builds and the workflow sweeps (E2E_CLUSTER), and the spine's
// own assertion accepts it. The name the regression produced is refused.
func TestCLIDemoClusterNameIsTheSeededPathsName(t *testing.T) {
	r := namingRun()
	const harnessProject, harnessEnv = "alethia-nl", "36135826614-1"

	if got, want := CLIDemoClusterName(r), harnessProject+"-"+harnessEnv; got != want {
		t.Fatalf("CLIDemoClusterName = %q, want %q (the workflow's E2E_CLUSTER)", got, want)
	}
	p, e := t2ClusterTarget(harnessProject, harnessEnv, r)
	if err := t2ValidateClusterName("hetzner", p, e, CLIDemoClusterName(r)); err != nil {
		t.Errorf("the spine refuses the cluster the CLI builds: %v", err)
	}
	if err := t2ValidateClusterName("hetzner", p, e, "alethia-nl-development"); err == nil {
		t.Error("the spine accepts `alethia-nl-development` — the untagged name run 36135826614 built")
	}
}

// TestT2ClusterTargetFollowsTheCLIRun: with the dimension on, the target is the RUN's pair even when
// it differs from the harness's, so a beat that renamed anything would take the teardown with it
// rather than leave it pointing at a cluster nobody built. With it off, it is the harness's pair.
func TestT2ClusterTargetFollowsTheCLIRun(t *testing.T) {
	if p, e := t2ClusterTarget("proj", "env", nil); p != "proj" || e != "env" {
		t.Errorf("seeded path: target = %s/%s, want proj/env", p, e)
	}
	r := &CLIDemoRun{Project: "cli-proj", EnvName: "cli-env"}
	if p, e := t2ClusterTarget("proj", "env", r); p != "cli-proj" || e != "cli-env" {
		t.Errorf("cli-demo path: target = %s/%s, want the run's cli-proj/cli-env", p, e)
	}
}

// TestAssertRunTaggedEnv: the read-back accepts the name only when it was stored EXACTLY and
// placed dedicated, and it never rewrites the run.
func TestAssertRunTaggedEnv(t *testing.T) {
	for name, tc := range map[string]struct {
		out     string
		wantErr string
	}{
		"stored exactly, dedicated": {
			out: `[{"name":"development","placement_mode":"dedicated","is_default":true},` +
				`{"name":"36135826614-1","placement_mode":"dedicated"}]`,
		},
		"only the default exists (the regression's shape)": {
			out:     `[{"name":"development","placement_mode":"dedicated","is_default":true}]`,
			wantErr: "no environment is stored under exactly that name",
		},
		"placed on a shared Fabric": {
			out:     `[{"name":"36135826614-1","placement_mode":"namespace"}]`,
			wantErr: "want `dedicated`",
		},
		"not JSON": {
			out:     "Added environment 36135826614-1",
			wantErr: "no JSON array",
		},
	} {
		t.Run(name, func(t *testing.T) {
			r := namingRun()
			err := assertRunTaggedEnv(r, tc.out)
			if tc.wantErr == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("error = %v, want one containing %q", err, tc.wantErr)
			}
			if r.EnvName != "36135826614-1" || r.Project != "alethia-nl" {
				t.Errorf("assertRunTaggedEnv rewrote the run to %s/%s — the name is an input, never a capture", r.Project, r.EnvName)
			}
		})
	}
}

// TestNothingRewritesTheCLIDemoRunsName: Project and EnvName are assigned exactly once, in the
// spine, from the harness's own project/env. The regression was a capture function in the cli-demo
// code overwriting EnvName, so every non-test cli-demo file is read for an assignment to either
// field. Read with go/parser rather than grepped, because the field names also appear in comments.
func TestNothingRewritesTheCLIDemoRunsName(t *testing.T) {
	isNameField := func(e ast.Expr) bool {
		sel, ok := e.(*ast.SelectorExpr)
		return ok && (sel.Sel.Name == "EnvName" || sel.Sel.Name == "Project")
	}
	files, err := filepath.Glob("t2_cli_demo*.go")
	if err != nil {
		t.Fatal(err)
	}
	examined := 0
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		examined++
		f, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			if as, ok := n.(*ast.AssignStmt); ok {
				for _, lhs := range as.Lhs {
					if isNameField(lhs) {
						t.Errorf("%s assigns %s — the run's name is set once by the spine; a beat that rewrites it renames the cluster away from the teardown's target (#5095)", path, selField(lhs))
					}
				}
			}
			return true
		})
	}
	if examined < 2 {
		t.Fatalf("examined %d cli-demo source file(s); the glob no longer finds the code it guards", examined)
	}

	src, err := os.ReadFile("t2_provision_test.go")
	if err != nil {
		t.Fatal(err)
	}
	f, err := parser.ParseFile(token.NewFileSet(), "t2_provision_test.go", src, 0)
	if err != nil {
		t.Fatalf("parse t2_provision_test.go: %v", err)
	}
	var writes []string
	ast.Inspect(f, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok {
			return true
		}
		for i, lhs := range as.Lhs {
			if !isNameField(lhs) {
				continue
			}
			rhs := "?"
			if i < len(as.Rhs) {
				if id, ok := as.Rhs[i].(*ast.Ident); ok {
					rhs = id.Name
				}
			}
			writes = append(writes, selField(lhs)+"="+rhs)
		}
		return true
	})
	slices.Sort(writes)
	if want := []string{"EnvName=env", "Project=project"}; !slices.Equal(writes, want) {
		t.Errorf("the spine's writes to the run's name = %v, want exactly %v — the harness's own pair, once", writes, want)
	}
}

// selField renders a selector's field name for a message.
func selField(e ast.Expr) string {
	if sel, ok := e.(*ast.SelectorExpr); ok {
		return sel.Sel.Name
	}
	return "?"
}

// TestSpineTeardownReadsTheClusterTarget: the in-process destroy, the hetzner LB capture and the
// cluster_name assertion in t2_provision_test.go all take their project/env from t2ClusterTarget.
// Were any of them to take the harness's `project`/`env` directly, the cli-demo path could once
// again assert, capture or destroy a cluster other than the one the CLI built.
func TestSpineTeardownReadsTheClusterTarget(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), "t2_provision_test.go", nil, 0)
	if err != nil {
		t.Fatalf("parse t2_provision_test.go: %v", err)
	}
	// Identifiers bound by `a, b := t2ClusterTarget(...)`.
	fromTarget := map[string]bool{}
	ast.Inspect(f, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok || len(as.Rhs) != 1 {
			return true
		}
		call, ok := as.Rhs[0].(*ast.CallExpr)
		if !ok {
			return true
		}
		if id, ok := call.Fun.(*ast.Ident); !ok || id.Name != "t2ClusterTarget" {
			return true
		}
		for _, lhs := range as.Lhs {
			if id, ok := lhs.(*ast.Ident); ok {
				fromTarget[id.Name] = true
			}
		}
		return true
	})
	isTarget := func(e ast.Expr) bool {
		id, ok := e.(*ast.Ident)
		return ok && fromTarget[id.Name]
	}
	// Each call and the argument positions that must carry the target.
	checks := map[string]func(args []ast.Expr) bool{
		"teardownT2Cluster": func(a []ast.Expr) bool { return len(a) > 5 && isTarget(a[3]) && isTarget(a[4]) },
		"t2ValidateClusterName": func(a []ast.Expr) bool {
			return len(a) > 2 && isTarget(a[1]) && isTarget(a[2])
		},
		"captureHetznerLoadBalancers": func(a []ast.Expr) bool {
			bin, ok := a[len(a)-1].(*ast.BinaryExpr)
			if !ok {
				return false
			}
			left, ok := bin.X.(*ast.BinaryExpr)
			return ok && isTarget(left.X) && isTarget(bin.Y)
		},
	}
	seen := map[string]int{}
	ast.Inspect(f, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		id, ok := call.Fun.(*ast.Ident)
		if !ok {
			return true
		}
		check, ok := checks[id.Name]
		if !ok {
			return true
		}
		seen[id.Name]++
		if !check(call.Args) {
			t.Errorf("%s in t2_provision_test.go does not take its project/env from t2ClusterTarget (#5095)", id.Name)
		}
		return true
	})
	for name := range checks {
		if seen[name] != 1 {
			t.Errorf("found %d call(s) to %s in t2_provision_test.go, want exactly 1", seen[name], name)
		}
	}
}
