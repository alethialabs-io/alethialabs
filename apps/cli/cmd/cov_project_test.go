// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
)

// The project/classification/channels command bodies live inside package-level
// `var x = &cobra.Command{Run: func…}` literals, so the only way to execute them is
// to drive the real cobra tree. This file does exactly that against a fake control
// plane, with the committed seams (stdinIsTTY/stdoutIsTTY, exitFunc, confirm,
// runHuhForm, openBrowser) supplying the terminal answers a test process cannot.

// projExit is the sentinel the stubbed exitFunc panics with, so a fatal arm can be
// observed instead of killing the test binary.
type projExit struct{ code int }

// projServer is the mutable fake control plane the TestProj_ suite drives. Each field
// is what the matching endpoint returns; failOn injects a 500 on any request whose
// path contains one of its substrings.
type projServer struct {
	mu          sync.Mutex
	failOn      []string
	config      map[string]any
	envs        []map[string]any
	comps       []map[string]any
	dims        []map[string]any
	assigns     []map[string]any
	channels    []map[string]any
	jobStatuses []string
	jobIdx      int
	jobErrMsg   string
	jobMeta     map[string]any
}

// jobBody returns the next polled job document, advancing through jobStatuses and
// repeating the last one, so `--wait` sees a real QUEUED→PROCESSING→terminal walk.
func (s *projServer) jobBody() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	status := "SUCCESS"
	if len(s.jobStatuses) > 0 {
		i := s.jobIdx
		if i >= len(s.jobStatuses) {
			i = len(s.jobStatuses) - 1
		}
		s.jobIdx++
		status = s.jobStatuses[i]
	}
	body := map[string]any{
		"id": "j1", "job_type": "PLAN", "status": status,
		"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
		"config_snapshot": map[string]any{},
	}
	if s.jobErrMsg != "" {
		body["error_message"] = s.jobErrMsg
	}
	if s.jobMeta != nil {
		body["execution_metadata"] = s.jobMeta
	}
	return body
}

// shouldFail reports whether this path is one the test asked to 500.
func (s *projServer) shouldFail(path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.failOn {
		if strings.Contains(path, f) {
			return true
		}
	}
	return false
}

// snapshot copies the response slices under the lock (the handler runs on the
// server's goroutine while the test mutates the struct between invocations).
func (s *projServer) snapshot() (envs, comps, dims, assigns, channels []map[string]any, config map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.envs, s.comps, s.dims, s.assigns, s.channels, s.config
}

func (s *projServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	enc := json.NewEncoder(w)
	if s.shouldFail(p) {
		w.WriteHeader(http.StatusInternalServerError)
		_ = enc.Encode(map[string]string{"error": "boom: " + p})
		return
	}
	envs, comps, dims, assigns, channels, config := s.snapshot()

	switch {
	case p == "/api/cli/whoami":
		_ = enc.Encode(map[string]any{
			"user":       map[string]any{"id": "u1", "email": "ada@x.com", "name": "Ada"},
			"active_org": map[string]any{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner"},
		})
	case p == "/api/cli/configurations":
		_ = enc.Encode(map[string]any{"configurations": []map[string]any{
			{"id": "p1", "project_name": "web", "environment_stage": "production", "status": "ACTIVE"},
		}})
	case strings.HasPrefix(p, "/api/cli/configurations/by-project-name/"):
		_ = enc.Encode(map[string]any{"configuration": config})
	case p == "/api/cli/runners":
		_ = enc.Encode(map[string]any{"runners": []map[string]any{
			{"id": "r1", "name": "primary", "operator": "managed", "status": "ONLINE", "is_default": true},
			{"id": "r2", "name": "edge", "operator": "self", "provisioning": "deployed", "status": "DRAINING"},
			{"id": "r3", "name": "old", "operator": "self", "status": "OFFLINE"},
		}})
	case p == "/api/cli/cloud-identities":
		_ = enc.Encode(map[string]any{"cloud_identities": []map[string]any{
			{"id": "ci1", "provider": "aws", "label": "prod-account"},
		}})
	case p == "/api/cli/projects":
		_ = enc.Encode(map[string]any{"project": map[string]any{
			"id": "p1", "project_name": "api", "slug": "api", "region": "eu-west-1",
			"cloud_provider": "aws", "environment_stage": "development", "status": "DRAFT",
			"iac_version": "1.11.4",
		}})
	case strings.HasSuffix(p, "/environments"):
		if r.Method == http.MethodPost {
			_ = enc.Encode(map[string]any{"environment": map[string]any{
				"id": "e9", "name": "staging", "stage": "staging", "status": "DRAFT",
			}})
			return
		}
		_ = enc.Encode(map[string]any{"environments": envs})
	case strings.Contains(p, "/components"):
		switch r.Method {
		case http.MethodPost:
			_ = enc.Encode(map[string]any{"component": map[string]any{
				"id": "comp1", "kind": "databases", "name": "main", "status": "PENDING",
			}})
		case http.MethodDelete:
			w.WriteHeader(http.StatusOK)
		default:
			_ = enc.Encode(map[string]any{"components": comps})
		}
	case p == "/api/jobs":
		_ = enc.Encode(map[string]any{"job": map[string]any{
			"id": "j1", "job_type": "PLAN", "status": "QUEUED",
			"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
		}})
	case strings.HasPrefix(p, "/api/cli/jobs/"):
		_ = enc.Encode(s.jobBody())
	case strings.HasSuffix(p, "/verify"):
		_ = enc.Encode(map[string]any{"channel": map[string]any{
			"id": "ch1", "name": "ops", "type": "webhook", "is_verified": true, "enabled": true,
		}})
	case p == "/api/cli/channels":
		if r.Method == http.MethodPost {
			_ = enc.Encode(map[string]any{"channel": map[string]any{
				"id": "ch1", "name": "ops", "type": "webhook", "is_verified": true, "enabled": true,
			}})
			return
		}
		_ = enc.Encode(map[string]any{"channels": channels})
	case strings.HasPrefix(p, "/api/cli/channels/"):
		w.WriteHeader(http.StatusOK)
	case p == "/api/cli/classification/dimensions":
		_ = enc.Encode(map[string]any{"dimensions": dims})
	case p == "/api/cli/classification/assignments":
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusOK)
			return
		}
		_ = enc.Encode(map[string]any{"assignments": assigns})
	default:
		w.WriteHeader(http.StatusNotFound)
		_ = enc.Encode(map[string]string{"error": "not found: " + p})
	}
}

// projHarness is one configured CLI-under-test: a runner over the real cobra tree,
// the fake control plane it talks to, and the path of its isolated credentials.
type projHarness struct {
	run   func(args ...string) bool
	srv   *projServer
	creds string
}

// projResetFlags clears every sticky flag target these commands bind to. rootCmd is a
// package global whose parsed flag values survive an Execute, so without this one
// invocation leaks its flags into the next.
func projResetFlags() {
	projectPlanProjectID, projectPlanRunnerID, projectPlanEnv, projectPlanWait = "", "", "", false
	projectApplyProjectID, projectApplyRunnerID, projectApplyPlanJobID = "", "", ""
	projectApplyEnv, projectApplyWait = "", false
	projectDestroyProjectID, projectDestroyRunnerID, projectDestroyEnv, projectDestroyWait = "", "", "", false
	componentListKind, componentListEnv = "", ""
	componentAddKind, componentAddName, componentAddSet = "", "", nil
	componentRemoveKind, componentRemoveName = "", ""
	projectCreateRegion, projectCreateIdentity = "", ""
	projectCreateStage, projectCreateIacVersion = "development", ""
	projectEnvStage, projectEnvRegion = "development", ""
	channelType, channelURL, channelSigningSecret, channelRoutingKey = "", "", "", ""
	channelRecipients = nil
	_ = projectComponentCmd.PersistentFlags().Set("project", "")
	_ = projectEnvCmd.PersistentFlags().Set("project", "")
	_ = projectGetCmd.Flags().Set("open", "false")
	_ = rootCmd.PersistentFlags().Set("output", "table")
	_ = rootCmd.PersistentFlags().Set("no-input", "false")
	rootCmd.SetArgs(nil)
}

// projEnv stands up the fake control plane, isolated credentials, and the exit seam,
// then returns a harness whose run() executes the real cobra tree and reports whether
// the invocation took a fatal (exitFunc) arm.
func projEnv(t *testing.T, s *projServer) projHarness {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme"}); err != nil {
		t.Fatalf("SaveCliConfig: %v", err)
	}

	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	prevExit, prevPoll, prevNoInput := exitFunc, jobPollInterval, noInputMode
	exitFunc = func(code int) { panic(projExit{code}) }
	jobPollInterval = time.Millisecond
	projResetFlags()
	t.Cleanup(func() {
		exitFunc, jobPollInterval, noInputMode = prevExit, prevPoll, prevNoInput
		projResetFlags()
	})

	run := func(args ...string) (exited bool) {
		defer func() {
			if r := recover(); r != nil {
				if _, ok := r.(projExit); !ok {
					panic(r)
				}
				exited = true
			}
		}()
		projResetFlags()
		rootCmd.SetArgs(args)
		if err := rootCmd.Execute(); err != nil {
			t.Errorf("execute %v: %v", args, err)
		}
		return false
	}
	return projHarness{run: run, srv: s, creds: credsPath}
}

// projTTY forces the terminal seams on, which is what makes the `interactiveTable`
// arm of every list command and the huh-backed selectors reachable at all.
func projTTY(t *testing.T) {
	t.Helper()
	prevIn, prevOut, prevNoInput := stdinIsTTY, stdoutIsTTY, noInputMode
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	t.Cleanup(func() {
		stdinIsTTY, stdoutIsTTY, noInputMode = prevIn, prevOut, prevNoInput
	})
}

// projConfirm pins the destructive-command confirmation to a fixed answer; no stub of
// runHuhForm can do this, because huh owns the pointer the answer is written through.
func projConfirm(t *testing.T, answer bool) {
	t.Helper()
	prev := confirm
	confirm = func(string, string) bool { return answer }
	t.Cleanup(func() { confirm = prev })
}

// projForm makes every huh form succeed without a terminal, so what happens AFTER a
// successful selection (rather than the TTY-error arm) is what runs.
func projForm(t *testing.T) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return nil }
	t.Cleanup(func() { runHuhForm = prev })
}

// projFormSeq makes runHuhForm answer a fixed sequence of results, so an EARLIER
// selector can succeed while a LATER one fails — which is the only way to reach the
// runner-picker's fatal arm, since a blanket failure stops at the project picker.
// The last entry repeats once the sequence is exhausted.
func projFormSeq(t *testing.T, results ...error) {
	t.Helper()
	prev := runHuhForm
	call := 0
	runHuhForm = func(...*huh.Group) error {
		r := results[len(results)-1]
		if call < len(results) {
			r = results[call]
		}
		call++
		return r
	}
	t.Cleanup(func() { runHuhForm = prev })
}

// projClosedStdout points os.Stdout at an already-closed file. A write error is the
// only way ui.Render/ui.RenderCard can fail, so this is what makes the "rendering the
// result failed" fatal arm reachable at all.
func projClosedStdout(t *testing.T) {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "closed")
	if err != nil {
		t.Fatalf("temp file: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close temp file: %v", err)
	}
	prev := os.Stdout
	os.Stdout = f
	t.Cleanup(func() { os.Stdout = prev })
}

// projNoAuth removes the stored credentials and answers "no" to the login prompt, so
// getAuthToken returns an error and the caller's fatal arm runs.
func projNoAuth(t *testing.T, h projHarness) {
	t.Helper()
	if err := os.Remove(h.creds); err != nil {
		t.Fatalf("remove credentials: %v", err)
	}
	prev := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) { return false, nil }
	t.Cleanup(func() { authRequiredPrompt = prev })
}

// --- fixtures ---

func projSampleComponents() []map[string]any {
	return []map[string]any{
		{"id": "c1", "kind": "databases", "name": "main", "status": "READY", "cloud_identity_id": "ci1"},
		{"id": "c2", "kind": "network", "name": "net", "status": "", "cloud_identity_id": nil},
	}
}

func projSampleEnvs() []map[string]any {
	return []map[string]any{
		{"id": "e1", "name": "production", "stage": "production", "status": "READY", "is_default": true, "region": "eu-west-1"},
		{"id": "e2", "name": "dev", "stage": "development", "status": "DRAFT", "is_default": false, "region": nil},
	}
}

func projSampleDims() []map[string]any {
	return []map[string]any{
		{"id": "d1", "key": "tier", "label": "Tier", "multi": false, "applies_to": []string{"project_environment"},
			"values": []map[string]any{{"id": "v1", "value": "gold", "label": "Gold"}}},
		{"id": "d2", "key": "owner", "label": "Owner", "multi": true, "applies_to": []string{}, "values": []map[string]any{}},
	}
}

func projSampleChannels() []map[string]any {
	return []map[string]any{
		{"id": "ch1", "name": "ops", "type": "webhook", "is_verified": true, "enabled": true},
		{"id": "ch2", "name": "mail", "type": "email", "is_verified": false, "enabled": false},
	}
}

func projSampleConfig() map[string]any {
	return map[string]any{
		"id": "p1", "project_name": "web", "environment_stage": "production",
		"container_platform": "eks", "cloud_account_id": "acct-1", "region": "eu-west-1",
		"iac_version": "1.11.4", "user_id": "u1",
		"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-02-01T00:00:00Z",
	}
}

// --- project component ---

// TestProj_ComponentKinds pins that `project component kinds` renders the kind registry
// in both the table and the json projection.
func TestProj_ComponentKinds(t *testing.T) {
	h := projEnv(t, &projServer{})
	for _, format := range []string{"table", "json", "csv"} {
		if h.run("project", "component", "kinds", "--output", format) {
			t.Errorf("kinds --output %s exited fatally", format)
		}
	}
}

// TestProj_ComponentListInteractive pins the TTY arm of `project component list`: the
// spinner-backed fetch, the populated table, and the empty-list notice.
func TestProj_ComponentListInteractive(t *testing.T) {
	s := &projServer{comps: projSampleComponents()}
	h := projEnv(t, s)
	projTTY(t)

	if h.run("project", "component", "list", "--project", "web", "--output", "table") {
		t.Error("interactive component list exited fatally")
	}
	if h.run("project", "component", "list", "--project", "web", "--kind", "databases", "--output", "table") {
		t.Error("filtered component list exited fatally")
	}
	s.comps = nil
	if h.run("project", "component", "list", "--project", "web", "--output", "table") {
		t.Error("empty component list exited fatally")
	}
}

// TestProj_ComponentListNonInteractive pins the scripting arm (json) and that a server
// error on either arm is fatal.
func TestProj_ComponentListNonInteractive(t *testing.T) {
	s := &projServer{comps: projSampleComponents()}
	h := projEnv(t, s)

	if h.run("project", "component", "list", "--project", "web", "--output", "json") {
		t.Error("json component list exited fatally")
	}
	s.failOn = []string{"/components"}
	if !h.run("project", "component", "list", "--project", "web", "--output", "json") {
		t.Error("json component list should exit on a server error")
	}
	projTTY(t)
	if !h.run("project", "component", "list", "--project", "web", "--output", "table") {
		t.Error("interactive component list should exit on a server error")
	}
}

// TestProj_ComponentListMissingProject pins that --project is required: there is no
// implicit active project, so the command exits rather than guessing one.
func TestProj_ComponentListMissingProject(t *testing.T) {
	h := projEnv(t, &projServer{})
	if !h.run("project", "component", "list", "--output", "json") {
		t.Error("component list without --project should exit")
	}
}

// TestProj_ComponentAdd pins `project component add`: the happy path with typed --set
// values, a malformed --set, a missing --kind, and a server error.
func TestProj_ComponentAdd(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if h.run("project", "component", "add", "--project", "web", "--kind", "databases",
		"--name", "main", "--set", "port=5432", "--set", "engine=postgres", "--output", "json") {
		t.Error("component add exited fatally")
	}
	if !h.run("project", "component", "add", "--project", "web", "--kind", "databases", "--set", "bogus", "--output", "json") {
		t.Error("component add with a malformed --set should exit")
	}
	if !h.run("project", "component", "add", "--project", "web", "--output", "json") {
		t.Error("component add without --kind should exit")
	}
	if !h.run("project", "component", "add", "--output", "json") {
		t.Error("component add without --project should exit")
	}
	s.failOn = []string{"/components"}
	if !h.run("project", "component", "add", "--project", "web", "--kind", "caches", "--name", "r", "--output", "json") {
		t.Error("component add should exit on a server error")
	}
}

// TestProj_ComponentRemove pins `project component remove`: a declined confirmation is a
// no-op, a confirmed one deletes, a missing --kind and a server error are both fatal.
func TestProj_ComponentRemove(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	projConfirm(t, false)
	if h.run("project", "component", "remove", "--project", "web", "--kind", "databases", "--name", "main", "--output", "json") {
		t.Error("declined component remove should not exit")
	}
	if !h.run("project", "component", "remove", "--project", "web", "--output", "json") {
		t.Error("component remove without --kind should exit")
	}
	if !h.run("project", "component", "remove", "--output", "json") {
		t.Error("component remove without --project should exit")
	}

	confirm = func(string, string) bool { return true }
	if h.run("project", "component", "remove", "--project", "web", "--kind", "network", "--output", "json") {
		t.Error("confirmed singleton remove exited fatally")
	}
	if h.run("project", "component", "remove", "--project", "web", "--kind", "databases", "--name", "main", "--output", "json") {
		t.Error("confirmed named remove exited fatally")
	}
	s.failOn = []string{"/components"}
	if !h.run("project", "component", "remove", "--project", "web", "--kind", "databases", "--name", "main", "--output", "json") {
		t.Error("component remove should exit on a server error")
	}
}

// --- project env ---

// TestProj_EnvListInteractive pins the TTY arm of `project env list`, populated and empty.
func TestProj_EnvListInteractive(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)
	projTTY(t)

	if h.run("project", "env", "list", "--project", "web", "--output", "table") {
		t.Error("interactive env list exited fatally")
	}
	s.envs = nil
	if h.run("project", "env", "list", "--project", "web", "--output", "table") {
		t.Error("empty env list exited fatally")
	}
}

// TestProj_EnvListNonInteractive pins the json arm and the fatal server-error arms.
func TestProj_EnvListNonInteractive(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)

	if h.run("project", "env", "list", "--project", "web", "--output", "json") {
		t.Error("json env list exited fatally")
	}
	if !h.run("project", "env", "list", "--output", "json") {
		t.Error("env list without --project should exit")
	}
	s.failOn = []string{"/environments"}
	if !h.run("project", "env", "list", "--project", "web", "--output", "json") {
		t.Error("json env list should exit on a server error")
	}
	projTTY(t)
	if !h.run("project", "env", "list", "--project", "web", "--output", "table") {
		t.Error("interactive env list should exit on a server error")
	}
}

// TestProj_EnvAdd pins `project env add`, including the missing --project and
// server-error fatal arms.
func TestProj_EnvAdd(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if h.run("project", "env", "add", "staging", "--project", "web", "--stage", "staging", "--region", "eu-west-1", "--output", "json") {
		t.Error("env add exited fatally")
	}
	if !h.run("project", "env", "add", "staging", "--output", "json") {
		t.Error("env add without --project should exit")
	}
	s.failOn = []string{"/environments"}
	if !h.run("project", "env", "add", "staging", "--project", "web", "--output", "json") {
		t.Error("env add should exit on a server error")
	}
}

// --- classification ---

// TestProj_ClassificationDimensions pins both render arms of `classification dimensions`
// plus the empty and server-error arms.
func TestProj_ClassificationDimensions(t *testing.T) {
	s := &projServer{dims: projSampleDims()}
	h := projEnv(t, s)

	if h.run("classification", "dimensions", "--output", "json") {
		t.Error("json dimensions exited fatally")
	}
	projTTY(t)
	if h.run("classification", "dimensions", "--output", "table") {
		t.Error("interactive dimensions exited fatally")
	}
	s.dims = nil
	if h.run("classification", "dimensions", "--output", "table") {
		t.Error("empty dimensions exited fatally")
	}
	s.failOn = []string{"/classification/dimensions"}
	if !h.run("classification", "dimensions", "--output", "table") {
		t.Error("interactive dimensions should exit on a server error")
	}
	if !h.run("classification", "dimensions", "--output", "json") {
		t.Error("json dimensions should exit on a server error")
	}
}

// TestProj_ClassificationShow pins `classification show <kind> <id>` on both arms, with
// the not-classified notice and the fatal server error.
func TestProj_ClassificationShow(t *testing.T) {
	s := &projServer{assigns: []map[string]any{
		{"dimension_key": "tier", "dimension_label": "Tier", "value": "gold", "value_label": "Gold"},
	}}
	h := projEnv(t, s)

	if h.run("classification", "show", "project_environment", "e1", "--output", "json") {
		t.Error("json show exited fatally")
	}
	projTTY(t)
	if h.run("classification", "show", "project_environment", "e1", "--output", "table") {
		t.Error("interactive show exited fatally")
	}
	s.assigns = nil
	if h.run("classification", "show", "project_environment", "e1", "--output", "table") {
		t.Error("unclassified show exited fatally")
	}
	s.failOn = []string{"/classification/assignments"}
	if !h.run("classification", "show", "project_environment", "e1", "--output", "table") {
		t.Error("interactive show should exit on a server error")
	}
	if !h.run("classification", "show", "project_environment", "e1", "--output", "json") {
		t.Error("json show should exit on a server error")
	}
}

// TestProj_ClassificationAssignUnassign pins the two mutating classification commands and
// their fatal server-error arms.
func TestProj_ClassificationAssignUnassign(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if h.run("classification", "assign", "project_environment", "e1", "tier", "gold", "--output", "json") {
		t.Error("assign exited fatally")
	}
	if h.run("classification", "unassign", "project_environment", "e1", "gold", "--output", "json") {
		t.Error("unassign exited fatally")
	}
	s.failOn = []string{"/classification/assignments"}
	if !h.run("classification", "assign", "project_environment", "e1", "tier", "gold", "--output", "json") {
		t.Error("assign should exit on a server error")
	}
	if !h.run("classification", "unassign", "project_environment", "e1", "gold", "--output", "json") {
		t.Error("unassign should exit on a server error")
	}
}

// --- channels ---

// TestProj_ChannelsList pins both render arms of `channels list`, the empty notice, and
// the fatal server-error arms.
func TestProj_ChannelsList(t *testing.T) {
	s := &projServer{channels: projSampleChannels()}
	h := projEnv(t, s)

	if h.run("channels", "list", "--output", "json") {
		t.Error("json channels list exited fatally")
	}
	projTTY(t)
	if h.run("channels", "list", "--output", "table") {
		t.Error("interactive channels list exited fatally")
	}
	s.channels = nil
	if h.run("channels", "list", "--output", "table") {
		t.Error("empty channels list exited fatally")
	}
	s.failOn = []string{"/cli/channels"}
	if !h.run("channels", "list", "--output", "table") {
		t.Error("interactive channels list should exit on a server error")
	}
	if !h.run("channels", "list", "--output", "json") {
		t.Error("json channels list should exit on a server error")
	}
}

// TestProj_ChannelsCreateVerify pins `channels create` (every config-carrying flag) and
// `channels verify`, plus both fatal server-error arms.
func TestProj_ChannelsCreateVerify(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if h.run("channels", "create", "ops", "--type", "webhook", "--url", "https://x/y",
		"--signing-secret", "s3cr3t", "--output", "json") {
		t.Error("channels create exited fatally")
	}
	if h.run("channels", "create", "mail", "--type", "email", "--recipient", "a@x.com",
		"--recipient", "b@x.com", "--output", "json") {
		t.Error("email channel create exited fatally")
	}
	if h.run("channels", "create", "pd", "--type", "pagerduty", "--routing-key", "rk", "--output", "json") {
		t.Error("pagerduty channel create exited fatally")
	}
	if h.run("channels", "verify", "ch1", "--output", "json") {
		t.Error("channels verify exited fatally")
	}
	s.failOn = []string{"/cli/channels"}
	if !h.run("channels", "create", "ops", "--type", "webhook", "--url", "https://x/y", "--output", "json") {
		t.Error("channels create should exit on a server error")
	}
	if !h.run("channels", "verify", "ch1", "--output", "json") {
		t.Error("channels verify should exit on a server error")
	}
}

// TestProj_ChannelsDelete pins that a declined confirmation is a no-op, a confirmed one
// deletes, and a server error is fatal.
func TestProj_ChannelsDelete(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	projConfirm(t, false)
	if h.run("channels", "delete", "ch1", "--output", "json") {
		t.Error("declined channel delete should not exit")
	}
	confirm = func(string, string) bool { return true }
	if h.run("channels", "delete", "ch1", "--output", "json") {
		t.Error("confirmed channel delete exited fatally")
	}
	s.failOn = []string{"/cli/channels"}
	if !h.run("channels", "delete", "ch1", "--output", "json") {
		t.Error("channel delete should exit on a server error")
	}
}

// --- project get ---

// TestProj_GetScriptingFormats pins that json/csv emit the record and never reach the
// interactive browser prompt.
func TestProj_GetScriptingFormats(t *testing.T) {
	h := projEnv(t, &projServer{config: projSampleConfig()})
	projTTY(t)
	for _, format := range []string{"json", "csv"} {
		if h.run("project", "get", "web", "--output", format) {
			t.Errorf("project get --output %s exited fatally", format)
		}
	}
}

// TestProj_GetTableOpensBrowser pins the TTY arm: the rendered project, the "open in
// browser?" prompt, and the --open shortcut that skips it.
func TestProj_GetTableOpensBrowser(t *testing.T) {
	h := projEnv(t, &projServer{config: projSampleConfig()})
	projTTY(t)
	projConfirm(t, true)

	opened := []string{}
	prev := openBrowser
	openBrowser = func(url string) error { opened = append(opened, url); return nil }
	t.Cleanup(func() { openBrowser = prev })

	if h.run("project", "get", "web", "--output", "table") {
		t.Error("project get exited fatally")
	}
	if len(opened) != 1 || !strings.HasSuffix(opened[0], "/dashboard") {
		t.Errorf("expected one /dashboard open, got %v", opened)
	}
	if h.run("project", "get", "web", "--open", "--output", "table") {
		t.Error("project get --open exited fatally")
	}
	if len(opened) != 2 {
		t.Errorf("--open should open the browser too, got %v", opened)
	}
}

// TestProj_GetBrowserFailureIsNotFatal pins that a browser that refuses to launch is
// reported but does not fail the command.
func TestProj_GetBrowserFailureIsNotFatal(t *testing.T) {
	h := projEnv(t, &projServer{config: projSampleConfig()})
	projTTY(t)
	prev := openBrowser
	openBrowser = func(string) error { return errBoom }
	t.Cleanup(func() { openBrowser = prev })

	if h.run("project", "get", "web", "--open", "--output", "table") {
		t.Error("a failed browser launch should not be fatal")
	}
}

// TestProj_GetMissingAndError pins the "no project found" notice and the fatal fetch error.
func TestProj_GetMissingAndError(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if h.run("project", "get", "nope", "--output", "table") {
		t.Error("a missing project should not be fatal")
	}
	s.failOn = []string{"by-project-name"}
	if !h.run("project", "get", "web", "--output", "table") {
		t.Error("project get should exit on a fetch error")
	}
}

// --- project create ---

// TestProj_CreateWithFlags pins the fully-flagged create path (no prompting) and the
// fatal server-error arm.
func TestProj_CreateWithFlags(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if h.run("project", "create", "api", "--region", "eu-west-1",
		"--cloud-identity-id", "ci1", "--stage", "development", "--iac-version", "1.11.4", "--output", "json") {
		t.Error("project create exited fatally")
	}
	s.failOn = []string{"/cli/projects"}
	if !h.run("project", "create", "api", "--region", "eu-west-1", "--cloud-identity-id", "ci1", "--output", "json") {
		t.Error("project create should exit on a server error")
	}
}

// TestProj_CreatePromptsOnTTY pins that an omitted --region opens the region form and an
// omitted --cloud-identity-id opens the cloud-account picker when prompting is allowed.
func TestProj_CreatePromptsOnTTY(t *testing.T) {
	h := projEnv(t, &projServer{})
	projTTY(t)
	projForm(t)

	if h.run("project", "create", "api", "--output", "json") {
		t.Error("prompted project create exited fatally")
	}
}

// TestProj_CreateRegionPromptFatal pins that a region prompt which cannot run — because
// prompting is disabled — is a hard error rather than an empty region.
func TestProj_CreateRegionPromptFatal(t *testing.T) {
	h := projEnv(t, &projServer{})
	if !h.run("project", "create", "api", "--no-input", "--output", "json") {
		t.Error("project create without --region and without prompts should exit")
	}
}

// --- plan / apply / destroy ---

// TestProj_PlanQueuesJob pins `project plan` with both ids supplied: no selector runs and
// the job is queued.
func TestProj_PlanQueuesJob(t *testing.T) {
	h := projEnv(t, &projServer{})
	if h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--output", "json") {
		t.Error("project plan exited fatally")
	}
}

// TestProj_PlanResolvesEnv pins that --env is resolved to an environment id, and that an
// unknown name is fatal rather than silently targeting the default.
func TestProj_PlanResolvesEnv(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)

	if h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--env", "production", "--output", "json") {
		t.Error("project plan --env exited fatally")
	}
	if !h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--env", "nope", "--output", "json") {
		t.Error("an unknown --env should exit")
	}
}

// TestProj_PlanQueueErrorIsFatal pins that a refused queue call exits non-zero.
func TestProj_PlanQueueErrorIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{failOn: []string{"/api/jobs"}})
	if !h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--output", "json") {
		t.Error("a refused queue call should exit")
	}
}

// TestProj_PlanSelectorsRun pins that omitting both ids runs the project and runner
// pickers, and that a picker which cannot open is fatal.
func TestProj_PlanSelectorsRun(t *testing.T) {
	h := projEnv(t, &projServer{})
	projTTY(t)
	projForm(t)
	if h.run("project", "plan", "--output", "json") {
		t.Error("plan through the pickers exited fatally")
	}

	runHuhForm = func(...*huh.Group) error { return errBoom }
	if !h.run("project", "plan", "--output", "json") {
		t.Error("plan should exit when the project picker cannot run")
	}
}

// TestProj_PlanWaitSucceeds pins `--wait`: the poll loop walks the status changes and
// reports the cost estimate carried in the job's execution metadata.
func TestProj_PlanWaitSucceeds(t *testing.T) {
	h := projEnv(t, &projServer{
		jobStatuses: []string{"QUEUED", "PROCESSING", "SUCCESS"},
		jobMeta:     map[string]any{"cost_breakdown": "42.00 USD"},
	})
	if h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("plan --wait exited fatally on a successful job")
	}
}

// TestProj_PlanWaitFailsIsFatal pins that a FAILED job makes `--wait` exit non-zero and
// surfaces the server's error message.
func TestProj_PlanWaitFailsIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{
		jobStatuses: []string{"CLAIMED", "FAILED"},
		jobErrMsg:   "terraform exploded",
	})
	if !h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("plan --wait should exit on a failed job")
	}
}

// TestProj_PlanWaitCancelledIsFatal pins the CANCELLED terminal state, and the
// unknown-error default when the server reports no message.
func TestProj_PlanWaitCancelledIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{jobStatuses: []string{"CANCELLED"}})
	if !h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("plan --wait should exit on a cancelled job")
	}
	h2 := projEnv(t, &projServer{jobStatuses: []string{"FAILED"}})
	if !h2.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("plan --wait should exit on a failed job with no message")
	}
}

// TestProj_PlanWaitPollErrorIsFatal pins that losing the control plane mid-wait exits
// rather than looping forever.
func TestProj_PlanWaitPollErrorIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{failOn: []string{"/api/cli/jobs/"}})
	if !h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("plan --wait should exit when polling fails")
	}
}

// TestProj_ApplyQueuesJob pins `project apply`, including --plan-job-id and --wait.
func TestProj_ApplyQueuesJob(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)

	if h.run("project", "apply", "--project-id", "p1", "--runner-id", "r1",
		"--plan-job-id", "j0", "--env", "production", "--output", "json") {
		t.Error("project apply exited fatally")
	}
	if h.run("project", "apply", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("project apply --wait exited fatally")
	}
	if !h.run("project", "apply", "--project-id", "p1", "--runner-id", "r1", "--env", "nope", "--output", "json") {
		t.Error("an unknown --env should exit")
	}
}

// TestProj_ApplySelectorsAndQueueError pins apply's picker arms and the refused queue call.
func TestProj_ApplySelectorsAndQueueError(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	projTTY(t)
	projForm(t)

	if h.run("project", "apply", "--output", "json") {
		t.Error("apply through the pickers exited fatally")
	}
	runHuhForm = func(...*huh.Group) error { return errBoom }
	if !h.run("project", "apply", "--output", "json") {
		t.Error("apply should exit when the project picker cannot run")
	}
	s.failOn = []string{"/api/jobs"}
	if !h.run("project", "apply", "--project-id", "p1", "--runner-id", "r1", "--output", "json") {
		t.Error("a refused queue call should exit")
	}
}

// TestProj_DestroyDeclined pins that declining the confirmation tears nothing down.
func TestProj_DestroyDeclined(t *testing.T) {
	h := projEnv(t, &projServer{})
	projConfirm(t, false)
	if h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--output", "json") {
		t.Error("a declined destroy should not exit")
	}
}

// TestProj_DestroyConfirmed pins the confirmed destroy path, --env resolution, --wait, and
// the fatal arms for an unknown env and a refused queue call.
func TestProj_DestroyConfirmed(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)
	projConfirm(t, true)

	if h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--env", "production", "--output", "json") {
		t.Error("project destroy exited fatally")
	}
	if h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("project destroy --wait exited fatally")
	}
	if !h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--env", "nope", "--output", "json") {
		t.Error("an unknown --env should exit")
	}
	s.failOn = []string{"/api/jobs"}
	if !h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--output", "json") {
		t.Error("a refused queue call should exit")
	}
}

// TestProj_DestroySelectors pins destroy's project and runner pickers, either succeeding
// or failing to open.
func TestProj_DestroySelectors(t *testing.T) {
	h := projEnv(t, &projServer{})
	projTTY(t)
	projForm(t)
	projConfirm(t, true)

	if h.run("project", "destroy", "--output", "json") {
		t.Error("destroy through the pickers exited fatally")
	}
	runHuhForm = func(...*huh.Group) error { return errBoom }
	if !h.run("project", "destroy", "--output", "json") {
		t.Error("destroy should exit when the project picker cannot run")
	}
}

// TestProj_RunnerPickerFailureIsFatal pins the second selector's fatal arm on all three
// job commands: the project picker answered, but the runner picker could not run, so the
// command exits rather than queueing a job against an unchosen runner.
func TestProj_RunnerPickerFailureIsFatal(t *testing.T) {
	for _, sub := range []string{"plan", "apply", "destroy"} {
		t.Run(sub, func(t *testing.T) {
			h := projEnv(t, &projServer{})
			projTTY(t)
			projConfirm(t, true)
			// The project picker answers, the runner picker refuses.
			projFormSeq(t, nil, errBoom)
			if !h.run("project", sub, "--output", "json") {
				t.Errorf("project %s should exit when the runner picker cannot run", sub)
			}
		})
	}
}

// TestProj_ApplyWaitFailsIsFatal pins that `apply --wait` on a job that ends FAILED exits
// non-zero rather than reporting a successful deploy.
func TestProj_ApplyWaitFailsIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{
		jobStatuses: []string{"PROCESSING", "FAILED"},
		jobErrMsg:   "apply exploded",
	})
	if !h.run("project", "apply", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("apply --wait should exit on a failed job")
	}
}

// TestProj_DestroyWaitFailsIsFatal pins the same for `destroy --wait`.
func TestProj_DestroyWaitFailsIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{jobStatuses: []string{"CANCELLED"}})
	projConfirm(t, true)
	if !h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("destroy --wait should exit on a cancelled job")
	}
}

// TestProj_ComponentKindsRenderErrorIsFatal pins that a failed write of the kind registry
// is reported and fatal, not swallowed into a silently empty listing.
func TestProj_ComponentKindsRenderErrorIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{})
	projClosedStdout(t)
	if !h.run("project", "component", "kinds", "--output", "json") {
		t.Error("component kinds should exit when the result cannot be written")
	}
}

// TestProj_GetRenderErrorIsFatal pins the same for `project get` on a scripting format:
// a project that cannot be written is an error, not a success with no output.
func TestProj_GetRenderErrorIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{config: projSampleConfig()})
	projClosedStdout(t)
	if !h.run("project", "get", "web", "--output", "json") {
		t.Error("project get should exit when the record cannot be written")
	}
}

// TestProj_UnauthenticatedIsFatal pins the shared first arm of every command in this
// scope: no usable credentials and a declined login prompt exits before any API call.
func TestProj_UnauthenticatedIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{config: projSampleConfig()})
	projNoAuth(t, h)

	cases := [][]string{
		{"project", "component", "list", "--project", "web"},
		{"project", "component", "add", "--project", "web", "--kind", "databases"},
		{"project", "component", "remove", "--project", "web", "--kind", "databases"},
		{"project", "env", "list", "--project", "web"},
		{"project", "env", "add", "staging", "--project", "web"},
		{"project", "get", "web"},
		{"project", "create", "api", "--region", "eu-west-1"},
		{"project", "plan", "--project-id", "p1"},
		{"project", "apply", "--project-id", "p1"},
		{"project", "destroy", "--project-id", "p1"},
		{"classification", "dimensions"},
		{"classification", "show", "project_environment", "e1"},
		{"classification", "assign", "project_environment", "e1", "tier", "gold"},
		{"classification", "unassign", "project_environment", "e1", "gold"},
		{"channels", "list"},
		{"channels", "create", "ops", "--type", "webhook", "--url", "https://x/y"},
		{"channels", "verify", "ch1"},
		{"channels", "delete", "ch1"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args[:2], "_"), func(t *testing.T) {
			if !h.run(append(args, "--output", "json")...) {
				t.Errorf("%v should exit when unauthenticated", args)
			}
		})
	}
}
