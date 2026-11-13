// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"io"
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// mysqlUsersConfig is usersConfig on a MySQL database: same charts, same bindings.
func mysqlUsersConfig(version string) *types.ProjectConfig {
	vc := usersConfig()
	vc.Databases[0] = types.ProjectDatabaseConfig{Name: "primary", Engine: "aurora-mysql", EngineFamily: "mysql", EngineVersion: version}
	return vc
}

// TestByoDBUsers_MySQLRunsTheMySQLDialect: a MySQL environment (#6467) declares the same users a
// Postgres one does, runs the Job with the MySQL dialect and client, and provisions what the result
// lists, with the same cleanup.
func TestByoDBUsers_MySQLRunsTheMySQLDialect(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	c.message = resultOf(api, worker)
	vc := mysqlUsersConfig("8.0")
	if got := declaredByoDBUsers(vc, false, nil); len(got) != 2 {
		t.Fatalf("declared %+v, want both charts' users on a MySQL database", got)
	}
	out, log := runUsers(vc, usersOutputs(vc), nil)
	if out.Failed || !out.Provisioned[api] || !out.Provisioned[worker] || out.Refusal != "" {
		t.Fatalf("outcome %+v\n%s", out, log)
	}
	args := c.jobArgs()
	for _, want := range []string{"--engine mysql", "--sweep-out /sql/sweep.sql"} {
		if !strings.Contains(args, want) {
			t.Errorf("Job args %q lack %q", args, want)
		}
	}
	if strings.Contains(args, "--result-path") {
		t.Errorf("Job args %q", args)
	}
	spec := c.appliedJob()["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)
	if img := spec["containers"].([]any)[0].(map[string]any)["image"]; !strings.HasPrefix(img.(string), "mysql:") {
		t.Errorf("main image %v, want the mysql client", img)
	}
	assertCleanedUp(t, c)
}

// TestByoDBUsers_MySQLFloor: a MySQL older than 8.0.21 runs no Job and reports the floor on the
// facet; a version without a patch passes here and is held to the floor by the Job itself; no
// readable version fails closed.
func TestByoDBUsers_MySQLFloor(t *testing.T) {
	for _, tc := range []struct {
		version string
		ok      bool
	}{
		{"5.7", false}, {"8.0.20", false}, {"latest", false},
		{"8.0", true}, {"8.0.21", true}, {"8.0.36", true}, {"8.4", true}, {"9.1", true},
		{"8.0.mysql_aurora.3.04.0", true}, {"MYSQL_8_0", true}, {"MYSQL_5_7", false},
	} {
		if got := byoMySQLVersionOK("aws", types.ProjectDatabaseConfig{EngineVersion: tc.version}); got != tc.ok {
			t.Errorf("%q: ok = %v, want %v", tc.version, got, tc.ok)
		}
	}
	for _, p := range []string{"aws", "gcp", "azure"} {
		if !byoMySQLVersionOK(p, types.ProjectDatabaseConfig{}) {
			t.Errorf("%s: the catalogue's default MySQL would refuse every binding", p)
		}
	}

	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	vc := mysqlUsersConfig("5.7")
	out, _ := runUsers(vc, usersOutputs(vc), nil)
	if out.Refusal != byoDBUsersMySQLFloorReason || out.Failed || len(c.calls) != 0 {
		t.Fatalf("outcome %+v, calls %v", out, c.calls)
	}
	assertFacetReason(t, vc, out, byoDBUsersMySQLFloorReason)
}

// TestByoDBUsers_MySQLEngineFamilyUnsetIsRefused: an engine naming MySQL with no engine family would
// be MySQL to the Job and Postgres to the binding resolver, so no Job runs and the facet says why.
func TestByoDBUsers_MySQLEngineFamilyUnsetIsRefused(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	vc := mysqlUsersConfig("8.0")
	vc.Databases[0].EngineFamily = ""
	out, _ := runUsers(vc, usersOutputs(vc), nil)
	if out.Refusal != byoDBUsersEngineUnknownReason || len(c.calls) != 0 {
		t.Fatalf("outcome %+v, calls %v", out, c.calls)
	}
	assertFacetReason(t, vc, out, byoDBUsersEngineUnknownReason)
}

// TestByoDBUsers_MySQLBindsTheUsersOwnDatabase: once the Job provisioned a MySQL binding's user, the
// binding lane points the chart at that user's own key and tells it the user's own database through
// the `database` facet — and the administrative secret appears in nothing it applied.
func TestByoDBUsers_MySQLBindsTheUsersOwnDatabase(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	vc := mysqlUsersConfig("8.0")
	w := &vc.AddOns[0].Workloads[0]
	w.Bindings[0].Inject = append(w.Bindings[0].Inject,
		types.ServiceBindingInjection{Env: "DB_USER", From: types.ServiceBindingFacetUsername},
		types.ServiceBindingInjection{Env: "DB_NAME", From: types.ServiceBindingFacetDatabase})
	w.ValuePaths["bind:database:primary:username"] = "api.userSecret"
	w.ValuePaths["bind:database:primary:database"] = "api.database"
	api, _ := usersFor()

	bc := newBindingCluster(t, `{"items":[]}`, 0)
	var log strings.Builder
	st := applyByoChartBindingsExcept(vc, usersOutputs(vc), "aws", nil, provisionedDBUsers(api), &log, io.Discard)
	if st.Failures != 0 {
		t.Fatalf("failures %d\n%s", st.Failures, log.String())
	}
	values := vc.AddOns[0].Values
	if got := manifests.BindingSecretName("api", w.Bindings[0].Target); values["api"].(map[string]any)["existingSecret"] != got {
		t.Errorf("values %v, want existingSecret %s", values, got)
	}
	if got := values["api"].(map[string]any)["database"]; got != api {
		t.Errorf("database facet = %v, want the user's own database %s", got, api)
	}
	body, _ := os.ReadFile(bc.applied)
	if !strings.Contains(string(body), `username: "`+api+`"`) {
		t.Errorf("the binding Secret does not carry the user's own name:\n%s", body)
	}
	if strings.Contains(string(body), bindingOutputsSecret) {
		t.Errorf("the administrative secret reached a binding:\n%s", body)
	}
}

// TestByoDBUsers_SessionsNotEndedIsAWarning: a `sessions-not-ended:<user>` line (the administrator
// could not end a revoked user's sessions) is a Deploy-tab warning naming that user — not a failure,
// and not a provisioned user — and its spelling is the runner's.
func TestByoDBUsers_SessionsNotEndedIsAWarning(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	gone := "alethia_byo_eeeeeeeeeeee"
	c.message = resultOf(api, worker, byoDBUsersSessionsPrefix+gone)
	vc := mysqlUsersConfig("8.0")
	out, log := runUsers(vc, usersOutputs(vc), nil)
	if out.Failed || len(out.Provisioned) != 2 || out.Provisioned[gone] {
		t.Fatalf("outcome %+v\n%s", out, log)
	}
	if len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], gone) || !strings.Contains(out.Warnings[0], "Any session it had open was not terminated") ||
		!strings.Contains(out.Warnings[0], "cannot log in again") {
		t.Fatalf("warnings %v", out.Warnings)
	}
	if _, _, err := parseByoDBUsersResult(*resultOf(byoDBUsersSessionsPrefix + "alethia_app"), true); err == nil {
		t.Error("a session line naming a non-per-binding user was accepted")
	}
	src, err := os.ReadFile("../../../apps/runner/internal/agent/db_bootstrap_byo_mysql.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), `const mysqlByoSessionsPrefix = "`+byoDBUsersSessionsPrefix+`"`) {
		t.Errorf("the runner's session line prefix is not %q", byoDBUsersSessionsPrefix)
	}
}

// TestByoDBUsers_SessionsWarningClaimsNoSession (#6536): without PROCESS the Job names every revoked
// user, whether or not it had a session, so the warning may not say that sessions exist.
func TestByoDBUsers_SessionsWarningClaimsNoSession(t *testing.T) {
	w := byoDBUsersSessionsWarning("alethia_byo_eeeeeeeeeeee")
	for _, claim := range []string{"Its open sessions", "its sessions were", "has open sessions"} {
		if strings.Contains(w, claim) {
			t.Errorf("the warning claims a session exists (%q): %s", claim, w)
		}
	}
	if !strings.Contains(w, "Any session it had open was not terminated") {
		t.Errorf("the warning does not say what happened to a session it had: %s", w)
	}
}

// TestByoDBUsers_SessionsWarningNamesEveryCause (#6536): the runner names a user whose session was
// past its kill bound, or whose kill failed, with every privilege held, so neither the per-user
// warning, the "+n more" doubt, nor the Job log line may give a missing privilege as THE cause, and
// the log line may not say that sessions exist.
func TestByoDBUsers_SessionsWarningNamesEveryCause(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	gone := "alethia_byo_eeeeeeeeeeee"
	c.message = resultOf(api, worker, byoDBUsersSessionsPrefix+gone, byoDBUsersDoubtPrefix+"sessions-not-ended +3 more")
	vc := mysqlUsersConfig("8.0")
	out, log := runUsers(vc, usersOutputs(vc), nil)
	if out.Failed || len(out.Warnings) != 2 {
		t.Fatalf("outcome %+v\n%s", out, log)
	}
	for _, w := range out.Warnings {
		for _, want := range []string{"PROCESS or CONNECTION_ADMIN privilege, or a session could not be ended", "more were open than one deploy ends", "ending one failed"} {
			if !strings.Contains(w, want) {
				t.Errorf("warning %q does not say %q", w, want)
			}
		}
	}
	for _, claim := range []string{"the sessions of revoked user", "(no PROCESS or CONNECTION_ADMIN)"} {
		if strings.Contains(log, claim) {
			t.Errorf("the Job log line claims %q:\n%s", claim, log)
		}
	}
	if !strings.Contains(log, "any open session of revoked user "+gone+" was not terminated") {
		t.Errorf("the Job log does not report %s:\n%s", gone, log)
	}
}

// TestByoDBUsers_DoubtLinesAreWarnings (#6536): each doubt line the runner writes — the lost session
// record, and the "+n more" past either capped list — is accepted inside the counted entries and
// surfaced as its own Deploy-tab warning, never a failure and never a provisioned user. A doubt of
// any other shape makes the result malformed, as any unknown line does. The spellings are the
// runner's.
func TestByoDBUsers_DoubtLinesAreWarnings(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newUsersCluster(t)
	api, worker := usersFor()
	doubts := []string{
		byoDBUsersDoubtPrefix + "sessions-unrecorded",
		byoDBUsersDoubtPrefix + "revocation-pending +6 more",
		byoDBUsersDoubtPrefix + "sessions-not-ended +38 more",
	}
	c.message = resultOf(append([]string{api, worker}, doubts...)...)
	vc := mysqlUsersConfig("8.0")
	out, log := runUsers(vc, usersOutputs(vc), nil)
	if out.Failed || len(out.Provisioned) != 2 {
		t.Fatalf("outcome %+v\n%s", out, log)
	}
	if len(out.Warnings) != 3 {
		t.Fatalf("warnings %v, want one per doubt", out.Warnings)
	}
	for i, want := range []string{"lost its record", "6 more database users", "38 more database users"} {
		if !strings.Contains(out.Warnings[i], want) {
			t.Errorf("warning %d = %q, want it to say %q", i, out.Warnings[i], want)
		}
	}
	for _, bad := range []string{
		byoDBUsersDoubtPrefix + "sessions-unrecorded +1 more",
		byoDBUsersDoubtPrefix + "revocation-pending +0 more",
		byoDBUsersDoubtPrefix + "revocation-pending +01 more",
		byoDBUsersDoubtPrefix + "drops +3 more",
		byoDBUsersDoubtPrefix + "sessions-not-ended",
		byoDBUsersDoubtPrefix,
	} {
		if _, _, _, _, err := parseByoDBUsersResultLines(*resultOf(bad), true); err == nil {
			t.Errorf("the doubt %q was accepted", bad)
		}
	}
	// The header counts a doubt line like any entry: one left uncounted is a mismatch.
	if _, _, _, _, err := parseByoDBUsersResultLines(byoDBUsersResultHeader+"0\n"+doubts[0]+"\n", true); err == nil {
		t.Error("a doubt outside the header's count was accepted")
	}
	src, err := os.ReadFile("../../../apps/runner/internal/agent/db_bootstrap_byo_mysql.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`const mysqlByoDoubtPrefix = "` + byoDBUsersDoubtPrefix + `"`,
		`const mysqlByoSessionsUnrecorded = "sessions-unrecorded"`,
		`more("revocation-pending")`,
		`more("sessions-not-ended")`,
		`kind+" +") + ` + "`" + `, COUNT(*) - `,
		`, ' more') USING utf8mb4)`,
	} {
		if !strings.Contains(string(src), want) {
			t.Errorf("the runner does not spell a doubt line as this parser reads it: %s", want)
		}
	}
}
