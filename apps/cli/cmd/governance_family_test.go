// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/iotest"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The contract every command of the governance family holds, driven through the real cobra tree
// against a fake control plane:
//
//   - a result is ONE document on stdout, and under `-o json` it parses;
//   - a command that changes something returns the mutation result, and with --dry-run sends
//     nothing;
//   - a refusal exits with the code its class owns, writes nothing on stdout, and says what to
//     do next on stderr;
//   - a destructive command needs --yes when nobody can be asked;
//   - a secret is written once, on stdout, and nowhere else.
//
// Every identifier here carries the govFam prefix.

// govFamTokenValue is the service token the fake control plane mints. It is distinctive so a
// search for it in a stream cannot match anything else.
const govFamTokenValue = "alethia_sat_govfam0123456789"

// govFamSecret is the channel secret the tests send. It must never come back on any stream.
const govFamSecret = "whsec-govfam-55aa77"

// govFamRequest is one request the fake control plane received.
type govFamRequest struct {
	Method string
	Path   string
	Body   string
}

// govFamServer is the fake control plane: it holds one of everything the family lists, records
// every request, and can refuse one route with a chosen status and sentence.
type govFamServer struct {
	mu       sync.Mutex
	requests []govFamRequest
	// refuse maps "METHOD path-suffix" to the answer for it.
	refuse map[string]govFamRefusal
	// empty makes every list come back with nothing in it.
	empty bool
}

// govFamRefusal is one answer the fake gives in place of a success.
type govFamRefusal struct {
	Status int
	Error  string
}

// mutations returns the requests that were not reads.
func (s *govFamServer) mutations() []govFamRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []govFamRequest
	for _, r := range s.requests {
		if r.Method != http.MethodGet {
			out = append(out, r)
		}
	}
	return out
}

// govFamLists is what each list route answers with.
func govFamLists() map[string]map[string]any {
	return map[string]map[string]any{
		"/api/cli/orgs": {"orgs": []map[string]any{
			{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner", "plan": "pro", "is_active": true},
			{"id": "o2", "name": "Beta", "slug": "beta", "role": "member", "plan": "community", "is_active": false},
		}},
		"/api/cli/orgs/o1/members": {"members": []map[string]any{
			{"id": "m1", "user_id": "u1", "email": "ada@example.com", "name": "Ada", "role": "owner", "status": "active"},
		}},
		"/api/cli/orgs/o1/teams": {"teams": []map[string]any{
			{"id": "t1", "name": "platform", "member_count": 2},
		}},
		"/api/cli/roles": {"roles": []map[string]any{
			{"id": "ro1", "name": "owner", "is_builtin": true, "permission_keys": []string{"project:deploy", "project:read"}},
			{"id": "ro2", "name": "deployers", "is_builtin": false, "permission_keys": []string{"project:deploy"}},
		}},
		"/api/cli/grants": {"grants": []map[string]any{
			{"id": "g1", "principal_type": "user", "principal_id": "u1", "effect": "allow", "role": "viewer", "resource_type": "org"},
		}},
		"/api/cli/sso": {"sso_providers": []map[string]any{
			{"id": "s1", "provider_type": "oidc", "domain": "example.com", "issuer": "https://idp.example.com", "enabled": true},
		}},
		"/api/cli/alerts": {"alert_rules": []map[string]any{
			{"id": "ar1", "name": "Job failures", "severity": "critical", "enabled": true,
				"event_patterns": []string{"system.job.failed"}, "channel_ids": []string{"ch1"}},
		}},
		"/api/cli/channels": {"channels": []map[string]any{
			{"id": "ch1", "name": "Ops Slack", "type": "slack", "is_verified": true, "enabled": true},
		}},
		"/api/cli/classification/dimensions": {"dimensions": []map[string]any{
			{"id": "d1", "key": "tier", "label": "Tier", "applies_to": []string{"project_environment"},
				"values": []map[string]any{{"id": "v1", "value": "gold", "label": "Gold"}}},
		}},
		"/api/cli/classification/assignments": {"assignments": []map[string]any{
			{"dimension_key": "tier", "dimension_label": "Tier", "value": "gold", "value_label": "Gold"},
		}},
		"/api/cli/tokens": {"tokens": []map[string]any{
			{"id": "tok1", "name": "ci", "token_prefix": "alethia_sat_abc", "created_at": "2026-01-01T00:00:00Z"},
		}},
	}
}

// govFamCreated is what each create route answers with.
func govFamCreated() map[string]map[string]any {
	return map[string]map[string]any{
		"/api/cli/orgs/o1/members": {"invitation": map[string]any{"id": "inv1", "email": "grace@example.com", "role": "admin", "status": "pending"}},
		"/api/cli/orgs/o1/teams":   {"team": map[string]any{"id": "t2", "name": "sre", "member_count": 0}},
		"/api/cli/roles":           {"role": map[string]any{"id": "ro3", "name": "auditors", "is_builtin": false, "permission_keys": []string{"project:read"}}},
		"/api/cli/grants": {"grant": map[string]any{"id": "g2", "principal_type": "user", "principal_id": "u1",
			"effect": "allow", "role": "viewer", "resource_type": "org"}},
		"/api/cli/alerts":   {"alert_rule": map[string]any{"id": "ar2", "name": "Denials", "severity": "warning", "enabled": true}},
		"/api/cli/channels": {"channel": map[string]any{"id": "ch2", "name": "Pager", "type": "pagerduty", "has_secret": true, "enabled": true}},
		"/api/cli/channels/ch1/verify": {"channel": map[string]any{"id": "ch1", "name": "Ops Slack", "type": "slack",
			"is_verified": true, "enabled": true}},
		"/api/cli/classification/assignments": {"assignments": []map[string]any{}},
		"/api/cli/tokens": {"id": "tok2", "name": "ci", "token_prefix": "alethia_sat_gov", "token": govFamTokenValue,
			"warning": "Store this token now. It is shown once."},
	}
}

// ServeHTTP answers one request.
func (s *govFamServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	s.requests = append(s.requests, govFamRequest{Method: r.Method, Path: r.URL.Path, Body: string(body)})
	refusals := s.refuse
	empty := s.empty
	s.mu.Unlock()

	enc := json.NewEncoder(w)
	for key, refusal := range refusals {
		method, suffix, _ := strings.Cut(key, " ")
		if r.Method == method && strings.HasSuffix(r.URL.Path, suffix) {
			w.WriteHeader(refusal.Status)
			_ = enc.Encode(map[string]string{"error": refusal.Error})
			return
		}
	}
	switch r.Method {
	case http.MethodGet:
		if r.URL.Path == "/api/cli/sso/s1" {
			_ = enc.Encode(map[string]any{"sso_provider": map[string]any{
				"id": "s1", "provider_type": "oidc", "domain": "example.com", "issuer": "https://idp.example.com", "enabled": true,
			}})
			return
		}
		if r.URL.Path == "/api/cli/org-settings" {
			_ = enc.Encode(map[string]any{"settings": map[string]any{"name": "Acme", "slug": "acme", "region": "eu-west-1"}})
			return
		}
		if answer, ok := govFamLists()[r.URL.Path]; ok && !empty {
			_ = enc.Encode(answer)
			return
		}
		_ = enc.Encode(map[string]any{})
	case http.MethodPost:
		if answer, ok := govFamCreated()[r.URL.Path]; ok {
			_ = enc.Encode(answer)
			return
		}
		_ = enc.Encode(map[string]any{"ok": true})
	default:
		_ = enc.Encode(map[string]any{"ok": true})
	}
}

// govFamResetFlags returns every flag variable of the family to its default. cobra keeps a parsed
// value across Execute calls, and a repeatable flag appends to what the last run left.
func govFamResetFlags() {
	membersAddRole, membersRemoveEmail = "member", ""
	teamsDeleteName, rolesDeleteName, rolePermissions = "", "", nil
	grantPrincipalType, grantPrincipalID, grantEffect = "user", "", "allow"
	grantRoleID, grantPermission, grantResourceType, grantResourceID = "", "", "org", ""
	ssoGetDomain = ""
	alertEventPatterns, alertChannelRefs, alertSeverity = nil, nil, "warning"
	channelType, channelRecipients, channelURL = "", nil, ""
	channelSigningSecret, channelSigningSecretStdin = "", false
	channelRoutingKey, channelRoutingKeyStdin = "", false
	tokenCreateName, tokenCreateExpires = "", 0
	hygCliConfirmResetFlags()
}

// govFamEnv stands up an isolated home, a credential, the active organization o1 and the fake
// control plane, and returns a runner over the real command tree that reports the exit code.
func govFamEnv(t *testing.T, s *govFamServer) func(args ...string) int {
	t.Helper()
	// --dry-run is registered from the registry, as main does before it executes.
	applyCommandMeta()
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

	prevExit := exitFunc
	exitFunc = func(code int) { panic(hygCliConfirmExit{code: code}) }
	t.Cleanup(func() { exitFunc = prevExit; govFamResetFlags() })

	return func(args ...string) (code int) {
		defer func() {
			govFamResetFlags()
			if r := recover(); r != nil {
				e, ok := r.(hygCliConfirmExit)
				if !ok {
					panic(r)
				}
				code = e.code
			}
		}()
		govFamResetFlags()
		execRootArgs(args)
		if err := rootCmd.Execute(); err != nil {
			// What cobra itself refuses leaves the way Execute sends it: through the fatal path.
			errorFormat = refusalFormat(args)
			fail(usageError(err))
		}
		return 0
	}
}

// govFamRun runs one invocation and returns its exit code with what it wrote on each stream.
func govFamRun(t *testing.T, run func(args ...string) int, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	stdout, stderr = captureStreams(t, func() { code = run(args...) })
	return code, stdout, stderr
}

// govFamStdin makes content the process's stdin for the rest of the test.
func govFamStdin(t *testing.T, content string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "stdin")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write stdin file: %v", err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open stdin file: %v", err)
	}
	prev := os.Stdin
	os.Stdin = f
	t.Cleanup(func() { os.Stdin = prev; _ = f.Close() })
}

// govFamMutation is one mutating command, said entirely in flags.
type govFamMutation struct {
	name, kind, action, id string
	args                   []string
	// method and path are the request the command sends.
	method, path string
}

// govFamMutations is every mutating command of the family that reaches the control plane.
func govFamMutations() []govFamMutation {
	return []govFamMutation{
		{"members add", govKindInvitation, "created", "inv1",
			[]string{"members", "add", "grace@example.com", "--role", "admin"}, http.MethodPost, "/api/cli/orgs/o1/members"},
		{"members remove", govKindMember, "deleted", "m1",
			[]string{"members", "remove", "--email", "ada@example.com", "--yes"}, http.MethodDelete, "/api/cli/orgs/o1/members/m1"},
		{"teams create", govKindTeam, "created", "t2",
			[]string{"teams", "create", "sre"}, http.MethodPost, "/api/cli/orgs/o1/teams"},
		{"teams delete", govKindTeam, "deleted", "t1",
			[]string{"teams", "delete", "--name", "platform", "--yes"}, http.MethodDelete, "/api/cli/orgs/o1/teams/t1"},
		{"roles create", govKindRole, "created", "ro3",
			[]string{"roles", "create", "auditors", "--permission", "project:read"}, http.MethodPost, "/api/cli/roles"},
		{"roles delete", govKindRole, "deleted", "ro2",
			[]string{"roles", "delete", "--name", "deployers", "--yes"}, http.MethodDelete, "/api/cli/roles/ro2"},
		{"grants add", govKindGrant, "created", "g2",
			[]string{"grants", "add", "--principal", "ada@example.com", "--role", "owner"}, http.MethodPost, "/api/cli/grants"},
		{"grants remove", govKindGrant, "deleted", "g1",
			[]string{"grants", "remove", "g1", "--yes"}, http.MethodDelete, "/api/cli/grants/g1"},
		{"alerts create", govKindAlertRule, "created", "ar2",
			[]string{"alerts", "create", "Denials", "--event", "authz.*.denied", "--channel", "Ops Slack"}, http.MethodPost, "/api/cli/alerts"},
		{"alerts delete", govKindAlertRule, "deleted", "ar1",
			[]string{"alerts", "delete", "Job failures", "--yes"}, http.MethodDelete, "/api/cli/alerts/ar1"},
		{"channels create", govKindChannel, "created", "ch2",
			[]string{"channels", "create", "Pager", "--type", "pagerduty", "--routing-key", govFamSecret}, http.MethodPost, "/api/cli/channels"},
		{"channels verify", govKindChannel, "updated", "ch1",
			[]string{"channels", "verify", "Ops Slack"}, http.MethodPost, "/api/cli/channels/ch1/verify"},
		{"channels delete", govKindChannel, "deleted", "ch1",
			[]string{"channels", "delete", "Ops Slack", "--yes"}, http.MethodDelete, "/api/cli/channels/ch1"},
		{"classification assign", govKindClassification, "updated", "e1",
			[]string{"classification", "assign", "project_environment", "e1", "tier", "gold"}, http.MethodPost, "/api/cli/classification/assignments"},
		{"classification unassign", govKindClassification, "deleted", "e1",
			[]string{"classification", "unassign", "project_environment", "e1", "gold", "--yes"}, http.MethodDelete, "/api/cli/classification/assignments"},
		{"token revoke", govKindServiceToken, "deleted", "tok1",
			[]string{"token", "revoke", "tok1"}, http.MethodDelete, "/api/cli/tokens/tok1"},
	}
}

// govFamDecode decodes stdout as exactly one mutation result.
func govFamDecode(t *testing.T, stdout string) famResult {
	t.Helper()
	var r famResult
	dec := json.NewDecoder(strings.NewReader(stdout))
	if err := dec.Decode(&r); err != nil {
		t.Fatalf("stdout is not one json document: %v\n%s", err, stdout)
	}
	if dec.More() {
		t.Fatalf("stdout carries more than the result:\n%s", stdout)
	}
	return r
}

// TestGovFamily_EveryMutationReturnsOneResult is the JSON shape of each mutating command: one
// result on stdout naming its subject and what happened to it, and the request it stands for
// sent exactly once.
func TestGovFamily_EveryMutationReturnsOneResult(t *testing.T) {
	for _, tc := range govFamMutations() {
		t.Run(tc.name, func(t *testing.T) {
			s := &govFamServer{}
			run := govFamEnv(t, s)
			code, stdout, stderr := govFamRun(t, run, append(tc.args, "--output", "json", "--no-input")...)
			if code != 0 {
				t.Fatalf("exit %d:\n%s", code, stderr)
			}
			r := govFamDecode(t, stdout)
			if r.Kind != tc.kind || r.Action != tc.action || r.ID != tc.id || r.DryRun || r.Job != nil {
				t.Errorf("result = %+v, want kind %s action %s id %s", r, tc.kind, tc.action, tc.id)
			}
			sent := 0
			for _, m := range s.mutations() {
				if m.Method == tc.method && m.Path == tc.path {
					sent++
				}
			}
			if sent != 1 || len(s.mutations()) != 1 {
				t.Errorf("want exactly one %s %s, got %v", tc.method, tc.path, s.mutations())
			}
			if strings.Contains(stdout+stderr, govFamSecret) {
				t.Errorf("a channel secret was printed:\nstdout: %s\nstderr: %s", stdout, stderr)
			}
		})
	}
}

// TestGovFamily_DryRunSendsNothing drives every mutation with --dry-run: the result says so, and
// no request that changes anything leaves the CLI.
func TestGovFamily_DryRunSendsNothing(t *testing.T) {
	cases := govFamMutations()
	cases = append(cases, govFamMutation{name: "token create", kind: govKindServiceToken, action: "created",
		args: []string{"token", "create", "--name", "ci"}})
	for _, tc := range cases {
		for _, format := range []string{ui.FormatJSON, ui.FormatTable} {
			t.Run(tc.name+"/"+format, func(t *testing.T) {
				s := &govFamServer{}
				run := govFamEnv(t, s)
				code, stdout, stderr := govFamRun(t, run, append(tc.args, "--dry-run", "--output", format, "--no-input")...)
				if code != 0 {
					t.Fatalf("exit %d:\n%s", code, stderr)
				}
				if muts := s.mutations(); len(muts) != 0 {
					t.Errorf("a dry run sent %v", muts)
				}
				if strings.Contains(stdout+stderr, govFamSecret) || strings.Contains(stdout+stderr, govFamTokenValue) {
					t.Errorf("a dry run printed a secret:\nstdout: %s\nstderr: %s", stdout, stderr)
				}
				if format == ui.FormatTable {
					if !strings.Contains(stdout, "Nothing was sent.") {
						t.Errorf("the dry run does not say nothing was sent:\n%s", stdout)
					}
					return
				}
				r := govFamDecode(t, stdout)
				if !r.DryRun || r.Kind != tc.kind || r.Action != tc.action {
					t.Errorf("result = %+v", r)
				}
			})
		}
	}
}

// TestGovFamily_ReadsEmitOneDocument is the JSON shape of each read: one document on stdout, and
// for a list an array — an empty one when there is nothing, never null and never prose.
func TestGovFamily_ReadsEmitOneDocument(t *testing.T) {
	lists := [][]string{
		{"org", "list"}, {"members", "list"}, {"teams", "list"}, {"roles", "list"}, {"grants", "list"},
		{"sso", "list"}, {"alerts", "list"}, {"channels", "list"}, {"classification", "dimensions"},
		{"classification", "show", "project_environment", "e1"}, {"token", "list"},
	}
	for _, args := range lists {
		for _, empty := range []bool{false, true} {
			name := strings.Join(args, " ")
			if empty {
				name += " (empty)"
			}
			t.Run(name, func(t *testing.T) {
				run := govFamEnv(t, &govFamServer{empty: empty})
				code, stdout, stderr := govFamRun(t, run, append(append([]string{}, args...), "--output", "json", "--no-input")...)
				if code != 0 {
					t.Fatalf("exit %d:\n%s", code, stderr)
				}
				var rows []map[string]any
				if err := json.Unmarshal([]byte(stdout), &rows); err != nil {
					t.Fatalf("stdout is not one json array: %v\n%s", err, stdout)
				}
				if empty && (len(rows) != 0 || strings.TrimSpace(stdout) != "[]") {
					t.Errorf("an empty list must be [], got %q", stdout)
				}
				if !empty && len(rows) == 0 {
					t.Errorf("the list came back empty:\n%s", stdout)
				}
			})
		}
	}

	t.Run("an empty list says so on stderr and leaves stdout empty", func(t *testing.T) {
		run := govFamEnv(t, &govFamServer{empty: true})
		code, stdout, stderr := govFamRun(t, run, "teams", "list", "--output", "table", "--no-input")
		if code != 0 || stdout != "" || !strings.Contains(stderr, "alethia teams create") {
			t.Errorf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
		}
	})

	for _, args := range [][]string{{"org", "settings"}, {"sso", "get", "--domain", "example.com"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			run := govFamEnv(t, &govFamServer{})
			code, stdout, stderr := govFamRun(t, run, append(append([]string{}, args...), "--output", "json", "--no-input")...)
			if code != 0 {
				t.Fatalf("exit %d:\n%s", code, stderr)
			}
			var doc map[string]any
			if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
				t.Fatalf("stdout is not one json object: %v\n%s", err, stdout)
			}
		})
	}
}

// TestGovFamily_OrgSwitchReportsWhatChanged pins the one mutation that changes this machine and
// not the control plane: a switch is "updated", and a switch to the active organization is
// "unchanged" and writes nothing.
func TestGovFamily_OrgSwitchReportsWhatChanged(t *testing.T) {
	s := &govFamServer{}
	run := govFamEnv(t, s)
	code, stdout, stderr := govFamRun(t, run, "org", "switch", "beta", "--output", "json", "--no-input")
	if code != 0 {
		t.Fatalf("exit %d:\n%s", code, stderr)
	}
	if r := govFamDecode(t, stdout); r.Kind != govKindOrganization || r.Action != "updated" || r.ID != "o2" {
		t.Errorf("result = %+v", r)
	}
	if got := types.LoadCliConfig().ActiveOrgID; got != "o2" {
		t.Errorf("active organization = %q, want o2", got)
	}

	_, stdout, _ = govFamRun(t, run, "org", "switch", "beta", "--output", "json", "--no-input")
	if r := govFamDecode(t, stdout); r.Action != "unchanged" {
		t.Errorf("a repeated switch reported %q, want unchanged", r.Action)
	}
	if muts := s.mutations(); len(muts) != 0 {
		t.Errorf("org switch sent %v", muts)
	}
}

// govFamRefusalCase is one invocation that must be refused.
type govFamRefusalCase struct {
	name string
	args []string
	exit int
	want []string
}

// govFamRefusals is one refusal per command that can make one without the control plane saying
// no, and one per kind of refusal a command has.
func govFamRefusals() []govFamRefusalCase {
	return []govFamRefusalCase{
		{"org switch: nobody to ask", []string{"org", "switch"}, clierr.ExitInputRequired, []string{"[org]", "alethia org list"}},
		{"org switch: unknown", []string{"org", "switch", "nope"}, clierr.ExitNotFound, []string{`no organization matching "nope"`, "alethia org list"}},
		{"org list: a stray argument", []string{"org", "list", "extra"}, clierr.ExitUsage, []string{"extra"}},
		{"members add: no email", []string{"members", "add"}, clierr.ExitInputRequired, []string{"[email]"}},
		{"members add: not an address", []string{"members", "add", "ada"}, clierr.ExitUsage, []string{"not an email address"}},
		{"members remove: nobody named", []string{"members", "remove"}, clierr.ExitInputRequired, []string{"--email", "alethia members list"}},
		{"members remove: unconfirmed", []string{"members", "remove", "--email", "ada@example.com"}, clierr.ExitInputRequired, []string{"pass --yes", "alethia members remove m1 --yes"}},
		{"members remove: unknown email", []string{"members", "remove", "--email", "nobody@example.com", "--yes"}, clierr.ExitNotFound, []string{`no member named "nobody@example.com"`, "alethia members list"}},
		{"members remove: named twice", []string{"members", "remove", "m1", "--email", "ada@example.com", "--yes"}, clierr.ExitUsage, []string{"not both"}},
		{"teams create: no name", []string{"teams", "create"}, clierr.ExitInputRequired, []string{"[name]"}},
		{"teams delete: unconfirmed", []string{"teams", "delete", "--name", "platform"}, clierr.ExitInputRequired, []string{"pass --yes"}},
		{"teams delete: unknown name", []string{"teams", "delete", "--name", "nope", "--yes"}, clierr.ExitNotFound, []string{`no team named "nope"`, "alethia teams list"}},
		{"roles create: no name", []string{"roles", "create"}, clierr.ExitInputRequired, []string{"[name]"}},
		{"roles delete: unconfirmed", []string{"roles", "delete", "--name", "deployers"}, clierr.ExitInputRequired, []string{"pass --yes"}},
		{"roles delete: a built-in by id", []string{"roles", "delete", "ro1", "--yes"}, clierr.ExitConflict, []string{"owner is a built-in role", "alethia roles list"}},
		{"roles delete: a built-in by name", []string{"roles", "delete", "--name", "owner", "--yes"}, clierr.ExitNotFound, []string{`no custom role named "owner"`}},
		{"grants add: no principal", []string{"grants", "add"}, clierr.ExitInputRequired, []string{"--principal"}},
		{"grants add: neither binding", []string{"grants", "add", "--principal", "ada@example.com"}, clierr.ExitUsage, []string{"exactly one of --role or --permission"}},
		{"grants add: a bad effect", []string{"grants", "add", "--principal", "ada@example.com", "--role", "owner", "--effect", "maybe"}, clierr.ExitUsage, []string{`--effect "maybe" is not one of`}},
		{"grants add: an org grant with a resource", []string{"grants", "add", "--principal", "ada@example.com", "--role", "owner", "--resource", "p1"}, clierr.ExitUsage, []string{"not meaningful with --resource-type org"}},
		{"grants add: an unknown role", []string{"grants", "add", "--principal", "ada@example.com", "--role", "nope"}, clierr.ExitNotFound, []string{`no role named "nope"`, "alethia roles list"}},
		{"grants remove: nobody named", []string{"grants", "remove"}, clierr.ExitInputRequired, []string{"[grant_id]", "alethia grants list"}},
		{"grants remove: unconfirmed", []string{"grants", "remove", "g1"}, clierr.ExitInputRequired, []string{"pass --yes", "alethia grants remove g1 --yes"}},
		{"sso get: nobody named", []string{"sso", "get"}, clierr.ExitInputRequired, []string{"--domain", "alethia sso list"}},
		{"sso get: unknown domain", []string{"sso", "get", "--domain", "nope.example"}, clierr.ExitNotFound, []string{`no SSO provider named "nope.example"`}},
		{"alerts create: no name", []string{"alerts", "create"}, clierr.ExitInputRequired, []string{"an alert rule name is required"}},
		{"alerts create: no event", []string{"alerts", "create", "r", "--channel", "Ops Slack"}, clierr.ExitInputRequired, []string{"--event"}},
		{"alerts create: no channel", []string{"alerts", "create", "r", "--event", "e"}, clierr.ExitInputRequired, []string{"--channel", "alethia channels list"}},
		{"alerts create: an unknown channel", []string{"alerts", "create", "r", "--event", "e", "--channel", "nope"}, clierr.ExitNotFound, []string{`no channel matches "nope"`}},
		{"alerts create: a bad severity", []string{"alerts", "create", "r", "--event", "e", "--channel", "Ops Slack", "--severity", "loud"}, clierr.ExitUsage, []string{`--severity "loud" is not one of`}},
		{"alerts delete: nobody named", []string{"alerts", "delete"}, clierr.ExitInputRequired, []string{"no alert rule given", "alethia alerts list"}},
		{"alerts delete: unconfirmed", []string{"alerts", "delete", "Job failures"}, clierr.ExitInputRequired, []string{"pass --yes"}},
		{"channels create: no name", []string{"channels", "create"}, clierr.ExitInputRequired, []string{"a channel name is required"}},
		{"channels create: no type", []string{"channels", "create", "Pager"}, clierr.ExitInputRequired, []string{"--type is required"}},
		{"channels create: no destination", []string{"channels", "create", "Pager", "--type", "pagerduty"}, clierr.ExitInputRequired, []string{"--routing-key", "--routing-key-stdin"}},
		{"channels create: a bad type", []string{"channels", "create", "Pager", "--type", "carrier-pigeon", "--url", "https://x.example"}, clierr.ExitUsage, []string{`--type "carrier-pigeon" is not one of`}},
		{"channels create: two secrets on one stdin", []string{"channels", "create", "Pager", "--type", "pagerduty", "--routing-key-stdin", "--signing-secret-stdin"}, clierr.ExitUsage, []string{"both read stdin"}},
		{"channels create: one secret named twice", []string{"channels", "create", "Pager", "--type", "pagerduty", "--routing-key", "k", "--routing-key-stdin"}, clierr.ExitUsage, []string{"both name the routing key"}},
		{"channels create: the signing secret named twice", []string{"channels", "create", "Hook", "--type", "webhook", "--url", "https://x.example", "--signing-secret", "s", "--signing-secret-stdin"}, clierr.ExitUsage, []string{"both name the signing secret"}},
		{"channels create: an empty signing secret on stdin", []string{"channels", "create", "Hook", "--type", "webhook", "--url", "https://x.example", "--signing-secret-stdin"}, clierr.ExitInputRequired, []string{"--signing-secret-stdin was given and stdin was empty"}},
		{"token create: a dry run with no name", []string{"token", "create", "--dry-run"}, clierr.ExitInputRequired, []string{"--name is required"}},
		{"channels verify: unknown", []string{"channels", "verify", "nope"}, clierr.ExitNotFound, []string{`no channel matches "nope"`, "alethia channels list"}},
		{"channels delete: unconfirmed", []string{"channels", "delete", "Ops Slack"}, clierr.ExitInputRequired, []string{"pass --yes", "alethia channels delete ch1 --yes"}},
		{"classification show: nothing named", []string{"classification", "show"}, clierr.ExitInputRequired, []string{"alethia classification dimensions"}},
		{"classification assign: one argument", []string{"classification", "assign", "project_environment"}, clierr.ExitUsage, []string{"accepts between 2 and 4 arg(s)"}},
		{"classification assign: an unknown dimension", []string{"classification", "assign", "project_environment", "e1", "nope", "gold"}, clierr.ExitNotFound, []string{`no classification dimension "nope"`}},
		{"classification assign: an unknown value", []string{"classification", "assign", "project_environment", "e1", "tier", "lead"}, clierr.ExitUsage, []string{`"lead" is not a value of the "tier" dimension`}},
		{"classification assign: no value", []string{"classification", "assign", "project_environment", "e1", "tier"}, clierr.ExitInputRequired, []string{"no value slug given", "gold"}},
		{"classification unassign: unconfirmed", []string{"classification", "unassign", "project_environment", "e1", "gold"}, clierr.ExitInputRequired, []string{"pass --yes"}},
		{"token create: no name", []string{"token", "create"}, clierr.ExitInputRequired, []string{"--name is required", "alethia token create --name ci"}},
		{"token revoke: nobody named", []string{"token", "revoke"}, clierr.ExitInputRequired, []string{"the token id is required", "alethia token list"}},
	}
}

// TestGovFamily_RefusalsExitWithTheirClassOnStderr drives every refusal: the exit code is the
// class, stdout is empty, the sentence and its next step are on stderr, and nothing was changed.
func TestGovFamily_RefusalsExitWithTheirClassOnStderr(t *testing.T) {
	for _, tc := range govFamRefusals() {
		t.Run(tc.name, func(t *testing.T) {
			s := &govFamServer{}
			run := govFamEnv(t, s)
			code, stdout, stderr := govFamRun(t, run, append(append([]string{}, tc.args...), "--no-input")...)
			if code != tc.exit {
				t.Errorf("exit code = %d, want %d\n%s", code, tc.exit, stderr)
			}
			if stdout != "" {
				t.Errorf("a refusal wrote on stdout: %q", stdout)
			}
			for _, want := range tc.want {
				if !strings.Contains(stderr, want) {
					t.Errorf("stderr is missing %q:\n%s", want, stderr)
				}
			}
			if muts := s.mutations(); len(muts) != 0 {
				t.Errorf("a refused command still sent %v", muts)
			}
		})
	}
}

// TestGovFamily_ARefusalUnderJSONIsOneEnvelopeOnStderr pins the machine form of a refusal: one
// alethia.error/v1 object on stderr carrying the code, the exit and the hint, and an empty stdout.
func TestGovFamily_ARefusalUnderJSONIsOneEnvelopeOnStderr(t *testing.T) {
	run := govFamEnv(t, &govFamServer{})
	code, stdout, stderr := govFamRun(t, run, "teams", "delete", "--name", "platform", "--output", "json", "--no-input")
	if code != clierr.ExitInputRequired || stdout != "" {
		t.Fatalf("exit %d, stdout %q", code, stdout)
	}
	var env struct {
		Schema string `json:"schema"`
		Error  struct {
			Code     string `json:"code"`
			ExitCode int    `json:"exit_code"`
			Hint     string `json:"hint"`
		} `json:"error"`
	}
	// The envelope is the LAST line of stderr: what was said on the way — which team the name
	// resolved to — comes before it.
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &env); err != nil {
		t.Fatalf("the last line of stderr is not one error envelope: %v\n%s", err, stderr)
	}
	if env.Schema != "alethia.error/v1" || env.Error.Code != clierr.CodeConfirmationRequired ||
		env.Error.ExitCode != clierr.ExitInputRequired || env.Error.Hint != "alethia teams delete t1 --yes" {
		t.Errorf("envelope = %+v", env)
	}
}

// TestGovFamily_AControlPlaneRefusalKeepsItsClassAndItsWords drives what the control plane says
// no to. The sentence shown is the control plane's own, the exit is the row its status belongs
// to, and the next step is named.
func TestGovFamily_AControlPlaneRefusalKeepsItsClassAndItsWords(t *testing.T) {
	cases := []struct {
		name    string
		key     string
		refusal govFamRefusal
		args    []string
		exit    int
		want    []string
	}{
		{"a plan limit on roles", "POST /api/cli/roles", govFamRefusal{http.StatusPaymentRequired, "Custom roles require an Enterprise license."},
			[]string{"roles", "create", "auditors"}, clierr.ExitLimited, []string{"Custom roles require an Enterprise license.", "alethia billing"}},
		{"a plan limit on grants", "POST /api/cli/grants", govFamRefusal{http.StatusPaymentRequired, "Access management requires an Enterprise license."},
			[]string{"grants", "add", "--principal", "ada@example.com", "--role", "owner"}, clierr.ExitLimited, []string{"Access management requires an Enterprise license.", "alethia billing"}},
		{"a plan limit on alerts", "POST /api/cli/alerts", govFamRefusal{http.StatusPaymentRequired, "Alerts require a Pro plan or higher."},
			[]string{"alerts", "create", "r", "--event", "e", "--channel", "Ops Slack"}, clierr.ExitLimited, []string{"Alerts require a Pro plan or higher.", "alethia billing"}},
		{"a plan limit on channels", "POST /api/cli/channels", govFamRefusal{http.StatusPaymentRequired, "Alerts require a Pro plan or higher."},
			[]string{"channels", "create", "Ops", "--type", "slack", "--url", "https://x.example"}, clierr.ExitLimited, []string{"Alerts require a Pro plan or higher.", "alethia billing"}},
		{"a plan limit on a list", "GET /api/cli/grants", govFamRefusal{http.StatusPaymentRequired, "Access management requires an Enterprise license."},
			[]string{"grants", "list"}, clierr.ExitLimited, []string{"Access management requires an Enterprise license.", "alethia billing"}},
		// Whatever the control plane says about creating a team is shown as it said it.
		{"a refused team", "POST /api/cli/orgs/o1/teams", govFamRefusal{http.StatusForbidden, "Forbidden: you cannot create teams in this organization"},
			[]string{"teams", "create", "sre"}, clierr.ExitForbidden, []string{"Forbidden: you cannot create teams in this organization", "alethia whoami"}},
		{"a member the control plane does not have", "DELETE /api/cli/orgs/o1/members/m9", govFamRefusal{http.StatusNotFound, "Member not found"},
			[]string{"members", "remove", "m9", "--yes"}, clierr.ExitNotFound, []string{"Member not found", "alethia members list"}},
		{"a server fault on a removal", "DELETE /api/cli/orgs/o1/members/m1", govFamRefusal{http.StatusInternalServerError, "boom"},
			[]string{"members", "remove", "m1", "--yes"}, clierr.ExitUnavailable, []string{"boom", "try again"}},
		{"a conflict on an invitation", "POST /api/cli/orgs/o1/members", govFamRefusal{http.StatusConflict, "ada@example.com is already a member"},
			[]string{"members", "add", "ada@example.com"}, clierr.ExitConflict, []string{"ada@example.com is already a member"}},
		{"an expired session", "GET /api/cli/roles", govFamRefusal{http.StatusUnauthorized, "Unauthorized: Invalid token"},
			[]string{"roles", "list"}, clierr.ExitAuth, []string{"Unauthorized: Invalid token", "alethia login"}},
		{"a role the control plane does not have", "DELETE /api/cli/roles/ro2", govFamRefusal{http.StatusNotFound, "Role not found"},
			[]string{"roles", "delete", "--name", "deployers", "--yes"}, clierr.ExitNotFound, []string{"Role not found", "alethia roles list"}},
		{"a failed alert list", "GET /api/cli/alerts", govFamRefusal{http.StatusInternalServerError, "boom"},
			[]string{"alerts", "list", "--output", "json"}, clierr.ExitUnavailable, []string{"boom"}},
		{"a token that is not there", "DELETE /api/cli/tokens/tok9", govFamRefusal{http.StatusNotFound, "Token not found"},
			[]string{"token", "revoke", "tok9"}, clierr.ExitNotFound, []string{"Token not found", "alethia token list"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &govFamServer{refuse: map[string]govFamRefusal{tc.key: tc.refusal}}
			run := govFamEnv(t, s)
			code, stdout, stderr := govFamRun(t, run, append(append([]string{}, tc.args...), "--no-input")...)
			if code != tc.exit {
				t.Errorf("exit code = %d, want %d\n%s", code, tc.exit, stderr)
			}
			if stdout != "" {
				t.Errorf("a refusal wrote on stdout: %q", stdout)
			}
			for _, want := range tc.want {
				if !strings.Contains(stderr, want) {
					t.Errorf("stderr is missing %q:\n%s", want, stderr)
				}
			}
		})
	}
}

// TestGovFamily_RemovalsAreConfirmedByTypingTheName pins the confirmation of the three removals
// that take a person's or a group's access away: the question asks for the name of the thing —
// found from its id when only the id was given — a wrong answer removes nothing and is not an
// error, and the right one removes it.
func TestGovFamily_RemovalsAreConfirmedByTypingTheName(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		wantName string
		path     string
	}{
		{"members remove by email", []string{"members", "remove", "--email", "ada@example.com"}, "ada@example.com", "/api/cli/orgs/o1/members/m1"},
		{"members remove by id", []string{"members", "remove", "m1"}, "ada@example.com", "/api/cli/orgs/o1/members/m1"},
		{"members remove by an id the list lacks", []string{"members", "remove", "m9"}, "m9", "/api/cli/orgs/o1/members/m9"},
		{"teams delete by name", []string{"teams", "delete", "--name", "platform"}, "platform", "/api/cli/orgs/o1/teams/t1"},
		{"teams delete by id", []string{"teams", "delete", "t1"}, "platform", "/api/cli/orgs/o1/teams/t1"},
		{"roles delete by name", []string{"roles", "delete", "--name", "deployers"}, "deployers", "/api/cli/roles/ro2"},
		{"roles delete by id", []string{"roles", "delete", "ro2"}, "deployers", "/api/cli/roles/ro2"},
	}
	for _, tc := range cases {
		for _, typed := range []bool{false, true} {
			name := tc.name + "/declined"
			if typed {
				name = tc.name + "/typed"
			}
			t.Run(name, func(t *testing.T) {
				s := &govFamServer{}
				run := govFamEnv(t, s)
				hygCliConfirmInteractive(t)
				miscTTY(t)
				var asked []string
				prev := confirmTypedName
				confirmTypedName = func(_, _, name string) bool {
					asked = append(asked, name)
					return typed
				}
				t.Cleanup(func() { confirmTypedName = prev })

				code, stdout, stderr := govFamRun(t, run, append(append([]string{}, tc.args...), "--output", "json", "--no-input=false")...)
				if code != 0 {
					t.Fatalf("exit %d:\n%s", code, stderr)
				}
				if len(asked) != 1 || asked[0] != tc.wantName {
					t.Errorf("the confirmation asked for %v, want [%s]", asked, tc.wantName)
				}
				muts := s.mutations()
				if !typed {
					if len(muts) != 0 || stdout != "" {
						t.Errorf("a declined removal sent %v and printed %q", muts, stdout)
					}
					return
				}
				if len(muts) != 1 || muts[0].Method != http.MethodDelete || muts[0].Path != tc.path {
					t.Errorf("want one DELETE %s, got %v", tc.path, muts)
				}
				if r := govFamDecode(t, stdout); r.Action != "deleted" {
					t.Errorf("result = %+v", r)
				}
			})
		}
	}
}

// TestGovFamily_TokenRevokeNeverWaitsOnAConfirmation pins the one removal that does not ask:
// revoking a token is what a pipeline does about a leaked credential, so with nobody to ask and
// no --yes it still revokes.
func TestGovFamily_TokenRevokeNeverWaitsOnAConfirmation(t *testing.T) {
	s := &govFamServer{}
	run := govFamEnv(t, s)
	code, stdout, stderr := govFamRun(t, run, "token", "revoke", "tok1", "--no-input")
	if code != 0 {
		t.Fatalf("exit %d:\n%s", code, stderr)
	}
	if muts := s.mutations(); len(muts) != 1 || muts[0].Path != "/api/cli/tokens/tok1" {
		t.Errorf("the token was not revoked: %v", muts)
	}
	if !strings.Contains(stdout, "Revoked tok1") {
		t.Errorf("stdout = %q", stdout)
	}
	if rootCmdFlag(t, "token", "revoke", "yes") {
		t.Error("token revoke gained a --yes flag: a confirmation there leaves a leaked token live")
	}
}

// rootCmdFlag reports whether the command at path has the named flag. The last argument is the
// flag; the ones before it are the command path.
func rootCmdFlag(t *testing.T, pathAndFlag ...string) bool {
	t.Helper()
	path, flag := pathAndFlag[:len(pathAndFlag)-1], pathAndFlag[len(pathAndFlag)-1]
	cmd, _, err := rootCmd.Find(path)
	if err != nil {
		t.Fatalf("find %v: %v", path, err)
	}
	return cmd.Flags().Lookup(flag) != nil
}

// TestGovFamily_TheTokenIsWrittenInOnePlace drives `token create` with the request log on, in
// each format, and counts the token: once on stdout, never on stderr.
func TestGovFamily_TheTokenIsWrittenInOnePlace(t *testing.T) {
	for _, format := range []string{ui.FormatTable, ui.FormatJSON, ui.FormatCSV} {
		t.Run(format, func(t *testing.T) {
			run := govFamEnv(t, &govFamServer{})
			t.Setenv(api.DebugEnv, "api")
			modeEnv(t, map[string]string{api.DebugEnv: "api"})
			code, stdout, stderr := govFamRun(t, run, "token", "create", "--name", "ci", "--no-input", "--output", format)
			if code != 0 {
				t.Fatalf("exit code = %d\n%s", code, stderr)
			}
			if n := strings.Count(stdout, govFamTokenValue); n != 1 {
				t.Errorf("the token is on stdout %d times, want 1:\n%s", n, stdout)
			}
			if strings.Contains(stderr, govFamTokenValue) {
				t.Errorf("the token is on stderr:\n%s", stderr)
			}
			// The request log must have been on, or "not on stderr" proves nothing about it.
			if !strings.Contains(stderr, "/api/cli/tokens") {
				t.Fatalf("the request log did not run, so this test did not read it:\n%s", stderr)
			}
			if format == ui.FormatTable && stdout != govFamTokenValue+"\n" {
				t.Errorf("stdout = %q, want exactly the token and a newline", stdout)
			}
		})
	}
}

// TestGovFamily_ARefusedTokenPrintsNoCredential pins the failure path of `token create`: nothing
// on stdout, the control plane's class, and no token anywhere.
func TestGovFamily_ARefusedTokenPrintsNoCredential(t *testing.T) {
	s := &govFamServer{refuse: map[string]govFamRefusal{"POST /api/cli/tokens": {http.StatusForbidden, "service tokens cannot mint tokens"}}}
	run := govFamEnv(t, s)
	t.Setenv(api.DebugEnv, "api")
	modeEnv(t, map[string]string{api.DebugEnv: "api"})
	code, stdout, stderr := govFamRun(t, run, "token", "create", "--name", "ci", "--no-input")
	if code != clierr.ExitForbidden || stdout != "" {
		t.Errorf("exit %d, stdout %q", code, stdout)
	}
	if strings.Contains(stderr, govFamTokenValue) || !strings.Contains(stderr, "service tokens cannot mint tokens") {
		t.Errorf("stderr = %s", stderr)
	}
}

// TestGovFamily_AChannelSecretIsReadFromStdin drives both secret flags: the secret piped in
// reaches the control plane in the request, and is on neither stream, with the request log on.
func TestGovFamily_AChannelSecretIsReadFromStdin(t *testing.T) {
	cases := []struct {
		name string
		args []string
		key  string
	}{
		{"routing key", []string{"channels", "create", "Pager", "--type", "pagerduty", "--routing-key-stdin"}, "routing_key"},
		{"signing secret", []string{"channels", "create", "Hook", "--type", "webhook", "--url", "https://x.example/hook", "--signing-secret-stdin"}, "signing_secret"},
	}
	for _, tc := range cases {
		for _, format := range []string{ui.FormatTable, ui.FormatJSON} {
			t.Run(tc.name+"/"+format, func(t *testing.T) {
				s := &govFamServer{}
				run := govFamEnv(t, s)
				t.Setenv(api.DebugEnv, "api")
				modeEnv(t, map[string]string{api.DebugEnv: "api"})
				govFamStdin(t, govFamSecret+"\n")
				code, stdout, stderr := govFamRun(t, run, append(append([]string{}, tc.args...), "--no-input", "--output", format)...)
				if code != 0 {
					t.Fatalf("exit %d:\n%s", code, stderr)
				}
				muts := s.mutations()
				if len(muts) != 1 {
					t.Fatalf("want one request, got %v", muts)
				}
				var sent struct {
					Config map[string]any `json:"config"`
				}
				if err := json.Unmarshal([]byte(muts[0].Body), &sent); err != nil {
					t.Fatalf("request body: %v\n%s", err, muts[0].Body)
				}
				if sent.Config[tc.key] != govFamSecret {
					t.Errorf("the secret did not reach the request as %s: %s", tc.key, muts[0].Body)
				}
				if strings.Contains(stdout, govFamSecret) || strings.Contains(stderr, govFamSecret) {
					t.Errorf("the secret was printed:\nstdout: %s\nstderr: %s", stdout, stderr)
				}
				if !strings.Contains(stderr, "/api/cli/channels") {
					t.Fatalf("the request log did not run, so this test did not read it:\n%s", stderr)
				}
			})
		}
	}

	t.Run("an empty stdin is refused", func(t *testing.T) {
		s := &govFamServer{}
		run := govFamEnv(t, s)
		govFamStdin(t, "\n")
		code, stdout, stderr := govFamRun(t, run, "channels", "create", "Pager", "--type", "pagerduty", "--routing-key-stdin", "--no-input")
		if code != clierr.ExitInputRequired || stdout != "" || !strings.Contains(stderr, "stdin was empty") {
			t.Errorf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
		}
		if muts := s.mutations(); len(muts) != 0 {
			t.Errorf("a refused create sent %v", muts)
		}
	})
}

// TestGovFamily_ADryRunOfAChannelNamesNoSecret pins the request a dry run reports: it says a
// secret is present and never what it is.
func TestGovFamily_ADryRunOfAChannelNamesNoSecret(t *testing.T) {
	run := govFamEnv(t, &govFamServer{})
	code, stdout, stderr := govFamRun(t, run, "channels", "create", "Pager", "--type", "pagerduty",
		"--routing-key", govFamSecret, "--dry-run", "--output", "json", "--no-input")
	if code != 0 {
		t.Fatalf("exit %d:\n%s", code, stderr)
	}
	var doc struct {
		Object struct {
			Request struct {
				Type          string `json:"type"`
				HasRoutingKey bool   `json:"has_routing_key"`
			} `json:"request"`
		} `json:"object"`
	}
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
		t.Fatalf("not json: %v\n%s", err, stdout)
	}
	if doc.Object.Request.Type != "pagerduty" || !doc.Object.Request.HasRoutingKey {
		t.Errorf("request = %+v", doc.Object.Request)
	}
	if strings.Contains(stdout+stderr, govFamSecret) {
		t.Errorf("the dry run printed the secret:\n%s\n%s", stdout, stderr)
	}
}

// TestGovFamily_ARecordlessSuccessIsAnError pins each create against a 200 that carries no
// record: it is reported, never dereferenced and never printed as a success.
func TestGovFamily_ARecordlessSuccessIsAnError(t *testing.T) {
	cases := map[string][]string{
		"POST /api/cli/orgs/o1/members": {"members", "add", "grace@example.com"},
		"POST /api/cli/orgs/o1/teams":   {"teams", "create", "sre"},
		"POST /api/cli/roles":           {"roles", "create", "auditors"},
		"POST /api/cli/grants":          {"grants", "add", "--principal", "ada@example.com", "--role", "owner"},
		"GET /api/cli/sso/s1":           {"sso", "get", "--domain", "example.com"},
	}
	for key, args := range cases {
		t.Run(strings.Join(args[:2], " "), func(t *testing.T) {
			// A 200 whose body is an error envelope decodes to no record.
			s := &govFamServer{refuse: map[string]govFamRefusal{key: {http.StatusOK, ""}}}
			run := govFamEnv(t, s)
			code, stdout, stderr := govFamRun(t, run, append(append([]string{}, args...), "--no-input")...)
			if code != clierr.ExitUnclassified || stdout != "" || !strings.Contains(stderr, "returned no record of it") {
				t.Errorf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
			}
		})
	}

	t.Run("token create", func(t *testing.T) {
		s := &govFamServer{refuse: map[string]govFamRefusal{"POST /api/cli/tokens": {http.StatusOK, ""}}}
		run := govFamEnv(t, s)
		code, stdout, stderr := govFamRun(t, run, "token", "create", "--name", "ci", "--no-input")
		if code != clierr.ExitUnclassified || stdout != "" || !strings.Contains(stderr, "returned no token") {
			t.Errorf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
		}
	})

	t.Run("a failed list keeps its class when rendered directly", func(t *testing.T) {
		err := runAlertsList(&fakeClient{err: &api.APIError{StatusCode: http.StatusForbidden, Message: "no"}}, io.Discard, ui.FormatJSON)
		if e := clierr.From(err); e == nil || e.Exit != clierr.ExitForbidden || e.Hint == "" {
			t.Errorf("error = %+v", e)
		}
	})

	t.Run("channels verify", func(t *testing.T) {
		s := &govFamServer{refuse: map[string]govFamRefusal{"POST /api/cli/channels/ch1/verify": {http.StatusOK, ""}}}
		run := govFamEnv(t, s)
		code, stdout, stderr := govFamRun(t, run, "channels", "verify", "Ops Slack", "--no-input")
		if code != clierr.ExitUnclassified || stdout != "" || !strings.Contains(stderr, "returned no channel") {
			t.Errorf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
		}
	})
}

// TestGovFamily_TokenCommandsNeedASession pins the token commands with no credential and nobody
// to sign in: each stops before it reaches the control plane.
func TestGovFamily_TokenCommandsNeedASession(t *testing.T) {
	for _, args := range [][]string{{"token", "list"}, {"token", "create", "--name", "ci"}, {"token", "revoke", "tok1"}} {
		t.Run(strings.Join(args[:2], " "), func(t *testing.T) {
			s := &govFamServer{}
			run := govFamEnv(t, s)
			isolatedHome(t) // a second, empty home: no credential
			t.Setenv("ALETHIA_TOKEN", "")
			code, stdout, _ := govFamRun(t, run, append(append([]string{}, args...), "--no-input")...)
			if code == 0 || stdout != "" {
				t.Errorf("exit %d, stdout %q", code, stdout)
			}
			if len(s.requests) != 0 {
				t.Errorf("an unauthenticated command reached the control plane: %v", s.requests)
			}
		})
	}
}

// TestPrintTokenCreateDryRun_SaysTheLifetime pins the sentence a dry run of `token create` says
// for a token that expires.
func TestPrintTokenCreateDryRun_SaysTheLifetime(t *testing.T) {
	p, out, _ := splitPrinter(ui.FormatTable)
	if err := printTokenCreateDryRun(p, "ci", 90); err != nil {
		t.Fatalf("printTokenCreateDryRun: %v", err)
	}
	if !strings.Contains(out.String(), "expiring in 90 day(s)") {
		t.Errorf("stdout = %q", out.String())
	}
}

// TestReadSecretLine_AStdinThatCannotBeReadIsRefused pins the read failure: a usage refusal that
// names the flag, and no secret.
func TestReadSecretLine_AStdinThatCannotBeReadIsRefused(t *testing.T) {
	secret, err := readSecretLine(iotest.ErrReader(errBoom), "routing-key-stdin")
	if secret != "" || err == nil {
		t.Fatalf("secret %q, err %v", secret, err)
	}
	if e := clierr.From(err); e.Exit != clierr.ExitUsage || !strings.Contains(e.Message, "--routing-key-stdin") {
		t.Errorf("error = %+v", e)
	}
}

// TestGovFamily_TheFleetPickerOffersOnlyOfferedClouds pins the cloud list `fleet set` asks from
// and refuses with: the catalog's offered set, in which a hidden cloud does not appear.
func TestGovFamily_TheFleetPickerOffersOnlyOfferedClouds(t *testing.T) {
	names := cloudProviderNames()
	offered := EnabledCloudProviders()
	if len(names) == 0 || len(names) != len(offered) {
		t.Fatalf("names = %v, offered = %v", names, offered)
	}
	for i, p := range offered {
		if names[i] != string(p) {
			t.Errorf("names[%d] = %q, want %q", i, names[i], p)
		}
	}
	hidden := 0
	for _, p := range types.AllCloudProviders {
		if CloudEnabled(string(p)) {
			continue
		}
		hidden++
		for _, n := range names {
			if n == string(p) {
				t.Errorf("%s is not offered and is in the fleet picker", p)
			}
		}
	}
	if hidden == 0 {
		t.Fatal("every cloud_provider value is offered, so this test compared nothing")
	}
}

// TestGovernanceError_AddsTheNextStepAndKeepsTheSentence pins the one place a control-plane
// refusal gains a hint: the message is untouched, a hint the control plane sent is kept, and a
// class with no stated next step gets none.
func TestGovernanceError_AddsTheNextStepAndKeepsTheSentence(t *testing.T) {
	if governanceError(nil) != nil {
		t.Error("a nil error became an error")
	}
	plan := governanceError(&api.APIError{StatusCode: http.StatusPaymentRequired, Message: "Alerts require a Pro plan or higher."})
	if e := clierr.From(plan); e.Exit != clierr.ExitLimited || !strings.Contains(e.Hint, "alethia billing") ||
		!strings.Contains(e.Message, "Alerts require a Pro plan or higher.") {
		t.Errorf("plan limit = %+v", e)
	}
	// A newer control plane's own code under the 402 row is still a plan limit.
	newer := governanceError(&api.APIError{StatusCode: http.StatusPaymentRequired, Message: "no", Code: "edition_required"})
	if e := clierr.From(newer); !strings.Contains(e.Hint, "alethia billing") {
		t.Errorf("a 402 under an unknown code has hint %q", e.Hint)
	}
	own := governanceError(&api.APIError{StatusCode: http.StatusForbidden, Message: "no", Hint: "ask an owner"})
	if e := clierr.From(own); e.Hint != "ask an owner" {
		t.Errorf("the control plane's hint was replaced with %q", e.Hint)
	}
	limited := governanceError(&api.APIError{StatusCode: http.StatusTooManyRequests, Message: "slow down"})
	if e := clierr.From(limited); e.Exit != clierr.ExitLimited || e.Hint != "" {
		t.Errorf("a rate limit = %+v", e)
	}
	if got := notFoundHint(errBoom, "alethia teams list"); got != errBoom {
		t.Errorf("notFoundHint changed an error that is not a not-found: %v", got)
	}
	if notFoundHint(nil, "x") != nil {
		t.Error("notFoundHint made an error out of nil")
	}
}

// TestMetaGovernance_TheFactsMatchTheCommands holds the registry's facts against the tree: a
// destructive command confirms, a dry-run level means the flag exists, every command says what
// it does, and every example runs as written.
func TestMetaGovernance_TheFactsMatchTheCommands(t *testing.T) {
	applyCommandMeta()
	// The one destructive command that deliberately carries no --yes.
	unconfirmed := map[string]bool{"alethia token revoke": true}
	checked := 0
	for _, m := range metaGovernance {
		cmd, _, err := rootCmd.Find(strings.Fields(m.Path)[1:])
		if err != nil || cmd.CommandPath() != m.Path {
			t.Errorf("%s does not resolve to its own command (err %v)", m.Path, err)
			continue
		}
		if strings.TrimSpace(cmd.Short) == "" || strings.TrimSpace(cmd.Long) == "" {
			t.Errorf("%s has no short or no long description", m.Path)
		}
		if !cmd.Runnable() {
			continue
		}
		checked++
		has := func(flag string) bool { return cmd.Flags().Lookup(flag) != nil }
		if m.Destructive == unconfirmed[m.Path] == has("yes") {
			t.Errorf("%s: destructive is %v and --yes present is %v", m.Path, m.Destructive, has("yes"))
		}
		if (m.DryRun == cmdmeta.DryRunClient) != has(cmdmeta.DryRunFlag) {
			t.Errorf("%s: dry-run level %q does not match whether --dry-run exists (%v)", m.Path, m.DryRun, has(cmdmeta.DryRunFlag))
		}
		// Every command that changes the control plane can be rehearsed.
		if m.Mutates && m.DryRun != cmdmeta.DryRunClient && m.Path != "alethia org switch" {
			t.Errorf("%s changes something and has no dry run", m.Path)
		}
		if m.LongRunning {
			t.Errorf("%s is recorded as long-running; no governance command queues a job", m.Path)
		}
		if len(m.Examples) == 0 {
			t.Errorf("%s has no example", m.Path)
		}
		for _, ex := range m.Examples {
			govFamCheckExample(t, m.Path, ex.Cmd)
		}
	}
	if checked < 31 {
		t.Fatalf("only %d runnable governance commands were checked; the family has thirty-one, so this walk is not seeing the registry", checked)
	}
}

// govFamCheckExample resolves one example against the real tree: it must be the command it is
// listed under, every flag it passes must exist there, its arguments must be ones the command
// accepts, and it must carry no placeholder.
func govFamCheckExample(t *testing.T, path, example string) {
	t.Helper()
	if strings.ContainsAny(example, "<>") {
		t.Errorf("%s: example %q carries a placeholder", path, example)
		return
	}
	tokens := govFamSplit(example)
	if len(tokens) < 2 || tokens[0] != "alethia" {
		t.Errorf("%s: example %q is not an `alethia …` invocation", path, example)
		return
	}
	cmd, rest, err := rootCmd.Find(tokens[1:])
	if err != nil || !cmd.Runnable() || cmd.CommandPath() != path {
		t.Errorf("%s: example %q does not resolve to that command (err %v)", path, example, err)
		return
	}
	var args []string
	for i := 0; i < len(rest); i++ {
		tok := rest[i]
		if !strings.HasPrefix(tok, "-") {
			args = append(args, tok)
			continue
		}
		name := strings.TrimLeft(strings.SplitN(tok, "=", 2)[0], "-")
		flag := lookupExampleFlag(cmd, name)
		if flag == nil {
			t.Errorf("%s: example %q passes %s, which the command does not take", path, example, tok)
			return
		}
		if flag.Value.Type() != "bool" && !strings.Contains(tok, "=") {
			i++
		}
	}
	if err := cmd.ValidateArgs(args); err != nil {
		t.Errorf("%s: example %q passes arguments %v the command does not accept: %v", path, example, args, err)
	}
}

// govFamSplit splits an example into arguments the way a shell would, for the double-quoted
// names the examples use.
func govFamSplit(example string) []string {
	var out []string
	var cur strings.Builder
	quoted, open := false, false
	for _, r := range example {
		switch {
		case r == '"':
			quoted, open = !quoted, true
		case r == ' ' && !quoted:
			if cur.Len() > 0 || open {
				out = append(out, cur.String())
			}
			cur.Reset()
			open = false
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 || open {
		out = append(out, cur.String())
	}
	return out
}
