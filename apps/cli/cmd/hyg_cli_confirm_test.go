// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// This file pins the --no-input contract of the destructive commands: with
// prompting disabled they must fail loudly instead of printing "Cancelled." and
// exiting 0, and --yes is the explicit opt-in that lets a script through.
//
// Before the fix a scripted `alethia project destroy` reached confirm, could not
// render a form on a non-TTY, and returned false — so the command exited 0 having
// queued nothing while the cloud resources it was meant to destroy kept billing.

// hygCliConfirmExit is the sentinel a trapped exitFunc panics with, so a fatal
// path is observable as an exit code instead of killing the test binary.
type hygCliConfirmExit struct{ code int }

// hygCliConfirmInteractive makes stdin look like a terminal for the rest of the
// test, so resolveInputMode leaves prompting enabled. A headless `go test` process
// has no terminal, so a destructive command otherwise takes the --yes-required arm
// rather than the confirm stub the test installed.
func hygCliConfirmInteractive(t *testing.T) {
	t.Helper()
	prev := stdinIsTTY
	stdinIsTTY = func() bool { return true }
	t.Cleanup(func() { stdinIsTTY = prev })
}

// hygCliConfirmSetNoInput pins noInputMode for a direct (non-cobra) unit test and
// restores it afterwards.
func hygCliConfirmSetNoInput(t *testing.T, v bool) {
	t.Helper()
	prev := noInputMode
	noInputMode = v
	t.Cleanup(func() { noInputMode = prev })
}

// hygCliConfirmTrapExit replaces exitFunc with one that panics, and returns a
// pointer to the recorded exit code (-1 while no exit has happened).
func hygCliConfirmTrapExit(t *testing.T) *int {
	t.Helper()
	code := -1
	prev := exitFunc
	exitFunc = func(c int) { code = c }
	t.Cleanup(func() { exitFunc = prev })
	return &code
}

// hygCliConfirmClearYes restores a command's --yes flag to its default after a test
// that passed it. cobra never clears a flag between Execute calls, so a leaked --yes
// would silently pre-confirm a destructive command in a later test.
func hygCliConfirmClearYes(t *testing.T, cmd *cobra.Command) {
	t.Helper()
	t.Cleanup(func() {
		f := cmd.Flags().Lookup("yes")
		if f == nil {
			return
		}
		_ = f.Value.Set(f.DefValue)
		f.Changed = false
	})
}

// hygCliConfirmServer records every request the CLI made, as "METHOD path".
type hygCliConfirmServer struct {
	mu       sync.Mutex
	requests []string
}

// record notes one inbound request.
func (s *hygCliConfirmServer) record(r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, r.Method+" "+r.URL.Path)
}

// mutations returns the requests that would have changed control-plane state.
func (s *hygCliConfirmServer) mutations() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, req := range s.requests {
		switch strings.SplitN(req, " ", 2)[0] {
		case http.MethodPost, http.MethodDelete, http.MethodPatch, http.MethodPut:
			out = append(out, req)
		}
	}
	return out
}

// saw reports whether the CLI made this exact request.
func (s *hygCliConfirmServer) saw(method, path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, req := range s.requests {
		if req == method+" "+path {
			return true
		}
	}
	return false
}

// forget clears the recorded requests so consecutive runs assert independently.
func (s *hygCliConfirmServer) forget() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = nil
}

// hygCliConfirmResetFlags puts the shared cobra tree back to its defaults. rootCmd
// is a package global and both the flags and the variables they bind survive an
// Execute, so --no-input or --yes would otherwise leak into the next run.
func hygCliConfirmResetFlags() {
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		c.Flags().VisitAll(func(f *pflag.Flag) {
			if !f.Changed {
				return
			}
			if sv, ok := f.Value.(pflag.SliceValue); ok {
				_ = sv.Replace(nil)
			} else {
				_ = f.Value.Set(f.DefValue)
			}
			f.Changed = false
		})
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	walk(rootCmd)
	projectDestroyProjectID, projectDestroyRunnerID = "", ""
	destroyRunnerID, destroyRunnerAssignedID = "", ""
	// The --yes opt-ins, in case a caller assigned one without going through a flag.
	alertsDeleteYes, channelsDeleteYes, connectorRemoveYes, fleetSetYes = false, false, false, false
	grantsRemoveYes, membersRemoveYes, componentRemoveYes, projectDestroyYes = false, false, false, false
	rolesDeleteYes, destroyRunnerYes, runnerRemoveYes, teamsDeleteYes = false, false, false, false
}

// hygCliConfirmEnv stands up isolated credentials, an active org and a fake control
// plane, traps exitFunc, and returns the recorder plus a runner that drives the real
// cobra tree and reports the exit code the command asked for (0 when it never exits).
func hygCliConfirmEnv(t *testing.T) (*hygCliConfirmServer, func(args ...string) int) {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	if err := types.SaveCliConfig(types.CliConfig{
		ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme",
	}); err != nil {
		t.Fatalf("SaveCliConfig: %v", err)
	}

	s := &hygCliConfirmServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.record(r)
		enc := json.NewEncoder(w)
		switch p := r.URL.Path; {
		case p == "/api/cli/cloud-identities":
			_ = enc.Encode(map[string]interface{}{"cloud_identities": []map[string]interface{}{
				{"id": "ci1", "provider": "aws", "label": "prod-account", "created_at": "2026-01-01T00:00:00Z"},
			}})
		case strings.HasPrefix(p, "/api/cli/fleet/"):
			_ = enc.Encode(map[string]interface{}{"pool": map[string]interface{}{
				"provider": strings.TrimPrefix(p, "/api/cli/fleet/"),
				"warm_min": 1, "max": 4, "slots_per_runner": 1, "enabled": false,
			}})
		case p == "/api/jobs" && r.Method == http.MethodPost:
			_ = enc.Encode(map[string]interface{}{"job": map[string]interface{}{
				"id": "j1", "job_type": "DESTROY", "status": "PENDING",
				"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
			}})
		default:
			_ = enc.Encode(map[string]interface{}{"ok": true})
		}
	}))
	t.Cleanup(srv.Close)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	prevExit := exitFunc
	exitFunc = func(code int) { panic(hygCliConfirmExit{code: code}) }
	t.Cleanup(func() {
		exitFunc = prevExit
		hygCliConfirmResetFlags()
	})

	return s, func(args ...string) (code int) {
		defer func() {
			hygCliConfirmResetFlags()
			if r := recover(); r != nil {
				e, ok := r.(hygCliConfirmExit)
				if !ok {
					panic(r)
				}
				code = e.code
			}
		}()
		// Reset before as well as after: a --yes left Changed by another test in this
		// package would otherwise silently pre-confirm the first run here.
		hygCliConfirmResetFlags()
		rootCmd.SetArgs(args)
		if err := rootCmd.Execute(); err != nil {
			return 1
		}
		return 0
	}
}

// hygCliConfirmDestructive is every command that gates itself on a destructive
// confirmation, with the arguments each needs to reach that gate.
var hygCliConfirmDestructive = []struct {
	name string
	args []string
}{
	{"alerts_delete", []string{"alerts", "delete", "ar1"}},
	{"channels_delete", []string{"channels", "delete", "ch1"}},
	{"connector_remove", []string{"connector", "remove", "aws"}},
	{"fleet_set_disable", []string{"fleet", "set", "aws", "--enabled=false"}},
	{"grants_remove", []string{"grants", "remove", "g1"}},
	{"members_remove", []string{"members", "remove", "m1"}},
	{"project_component_remove", []string{"project", "component", "remove", "--project", "p1", "--kind", "cluster"}},
	{"project_destroy", []string{"project", "destroy", "--project-id", "p1"}},
	{"roles_delete", []string{"roles", "delete", "ro1"}},
	{"runner_destroy", []string{"runner", "destroy", "--runner-id", "r1"}},
	{"runner_remove", []string{"runner", "remove", "r1"}},
	{"teams_delete", []string{"teams", "delete", "t1"}},
}

// TestHygCliConfirm_NoInputWithoutYesIsFatal is the regression this lane exists for.
// Every destructive command, run with --no-input and no --yes, must exit non-zero
// and change nothing. Before the fix each one printed "Cancelled." and exited 0.
func TestHygCliConfirm_NoInputWithoutYesIsFatal(t *testing.T) {
	s, run := hygCliConfirmEnv(t)
	for _, tc := range hygCliConfirmDestructive {
		t.Run(tc.name, func(t *testing.T) {
			s.forget()
			if got := run(append(append([]string{}, tc.args...), "--no-input")...); got != 1 {
				t.Errorf("exit code = %d, want 1 (a scripted destructive command must not exit 0)", got)
			}
			if muts := s.mutations(); len(muts) > 0 {
				t.Errorf("state was changed without a confirmation: %v", muts)
			}
		})
	}
}

// TestHygCliConfirm_NoInputWithYesProceeds is the precondition for the test above:
// the new guard refuses because the caller did not opt in, not because it blocks
// every scripted invocation. The same commands with --yes reach the control plane.
func TestHygCliConfirm_NoInputWithYesProceeds(t *testing.T) {
	s, run := hygCliConfirmEnv(t)
	for _, tc := range hygCliConfirmDestructive {
		t.Run(tc.name, func(t *testing.T) {
			s.forget()
			if got := run(append(append([]string{}, tc.args...), "--no-input", "--yes")...); got != 0 {
				t.Errorf("exit code = %d, want 0", got)
			}
			if muts := s.mutations(); len(muts) == 0 {
				t.Errorf("--yes did not reach the control plane; requests = %v", s.requests)
			}
		})
	}
}

// TestHygCliConfirm_ScriptedProjectDestroyQueuesTheJob spells out the money case
// from the issue: a scripted teardown must actually queue the DESTROY job.
func TestHygCliConfirm_ScriptedProjectDestroyQueuesTheJob(t *testing.T) {
	s, run := hygCliConfirmEnv(t)
	if got := run("project", "destroy", "--project-id", "p1", "--no-input", "--yes"); got != 0 {
		t.Fatalf("exit code = %d, want 0", got)
	}
	if !s.saw(http.MethodPost, "/api/jobs") {
		t.Errorf("no DESTROY job was queued; requests = %v", s.requests)
	}
}

// TestHygCliConfirm_ShortYesFlagWorks pins the -y shorthand, so the flag is usable
// the way `connector remove` already advertised it.
func TestHygCliConfirm_ShortYesFlagWorks(t *testing.T) {
	s, run := hygCliConfirmEnv(t)
	if got := run("roles", "delete", "ro1", "--no-input", "-y"); got != 0 {
		t.Fatalf("exit code = %d, want 0", got)
	}
	if !s.saw(http.MethodDelete, "/api/cli/roles/ro1") {
		t.Errorf("-y did not confirm the delete; requests = %v", s.requests)
	}
}

// TestHygCliConfirm_EveryDestructiveCommandOffersYes pins the harmonization: one
// flag, one spelling, one shorthand across all of them.
func TestHygCliConfirm_EveryDestructiveCommandOffersYes(t *testing.T) {
	for _, tc := range hygCliConfirmDestructive {
		t.Run(tc.name, func(t *testing.T) {
			cmd, _, err := rootCmd.Find(tc.args)
			if err != nil {
				t.Fatalf("find %v: %v", tc.args, err)
			}
			f := cmd.Flags().Lookup("yes")
			if f == nil {
				t.Fatalf("%q has no --yes flag", cmd.CommandPath())
			}
			if f.Shorthand != "y" {
				t.Errorf("--yes shorthand = %q, want %q", f.Shorthand, "y")
			}
		})
	}
}

// TestHygCliConfirm_ProjectGetKeepsNoYesFlag pins the deliberate exception: the
// "Open in Browser?" prompt is not destructive, so it gets no opt-in flag and must
// simply not open a browser when prompting is disabled.
func TestHygCliConfirm_ProjectGetKeepsNoYesFlag(t *testing.T) {
	cmd, _, err := rootCmd.Find([]string{"project", "get"})
	if err != nil {
		t.Fatalf("find project get: %v", err)
	}
	if f := cmd.Flags().Lookup("yes"); f != nil {
		t.Errorf("project get gained a --yes flag; the browser prompt is not destructive")
	}
}

// TestHygCliConfirm_ConfirmDeclinesWhenPromptsDisabled pins the seam itself: with
// prompting disabled confirm declines without ever opening a form. The enabled case
// is asserted first, so a stub that is simply never reached cannot pass this.
func TestHygCliConfirm_ConfirmDeclinesWhenPromptsDisabled(t *testing.T) {
	opened := 0
	prevForm := runHuhForm
	runHuhForm = func(...*huh.Group) error { opened++; return nil }
	t.Cleanup(func() { runHuhForm = prevForm })

	hygCliConfirmSetNoInput(t, false)
	if confirm("Delete?", "gone forever") {
		t.Fatal("a form that answered nothing must not confirm")
	}
	if opened != 1 {
		t.Fatalf("prompting enabled: form opened %d times, want 1", opened)
	}

	noInputMode = true
	if confirm("Delete?", "gone forever") {
		t.Error("confirm returned true with prompting disabled")
	}
	if opened != 1 {
		t.Errorf("prompting disabled: form opened %d times, want it left untouched", opened)
	}
}

// TestHygCliConfirm_ConfirmDestructiveMatrix walks the four --yes × --no-input
// combinations and pins which of them prompts, proceeds, or dies.
func TestHygCliConfirm_ConfirmDestructiveMatrix(t *testing.T) {
	cases := []struct {
		name      string
		yes       bool
		noInput   bool
		answer    bool
		want      bool
		wantAsked bool
		wantExit  int
	}{
		{"yes flag skips the prompt", true, false, false, true, false, -1},
		{"yes flag skips the prompt when scripted", true, true, false, true, false, -1},
		{"scripted without yes is fatal", false, true, true, false, false, 1},
		{"interactive accept", false, false, true, true, true, -1},
		{"interactive decline", false, false, false, false, true, -1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			asked := false
			prev := confirm
			confirm = func(string, string) bool { asked = true; return tc.answer }
			t.Cleanup(func() { confirm = prev })

			hygCliConfirmSetNoInput(t, tc.noInput)
			code := hygCliConfirmTrapExit(t)

			if got := confirmDestructive(tc.yes, "Destroy?", "gone forever"); got != tc.want {
				t.Errorf("confirmDestructive = %v, want %v", got, tc.want)
			}
			if asked != tc.wantAsked {
				t.Errorf("prompted = %v, want %v", asked, tc.wantAsked)
			}
			if *code != tc.wantExit {
				t.Errorf("exit code = %d, want %d", *code, tc.wantExit)
			}
		})
	}
}
