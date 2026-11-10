// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build integration

package manifests

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The real-server half of the TLS verification tests (#6521). It runs the apply scripts the bootstrap
// and BYO users Jobs render, with the real mysql and psql clients, against a MySQL 8 and a Postgres 16
// server whose certificate a test CA signed for one host name. CI's `db-tls-verify` job
// (.github/workflows/ci.yml) creates that CA, a second unrelated CA, the servers, and an
// /etc/hosts entry pointing the host name at 127.0.0.1:
//
//	ALETHIA_TEST_DBTLS_CA         the CA that signed the servers' certificates (PEM file)
//	ALETHIA_TEST_DBTLS_OTHER_CA   an unrelated CA (PEM file)
//	ALETHIA_TEST_DBTLS_NAME       the host name the certificates carry; resolves to 127.0.0.1
//	ALETHIA_TEST_DBTLS_MYSQL_PWD  root's password on the MySQL server (127.0.0.1:3306)
//	ALETHIA_TEST_DBTLS_PG_PWD     postgres's password on the Postgres server (127.0.0.1:5432)
//
// Without them the tests skip, unless ALETHIA_TEST_DBTLS_REQUIRED=1, which makes the skip a failure
// so CI cannot pass by not running. What this proves is the MECHANICS each cloud relies on — that the
// rendered command verifies the CA, that the identity mode also checks the host name, that the CA-only
// mode accepts a certificate with no matching name, and that every refusal fails the script with the
// named reason. Which mode and CA set each cloud gets is pinned by the render tests and justified from
// the providers' documentation in db_tls.go; no managed server is contacted here.

// dbTLSEnv is the servers' parameters.
type dbTLSEnv struct {
	ca, otherCA, name, mysqlPwd, pgPwd string
}

// newDBTLSEnv reads the environment, or skips.
func newDBTLSEnv(t *testing.T) dbTLSEnv {
	t.Helper()
	skip := t.Skip
	if os.Getenv("ALETHIA_TEST_DBTLS_REQUIRED") == "1" {
		skip = t.Fatal
	}
	read := func(key string) string {
		path := os.Getenv(key)
		if path == "" {
			skip(key + " is unset")
		}
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		return string(b)
	}
	e := dbTLSEnv{ca: read("ALETHIA_TEST_DBTLS_CA"), otherCA: read("ALETHIA_TEST_DBTLS_OTHER_CA"),
		name: os.Getenv("ALETHIA_TEST_DBTLS_NAME"), mysqlPwd: os.Getenv("ALETHIA_TEST_DBTLS_MYSQL_PWD"),
		pgPwd: os.Getenv("ALETHIA_TEST_DBTLS_PG_PWD")}
	if e.name == "" || e.mysqlPwd == "" || e.pgPwd == "" {
		skip("ALETHIA_TEST_DBTLS_NAME, _MYSQL_PWD or _PG_PWD is unset")
	}
	return e
}

// clientDir is the directory holding a real client binary.
func clientDir(t *testing.T, name string) string {
	t.Helper()
	p, err := exec.LookPath(name)
	if err != nil {
		if os.Getenv("ALETHIA_TEST_DBTLS_REQUIRED") == "1" {
			t.Fatalf("%s is not installed", name)
		}
		t.Skipf("%s is not installed", name)
	}
	return filepath.Dir(p)
}

// dbTLSCase is one connection attempt: the host the client dials, the verification, the CA set the
// pod would mount, and whether the connection must succeed.
type dbTLSCase struct {
	name     string
	host     func(e dbTLSEnv) string
	identity bool
	ca       func(e dbTLSEnv) string
	ok       bool
}

var (
	byName = func(e dbTLSEnv) string { return e.name }
	byIP   = func(dbTLSEnv) string { return "127.0.0.1" }
	goodCA = func(e dbTLSEnv) string { return e.ca }
	badCA  = func(e dbTLSEnv) string { return e.otherCA }
)

// dbTLSCases: identity mode (AWS, Azure) passes only for the signed name under the signing CA; CA-only
// mode (GCP) passes by IP under the signing CA and refuses any other CA.
var dbTLSCases = []dbTLSCase{
	{"identity, signed name, signing CA", byName, true, goodCA, true},
	{"identity, address not in the certificate", byIP, true, goodCA, false},
	{"identity, unrelated CA", byName, true, badCA, false},
	{"CA only, by IP, signing CA", byIP, false, goodCA, true},
	{"CA only, unrelated CA", byIP, false, badCA, false},
}

// mutateToUnverified, when ALETHIA_TEST_DBTLS_MUTATE=unverified, rewrites a rendered script and env to
// the pre-#6521 modes (--ssl-mode=REQUIRED, sslmode=require). CI runs the tests once more that way and
// requires them to FAIL: the refusal cases must then connect, which proves these tests can tell a
// verified connection from an unverified one rather than passing on any outcome.
func mutateToUnverified(script string, env []string) (string, []string) {
	if os.Getenv("ALETHIA_TEST_DBTLS_MUTATE") != "unverified" {
		return script, env
	}
	for _, m := range []string{"--ssl-mode=VERIFY_IDENTITY", "--ssl-mode=VERIFY_CA"} {
		script = strings.ReplaceAll(script, m, "--ssl-mode=REQUIRED")
	}
	out := append([]string(nil), env...)
	for i, e := range out {
		if strings.HasPrefix(e, "PGSSLMODE=") {
			out[i] = "PGSSLMODE=require"
		}
	}
	return script, out
}

// assertDBTLSOutcome checks one run: success exits 0 without the TLS reason; a refusal exits
// non-zero with the reason in the log and as the termination message.
func assertDBTLSOutcome(t *testing.T, tc dbTLSCase, code int, stderr, msg string) {
	t.Helper()
	if tc.ok {
		if code != 0 || strings.Contains(stderr, "DB_TLS_VERIFY_FAILED") {
			t.Errorf("want a verified connection: exit %d\n%s", code, stderr)
		}
		return
	}
	// Logged so the run records the clients' real TLS error texts the reason matcher relies on.
	t.Logf("refusal, client stderr:\n%s", stderr)
	if code == 0 || !strings.Contains(stderr, "DB_TLS_VERIFY_FAILED") || !strings.HasPrefix(msg, "alethia: DB_TLS_VERIFY_FAILED: ") {
		t.Errorf("want a refusal with the named reason: exit %d, termination message %q\n%s", code, msg, stderr)
	}
}

// TestDBTLSServer_BootstrapMySQL runs the bootstrap Job's MySQL apply script.
func TestDBTLSServer_BootstrapMySQL(t *testing.T) {
	e := newDBTLSEnv(t)
	bin := clientDir(t, "mysql")
	for _, tc := range dbTLSCases {
		t.Run(tc.name, func(t *testing.T) {
			tls := dbTLS{Identity: tc.identity, CAPEM: tc.ca(e), Source: "the test CA"}
			c := mysqlContainer(tc.host(e), "mysql", "", "admin", false, tls)
			script, env := mutateToUnverified(c.Command[2], containerEnv(c, "BOOTSTRAP_DB_USER=root", "MYSQL_PWD="+e.mysqlPwd))
			code, stderr, msg := runRenderedScriptWith(t, script, bin, env, "SELECT 1;\n", tls.CAPEM)
			assertDBTLSOutcome(t, tc, code, stderr, msg)
		})
	}
}

// TestDBTLSServer_BootstrapPostgres runs the bootstrap Job's Postgres apply script.
func TestDBTLSServer_BootstrapPostgres(t *testing.T) {
	e := newDBTLSEnv(t)
	bin := clientDir(t, "psql")
	for _, tc := range dbTLSCases {
		t.Run(tc.name, func(t *testing.T) {
			tls := dbTLS{Identity: tc.identity, CAPEM: tc.ca(e), Source: "the test CA"}
			c := psqlContainer(tc.host(e), "postgres", "", "admin", false, tls)
			script, env := mutateToUnverified(c.Command[2], containerEnv(c, "PGUSER=postgres", "PGPASSWORD="+e.pgPwd))
			code, stderr, msg := runRenderedScriptWith(t, script, bin, env, "SELECT 1;\n", tls.CAPEM)
			assertDBTLSOutcome(t, tc, code, stderr, msg)
		})
	}
}

// TestDBTLSServer_ByoUsersMySQL runs the BYO users Job's MySQL script (provision and sweep). On
// success the result reaches the termination message; on a refusal the message is the reason.
func TestDBTLSServer_ByoUsersMySQL(t *testing.T) {
	e := newDBTLSEnv(t)
	bin := clientDir(t, "mysql")
	for _, tc := range dbTLSCases {
		t.Run(tc.name, func(t *testing.T) {
			tls := dbTLS{Identity: tc.identity, CAPEM: tc.ca(e), Source: "the test CA"}
			env := []string{"MYSQL_HOST=" + tc.host(e), "MYSQL_TCP_PORT=3306", "BYO_DB_NAME=mysql",
				dbTLSReasonEnv + "=" + tls.dbTLSFailureReason(), "BYO_DB_ADMIN_USER=root", "MYSQL_PWD=" + e.mysqlPwd}
			script, env := mutateToUnverified(byoDBUsersMySQLScript(false, false, tls.MySQLFlags()), env)
			code, stderr, msg := runRenderedScriptWith(t, script, bin, env, "SELECT 'alethia-byo-users v1 count=0';\n", tls.CAPEM)
			assertDBTLSOutcome(t, tc, code, stderr, msg)
			if tc.ok && msg != "alethia-byo-users v1 count=0\n" {
				t.Errorf("termination message %q, want the result", msg)
			}
		})
	}
}

// TestDBTLSServer_ByoUsersPostgres runs the BYO users Job's Postgres script.
func TestDBTLSServer_ByoUsersPostgres(t *testing.T) {
	e := newDBTLSEnv(t)
	bin := clientDir(t, "psql")
	for _, tc := range dbTLSCases {
		t.Run(tc.name, func(t *testing.T) {
			tls := dbTLS{Identity: tc.identity, CAPEM: tc.ca(e), Source: "the test CA"}
			env := []string{"PGHOST=" + tc.host(e), "PGPORT=5432", "PGDATABASE=postgres", "PGSSLMODE=" + tls.PGSSLMode(),
				"PGSSLROOTCERT=" + dbCAFile, "PGCONNECT_TIMEOUT=30", dbTLSReasonEnv + "=" + tls.dbTLSFailureReason(),
				"PGUSER=postgres", "PGPASSWORD=" + e.pgPwd}
			script, env := mutateToUnverified(byoDBUsersPGScript(false), env)
			code, stderr, msg := runRenderedScriptWith(t, script, bin, env, "SELECT 1;\n", tls.CAPEM)
			assertDBTLSOutcome(t, tc, code, stderr, msg)
		})
	}
}
