// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build integration

package agent

import (
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The real-Postgres half of the per-binding users tests. It applies the rendered script exactly as the
// BYO users Job does (`psql --single-transaction -v ON_ERROR_STOP=1`) against the database named by
// ALETHIA_TEST_PG_ADMIN_DSN (a postgres:// URI for an administrator; a superuser is fine), and skips
// when that variable or psql is absent. It creates and removes only roles and schemas named
// alethia_byo_* with hashes no namer produces (all 'e'/'f'/'d' digits), plus one untagged decoy.
//
//	ALETHIA_TEST_PG_ADMIN_DSN=postgres://… go test -tags integration -run ByoUsersPostgres ./internal/agent/

const (
	pgUserA      = "alethia_byo_eeeeeeeeeee1" // env A, declared then revoked then re-adopted
	pgUserB      = "alethia_byo_eeeeeeeeeee2" // env B — must survive env A's sweep
	pgUntagged   = "alethia_byo_eeeeeeeeeee3" // prefixed but untagged — never a candidate
	pgPasswordA1 = "AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA1"
	pgPasswordA2 = "AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA2"
	pgPasswordB  = "BbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB1"
)

// pgAdmin is the admin DSN and the database it names.
type pgAdmin struct {
	t   *testing.T
	dsn *url.URL
	db  string
}

// newPgAdmin reads the DSN or skips the test.
func newPgAdmin(t *testing.T) *pgAdmin {
	t.Helper()
	raw := os.Getenv("ALETHIA_TEST_PG_ADMIN_DSN")
	if raw == "" {
		t.Skip("ALETHIA_TEST_PG_ADMIN_DSN is unset")
	}
	if _, err := exec.LookPath("psql"); err != nil {
		t.Skip("psql is not installed")
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("ALETHIA_TEST_PG_ADMIN_DSN is not a URI: %v", err)
	}
	a := &pgAdmin{t: t, dsn: u}
	a.db = strings.TrimSpace(a.query("SELECT current_database()"))
	return a
}

// as returns the DSN with the user and password replaced.
func (a *pgAdmin) as(user, password string) string {
	u := *a.dsn
	u.User = url.UserPassword(user, password)
	return u.String()
}

// psql runs sql (as -c) against dsn and returns stdout, or the error and combined output.
func psqlRun(dsn, sql string) (string, error) {
	cmd := exec.Command("psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", dsn, "-c", sql)
	out, err := cmd.Output()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return string(out) + string(ee.Stderr), err
	}
	return string(out), err
}

// query runs sql as the administrator and fails the test on error.
func (a *pgAdmin) query(sql string) string {
	a.t.Helper()
	out, err := psqlRun(a.dsn.String(), sql)
	if err != nil {
		a.t.Fatalf("%s: %v\n%s", sql, err, out)
	}
	return out
}

// apply renders the script for env and users, applies it as the BYO users Job does, and returns the
// provisioned set the result line wrote.
func (a *pgAdmin) apply(env string, users ...byoUser) []string {
	a.t.Helper()
	dir := a.t.TempDir()
	result := filepath.Join(dir, "result")
	sql, err := renderByoUsersSQL(byoUsersInput{EnvironmentID: env, DBName: a.db, Users: users, ResultPath: result})
	if err != nil {
		a.t.Fatal(err)
	}
	for _, u := range users {
		if strings.Contains(sql, u.Password) {
			a.t.Fatal("password in the rendered SQL")
		}
	}
	file := filepath.Join(dir, "byo.sql")
	if err := os.WriteFile(file, []byte(sql), 0o600); err != nil {
		a.t.Fatal(err)
	}
	out, err := exec.Command("psql", "-X", "-q", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-d", a.dsn.String(), "-f", file).CombinedOutput()
	if err != nil {
		a.t.Fatalf("apply failed: %v\n%s", err, out)
	}
	b, err := os.ReadFile(result)
	if err != nil {
		a.t.Fatal(err)
	}
	return strings.Fields(string(b))
}

// cleanup removes every role and schema the test may have left.
func (a *pgAdmin) cleanup() {
	for _, r := range []string{pgUserA, pgUserB, pgUntagged} {
		for _, role := range []string{r, r + byoHolderSuffix} {
			_, _ = psqlRun(a.dsn.String(), `DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = '`+role+`') THEN
				EXECUTE 'DROP OWNED BY `+role+` CASCADE'; EXECUTE 'DROP ROLE `+role+`'; END IF; END $$;`)
		}
		_, _ = psqlRun(a.dsn.String(), `DROP SCHEMA IF EXISTS `+r+` CASCADE`)
	}
}

// TestByoUsersPostgres_Lifecycle: create, re-run, env-scoped revoke, and re-adopt against a real server.
func TestByoUsersPostgres_Lifecycle(t *testing.T) {
	a := newPgAdmin(t)
	a.cleanup()
	t.Cleanup(a.cleanup)

	// Create: the user logs in with the stored password, works in its own schema by default, and may
	// not create in public.
	if got := a.apply("env-a", byoUser{pgUserA, pgPasswordA1}); strings.Join(got, ",") != pgUserA {
		t.Fatalf("provisioned set = %v, want [%s]", got, pgUserA)
	}
	asA := a.as(pgUserA, pgPasswordA1)
	if out, err := psqlRun(asA, "CREATE TABLE kept (v text); INSERT INTO kept VALUES ('still here'); CREATE SEQUENCE kept_seq; CREATE VIEW kept_v AS SELECT v FROM kept;"); err != nil {
		t.Fatalf("user A cannot work in its schema: %v\n%s", err, out)
	}
	if got := strings.TrimSpace(a.query("SELECT schemaname FROM pg_tables WHERE tablename = 'kept'")); got != pgUserA {
		t.Errorf("the table landed in schema %q, want its own", got)
	}
	if _, err := psqlRun(asA, "CREATE TABLE public.escape (v int)"); err == nil {
		t.Error("user A may create in schema public")
	}
	if got := strings.TrimSpace(a.query("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname = '" + pgUserA + "'")); got != "f" {
		t.Error("user A holds an elevated attribute")
	}
	if strings.TrimSpace(a.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")) == "t" { // pg_authid is superuser-only
		if v := strings.TrimSpace(a.query("SELECT rolpassword FROM pg_authid WHERE rolname = '" + pgUserA + "'")); !strings.HasPrefix(v, "SCRAM-SHA-256$4096:") {
			t.Errorf("stored password is not a SCRAM verifier: %q", v)
		}
	}

	// Re-run: the same result, nothing else changes, the data is untouched.
	if got := a.apply("env-a", byoUser{pgUserA, pgPasswordA1}); strings.Join(got, ",") != pgUserA {
		t.Fatalf("re-run provisioned set = %v", got)
	}
	if out, _ := psqlRun(asA, "SELECT v FROM kept"); strings.TrimSpace(out) != "still here" {
		t.Fatalf("after re-run, data = %q", out)
	}

	// Another environment's user, and an untagged prefixed role.
	if got := a.apply("env-b", byoUser{pgUserB, pgPasswordB}); strings.Join(got, ",") != pgUserB {
		t.Fatalf("env B provisioned set = %v", got)
	}
	a.query("CREATE ROLE " + pgUntagged + " NOLOGIN")

	// Revoke env A's undeclared users: A goes, its objects move to its holder; B and the untagged role
	// are untouched.
	if got := a.apply("env-a"); len(got) != 0 {
		t.Fatalf("revoke run provisioned %v", got)
	}
	if got := strings.TrimSpace(a.query("SELECT count(*) FROM pg_roles WHERE rolname = '" + pgUserA + "'")); got != "0" {
		t.Fatal("user A was not dropped")
	}
	if got := strings.TrimSpace(a.query("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = '" + pgUserA + "'")); got != pgUserA+byoHolderSuffix {
		t.Errorf("revoked schema owner = %q, want the holder", got)
	}
	if got := strings.TrimSpace(a.query("SELECT tableowner FROM pg_tables WHERE tablename = 'kept'")); got != pgUserA+byoHolderSuffix {
		t.Errorf("revoked table owner = %q, want the holder", got)
	}
	if got := strings.TrimSpace(a.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = '" + pgUserA + byoHolderSuffix + "'")); got != "f" {
		t.Error("the holder can log in")
	}
	if out, err := psqlRun(a.as(pgUserB, pgPasswordB), "SELECT 1"); err != nil {
		t.Errorf("env A's sweep touched env B's user: %v\n%s", err, out)
	}
	if got := strings.TrimSpace(a.query("SELECT count(*) FROM pg_roles WHERE rolname = '" + pgUntagged + "'")); got != "1" {
		t.Error("env A's sweep dropped an untagged prefixed role")
	}

	// A second revoke run is a no-op: the holder is never swept.
	a.apply("env-a")
	if got := strings.TrimSpace(a.query("SELECT count(*) FROM pg_roles WHERE rolname = '" + pgUserA + byoHolderSuffix + "'")); got != "1" {
		t.Fatal("the holder was swept")
	}

	// Re-adopt with a rotated password: every object comes back, the data is reachable, the holder is gone.
	if got := a.apply("env-a", byoUser{pgUserA, pgPasswordA2}); strings.Join(got, ",") != pgUserA {
		t.Fatalf("re-adopt provisioned set = %v", got)
	}
	asA2 := a.as(pgUserA, pgPasswordA2)
	if out, err := psqlRun(asA2, "SELECT v FROM kept_v; SELECT nextval('kept_seq');"); err != nil || !strings.Contains(out, "still here") {
		t.Fatalf("re-adopted user cannot reach its data: %v\n%s", err, out)
	}
	if _, err := psqlRun(asA, "SELECT 1"); err == nil {
		t.Error("the old password still logs in after rotation")
	}
	for _, q := range []string{
		"SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = '" + pgUserA + "'",
		"SELECT tableowner FROM pg_tables WHERE tablename = 'kept'",
		"SELECT sequenceowner FROM pg_sequences WHERE sequencename = 'kept_seq'",
		"SELECT viewowner FROM pg_views WHERE viewname = 'kept_v'",
	} {
		if got := strings.TrimSpace(a.query(q)); got != pgUserA {
			t.Errorf("%s = %q, want %s", q, got, pgUserA)
		}
	}
	if got := strings.TrimSpace(a.query("SELECT count(*) FROM pg_roles WHERE rolname = '" + pgUserA + byoHolderSuffix + "'")); got != "0" {
		t.Error("the holder survived re-adoption")
	}

	// Below 15 the preflight must have taken CREATE on public away from PUBLIC.
	if v := strings.TrimSpace(a.query("SELECT current_setting('server_version_num')::int < 150000")); v == "t" {
		if got := strings.TrimSpace(a.query("SELECT has_schema_privilege('public', 'public', 'CREATE')")); got != "f" {
			t.Error("PUBLIC still holds CREATE on schema public")
		}
	}
}

// TestByoUsersPostgres_RefusesForeignRole: a pre-existing role with a declared name that this
// environment did not tag fails the whole run, and nothing is provisioned.
func TestByoUsersPostgres_RefusesForeignRole(t *testing.T) {
	a := newPgAdmin(t)
	a.cleanup()
	t.Cleanup(a.cleanup)
	a.query("CREATE ROLE " + pgUntagged + " NOLOGIN")
	dir := t.TempDir()
	sql, err := renderByoUsersSQL(byoUsersInput{EnvironmentID: "env-a", DBName: a.db, ResultPath: filepath.Join(dir, "r"),
		Users: []byoUser{{pgUserA, pgPasswordA1}, {pgUntagged, pgPasswordA1}}})
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "byo.sql")
	if err := os.WriteFile(file, []byte(sql), 0o600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("psql", "-X", "-q", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-d", a.dsn.String(), "-f", file).CombinedOutput(); err == nil {
		t.Fatalf("the run adopted an untagged role:\n%s", out)
	}
	if got := strings.TrimSpace(a.query("SELECT count(*) FROM pg_roles WHERE rolname = '" + pgUserA + "'")); got != "0" {
		t.Error("a failed run left a user behind: the script is not one transaction")
	}
}
