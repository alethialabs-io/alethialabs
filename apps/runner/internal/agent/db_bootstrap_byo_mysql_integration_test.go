// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build integration

package agent

import (
	"errors"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
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
}

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
		var sweepErr string
		result, sweepErr, _ = a.admin.run(scripts.Sweep, true)
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
	return entries, errOut, nil
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
