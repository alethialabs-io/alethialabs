// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// testGCPServerCA stands in for a Cloud SQL instance's server CA (the cloud_sql_server_ca_cert
// output): a self-signed P-256 CA, valid for a century, used only by tests.
const testGCPServerCA = `-----BEGIN CERTIFICATE-----
MIIB6DCCAY2gAwIBAgIUMMlIrMH+z0ynT4cc9zUoBm+67s0wCgYIKoZIzj0EAwIw
SDEjMCEGA1UEAwwaR29vZ2xlIENsb3VkIFNRTCBTZXJ2ZXIgQ0ExFDASBgNVBAoM
C0dvb2dsZSwgSW5jMQswCQYDVQQGEwJVUzAgFw0yNjExMTAxODA2MjFaGA8yMTI2
MTAxNzE4MDYyMVowSDEjMCEGA1UEAwwaR29vZ2xlIENsb3VkIFNRTCBTZXJ2ZXIg
Q0ExFDASBgNVBAoMC0dvb2dsZSwgSW5jMQswCQYDVQQGEwJVUzBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABIL0IoWSyUpjn9CKLac6aDy6onQav8hyvKVtpWuB1GNK
Aajf0oM7q6ZpdWCcOLBhNW5cpFA8qoiY5kMmEBeSwvGjUzBRMB0GA1UdDgQWBBRr
iQJcML026q0rpomfDJjPR2npGDAfBgNVHSMEGDAWgBRriQJcML026q0rpomfDJjP
R2npGDAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQDo/JWJIdfq
4kVbX9Ugp99R9mCjSZkJmlp+dc6vGN5dawIhAP+59ESCoOA4xjbyV+DjTsY499Eh
tkDvuMhjlvbDtS5V
-----END CERTIFICATE-----
`

// dbCASources is dbca/SOURCES.json.
type dbCASources struct {
	Bundles []struct {
		File         string `json:"file"`
		Doc          string `json:"doc"`
		SHA256       string `json:"sha256"`
		Certificates int    `json:"certificates"`
		Sources      []struct {
			URL    string `json:"url"`
			Format string `json:"format"`
			SHA256 string `json:"sha256"`
		} `json:"sources"`
	} `json:"bundles"`
}

// readDBCASources parses the pins.
func readDBCASources(t *testing.T) dbCASources {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("dbca", "SOURCES.json"))
	if err != nil {
		t.Fatal(err)
	}
	var s dbCASources
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("SOURCES.json: %v", err)
	}
	return s
}

// bundleSubjects returns the subject CN of every certificate in a PEM bundle, failing on any block
// that is not a parseable certificate.
func bundleSubjects(t *testing.T, bundle string) []string {
	t.Helper()
	var cns []string
	rest := []byte(bundle)
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil || block.Type != "CERTIFICATE" {
			t.Fatalf("block %q does not parse: %v", block.Type, err)
		}
		cns = append(cns, cert.Subject.CommonName)
	}
	if strings.TrimSpace(string(rest)) != "" {
		t.Fatalf("trailing non-PEM text in bundle")
	}
	return cns
}

// TestDBCABundles_MatchTheirPins: every checked-in bundle is byte-for-byte the file SOURCES.json pins
// (its sha256 and certificate count), every pin names an https source with a sha256 and a known
// format, the directory holds no bundle without a pin, and the embedded copies are those files.
func TestDBCABundles_MatchTheirPins(t *testing.T) {
	src := readDBCASources(t)
	if len(src.Bundles) == 0 {
		t.Fatal("SOURCES.json pins no bundle")
	}
	pinned := map[string]bool{"SOURCES.json": true}
	for _, b := range src.Bundles {
		pinned[b.File] = true
		raw, err := os.ReadFile(filepath.Join("dbca", b.File))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(raw)
		if got := hex.EncodeToString(sum[:]); got != b.SHA256 {
			t.Errorf("%s: sha256 %s, pinned %s — rebuild it only with scripts/db-ca-bundles.sh update", b.File, got, b.SHA256)
		}
		if n := len(bundleSubjects(t, string(raw))); n != b.Certificates || n == 0 {
			t.Errorf("%s: %d certificates, pinned %d", b.File, n, b.Certificates)
		}
		if err := checkCAPEM(string(raw)); err != nil {
			t.Errorf("%s: %v", b.File, err)
		}
		if len(b.Sources) == 0 || !strings.HasPrefix(b.Doc, "https://") {
			t.Errorf("%s: no sources or no documentation link", b.File)
		}
		for _, s := range b.Sources {
			if !strings.HasPrefix(s.URL, "https://") || len(s.SHA256) != 64 || (s.Format != "pem" && s.Format != "der") {
				t.Errorf("%s: source %+v", b.File, s)
			}
		}
	}
	entries, err := os.ReadDir("dbca")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if !pinned[e.Name()] {
			t.Errorf("dbca/%s has no pin in SOURCES.json", e.Name())
		}
	}
	for file, embedded := range map[string]string{"aws-rds-global-bundle.crt": awsRDSCABundle, "azure-db-roots.crt": azureDBCABundle} {
		raw, _ := os.ReadFile(filepath.Join("dbca", file))
		if string(raw) != embedded || !pinned[file] {
			t.Errorf("the embedded %s is not the pinned file", file)
		}
	}
}

// TestDBCABundles_CarryTheDocumentedRoots: the Azure set is exactly the three roots Microsoft lists for
// the root rotation, and the AWS set carries all three RDS CA families in the Regions spot-checked.
func TestDBCABundles_CarryTheDocumentedRoots(t *testing.T) {
	azure := bundleSubjects(t, azureDBCABundle)
	sort.Strings(azure)
	if want := []string{"DigiCert Global Root CA", "DigiCert Global Root G2", "Microsoft RSA Root Certificate Authority 2017"}; strings.Join(azure, "|") != strings.Join(want, "|") {
		t.Errorf("Azure roots %v, want %v", azure, want)
	}
	have := map[string]bool{}
	for _, cn := range bundleSubjects(t, awsRDSCABundle) {
		have[cn] = true
	}
	for _, region := range []string{"us-east-1", "eu-central-1", "eu-west-1", "ap-southeast-2"} {
		for _, family := range []string{"RSA2048 G1", "RSA4096 G1", "ECC384 G1"} {
			if cn := "Amazon RDS " + region + " Root CA " + family; !have[cn] {
				t.Errorf("the AWS bundle lacks %q", cn)
			}
		}
	}
}

// TestDBTLSFor_PerCloud pins each cloud's mode and CA set: AWS and Azure check the host name
// (VERIFY_IDENTITY / verify-full) against the checked-in bundle; GCP checks the CA only
// (VERIFY_CA / verify-ca) against the instance's own server CA, from its tofu output.
func TestDBTLSFor_PerCloud(t *testing.T) {
	for _, tc := range []struct {
		provider, mysql, pg, ca string
		outputs                 map[string]string
	}{
		{"aws", "--ssl-mode=VERIFY_IDENTITY --ssl-ca=/etc/alethia/db-ca/ca.pem", "verify-full", awsRDSCABundle, nil},
		{"azure", "--ssl-mode=VERIFY_IDENTITY --ssl-ca=/etc/alethia/db-ca/ca.pem", "verify-full", azureDBCABundle, nil},
		{"gcp", "--ssl-mode=VERIFY_CA --ssl-ca=/etc/alethia/db-ca/ca.pem", "verify-ca", testGCPServerCA,
			map[string]string{"cloud_sql_server_ca_cert": testGCPServerCA}},
		{"gcp", "--ssl-mode=VERIFY_CA --ssl-ca=/etc/alethia/db-ca/ca.pem", "verify-ca", testGCPServerCA,
			map[string]string{"cloud_sql_server_ca_cert": testGCPServerCA, "cloud_sql_server_ca_mode": "GOOGLE_MANAGED_INTERNAL_CA"}},
	} {
		tls, err := dbTLSFor(tc.provider, tc.outputs)
		if err != nil {
			t.Fatalf("%s: %v", tc.provider, err)
		}
		if tls.MySQLFlags() != tc.mysql || tls.PGSSLMode() != tc.pg || tls.CAPEM != tc.ca {
			t.Errorf("%s: mysql %q, pg %q, CA from the right source = %v", tc.provider, tls.MySQLFlags(), tls.PGSSLMode(), tls.CAPEM == tc.ca)
		}
		if r := tls.dbTLSFailureReason(); !strings.Contains(r, "DB_TLS_VERIFY_FAILED") || !strings.Contains(r, "never retries without verification") {
			t.Errorf("%s: reason %q", tc.provider, r)
		}
	}
}

// TestDBTLSFor_FailsClosed: a GCP instance without a usable server CA, or with a CA mode in which the
// CA alone does not identify the instance, and a provider with no verification defined are errors —
// never a weaker mode.
func TestDBTLSFor_FailsClosed(t *testing.T) {
	for name, tc := range map[string]struct {
		provider string
		outputs  map[string]string
	}{
		"gcp without the CA output":           {"gcp", map[string]string{}},
		"gcp with a blank CA":                 {"gcp", map[string]string{"cloud_sql_server_ca_cert": "  \n"}},
		"gcp with text, not PEM":              {"gcp", map[string]string{"cloud_sql_server_ca_cert": "not a certificate"}},
		"gcp with a key block":                {"gcp", map[string]string{"cloud_sql_server_ca_cert": "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"}},
		"gcp with a cert under another label": {"gcp", map[string]string{"cloud_sql_server_ca_cert": strings.ReplaceAll(testGCPServerCA, " CERTIFICATE-----", " X509 CRL-----")}},
		"gcp with a corrupt cert":             {"gcp", map[string]string{"cloud_sql_server_ca_cert": "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"}},
		"gcp with trailing text":              {"gcp", map[string]string{"cloud_sql_server_ca_cert": testGCPServerCA + "junk"}},
		"gcp with a shared CA":                {"gcp", map[string]string{"cloud_sql_server_ca_cert": testGCPServerCA, "cloud_sql_server_ca_mode": "GOOGLE_MANAGED_CAS_CA"}},
		"gcp with a customer CA":              {"gcp", map[string]string{"cloud_sql_server_ca_cert": testGCPServerCA, "cloud_sql_server_ca_mode": "CUSTOMER_MANAGED_CAS_CA"}},
		"alibaba, no bootstrap path":          {"alibaba", nil},
		"no provider":                         {"", nil},
	} {
		if tls, err := dbTLSFor(tc.provider, tc.outputs); err == nil {
			t.Errorf("%s: resolved %+v", name, tls)
		}
	}
}

// fakeClient installs an executable named name in a fresh PATH directory. It records its argv and
// the TLS env it saw into <dir>/argv, prints stdout, prints stderr and exits with code.
func fakeClient(t *testing.T, name, stdout, stderr string, code int) string {
	t.Helper()
	dir := t.TempDir()
	for f, body := range map[string]string{"out": stdout, "err": stderr} {
		if err := os.WriteFile(filepath.Join(dir, f), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	script := "#!/bin/sh\n" +
		`printf '%s\n' "$*" > "` + dir + `/argv"` + "\n" +
		`printf 'PGSSLMODE=%s PGSSLROOTCERT=%s\n' "${PGSSLMODE:-}" "${PGSSLROOTCERT:-}" >> "` + dir + `/argv"` + "\n" +
		"cat > /dev/null\n" +
		`cat "` + dir + `/out"` + "\n" +
		`cat "` + dir + `/err" >&2` + "\n" +
		fmt.Sprintf("exit %d\n", code)
	if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// runRenderedScript runs a rendered apply-container script with its absolute paths moved into a
// temp directory (the SQL files, the token, the result dir and the termination message), the fake
// client first on PATH, and env. It returns the exit code, stderr and the termination message.
func runRenderedScript(t *testing.T, script, binDir string, env []string) (int, string, string) {
	t.Helper()
	return runRenderedScriptWith(t, script, binDir, env, "x\n", "")
}

// runRenderedScriptWith is runRenderedScript with the SQL both script files hold and, when caPEM is
// set, the mounted CA file moved into the temp directory too (in the script and in env values).
func runRenderedScriptWith(t *testing.T, script, binDir string, env []string, sql, caPEM string) (int, string, string) {
	t.Helper()
	root := t.TempDir()
	for _, d := range []string{"sql", "db-admin-token", "byo-result"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{"sql/init.sql": sql, "sql/sweep.sql": sql, "db-admin-token/token": "x\n"}
	if caPEM != "" {
		files["ca.pem"] = caPEM
	}
	for f, body := range files {
		if err := os.WriteFile(filepath.Join(root, f), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	term := filepath.Join(root, "termination-log")
	moves := [][2]string{
		{"/dev/termination-log", term},
		{"/sql/", root + "/sql/"},
		{"/db-admin-token/", root + "/db-admin-token/"},
		{"/byo-result/", root + "/byo-result/"},
	}
	if caPEM != "" {
		moves = append(moves, [2]string{dbCAFile, root + "/ca.pem"})
	}
	moved := append([]string(nil), env...)
	for _, p := range moves {
		script = strings.ReplaceAll(script, p[0], p[1])
		for i := range moved {
			moved[i] = strings.ReplaceAll(moved[i], p[0], p[1])
		}
	}
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.Env = append([]string{"PATH=" + binDir + ":/usr/bin:/bin"}, moved...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	code := 0
	if err := cmd.Run(); err != nil {
		ee, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatalf("run: %v", err)
		}
		code = ee.ExitCode()
	}
	msg, _ := os.ReadFile(term)
	return code, stderr.String(), string(msg)
}

// containerEnv flattens a bootstrap container's plain env values, plus extra, into KEY=value pairs.
func containerEnv(c bootstrapContainer, extra ...string) []string {
	var out []string
	for _, e := range c.Env {
		if e.SecretName == "" {
			out = append(out, e.Name+"="+e.Value)
		}
	}
	return append(out, extra...)
}

// The client errors the real clients print, as the integration test (db_tls_integration_test.go)
// observes them on mysql 8 and psql 16.
const (
	mysqlTLSError = "ERROR 2026 (HY000): SSL connection error: error:0A000086:SSL routines::certificate verify failed"
	psqlTLSError  = `psql: error: connection to server at "db" (10.0.0.5), port 5432 failed: server certificate for "x" does not match host name "db"`
	authError     = "ERROR 1045 (28000): Access denied for user 'admin'"
)

// nonTLSErrors are failures that are not a TLS verification failure but mention SSL, TLS or a
// certificate, so a matcher on those words alone would give them the TLS reason.
var nonTLSErrors = []string{
	authError,
	"ERROR 3159 (HY000): Connections using insecure transport are prohibited while --require_secure_transport=ON.",
	`psql:/sql/init.sql:3: ERROR:  role "tls_certificate_reader" does not exist`,
	"ERROR 1064 (42000): You have an error in your SQL syntax near 'SSL certificate' at line 1",
}

// TestDBTLS_BootstrapScriptsNameATLSFailure runs each rendered bootstrap apply script with a fake
// client. A TLS failure exits non-zero with the named reason in the log and the termination message;
// a failure of another kind still exits non-zero, without the TLS reason; success exits 0 with the
// client's output intact. Every client is handed the verification flags or env of its cloud.
func TestDBTLS_BootstrapScriptsNameATLSFailure(t *testing.T) {
	identity := dbTLS{Identity: true, CAPEM: testGCPServerCA, Source: "a test CA"}
	caOnly := dbTLS{CAPEM: testGCPServerCA, Source: "a test CA"}
	for _, tc := range []struct {
		name, client, tlsErr, wantArg string
		c                             bootstrapContainer
	}{
		{"mysql password, identity", "mysql", mysqlTLSError, "--ssl-mode=VERIFY_IDENTITY --ssl-ca=/etc/alethia/db-ca/ca.pem",
			mysqlContainer("db", "app", "", "admin", false, identity)},
		{"mysql token, identity", "mysql", mysqlTLSError, "--ssl-mode=VERIFY_IDENTITY --ssl-ca=/etc/alethia/db-ca/ca.pem --enable-cleartext-plugin",
			mysqlContainer("db", "app", "acme-admin", "", true, identity)},
		{"mysql password, CA only", "mysql", mysqlTLSError, "--ssl-mode=VERIFY_CA --ssl-ca=/etc/alethia/db-ca/ca.pem",
			mysqlContainer("10.0.0.5", "app", "", "admin", false, caOnly)},
		{"psql password, identity", "psql", psqlTLSError, "PGSSLMODE=verify-full PGSSLROOTCERT=/etc/alethia/db-ca/ca.pem",
			psqlContainer("db", "app", "", "admin", false, identity)},
		{"psql token, identity", "psql", psqlTLSError, "PGSSLMODE=verify-full PGSSLROOTCERT=/etc/alethia/db-ca/ca.pem",
			psqlContainer("db", "app", "acme-admin", "", true, identity)},
		{"psql password, CA only", "psql", psqlTLSError, "PGSSLMODE=verify-ca PGSSLROOTCERT=/etc/alethia/db-ca/ca.pem",
			psqlContainer("10.0.0.5", "app", "", "admin", false, caOnly)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if len(tc.c.Command) != 3 || tc.c.Command[0] != "/bin/sh" {
				t.Fatalf("command %v", tc.c.Command)
			}
			script := tc.c.Command[2]
			env := containerEnv(tc.c, "BOOTSTRAP_DB_USER=admin", "MYSQL_PWD=pw", "PGUSER=admin", "PGPASSWORD=pw")
			reason := ""
			for _, e := range tc.c.Env {
				if e.Name == dbTLSReasonEnv {
					reason = e.Value
				}
			}
			if !strings.Contains(reason, "DB_TLS_VERIFY_FAILED") {
				t.Fatalf("no reason env: %v", tc.c.Env)
			}

			bin := fakeClient(t, tc.client, "", tc.tlsErr, 1)
			code, stderr, msg := runRenderedScript(t, script, bin, env)
			argv, _ := os.ReadFile(filepath.Join(bin, "argv"))
			if code == 0 || !strings.Contains(stderr, tc.tlsErr) || !strings.Contains(stderr, reason) || strings.TrimSpace(msg) != reason {
				t.Errorf("TLS failure: exit %d, termination message %q, stderr:\n%s", code, msg, stderr)
			}
			if !strings.Contains(string(argv), tc.wantArg) {
				t.Errorf("the client was not handed %q: %s", tc.wantArg, argv)
			}

			for _, nonTLS := range nonTLSErrors {
				bin = fakeClient(t, tc.client, "", nonTLS, 1)
				if code, stderr, msg := runRenderedScript(t, script, bin, env); code == 0 || strings.Contains(stderr, "DB_TLS_VERIFY_FAILED") || msg != "" || !strings.Contains(stderr, nonTLS) {
					t.Errorf("non-TLS failure %q: exit %d, termination message %q, stderr:\n%s", nonTLS, code, msg, stderr)
				}
			}

			bin = fakeClient(t, tc.client, "GRANT\n", "", 0)
			if code, stderr, _ := runRenderedScript(t, script, bin, env); code != 0 || strings.Contains(stderr, "DB_TLS_VERIFY_FAILED") {
				t.Errorf("success: exit %d, stderr:\n%s", code, stderr)
			}
		})
	}
}

// TestDBTLS_ByoUsersScriptsFailOnATLSFailure runs each rendered BYO users main script with a fake
// client that fails TLS. The container exits non-zero and its termination message is the named
// reason, not a result: the runner reads it as a failed run, never as one that provisioned nobody.
// Without the failure, the MySQL run's result still reaches the termination message.
func TestDBTLS_ByoUsersScriptsFailOnATLSFailure(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure"} {
		for _, engine := range []string{"postgres", "mysql"} {
			for _, skip := range []bool{false, true} {
				job, err := RenderByoDBUsersJob(ByoDBUsersJobParams{
					Provider: provider, Engine: engine, RunnerImage: "img", Environment: "env-1",
					Users: byoUsersTestUsers, SkipRevoke: skip, RunID: "r1", Outputs: byoUsersTestOutputs[provider],
				})
				if err != nil {
					t.Fatal(err)
				}
				_, _, main := byoUsersPod(t, job)
				script := toStrings(dig(main, "command"))[2]
				var env []string
				for _, e := range dig(main, "env").([]any) {
					if v, ok := dig(e, "value").(string); ok {
						env = append(env, dig(e, "name").(string)+"="+v)
					}
				}
				env = append(env, "BYO_DB_ADMIN_USER=admin", "MYSQL_PWD=pw", "PGPASSWORD=pw", "PGUSER=admin")
				client, tlsErr := "psql", psqlTLSError
				if engine == "mysql" {
					client, tlsErr = "mysql", mysqlTLSError
				}
				what := provider + "/" + engine
				bin := fakeClient(t, client, "", tlsErr, 1)
				code, stderr, msg := runRenderedScript(t, script, bin, env)
				if code == 0 || !strings.HasPrefix(msg, "alethia: DB_TLS_VERIFY_FAILED: ") || strings.HasPrefix(msg, "alethia-byo-users") {
					t.Errorf("%s skip=%v: exit %d, termination message %q, stderr:\n%s", what, skip, code, msg, stderr)
				}
				if engine == "mysql" {
					bin = fakeClient(t, client, "alethia-byo-users v1 count=0\n", "", 0)
					if code, stderr, msg := runRenderedScript(t, script, bin, env); code != 0 || msg != "alethia-byo-users v1 count=0\n" {
						t.Errorf("%s skip=%v success: exit %d, termination message %q, stderr:\n%s", what, skip, code, msg, stderr)
					}
				}
			}
		}
	}
}

// bootstrapTLSOutputs are each cloud's bootstrap outputs, for both engines (the MySQL ones carry the
// Azure app client id as well as the Postgres app OID).
var bootstrapTLSOutputs = map[string]map[string]string{
	"aws": {"rds_cluster_endpoint": "orders.cluster-abc.eu-central-1.rds.amazonaws.com", "rds_database_name": "orders",
		"rds_master_credentials_secret_name": "alethia/rds/orders"},
	"gcp": {"cloud_sql_ip": "10.0.0.5", "cloud_sql_database": "orders", "cloud_sql_iam_user": "app@p.iam",
		"cloud_sql_credentials_secret": "orders-sql", "cloud_sql_server_ca_cert": testGCPServerCA},
	"azure": {"azure_db_fqdn": "orders.postgres.database.azure.com", "azure_db_name": "orders", "azure_db_admin_user": "admin",
		"azure_db_admin_client_id": "aaaa1111-2222-3333-4444-555566667777", "azure_db_app_oid": "bbbb1111-2222-3333-4444-555566667777",
		"azure_db_client_id": "cccc1111-2222-3333-4444-555566667777"},
}

// wantTLS is each cloud's verification as the PR states it: host-name checking and the CA set.
var wantTLS = map[string]struct {
	identity bool
	ca       string
}{
	"aws":   {true, awsRDSCABundle},
	"azure": {true, azureDBCABundle},
	"gcp":   {false, testGCPServerCA},
}

// assertVerifiedClient checks one apply container against its cloud's verification: the mysql client
// is handed the mode and the mounted CA file, psql gets them through PGSSLMODE/PGSSLROOTCERT, the
// mount is read-only at the CA directory, and no unverified mode appears anywhere in the container.
func assertVerifiedClient(t *testing.T, what, engine string, identity bool, main any) {
	t.Helper()
	cmd := strings.Join(toStrings(dig(main, "command")), " ")
	env := map[string]string{}
	for _, e := range dig(main, "env").([]any) {
		if v, ok := dig(e, "value").(string); ok {
			env[dig(e, "name").(string)] = v
		}
	}
	if engine == "mysql" {
		want := "--ssl-mode=VERIFY_CA --ssl-ca=/etc/alethia/db-ca/ca.pem"
		if identity {
			want = "--ssl-mode=VERIFY_IDENTITY --ssl-ca=/etc/alethia/db-ca/ca.pem"
		}
		if strings.Count(cmd, want) == 0 || strings.Count(cmd, "mysql --user") != strings.Count(cmd, want) {
			t.Errorf("%s: not every mysql invocation carries %q:\n%s", what, want, cmd)
		}
	} else {
		want := "verify-ca"
		if identity {
			want = "verify-full"
		}
		if env["PGSSLMODE"] != want || env["PGSSLROOTCERT"] != "/etc/alethia/db-ca/ca.pem" || !strings.Contains(cmd, "run_db_client psql") {
			t.Errorf("%s: PGSSLMODE %q PGSSLROOTCERT %q, command %q", what, env["PGSSLMODE"], env["PGSSLROOTCERT"], cmd)
		}
	}
	for _, weak := range []string{"REQUIRED", "PREFERRED", "DISABLED"} {
		if strings.Contains(cmd, "--ssl-mode="+weak) {
			t.Errorf("%s: an unverified mode %s is rendered", what, weak)
		}
	}
	if !strings.HasPrefix(env[dbTLSReasonEnv], "alethia: DB_TLS_VERIFY_FAILED: ") {
		t.Errorf("%s: no named TLS failure reason in the env", what)
	}
	mounted := false
	for _, m := range dig(main, "volumeMounts").([]any) {
		if dig(m, "name") == dbCAVolume {
			mounted = dig(m, "mountPath") == "/etc/alethia/db-ca" && dig(m, "readOnly") == true
		}
	}
	if !mounted {
		t.Errorf("%s: the CA set is not mounted read-only at /etc/alethia/db-ca", what)
	}
}

// TestBootstrapJob_VerifiesTheServerPerCloud pins, per cloud and engine, the bootstrap Job's
// verification mode and the CA set it mounts: the ConfigMap (a PreSync hook one wave before the Job)
// carries exactly that cloud's CA set, the pod mounts that ConfigMap, and the apply client verifies
// against it.
func TestBootstrapJob_VerifiesTheServerPerCloud(t *testing.T) {
	for provider, want := range wantTLS {
		for _, engine := range []string{"postgres", "mysql"} {
			what := provider + "/" + engine
			res, err := RenderBootstrapJob(Options{
				Provider: provider, RunnerImage: "runner:1", Outputs: bootstrapTLSOutputs[provider],
				Databases: []types.ProjectDatabaseConfig{{Name: "orders-db", EngineFamily: engine}},
			}, dbTarget())
			if err != nil {
				t.Fatalf("%s: %v", what, err)
			}
			docs := parseYAMLDocs(t, res.JobYAML)
			cm, job := docs[0], docs[len(docs)-1]
			if cm["kind"] != "ConfigMap" || job["kind"] != "Job" {
				t.Fatalf("%s: documents %v … %v", what, cm["kind"], job["kind"])
			}
			cmName := "bootstrap-database-orders-db-db-ca"
			if dig(cm, "metadata", "name") != cmName || dig(cm, "metadata", "namespace") != dig(job, "metadata", "namespace") ||
				dig(cm, "data", "ca.pem") != want.ca {
				t.Errorf("%s: ConfigMap %v in %v, CA set is the cloud's = %v", what, dig(cm, "metadata", "name"),
					dig(cm, "metadata", "namespace"), dig(cm, "data", "ca.pem") == want.ca)
			}
			if dig(cm, "metadata", "annotations", "argocd.argoproj.io/hook") != "PreSync" ||
				dig(cm, "metadata", "annotations", "argocd.argoproj.io/sync-wave") != "-1" {
				t.Errorf("%s: the ConfigMap is not a PreSync hook ahead of the Job: %v", what, dig(cm, "metadata", "annotations"))
			}
			pod := dig(job, "spec", "template", "spec")
			found := false
			for _, v := range dig(pod, "volumes").([]any) {
				if dig(v, "name") == dbCAVolume {
					found = dig(v, "configMap", "name") == cmName
				}
			}
			if !found {
				t.Errorf("%s: no %s volume from ConfigMap %s", what, dbCAVolume, cmName)
			}
			mains := dig(pod, "containers").([]any)
			assertVerifiedClient(t, what, engine, want.identity, mains[0])
		}
	}
}

// TestByoDBUsersJob_VerifiesTheServerPerCloud pins the same for the BYO users Job: its CA ConfigMap
// carries the cloud's CA set and the run's labels, in the run namespace, and the main container
// verifies against it.
func TestByoDBUsersJob_VerifiesTheServerPerCloud(t *testing.T) {
	for provider, want := range wantTLS {
		for _, engine := range []string{"postgres", "mysql"} {
			what := provider + "/" + engine
			job, err := RenderByoDBUsersJob(ByoDBUsersJobParams{
				Provider: provider, Engine: engine, RunnerImage: "img", Environment: "env-1",
				Users: byoUsersTestUsers, RunID: "r1", Outputs: byoUsersTestOutputs[provider],
			})
			if err != nil {
				t.Fatalf("%s: %v", what, err)
			}
			cm := byoUsersDoc(t, job.CAConfigMap.YAML)
			name := ByoDBUsersBaseName("env-1") + "-db-ca"
			if job.CAConfigMap.Resource != "configmaps" || job.CAConfigMap.Name != name || dig(cm, "kind") != "ConfigMap" ||
				dig(cm, "metadata", "name") != name || dig(cm, "metadata", "namespace") != ByoDBUsersNamespace ||
				dig(cm, "data", "ca.pem") != want.ca {
				t.Errorf("%s: CA ConfigMap %+v", what, job.CAConfigMap.Name)
			}
			assertByoUsersLabels(t, what+" CA ConfigMap", dig(cm, "metadata", "labels"))
			for _, c := range job.Credentials {
				if c.Name == name {
					t.Errorf("%s: the CA ConfigMap is listed as a credential", what)
				}
			}
			pod, _, main := byoUsersPod(t, job)
			found := false
			for _, v := range dig(pod, "volumes").([]any) {
				if dig(v, "name") == dbCAVolume {
					found = dig(v, "configMap", "name") == name
				}
			}
			if !found {
				t.Errorf("%s: no %s volume from ConfigMap %s", what, dbCAVolume, name)
			}
			assertVerifiedClient(t, what, engine, want.identity, main)
		}
	}
}

// TestDBTLS_GCPWithoutAServerCAGetsNoJob: a GCP environment whose outputs carry no server CA gets
// neither Job — the render fails, naming the output — rather than a Job that connects unverified.
func TestDBTLS_GCPWithoutAServerCAGetsNoJob(t *testing.T) {
	outs := map[string]string{}
	for k, v := range bootstrapTLSOutputs["gcp"] {
		if k != "cloud_sql_server_ca_cert" {
			outs[k] = v
		}
	}
	if _, err := RenderBootstrapJob(Options{Provider: "gcp", RunnerImage: "runner:1", Outputs: outs}, dbTarget()); err == nil ||
		!strings.Contains(err.Error(), "cloud_sql_server_ca_cert") {
		t.Errorf("bootstrap Job: %v", err)
	}
	byoOuts := map[string]string{}
	for k, v := range byoUsersTestOutputs["gcp"] {
		if k != "cloud_sql_server_ca_cert" {
			byoOuts[k] = v
		}
	}
	if _, err := RenderByoDBUsersJob(ByoDBUsersJobParams{Provider: "gcp", RunnerImage: "img", Environment: "env-1",
		RunID: "r1", Outputs: byoOuts}); err == nil || !strings.Contains(err.Error(), "cloud_sql_server_ca_cert") {
		t.Errorf("BYO users Job: %v", err)
	}
}

// dbCAConfigMapBudget is the most a rendered CA ConfigMap may weigh. A client-side `kubectl apply`
// (the BYO users runner) and ArgoCD's default apply copy the whole object into the
// kubectl.kubernetes.io/last-applied-configuration annotation, and an object's annotations together
// may not exceed 256 KiB. 200 KiB leaves room for the object's other annotations and labels, and turns
// a growing bundle (about 4.5 KB of roots per new AWS Region) into this red test rather than a failed
// sync.
const dbCAConfigMapBudget = 200 * 1024

// TestDBCAConfigMaps_StayWithinTheAnnotationBudget renders every cloud's CA ConfigMap, for both Jobs,
// and holds its JSON encoding (what the annotation stores) under dbCAConfigMapBudget.
func TestDBCAConfigMaps_StayWithinTheAnnotationBudget(t *testing.T) {
	for provider := range wantTLS {
		res, err := RenderBootstrapJob(Options{Provider: provider, RunnerImage: "runner:1", Outputs: bootstrapTLSOutputs[provider]}, dbTarget())
		if err != nil {
			t.Fatal(err)
		}
		byo, err := RenderByoDBUsersJob(ByoDBUsersJobParams{Provider: provider, RunnerImage: "img", Environment: "env-1",
			Users: byoUsersTestUsers, RunID: "r1", Outputs: byoUsersTestOutputs[provider]})
		if err != nil {
			t.Fatal(err)
		}
		for what, doc := range map[string]map[string]any{
			"bootstrap": parseYAMLDocs(t, res.JobYAML)[0],
			"BYO users": byoUsersDoc(t, byo.CAConfigMap.YAML),
		} {
			if doc["kind"] != "ConfigMap" {
				t.Fatalf("%s/%s: first document is %v", provider, what, doc["kind"])
			}
			b, err := json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
			if len(b) > dbCAConfigMapBudget {
				t.Errorf("%s %s CA ConfigMap is %d bytes, over the %d-byte budget: kubectl's last-applied annotation (256 KiB for all annotations) would soon refuse it. Shrink the bundle (a regional RDS bundle instead of the global one) before adding to it.",
					provider, what, len(b), dbCAConfigMapBudget)
			}
			t.Logf("%s %s CA ConfigMap: %d bytes of %d", provider, what, len(b), dbCAConfigMapBudget)
		}
	}
}
