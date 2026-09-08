// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/pflag"
)

// The golden path, driven through the real cobra tree against the fake control plane. The fake
// serves one existing project ("web", p1) and the environments a test seeds, so both arms — a
// project to create and a project to reconcile — are reachable from one file.

const applyDemoManifest = `project: boutique
cloud:
  account: prod-account
  region: eu-west-1
environments:
  - name: prod
    stage: production
    components:
      cluster:
        node_min_size: 1
        node_max_size: 2
  - name: dev-1
    stage: development
    namespace: boutique-dev-1
    components:
      repositories:
        apps_destination_repo: https://github.com/alethialabs-io/alethia-examples
        apps_path: examples/online-boutique/overlays/dev-1
      databases:
        - name: orders
          engine: postgres
`

// applyDemoEnvs is what the fake lists after the demo manifest's create: the fake's environment
// list is static, so the rows the server would have created are seeded for the deploy step to
// read their ids back.
func applyDemoEnvs() []map[string]any {
	return []map[string]any{
		{"id": "e1", "name": "prod", "stage": "production", "placement_mode": "dedicated", "status": "DRAFT", "is_default": true},
		{"id": "e2", "name": "dev-1", "stage": "development", "placement_mode": "namespace", "namespace": "boutique-dev-1", "status": "DRAFT"},
	}
}

// applyWriteManifest writes a manifest into a fresh directory and returns its path.
func applyWriteManifest(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), manifest.FileName)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// applyResetFlags zeroes the generated flags between runs, the way projResetFlags does for the
// project group. Registered here rather than in projResetFlags because that list is the project
// group's; a root command resets its own.
func applyResetFlags() {
	applyBinder.Reset()
	planBinder.Reset()
	applyRunnerID = ""
}

func applyEnv(t *testing.T, s *projServer) projHarness {
	t.Helper()
	h := projEnv(t, s)
	applyResetFlags()
	t.Cleanup(applyResetFlags)
	run := h.run
	h.run = func(args ...string) bool {
		applyResetFlags()
		return run(args...)
	}
	return h
}

// ── plan ──────────────────────────────────────────────────────────────────────────────────

func TestApply_PlanForANewProjectCreatesEverything(t *testing.T) {
	s := &projServer{}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)

	read := projCaptureStdout(t)
	if h.run("plan", "--file", path, "--no-input") {
		t.Error("plan exited fatally")
	}
	out := read()
	for _, want := range []string{"boutique", "aws/eu-west-1", "+ project boutique", "prod", "dedicated", "+ cluster", "dev-1", "namespace", "+ repositories", "+ databases/orders", "1 project to create · 2 environments · 3 components"} {
		if !strings.Contains(out, want) {
			t.Errorf("plan output is missing %q:\n%s", want, out)
		}
	}
	if len(s.posts) != 0 {
		t.Errorf("plan wrote to the control plane: %+v", s.posts)
	}
}

func TestApply_PlanJSONIsTheTypedPlan(t *testing.T) {
	h := applyEnv(t, &projServer{})
	path := applyWriteManifest(t, applyDemoManifest)
	read := projCaptureStdout(t)
	if h.run("plan", "--file", path, "--no-input", "--output", "json") {
		t.Error("plan exited fatally")
	}
	out := read()
	var got ApplyPlan
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("plan --output json is not the typed plan: %v\n%s", err, out)
	}
	if got.ProjectID != "" || len(got.Environments) != 2 || got.Environments[0].Action != ActionCreate || got.IdentityID != "ci1" {
		t.Errorf("unexpected plan: %+v", got)
	}
	if strings.Contains(out, "Reading") {
		t.Errorf("prose leaked into the json stream:\n%s", out)
	}
}

func TestApply_PlanReconcilesAnExistingProject(t *testing.T) {
	// `web` exists with `production` (dedicated) and `staging`; the file declares production
	// with a cluster, and a new dev-1. staging is unmanaged and left alone.
	s := &projServer{
		envs: []map[string]any{
			{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
			{"id": "e2", "name": "staging", "stage": "staging", "placement_mode": "namespace", "status": "ACTIVE"},
		},
		comps: []map[string]any{
			{"id": "c1", "kind": "cluster", "name": "cluster", "status": "ACTIVE", "config": map[string]any{}},
		},
	}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, `project: Web
cloud:
  region: eu-west-1
environments:
  - name: production
    stage: production
    components:
      cluster:
        node_max_size: 4
  - name: dev-1
    stage: development
    components:
      repositories:
        apps_path: overlays/dev-1
`)
	read := projCaptureStdout(t)
	if h.run("plan", "--file", path, "--no-input") {
		t.Error("plan exited fatally")
	}
	out := read()
	// The project name matches case-insensitively, as the server's uniqueness index does.
	if strings.Contains(out, "+ project") {
		t.Errorf("an existing project was planned for creation:\n%s", out)
	}
	for _, want := range []string{"= environment  ~ cluster", "+ environment  + repositories", "staging is on the server and not in the file", "0 projects to create · 1 environment · 2 components"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q:\n%s", want, out)
		}
	}
}

func TestApply_PlanRefusesWhatItCannotReconcile(t *testing.T) {
	s := &projServer{envs: []map[string]any{
		{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
	}}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: production\n    stage: staging\n    placement: vcluster\n  - name: prod2\n    stage: production\n    placement: dedicated\n")
	read := projCaptureStdout(t)
	if !h.run("plan", "--file", path, "--no-input") {
		t.Error("a plan that cannot be reconciled must exit")
	}
	out := read()
	if !strings.Contains(out, "stage staging, the server has production") || !strings.Contains(out, "placement vcluster, the server has dedicated") {
		t.Errorf("the plan did not show BOTH problems before refusing:\n%s", out)
	}
	if len(s.posts) != 0 {
		t.Errorf("a refused plan wrote to the control plane: %+v", s.posts)
	}
}

func TestApply_ManifestProblemsAreNamedBeforeAnyRequest(t *testing.T) {
	s := &projServer{}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, "project: boutique\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n    components:\n      warehouses:\n        - name: x\n      cluster:\n        colour: red\n")
	if !h.run("plan", "--file", path, "--no-input") {
		t.Error("an invalid manifest must exit")
	}
	for _, post := range s.posts {
		t.Errorf("an invalid manifest reached the control plane: %+v", post)
	}
	if !h.run("plan", "--file", filepath.Join(t.TempDir(), "missing.yaml"), "--no-input") {
		t.Error("a missing manifest must exit")
	}
	if !h.run("plan", "--file", applyWriteManifest(t, "project: boutique\ncloud:\n  account: nobody\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n"), "--no-input") {
		t.Error("an unknown cloud account must exit")
	}
}

// ── apply ─────────────────────────────────────────────────────────────────────────────────

func TestApply_CreatesThenDeploysInFileOrder(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs()}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)
	read := projCaptureStdout(t)
	if h.run("apply", "--file", path, "--yes", "--runner", "primary", "--no-input") {
		t.Error("apply exited fatally")
	}
	out := read()
	for _, want := range []string{"created project boutique", "added cluster in prod", "added repositories in dev-1", "added databases/orders in dev-1", "boutique is up."} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q:\n%s", want, out)
		}
	}
	// The wire, in order: one create carrying the WHOLE matrix (so the server fans it out onto
	// one Fabric), the components, then a DEPLOY per environment in file order.
	var paths []string
	for _, p := range s.posts {
		paths = append(paths, p.Method+" "+p.Path)
	}
	want := []string{
		"POST /api/cli/projects",
		"POST /api/cli/projects/p1/components/cluster",
		"POST /api/cli/projects/p1/components/repositories",
		"POST /api/cli/projects/p1/components/databases",
		"POST /api/jobs",
		"POST /api/jobs",
	}
	if strings.Join(paths, "\n") != strings.Join(want, "\n") {
		t.Errorf("requests:\n%s\nwant:\n%s", strings.Join(paths, "\n"), strings.Join(want, "\n"))
	}
	create := s.posts[0].Body
	envs, _ := create["environments"].([]any)
	if create["project_name"] != "boutique" || create["cloud_identity_id"] != "ci1" || len(envs) != 2 {
		t.Errorf("the create did not carry the file: %+v", create)
	}
	first, _ := envs[0].(map[string]any)
	if first["name"] != "prod" || first["placement_mode"] != "dedicated" || first["is_default"] != true {
		t.Errorf("the first environment is the dedicated default: %+v", first)
	}
	db := s.posts[3].Body
	fields, _ := db["fields"].(map[string]any)
	if db["name"] != "orders" || fields["engine"] != "postgres" {
		t.Errorf("a named component carries its name outside its fields: %+v", db)
	}
	job := s.posts[4].Body
	if job["job_type"] != "DEPLOY" || job["assigned_runner_id"] != "r1" || job["configuration_id"] != "p1" {
		t.Errorf("the deploy is not assigned to the named runner: %+v", job)
	}
}

func TestApply_NoInputWithoutYesRefusesBeforeWriting(t *testing.T) {
	s := &projServer{}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)
	if !h.run("apply", "--file", path, "--no-input") {
		t.Error("apply without --yes and without a terminal must exit")
	}
	if len(s.posts) != 0 {
		t.Errorf("a refused apply wrote to the control plane: %+v", s.posts)
	}
}

func TestApply_DeclinedConfirmationWritesNothing(t *testing.T) {
	s := &projServer{}
	h := applyEnv(t, s)
	projConfirm(t, false)
	path := applyWriteManifest(t, applyDemoManifest)
	if h.run("apply", "--file", path) {
		t.Error("a declined apply is not a failure")
	}
	if len(s.posts) != 0 {
		t.Errorf("a declined apply wrote to the control plane: %+v", s.posts)
	}
}

func TestApply_EnvNarrowsTheDeployNotTheCreate(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs()}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)
	if h.run("apply", "--file", path, "--yes", "--runner-id", "r1", "--env", "dev-1", "--no-wait", "--no-input") {
		t.Error("apply exited fatally")
	}
	var deploys int
	for _, p := range s.posts {
		if p.Path == "/api/jobs" {
			deploys++
		}
	}
	if deploys != 1 {
		t.Errorf("--env dev-1 queued %d deploys, want 1", deploys)
	}
	if s.posts[0].Path != "/api/cli/projects" {
		t.Errorf("the project was not created: %+v", s.posts)
	}
	if !h.run("apply", "--file", path, "--yes", "--env", "nope", "--no-input") {
		t.Error("an --env the file does not declare must exit")
	}
}

func TestApply_JSONOutputIsTheResult(t *testing.T) {
	h := applyEnv(t, &projServer{envs: applyDemoEnvs()})
	path := applyWriteManifest(t, applyDemoManifest)
	read := projCaptureStdout(t)
	if h.run("apply", "--file", path, "--yes", "--runner", "primary", "--no-wait", "--no-input", "--output", "json") {
		t.Error("apply exited fatally")
	}
	out := read()
	var got ApplyResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("apply --output json is not the typed result: %v\n%s", err, out)
	}
	if got.ProjectID != "p1" || len(got.Jobs) != 2 || len(got.Created) != 4 {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestApply_AFailedDeployIsFatal(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs(), jobStatuses: []string{"RUNNING", "FAILED"}, jobErrMsg: "quota"}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)
	if !h.run("apply", "--file", path, "--yes", "--runner", "primary", "--no-input") {
		t.Error("a failed deploy must exit non-zero")
	}
	s = &projServer{envs: applyDemoEnvs(), failOn: []string{"/api/jobs"}}
	h = applyEnv(t, s)
	if !h.run("apply", "--file", path, "--yes", "--runner", "primary", "--no-input") {
		t.Error("a refused queue call must exit")
	}
}

// ── the runner rule ───────────────────────────────────────────────────────────────────────

type applyRunnerFake struct {
	applyClient
	runners []api.Runner
}

func (f applyRunnerFake) GetRunners() ([]api.Runner, error) { return f.runners, nil }

func TestApply_RunnerRule(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	one := applyRunnerFake{runners: []api.Runner{
		{ID: "r1", Name: "primary", Status: "ONLINE"},
		{ID: "r3", Name: "old", Status: "OFFLINE"},
	}}
	// The only online runner is picked without a question.
	if id, err := applyRunner(one, "tok", "", ""); err != nil || id != "r1" {
		t.Errorf("one online runner: got %q, %v", id, err)
	}
	// Two online and nobody to ask: unassigned, for the server to place.
	two := applyRunnerFake{runners: []api.Runner{
		{ID: "r1", Name: "primary", Status: "ONLINE"},
		{ID: "r2", Name: "edge", Status: "ONLINE"},
	}}
	if id, err := applyRunner(two, "tok", "", ""); err != nil || id != "" {
		t.Errorf("two online runners under --no-input: got %q, %v", id, err)
	}
	// A name resolves; an unknown name is refused naming the known ones.
	if id, err := applyRunner(two, "tok", "edge", ""); err != nil || id != "r2" {
		t.Errorf("by name: got %q, %v", id, err)
	}
	if _, err := applyRunner(two, "tok", "nope", ""); err == nil || !strings.Contains(err.Error(), "primary") {
		t.Errorf("an unknown runner must be refused naming the known ones: %v", err)
	}
	if _, err := applyRunner(two, "tok", "edge", "r1"); err == nil {
		t.Error("--runner and --runner-id together must be refused")
	}
}

// ── the docs rendering ────────────────────────────────────────────────────────────────────

// TestHygApply_DocsCarryTheGeneratedTables pins the fourth rendering: the fieldspec tables on
// plan-and-apply.mdx are byte-for-byte what the specs render, and every flag the two commands
// register is named on the page.
func TestHygApply_DocsCarryTheGeneratedTables(t *testing.T) {
	page := docsRead(t, filepath.Join(docsRepoRoot(), docsPlanApplyPage))
	for _, s := range []spec.Spec{applySpec, planSpec} {
		if err := s.Validate(); err != nil {
			t.Fatalf("%s: %v", s.Command, err)
		}
		marker := spec.MarkerFor(s.Command)
		i := strings.Index(page, marker)
		if i < 0 {
			t.Fatalf("%s has no %s marker", docsPlanApplyPage, marker)
		}
		table := s.RenderDocsTable()
		if !strings.Contains(page[i:], table) {
			t.Errorf("the table under %s is not what the spec renders. Expected:\n%s", marker, table)
		}
	}
	for _, cmd := range []string{"apply", "plan"} {
		c, _, err := rootCmd.Find([]string{cmd})
		if err != nil {
			t.Fatal(err)
		}
		c.Flags().VisitAll(func(f *pflag.Flag) {
			if f.Hidden || projectGlobalFlag(f.Name) {
				return
			}
			if !strings.Contains(page, "`--"+f.Name+"`") {
				t.Errorf("%s does not name --%s of `alethia %s`", docsPlanApplyPage, f.Name, cmd)
			}
		})
	}
	// The manifest keys `project create` declares are exactly the scalar keys the reader answers,
	// so the kit's manifest rung cannot name a key the file has no place for.
	for _, key := range projectCreateSpec.ManifestKeyPaths() {
		found := false
		for _, k := range manifest.ScalarKeys() {
			if k == key {
				found = true
			}
		}
		if !found {
			t.Errorf("project create declares manifest key %q, which manifest.Lookup does not answer", key)
		}
	}
}

// TestApply_RenderPlanUnmanagedAndNarrowed pins the two lines a person reads for what apply will
// NOT touch.
func TestApply_RenderPlanUnmanagedAndNarrowed(t *testing.T) {
	m, err := manifest.Parse([]byte("project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n  - name: dev\n    stage: development\n"))
	if err != nil {
		t.Fatal(err)
	}
	m.Normalize()
	p := &ApplyPlan{Manifest: m, ProjectID: "p1", Unmanaged: []string{"old"}, Environments: []EnvPlan{
		{Name: "prod", Placement: "dedicated", Action: ActionUnchanged, Deploy: false},
		{Name: "dev", Placement: "namespace", Action: ActionCreate, Deploy: true},
	}}
	if err := p.restrictTo([]string{"dev"}); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	renderPlan(&buf, p)
	out := buf.String()
	if !strings.Contains(out, "old is on the server and not in the file") || !strings.Contains(out, "(not deployed: --env)") {
		t.Errorf("plan lines:\n%s", out)
	}
	if strings.Contains(out, "+ project") {
		t.Errorf("an existing project rendered as a creation:\n%s", out)
	}
	if !strings.Contains(out, ui.MutedStyle.Render("  0 projects to create · 1 environment · 0 components")) {
		t.Errorf("totals:\n%s", out)
	}
}
