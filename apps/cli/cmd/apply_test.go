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
	"github.com/charmbracelet/huh"
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
	if h.run("apply", "--file", path, "--yes", "--runner", "primary", "--env", "dev-1", "--no-wait", "--no-input") {
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
	if id, err := applyRunner(one, "tok", ""); err != nil || id != "r1" {
		t.Errorf("one online runner: got %q, %v", id, err)
	}
	// Two online and nobody to ask: unassigned, for the server to place.
	two := applyRunnerFake{runners: []api.Runner{
		{ID: "r1", Name: "primary", Status: "ONLINE"},
		{ID: "r2", Name: "edge", Status: "ONLINE"},
	}}
	if id, err := applyRunner(two, "tok", ""); err != nil || id != "" {
		t.Errorf("two online runners under --no-input: got %q, %v", id, err)
	}
	// A name resolves; an unknown name is refused naming the known ones.
	if id, err := applyRunner(two, "tok", "edge"); err != nil || id != "r2" {
		t.Errorf("by name: got %q, %v", id, err)
	}
	if _, err := applyRunner(two, "tok", "nope"); err == nil || !strings.Contains(err.Error(), "primary") {
		t.Errorf("an unknown runner must be refused naming the known ones: %v", err)
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

// ── the error arms, each reached through the real command ─────────────────────────────────

func TestApply_ReconcilesAnExistingProjectByAddingWhatIsMissing(t *testing.T) {
	// `web` exists with production; the file adds dev-1 and declares orders, which already exists.
	s := &projServer{
		envs: []map[string]any{
			{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
			{"id": "e2", "name": "dev-1", "stage": "development", "placement_mode": "namespace", "status": "DRAFT"},
		},
		comps: []map[string]any{
			{"id": "c0", "kind": "cluster", "name": "cluster", "status": "ACTIVE", "config": map[string]any{}},
			{"id": "c1", "kind": "databases", "name": "orders", "status": "ACTIVE", "config": map[string]any{}},
		},
	}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: production\n    stage: production\n  - name: dev-1\n    stage: development\n    components:\n      databases:\n        - name: orders\n          engine: postgres\n        - name: carts\n          engine: postgres\n")
	// The plan sees dev-1 as existing through the static fake, so the arm under test is the
	// unchanged multi component; the add-environment arm is reached below with a narrower fake.
	read := projCaptureStdout(t)
	if h.run("apply", "--file", path, "--yes", "--runner", "primary", "--no-wait", "--no-input", "--output", "json") {
		t.Error("apply exited fatally")
	}
	var got ApplyResult
	if err := json.Unmarshal([]byte(read()), &got); err != nil {
		t.Fatal(err)
	}
	if got.ProjectID != "p1" || len(got.Created) != 1 || !strings.Contains(got.Created[0], "databases/carts") {
		t.Errorf("only carts is new: %+v", got)
	}

	// Now the environment is missing on the server, so apply must ADD it rather than re-create
	// the project — and the created line is printed.
	s2 := &projServer{envs: []map[string]any{
		{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
	}}
	h2 := applyEnv(t, s2)
	read2 := projCaptureStdout(t)
	// The fake never lists dev-1 after the add, so the deploy step refuses — which is itself an
	// arm worth pinning: a declared environment the server does not list is fatal, not skipped.
	if !h2.run("apply", "--file", path, "--yes", "--runner", "primary", "--no-wait", "--no-input") {
		t.Error("an environment the server does not list after apply must be fatal")
	}
	out := read2()
	if !strings.Contains(out, "created environment dev-1") {
		t.Errorf("the add-environment arm did not run:\n%s", out)
	}
	var posts []string
	for _, p := range s2.posts {
		posts = append(posts, p.Method+" "+p.Path)
	}
	// production deploys first, in file order, and dev-1's refusal comes after it.
	if strings.Join(posts, " ") != "POST /api/cli/projects/p1/environments POST /api/cli/projects/p1/components/databases POST /api/cli/projects/p1/components/databases POST /api/jobs" {
		t.Errorf("requests: %v", posts)
	}

	// And the POST itself failing is reported by environment.
	s3 := &projServer{envs: s2.envs, failOnPost: []string{"/environments"}}
	h3 := applyEnv(t, s3)
	if !h3.run("apply", "--file", path, "--yes", "--runner", "primary", "--no-wait", "--no-input") {
		t.Error("a refused environment add must be fatal")
	}
	s4 := &projServer{envs: applyDemoEnvs(), failOnPost: []string{"/components/"}}
	h4 := applyEnv(t, s4)
	if !h4.run("apply", "--file", applyWriteManifest(t, applyDemoManifest), "--yes", "--runner", "primary", "--no-wait", "--no-input") {
		t.Error("a refused component add must be fatal")
	}
}

func TestApply_EveryReadFailureIsFatalAndNamed(t *testing.T) {
	path := applyWriteManifest(t, applyDemoManifest)
	existing := applyWriteManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: production\n    stage: production\n")
	existingWithComponent := applyWriteManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: production\n    stage: production\n    components:\n      cluster:\n        node_max_size: 3\n")
	for name, tc := range map[string]struct {
		fail []string
		file string
	}{
		"cloud identities": {[]string{"/cloud-identities"}, path},
		"projects":         {[]string{"/configurations"}, path},
		"schema":           {[]string{"/schema/components"}, path},
		"environments":     {[]string{"/environments"}, existing},
		"components":       {[]string{"/p1/components"}, existingWithComponent},
		"runners":          {[]string{"/runners"}, path},
	} {
		t.Run(name, func(t *testing.T) {
			s := &projServer{failOn: tc.fail, envs: []map[string]any{
				{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
			}}
			h := applyEnv(t, s)
			// plan never lists runners; every other read is on its path too.
			if name != "runners" && !h.run("plan", "--file", tc.file, "--no-input") {
				t.Errorf("a failed %s read must be fatal", name)
			}
			if !h.run("apply", "--file", tc.file, "--yes", "--no-input") {
				t.Errorf("apply over a failed %s read must be fatal", name)
			}
		})
	}
	// The writes: a refused create, and a refused environment read AFTER the create.
	for name, fail := range map[string][]string{"create": {"/cli/projects"}, "environments after create": {"/environments"}} {
		t.Run(name, func(t *testing.T) {
			s := &projServer{failOnPost: fail}
			if name != "create" {
				s = &projServer{failOn: fail}
			}
			h := applyEnv(t, s)
			if !h.run("apply", "--file", path, "--yes", "--runner", "primary", "--no-wait", "--no-input") {
				t.Errorf("a refused %s must be fatal", name)
			}
		})
	}
	// A manifest that does not parse, through apply.
	h := applyEnv(t, &projServer{})
	if !h.run("apply", "--file", applyWriteManifest(t, "project: [\n"), "--yes", "--no-input") {
		t.Error("a manifest that does not parse must be fatal")
	}
}

func TestApply_UpdatesAnExistingSingleton(t *testing.T) {
	s := &projServer{
		envs: []map[string]any{
			{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
		},
		comps: []map[string]any{
			{"id": "c0", "kind": "cluster", "name": "cluster", "status": "ACTIVE", "config": map[string]any{}},
		},
	}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: production\n    stage: production\n    components:\n      cluster:\n        node_max_size: 4\n")
	read := projCaptureStdout(t)
	if h.run("apply", "--file", path, "--yes", "--runner", "primary", "--no-wait", "--no-input") {
		t.Error("apply exited fatally")
	}
	out := read()
	if !strings.Contains(out, "~ cluster") || !strings.Contains(out, "updated cluster in production") {
		t.Errorf("a singleton that exists is UPDATED (the server upserts), not added:\n%s", out)
	}
}

func TestProj_CreateReadsTheManifestInTheWorkingDirectory(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, manifest.FileName), []byte("project: api\ncloud:\n  account: prod-account\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n  - name: dev\n    stage: development\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	if h.run("project", "create", "--no-input", "--output", "json") {
		t.Error("create from the working directory's manifest exited fatally")
	}
	post, ok := s.lastPost()
	if !ok {
		t.Fatal("nothing was sent")
	}
	envs, _ := post.Body["environments"].([]any)
	if post.Body["project_name"] != "api" || post.Body["region"] != "eu-west-1" || post.Body["cloud_identity_id"] != "ci1" || len(envs) != 2 {
		t.Errorf("the file did not supply the create: %+v", post.Body)
	}
	// The picker's id is all the replay has when no label was given, and --cloud-account takes it.
	m := manifestFromCreate(api.CreateProjectParams{ProjectName: "x", Region: "r", CloudIdentityID: "ci9"}, "")
	if m.Cloud.Account != "ci9" {
		t.Errorf("the replay dropped the only account reference: %+v", m.Cloud)
	}
}

// TestProj_TheDiscoveredManifestIsAnnouncedAndCanBeRefused pins the two halves of implicit
// discovery.
//
// Reading ./alethia.yaml with no --file is what makes `alethia project create` do the right thing
// in a checked-out repository, so it stays. But a scripted run in a tree that happens to hold an
// example manifest would take that file's environments — or fail naming a file the caller never
// mentioned — and there was no way to say "read none". So the read announces itself, and
// --no-manifest turns it off.
func TestProj_TheDiscoveredManifestIsAnnouncedAndCanBeRefused(t *testing.T) {
	write := func(t *testing.T) string {
		t.Helper()
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, manifest.FileName), []byte(
			"project: api\ncloud:\n  account: prod-account\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return dir
	}

	t.Run("the implicit read is on screen", func(t *testing.T) {
		s := &projServer{}
		h := projEnv(t, s)
		t.Chdir(write(t))
		read := projCaptureStdout(t)
		if h.run("project", "create", "--no-input") {
			t.Error("create from the discovered manifest exited fatally")
		}
		if out := read(); !strings.Contains(out, manifest.FileName) || !strings.Contains(out, "--no-manifest") {
			t.Errorf("a file nobody named was read without saying so:\n%s", out)
		}
	})

	t.Run("--no-manifest reads none", func(t *testing.T) {
		s := &projServer{}
		h := projEnv(t, s)
		t.Chdir(write(t))
		if h.run("project", "create", "svc-7", "--region", "eu-west-1", "--no-manifest", "--no-input", "--output", "json") {
			t.Error("create with --no-manifest exited fatally")
		}
		post, ok := s.lastPost()
		if !ok {
			t.Fatal("nothing was sent")
		}
		// The file said `api` with one production environment. None of it may reach the wire.
		if post.Body["project_name"] != "svc-7" {
			t.Errorf("the ignored manifest supplied the name anyway: %+v", post.Body)
		}
		if envs, _ := post.Body["environments"].([]any); len(envs) != 0 {
			t.Errorf("the ignored manifest supplied the matrix anyway: %+v", post.Body["environments"])
		}
	})

	t.Run("--file and --no-manifest together are refused", func(t *testing.T) {
		h := projEnv(t, &projServer{})
		dir := write(t)
		if !h.run("project", "create", "x", "--region", "r", "--file", filepath.Join(dir, manifest.FileName),
			"--no-manifest", "--no-input") {
			t.Error("naming a file and saying to read none must be refused rather than silently resolved")
		}
	})
}

func TestApply_RefusalsThroughTheApplyCommand(t *testing.T) {
	// A file that cannot be reconciled is refused by apply as well as by plan, before any write.
	s := &projServer{envs: []map[string]any{
		{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
	}}
	h := applyEnv(t, s)
	mismatch := applyWriteManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: production\n    stage: staging\n")
	if !h.run("apply", "--file", mismatch, "--yes", "--no-input") {
		t.Error("apply must refuse what plan refuses")
	}
	if len(s.posts) != 0 {
		t.Errorf("a refused apply wrote: %+v", s.posts)
	}
	// A runner that does not exist, and two projects sharing the name.
	h = applyEnv(t, &projServer{envs: applyDemoEnvs()})
	if !h.run("apply", "--file", applyWriteManifest(t, applyDemoManifest), "--yes", "--runner", "nope", "--no-input") {
		t.Error("an unknown runner must be fatal")
	}
	twins := &projServer{configs: []map[string]any{
		{"id": "p1", "project_name": "boutique", "environment_stage": "production", "status": "ACTIVE"},
		{"id": "p2", "project_name": "Boutique", "environment_stage": "production", "status": "ACTIVE"},
	}}
	h = applyEnv(t, twins)
	if !h.run("plan", "--file", applyWriteManifest(t, applyDemoManifest), "--no-input") {
		t.Error("two projects matching the file's name must be fatal rather than picked between")
	}
	// A missing manifest through apply, not only through plan.
	h = applyEnv(t, &projServer{})
	if !h.run("apply", "--file", filepath.Join(t.TempDir(), "none.yaml"), "--yes", "--no-input") {
		t.Error("apply over a missing file must be fatal")
	}
}

func TestApply_PlanJSONOfARefusalStillPrintsTheTypedPlan(t *testing.T) {
	// `--output json` on plan renders the plan and returns: the problems are IN the document, and
	// a script reads them from there rather than from an exit code with prose beside it.
	s := &projServer{envs: []map[string]any{
		{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
	}}
	h := applyEnv(t, s)
	mismatch := applyWriteManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: production\n    stage: staging\n")
	read := projCaptureStdout(t)
	if h.run("plan", "--file", mismatch, "--no-input", "--output", "json") {
		t.Error("plan --output json is a document, not a refusal")
	}
	var got ApplyPlan
	if err := json.Unmarshal([]byte(read()), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Environments) != 1 || len(got.Environments[0].Problems) == 0 {
		t.Errorf("the problems are not in the document: %+v", got)
	}
}

func TestApply_TheOnlyOnlineRunnerIsPickedWithoutAQuestion(t *testing.T) {
	// The fake lists one ONLINE runner (and a draining and an offline one), so on a terminal
	// with prompting allowed no picker opens and the deploy is assigned to it.
	s := &projServer{envs: applyDemoEnvs()}
	h := applyEnv(t, s)
	projTTY(t)
	opened := projFormCounter(t)
	projConfirm(t, true)
	path := applyWriteManifest(t, applyDemoManifest)
	if h.run("apply", "--file", path, "--no-wait") {
		t.Error("apply exited fatally")
	}
	if *opened != 0 {
		t.Errorf("a picker opened for a list of one online runner (%d form(s))", *opened)
	}
	for _, p := range s.posts {
		if p.Path == "/api/jobs" && p.Body["assigned_runner_id"] != "r1" {
			t.Errorf("the deploy was not assigned to the only online runner: %+v", p.Body)
		}
	}
}

func TestMatchCloudIdentity(t *testing.T) {
	ids := []api.CloudIdentity{
		{ID: "ci1", Provider: "aws", Label: "prod"},
		{ID: "ci2", Provider: "gcp", Label: "dup"},
		{ID: "ci3", Provider: "azure", Label: "dup"},
	}
	if got, err := matchCloudIdentity(ids, "ci1"); err != nil || got.Provider != "aws" {
		t.Errorf("by id: %+v %v", got, err)
	}
	if got, err := matchCloudIdentity(ids, "prod"); err != nil || got.ID != "ci1" {
		t.Errorf("by label: %+v %v", got, err)
	}
	if _, err := matchCloudIdentity(ids, "dup"); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Errorf("an ambiguous label must be refused: %v", err)
	}
	if _, err := matchCloudIdentity(ids, "none"); err == nil || !strings.Contains(err.Error(), "prod") {
		t.Errorf("an unknown label must name the known ones: %v", err)
	}
	if _, err := findEnv(&manifest.Manifest{}, "x"); err == nil {
		t.Error("an environment absent from the file must be an error")
	}
	if err := (&ApplyPlan{}).restrictTo(nil); err != nil {
		t.Error(err)
	}
}

func TestProj_CreateFileErrorsAreFatal(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	if !h.run("project", "create", "api", "--region", "eu-west-1", "--file", filepath.Join(t.TempDir(), "none.yaml"), "--no-input") {
		t.Error("a --file that does not exist must be fatal")
	}
	broken := filepath.Join(t.TempDir(), manifest.FileName)
	if err := os.WriteFile(broken, []byte("project: [\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !h.run("project", "create", "api", "--region", "eu-west-1", "--file", broken, "--no-input") {
		t.Error("a --file that does not parse must be fatal")
	}
	if len(s.posts) != 0 {
		t.Errorf("a refused create reached the control plane: %+v", s.posts)
	}
	// Declined matrix on a terminal: the server's default pair, no replay of a file.
	projTTY(t)
	projForm(t)
	projScriptYesNo(t, false)
	read := projCaptureStdout(t)
	if h.run("project", "create", "api", "--region", "eu-west-1", "--cloud-account", "prod-account") {
		t.Error("create with a declined matrix exited fatally")
	}
	if strings.Contains(read(), "save this as") {
		t.Error("a declined matrix must not print a manifest replay")
	}
}

func TestApply_RunnerPickerWithSeveralOnline(t *testing.T) {
	two := []map[string]any{
		{"id": "r1", "name": "primary", "operator": "managed", "status": "ONLINE", "is_default": true},
		{"id": "r2", "name": "edge", "operator": "managed", "status": "ONLINE"},
	}
	s := &projServer{envs: applyDemoEnvs(), runners: two}
	h := applyEnv(t, s)
	projTTY(t)
	projForm(t)
	projConfirm(t, true)
	path := applyWriteManifest(t, applyDemoManifest)
	if h.run("apply", "--file", path, "--no-wait") {
		t.Error("apply through the runner picker exited fatally")
	}
	// The picker pre-selects the org's default runner, so the deploy lands on it.
	for _, p := range s.posts {
		if p.Path == "/api/jobs" && p.Body["assigned_runner_id"] != "r1" {
			t.Errorf("the picker's default was not used: %+v", p.Body)
		}
	}
	runHuhForm = func(...*huh.Group) error { return errBoom }
	if !h.run("apply", "--file", path, "--no-wait") {
		t.Error("a picker that cannot run must be fatal, not a silent unassigned deploy")
	}
}

// TestApply_LoggedOutIsFatalBeforeAnyRead pins the first thing both commands do: a run with no
// credential fails naming the login, rather than reaching the control plane with no token and
// reporting a 401 as if the manifest were wrong.
func TestApply_LoggedOutIsFatalBeforeAnyRead(t *testing.T) {
	s := &projServer{}
	h := applyEnv(t, s)
	isolatedHome(t) // no credentials written
	t.Setenv(ServiceTokenEnv, "")
	path := applyWriteManifest(t, applyDemoManifest)
	if !h.run("apply", "--file", path, "--yes", "--no-input") {
		t.Error("apply with no credential must be fatal")
	}
	if !h.run("plan", "--file", path, "--no-input") {
		t.Error("plan with no credential must be fatal")
	}
	if len(s.posts) != 0 {
		t.Errorf("a logged-out run reached the control plane: %+v", s.posts)
	}
}

// ── the review round's four behaviours ─────────────────────────────────────────────────────

// The server transforms every environment name through the slugifier before storing it, then
// matches the STORED name exactly. Sending the raw name created the project and made every later
// address of that environment fail — after the writes, which is the worst place to find out.
func TestApply_SendsTheNormalisedEnvironmentName(t *testing.T) {
	s := &projServer{envs: []map[string]any{
		{"id": "e1", "name": "prod", "stage": "production", "placement_mode": "dedicated", "status": "DRAFT", "is_default": true},
	}}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, "project: boutique\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: Prod\n    stage: production\n")
	if h.run("apply", "--file", path, "--yes", "--runner", "primary", "--no-wait", "--no-input") {
		t.Error("apply exited fatally")
	}
	create := s.posts[0].Body
	envs, _ := create["environments"].([]any)
	first, _ := envs[0].(map[string]any)
	if first["name"] != "prod" {
		t.Errorf("sent %q — the server stores the slug, so anything else cannot be addressed afterwards", first["name"])
	}
	// And the deploy found it, which is the half that used to fail.
	var deploys int
	for _, p := range s.posts {
		if p.Path == "/api/jobs" {
			deploys++
		}
	}
	if deploys != 1 {
		t.Errorf("the deploy did not resolve the environment it had just created: %+v", s.posts)
	}
}

// `--output json` must be parseable on the DEFAULT path, which waits. Every progress line the wait
// loop wrote used to land in the document, once per environment.
func TestApply_JSONIsParseableOnTheWaitingPath(t *testing.T) {
	s := &projServer{envs: applyDemoEnvs()}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, applyDemoManifest)
	read := projCaptureStdout(t)
	// No --no-wait: this is the arm the previous test avoided.
	if h.run("apply", "--file", path, "--yes", "--runner", "primary", "--no-input", "--output", "json") {
		t.Error("apply exited fatally")
	}
	out := read()
	var got ApplyResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("the waiting path's output is not parseable json: %v\n%s", err, out)
	}
	for _, prose := range []string{"Waiting for job", "Status:", "Job completed"} {
		if strings.Contains(out, prose) {
			t.Errorf("the wait loop wrote %q into the json stream:\n%s", prose, out)
		}
	}
}

// The "one environment must be dedicated" rule is the SERVER's, and the server applies it only
// where a matrix brings a project's first Fabric into being.
func TestApply_TheDedicatedRuleIsCreateTimeOnly(t *testing.T) {
	shared := "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: dev-1\n    stage: development\n    placement: namespace\n"

	// Against an EXISTING project it is allowed — this is what a manifest is for, and refusing it
	// contradicted the reader's own promise that unmentioned environments are left alone.
	existing := &projServer{envs: []map[string]any{
		{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
	}}
	h := applyEnv(t, existing)
	if h.run("plan", "--file", applyWriteManifest(t, shared), "--no-input") {
		t.Error("a shared-only matrix against an existing project must be allowed")
	}

	// Against a NEW project it is refused: nothing in it would ever provision.
	fresh := &projServer{configs: []map[string]any{}}
	h = applyEnv(t, fresh)
	if !h.run("plan", "--file", applyWriteManifest(t, shared), "--no-input") {
		t.Error("a shared-only matrix that would CREATE a project must be refused")
	}
}

// The three fetches the plan does not need. Counted, because "it still works" is not the claim —
// the claim is that a components-free plan does not pay for a 1100-line document.
func TestApply_DoesNotFetchWhatThePlanCannotUse(t *testing.T) {
	s := &projServer{envs: []map[string]any{
		{"id": "e1", "name": "prod", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
		{"id": "e2", "name": "dev", "stage": "development", "placement_mode": "namespace", "status": "ACTIVE"},
	}}
	h := applyEnv(t, s)
	// A file with no components at all, over a project that exists.
	path := applyWriteManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n  - name: dev\n    stage: development\n")
	if h.run("plan", "--file", path, "--no-input") {
		t.Error("plan exited fatally")
	}
	if s.hits("/api/cli/schema/components") != 0 {
		t.Errorf("the component schema was fetched for a manifest that declares none (%d time(s))", s.hits("/api/cli/schema/components"))
	}
	if n := s.hits("/components"); n != 0 {
		t.Errorf("components were listed %d time(s) for environments the file declares none on", n)
	}
}
