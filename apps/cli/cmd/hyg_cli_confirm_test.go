// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
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

// hygCliConfirmServer records every request the CLI made, as "METHOD path", plus each request's
// body.
//
// The body is recorded SEPARATELY rather than folded into the request line, so every existing
// `saw` and `mutations` assertion keeps comparing exactly what it always compared. It is needed
// because several of this API's endpoints put the thing being acted on in the PAYLOAD and not in
// the path — `DELETE /cli/projects/p/byo-charts` with `{"id": "…"}` — so a path-only recorder
// cannot tell "detached the chart the user picked" from "detached a different one".
type hygCliConfirmServer struct {
	mu       sync.Mutex
	requests []string
	bodies   []string
}

// record notes one inbound request and its body.
//
// The body is put back before the handler runs. The handler here never reads one, but a recorder
// that silently consumed the request would be a trap for the next case added to it.
func (s *hygCliConfirmServer) record(r *http.Request) {
	body := ""
	if r.Body != nil {
		if raw, err := io.ReadAll(r.Body); err == nil {
			body = string(raw)
			r.Body = io.NopCloser(bytes.NewReader(raw))
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, r.Method+" "+r.URL.Path)
	s.bodies = append(s.bodies, body)
}

// sentBody reports whether some request carried this exact JSON fragment in its payload.
func (s *hygCliConfirmServer) sentBody(fragment string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, b := range s.bodies {
		if strings.Contains(b, fragment) {
			return true
		}
	}
	return false
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
	s.bodies = nil
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
	// Added with the commands they gate. `tokenEnv` does not reset the cobra tree, so a --yes left
	// set here pre-confirms a LATER test in the same package run — which is the failure this
	// explicit list exists to prevent, and which is why a new --yes global must always be added to
	// it rather than relying on the VisitAll walk above.
	classificationUnassignYes, jobsCancelYes = false, false
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
		case strings.HasSuffix(p, "/byo-charts") && r.Method == http.MethodGet:
			// One attached chart, so `chart detach` and `chart scan` with no id can reach their
			// picker. Nothing that passes an id ever calls this endpoint — an id is a lookup key
			// and is sent to the server as given — so adding it changes no existing case.
			_ = enc.Encode(map[string]interface{}{
				"environment": "e1",
				"charts": []map[string]interface{}{
					{"id": "c1", "repo_url": "https://github.com/acme/charts", "chart_path": "charts/api",
						"ref": "main", "status": "Synced", "scan_status": "done"},
				},
			})
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
	// Missing since they were wired — nothing failed, because this list was both the subject AND
	// the definition of the set. TestHygCliConfirm_BehaviouralListCoversTheDerivedSet now makes
	// that impossible.
	{"addon_disable", []string{"addon", "disable", "a1", "--project", "p1", "--env", "e1"}},
	{"chart_detach", []string{"chart", "detach", "c1", "--project", "p1", "--env", "e1"}},
	{"iac_detach", []string{"iac", "detach", "--project", "p1", "--env", "e1"}},
	{"classification_unassign", []string{"classification", "unassign", "project_environment", "e1", "gold"}},
	{"jobs_cancel", []string{"jobs", "cancel", "j1"}},
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

// TestHygCliConfirm_InteractiveDeclineIsAQuietNoOp pins the arm the --no-input
// contract must NOT swallow: on a real terminal, answering "no" still returns
// quietly with nothing deleted and no fatal exit.
func TestHygCliConfirm_InteractiveDeclineIsAQuietNoOp(t *testing.T) {
	s, run := hygCliConfirmEnv(t)
	hygCliConfirmInteractive(t)
	prev := confirm
	confirm = func(string, string) bool { return false }
	t.Cleanup(func() { confirm = prev })

	if got := run("alerts", "delete", "ar1", "--output", "json"); got != 0 {
		t.Fatalf("exit code = %d, want 0 — a declined prompt is not an error", got)
	}
	if muts := s.mutations(); len(muts) > 0 {
		t.Errorf("a declined delete still changed state: %v", muts)
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

// TestHygCliConfirm_ListedDestructiveCommandsSpellYesTheSameWay pins the harmonization for the
// commands hygCliConfirmDestructive names: one flag, one spelling, one shorthand.
//
// RENAMED. It was TestHygCliConfirm_EveryDestructiveCommandOffersYes, and "Every" was false — it
// walks a hand-written list, so three destructive commands that were never added to that list
// (`token revoke`, `classification unassign`, `jobs cancel`) shipped with no confirmation at all
// while a test claiming to cover every one of them stayed green. The name is a load-bearing part of
// that failure: it is what stopped anyone asking where the list came from.
//
// The set is now DERIVED in TestHygCliConfirm_DerivedDestructiveSetAllOfferYes. This test keeps its
// value — it drives each listed command's flag through rootCmd.Find — but it is no longer, and must
// never again be described as, the definition of the set.
func TestHygCliConfirm_ListedDestructiveCommandsSpellYesTheSameWay(t *testing.T) {
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

// TestHygCliConfirm_ConfirmAcceptsAnAnsweredForm pins confirm's affirmative arm, the
// one no stub of runHuhForm can normally reach: the answer is written through a pointer
// huh owns, so the form has to be driven. Measured, not assumed — huh fills the bound
// value from a key message with no terminal involved and without blocking.
func TestHygCliConfirm_ConfirmAcceptsAnAnsweredForm(t *testing.T) {
	prev := runHuhForm
	runHuhForm = func(groups ...*huh.Group) error {
		f := huh.NewForm(groups...)
		f.Init()
		f.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })

	hygCliConfirmSetNoInput(t, false)
	if !confirm("Destroy?", "gone forever") {
		t.Error("confirm returned false for an affirmatively answered form")
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

// ── the inventory, DERIVED ──────────────────────────────────────────────────────────────────
//
// TestHygCliConfirm_ListedDestructiveCommandsSpellYesTheSameWay above walks a hand-written list, and a
// hand-written list of what a guard watches stops covering silently. It did: `token revoke`,
// `classification unassign` and `jobs cancel` were all destructive, all missing `--yes`, and all
// invisible to a test whose name claims to cover EVERY destructive command.
//
// So this one derives the set from the command tree instead. The list above stays — it pins the
// spelling and shorthand of the ones we know — but it can no longer be the definition of the set.

// destructiveVerbs are the leaf verbs that take something away. Matched against the FIRST word of
// a command's Use, so `cancel-job` does not match `cancel` and is handled by name below.
var destructiveVerbs = map[string]bool{
	"delete": true, "remove": true, "revoke": true, "destroy": true,
	"cancel": true, "unassign": true, "detach": true, "disable": true,
}

// A verb set is itself hand-written, so it has the same decay this file is about — one level
// further down. `ops drain-runner` and `ops unstick-env` take something away, match no verb, and
// would sit in neither map with nothing recording why. They are named here so the decision that
// they are gated by a required --reason is written down rather than implied by their absence.

// destructiveExemptions are commands that take something away and deliberately do NOT carry --yes,
// each with the stronger gate it carries instead. An exemption is a decision, not a mute button:
// the test below fails if one names a command that no longer exists, so the list cannot rot.
// alsoDestructive are commands that take something away under a verb the set above does not read as
// destructive. Named explicitly, because "cancel-job" is not "cancel" and `set` is not a verb any
// heuristic should treat as dangerous — but all of these destroy.
//
// The first cut of this test put the ops commands straight into destructiveExemptions, and the
// guard reported five exemptions matching nothing: they were never classified as destructive in the
// first place, so exempting them was decorative. An exemption for a command the filter never sees
// is a comment that looks like a rule — which is the same defect as the hand-written list this test
// replaces, one level up.
var alsoDestructive = map[string]bool{
	"alethia ops cancel-job":         true,
	"alethia ops orphan-clean":       true,
	"alethia ops force-release-lock": true,
	"alethia ops state-surgery":      true,
	"alethia ops drain-runner":       true,
	"alethia ops unstick-env":        true,
	"alethia fleet set":              true,
	"alethia token revoke":           true,
}

// destructiveExemptions are commands in the derived set that deliberately do NOT carry --yes,
// each naming the stronger gate it carries instead. An exemption is a decision, not a mute
// button: the stale-entry check fails if one names a command the filter never classifies as
// destructive, so an exemption cannot quietly become decorative.
var destructiveExemptions = map[string]string{
	"alethia ops cancel-job":         "audited --reason; runOpsAction fails closed on an empty one",
	"alethia ops orphan-clean":       "two-person --approval, a STRONGER gate than a single operator's --yes",
	"alethia ops force-release-lock": "two-person --approval",
	"alethia ops state-surgery":      "two-person --approval",
	"alethia ops drain-runner":       "audited --reason; runOpsAction fails closed on an empty one",
	"alethia ops unstick-env":        "audited --reason; runOpsAction fails closed on an empty one",
	// REVOCATION IS A SAFETY ACTION and its asymmetry runs the other way: revoking a token you did
	// not mean to is recoverable in one command, while failing to revoke a leaked one is not. A
	// gate here fails a CI pipeline revoking a compromised credential and LEAVES IT LIVE, which is
	// the moment an operator can least afford friction. Gated once, in this PR, and ungated on the
	// maintainer's ruling before it shipped.
	"alethia token revoke": "revocation is a safety action; a confirmation here fails incident-response pipelines and leaves the credential valid",
}

// walkLeaves yields every runnable leaf command under root.
func walkLeaves(root *cobra.Command) []*cobra.Command {
	var out []*cobra.Command
	var walk func(*cobra.Command)
	walk = func(c *cobra.Command) {
		if len(c.Commands()) == 0 {
			if c.Run != nil || c.RunE != nil {
				out = append(out, c)
			}
			return
		}
		for _, child := range c.Commands() {
			walk(child)
		}
	}
	walk(root)
	return out
}

func TestHygCliConfirm_DerivedDestructiveSetAllOfferYes(t *testing.T) {
	leaves := walkLeaves(rootCmd)
	// Vacuity: a walk that finds no commands would pass having checked nothing, and the whole
	// point of deriving the set is that nobody has to remember to extend it.
	if len(leaves) < 80 {
		t.Fatalf("walked only %d leaf commands — the CLI has well over a hundred, so this walk is "+
			"not seeing the tree and every assertion below is vacuous", len(leaves))
	}

	seen := map[string]bool{}
	destructive := 0
	for _, c := range leaves {
		path := c.CommandPath()
		// Fields on an empty Use returns an empty slice, and cobra permits an empty Use. Indexing
		// it would take the whole binary down instead of naming the command.
		fields := strings.Fields(c.Use)
		if len(fields) == 0 {
			t.Errorf("%q has an empty Use, so no verb can be read from it — give it one", path)
			continue
		}
		verb := fields[0]
		if !destructiveVerbs[verb] && !alsoDestructive[path] {
			continue
		}
		destructive++
		seen[path] = true
		if reason, exempt := destructiveExemptions[path]; exempt {
			if strings.TrimSpace(reason) == "" {
				t.Errorf("%s is exempted with no reason", path)
			}
			continue
		}
		f := c.Flags().Lookup("yes")
		if f == nil {
			t.Errorf("%s takes something away and has no --yes flag.\n"+
				"      Every sibling destructive command confirms through confirmDestructive, so a scripted\n"+
				"      caller of THIS one destroys without opting in. Either wire addYesFlag +\n"+
				"      confirmDestructive, or add it to destructiveExemptions naming the stronger gate it has.", path)
			continue
		}
		if f.Shorthand != "y" {
			t.Errorf("%s: --yes shorthand = %q, want %q — one flag, one spelling", path, f.Shorthand, "y")
		}
	}

	if destructive < 15 {
		t.Errorf("only %d destructive commands discovered; the repo had 16 wired plus 3 missing when this "+
			"was written, so a count this low means the verb set or the walk stopped matching", destructive)
	}

	// A stale exemption is its own failure: it makes the list look like a considered set of
	// decisions while one of them describes a command that is gone.
	for path := range destructiveExemptions {
		if !seen[path] {
			t.Errorf("exemption %q matches no destructive command — either it is gone, or the filter "+
				"never classifies it as destructive and the exemption is decorative. Delete it.", path)
		}
	}
	for path := range alsoDestructive {
		if !seen[path] {
			t.Errorf("alsoDestructive names %q, which the walk did not reach — that command is gone or renamed", path)
		}
	}
}

// TestHygCliConfirm_NewlyGatedCommandsHonourNo drives the DECLINE arm of the three commands this
// change gated. Without it the accept arm is exercised (every other test passes --yes) and the
// refusal is nine statements nobody runs — which the ratchet noticed before a human did.
//
// It is also the behaviour worth testing on its own merits, not merely a coverage errand: a
// destructive command that asks "are you sure?" and proceeds when told no is a worse failure than
// one that never asked, because the operator has been given a reason to believe they were heard.
//
// Each asserts BOTH halves: exit 0 (a declined prompt is a choice, not an error) and no mutation
// reaching the server. The exit code alone would pass for a command that destroyed and then
// returned cleanly.
func TestHygCliConfirm_NewlyGatedCommandsHonourNo(t *testing.T) {
	cases := map[string][]string{
		"classification unassign": {"classification", "unassign", "project_environment", "e1", "gold", "--output", "json"},
		"jobs cancel":             {"jobs", "cancel", "j1", "--output", "json"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			s, run := hygCliConfirmEnv(t)
			hygCliConfirmInteractive(t)
			prev := confirm
			confirm = func(string, string) bool { return false }
			t.Cleanup(func() { confirm = prev })

			if got := run(args...); got != 0 {
				t.Fatalf("exit code = %d, want 0 — a declined prompt is a choice, not an error", got)
			}
			if muts := s.mutations(); len(muts) > 0 {
				t.Errorf("%s was declined and still changed state: %v\n"+
					"      The confirmation must gate the API call, not decorate it.", name, muts)
			}
		})
	}
}

// The other half of the same seam: when the operator says YES, the command must actually act. A
// confirmation wired in front of a call that then never happens would satisfy the test above
// perfectly, and this is what makes that impossible.
func TestHygCliConfirm_NewlyGatedCommandsActOnYes(t *testing.T) {
	cases := map[string][]string{
		"jobs cancel": {"jobs", "cancel", "j1", "--yes", "--output", "json"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			s, run := hygCliConfirmEnv(t)
			if got := run(args...); got != 0 {
				t.Fatalf("exit code = %d, want 0", got)
			}
			if muts := s.mutations(); len(muts) == 0 {
				t.Errorf("%s was confirmed with --yes and sent NO mutation — the command is gated into doing nothing", name)
			}
		})
	}
}

// TestHygCliConfirm_BehaviouralListCoversTheDerivedSet closes the hole one level below the derived
// set, and it is the one that actually protects the regression this file exists for.
//
// Deriving the set fixed "WHICH commands do we check". It did not fix "WHAT do we check about
// them": TestHygCliConfirm_DerivedDestructiveSetAllOfferYes asserts only that a --yes flag is
// REGISTERED, and the two tests that drive the real contract — NoInputWithoutYesIsFatal and
// NoInputWithYesProceeds — run off hygCliConfirmDestructive, which is hand-written. So the
// `confirmDestructive` block could be deleted from a command, `addYesFlag` left in place, and the
// whole suite would stay green: a flag that is registered, accepted, and read by nobody.
//
// It was not hypothetical. That list named 12 while 18 commands call confirmDestructive; `addon
// disable`, `chart detach` and `iac detach` had no behavioural coverage from the day they were
// wired, because the list was simultaneously the subject of the test and the definition of what
// the test should cover.
//
// A hand-written ARGS table is unavoidable — every command needs its own valid invocation, and
// nothing can derive those. What is avoidable is the table also deciding the SET. Here the set is
// derived and the table must cover it; a gap is a failure that names the missing command.
func TestHygCliConfirm_BehaviouralListCoversTheDerivedSet(t *testing.T) {
	covered := map[string]bool{}
	for _, tc := range hygCliConfirmDestructive {
		cmd, _, err := rootCmd.Find(tc.args)
		if err != nil {
			t.Errorf("%s: args %v resolve to no command: %v", tc.name, tc.args, err)
			continue
		}
		covered[cmd.CommandPath()] = true
	}

	need := 0
	for _, c := range walkLeaves(rootCmd) {
		path := c.CommandPath()
		fields := strings.Fields(c.Use)
		if len(fields) == 0 {
			continue // reported by the derived-set test
		}
		if !destructiveVerbs[fields[0]] && !alsoDestructive[path] {
			continue
		}
		if _, exempt := destructiveExemptions[path]; exempt {
			continue // no --yes to exercise
		}
		need++
		if !covered[path] {
			t.Errorf("%s is in the derived destructive set and has NO entry in hygCliConfirmDestructive.\n"+
				"      Nothing drives its --no-input contract, so deleting its confirmDestructive block\n"+
				"      would leave the suite green with the flag still registered. Add an invocation.", path)
		}
	}

	// Vacuity, both directions. Zero required commands would pass having checked nothing, and the
	// count is the thing that silently fell out of step last time.
	if need < 15 {
		t.Errorf("only %d commands require a behavioural entry; 18 call confirmDestructive, so a "+
			"count this low means the derivation stopped matching", need)
	}
	if len(hygCliConfirmDestructive) < need {
		t.Errorf("the behavioural table has %d entries for %d commands that need one", len(hygCliConfirmDestructive), need)
	}
}
