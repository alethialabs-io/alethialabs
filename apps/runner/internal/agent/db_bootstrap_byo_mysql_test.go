// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The unit half of the MySQL dialect's tests: the text of both scripts. What a real server does with
// that text is db_bootstrap_byo_mysql_integration_test.go's.

// readGolden reads a reviewed script from testdata.
func readGolden(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestByoUsersMySQL_Golden pins both scripts for one declared user, statement by statement. To review
// a deliberate change, render oneUserInput() and diff it against the files.
func TestByoUsersMySQL_Golden(t *testing.T) {
	got, err := renderByoUsersMySQL(oneUserInput())
	if err != nil {
		t.Fatal(err)
	}
	if want := readGolden(t, "byo_users_mysql_provision.golden.sql"); got.Provision != want {
		t.Errorf("provision script differs from the golden.\n--- got ---\n%s", got.Provision)
	}
	if want := readGolden(t, "byo_users_mysql_sweep.golden.sql"); got.Sweep != want {
		t.Errorf("sweep script differs from the golden.\n--- got ---\n%s", got.Sweep)
	}
}

// TestCachingSHA2_SHA256CryptVectors: the digest is Drepper's SHA-256-crypt. The first two vectors are
// from his specification; the third is `openssl passwd -5 -salt BBBBBBBBBBBBBBBB <password>`, with a
// password of the shape the store generates. A 20-byte salt (MySQL's length; glibc stops at 16) is
// proven by the real-engine test logging in with it.
func TestCachingSHA2_SHA256CryptVectors(t *testing.T) {
	for _, v := range []struct{ password, salt, want string }{
		{"Hello world!", "saltstring", "5B8vYYiY.CVt1RlTTf8KbXBH3hsxY/GNooZaBBGWEc5"},
		{"This is just a test", "toolongsaltstrin", "Un/5jzAHMgOGZ5.mWJpuVolil07guHPvOW8mGRcvxa5"},
		{"AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA1", "BBBBBBBBBBBBBBBB", "KZ3HfFOetGGoEoszl480YfycqwWCHwebxG9IvLCrMaD"},
	} {
		if got := sha256Crypt([]byte(v.password), []byte(v.salt), 5000); got != v.want {
			t.Errorf("sha256Crypt(%q, %q) = %s, want %s", v.password, v.salt, got, v.want)
		}
	}
}

// TestCachingSHA2Hash_Format: the stored string is `$A$005$` + a 20-character salt + a 43-character
// digest, 70 characters, carrying no byte a string literal would have to escape.
func TestCachingSHA2Hash_Format(t *testing.T) {
	salt, err := cachingSHA2Salt(fixedSalt(1))
	if err != nil {
		t.Fatal(err)
	}
	h, err := cachingSHA2Hash(byoTestPassword, salt)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^\$A\$005\$[A-Za-z0-9]{20}[./0-9A-Za-z]{43}$`).MatchString(h) || len(h) != 70 {
		t.Fatalf("hash %q is not a caching_sha2_password string", h)
	}
	if strings.Contains(h, byoTestPassword) {
		t.Fatal("the hash carries the password")
	}
	for _, bad := range [][]byte{[]byte("short"), bytes.Repeat([]byte("$"), 20), append(bytes.Repeat([]byte("a"), 19), 0)} {
		if _, err := cachingSHA2Hash(byoTestPassword, bad); err == nil {
			t.Errorf("salt %q accepted", bad)
		}
	}
}

// TestCachingSHA2Salt_Alphabet: a salt is drawn from letters and digits only, every byte past the
// alphabet's largest multiple is discarded (no modulo bias), and a short source is an error.
func TestCachingSHA2Salt_Alphabet(t *testing.T) {
	src := append(bytes.Repeat([]byte{255}, 10), bytes.Repeat([]byte{61}, 20)...)
	salt, err := cachingSHA2Salt(bytes.NewReader(src))
	if err != nil {
		t.Fatal(err)
	}
	if string(salt) != strings.Repeat("9", 20) {
		t.Fatalf("salt = %q, want the 248+ bytes discarded and 61 → '9'", salt)
	}
	if _, err := cachingSHA2Salt(bytes.NewReader([]byte{1, 2, 3})); err == nil {
		t.Fatal("a short random source produced a salt")
	}
}

// TestByoUsersMySQL_Rotation: a second render differs only in the hashes (a fresh salt), so a run
// re-sets every password from the store.
func TestByoUsersMySQL_Rotation(t *testing.T) {
	a, _ := renderByoUsersMySQL(oneUserInput())
	in := oneUserInput()
	in.Salt = fixedSalt(2)
	b, _ := renderByoUsersMySQL(in)
	if a.Provision == b.Provision {
		t.Fatal("a different salt rendered the same hash")
	}
	hash := regexp.MustCompile(`\$A\$005\$[A-Za-z0-9./]{63}`)
	if hash.ReplaceAllString(a.Provision, "H") != hash.ReplaceAllString(b.Provision, "H") {
		t.Fatal("two renders differ in more than the hashes")
	}
}

// TestByoUsersMySQL_PlaintextNowhere runs the CLI entry point with --engine mysql: the password is
// read from its environment variable and appears in neither argv nor either file, which are 0600, and
// nothing is printed. No statement sets a password any other way than as a hash.
func TestByoUsersMySQL_PlaintextNowhere(t *testing.T) {
	dir := t.TempDir()
	out, sweep := filepath.Join(dir, "init.sql"), filepath.Join(dir, "sweep.sql")
	args := []string{"--byo-users", "--engine", "mysql", "--env-id", "env-1", "--db", "app-db", "--users", byoTestUser, "--out", out, "--sweep-out", sweep}
	env := map[string]string{byoPasswordEnv(byoTestUser): byoTestPassword}
	stdout := captureStdout(t, func() {
		if err := runDBBootstrapByoUsers(context.Background(), args, mapEnv(env)); err != nil {
			t.Fatal(err)
		}
	})
	if stdout != "" {
		t.Fatalf("the entry point wrote to stdout:\n%s", stdout)
	}
	for _, p := range []string{out, sweep} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %v, want 0600", p, fi.Mode().Perm())
		}
		b, _ := os.ReadFile(p)
		if bytes.Contains(b, []byte(byoTestPassword)) {
			t.Fatalf("password in %s", p)
		}
		for _, bad := range []string{"IDENTIFIED BY", "SET PASSWORD", "PASSWORD("} {
			if bytes.Contains(b, []byte(bad)) {
				t.Errorf("%s sets a password with %q", p, bad)
			}
		}
	}
	b, _ := os.ReadFile(out)
	if bytes.Count(b, []byte("IDENTIFIED WITH caching_sha2_password AS '$A$005$")) != 2 {
		t.Fatalf("want the hash on CREATE and on ALTER:\n%s", b)
	}
}

// TestByoUsersMySQL_Quoting: every identifier is backtick-quoted and every account a quoted literal;
// a literal never carries a backslash (its meaning would depend on sql_mode), and the GRANT's database
// is written with its underscores escaped exactly when the server would read them as wildcards.
func TestByoUsersMySQL_Quoting(t *testing.T) {
	got, _ := renderByoUsersMySQL(oneUserInput())
	for _, want := range []string{
		"CREATE DATABASE IF NOT EXISTS `" + byoTestUser + "`;",
		"CREATE USER IF NOT EXISTS '" + byoTestUser + "'@'%' ",
		"ALTER USER '" + byoTestUser + "'@'%' ACCOUNT UNLOCK;",
		"IF(@@partial_revokes, '" + byoTestUser + "', REPLACE('" + byoTestUser + "', '_', CONCAT(CHAR(92 USING utf8mb4), '_')))",
		"'`.* TO ''" + byoTestUser + "''@''%''')",
	} {
		if !strings.Contains(got.Provision, want) {
			t.Errorf("provision script missing %q", want)
		}
	}
	if strings.Contains(got.Provision+got.Sweep, `\`) {
		t.Error("a script carries a backslash")
	}
	if q := mysqlQuoteIdent("a`b"); q != "`a``b`" {
		t.Errorf("mysqlQuoteIdent = %s", q)
	}
	if q, err := mysqlQuoteLiteral("it's"); err != nil || q != "'it''s'" {
		t.Errorf("mysqlQuoteLiteral = %s, %v", q, err)
	}
	for _, bad := range []string{`a\b`, "a\x00b"} {
		if _, err := mysqlQuoteLiteral(bad); err == nil {
			t.Errorf("literal %q accepted", bad)
		}
	}
}

// TestByoUsersMySQL_Refusals: a server-side refusal's reason is a column name, so every one must fit
// 64 characters (with the longest user name) and hold no backtick; inputs the script would be wrong
// with are refused before rendering, as on Postgres.
func TestByoUsersMySQL_Refusals(t *testing.T) {
	for _, r := range []string{mysqlByoFloorReason, byoTestUser + " is not tagged with this environment", byoTestUser + " holds a privilege beyond its own"} {
		if _, err := mysqlRefuseUnless("TRUE", r); err != nil {
			t.Errorf("reason %q: %v", r, err)
		}
	}
	for _, bad := range []string{strings.Repeat("a", 65), "a`b", "trailing "} {
		if _, err := mysqlRefuseUnless("TRUE", bad); err == nil {
			t.Errorf("reason %q accepted", bad)
		}
	}
	cases := map[string]func(*byoUsersInput){
		"duplicate user":  func(in *byoUsersInput) { in.Users = append(in.Users, in.Users[0]) },
		"bad user":        func(in *byoUsersInput) { in.Users[0].Name = "alethia_app" },
		"upper-case hex":  func(in *byoUsersInput) { in.Users[0].Name = "alethia_byo_0123456789AB" },
		"non-alnum":       func(in *byoUsersInput) { in.Users[0].Password = "Abcdefghijklmnop0123456789ABCD'E" },
		"short":           func(in *byoUsersInput) { in.Users[0].Password = "Abc123" },
		"no env id":       func(in *byoUsersInput) { in.EnvironmentID = "" },
		"quote in env id": func(in *byoUsersInput) { in.EnvironmentID = "env'1" },
		"no db":           func(in *byoUsersInput) { in.DBName = "" },
		"long db":         func(in *byoUsersInput) { in.DBName = strings.Repeat("a", 65) },
	}
	for name, mut := range cases {
		in := oneUserInput()
		mut(&in)
		if _, err := renderByoUsersMySQL(in); err == nil {
			t.Errorf("%s: accepted", name)
		} else if strings.Contains(err.Error(), byoTestPassword) {
			t.Errorf("%s: refusal quotes the password: %v", name, err)
		}
	}
}

// TestByoUsersMySQL_CLIEngineFlags: --engine mysql needs --sweep-out exactly when revocation runs,
// and --sweep-out is refused on Postgres, so a Job and the binary cannot disagree about which files
// exist.
func TestByoUsersMySQL_CLIEngineFlags(t *testing.T) {
	env := mapEnv(map[string]string{byoPasswordEnv(byoTestUser): byoTestPassword})
	dir := t.TempDir()
	base := []string{"--byo-users", "--env-id", "env-1", "--db", "app-db", "--users", byoTestUser, "--out", filepath.Join(dir, "init.sql")}
	sweep := []string{"--sweep-out", filepath.Join(dir, "sweep.sql")}
	with := func(extra ...[]string) []string {
		out := append([]string{}, base...)
		for _, e := range extra {
			out = append(out, e...)
		}
		return out
	}
	for name, args := range map[string][]string{
		"mysql without --sweep-out":       with([]string{"--engine", "mysql"}),
		"mysql --skip-revoke --sweep-out": with([]string{"--engine", "mysql", "--skip-revoke"}, sweep),
		"postgres --sweep-out":            with(sweep),
		"unknown engine":                  with([]string{"--engine", "mariadb"}, sweep),
	} {
		if err := runDBBootstrapByoUsers(context.Background(), args, env); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if err := runDBBootstrapByoUsers(context.Background(), with([]string{"--engine", "mysql", "--skip-revoke"}), env); err != nil {
		t.Fatalf("mysql --skip-revoke refused: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "sweep.sql")); err == nil {
		t.Fatal("--skip-revoke wrote a sweep script")
	}
}

// TestByoUsersMySQL_CandidateScope: the revocation candidates are users on host '%' matching the
// anchored pattern case-sensitively, tagged with THIS environment, and not declared. With nothing
// declared there is no exclusion list (and no empty `IN ()`).
func TestByoUsersMySQL_CandidateScope(t *testing.T) {
	got := mysqlByoCandidatesSQL("env-1", []byoUser{{Name: byoTestUser}})
	for _, want := range []string{
		"REGEXP_LIKE(a.USER, '^alethia_byo_[0-9a-f]{12}$', 'c') AND a.HOST = '%'",
		"JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$.alethia_env')) = 'env-1'",
		"CAST(a.USER AS BINARY) NOT IN ('" + byoTestUser + "')",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("candidates missing %q:\n%s", want, got)
		}
	}
	in := oneUserInput()
	in.Users = nil
	empty, err := renderByoUsersMySQL(in)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(empty.Provision+empty.Sweep, "IN ()") || strings.Contains(empty.Provision+empty.Sweep, "NOT IN") {
		t.Error("an empty declared set renders an exclusion list")
	}
	if strings.Contains(empty.Provision, "CREATE USER") {
		t.Error("an empty declared set provisions a user")
	}
	if !strings.Contains(empty.Provision, "AND FALSE") {
		t.Error("an empty declared set's result must select no user")
	}
}

// TestByoUsersMySQL_Phases: the floor comes before anything that changes state; the lockout before
// any user; within a user, its CREATE (locked) before the tag check, the tag check before the
// password is set, and the UNLOCK after every check; the result is the last statement. The drops come
// after the kills, and both scripts select rows only in their result.
func TestByoUsersMySQL_Phases(t *testing.T) {
	got, _ := renderByoUsersMySQL(oneUserInput())
	p := got.Provision
	order := []string{
		"/*!80021 + 1 */",
		"'SELECT `" + mysqlByoFloorReason + "`'",
		"' ACCOUNT LOCK'",
		"CREATE USER IF NOT EXISTS",
		"is not tagged with this environment`'",
		"ALTER USER '" + byoTestUser + "'@'%' IDENTIFIED WITH",
		"CREATE DATABASE IF NOT EXISTS",
		"'GRANT " + mysqlAppPrivileges,
		"holds a privilege beyond its own`'",
		"ACCOUNT UNLOCK;",
		"CONCAT('alethia-byo-users v1 count='",
	}
	last := -1
	for _, s := range order {
		i := strings.Index(p, s)
		if i < 0 || i < last {
			t.Fatalf("%q missing or out of order (at %d, previous at %d)", s, i, last)
		}
		last = i
	}
	if !strings.Contains(p, "IDENTIFIED WITH caching_sha2_password AS '$A$005$") || !strings.Contains(p, "ACCOUNT LOCK ATTRIBUTE '{\"alethia_env\":\"env-1\"}';") {
		t.Error("the user is not created locked and tagged")
	}
	s := got.Sweep
	if k, d := strings.Index(s, "CONCAT('KILL '"), strings.Index(s, "CONCAT('DROP USER '"); k < 0 || d < k {
		t.Error("the drops do not follow the kills")
	}
	if n := strings.Count(s, "CONCAT('KILL '"); n != mysqlByoMaxKills {
		t.Errorf("%d kill steps, want %d", n, mysqlByoMaxKills)
	}
	if n := strings.Count(s, "CONCAT('DROP USER '"); n != mysqlByoMaxDrops {
		t.Errorf("%d drop steps, want %d", n, mysqlByoMaxDrops)
	}
	if !strings.Contains(s, "CONCAT('revocation-pending:', c.USER)") {
		t.Error("the sweep's result lists no pending revocation")
	}
	topSelect := regexp.MustCompile(`(?m)^SELECT `)
	for name, script := range map[string]string{"provision": p, "sweep": s} {
		if n := len(topSelect.FindAllString(script, -1)); n != 1 {
			t.Errorf("%s script has %d top-level SELECTs, want only its result", name, n)
		}
		if !strings.HasPrefix(script[strings.LastIndex(script, "\nSELECT ")+1:], "SELECT s.line FROM (") {
			t.Errorf("%s script does not end with its result", name)
		}
	}
	if strings.Contains(p, "DROP USER") || strings.Contains(p, "KILL") {
		t.Error("the provision script (applied without --force) drops or kills")
	}
}

// TestByoUsersMySQL_SkipRevoke: with an incomplete declared set, no lockout, no sweep script and no
// pending list are rendered; the declared users are still provisioned.
func TestByoUsersMySQL_SkipRevoke(t *testing.T) {
	in := oneUserInput()
	in.SkipRevoke = true
	got, err := renderByoUsersMySQL(in)
	if err != nil {
		t.Fatal(err)
	}
	if got.Sweep != "" {
		t.Fatal("--skip-revoke rendered a sweep script")
	}
	for _, bad := range []string{"' ACCOUNT LOCK'", "CAST(a.USER AS BINARY) NOT IN", byoPendingPrefix, "DROP USER", "KILL"} {
		if strings.Contains(got.Provision, bad) {
			t.Errorf("--skip-revoke still renders %q", bad)
		}
	}
	for _, want := range []string{mysqlByoFloorReason, "CREATE USER IF NOT EXISTS '" + byoTestUser + "'@'%'", "ACCOUNT UNLOCK;", byoResultHeaderPrefix} {
		if !strings.Contains(got.Provision, want) {
			t.Errorf("--skip-revoke dropped %q", want)
		}
	}
}

// TestByoUsersMySQL_LeastPrivilege: the only grant is the keyless lane's DDL+DML set on the user's own
// database — never *.*, never GRANT OPTION, never a role, never a privilege on another database.
func TestByoUsersMySQL_LeastPrivilege(t *testing.T) {
	got, _ := renderByoUsersMySQL(oneUserInput())
	all := got.Provision + got.Sweep
	if n := strings.Count(all, "'GRANT "); n != 1 {
		t.Errorf("%d GRANT statements, want 1", n)
	}
	for _, bad := range []string{"*.*", "GRANT OPTION", "WITH ADMIN", "SUPER", "GRANT ALL", "DEFAULT ROLE", "SET ROLE", "ON `app-db`"} {
		if strings.Contains(all, bad) {
			t.Errorf("the scripts contain %q", bad)
		}
	}
	if mysqlAppPrivileges != "SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES" {
		t.Errorf("the privilege set changed: %s", mysqlAppPrivileges)
	}
}
