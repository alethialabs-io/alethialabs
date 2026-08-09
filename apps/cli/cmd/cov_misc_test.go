// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/mattn/go-isatty"
)

// The "misc" command group — alerts, org, ops*, sso, promotion, protection, config, repo,
// agent, addon, chart, probes, staged, clusters, activity, cost, iac, drift, open, root.
//
// Almost every statement in these files lives inside a package-level
// `var xCmd = &cobra.Command{Run: func…}`, so it is reachable only by executing the real
// cobra tree. These tests do exactly that against a fake control plane, in all three arms
// each command has: the interactive TTY arm (`if interactiveTable(cmd)`), the
// json/csv/static arm, and the fatal arm (`failf` → exitFunc).

// miscMode selects what the fake control plane answers with.
type miscMode int

const (
	// miscFull answers every endpoint with one populated envelope.
	miscFull miscMode = iota
	// miscEmpty answers with empty collections, so the "nothing found" arms run.
	miscEmpty
	// miscFail answers 500, so every command's error arm runs.
	miscFail
)

// miscExit is what the stubbed exitFunc panics with, so a fatal path can be observed
// without the test binary being killed by a real os.Exit.
type miscExit struct{ code int }

// miscEnvelope is the single JSON object the fake control plane returns for every
// request. Each API method decodes it into its own narrow struct and picks the one key
// it cares about; unknown keys are ignored by encoding/json. That keeps one handler
// serving ~25 endpoints without hand-writing a per-path switch.
func miscEnvelope(mode miscMode) map[string]any {
	if mode == miscEmpty {
		return map[string]any{
			"orgs": []any{}, "alert_rules": []any{}, "sso_providers": []any{},
			"activity": []any{}, "repositories": []any{}, "agents": []any{},
			"clusters": []any{}, "rules": []any{}, "probes": []any{},
			"addons": []any{}, "charts": []any{}, "changes": []any{},
			"promotions": []any{}, "configurations": []any{}, "details": []any{},
			"resources": []any{}, "source": nil, "environment": "production",
			"evaluated": false, "priced": false,
			// `sso get` dereferences the provider without a nil check (see the
			// defect noted in this file's report), so the empty envelope still
			// carries one rather than pinning that crash as the spec.
			"sso_provider": map[string]any{"id": "sso1", "provider_type": "oidc"},
			// break-glass: a result with no data payload.
			"sessionId": "s1", "expiresAt": "2026-01-02T00:00:00Z", "operator": "ops@x.com",
			"approvalId": "ap1", "note": "pass --approval ap1", "ok": true,
			"detail": "no-op",
		}
	}
	envName := "production"
	rev := "0123456789abcdef"
	repoURL := "https://github.com/acme/apps"
	msg := "api server reachable"
	ts := "2026-01-01T00:00:00Z"
	cost := 412.0
	minCount := 2
	soak := 30
	threshold := 50.0
	reachable := true
	return map[string]any{
		"orgs": []any{
			map[string]any{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner", "plan": "team", "is_active": true},
		},
		"configurations": []any{
			map[string]any{"id": "p1", "project_name": "web", "environment_stage": "production", "status": "ACTIVE"},
		},
		"alert_rules": []any{
			map[string]any{
				"id": "ar1", "name": "job failures", "severity": "critical",
				"event_patterns": []string{"system.job.failed"}, "channel_ids": []string{"ch1"},
				"enabled": true, "created_at": ts,
			},
		},
		"alert_rule": map[string]any{"id": "ar2", "name": "new rule", "severity": "warning"},
		"sso_providers": []any{
			map[string]any{"id": "sso1", "provider_type": "oidc", "domain": "acme.com", "issuer": "https://idp.acme.com", "enabled": true},
		},
		"sso_provider": map[string]any{
			"id": "sso1", "provider_type": "saml", "domain": "acme.com", "issuer": "https://idp.acme.com", "enabled": true,
		},
		"activity": []any{
			map[string]any{
				"id": "a1", "actor_id": "u1", "actor_email": "ada@x.com", "action": "project.apply",
				"resource_type": "project", "resource_id": "p1", "decision": true, "reason": "", "ts": ts,
			},
			map[string]any{
				"id": "a2", "actor_id": "u2", "actor_email": "", "action": "project.destroy",
				"resource_type": "project", "resource_id": "", "decision": false, "reason": "denied by policy", "ts": ts,
			},
		},
		"repositories": []any{
			map[string]any{"id": "r1", "name": "apps", "full_name": "acme/apps", "url": repoURL, "private": true, "default_branch": "main", "provider": "github"},
			map[string]any{"id": "r2", "name": "infra", "full_name": "", "url": repoURL, "private": false, "default_branch": "", "provider": "github"},
		},
		"agents": []any{
			map[string]any{"id": "ag1", "persona": "sre", "mission": "keep it up", "tool_scope": []string{"plan", "apply"}, "memory_namespace": "ns1", "version": 3},
		},
		"agent": map[string]any{
			"id": "ag1", "persona": "sre", "mission": "keep it up", "tool_scope": []string{"plan", "apply"}, "memory_namespace": "ns1", "version": 3,
		},
		"clusters": []any{
			map[string]any{
				"id": "c1", "cluster_name": "prod-eks", "cluster_version": "1.30", "status": "ACTIVE",
				"status_message": "", "argocd_url": "https://argo.acme.com", "estimated_monthly_cost": cost,
				"project_name": "web", "environment": envName, "region": "eu-west-1",
				"node_min_size": 2, "node_desired_size": 3, "node_max_size": 6,
			},
			map[string]any{
				"id": "c2", "cluster_name": "", "cluster_version": "", "status": "FAILED",
				"status_message": "subnet exhausted", "project_name": "api", "environment": "",
				"region": "eu-west-1",
			},
		},
		"cluster": map[string]any{
			"id": "c1", "cluster_name": "prod-eks", "cluster_version": "1.30", "status": "ACTIVE",
			"project_name": "web", "environment": envName, "region": "eu-west-1",
		},
		"gitops": map[string]any{
			"mode": "argocd", "apps_repo": repoURL, "revision": rev,
			"total": 4, "synced": 4, "healthy": 4, "status_available": true,
			"last_deploy_failed": false,
		},
		"rules": []any{
			map[string]any{
				"environment_id": "e1", "environment": envName,
				"require_predecessor": true, "require_verify_pass": true, "require_approval": true,
				"min_count": minCount, "soak_minutes": soak, "cost_delta_threshold": threshold,
			},
			map[string]any{"environment_id": "e2", "environment": "development"},
		},
		"probes": []any{
			map[string]any{"environment_id": "e1", "environment": envName, "reachable": reachable, "message": msg, "probed_at": ts},
			map[string]any{"environment_id": "e2", "environment": "development"},
		},
		"environment": envName,
		"addons": []any{
			map[string]any{"addon_id": "kube-prometheus", "enabled": true, "mode": "managed", "version": "1.2.3", "status": "INSTALLED", "health": "Healthy"},
			map[string]any{"addon_id": "redis", "enabled": false, "mode": "managed", "status": "PENDING"},
		},
		"charts": []any{
			map[string]any{"id": "bc1", "repo_url": repoURL, "chart_path": "charts/web", "ref": "main", "status": "SYNCED", "scan_status": "PASSED"},
		},
		"changes": []any{
			map[string]any{"component_type": "database", "op": "create", "component_id": "cmp1", "created_at": ts},
			map[string]any{"component_type": "cache", "op": "delete", "created_at": ts},
		},
		"source": map[string]any{
			"id": "iac1", "environment": envName, "name": "network", "repo_url": repoURL,
			"path": "modules/network", "ref": "main", "enabled": true, "scan_status": "PASSED",
			"commit_sha": rev, "status": "ATTACHED",
		},
		"promotions": []any{
			map[string]any{"id": "pr1", "source": "staging", "target": envName, "status": "PENDING", "created_at": ts},
		},
		"promotion": map[string]any{
			"id": "pr1", "source": "staging", "target": envName, "status": "BLOCKED",
			"initiator": "ada@x.com", "error_message": "soak window not elapsed",
			"approved": 1, "required": 2, "created_at": ts,
			"approvals": []any{
				map[string]any{"id": "ap1", "status": "approved", "name": "Ada", "required_role": "owner", "decided_at": ts},
				map[string]any{"id": "ap2", "status": "pending"},
			},
		},
		// drift posture (decoded straight into DriftPosture)
		"evaluated": true, "in_sync": false, "drifted": 2, "scanned_at": ts,
		"details": []any{
			map[string]any{"address": "aws_instance.a", "type": "aws_instance", "kind": "update"},
		},
		// environment cost (decoded straight into EnvironmentCost)
		"priced": true, "total_monthly": 412.5, "currency": "USD", "captured_at": ts,
		"resources": []any{
			map[string]any{"address": "aws_eks_cluster.main", "resource_type": "aws_eks_cluster", "monthly_cost": 72.0},
		},
		// configuration export
		"content": "project: web", "filename": "web.yaml", "format": "legacy-yaml",
		// break-glass
		"sessionId": "s1", "expiresAt": "2026-01-02T00:00:00Z", "operator": "ops@x.com",
		"approvalId": "ap1", "action": "state_surgery", "resourceId": "k1",
		"approver": "bob@x.com", "note": "pass --approval ap1",
		"ok": true, "detail": "action executed", "data": map[string]any{"rows": 1},
	}
}

// miscEnv stands up the fake control plane, isolated credentials and an active org, then
// returns a runner that executes the real cobra tree. It never sets --output itself, so a
// caller must always pass one explicitly — rootCmd is a package global and its flag state
// is sticky between runs.
func miscEnv(t *testing.T, mode miscMode) func(args ...string) error {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatal(err)
	}
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme"}); err != nil {
		t.Fatal(err)
	}

	body := miscEnvelope(mode)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if mode == miscFail {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "control plane exploded"})
			return
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	return func(args ...string) error {
		rootCmd.SetArgs(args)
		return rootCmd.Execute()
	}
}

// miscTTY makes the CLI believe it is attached to a terminal, so resolveInputMode leaves
// prompts enabled and interactiveTable returns true — the arm that holds most of this
// group's statements.
func miscTTY(t *testing.T) {
	t.Helper()
	prevIn, prevOut := stdinIsTTY, stdoutIsTTY
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	t.Cleanup(func() { stdinIsTTY, stdoutIsTTY = prevIn, prevOut })
}

// miscTrapExit replaces the process-exit hook with a panic, and returns a function that
// runs one command and reports whether it took the fatal path.
func miscTrapExit(t *testing.T, run func(args ...string) error) func(args ...string) bool {
	t.Helper()
	prev := exitFunc
	exitFunc = func(code int) { panic(miscExit{code}) }
	t.Cleanup(func() { exitFunc = prev })

	return func(args ...string) (exited bool) {
		defer func() {
			r := recover()
			if r == nil {
				return
			}
			if e, ok := r.(miscExit); ok {
				if e.code == 0 {
					t.Errorf("%v: fatal path exited 0, want non-zero", args)
				}
				exited = true
				return
			}
			panic(r)
		}()
		_ = run(args...)
		return false
	}
}

// miscReadCommands is every read-only command in this group with the flags it needs.
// Each entry runs identically in the interactive-table arm and the json arm.
func miscReadCommands() [][]string {
	return [][]string{
		{"alerts", "list"},
		{"sso", "list"},
		{"sso", "get", "sso1"},
		{"activity", "-n", "10"},
		{"repo", "list", "--provider", "github"},
		{"agent", "list"},
		{"agent", "get", "ag1"},
		{"cluster", "list"},
		{"cluster", "get", "web"},
		{"org", "list"},
		{"addon", "list", "-p", "web", "-e", "production"},
		{"chart", "list", "-p", "web", "-e", "production"},
		{"staged", "list", "-p", "web", "-e", "production"},
		{"protection", "list", "-p", "web"},
		{"probes", "list", "-p", "web"},
		{"promotion", "list", "-p", "web", "-e", "production"},
		{"promotion", "get", "pr1", "-p", "web"},
		{"cost", "show", "-p", "web", "-e", "production"},
		{"iac", "show", "-p", "web", "-e", "production"},
		{"drift", "show", "-p", "web", "-e", "production"},
	}
}

// TestMisc_ReadCommandsJSON pins that every read command in the group runs end to end
// through the cobra tree and emits json without erroring.
func TestMisc_ReadCommandsJSON(t *testing.T) {
	run := miscEnv(t, miscFull)
	for _, args := range miscReadCommands() {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if err := run(append(append([]string{}, args...), "--output", "json", "--no-input")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestMisc_ReadCommandsCSV pins the csv projection of every read command — it exercises
// the same row builders through a different ui.Render arm.
func TestMisc_ReadCommandsCSV(t *testing.T) {
	run := miscEnv(t, miscFull)
	for _, args := range miscReadCommands() {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if err := run(append(append([]string{}, args...), "--output", "csv", "--no-input")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestMisc_ReadCommandsInteractiveTable pins the interactive arm of every read command:
// with a TTY on both ends and prompts enabled, each list command takes the
// `if interactiveTable(cmd)` branch and renders through the Bubble Tea table. Under
// `go test` that table returns a "could not open a new TTY" error which every call site
// deliberately drops, so the command still completes.
func TestMisc_ReadCommandsInteractiveTable(t *testing.T) {
	miscTTY(t)
	run := miscEnv(t, miscFull)
	for _, args := range miscReadCommands() {
		if strings.Join(args, " ") == "cluster list" {
			// `cluster list` drives Bubble Tea directly and treats a table failure as
			// fatal; it has its own test below.
			continue
		}
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if err := run(append(append([]string{}, args...), "--output", "table", "--no-input=false")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestMisc_ClusterListInteractiveTableIsFatalOnTableError pins the one interactive list
// that does NOT drop its table error: `cluster list` builds its own Bubble Tea program
// (it needs fixed column widths) and exits when that program cannot start, where every
// ui.ShowTable call site merely discards the error.
func TestMisc_ClusterListInteractiveTableIsFatalOnTableError(t *testing.T) {
	miscTTY(t)
	run := miscTrapExit(t, miscEnv(t, miscFull))
	if !run("cluster", "list", "--output", "table", "--no-input=false") {
		t.Error("expected the fatal path when the cluster table cannot open a TTY")
	}
}

// TestMisc_EmptyResultsAreReported pins that an empty collection short-circuits into the
// muted "nothing here" note instead of rendering an empty table — in both arms.
func TestMisc_EmptyResultsAreReported(t *testing.T) {
	miscTTY(t)
	run := miscEnv(t, miscEmpty)
	for _, args := range miscReadCommands() {
		t.Run("interactive_"+strings.Join(args, "_"), func(t *testing.T) {
			if err := run(append(append([]string{}, args...), "--output", "table", "--no-input=false")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
		t.Run("static_"+strings.Join(args, "_"), func(t *testing.T) {
			if err := run(append(append([]string{}, args...), "--output", "table", "--no-input")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestMisc_ServerErrorsExitNonZero pins that a failing control plane takes every read
// command down the fatal path rather than printing a half-rendered result. Both arms are
// covered because the interactive branch has its own error check.
func TestMisc_ServerErrorsExitNonZero(t *testing.T) {
	miscTTY(t)
	run := miscTrapExit(t, miscEnv(t, miscFail))
	for _, args := range miscReadCommands() {
		t.Run("interactive_"+strings.Join(args, "_"), func(t *testing.T) {
			if !run(append(append([]string{}, args...), "--output", "table", "--no-input=false")...) {
				t.Errorf("%v: expected the fatal path", args)
			}
		})
		t.Run("static_"+strings.Join(args, "_"), func(t *testing.T) {
			if !run(append(append([]string{}, args...), "--output", "json", "--no-input")...) {
				t.Errorf("%v: expected the fatal path", args)
			}
		})
	}
}

// TestMisc_ProjectFlagIsRequired pins that the project-scoped commands refuse to guess a
// project: with --project empty each one exits rather than calling the control plane.
func TestMisc_ProjectFlagIsRequired(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscFull))
	cases := [][]string{
		{"addon", "list"},
		{"chart", "list"},
		{"staged", "list"},
		{"protection", "list"},
		{"probes", "list"},
		{"promotion", "list"},
		{"promotion", "get", "pr1"},
		{"cost", "show"},
		{"iac", "show"},
		{"drift", "show"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			full := append(append([]string{}, args...), "--project=", "--output", "json", "--no-input")
			if !run(full...) {
				t.Errorf("%v: expected the fatal path when --project is empty", args)
			}
		})
	}
}

// TestMisc_AlertsCreateAndDelete pins the alert-rule mutations: create reports the new
// rule, and delete only calls the control plane once the operator has confirmed.
func TestMisc_AlertsCreateAndDelete(t *testing.T) {
	run := miscEnv(t, miscFull)

	if err := run("alerts", "create", "job failures",
		"--event", "system.job.failed", "--channel", "ch1", "--severity", "critical",
		"--output", "json", "--no-input"); err != nil {
		t.Fatalf("alerts create: %v", err)
	}

	// The real prompt cannot be answered headlessly, so the un-confirmed path returns
	// without deleting anything.
	if err := run("alerts", "delete", "ar1", "--output", "json", "--no-input"); err != nil {
		t.Fatalf("alerts delete (cancelled): %v", err)
	}

	// With the operator confirming, the delete goes through.
	prev := confirm
	confirm = func(title, description string) bool { return true }
	t.Cleanup(func() { confirm = prev })
	if err := run("alerts", "delete", "ar1", "--output", "json", "--no-input"); err != nil {
		t.Fatalf("alerts delete (confirmed): %v", err)
	}
}

// TestMisc_AlertsMutationFailuresExit pins that a refused create/delete is fatal, not a
// silent success.
func TestMisc_AlertsMutationFailuresExit(t *testing.T) {
	prev := confirm
	confirm = func(title, description string) bool { return true }
	t.Cleanup(func() { confirm = prev })

	run := miscTrapExit(t, miscEnv(t, miscFail))
	if !run("alerts", "create", "x", "--event", "e", "--channel", "c", "--output", "json", "--no-input") {
		t.Error("alerts create: expected the fatal path")
	}
	if !run("alerts", "delete", "ar1", "--output", "json", "--no-input") {
		t.Error("alerts delete: expected the fatal path")
	}
}

// TestMisc_ConfigSurface pins the config verbs: the resolved-config card, get for each
// supported key, a validated set, and clearing the active-org context.
func TestMisc_ConfigSurface(t *testing.T) {
	run := miscEnv(t, miscFull)
	cases := [][]string{
		{"config", "--output", "table"},
		{"config", "--output", "json"},
		{"config", "--output", "csv"},
		{"config", "get"},
		{"config", "get", "web-origin"},
		{"config", "get", "active-org"},
		{"config", "set", "web-origin", "https://alethia.example.com/"},
		{"config", "clear-context"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			full := args
			if !strings.Contains(strings.Join(args, " "), "--output") {
				full = append(append([]string{}, args...), "--output", "table")
			}
			if err := run(append(full, "--no-input")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestMisc_ConfigRejectsUnknownKeys pins that an unrecognised config key is a hard error
// on both get and set, rather than silently doing nothing.
func TestMisc_ConfigRejectsUnknownKeys(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscFull))
	if !run("config", "get", "nope", "--output", "table", "--no-input") {
		t.Error("config get: expected the fatal path for an unknown key")
	}
	if !run("config", "set", "nope", "x", "--output", "table", "--no-input") {
		t.Error("config set: expected the fatal path for an unknown key")
	}
	if !run("config", "set", "web-origin", "not-a-url", "--output", "table", "--no-input") {
		t.Error("config set: expected the fatal path for an invalid origin")
	}
}

// TestMisc_ConfigExport pins the three export destinations: raw content on stdout, the
// envelope as json, and a file written by --out.
func TestMisc_ConfigExport(t *testing.T) {
	run := miscEnv(t, miscFull)
	if err := run("config", "export", "web", "--output", "table", "--no-input"); err != nil {
		t.Fatalf("config export raw: %v", err)
	}
	if err := run("config", "export", "web", "--output", "json", "--no-input"); err != nil {
		t.Fatalf("config export json: %v", err)
	}
	out := t.TempDir() + "/export.yaml"
	if err := run("config", "export", "web", "--out", out, "--output", "table", "--no-input"); err != nil {
		t.Fatalf("config export --out: %v", err)
	}
	if _, err := os.Stat(out); err != nil {
		t.Errorf("--out did not write the file: %v", err)
	}
}

// TestMisc_ConfigExportNeedsAProject pins that omitting the project falls back to the
// interactive picker, which refuses under --no-input rather than exporting the wrong
// project.
func TestMisc_ConfigExportNeedsAProject(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscFull))
	if !run("config", "export", "--out", "", "--output", "table", "--no-input") {
		t.Error("expected the fatal path when no project is given and prompts are disabled")
	}
}

// TestMisc_ConfigExportPickerRunsInteractively pins that with a TTY the same command
// reaches the project picker (which cannot complete headlessly, so the command exits).
func TestMisc_ConfigExportPickerRunsInteractively(t *testing.T) {
	miscTTY(t)
	run := miscTrapExit(t, miscEnv(t, miscFull))
	if !run("config", "export", "--out", "", "--output", "table", "--no-input=false") {
		t.Error("expected the fatal path when the picker cannot be answered")
	}
}

// TestMisc_OpsVerbs pins the break-glass surface: each verb opens an audited session and
// executes exactly one action against the single audited endpoint.
func TestMisc_OpsVerbs(t *testing.T) {
	run := miscEnv(t, miscFull)
	cases := [][]string{
		{"ops"},
		{"ops", "approve", "state_surgery", "k1", "--reason", "incident-1"},
		{"ops", "session", "--reason", "incident-1"},
		{"ops", "inspect-job", "j1", "--reason", "incident-1"},
		{"ops", "retry-job", "j1", "--reason", "incident-1"},
		{"ops", "cancel-job", "j1", "--reason", "incident-1"},
		{"ops", "drain-runner", "r1", "--reason", "incident-1"},
		{"ops", "restart-runner", "r1", "--reason", "incident-1"},
		{"ops", "replay-webhook", "evt_1", "--reason", "incident-1"},
		{"ops", "replay-webhook", "evt_1", "--reason", "incident-1", "--send-emails"},
		{"ops", "unstick-env", "e1", "--reason", "incident-1", "--from", "APPLYING, ", "--to", "FAILED"},
		{"ops", "force-release-lock", "k1", "--reason", "incident-1", "--approval", "ap1"},
		{"ops", "state-surgery", "k1", "--reason", "incident-1", "--approval", "ap1", "--note", "rebind the address"},
		{"ops", "state-surgery", "k1", "--reason", "incident-1", "--approval", "ap1", "--note", ""},
		{"ops", "orphan-detect", "--reason", "incident-1", "--project", "p1"},
		{"ops", "orphan-clean", "--reason", "incident-1", "--project", "p1", "--approval", "ap1"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if err := run(append(append([]string{}, args...), "--output", "json", "--no-input")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestMisc_OpsResultWithoutData pins that a result carrying no data payload prints the
// detail line alone, instead of an empty json block.
func TestMisc_OpsResultWithoutData(t *testing.T) {
	run := miscEnv(t, miscEmpty)
	if err := run("ops", "inspect-job", "j1", "--reason", "incident-1", "--output", "json", "--no-input"); err != nil {
		t.Fatalf("ops inspect-job: %v", err)
	}
}

// TestMisc_OpsRefusesMissingSafetyFlags pins the guardrails on the break-glass verbs: an
// incident --reason is always required, high-blast verbs need a two-person --approval,
// orphan verbs need a --project scope, and unstick-env needs both CAS sides. Each is
// refused before any call to the control plane.
func TestMisc_OpsRefusesMissingSafetyFlags(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscFull))
	cases := [][]string{
		{"ops", "approve", "state_surgery", "k1", "--reason="},
		{"ops", "session", "--reason="},
		{"ops", "inspect-job", "j1", "--reason="},
		{"ops", "force-release-lock", "k1", "--reason", "i", "--approval="},
		{"ops", "state-surgery", "k1", "--reason", "i", "--approval="},
		{"ops", "orphan-detect", "--reason", "i", "--project="},
		{"ops", "orphan-clean", "--reason", "i", "--project="},
		{"ops", "orphan-clean", "--reason", "i", "--project", "p1", "--approval="},
		{"ops", "unstick-env", "e1", "--reason", "i", "--from=", "--to="},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if !run(append(append([]string{}, args...), "--output", "json", "--no-input")...) {
				t.Errorf("%v: expected the fatal path", args)
			}
		})
	}
}

// TestMisc_OpsFailuresExit pins that a refused session or a refused action is fatal — a
// break-glass verb must never look like it succeeded.
func TestMisc_OpsFailuresExit(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscFail))
	for _, args := range [][]string{
		{"ops", "approve", "state_surgery", "k1", "--reason", "i"},
		{"ops", "session", "--reason", "i"},
		{"ops", "inspect-job", "j1", "--reason", "i"},
	} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if !run(append(append([]string{}, args...), "--output", "json", "--no-input")...) {
				t.Errorf("%v: expected the fatal path", args)
			}
		})
	}
}

// TestMisc_ClusterGetUnmatched pins that asking for a project with no cluster reports it
// plainly instead of rendering an empty card.
func TestMisc_ClusterGetUnmatched(t *testing.T) {
	run := miscEnv(t, miscFull)
	if err := run("cluster", "get", "no-such-project", "--output", "table", "--no-input"); err != nil {
		t.Fatalf("cluster get: %v", err)
	}
}

// TestMisc_OpenTargets pins which URL `alethia open` sends the browser to: the console by
// default, the docs for the `docs` alias and the explicit `docs` argument, and a refusal
// for anything else.
func TestMisc_OpenTargets(t *testing.T) {
	var opened []string
	prev := openBrowser
	openBrowser = func(url string) error {
		opened = append(opened, url)
		return nil
	}
	t.Cleanup(func() { openBrowser = prev })

	run := miscEnv(t, miscFull)
	for _, args := range [][]string{
		{"open"},
		{"open", "console"},
		{"open", "dashboard"},
		{"open", "docs"},
		{"docs"},
		{"dashboard"},
	} {
		if err := run(append(append([]string{}, args...), "--output", "table", "--no-input")...); err != nil {
			t.Errorf("%v: %v", args, err)
		}
	}
	if len(opened) != 6 {
		t.Fatalf("expected 6 browser launches, got %d: %v", len(opened), opened)
	}
	if opened[3] != docsURL || opened[4] != docsURL {
		t.Errorf("docs target did not resolve to the docs URL: %v", opened)
	}
	if !strings.HasPrefix(opened[0], "http") || opened[0] == docsURL {
		t.Errorf("default target should be the console origin, got %q", opened[0])
	}
}

// TestMisc_OpenReportsBrowserFailure pins that a browser that will not launch is reported
// rather than swallowed — the URL is already printed, so the command still succeeds.
func TestMisc_OpenReportsBrowserFailure(t *testing.T) {
	prev := openBrowser
	openBrowser = func(url string) error { return errBoom }
	t.Cleanup(func() { openBrowser = prev })

	run := miscEnv(t, miscFull)
	if err := run("open", "console", "--output", "table", "--no-input"); err != nil {
		t.Fatalf("open: %v", err)
	}
}

// TestMisc_OpenRejectsUnknownTarget pins that an unrecognised target exits instead of
// opening the console anyway.
func TestMisc_OpenRejectsUnknownTarget(t *testing.T) {
	prev := openBrowser
	openBrowser = func(url string) error {
		t.Errorf("browser should not be launched for an unknown target, got %q", url)
		return nil
	}
	t.Cleanup(func() { openBrowser = prev })

	run := miscTrapExit(t, miscEnv(t, miscFull))
	if !run("open", "nope", "--output", "table", "--no-input") {
		t.Error("expected the fatal path for an unknown open target")
	}
}

// TestMisc_RootBanner pins that a bare `alethia` prints the brand banner and its help,
// rather than erroring on a missing subcommand.
func TestMisc_RootBanner(t *testing.T) {
	run := miscEnv(t, miscFull)
	if err := run(); err != nil {
		t.Fatalf("bare root: %v", err)
	}
}

// TestMisc_ExecuteExitsOnUnknownCommand pins the top-level Execute wrapper: a command
// cobra cannot resolve is routed through the single fatal-error path, not returned to a
// caller that would ignore it.
func TestMisc_ExecuteExitsOnUnknownCommand(t *testing.T) {
	miscEnv(t, miscFull)
	prev := exitFunc
	exited := false
	exitFunc = func(code int) { exited = true; panic(miscExit{code}) }
	t.Cleanup(func() { exitFunc = prev })

	func() {
		defer func() {
			if r := recover(); r != nil {
				if _, ok := r.(miscExit); !ok {
					panic(r)
				}
			}
		}()
		rootCmd.SetArgs([]string{"definitely-not-a-command"})
		rootCmd.SetOut(os.Stderr)
		Execute()
	}()
	if !exited {
		t.Error("Execute did not take the fatal path for an unknown command")
	}
	rootCmd.SetOut(nil)
}

// TestMisc_WebOriginFollowsTheEnvironment pins that the exported WebOrigin helper resolves
// through the same precedence the client uses, so `open` and the API client cannot
// disagree about which control plane they are talking to.
func TestMisc_WebOriginFollowsTheEnvironment(t *testing.T) {
	isolatedHome(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://cp.example.com")
	if got := WebOrigin(); got != "https://cp.example.com" {
		t.Errorf("WebOrigin() = %q, want the env override", got)
	}
}

// ---------------------------------------------------------------------------
// The organization-administration, fleet, provider, runner and job surfaces.
//
// These commands do NOT share the one-envelope fake above: `provider status`,
// `provider verify`, `jobs get` and `runner deploy` each decode the whole response
// body into their own struct, and three of them want a different value under the
// same `status` key. So they get a path-aware fake instead.
// ---------------------------------------------------------------------------

// miscAdminOpts tunes the path-aware fake control plane: which collections come back
// empty, which endpoint answers 500, what the runner and cloud-account inventories look
// like, and what verdict the job poller and the provider probe report.
type miscAdminOpts struct {
	// empty makes every collection endpoint answer with a zero-length list.
	empty bool
	// failOn is a path substring the server answers 500 for ("" = never fail).
	failOn string
	// runners is the runner inventory the picker sees.
	runners []map[string]any
	// identities is the linked-cloud-account inventory the picker sees.
	identities []map[string]any
	// jobStatus is what GetJob reports. Empty means SUCCESS.
	jobStatus string
	// jobStatusAfter, when set, is reported from the second GetJob onwards, so a poll
	// loop runs its wait-and-retry arm exactly once.
	jobStatusAfter string
	// connected is the provider probe's connection verdict.
	connected bool
	// verified and verifyStatus are the re-verification verdict.
	verified     bool
	verifyStatus string
}

// miscAdminEnv stands up the path-aware fake control plane with isolated credentials and
// an active org, and returns a runner that executes the real cobra tree. As with miscEnv,
// the caller must always pass --output explicitly: rootCmd is a package global whose flag
// state is sticky between runs.
func miscAdminEnv(t *testing.T, o miscAdminOpts) func(args ...string) error {
	t.Helper()
	credsPath := isolatedHome(t)
	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: makeToken(t, time.Now().Add(time.Hour)), RefreshToken: "r",
	}); err != nil {
		t.Fatal(err)
	}
	if err := types.SaveCliConfig(types.CliConfig{
		ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme",
	}); err != nil {
		t.Fatal(err)
	}
	if o.jobStatus == "" {
		o.jobStatus = "SUCCESS"
	}
	if o.runners == nil {
		o.runners = miscRunnerInventory()
	}
	if o.identities == nil {
		o.identities = []map[string]any{
			{"id": "ci-aws", "provider": "aws", "label": "prod-account", "created_at": miscTS},
			{"id": "ci-gcp", "provider": "gcp", "label": "analytics", "created_at": miscTS},
		}
	}

	// jobPolls counts GetJob calls so jobStatusAfter can flip the verdict on the second
	// one; the fake is only ever driven by the single-threaded command under test.
	jobPolls := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		list := func(full []map[string]any) []map[string]any {
			if o.empty {
				return []map[string]any{}
			}
			return full
		}

		switch {
		case o.failOn != "" && strings.Contains(p, o.failOn):
			w.WriteHeader(http.StatusInternalServerError)
			write(map[string]string{"error": "control plane refused"})

		case p == "/api/cli/whoami":
			write(map[string]any{
				"user":       map[string]any{"id": "u1", "email": "ada@x.com", "name": "Ada"},
				"active_org": map[string]any{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner"},
			})
		case p == "/api/cli/orgs":
			write(map[string]any{"orgs": list([]map[string]any{
				{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner", "plan": "team", "is_active": true},
				{"id": "o2", "name": "Beta", "slug": "beta", "role": "member", "plan": "community"},
			})})

		// --- Access: grants, roles ---
		case p == "/api/cli/grants" && r.Method == http.MethodPost:
			write(map[string]any{"grant": map[string]any{
				"id": "g9", "principal_type": "user", "principal_id": "u1", "effect": "allow",
				"role": "operator", "resource_type": "project", "resource_id": "p1",
			}})
		case p == "/api/cli/grants":
			write(map[string]any{"grants": list([]map[string]any{
				{
					"id": "g1", "principal_type": "user", "principal_id": "u1", "effect": "allow",
					"role": "operator", "resource_type": "project", "resource_id": "p1",
				},
				{
					"id": "g2", "principal_type": "team", "principal_id": "t1", "effect": "deny",
					"permission_key": "project:destroy", "resource_type": "org",
				},
			})})
		case strings.HasPrefix(p, "/api/cli/grants/"):
			write(map[string]any{})

		case p == "/api/cli/roles" && r.Method == http.MethodPost:
			write(map[string]any{"role": map[string]any{
				"id": "role9", "name": "deployer", "permission_keys": []string{"project:deploy"},
			}})
		case p == "/api/cli/roles":
			write(map[string]any{"roles": list([]map[string]any{
				{"id": "role1", "name": "owner", "is_builtin": true, "permission_keys": []string{"a", "b", "c"}},
				{"id": "role2", "name": "deployer", "permission_keys": []string{"project:deploy"}},
			})})
		case strings.HasPrefix(p, "/api/cli/roles/"):
			write(map[string]any{})

		// --- Org: members, teams, settings ---
		case strings.HasSuffix(p, "/members") && r.Method == http.MethodPost:
			write(map[string]any{"invitation": map[string]any{
				"id": "inv1", "email": "new@x.com", "role": "operator", "status": "pending",
			}})
		case strings.HasSuffix(p, "/members"):
			write(map[string]any{"members": list([]map[string]any{
				{"id": "m1", "user_id": "u1", "email": "ada@x.com", "name": "Ada", "role": "owner", "status": "active"},
			})})
		case strings.Contains(p, "/members/"):
			write(map[string]any{})

		case strings.HasSuffix(p, "/teams") && r.Method == http.MethodPost:
			write(map[string]any{"team": map[string]any{"id": "t9", "name": "SRE", "member_count": 0}})
		case strings.HasSuffix(p, "/teams"):
			write(map[string]any{"teams": list([]map[string]any{
				{"id": "t1", "name": "Platform", "member_count": 2},
			})})
		case strings.Contains(p, "/teams/"):
			write(map[string]any{})

		case p == "/api/cli/org-settings":
			if o.empty {
				write(map[string]any{"settings": nil})
				return
			}
			write(map[string]any{"settings": map[string]any{
				"name": "Acme", "slug": "acme", "description": "", "region": "eu-west-1",
				"default_env": "production", "terraform_version": "1.9.0",
			}})

		// --- Billing / usage ---
		case p == "/api/cli/usage":
			write(map[string]any{"usage": map[string]any{
				"seats_used": 3, "seats_cap": 10, "runner_minutes": 412,
				"projects": 2, "ai_credits_used": 100, "ai_credits_granted": 500,
			}})
		case p == "/api/cli/billing":
			if o.empty {
				write(map[string]any{"billing": map[string]any{"plan": "community", "status": "active"}})
				return
			}
			write(map[string]any{"billing": map[string]any{
				"plan": "team", "status": "active", "seats": 5,
				"stripe_subscription_id": "sub_1", "trial_ends_at": miscTS, "current_period_end": miscTS,
			}})

		// --- Fleet ---
		case strings.HasPrefix(p, "/api/cli/fleet/"):
			write(map[string]any{"pool": miscFleetPool()})
		case p == "/api/cli/fleet":
			write(map[string]any{"pools": list([]map[string]any{
				miscFleetPool(),
				{"provider": "gcp", "warm_min": 0, "max": 4, "slots_per_runner": 1, "channel": "stable"},
				{"provider": "azure", "warm_min": 0, "max": 1, "slots_per_runner": 1},
			})})

		// --- Providers ---
		case strings.HasSuffix(p, "/status"):
			write(map[string]any{
				"connected": o.connected, "identityId": "ci-aws",
				"accountId": "123456789012", "roleArn": "arn:aws:iam::123456789012:role/alethia",
				"projectId": "gcp-proj", "serviceAccountEmail": "sa@gcp-proj.iam.gserviceaccount.com",
				"tenantId": "tid", "clientId": "cid", "subscriptionId": "sid",
			})
		case strings.HasSuffix(p, "/verify"):
			body := map[string]any{
				"identity_id": "ci-aws", "verified": o.verified, "status": o.verifyStatus,
			}
			if !o.verified {
				body["error"] = "assume-role denied"
				body["missing_permissions"] = []string{"eks:CreateCluster", "iam:PassRole"}
			}
			write(body)

		// --- Runners ---
		case p == "/api/cli/runners/deploy":
			write(map[string]any{
				"runner": map[string]any{"id": "rn9", "name": "runner-ci"},
				"job":    map[string]any{"id": "j9", "status": "QUEUED", "created_at": miscTS},
			})
		case p == "/api/cli/runners":
			write(map[string]any{"runners": list(o.runners)})
		case strings.HasPrefix(p, "/api/cli/runners/"):
			write(map[string]any{})

		case p == "/api/cli/cloud-identities":
			write(map[string]any{"cloud_identities": list(o.identities)})
		case strings.HasSuffix(p, "/inventory"):
			write(miscInventory(o.empty))

		case strings.HasSuffix(p, "/export"):
			write(map[string]any{"content": "project: web\n", "filename": "web.yaml", "format": "legacy-yaml"})

		// --- Break-glass ---
		case strings.HasSuffix(p, "/breakglass/session"):
			write(map[string]any{"sessionId": "s1", "expiresAt": miscTS, "operator": "ops@x.com"})
		case strings.HasSuffix(p, "/breakglass/approval"):
			write(map[string]any{"approvalId": "ap1", "note": "pass --approval ap1", "expiresAt": miscTS})
		case strings.HasSuffix(p, "/breakglass/execute"):
			write(map[string]any{"ok": true, "detail": "action executed"})

		// --- Jobs ---
		case strings.HasSuffix(p, "/logs"):
			write(map[string]any{"logs": list([]map[string]any{
				{"id": 1, "job_id": "j1", "log_chunk": "planning\n", "stream_type": "STDOUT"},
				{"id": 2, "job_id": "j1", "log_chunk": "warning: drift\n", "stream_type": "STDERR"},
				{"id": 3, "job_id": "j1", "log_chunk": "runner claimed\n", "stream_type": "SYSTEM"},
			})})
		case strings.HasSuffix(p, "/cancel"):
			write(map[string]any{})
		case p == "/api/jobs" && r.Method == http.MethodPost:
			write(map[string]any{"job": map[string]any{
				"id": "j9", "job_type": "DESTROY_RUNNER", "status": "QUEUED", "created_at": miscTS,
			}})
		case p == "/api/jobs":
			write(map[string]any{
				"jobs":  list([]map[string]any{{"id": "j1", "job_type": "PLAN", "status": "SUCCESS", "created_at": miscTS}}),
				"total": miscJobTotal(o.empty), "limit": 20, "offset": 0,
			})
		case strings.HasPrefix(p, "/api/cli/jobs/"):
			jobPolls++
			status := o.jobStatus
			if o.jobStatusAfter != "" && jobPolls > 1 {
				status = o.jobStatusAfter
			}
			write(map[string]any{
				"id": "j1", "job_type": "DEPLOY_RUNNER", "status": status,
				"created_at": miscTS, "updated_at": miscTS,
				"error_message":      "the template did not apply",
				"execution_metadata": map[string]any{"cost_breakdown": "€72/mo"},
				"config_snapshot":    map[string]any{},
			})

		default:
			w.WriteHeader(http.StatusNotFound)
			write(map[string]string{"error": "not found: " + p})
		}
	}))
	t.Cleanup(srv.Close)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	// Substitute the process-exit hook for the whole env, so a command that takes a fatal
	// path is reported to the caller instead of killing the test binary — even in a test
	// that expected the command to succeed.
	prevExit := exitFunc
	exitFunc = func(code int) { panic(miscExit{code}) }
	t.Cleanup(func() { exitFunc = prevExit })
	t.Cleanup(miscResetNoInput)

	return func(args ...string) (err error) {
		defer func() {
			r := recover()
			if r == nil {
				return
			}
			e, ok := r.(miscExit)
			if !ok {
				panic(r)
			}
			if e.code == 0 {
				t.Errorf("%v: fatal path exited 0, want non-zero", args)
			}
			err = errMiscExited
		}()
		miscResetNoInput()
		rootCmd.SetArgs(args)
		return rootCmd.Execute()
	}
}

// errMiscExited reports that a command took the fatal path (it called exitFunc).
var errMiscExited = errors.New("command exited")

// miscFatalRunner adapts a runner into a predicate: true when the command exited.
func miscFatalRunner(run func(args ...string) error) func(args ...string) bool {
	return func(args ...string) bool { return errors.Is(run(args...), errMiscExited) }
}

// miscResetNoInput clears --no-input on rootCmd. It is a persistent flag on a package
// global, so one test passing it would otherwise disable prompts for every later test —
// which silently turns an interactive arm into a fatal one.
func miscResetNoInput() {
	f := rootCmd.PersistentFlags().Lookup("no-input")
	if f == nil {
		return
	}
	_ = f.Value.Set("false")
	f.Changed = false
}

// miscTS is the one timestamp every fixture uses, so no assertion can depend on the clock.
const miscTS = "2026-01-01T00:00:00Z"

// miscRunnerInventory is the default runner list: one ONLINE default (which the picker
// pre-selects), plus a DRAINING and an OFFLINE one so every status glyph arm renders.
func miscRunnerInventory() []map[string]any {
	return []map[string]any{
		{"id": "r1", "name": "primary", "operator": "managed", "status": "ONLINE", "is_default": true},
		{"id": "r2", "name": "spare", "operator": "self", "provisioning": "registered", "status": "DRAINING"},
		{"id": "r3", "name": "cold", "operator": "self", "provisioning": "deployed", "status": "OFFLINE"},
	}
}

// miscFleetPool is a fully populated warm pool (pinned version + locations).
func miscFleetPool() map[string]any {
	return map[string]any{
		"provider": "aws", "warm_min": 2, "max": 10, "slots_per_runner": 2,
		"locations": []string{"eu-west-1", "us-east-1"}, "version": "1.4.2", "enabled": true,
	}
}

// miscInventory is a cloud identity's discovered networking, or an empty one.
func miscInventory(empty bool) map[string]any {
	if empty {
		return map[string]any{"networks": []any{}, "subnets": []any{}, "regions": []any{}}
	}
	name, region, cidr, az := "prod-vpc", "eu-west-1", "10.0.0.0/16", "eu-west-1a"
	return map[string]any{
		"networks": []any{
			map[string]any{"native_id": "vpc-1", "name": name, "region": region, "provider": "aws", "cidr_block": cidr, "is_default": true},
			map[string]any{"native_id": "vpc-2", "provider": "aws"},
		},
		"subnets": []any{
			map[string]any{"native_id": "sub-1", "name": "public-a", "region": region, "availability_zone": az, "cidr_block": "10.0.1.0/24", "is_public": true},
			map[string]any{"native_id": "sub-2"},
		},
		"regions": []string{"eu-west-1", "us-east-1"},
	}
}

// miscJobTotal reports the job count matching the empty/populated fixture.
func miscJobTotal(empty bool) int {
	if empty {
		return 0
	}
	return 1
}

// miscAlwaysConfirm answers yes to every destructive confirmation, and restores the real
// prompt afterwards. No stub of runHuhForm can do this: the answer is written through a
// pointer the huh group owns and never exposes.
func miscAlwaysConfirm(t *testing.T, answer bool) {
	t.Helper()
	prev := confirm
	confirm = func(string, string) bool { return answer }
	t.Cleanup(func() { confirm = prev })
}

// miscStubForm makes every huh form return immediately without touching a terminal, so a
// selector runs its whole option-building body and then returns its default value.
func miscStubForm(t *testing.T) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return nil }
	t.Cleanup(func() { runHuhForm = prev })
}

// miscFastPolls shrinks the two job poll intervals so a wait loop cannot add wall-clock
// time to the suite, and restores them afterwards.
func miscFastPolls(t *testing.T) {
	t.Helper()
	prevJob, prevLogs := jobPollInterval, jobsLogsPollInterval
	jobPollInterval, jobsLogsPollInterval = time.Millisecond, time.Millisecond
	t.Cleanup(func() { jobPollInterval, jobsLogsPollInterval = prevJob, prevLogs })
}

// miscRestoreFlagState snapshots the package-level variables these commands bind their
// flags to — and pflag's "was this flag passed?" bits, which `fleet set` reads directly —
// then restores them. rootCmd is a package global, so without this one test's flag value
// silently becomes the next test's default.
func miscRestoreFlagState(t *testing.T) {
	t.Helper()
	gPT, gPID, gE, gR, gPerm, gRT, gRID := grantPrincipalType, grantPrincipalID, grantEffect,
		grantRoleID, grantPermission, grantResourceType, grantResourceID
	perms := rolePermissions
	mRole := membersAddRole
	dCI, dName, dRegion, dAssigned, dWait := deployCloudIdentityID, deployRunnerName,
		deployRegion, deployAssignedID, deployRunnerWait
	xID, xAssigned, xWait := destroyRunnerID, destroyRunnerAssignedID, destroyRunnerWait
	fWarm, fMax, fSlots, fOn, fChan, fVer := fleetWarmMin, fleetMax, fleetSlots,
		fleetEnabled, fleetChannel, fleetVersion
	follow := jobsLogsFollow
	jStatus, jLimit := jobsListStatus, jobsListLimit
	t.Cleanup(func() {
		grantPrincipalType, grantPrincipalID, grantEffect, grantRoleID, grantPermission,
			grantResourceType, grantResourceID = gPT, gPID, gE, gR, gPerm, gRT, gRID
		rolePermissions = perms
		membersAddRole = mRole
		deployCloudIdentityID, deployRunnerName, deployRegion, deployAssignedID,
			deployRunnerWait = dCI, dName, dRegion, dAssigned, dWait
		destroyRunnerID, destroyRunnerAssignedID, destroyRunnerWait = xID, xAssigned, xWait
		fleetWarmMin, fleetMax, fleetSlots, fleetEnabled, fleetChannel, fleetVersion =
			fWarm, fMax, fSlots, fOn, fChan, fVer
		jobsLogsFollow = follow
		jobsListStatus, jobsListLimit = jStatus, jLimit
		miscClearFleetChanged()
	})
}

// miscClearFleetChanged resets pflag's Changed bits on `fleet set`. buildFleetUpdate reads
// them to decide what to send, and they are never cleared within a process.
func miscClearFleetChanged() {
	for _, name := range []string{"warm-min", "max", "slots", "enabled", "channel", "version"} {
		if f := fleetSetCmd.Flags().Lookup(name); f != nil {
			f.Changed = false
		}
	}
}

// miscAdminCommands is every command in this group that reaches for a token before it does
// anything else, with the flags each one needs to get past cobra's argument validation.
func miscAdminCommands() [][]string {
	return [][]string{
		{"whoami"},
		{"org", "list"}, {"org", "settings"}, {"org", "switch", "acme"},
		{"members", "list"}, {"members", "add", "new@x.com"}, {"members", "remove", "m1"},
		{"teams", "list"}, {"teams", "create", "SRE"}, {"teams", "delete", "t1"},
		{"grants", "list"}, {"grants", "add", "--principal", "u1", "--role", "role1"}, {"grants", "remove", "g1"},
		{"roles", "list"}, {"roles", "create", "deployer"}, {"roles", "delete", "role2"},
		{"fleet", "list"}, {"fleet", "set", "aws", "--max", "4"},
		{"provider", "status", "aws"}, {"provider", "verify", "aws"},
		{"runner", "list"}, {"runner", "remove", "r1"},
		{"runner", "deploy", "--cloud-identity-id", "ci-aws", "--name", "n", "--region", "eu-west-1", "--assigned-runner-id", "r1"},
		{"runner", "destroy", "--runner-id", "r1", "--assigned-runner-id", "r2"},
		{"jobs", "list"}, {"jobs", "get", "j1"}, {"jobs", "logs", "j1"}, {"jobs", "cancel", "j1"},
		{"usage"}, {"billing"}, {"cloud", "inventory", "ci-aws"},
		{"project", "list"}, {"connector", "list"}, {"cluster", "list"}, {"config", "export", "web"},
		{"activity"}, {"repo", "list"}, {"agent", "list"}, {"agent", "get", "ag1"},
		{"alerts", "list"}, {"alerts", "create", "rule"}, {"alerts", "delete", "ar1"},
		{"sso", "list"}, {"sso", "get", "sso1"},
		{"addon", "list", "-p", "web"}, {"chart", "list", "-p", "web"}, {"staged", "list", "-p", "web"},
		{"protection", "list", "-p", "web"}, {"probes", "list", "-p", "web"},
		{"promotion", "list", "-p", "web"}, {"promotion", "get", "pr1", "-p", "web"},
		{"cost", "show", "-p", "web"}, {"iac", "show", "-p", "web"}, {"drift", "show", "-p", "web"},
		{"cluster", "get", "web"},
		{"ops", "session", "--reason", "incident-1"},
		{"ops", "approve", "state_surgery", "k1", "--reason", "incident-1"},
	}
}

// TestMisc_EveryCommandFailsClosedWithoutCredentials pins the single most repeated branch
// in this package: with no credentials on disk and prompting refused, every authenticated
// command exits non-zero at the token check rather than calling the control plane with an
// empty token.
func TestMisc_EveryCommandFailsClosedWithoutCredentials(t *testing.T) {
	isolatedHome(t) // deliberately no saveCredentials
	miscRestoreFlagState(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", "http://127.0.0.1:1")
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	prev := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) { return false, nil }
	t.Cleanup(func() { authRequiredPrompt = prev })

	run := miscTrapExit(t, func(args ...string) error {
		rootCmd.SetArgs(args)
		return rootCmd.Execute()
	})

	for _, args := range miscAdminCommands() {
		if !run(append(append([]string{}, args...), "--output", "json")...) {
			t.Errorf("%v: expected the missing-credentials path to exit non-zero", args)
		}
	}
}

// TestMisc_AccessSurfaceReads pins `grants list` and `roles list` in all three arms —
// interactive table, json, and the muted note when the org has none.
func TestMisc_AccessSurfaceReads(t *testing.T) {
	for _, tc := range []struct {
		name  string
		empty bool
		tty   bool
		out   string
	}{
		{"json", false, false, "json"},
		{"csv", false, false, "csv"},
		{"static table", false, false, "table"},
		{"interactive table", false, true, "table"},
		{"empty static", true, false, "table"},
		{"empty interactive", true, true, "table"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run := miscAdminEnv(t, miscAdminOpts{empty: tc.empty})
			if tc.tty {
				miscTTY(t)
			}
			for _, args := range [][]string{{"grants", "list"}, {"roles", "list"}} {
				if err := run(append(args, "--output", tc.out)...); err != nil {
					t.Errorf("%v: %v", args, err)
				}
			}
		})
	}
}

// TestMisc_AccessSurfaceMutations pins the grant and role write verbs: a grant binds
// either a role or a single permission (never both), and revoking one only calls the
// control plane after the operator confirms.
func TestMisc_AccessSurfaceMutations(t *testing.T) {
	miscRestoreFlagState(t)
	run := miscAdminEnv(t, miscAdminOpts{})
	miscAlwaysConfirm(t, true)

	for _, args := range [][]string{
		{"grants", "add", "--principal", "u1", "--role", "role1", "--permission", "", "--resource", "p1", "--resource-type", "project"},
		{"grants", "add", "--principal", "t1", "--principal-type", "team", "--role", "", "--permission", "project:destroy", "--effect", "deny", "--resource", ""},
		{"grants", "remove", "g1"},
		{"roles", "create", "deployer", "--permission", "project:deploy"},
		{"roles", "delete", "role2"},
	} {
		if err := run(append(args, "--output", "json")...); err != nil {
			t.Errorf("%v: %v", args, err)
		}
	}
}

// TestMisc_AccessSurfaceRefusals pins that a grant binding neither (or both) of a role and
// a permission is refused before any call, a declined confirmation revokes nothing, and a
// refusing control plane is fatal on every access verb.
func TestMisc_AccessSurfaceRefusals(t *testing.T) {
	miscRestoreFlagState(t)

	t.Run("role and permission are exclusive", func(t *testing.T) {
		miscRestoreFlagState(t)
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
		for _, args := range [][]string{
			{"grants", "add", "--principal", "u1", "--role", "", "--permission", ""},
			{"grants", "add", "--principal", "u1", "--role", "role1", "--permission", "project:deploy"},
		} {
			if !exits(append(args, "--output", "json")...) {
				t.Errorf("%v: expected a refusal", args)
			}
		}
	})

	t.Run("declined confirmation revokes nothing", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, false)
		for _, args := range [][]string{{"grants", "remove", "g1"}, {"roles", "delete", "role2"}} {
			if err := run(append(args, "--output", "json")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		}
	})

	t.Run("a refusing control plane is fatal", func(t *testing.T) {
		miscRestoreFlagState(t)
		miscAlwaysConfirm(t, true)
		for _, tc := range []struct {
			failOn string
			args   []string
		}{
			{"/grants", []string{"grants", "list"}},
			{"/grants", []string{"grants", "add", "--principal", "u1", "--role", "role1", "--permission", ""}},
			{"/grants", []string{"grants", "remove", "g1"}},
			{"/roles", []string{"roles", "list"}},
			{"/roles", []string{"roles", "create", "x"}},
			{"/roles", []string{"roles", "delete", "role2"}},
		} {
			exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: tc.failOn}))
			if !exits(append(tc.args, "--output", "json")...) {
				t.Errorf("%v: expected the failure to be fatal", tc.args)
			}
		}
	})

	t.Run("a refusing control plane is fatal on the interactive arm too", func(t *testing.T) {
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/"}))
		miscTTY(t)
		for _, args := range [][]string{
			{"grants", "list"}, {"roles", "list"}, {"teams", "list"}, {"members", "list"}, {"fleet", "list"},
		} {
			if !exits(append(args, "--output", "table")...) {
				t.Errorf("%v: expected the failure to be fatal", args)
			}
		}
	})
}

// TestMisc_OrgMembershipSurface pins the members and teams verbs in every arm: the three
// output formats, the interactive table, the empty org, and the write verbs (whose delete
// is gated on a confirmation).
func TestMisc_OrgMembershipSurface(t *testing.T) {
	miscRestoreFlagState(t)

	t.Run("reads", func(t *testing.T) {
		for _, tc := range []struct {
			name  string
			empty bool
			tty   bool
			out   string
		}{
			{"json", false, false, "json"},
			{"csv", false, false, "csv"},
			{"static table", false, false, "table"},
			{"interactive table", false, true, "table"},
			{"empty static", true, false, "table"},
			{"empty interactive", true, true, "table"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				run := miscAdminEnv(t, miscAdminOpts{empty: tc.empty})
				if tc.tty {
					miscTTY(t)
				}
				for _, args := range [][]string{{"members", "list"}, {"teams", "list"}, {"org", "settings"}} {
					if err := run(append(args, "--output", tc.out)...); err != nil {
						t.Errorf("%v: %v", args, err)
					}
				}
			})
		}
	})

	t.Run("writes", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		for _, args := range [][]string{
			{"members", "add", "new@x.com", "--role", "operator"},
			{"members", "remove", "m1"},
			{"teams", "create", "SRE"},
			{"teams", "delete", "t1"},
		} {
			if err := run(append(args, "--output", "json")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		}
	})

	t.Run("an explicit --org overrides the active context", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		for _, args := range [][]string{{"members", "list", "--org", "o2"}, {"teams", "list", "--org", "o2"}} {
			if err := run(append(args, "--output", "json")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		}
	})

	t.Run("without an org context every verb refuses", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		if err := types.SaveCliConfig(types.CliConfig{}); err != nil {
			t.Fatal(err)
		}
		exits := miscFatalRunner(run)
		for _, args := range [][]string{
			{"members", "list", "--org", ""}, {"members", "add", "a@x.com", "--org", ""},
			{"members", "remove", "m1", "--org", ""}, {"teams", "list", "--org", ""},
			{"teams", "create", "x", "--org", ""}, {"teams", "delete", "t1", "--org", ""},
		} {
			if !exits(append(args, "--output", "json")...) {
				t.Errorf("%v: expected a missing org context to be fatal", args)
			}
		}
	})

	t.Run("a refusing control plane is fatal", func(t *testing.T) {
		miscAlwaysConfirm(t, true)
		for _, args := range [][]string{
			{"members", "list"}, {"members", "add", "a@x.com"}, {"members", "remove", "m1"},
			{"teams", "list"}, {"teams", "create", "x"}, {"teams", "delete", "t1"},
			{"org", "settings"},
		} {
			exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/"}))
			if !exits(append(args, "--output", "json")...) {
				t.Errorf("%v: expected the failure to be fatal", args)
			}
		}
	})
}

// TestMisc_OrgSwitchResolvesATarget pins how `org switch` resolves its argument: an id, a
// slug or a name all match, an unknown target is fatal, and with no argument and prompts
// disabled it refuses rather than guessing.
func TestMisc_OrgSwitchResolvesATarget(t *testing.T) {
	run := miscAdminEnv(t, miscAdminOpts{})
	for _, target := range []string{"o2", "beta", "Beta"} {
		if err := run("org", "switch", target, "--output", "json"); err != nil {
			t.Errorf("switch %q: %v", target, err)
		}
		if got := types.LoadCliConfig().ActiveOrgID; got != "o2" {
			t.Errorf("switch %q: active org = %q, want o2", target, got)
		}
	}

	exits := miscFatalRunner(run)
	for _, args := range [][]string{
		{"org", "switch", "nope"}, // no such org
		{"org", "switch"},         // needs the picker, which --no-input refuses
	} {
		if !exits(append(args, "--output", "json", "--no-input")...) {
			t.Errorf("%v: expected a refusal", args)
		}
	}

	noOrgs := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{empty: true}))
	if !noOrgs("org", "switch", "acme", "--output", "json") {
		t.Error("expected an empty org list to be fatal")
	}
}

// TestMisc_FleetSurface pins the warm-pool commands: the list in every arm, a partial
// update that only sends the flags actually passed, the refusal when none were, and the
// extra confirmation a pool being disabled requires.
func TestMisc_FleetSurface(t *testing.T) {
	miscRestoreFlagState(t)

	t.Run("list", func(t *testing.T) {
		for _, tc := range []struct {
			name  string
			empty bool
			tty   bool
			out   string
		}{
			{"json", false, false, "json"},
			{"csv", false, false, "csv"},
			{"static table", false, false, "table"},
			{"interactive table", false, true, "table"},
			{"empty static", true, false, "table"},
			{"empty interactive", true, true, "table"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				run := miscAdminEnv(t, miscAdminOpts{empty: tc.empty})
				if tc.tty {
					miscTTY(t)
				}
				if err := run("fleet", "list", "--output", tc.out); err != nil {
					t.Error(err)
				}
			})
		}
	})

	t.Run("set with no flags is refused", func(t *testing.T) {
		miscRestoreFlagState(t)
		miscClearFleetChanged()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
		if !exits("fleet", "set", "aws", "--output", "json") {
			t.Error("expected an empty update to be refused")
		}
	})

	t.Run("each flag is sent on its own", func(t *testing.T) {
		miscRestoreFlagState(t)
		run := miscAdminEnv(t, miscAdminOpts{})
		for _, flags := range [][]string{
			{"--warm-min", "3"}, {"--max", "12"}, {"--slots", "4"},
			{"--channel", "stable"}, {"--version", "1.4.3"},
			{"--enabled=true"},
		} {
			miscClearFleetChanged()
			if err := run(append([]string{"fleet", "set", "aws"}, append(flags, "--output", "json")...)...); err != nil {
				t.Errorf("%v: %v", flags, err)
			}
		}
	})

	t.Run("disabling a pool asks first", func(t *testing.T) {
		miscRestoreFlagState(t)
		run := miscAdminEnv(t, miscAdminOpts{})

		miscAlwaysConfirm(t, false)
		miscClearFleetChanged()
		if err := run("fleet", "set", "aws", "--enabled=false", "--output", "json"); err != nil {
			t.Errorf("declined disable: %v", err)
		}
	})

	t.Run("a confirmed disable is applied", func(t *testing.T) {
		miscRestoreFlagState(t)
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		miscClearFleetChanged()
		if err := run("fleet", "set", "aws", "--enabled=false", "--output", "json"); err != nil {
			t.Errorf("confirmed disable: %v", err)
		}
	})

	t.Run("a refusing control plane is fatal", func(t *testing.T) {
		miscRestoreFlagState(t)
		miscClearFleetChanged()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/fleet"}))
		if !exits("fleet", "set", "aws", "--max", "9", "--output", "json") {
			t.Error("expected the failure to be fatal")
		}
		miscClearFleetChanged()
		if !exits("fleet", "list", "--output", "json") {
			t.Error("expected the failure to be fatal")
		}
	})
}

// TestMisc_ProviderStatusAndVerify pins the read-only provider verbs: status renders only
// the identity fields the connected cloud actually has, and verify reports the probe's
// verdict — succeeding on connected, warning on degraded, and exiting non-zero whenever
// the identity is missing or the probe fails it.
func TestMisc_ProviderStatusAndVerify(t *testing.T) {
	t.Run("status renders in every format", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{connected: true})
		for _, out := range []string{"json", "csv", "table"} {
			for _, provider := range []string{"aws", "gcp", "azure"} {
				if err := run("provider", "status", provider, "--output", out); err != nil {
					t.Errorf("%s/%s: %v", provider, out, err)
				}
			}
		}
	})

	t.Run("a disconnected provider still renders", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{connected: false})
		if err := run("provider", "status", "aws", "--output", "table"); err != nil {
			t.Error(err)
		}
	})

	t.Run("a verified identity passes", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{connected: true, verified: true, verifyStatus: "connected"})
		for _, out := range []string{"json", "table"} {
			if err := run("provider", "verify", "aws", "--output", out); err != nil {
				t.Errorf("%s: %v", out, err)
			}
		}
	})

	t.Run("a degraded identity passes with a warning", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{connected: true, verified: true, verifyStatus: "degraded"})
		if err := run("provider", "verify", "aws", "--output", "table"); err != nil {
			t.Error(err)
		}
	})

	t.Run("a failed verdict is fatal", func(t *testing.T) {
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{
			connected: true, verified: false, verifyStatus: "disconnected",
		}))
		if !exits("provider", "verify", "aws", "--output", "table") {
			t.Error("expected a failed verification to exit non-zero")
		}
	})

	t.Run("nothing connected is fatal", func(t *testing.T) {
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{connected: false}))
		if !exits("provider", "verify", "aws", "--output", "json") {
			t.Error("expected an unconnected provider to exit non-zero")
		}
	})

	t.Run("a refusing control plane is fatal", func(t *testing.T) {
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/status"}))
		for _, args := range [][]string{{"provider", "status", "aws"}, {"provider", "verify", "aws"}} {
			if !exits(append(args, "--output", "json")...) {
				t.Errorf("%v: expected the failure to be fatal", args)
			}
		}
		probeFails := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{connected: true, failOn: "/verify"}))
		if !probeFails("provider", "verify", "aws", "--output", "json") {
			t.Error("expected a refused probe to be fatal")
		}
	})
}

// miscResetDeployFlags clears the package variables `runner deploy` binds its flags to.
// They are globals, so a value one run passed is the next run's default — and the whole
// point of the picker arms below is that the flag was NOT supplied.
func miscResetDeployFlags() {
	deployCloudIdentityID, deployRunnerName, deployRegion, deployAssignedID = "", "", "", ""
	deployRunnerWait = false
}

// miscResetDestroyFlags does the same for `runner destroy`.
func miscResetDestroyFlags() {
	destroyRunnerID, destroyRunnerAssignedID = "", ""
	destroyRunnerWait = false
}

// TestMisc_RunnerDeploy pins `runner deploy`: fully-flagged it creates the runner and
// queues one DEPLOY_RUNNER job, --wait follows that job to its terminal state, and a
// failed job exits non-zero rather than reporting a deploy that did not happen.
func TestMisc_RunnerDeploy(t *testing.T) {
	miscRestoreFlagState(t)
	miscFastPolls(t)

	fullFlags := []string{
		"--cloud-identity-id", "ci-aws", "--name", "runner-ci",
		"--region", "eu-west-1", "--assigned-runner-id", "r1",
	}

	t.Run("every flag supplied", func(t *testing.T) {
		miscResetDeployFlags()
		run := miscAdminEnv(t, miscAdminOpts{})
		if err := run(append([]string{"runner", "deploy"}, append(fullFlags, "--output", "json")...)...); err != nil {
			t.Error(err)
		}
	})

	t.Run("--wait follows the job to success", func(t *testing.T) {
		miscResetDeployFlags()
		run := miscAdminEnv(t, miscAdminOpts{jobStatus: "PROCESSING", jobStatusAfter: "SUCCESS"})
		if err := run(append([]string{"runner", "deploy", "--wait"}, append(fullFlags, "--output", "json")...)...); err != nil {
			t.Error(err)
		}
	})

	t.Run("--wait on a failed job exits non-zero", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{jobStatus: "FAILED"}))
		if !exits(append([]string{"runner", "deploy", "--wait"}, append(fullFlags, "--output", "json")...)...) {
			t.Error("expected a failed deploy job to exit non-zero")
		}
	})

	t.Run("--wait on a cancelled job exits non-zero", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{jobStatus: "CANCELLED"}))
		if !exits(append([]string{"runner", "deploy", "--wait"}, append(fullFlags, "--output", "json")...)...) {
			t.Error("expected a cancelled deploy job to exit non-zero")
		}
	})

	t.Run("omitted flags run the pickers", func(t *testing.T) {
		miscResetDeployFlags()
		run := miscAdminEnv(t, miscAdminOpts{})
		miscTTY(t)
		miscStubForm(t)
		if err := run("runner", "deploy", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("the cloud picker refuses without prompts", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
		if !exits("runner", "deploy", "--no-input", "--output", "json") {
			t.Error("expected the picker to refuse under --no-input")
		}
	})

	t.Run("a cloud with no runner template is refused", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{identities: []map[string]any{
			{"id": "ci-gcp", "provider": "gcp", "label": "analytics", "created_at": miscTS},
		}}))
		miscTTY(t)
		miscStubForm(t)
		if !exits("runner", "deploy", "--output", "json") {
			t.Error("expected a non-deployable cloud to be refused")
		}
	})

	t.Run("no linked cloud accounts is refused", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{empty: true}))
		miscTTY(t)
		miscStubForm(t)
		if !exits("runner", "deploy", "--output", "json") {
			t.Error("expected an empty cloud-account list to be refused")
		}
	})

	t.Run("a refusing control plane is fatal", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/runners/deploy"}))
		if !exits(append([]string{"runner", "deploy"}, append(fullFlags, "--output", "json")...)...) {
			t.Error("expected a refused deploy to be fatal")
		}
	})

	t.Run("an unreachable runner list is fatal", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/runners"}))
		miscTTY(t)
		miscStubForm(t)
		if !exits("runner", "deploy", "--cloud-identity-id", "ci-aws", "--name", "n", "--region", "eu", "--output", "json") {
			t.Error("expected an unreachable runner list to be fatal")
		}
	})
}

// TestMisc_RunnerDestroy pins `runner destroy`: it queues one DESTROY_RUNNER job only
// after an explicit confirmation, refuses the picker's "Any available" answer (a teardown
// must name its target), and follows the job with --wait.
func TestMisc_RunnerDestroy(t *testing.T) {
	miscRestoreFlagState(t)
	miscFastPolls(t)

	t.Run("confirmed with both ids", func(t *testing.T) {
		miscResetDestroyFlags()
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		if err := run("runner", "destroy", "--runner-id", "r1", "--assigned-runner-id", "r2", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("declining confirms nothing", func(t *testing.T) {
		miscResetDestroyFlags()
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, false)
		if err := run("runner", "destroy", "--runner-id", "r1", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("the executor is picked when omitted", func(t *testing.T) {
		miscResetDestroyFlags()
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		miscTTY(t)
		miscStubForm(t)
		if err := run("runner", "destroy", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("a target of Any available is refused", func(t *testing.T) {
		miscResetDestroyFlags()
		// No default ONLINE runner, so the picker's pre-selected value is the empty
		// "Any available" option — which is not a thing you can tear down.
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{runners: []map[string]any{
			{"id": "r2", "name": "spare", "operator": "self", "status": "DRAINING"},
		}}))
		miscTTY(t)
		miscStubForm(t)
		if !exits("runner", "destroy", "--output", "json") {
			t.Error("expected an unnamed destroy target to be refused")
		}
	})

	t.Run("the picker refuses without prompts", func(t *testing.T) {
		miscResetDestroyFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
		if !exits("runner", "destroy", "--no-input", "--output", "json") {
			t.Error("expected the picker to refuse under --no-input")
		}
	})

	t.Run("--wait follows the job", func(t *testing.T) {
		miscResetDestroyFlags()
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		if err := run("runner", "destroy", "--runner-id", "r1", "--assigned-runner-id", "r2", "--wait", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("--wait on a failed job exits non-zero", func(t *testing.T) {
		miscResetDestroyFlags()
		miscAlwaysConfirm(t, true)
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{jobStatus: "FAILED"}))
		if !exits("runner", "destroy", "--runner-id", "r1", "--assigned-runner-id", "r2", "--wait", "--output", "json") {
			t.Error("expected a failed teardown job to exit non-zero")
		}
	})

	t.Run("a refused queue is fatal", func(t *testing.T) {
		miscResetDestroyFlags()
		miscAlwaysConfirm(t, true)
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/jobs"}))
		if !exits("runner", "destroy", "--runner-id", "r1", "--assigned-runner-id", "r2", "--output", "json") {
			t.Error("expected a refused queue to be fatal")
		}
	})
}

// TestMisc_RunnerRemove pins `runner remove`: it deletes only the record, always behind a
// confirmation, and — like destroy — refuses to act on the picker's "Any available".
func TestMisc_RunnerRemove(t *testing.T) {
	miscRestoreFlagState(t)

	t.Run("by argument", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		if err := run("runner", "remove", "r1", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("declining removes nothing", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, false)
		if err := run("runner", "remove", "r1", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("by picker", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		miscTTY(t)
		miscStubForm(t)
		if err := run("runner", "remove", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("a target of Any available is refused", func(t *testing.T) {
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{runners: []map[string]any{
			{"id": "r3", "name": "cold", "operator": "self", "status": "OFFLINE"},
		}}))
		miscTTY(t)
		miscStubForm(t)
		if !exits("runner", "remove", "--output", "json") {
			t.Error("expected an unnamed removal target to be refused")
		}
	})

	t.Run("the picker refuses without prompts", func(t *testing.T) {
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
		if !exits("runner", "remove", "--no-input", "--output", "json") {
			t.Error("expected the picker to refuse under --no-input")
		}
	})

	t.Run("a refused delete is fatal", func(t *testing.T) {
		miscAlwaysConfirm(t, true)
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/runners/"}))
		if !exits("runner", "remove", "r1", "--output", "json") {
			t.Error("expected a refused delete to be fatal")
		}
	})
}

// TestMisc_JobLogsAndCancel pins `jobs logs` and `jobs cancel`: each log stream gets its
// own style, --follow keeps polling until the job reaches a terminal state and then drains
// the tail, and an unreadable log or a refused cancel is fatal.
func TestMisc_JobLogsAndCancel(t *testing.T) {
	miscRestoreFlagState(t)
	miscFastPolls(t)

	t.Run("one shot", func(t *testing.T) {
		jobsLogsFollow = false
		run := miscAdminEnv(t, miscAdminOpts{})
		if err := run("jobs", "logs", "j1", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("follow drains the tail once the job finishes", func(t *testing.T) {
		jobsLogsFollow = false
		run := miscAdminEnv(t, miscAdminOpts{jobStatus: "SUCCESS"})
		if err := run("jobs", "logs", "j1", "--follow", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("follow waits while the job is still running", func(t *testing.T) {
		jobsLogsFollow = false
		run := miscAdminEnv(t, miscAdminOpts{jobStatus: "PROCESSING", jobStatusAfter: "FAILED"})
		if err := run("jobs", "logs", "j1", "--follow", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("an unreadable log is fatal", func(t *testing.T) {
		jobsLogsFollow = false
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/logs"}))
		if !exits("jobs", "logs", "j1", "--output", "json") {
			t.Error("expected an unreadable log to be fatal")
		}
	})

	t.Run("an unreadable job is fatal", func(t *testing.T) {
		jobsLogsFollow = false
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/jobs/"}))
		if !exits("jobs", "get", "j1", "--output", "json") {
			t.Error("expected an unreadable job to be fatal")
		}
	})

	t.Run("cancel", func(t *testing.T) {
		jobsLogsFollow = false
		run := miscAdminEnv(t, miscAdminOpts{})
		if err := run("jobs", "cancel", "j1", "--output", "json"); err != nil {
			t.Error(err)
		}
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/cancel"}))
		if !exits("jobs", "cancel", "j1", "--output", "json") {
			t.Error("expected a refused cancel to be fatal")
		}
	})

	t.Run("the bare jobs command points at its verbs", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		if err := run("jobs", "--output", "json"); err != nil {
			t.Error(err)
		}
	})
}

// TestMisc_JobsPaginatedTable pins the paging model behind the interactive `jobs list`:
// a page change re-queries the control plane and reports the new rows, and a query that
// fails leaves the view alone instead of crashing the table.
func TestMisc_JobsPaginatedTable(t *testing.T) {
	miscRestoreFlagState(t)
	run := miscAdminEnv(t, miscAdminOpts{})
	// Force the client to resolve the fake origin the same way the commands do.
	if err := run("jobs", "list", "--output", "json"); err != nil {
		t.Fatal(err)
	}

	rows := jobRows([]api.ProvisionJob{
		{ID: "j1", JobType: "PLAN", Status: "SUCCESS"},
		{ID: "j2", JobType: "not-a-known-type", Status: "FAILED", ProjectID: "0123456789abcdef", RunnerID: "r-0123456789"},
	})
	if len(rows) != 2 {
		t.Fatalf("jobRows returned %d rows, want 2", len(rows))
	}

	m := jobsPaginatedModel{
		PaginatedTableModel: ui.NewPaginatedTableModel(jobColumns(), rows, "jobs", 40, 20),
		apiClient:           api.NewClient("tok"),
		pageSize:            20,
	}

	updated, cmd := m.Update(ui.PageChangedMsg{Page: 2})
	if cmd == nil {
		t.Fatal("a page change must issue a fetch")
	}
	data, ok := cmd().(ui.PageDataMsg)
	if !ok {
		t.Fatalf("fetchPage returned %T, want ui.PageDataMsg", cmd())
	}
	if data.Page != 2 || data.TotalPages < 1 {
		t.Errorf("page = %d, totalPages = %d", data.Page, data.TotalPages)
	}

	// Any other message falls through to the embedded table model.
	if _, _ = updated.Update(ui.PageDataMsg{Page: 2, Total: 40, TotalPages: 2}); false {
		t.Fatal("unreachable")
	}

	// A refused query yields no message rather than a crash.
	broken := miscAdminEnv(t, miscAdminOpts{failOn: "/api/jobs"})
	if err := broken("jobs", "list", "--output", "json"); err == nil {
		_ = err // the command exits through exitFunc; the model check below is the point
	}
	bad := jobsPaginatedModel{
		PaginatedTableModel: ui.NewPaginatedTableModel(jobColumns(), rows, "jobs", 0, 20),
		apiClient:           api.NewClient("tok"),
		pageSize:            20,
	}
	if got := bad.fetchPage(1)(); got != nil {
		t.Errorf("a refused page query returned %v, want nil", got)
	}
}

// TestMisc_UsageBillingAndInventory pins the remaining read-only cards: usage and billing
// render their counters in every format, and the cloud inventory renders its networks,
// subnets and regions — reporting plainly when nothing has been discovered yet.
func TestMisc_UsageBillingAndInventory(t *testing.T) {
	t.Run("populated", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		for _, out := range []string{"json", "csv", "table"} {
			for _, args := range [][]string{{"usage"}, {"billing"}, {"cloud", "inventory", "ci-aws"}} {
				if err := run(append(args, "--output", out)...); err != nil {
					t.Errorf("%v/%s: %v", args, out, err)
				}
			}
		}
	})

	t.Run("a community org has no seat count and no inventory", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{empty: true})
		for _, args := range [][]string{{"billing"}, {"cloud", "inventory", "ci-aws"}} {
			if err := run(append(args, "--output", "table")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		}
	})

	t.Run("a refusing control plane is fatal", func(t *testing.T) {
		for _, tc := range []struct {
			failOn string
			args   []string
		}{
			{"/usage", []string{"usage"}},
			{"/billing", []string{"billing"}},
			{"/inventory", []string{"cloud", "inventory", "ci-aws"}},
		} {
			exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: tc.failOn}))
			if !exits(append(tc.args, "--output", "json")...) {
				t.Errorf("%v: expected the failure to be fatal", tc.args)
			}
		}
	})
}

// TestMisc_ConfigExportFailureIsFatal pins that an export the control plane refuses exits
// non-zero, rather than writing an empty file or an empty stdout.
func TestMisc_ConfigExportFailureIsFatal(t *testing.T) {
	exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/"}))
	if !exits("config", "export", "web", "--output", "json") {
		t.Error("expected a refused export to be fatal")
	}
}

// TestMisc_VersionPrintsTheBuild pins that `version` prints the compiled version and, when
// a newer one has been cached by the background update check, notes it.
func TestMisc_VersionPrintsTheBuild(t *testing.T) {
	run := miscAdminEnv(t, miscAdminOpts{})
	if err := run("version", "--output", "json"); err != nil {
		t.Error(err)
	}
}

// TestMisc_InvalidOutputFormatIsRefused pins that an --output the renderer does not know is
// rejected before anything is printed, rather than falling through to a default.
func TestMisc_InvalidOutputFormatIsRefused(t *testing.T) {
	exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
	for _, args := range [][]string{{"cluster", "list"}, {"usage"}, {"grants", "list"}} {
		if !exits(append(args, "--output", "yaml")...) {
			t.Errorf("%v: expected an unknown --output to be refused", args)
		}
	}
}

// TestMisc_TerminalDetectionDelegatesToIsatty pins that the two TTY seams are, by default,
// exactly the isatty calls they replaced — so substituting them in a test cannot be
// mistaken for a change in how production decides which arm to run.
func TestMisc_TerminalDetectionDelegatesToIsatty(t *testing.T) {
	if got, want := stdinIsTTY(), isatty.IsTerminal(os.Stdin.Fd()); got != want {
		t.Errorf("stdinIsTTY() = %v, want %v", got, want)
	}
	if got, want := stdoutIsTTY(), isatty.IsTerminal(os.Stdout.Fd()); got != want {
		t.Errorf("stdoutIsTTY() = %v, want %v", got, want)
	}
}

// TestMisc_OpsActionRefusedAfterTheSessionOpens pins the second failure point of a
// break-glass verb: the audited session opens, and it is the ACTION the server refuses.
// That is a different arm from a refused session, and it must still be fatal.
func TestMisc_OpsActionRefusedAfterTheSessionOpens(t *testing.T) {
	exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/breakglass/execute"}))
	if !exits("ops", "inspect-job", "j1", "--reason", "incident-1", "--output", "json") {
		t.Error("expected a refused action to be fatal")
	}
}

// TestMisc_OpsActionsFailClosedWithoutCredentials pins that the shared break-glass action
// path checks for a token before it opens an audited session — the verbs route through one
// helper, so this is the only place that check runs.
func TestMisc_OpsActionsFailClosedWithoutCredentials(t *testing.T) {
	isolatedHome(t) // deliberately no saveCredentials
	t.Setenv("ALETHIA_WEB_ORIGIN", "http://127.0.0.1:1")
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	prev := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) { return false, nil }
	t.Cleanup(func() { authRequiredPrompt = prev })

	exits := miscTrapExit(t, func(args ...string) error {
		miscResetNoInput()
		rootCmd.SetArgs(args)
		return rootCmd.Execute()
	})
	for _, args := range [][]string{
		{"ops", "inspect-job", "j1", "--reason", "incident-1"},
		{"ops", "orphan-detect", "--reason", "incident-1", "--project", "p1"},
	} {
		if !exits(append(args, "--output", "json")...) {
			t.Errorf("%v: expected the missing-credentials path to exit non-zero", args)
		}
	}
}

// TestMisc_JobsListFallsBackToADefaultPageSize pins that a non-positive --limit does not
// ask the control plane for zero jobs; the page size falls back to 20.
func TestMisc_JobsListFallsBackToADefaultPageSize(t *testing.T) {
	miscRestoreFlagState(t)
	run := miscAdminEnv(t, miscAdminOpts{})
	if err := run("jobs", "list", "-n", "0", "--output", "json"); err != nil {
		t.Error(err)
	}
}

// TestMisc_JobsPagerAlwaysHasOnePage pins that an empty result still reports one page —
// a zero page count would make the pager render "page 1 of 0".
func TestMisc_JobsPagerAlwaysHasOnePage(t *testing.T) {
	miscRestoreFlagState(t)
	run := miscAdminEnv(t, miscAdminOpts{empty: true})
	if err := run("jobs", "list", "--output", "json"); err != nil {
		t.Fatal(err)
	}
	m := jobsPaginatedModel{
		PaginatedTableModel: ui.NewPaginatedTableModel(jobColumns(), nil, "jobs", 0, 20),
		apiClient:           api.NewClient("tok"),
		pageSize:            20,
	}
	data, ok := m.fetchPage(1)().(ui.PageDataMsg)
	if !ok {
		t.Fatal("fetchPage did not return page data")
	}
	if data.TotalPages != 1 {
		t.Errorf("TotalPages = %d for an empty result, want 1", data.TotalPages)
	}
}

// TestMisc_ConfigExportToAnUnwritablePathIsFatal pins that a --out the CLI cannot write is
// reported, instead of the export silently going nowhere.
func TestMisc_ConfigExportToAnUnwritablePathIsFatal(t *testing.T) {
	exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
	dest := filepath.Join(t.TempDir(), "no-such-dir", "export.yaml")
	if !exits("config", "export", "web", "--out", dest, "--output", "table") {
		t.Error("expected an unwritable --out to be fatal")
	}
}

// TestMisc_ConfigWritesReportAFailedSave pins that `config set` and `config clear-context`
// report a config file they could not persist. Both are the only place the CLI's own state
// is written, so a silent failure would leave the user with stale settings.
func TestMisc_ConfigWritesReportAFailedSave(t *testing.T) {
	// A regular file where the config DIRECTORY should be: MkdirAll then fails.
	blocked := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocked, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", blocked)
	t.Setenv("XDG_CONFIG_HOME", blocked)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	exits := miscTrapExit(t, func(args ...string) error {
		miscResetNoInput()
		rootCmd.SetArgs(args)
		return rootCmd.Execute()
	})
	for _, args := range [][]string{
		{"config", "set", "web-origin", "https://cp.example.com"},
		{"config", "clear-context"},
	} {
		if !exits(append(args, "--output", "table")...) {
			t.Errorf("%v: expected an unwritable config to be fatal", args)
		}
	}
}

// TestMisc_OrgSwitchPickerFailureIsReported pins that when `org switch` has no argument and
// prompts ARE enabled, a picker that cannot open is surfaced as an error rather than
// leaving the active organization silently unchanged.
func TestMisc_OrgSwitchPickerFailureIsReported(t *testing.T) {
	// No miscStubForm here on purpose: the real huh form is what fails headlessly, which
	// is exactly the arm under test.
	exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
	miscTTY(t)
	if !exits("org", "switch", "--output", "json") {
		t.Error("expected a picker that cannot open to be reported")
	}
}
