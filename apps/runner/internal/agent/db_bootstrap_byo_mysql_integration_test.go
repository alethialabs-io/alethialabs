// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build integration

package agent

import (
	"errors"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
)

// The real-MySQL half of the per-binding users tests. It applies the two rendered scripts exactly as
// the BYO users Job does — the provision script with `mysql -N -B` (no --force), then the sweep with
// `mysql -N -B --force` — over TLS, against the server named by ALETHIA_TEST_MYSQL_ADMIN_DSN, a
// mysql://user:password@host:port/database URI for an administrator. CI's `byo-users-mysql` job points
// it at an administrator holding the static privilege set an RDS master user holds (no SUPER, no
// SET_USER_ID, no CONNECTION_ADMIN), on MySQL 8.0 and 8.4, and on 8.0.20, the last release below the
// floor, where the only test that runs is the one asserting that refusal. ALETHIA_TEST_MYSQL_ROOT_DSN
// names the server's root, used only to set up what a managed administrator could not (a DEFINER
// object, partial_revokes, a dynamic privilege) and to clean up. Without the variables or the mysql
// client the tests skip, unless ALETHIA_TEST_MYSQL_REQUIRED=1, which turns the skip into a failure so
// CI cannot pass by not running. They create and remove only users and databases named alethia_byo_*
// with hashes no namer produces (all 'e' digits).
//
//	ALETHIA_TEST_MYSQL_ADMIN_DSN=mysql://… ALETHIA_TEST_MYSQL_ROOT_DSN=mysql://… \
//	  go test -tags integration -run ByoUsersMySQLServer ./internal/agent/

const (
	myUserA      = "alethia_byo_eeeeeeeeeee1" // env A, declared then revoked then re-adopted
	myUserB      = "alethia_byo_eeeeeeeeeee2" // env B — must survive env A's sweep
	myUntagged   = "alethia_byo_eeeeeeeeeee3" // prefixed but untagged — never a candidate, never adopted
	myUserC      = "alethia_byo_eeeeeeeeeee4" // env A, a droppable candidate next to a stuck one
	myPasswordA1 = "AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA1"
	myPasswordA2 = "AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA2"
	myPasswordB  = "BbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB1"
	myDecoyPass  = "DecoyDecoyDecoyDecoyDecoyDecoy12"
	// myLookalikeDB matches `alethia_byo_eeeeeeeeeee1` when '_' is read as a wildcard.
	myLookalikeDB = "alethiaxbyoxeeeeeeeeeee1"
)

// myConn is one mysql client connection's parameters.
type myConn struct {
	host, port, user, pass, db string
}

// parseMyDSN reads a mysql:// URI.
func parseMyDSN(t *testing.T, raw string) myConn {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "mysql" {
		t.Fatalf("%q is not a mysql:// URI", raw)
	}
	pass, _ := u.User.Password()
	port := u.Port()
	if port == "" {
		port = "3306"
	}
	return myConn{host: u.Hostname(), port: port, user: u.User.Username(), pass: pass, db: strings.TrimPrefix(u.Path, "/")}
}

// as returns the connection with another user, password and database.
func (c myConn) as(user, pass, db string) myConn {
	c.user, c.pass, c.db = user, pass, db
	return c
}

// command builds a mysql client invocation over TCP and TLS, the password in MYSQL_PWD as the Job
// passes it.
func (c myConn) command(force bool, extra ...string) *exec.Cmd {
	args := []string{"--protocol=TCP", "--host", c.host, "--port", c.port, "--user", c.user, "--ssl-mode=REQUIRED", "-N", "-B"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, extra...)
	if c.db != "" {
		args = append(args, c.db)
	}
	cmd := exec.Command("mysql", args...)
	cmd.Env = append(os.Environ(), "MYSQL_PWD="+c.pass)
	return cmd
}

// run feeds sql to the client and returns stdout, stderr and the error.
func (c myConn) run(sql string, force bool) (string, string, error) {
	cmd := c.command(force)
	cmd.Stdin = strings.NewReader(sql)
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

// myAdmin is the administrator the scripts run as, and root for setup.
type myAdmin struct {
	t           *testing.T
	admin, root myConn
	// sessions are the last run's `sessions-not-ended:<user>` entries, held apart from what apply
	// returns so the other tests read the result as before.
	sessions []string
	// mutateSweep, when set, rewrites the sweep script before it is applied (to make a step fail).
	mutateSweep func(string) string
}

// myEntryRe is every entry a result may carry, as strictly as the runner's parser
// (provisioner parseByoDBUsersResult) reads it: one unparseable line fails the whole run there.
var myEntryRe = regexp.MustCompile(`^(` + byoPendingPrefix + `|` + mysqlByoSessionsPrefix + `)?` + manifests.ByoDBUserPrefix + `[0-9a-f]{12}$`)

// newMyAdmin reads both DSNs or skips the test.
func newMyAdmin(t *testing.T) *myAdmin {
	t.Helper()
	skip := t.Skip
	if os.Getenv("ALETHIA_TEST_MYSQL_REQUIRED") == "1" {
		skip = t.Fatal
	}
	admin, root := os.Getenv("ALETHIA_TEST_MYSQL_ADMIN_DSN"), os.Getenv("ALETHIA_TEST_MYSQL_ROOT_DSN")
	if admin == "" || root == "" {
		skip("ALETHIA_TEST_MYSQL_ADMIN_DSN or ALETHIA_TEST_MYSQL_ROOT_DSN is unset")
	}
	if _, err := exec.LookPath("mysql"); err != nil {
		skip("the mysql client is not installed")
	}
	return &myAdmin{t: t, admin: parseMyDSN(t, admin), root: parseMyDSN(t, root)}
}

// query runs sql on c and fails the test on error.
func (a *myAdmin) query(c myConn, sql string) string {
	a.t.Helper()
	out, errOut, err := c.run(sql, false)
	if err != nil {
		a.t.Fatalf("%s: %v\n%s", sql, err, errOut)
	}
	return strings.TrimSpace(out)
}

// belowFloor reports whether the server is older than MySQL 8.0.21, by the server's own versioned
// comment, the same test the script makes.
func (a *myAdmin) belowFloor() bool {
	return a.query(a.root, "SELECT 0 /*!80021 + 1 */") != "1"
}

// requiresFloor skips a test on a server older than 8.0.21, which the script refuses.
func (a *myAdmin) requiresFloor() {
	a.t.Helper()
	if a.belowFloor() {
		a.t.Skip("per-binding users need MySQL 8.0.21 or newer; TestByoUsersMySQLServer_RefusesBelowFloor covers this server")
	}
}

// login reports whether user can connect with pass to db and run SELECT 1.
func (a *myAdmin) login(user, pass, db string) error {
	out, errOut, err := a.admin.as(user, pass, db).run("SELECT 1", false)
	if err != nil {
		return errors.New(err.Error() + ": " + errOut)
	}
	if strings.TrimSpace(out) != "1" {
		return errors.New("unexpected output " + out)
	}
	return nil
}

// apply renders the scripts for env and users, applies them as the Job does, and returns the result's
// entries.
func (a *myAdmin) apply(env string, users ...byoUser) []string {
	a.t.Helper()
	got, out, err := a.applyInput(byoUsersInput{EnvironmentID: env, Users: users})
	if err != nil {
		a.t.Fatalf("apply failed: %v\n%s", err, out)
	}
	return got
}

// applyInput is apply for a full input, returning the failure instead of failing the test: the
// entries (nil when the provision script failed, which writes no result), the clients' stderr, and
// the provision script's error. The sweep's own error is reported in stderr and not returned, as in
// the Job, where a candidate the sweep could not drop is a pending revocation, not a failure.
func (a *myAdmin) applyInput(in byoUsersInput) ([]string, string, error) {
	a.t.Helper()
	in.DBName = a.admin.db
	scripts, err := renderByoUsersMySQL(in)
	if err != nil {
		a.t.Fatal(err)
	}
	for _, u := range in.Users {
		if strings.Contains(scripts.Provision+scripts.Sweep, u.Password) {
			a.t.Fatal("password in a rendered script")
		}
	}
	result, errOut, err := a.admin.run(scripts.Provision, false)
	if err != nil {
		return nil, errOut, err
	}
	if scripts.Sweep != "" {
		sweep := scripts.Sweep
		if a.mutateSweep != nil {
			sweep = a.mutateSweep(sweep)
		}
		var sweepErr string
		result, sweepErr, _ = a.admin.run(sweep, true)
		errOut += sweepErr
	}
	// The first line is the header, `alethia-byo-users v1 count=<n>`, and exactly n entries follow.
	lines := strings.Split(strings.TrimSuffix(result, "\n"), "\n")
	if !strings.HasPrefix(lines[0], byoResultHeaderPrefix) {
		a.t.Fatalf("the result does not start with its header:\n%s\nstderr:\n%s", result, errOut)
	}
	entries := lines[1:]
	if want := strings.TrimPrefix(lines[0], byoResultHeaderPrefix); want != strconv.Itoa(len(entries)) {
		a.t.Fatalf("the header counts %s entries, the result has %d:\n%s", want, len(entries), result)
	}
	a.sessions = nil
	var out []string
	for _, e := range entries {
		if !myEntryRe.MatchString(e) {
			a.t.Fatalf("the result carries %q, which the runner's parser rejects (the whole run would fail):\n%s", e, result)
		}
		if strings.HasPrefix(e, mysqlByoSessionsPrefix) {
			a.sessions = append(a.sessions, strings.TrimPrefix(e, mysqlByoSessionsPrefix))
			continue
		}
		out = append(out, e)
	}
	return out, errOut, nil
}

// userCount is how many accounts named user exist on any host.
func (a *myAdmin) userCount(user string) string {
	return a.query(a.root, "SELECT COUNT(*) FROM mysql.user WHERE CAST(User AS BINARY) = '"+user+"'")
}

// cleanup removes every user and database the tests may have left. Databases first, so no DEFINER
// object holds a DROP USER back.
func (a *myAdmin) cleanup() {
	for _, u := range []string{myUserA, myUserB, myUntagged, myUserC} {
		_, _, _ = a.root.run("DROP DATABASE IF EXISTS `"+u+"`", false)
	}
	_, _, _ = a.root.run("DROP DATABASE IF EXISTS `"+myLookalikeDB+"`", false)
	_, _, _ = a.root.run("SET @n = CONCAT('"+myLookalike+"', CHAR(10)); SET @s = CONCAT('DROP USER IF EXISTS ''', @n, '''@''%'''); PREPARE s FROM @s; EXECUTE s;", false)
	for _, u := range []string{myUserA, myUserB, myUntagged, myUserC} {
		_, _, _ = a.root.run("DROP USER IF EXISTS '"+u+"'@'%'", false)
	}
}

// TestByoUsersMySQLServer_Lifecycle: create, re-run, env-scoped revoke that keeps the database, and
// re-adoption with a rotated password, against a real server.
func TestByoUsersMySQLServer_Lifecycle(t *testing.T) {
	a := newMyAdmin(t)
	a.requiresFloor()
	a.cleanup()
	t.Cleanup(a.cleanup)

	// Create: the user logs in with the stored password, works in its own database, and reaches
	// neither the environment's database nor a database its name matches only as a LIKE pattern.
	if got := a.apply("env-a", byoUser{myUserA, myPasswordA1}); strings.Join(got, ",") != myUserA {
		t.Fatalf("provisioned set = %v, want [%s]", got, myUserA)
	}
	asA := a.admin.as(myUserA, myPasswordA1, myUserA)
	if _, errOut, err := asA.run("CREATE TABLE kept (v text); INSERT INTO kept VALUES ('still here');", false); err != nil {
		t.Fatalf("user A cannot work in its database: %v\n%s", err, errOut)
	}
	if err := a.login(myUserA, myPasswordA1, a.admin.db); err == nil {
		t.Error("user A may use the environment's database")
	}
	if _, _, err := asA.run("CREATE DATABASE `"+myLookalikeDB+"`", false); err == nil {
		t.Errorf("user A may create %s: its database grant was read as a LIKE pattern", myLookalikeDB)
	}
	row := a.query(a.root, "SELECT CONCAT_WS('|', plugin, LEFT(authentication_string, 7), ssl_type, max_user_connections, account_locked) FROM mysql.user WHERE CAST(User AS BINARY) = '"+myUserA+"' AND Host = '%'")
	if row != "caching_sha2_password|$A$005$|ANY|20|N" {
		t.Errorf("user A's account = %q, want caching_sha2_password|$A$005$|ANY|20|N", row)
	}
	if got := a.query(a.root, "SELECT JSON_UNQUOTE(JSON_EXTRACT(ATTRIBUTE, '$.alethia_env')) FROM information_schema.USER_ATTRIBUTES WHERE USER = '"+myUserA+"'"); got != "env-a" {
		t.Errorf("user A's tag = %q, want env-a", got)
	}
	if got := a.query(a.root, "SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = '''"+myUserA+"''@''%''' AND PRIVILEGE_TYPE <> 'USAGE'"); got != "0" {
		t.Errorf("user A holds %s global privileges", got)
	}

	// Re-run: the same result, the data untouched.
	if got := a.apply("env-a", byoUser{myUserA, myPasswordA1}); strings.Join(got, ",") != myUserA {
		t.Fatalf("re-run provisioned set = %v", got)
	}
	if out, _, _ := asA.run("SELECT v FROM kept", false); strings.TrimSpace(out) != "still here" {
		t.Fatalf("after re-run, data = %q", out)
	}

	// Another environment's user, and an untagged prefixed user.
	if got := a.apply("env-b", byoUser{myUserB, myPasswordB}); strings.Join(got, ",") != myUserB {
		t.Fatalf("env B provisioned set = %v", got)
	}
	a.query(a.admin, "CREATE USER '"+myUntagged+"'@'%' IDENTIFIED BY '"+myDecoyPass+"'")

	// Revoke env A's undeclared users: A is dropped and its database KEPT; B and the untagged user
	// are untouched.
	if got := a.apply("env-a"); len(got) != 0 {
		t.Fatalf("revoke run provisioned %v", got)
	}
	if got := a.userCount(myUserA); got != "0" {
		t.Fatal("user A was not dropped")
	}
	// This administrator has no CONNECTION_ADMIN, so the run says it could not end A's sessions.
	if strings.Join(a.sessions, ",") != myUserA {
		t.Errorf("sessions-not-ended = %v, want [%s]", a.sessions, myUserA)
	}
	if got := a.query(a.root, "SELECT v FROM `"+myUserA+"`.kept"); got != "still here" {
		t.Errorf("the revoked user's database lost its data: %q", got)
	}
	if err := a.login(myUserB, myPasswordB, myUserB); err != nil {
		t.Errorf("env A's sweep touched env B's user: %v", err)
	}
	if err := a.login(myUntagged, myDecoyPass, ""); err != nil {
		t.Errorf("env A's sweep touched an untagged prefixed user: %v", err)
	}

	// Re-adopt with a rotated password: the same name, the same database, the data reachable.
	if got := a.apply("env-a", byoUser{myUserA, myPasswordA2}); strings.Join(got, ",") != myUserA {
		t.Fatalf("re-adopt provisioned set = %v", got)
	}
	if out, errOut, err := a.admin.as(myUserA, myPasswordA2, myUserA).run("SELECT v FROM kept", false); err != nil || strings.TrimSpace(out) != "still here" {
		t.Fatalf("re-adopted user cannot reach its data: %v\n%s%s", err, out, errOut)
	}
	if err := a.login(myUserA, myPasswordA1, myUserA); err == nil {
		t.Error("the old password still logs in after rotation")
	}
}

// TestByoUsersMySQLServer_RefusesForeignUser: a pre-existing user with a declared name that this
// environment did not tag fails the run before its password, grants or lock state change, and no
// result is written. MySQL account statements are not transactional, so a declared user sorted before
// it may already be provisioned; the runner counts none of them, because the Job failed.
func TestByoUsersMySQLServer_RefusesForeignUser(t *testing.T) {
	a := newMyAdmin(t)
	a.requiresFloor()
	a.cleanup()
	t.Cleanup(a.cleanup)
	a.query(a.admin, "CREATE USER '"+myUntagged+"'@'%' IDENTIFIED BY '"+myDecoyPass+"'")
	got, out, err := a.applyInput(byoUsersInput{EnvironmentID: "env-a", Users: []byoUser{{myUserA, myPasswordA1}, {myUntagged, myPasswordA1}}})
	if err == nil {
		t.Fatalf("the run adopted an untagged user: %v", got)
	}
	if !strings.Contains(out, myUntagged+" is not tagged with this environment") {
		t.Errorf("the refusal does not name the user and the cause:\n%s", out)
	}
	if err := a.login(myUntagged, myDecoyPass, ""); err != nil {
		t.Errorf("the refused user's password was changed: %v", err)
	}
	if got := a.query(a.root, "SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = '''"+myUntagged+"''@''%'''"); got != "0" {
		t.Error("the refused user was granted its database")
	}
}

// TestByoUsersMySQLServer_RevokeFailsSafe: a candidate named as the DEFINER of a stored object cannot be
// dropped by an administrator without SET_USER_ID (MySQL 8.0.22 and later). That must cost nothing
// but its own revocation:
//   - the run succeeds;
//   - a declared user next to it IS provisioned, IS in the result and can log in;
//   - a second, droppable candidate IS dropped in the same run;
//   - the stuck user is locked, cannot log in, and is reported as `revocation-pending:<user>`.
//
// Once the object is gone, the next run completes the revocation.
func TestByoUsersMySQLServer_RevokeFailsSafe(t *testing.T) {
	a := newMyAdmin(t)
	a.requiresFloor()
	a.cleanup()
	t.Cleanup(a.cleanup)
	a.apply("env-a", byoUser{myUserA, myPasswordA1}, byoUser{myUserC, myPasswordA1})
	a.query(a.root, "CREATE DEFINER = '"+myUserA+"'@'%' SQL SECURITY DEFINER VIEW `"+myUserA+"`.owned AS SELECT 1 AS one")

	got, out, err := a.applyErr("env-a", byoUser{myUserB, myPasswordB})
	if err != nil {
		t.Fatalf("a stuck revocation failed the run: %v\n%s", err, out)
	}
	if want := myUserB + "," + byoPendingPrefix + myUserA; strings.Join(got, ",") != want {
		t.Errorf("result = %v, want %s\n%s", got, want, out)
	}
	if !strings.Contains(out, myUserA) {
		t.Errorf("the client reported no error naming the stuck user:\n%s", out)
	}
	if err := a.login(myUserB, myPasswordB, myUserB); err != nil {
		t.Errorf("the declared user next to a stuck candidate cannot log in: %v", err)
	}
	if got := a.userCount(myUserC); got != "0" {
		t.Error("the droppable candidate was not dropped: one stuck candidate blocked another")
	}
	if got := a.query(a.root, "SELECT account_locked FROM mysql.user WHERE CAST(User AS BINARY) = '"+myUserA+"'"); got != "Y" {
		t.Fatalf("after a failed revocation the user's account_locked = %q; the lockout did not hold", got)
	}
	if err := a.login(myUserA, myPasswordA1, myUserA); err == nil {
		t.Fatal("a user whose revocation failed can still log in")
	}

	// The next run, with the object gone, completes it.
	a.query(a.root, "DROP VIEW `"+myUserA+"`.owned")
	if got := a.apply("env-a", byoUser{myUserB, myPasswordB}); strings.Join(got, ",") != myUserB {
		t.Errorf("retry result = %v, want [%s]", got, myUserB)
	}
	if got := a.userCount(myUserA); got != "0" {
		t.Error("the retry did not complete the revocation")
	}
}

// applyErr is applyInput for env and users.
func (a *myAdmin) applyErr(env string, users ...byoUser) ([]string, string, error) {
	a.t.Helper()
	return a.applyInput(byoUsersInput{EnvironmentID: env, Users: users})
}

// TestByoUsersMySQLServer_KillsSessions: an administrator holding CONNECTION_ADMIN ends a revoked user's
// open sessions before the drop. (Without it each KILL fails, is reported, and the drop still runs;
// the other tests run without it.)
func TestByoUsersMySQLServer_KillsSessions(t *testing.T) {
	a := newMyAdmin(t)
	a.requiresFloor()
	a.cleanup()
	t.Cleanup(a.cleanup)
	a.query(a.root, "GRANT CONNECTION_ADMIN ON *.* TO '"+a.admin.user+"'@'%'")
	t.Cleanup(func() { a.query(a.root, "REVOKE CONNECTION_ADMIN ON *.* FROM '"+a.admin.user+"'@'%'") })
	a.apply("env-a", byoUser{myUserC, myPasswordA1})

	session := a.admin.as(myUserC, myPasswordA1, myUserC).command(false, "-e", "SELECT SLEEP(120)")
	if err := session.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- session.Wait() }()
	deadline := time.Now().Add(20 * time.Second)
	for a.query(a.root, "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER = '"+myUserC+"'") == "0" {
		if time.Now().After(deadline) {
			t.Fatal("the user's session never appeared")
		}
		time.Sleep(200 * time.Millisecond)
	}

	if got := a.apply("env-a"); len(got) != 0 {
		t.Fatalf("revoke run result = %v", got)
	}
	if len(a.sessions) != 0 {
		t.Errorf("with PROCESS and CONNECTION_ADMIN the run still reports sessions not ended: %v", a.sessions)
	}
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		_ = session.Process.Kill()
		t.Fatal("the revoked user's session survived the sweep")
	}
	if got := a.userCount(myUserC); got != "0" {
		t.Error("the user was not dropped")
	}
}

// TestByoUsersMySQLServer_PartialRevokes: with partial_revokes ON the server reads '_' in a GRANT's database
// literally, so the grant is written unescaped and still covers the user's database, and only it.
func TestByoUsersMySQLServer_PartialRevokes(t *testing.T) {
	a := newMyAdmin(t)
	a.requiresFloor()
	a.cleanup()
	t.Cleanup(a.cleanup)
	a.query(a.root, "SET GLOBAL partial_revokes = ON")
	t.Cleanup(func() {
		a.cleanup()
		a.query(a.root, "SET GLOBAL partial_revokes = OFF")
	})
	if got := a.apply("env-a", byoUser{myUserA, myPasswordA1}); strings.Join(got, ",") != myUserA {
		t.Fatalf("provisioned set = %v", got)
	}
	if _, errOut, err := a.admin.as(myUserA, myPasswordA1, myUserA).run("CREATE TABLE t (v int)", false); err != nil {
		t.Fatalf("with partial_revokes ON the user cannot work in its database: %v\n%s", err, errOut)
	}
	if got := a.query(a.root, "SELECT DISTINCT TABLE_SCHEMA FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = '''"+myUserA+"''@''%'''"); got != myUserA {
		t.Errorf("grant database = %q, want %s literally", got, myUserA)
	}
}

// TestByoUsersMySQLServer_SkipRevoke: with an incomplete declared set the runner passes --skip-revoke. The
// run provisions what is declared, and an undeclared user of this environment stays unlocked.
func TestByoUsersMySQLServer_SkipRevoke(t *testing.T) {
	a := newMyAdmin(t)
	a.requiresFloor()
	a.cleanup()
	t.Cleanup(a.cleanup)
	a.apply("env-a", byoUser{myUserA, myPasswordA1})
	got, out, err := a.applyInput(byoUsersInput{EnvironmentID: "env-a", Users: []byoUser{{myUserB, myPasswordB}}, SkipRevoke: true})
	if err != nil {
		t.Fatalf("--skip-revoke run failed: %v\n%s", err, out)
	}
	if strings.Join(got, ",") != myUserB {
		t.Errorf("result = %v, want [%s]", got, myUserB)
	}
	if err := a.login(myUserA, myPasswordA1, myUserA); err != nil {
		t.Errorf("--skip-revoke locked out an undeclared user: %v", err)
	}
}

// TestByoUsersMySQLServer_RefusesBelowFloor: on a server older than MySQL 8.0.21 the run fails with the
// floor's reason before it changes anything: a prefixed user that exists is left unlocked, and no user
// is created.
func TestByoUsersMySQLServer_RefusesBelowFloor(t *testing.T) {
	a := newMyAdmin(t)
	if !a.belowFloor() {
		t.Skip("this server is MySQL 8.0.21 or newer")
	}
	a.cleanup()
	t.Cleanup(a.cleanup)
	a.query(a.root, "CREATE USER '"+myUserC+"'@'%' IDENTIFIED BY '"+myDecoyPass+"'")
	_, out, err := a.applyErr("env-a", byoUser{myUserA, myPasswordA1})
	if err == nil {
		t.Fatal("the run succeeded on a server older than 8.0.21")
	}
	if !strings.Contains(out, mysqlByoFloorReason) {
		t.Errorf("the refusal does not state the floor:\n%s", out)
	}
	if got := a.userCount(myUserA); got != "0" {
		t.Error("a user was provisioned below the floor")
	}
	if got := a.query(a.root, "SELECT account_locked FROM mysql.user WHERE CAST(User AS BINARY) = '"+myUserC+"'"); got != "N" {
		t.Error("the refusal ran after the lockout: nothing may change below the floor")
	}
}

// TestByoUsersMySQLServer_FailedCursorStepDropsNoOtherAccount (B1): under --force, a failed step
// leaves the session variables as they were. The first drop step is made to fail while the anonymous
// account ”@'%' exists; the drop cursor's initial value is ”, so a DROP built from the cursor would
// name exactly that account. It must survive, and the later steps still drop both candidates.
func TestByoUsersMySQLServer_FailedCursorStepDropsNoOtherAccount(t *testing.T) {
	a := newMyAdmin(t)
	a.requiresFloor()
	a.cleanup()
	t.Cleanup(a.cleanup)
	a.query(a.root, "CREATE USER ''@'%' IDENTIFIED BY '"+myDecoyPass+"'")
	t.Cleanup(func() { _, _, _ = a.root.run("DROP USER IF EXISTS ''@'%'", false) })
	a.apply("env-a", byoUser{myUserA, myPasswordA1}, byoUser{myUserC, myPasswordA1})

	failed := false
	a.mutateSweep = func(sweep string) string {
		i := strings.Index(sweep, "SELECT CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4), IFNULL(CONCAT('DROP USER '")
		if i < 0 {
			t.Fatal("fixture: no drop step to break")
		}
		end := strings.Index(sweep[i:], ";\n")
		failed = true
		return sweep[:i] + "SELECT alethia_byo_no_such_column INTO @alethia_byo_u, @alethia_byo_s" + sweep[i+end:]
	}
	t.Cleanup(func() { a.mutateSweep = nil })
	_, out, err := a.applyErr("env-a")
	if err != nil || !failed {
		t.Fatalf("the provision script failed: %v\n%s", err, out)
	}
	if !strings.Contains(out, "alethia_byo_no_such_column") {
		t.Fatalf("the broken step did not fail:\n%s", out)
	}
	if got := a.query(a.root, "SELECT COUNT(*) FROM mysql.user WHERE User = '' AND Host = '%'"); got != "1" {
		t.Fatal("a failed cursor step dropped the anonymous account")
	}
	if a.userCount(myUserA) != "0" || a.userCount(myUserC) != "0" {
		t.Error("the steps after the failed one did not drop the candidates")
	}
}

// TestByoUsersMySQLServer_RefusedProvisionedUserIsLocked: a user an earlier run unlocked, which now
// fails the least-privilege check (an administrator granted it something more), is left LOCKED by the
// failed run, and the next clean run unlocks it again.
func TestByoUsersMySQLServer_RefusedProvisionedUserIsLocked(t *testing.T) {
	a := newMyAdmin(t)
	a.requiresFloor()
	a.cleanup()
	t.Cleanup(a.cleanup)
	a.apply("env-a", byoUser{myUserA, myPasswordA1})
	if err := a.login(myUserA, myPasswordA1, myUserA); err != nil {
		t.Fatalf("fixture: A cannot log in: %v", err)
	}
	a.query(a.root, "GRANT SELECT ON `"+a.admin.db+"`.* TO '"+myUserA+"'@'%'")
	_, out, err := a.applyErr("env-a", byoUser{myUserA, myPasswordA1})
	if err == nil || !strings.Contains(out, myUserA+" holds a privilege beyond its own") {
		t.Fatalf("the run did not refuse the over-privileged user: %v\n%s", err, out)
	}
	if got := a.query(a.root, "SELECT account_locked FROM mysql.user WHERE CAST(User AS BINARY) = '"+myUserA+"'"); got != "Y" {
		t.Fatalf("a refused, previously provisioned user is left account_locked = %q", got)
	}
	if err := a.login(myUserA, myPasswordA1, myUserA); err == nil {
		t.Fatal("a refused, previously provisioned user can still log in")
	}
	a.query(a.root, "REVOKE SELECT ON `"+a.admin.db+"`.* FROM '"+myUserA+"'@'%'")
	if got := a.apply("env-a", byoUser{myUserA, myPasswordA1}); strings.Join(got, ",") != myUserA {
		t.Fatalf("after the grant is removed, result = %v", got)
	}
	if err := a.login(myUserA, myPasswordA1, myUserA); err != nil {
		t.Errorf("the clean run did not unlock the user: %v", err)
	}
}

// myLookalike is a tagged user named like a per-binding user plus a trailing newline. It is built
// with CHAR(10), so the statements read the same in every sql_mode.
var myLookalike = myUserA[:len(myUserA)-1] + "5"

// TestByoUsersMySQLServer_NewlineLookalikeIsNoCandidate: ICU's `$` matches before a final newline, so
// the lookalike matches the pattern alone. The length bound keeps it out of the candidates: it is not
// dropped, and it never reaches the result, where one line the runner cannot parse would fail every
// run (applyInput holds every entry to the runner's parser).
func TestByoUsersMySQLServer_NewlineLookalikeIsNoCandidate(t *testing.T) {
	a := newMyAdmin(t)
	a.requiresFloor()
	a.cleanup()
	t.Cleanup(a.cleanup)
	a.query(a.root, "SET @n = CONCAT('"+myLookalike+"', CHAR(10)); "+
		"SET @s = CONCAT('CREATE USER ''', @n, '''@''%'' IDENTIFIED BY ''"+myDecoyPass+"'' ATTRIBUTE ''{\"alethia_env\":\"env-a\"}'''); "+
		"PREPARE s FROM @s; EXECUTE s;")
	if got := a.query(a.root, "SELECT COUNT(*) FROM information_schema.USER_ATTRIBUTES WHERE REGEXP_LIKE(USER, '^alethia_byo_[0-9a-f]{12}$', 'c') "+
		"AND HEX(USER) = CONCAT(HEX('"+myLookalike+"'), '0A') AND JSON_UNQUOTE(JSON_EXTRACT(ATTRIBUTE, '$.alethia_env')) = 'env-a'"); got != "1" {
		t.Fatalf("fixture: the lookalike does not match the pattern alone (count %s), so this test proves nothing", got)
	}
	if got := a.apply("env-a", byoUser{myUserB, myPasswordB}); strings.Join(got, ",") != myUserB {
		t.Fatalf("result = %v, want [%s]", got, myUserB)
	}
	if got := a.query(a.root, "SELECT COUNT(*) FROM mysql.user WHERE HEX(User) = CONCAT(HEX('"+myLookalike+"'), '0A')"); got != "1" {
		t.Error("the newline lookalike was dropped as a candidate")
	}
}

// TestByoUsersMySQLServer_UserCannotRetagItself: the whole revocation scope rests on the tag, so a
// per-binding user must not be able to change its own ATTRIBUTE or COMMENT (both need CREATE USER).
func TestByoUsersMySQLServer_UserCannotRetagItself(t *testing.T) {
	a := newMyAdmin(t)
	a.requiresFloor()
	a.cleanup()
	t.Cleanup(a.cleanup)
	a.apply("env-a", byoUser{myUserA, myPasswordA1})
	asA := a.admin.as(myUserA, myPasswordA1, myUserA)
	for _, st := range []string{
		`ALTER USER CURRENT_USER() ATTRIBUTE '{"alethia_env": "env-b"}'`,
		`ALTER USER CURRENT_USER() COMMENT 'retagged'`,
		`ALTER USER '` + myUserA + `'@'%' ATTRIBUTE '{"alethia_env": "env-b"}'`,
	} {
		if _, _, err := asA.run(st, false); err == nil {
			t.Errorf("the user ran %s", st)
		}
	}
	if got := a.query(a.root, "SELECT JSON_UNQUOTE(JSON_EXTRACT(ATTRIBUTE, '$.alethia_env')) FROM information_schema.USER_ATTRIBUTES WHERE USER = '"+myUserA+"'"); got != "env-a" {
		t.Errorf("the user's tag is now %q", got)
	}
	if got := a.query(a.root, "SELECT JSON_CONTAINS_PATH(ATTRIBUTE, 'one', '$.comment') FROM information_schema.USER_ATTRIBUTES WHERE USER = '"+myUserA+"'"); got != "0" {
		t.Error("the user wrote a comment on itself")
	}
}

// TestByoUsersMySQLServer_SQLMode proves a pass ran under the sql_mode it claims: with
// ALETHIA_TEST_MYSQL_SQL_MODE set (CI's second pass sets NO_BACKSLASH_ESCAPES,ANSI_QUOTES globally and
// reruns every test), each listed mode must be active in the administrator's session.
func TestByoUsersMySQLServer_SQLMode(t *testing.T) {
	want := os.Getenv("ALETHIA_TEST_MYSQL_SQL_MODE")
	if want == "" {
		t.Skip("ALETHIA_TEST_MYSQL_SQL_MODE is unset")
	}
	a := newMyAdmin(t)
	got := "," + a.query(a.admin, "SELECT @@SESSION.sql_mode") + ","
	for _, m := range strings.Split(want, ",") {
		if !strings.Contains(got, ","+m+",") {
			t.Errorf("sql_mode %s lacks %s", got, m)
		}
	}
}
