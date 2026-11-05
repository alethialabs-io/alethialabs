// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// byoTestUser / byoTestPassword are a declared user and its (alphanumeric, 32-character) password.
const (
	byoTestUser     = "alethia_byo_0123456789ab"
	byoTestPassword = "Abcdefghijklmnop0123456789ABCDEF"
)

// fixedSalt returns a salt source that yields the byte b forever, so a rendered script is reproducible.
func fixedSalt(b byte) io.Reader { return bytes.NewReader(bytes.Repeat([]byte{b}, 1024)) }

// oneUserInput is the golden case: one declared user, a database name with a '-'.
func oneUserInput() byoUsersInput {
	return byoUsersInput{
		EnvironmentID: "env-1",
		DBName:        "app-db",
		ResultPath:    "/dev/termination-log",
		Salt:          fixedSalt(1),
		Users:         []byoUser{{Name: byoTestUser, Password: byoTestPassword}},
	}
}

// TestByoUsersSQL_GoldenCreate pins the whole script for one declared user, statement by statement.
func TestByoUsersSQL_GoldenCreate(t *testing.T) {
	got, err := renderByoUsersSQL(oneUserInput())
	if err != nil {
		t.Fatal(err)
	}
	if got != goldenOneUser {
		t.Errorf("rendered script differs from the golden.\n--- got ---\n%s", got)
	}
}

// TestByoUsersSQL_GoldenEmptyDeclaredSet: with nothing declared, no user is provisioned, the sweep
// excludes nobody, and the result line selects nobody — but the sweep is still env-tag scoped.
func TestByoUsersSQL_GoldenEmptyDeclaredSet(t *testing.T) {
	in := oneUserInput()
	in.Users = nil
	got, err := renderByoUsersSQL(in)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "CREATE ROLE \"alethia_byo_") || strings.Contains(got, "PASSWORD") {
		t.Errorf("an empty declared set must provision nobody:\n%s", got)
	}
	for _, want := range []string{
		"AND a.rolname <> ALL (ARRAY[]::name[])",
		"AND a.rolname = ANY (ARRAY[]::name[])",
		"AND d.description = 'alethia-env:env-1'",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q:\n%s", want, got)
		}
	}
}

// TestByoUsersSQL_OrderIndependent: users are rendered sorted, so argument order changes nothing.
func TestByoUsersSQL_OrderIndependent(t *testing.T) {
	a := byoUser{Name: "alethia_byo_aaaaaaaaaaaa", Password: byoTestPassword}
	b := byoUser{Name: "alethia_byo_bbbbbbbbbbbb", Password: byoTestPassword}
	in := oneUserInput()
	in.Users = []byoUser{b, a}
	s1, err := renderByoUsersSQL(in)
	if err != nil {
		t.Fatal(err)
	}
	in.Users, in.Salt = []byoUser{a, b}, fixedSalt(1)
	s2, err := renderByoUsersSQL(in)
	if err != nil {
		t.Fatal(err)
	}
	if s1 != s2 {
		t.Error("the script depends on the order users were passed in")
	}
	if !strings.Contains(s1, "ARRAY['alethia_byo_aaaaaaaaaaaa', 'alethia_byo_bbbbbbbbbbbb']::name[]") {
		t.Errorf("declared set not rendered sorted:\n%s", s1)
	}
}

// TestByoUsersSQL_RerunIsIdentical: a re-run renders the same script; only a fresh salt changes the
// verifier line, and nothing else.
func TestByoUsersSQL_RerunIsIdentical(t *testing.T) {
	s1, _ := renderByoUsersSQL(oneUserInput())
	s2, _ := renderByoUsersSQL(oneUserInput())
	if s1 != s2 {
		t.Fatal("same input, same salt: scripts differ")
	}
	in := oneUserInput()
	in.Salt = fixedSalt(2)
	s3, err := renderByoUsersSQL(in)
	if err != nil {
		t.Fatal(err)
	}
	assertOnlyPasswordLineDiffers(t, s1, s3)
}

// TestByoUsersSQL_Rotation: a new password changes only the verifier, never another statement.
func TestByoUsersSQL_Rotation(t *testing.T) {
	s1, _ := renderByoUsersSQL(oneUserInput())
	in := oneUserInput()
	in.Users[0].Password = "Zyxwvutsrqponmlk9876543210ZYXWVU"
	s2, err := renderByoUsersSQL(in)
	if err != nil {
		t.Fatal(err)
	}
	if s1 == s2 {
		t.Fatal("a rotated password rendered the same verifier")
	}
	assertOnlyPasswordLineDiffers(t, s1, s2)
}

// assertOnlyPasswordLineDiffers fails unless a and b differ in exactly the ALTER ROLE … PASSWORD line.
func assertOnlyPasswordLineDiffers(t *testing.T, a, b string) {
	t.Helper()
	la, lb := strings.Split(a, "\n"), strings.Split(b, "\n")
	if len(la) != len(lb) {
		t.Fatalf("line counts differ: %d vs %d", len(la), len(lb))
	}
	diffs := 0
	for i := range la {
		if la[i] == lb[i] {
			continue
		}
		diffs++
		if !strings.HasPrefix(la[i], `ALTER ROLE "`+byoTestUser+`" WITH LOGIN CONNECTION LIMIT 20 PASSWORD 'SCRAM-SHA-256$`) {
			t.Errorf("line %d differs and is not the verifier line:\n%s\n%s", i, la[i], lb[i])
		}
	}
	if diffs != 1 {
		t.Errorf("want exactly one differing line, got %d", diffs)
	}
}

// verifierPattern is the SCRAM-SHA-256 verifier Postgres stores: 16-byte salt, 32-byte keys.
var verifierPattern = regexp.MustCompile(`^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$`)

// TestScramVerifier_Format: the verifier has Postgres's stored shape, and a random salt differs per run.
func TestScramVerifier_Format(t *testing.T) {
	salt := make([]byte, scramSaltLen)
	v, err := scramSHA256Verifier(byoTestPassword, salt, scramIterations)
	if err != nil {
		t.Fatal(err)
	}
	if !verifierPattern.MatchString(v) {
		t.Errorf("verifier %q does not have the SCRAM-SHA-256$4096:<salt>$<stored>:<server> shape", v)
	}
	r1, _ := renderByoUsersSQL(byoUsersInput{EnvironmentID: "e", DBName: "d", ResultPath: "/r", Users: []byoUser{{byoTestUser, byoTestPassword}}})
	r2, _ := renderByoUsersSQL(byoUsersInput{EnvironmentID: "e", DBName: "d", ResultPath: "/r", Users: []byoUser{{byoTestUser, byoTestPassword}}})
	if r1 == r2 {
		t.Error("two runs with crypto/rand salts rendered the same verifier")
	}
}

// TestScramVerifier_RFC7677Vector checks the verifier against RFC 7677 §3's exchange, independently of
// this implementation: from the StoredKey and ServerKey it produced, the RFC's client proof must
// recover a ClientKey hashing to StoredKey, and the RFC's server signature must verify.
func TestScramVerifier_RFC7677Vector(t *testing.T) {
	salt, _ := base64.StdEncoding.DecodeString("W22ZaJ0SNY7soEsUEjb6gQ==")
	v, err := scramSHA256Verifier("pencil", salt, 4096)
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`^SCRAM-SHA-256\$4096:W22ZaJ0SNY7soEsUEjb6gQ==\$([^:]+):(.+)$`).FindStringSubmatch(v)
	if m == nil {
		t.Fatalf("verifier %q does not carry the vector's salt", v)
	}
	storedKey, _ := base64.StdEncoding.DecodeString(m[1])
	serverKey, _ := base64.StdEncoding.DecodeString(m[2])
	const nonce = "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0"
	authMessage := "n=user,r=rOprNGfwEbeRWgbNEkqO," +
		"r=" + nonce + ",s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096," +
		"c=biws,r=" + nonce
	proof, _ := base64.StdEncoding.DecodeString("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=")
	clientSig := hmacSHA256(storedKey, authMessage)
	clientKey := make([]byte, len(proof))
	for i := range proof {
		clientKey[i] = proof[i] ^ clientSig[i]
	}
	if got := sha256.Sum256(clientKey); !bytes.Equal(got[:], storedKey) {
		t.Error("RFC 7677 client proof does not verify against the StoredKey")
	}
	wantServerSig, _ := base64.StdEncoding.DecodeString("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")
	if !bytes.Equal(hmacSHA256(serverKey, authMessage), wantServerSig) {
		t.Error("RFC 7677 server signature does not verify against the ServerKey")
	}
}

// TestByoUsers_PlaintextNowhere runs the CLI entry point: the password reaches it only through its
// environment variable, and appears in neither the argv it was given nor anything it writes.
func TestByoUsers_PlaintextNowhere(t *testing.T) {
	args := []string{"--byo-users", "--env-id", "env-1", "--db", "app-db", "--users", byoTestUser}
	env := map[string]string{byoPasswordEnv(byoTestUser): byoTestPassword}
	var out bytes.Buffer
	if err := runDBBootstrapByoUsers(context.Background(), args, mapEnv(env), &out); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(args, " "), byoTestPassword) {
		t.Fatal("password in argv")
	}
	if strings.Contains(out.String(), byoTestPassword) {
		t.Fatal("password in the rendered SQL")
	}
	if !strings.Contains(out.String(), "PASSWORD 'SCRAM-SHA-256$4096:") {
		t.Fatalf("no verifier in the rendered SQL:\n%s", out.String())
	}
	// --out writes the same script, owner-only.
	path := filepath.Join(t.TempDir(), "byo.sql")
	if err := runDBBootstrapByoUsers(context.Background(), append(args, "--out", path), mapEnv(env), io.Discard); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("--out mode = %v, want 0600", fi.Mode().Perm())
	}
	b, _ := os.ReadFile(path)
	if bytes.Contains(b, []byte(byoTestPassword)) {
		t.Fatal("password in the --out file")
	}
}

// mapEnv adapts a map to the getenv the entry point takes.
func mapEnv(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

// TestByoUsers_DBNameQuoted: the database name is always a quoted identifier, an embedded quote is
// doubled, and names Postgres would truncate or that hold control characters are refused.
func TestByoUsers_DBNameQuoted(t *testing.T) {
	in := oneUserInput()
	in.DBName = `my-"db"`
	got, err := renderByoUsersSQL(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`GRANT CONNECT ON DATABASE "my-""db""" TO "` + byoTestUser + `";`,
		`ALTER ROLE "` + byoTestUser + `" IN DATABASE "my-""db""" SET search_path = "` + byoTestUser + `";`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q:\n%s", want, got)
		}
	}
	for _, bad := range []string{"", strings.Repeat("a", 64), "db\nname", "db\x00", "db\x7f"} {
		in.DBName = bad
		if _, err := renderByoUsersSQL(in); err == nil {
			t.Errorf("database name %q accepted", bad)
		}
	}
	in.DBName = strings.Repeat("a", 63)
	if _, err := renderByoUsersSQL(in); err != nil {
		t.Errorf("a 63-byte name is valid: %v", err)
	}
}

// TestByoUsers_Refusals: every input the script would be unsafe or wrong with is refused, and no
// refusal quotes a password.
func TestByoUsers_Refusals(t *testing.T) {
	badNames := []string{
		"alethia_app",                         // first-class role
		"alethia_byo_0123456789ab_r",          // a holder
		"alethia_byo_0123456789AB",            // upper-case hex
		"alethia_byo_0123456789a",             // 11 hex
		"alethia_byo_0123456789abc",           // 13 hex
		`alethia_byo_0123456789ab";DROP ROLE`, // injection
		" alethia_byo_0123456789ab",
	}
	for _, n := range badNames {
		in := oneUserInput()
		in.Users = []byoUser{{Name: n, Password: byoTestPassword}}
		if _, err := renderByoUsersSQL(in); err == nil {
			t.Errorf("user %q accepted", n)
		}
	}
	cases := map[string]func(*byoUsersInput){
		"duplicate user":    func(in *byoUsersInput) { in.Users = append(in.Users, in.Users[0]) },
		"non-alnum":         func(in *byoUsersInput) { in.Users[0].Password = "Abcdefghijklmnop0123456789ABCD'E" },
		"short":             func(in *byoUsersInput) { in.Users[0].Password = "Abc123" },
		"empty password":    func(in *byoUsersInput) { in.Users[0].Password = "" },
		"no env id":         func(in *byoUsersInput) { in.EnvironmentID = "" },
		"quote in env id":   func(in *byoUsersInput) { in.EnvironmentID = "env'1" },
		"dollar in env id":  func(in *byoUsersInput) { in.EnvironmentID = "env$alethia_byo$" },
		"no result path":    func(in *byoUsersInput) { in.ResultPath = "" },
		"result path space": func(in *byoUsersInput) { in.ResultPath = "/tmp/a b" },
		"result path pipe":  func(in *byoUsersInput) { in.ResultPath = "|sh" },
		"result path rel":   func(in *byoUsersInput) { in.ResultPath = "result" },
	}
	for name, mut := range cases {
		in := oneUserInput()
		mut(&in)
		_, err := renderByoUsersSQL(in)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		if len(in.Users) > 0 && in.Users[0].Password != "" && strings.Contains(err.Error(), in.Users[0].Password) {
			t.Errorf("%s: refusal quotes the password: %v", name, err)
		}
	}
}

// TestByoUsers_CLIRefusals: the entry point refuses a missing declared set, a missing password, a bad
// name before reading any password, and an engine other than Postgres.
func TestByoUsers_CLIRefusals(t *testing.T) {
	env := mapEnv(map[string]string{byoPasswordEnv(byoTestUser): byoTestPassword})
	base := []string{"--byo-users", "--env-id", "env-1", "--db", "app-db"}
	for name, args := range map[string][]string{
		"no --users":      base,
		"no password env": append(append([]string{}, base...), "--users", "alethia_byo_ffffffffffff"),
		"bad name":        append(append([]string{}, base...), "--users", "alethia_app"),
		"mysql":           append(append([]string{}, base...), "--users", byoTestUser, "--engine", "mysql"),
		"unknown flag":    append(append([]string{}, base...), "--users", byoTestUser, "--password", "x"),
	} {
		if err := runDBBootstrapByoUsers(context.Background(), args, env, io.Discard); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// An explicitly empty declared set is a known set: it renders the sweep.
	var out bytes.Buffer
	if err := runDBBootstrapByoUsers(context.Background(), append(base, "--users="), env, &out); err != nil {
		t.Fatalf("--users= refused: %v", err)
	}
	if !strings.Contains(out.String(), "ARRAY[]::name[]") {
		t.Errorf("empty declared set not rendered:\n%s", out.String())
	}
}

// TestByoUsers_Dispatch: db-bootstrap routes --byo-users here and leaves the keyless path alone.
func TestByoUsers_Dispatch(t *testing.T) {
	for _, a := range [][]string{{"--byo-users"}, {"-byo-users"}, {"--db", "x", "--byo-users=true"}} {
		if !isByoUsersInvocation(a) {
			t.Errorf("%v not routed to --byo-users", a)
		}
	}
	if isByoUsersInvocation([]string{"--provider", "aws", "--db", "byo-users"}) {
		t.Error("a flag VALUE named byo-users was routed")
	}
	if err := RunDBBootstrap(context.Background(), []string{"--byo-users", "--env-id", "e", "--db", "d"}); err == nil ||
		!strings.Contains(err.Error(), "--users is required") {
		t.Errorf("RunDBBootstrap did not reach the byo-users path: %v", err)
	}
}

// TestByoUsers_SweepPatternScope: the sweep's name pattern (the same text in Go and in SQL) selects
// per-binding users only — never a holder, never a first-class role.
func TestByoUsers_SweepPatternScope(t *testing.T) {
	if byoUserPattern.String() != byoUserSQLPattern {
		t.Fatalf("Go pattern %q and SQL pattern %q differ", byoUserPattern.String(), byoUserSQLPattern)
	}
	for _, n := range []string{"alethia_byo_0123456789ab_r", "alethia_app", "postgres", "rdsadmin", "alethia_byo_", "xalethia_byo_0123456789ab"} {
		if byoUserPattern.MatchString(n) {
			t.Errorf("sweep pattern selects %q", n)
		}
	}
	got, _ := renderByoUsersSQL(oneUserInput())
	sweep := got[strings.Index(got, "-- revoke every undeclared"):]
	for _, want := range []string{
		"WHERE a.rolname ~ '^alethia_byo_[0-9a-f]{12}$'",
		"AND d.description = 'alethia-env:env-1'",
		"AND a.rolname <> ALL (ARRAY['" + byoTestUser + "']::name[])",
		"EXECUTE format('REASSIGN OWNED BY %I TO %I', r.rolname, holder);",
	} {
		if !strings.Contains(sweep, want) {
			t.Errorf("sweep missing %q", want)
		}
	}
	// The objects go to the user's own holder, never to the administrator.
	if strings.Contains(sweep, "REASSIGN OWNED BY %I TO CURRENT_USER") || strings.Contains(got, "ALTER SCHEMA") {
		t.Error("revocation hands objects to the administrator or re-owns only the schema")
	}
}

// TestByoUsers_PreflightVersionBranch: the PUBLIC CREATE revocation runs only below 150000, grants the
// administrator and alethia_app BEFORE revoking, and then checks the result so a refused REVOKE (a
// WARNING in Postgres) fails the run.
func TestByoUsers_PreflightVersionBranch(t *testing.T) {
	got, _ := renderByoUsersSQL(oneUserInput())
	pre := got[:strings.Index(got, "-- "+byoTestUser)]
	order := []string{
		"IF current_setting('server_version_num')::int < 150000",
		"GRANT CREATE ON SCHEMA public TO CURRENT_USER;",
		`GRANT CREATE ON SCHEMA public TO "alethia_app";`,
		"REVOKE CREATE ON SCHEMA public FROM PUBLIC;",
		"a.grantee = 0 AND a.privilege_type = 'CREATE'",
		"RAISE EXCEPTION 'alethia byo-users: CREATE on schema public could not be revoked from PUBLIC'",
	}
	at := 0
	for _, s := range order {
		i := strings.Index(pre[at:], s)
		if i < 0 {
			t.Fatalf("preflight missing %q after offset %d:\n%s", s, at, pre)
		}
		at += i + len(s)
	}
	if strings.Index(got, "REVOKE CREATE ON SCHEMA public FROM PUBLIC") > strings.Index(got, "CREATE ROLE") {
		t.Error("the preflight must run before any user is created")
	}
}

// TestByoUsers_LeastPrivilege: nothing in the script gives a per-binding user an elevated attribute, a
// membership, or a grant on any schema but its own.
func TestByoUsers_LeastPrivilege(t *testing.T) {
	got, _ := renderByoUsersSQL(oneUserInput())
	for _, bad := range []string{
		" SUPERUSER", " CREATEDB", " CREATEROLE", " REPLICATION", " BYPASSRLS",
		`TO "` + byoTestUser + `" WITH`, "ON SCHEMA public TO \"" + byoTestUser,
		"GRANT CURRENT_USER", `IN ROLE`,
	} {
		if strings.Contains(got, bad) {
			t.Errorf("script contains %q", bad)
		}
	}
	grants := regexp.MustCompile(`(?m)^GRANT .*$`).FindAllString(got, -1)
	want := []string{
		`GRANT "` + byoTestUser + `" TO CURRENT_USER;`,
		`GRANT CONNECT ON DATABASE "app-db" TO "` + byoTestUser + `";`,
	}
	if strings.Join(grants, "\n") != strings.Join(want, "\n") {
		t.Errorf("top-level grants = %q, want %q", grants, want)
	}
}

// goldenOneUser is the reviewed script for oneUserInput (salt bytes all 0x01).
const goldenOneUser = `-- alethia db-bootstrap --byo-users (postgres). Apply with psql --single-transaction -v ON_ERROR_STOP=1.
-- Passwords are carried as SCRAM-SHA-256 verifiers only.
DO $alethia_byo$
BEGIN
  IF current_setting('server_version_num')::int < 150000 AND to_regnamespace('public') IS NOT NULL THEN
    GRANT CREATE ON SCHEMA public TO CURRENT_USER;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'alethia_app') THEN
      GRANT CREATE ON SCHEMA public TO "alethia_app";
    END IF;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    IF EXISTS (SELECT FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
               WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') THEN
      RAISE EXCEPTION 'alethia byo-users: CREATE on schema public could not be revoked from PUBLIC';
    END IF;
    IF NOT has_schema_privilege(CURRENT_USER, 'public', 'CREATE') THEN
      RAISE EXCEPTION 'alethia byo-users: the administrator lost CREATE on schema public';
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'alethia_app')
       AND NOT has_schema_privilege('alethia_app', 'public', 'CREATE') THEN
      RAISE EXCEPTION 'alethia byo-users: alethia_app lost CREATE on schema public';
    END IF;
  END IF;
END
$alethia_byo$;
-- alethia_byo_0123456789ab
DO $alethia_byo$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'alethia_byo_0123456789ab') THEN
    IF shobj_description((SELECT oid FROM pg_roles WHERE rolname = 'alethia_byo_0123456789ab'), 'pg_authid') IS DISTINCT FROM 'alethia-env:env-1' THEN
      RAISE EXCEPTION 'alethia byo-users: role % exists and is not tagged with this environment', 'alethia_byo_0123456789ab';
    END IF;
  ELSE
    CREATE ROLE "alethia_byo_0123456789ab" NOLOGIN;
  END IF;
END
$alethia_byo$;
COMMENT ON ROLE "alethia_byo_0123456789ab" IS 'alethia-env:env-1';
ALTER ROLE "alethia_byo_0123456789ab" WITH LOGIN CONNECTION LIMIT 20 PASSWORD 'SCRAM-SHA-256$4096:AQEBAQEBAQEBAQEBAQEBAQ==$XrsZsemzz6NMa1vC+1hnxzMsYneNJQsAZffGF2K6shI=:64GU0XzGp85ScGnPWli/NVH54w/fpAric5YD+h/SC7w=';
GRANT "alethia_byo_0123456789ab" TO CURRENT_USER;
DO $alethia_byo$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'alethia_byo_0123456789ab'
             AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'alethia byo-users: role % holds an elevated attribute', 'alethia_byo_0123456789ab';
  END IF;
  IF EXISTS (SELECT FROM pg_auth_members WHERE member = 'alethia_byo_0123456789ab'::regrole) THEN
    RAISE EXCEPTION 'alethia byo-users: role % is a member of another role', 'alethia_byo_0123456789ab';
  END IF;
END
$alethia_byo$;
DO $alethia_byo$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'alethia_byo_0123456789ab_r') THEN
    IF shobj_description((SELECT oid FROM pg_roles WHERE rolname = 'alethia_byo_0123456789ab_r'), 'pg_authid') IS DISTINCT FROM 'alethia-env:env-1' THEN
      RAISE EXCEPTION 'alethia byo-users: holder % is not tagged with this environment', 'alethia_byo_0123456789ab_r';
    END IF;
    REASSIGN OWNED BY "alethia_byo_0123456789ab_r" TO "alethia_byo_0123456789ab";
    DROP OWNED BY "alethia_byo_0123456789ab_r";
    DROP ROLE "alethia_byo_0123456789ab_r";
  END IF;
END
$alethia_byo$;
GRANT CONNECT ON DATABASE "app-db" TO "alethia_byo_0123456789ab";
CREATE SCHEMA IF NOT EXISTS "alethia_byo_0123456789ab" AUTHORIZATION "alethia_byo_0123456789ab";
DO $alethia_byo$
BEGIN
  IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'alethia_byo_0123456789ab') IS DISTINCT FROM 'alethia_byo_0123456789ab'::regrole::oid THEN
    RAISE EXCEPTION 'alethia byo-users: schema % is not owned by its user', 'alethia_byo_0123456789ab';
  END IF;
END
$alethia_byo$;
ALTER ROLE "alethia_byo_0123456789ab" IN DATABASE "app-db" SET search_path = "alethia_byo_0123456789ab";
-- revoke every undeclared per-binding user of this environment
DO $alethia_byo$
DECLARE
  r record;
  holder name;
BEGIN
  FOR r IN SELECT a.rolname FROM pg_roles a
    JOIN pg_shdescription d ON d.objoid = a.oid AND d.classoid = 'pg_authid'::regclass
    WHERE a.rolname ~ '^alethia_byo_[0-9a-f]{12}$'
      AND d.description = 'alethia-env:env-1'
      AND a.rolname <> ALL (ARRAY['alethia_byo_0123456789ab']::name[])
    ORDER BY a.rolname
  LOOP
    holder := r.rolname || '_r';
    EXECUTE format('ALTER ROLE %I NOLOGIN', r.rolname);
    PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = r.rolname;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = holder) THEN
      IF shobj_description((SELECT oid FROM pg_roles WHERE rolname = holder), 'pg_authid') IS DISTINCT FROM 'alethia-env:env-1' THEN
        RAISE EXCEPTION 'alethia byo-users: holder % is not tagged with this environment', holder;
      END IF;
    ELSE
      EXECUTE format('CREATE ROLE %I NOLOGIN', holder);
    END IF;
    EXECUTE format('COMMENT ON ROLE %I IS %L', holder, 'alethia-env:env-1');
    EXECUTE format('GRANT %I TO CURRENT_USER', holder);
    EXECUTE format('REASSIGN OWNED BY %I TO %I', r.rolname, holder);
    EXECUTE format('DROP OWNED BY %I', r.rolname);
    EXECUTE format('DROP ROLE %I', r.rolname);
  END LOOP;
END
$alethia_byo$;
\pset tuples_only on
\pset format unaligned
\o /dev/termination-log
SELECT a.rolname FROM pg_roles a
    JOIN pg_shdescription d ON d.objoid = a.oid AND d.classoid = 'pg_authid'::regclass
    WHERE a.rolname ~ '^alethia_byo_[0-9a-f]{12}$'
      AND d.description = 'alethia-env:env-1'
      AND a.rolcanlogin
      AND a.rolname = ANY (ARRAY['alethia_byo_0123456789ab']::name[])
    ORDER BY a.rolname;
\o
`

// TestByoUsers_ProvisionOrder: one user's block refuses a foreign role, tags it, sets the verifier,
// asserts no elevated attribute or membership, re-adopts from its holder BEFORE creating its schema
// (so a schema left with the holder comes back rather than being skipped), then asserts it owns that
// schema and sets its search_path.
func TestByoUsers_ProvisionOrder(t *testing.T) {
	got, _ := renderByoUsersSQL(oneUserInput())
	u := byoTestUser
	order := []string{
		"IS DISTINCT FROM 'alethia-env:env-1' THEN\n      RAISE EXCEPTION 'alethia byo-users: role % exists and is not tagged with this environment'",
		`CREATE ROLE "` + u + `" NOLOGIN;`,
		`COMMENT ON ROLE "` + u + `" IS 'alethia-env:env-1';`,
		`ALTER ROLE "` + u + `" WITH LOGIN CONNECTION LIMIT 20 PASSWORD 'SCRAM-SHA-256$4096:`,
		`GRANT "` + u + `" TO CURRENT_USER;`,
		"(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN\n    RAISE EXCEPTION",
		"SELECT FROM pg_auth_members WHERE member = '" + u + "'::regrole) THEN\n    RAISE EXCEPTION",
		"IS DISTINCT FROM 'alethia-env:env-1' THEN\n      RAISE EXCEPTION 'alethia byo-users: holder % is not tagged",
		`REASSIGN OWNED BY "` + u + `_r" TO "` + u + `";`,
		`DROP OWNED BY "` + u + `_r";`,
		`DROP ROLE "` + u + `_r";`,
		`GRANT CONNECT ON DATABASE "app-db" TO "` + u + `";`,
		`CREATE SCHEMA IF NOT EXISTS "` + u + `" AUTHORIZATION "` + u + `";`,
		"IS DISTINCT FROM '" + u + "'::regrole::oid THEN\n    RAISE EXCEPTION 'alethia byo-users: schema % is not owned by its user'",
		`ALTER ROLE "` + u + `" IN DATABASE "app-db" SET search_path = "` + u + `";`,
		"-- revoke every undeclared",
	}
	at := 0
	for _, s := range order {
		i := strings.Index(got[at:], s)
		if i < 0 {
			t.Fatalf("missing, or out of order after offset %d: %q", at, s)
		}
		at += i + len(s)
	}
}
