// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// renderByoUsersMySQLFor renders a MySQL run for provider with the test users.
func renderByoUsersMySQLFor(t *testing.T, provider string, skipRevoke bool) ByoDBUsersJob {
	t.Helper()
	job, err := RenderByoDBUsersJob(ByoDBUsersJobParams{
		Provider: provider, Engine: "mysql", RunnerImage: "ghcr.io/alethia/runner:1", Environment: "env-1",
		Users: byoUsersTestUsers, SkipRevoke: skipRevoke, RunID: "r1", Outputs: byoUsersTestOutputs[provider],
	})
	if err != nil {
		t.Fatalf("%s: render: %v", provider, err)
	}
	return job
}

// byoUsersPod returns a run's pod spec, its render-sql container and its main container.
func byoUsersPod(t *testing.T, job ByoDBUsersJob) (any, any, any) {
	t.Helper()
	pod := dig(byoUsersDoc(t, job.JobYAML), "spec", "template", "spec")
	var render any
	for _, c := range dig(pod, "initContainers").([]any) {
		if dig(c, "name") == "render-sql" {
			render = c
		}
	}
	mains, _ := dig(pod, "containers").([]any)
	if render == nil || len(mains) != 1 {
		t.Fatalf("pod %v", pod)
	}
	return pod, render, mains[0]
}

// TestByoDBUsersJob_MySQLPerCloud pins the MySQL run on each cloud: db-bootstrap renders both scripts
// to the shared volume; the mysql client applies the provision script without --force, sending its
// output (the result) to the termination message, then the sweep with --force into a file that
// replaces the message only when it is a whole result; TLS is always required; the admin password is
// in MYSQL_PWD (never argv), and only Azure's Entra token login enables the cleartext plugin. The
// credential objects are the Postgres run's: admin, then one Secret per user.
func TestByoDBUsersJob_MySQLPerCloud(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure"} {
		t.Run(provider, func(t *testing.T) {
			job := renderByoUsersMySQLFor(t, provider, false)
			pg := renderByoUsersFor(t, provider, false)
			if !reflect.DeepEqual(job.Credentials, pg.Credentials) {
				t.Error("the MySQL run's credential objects differ from the Postgres run's")
			}
			pod, render, main := byoUsersPod(t, job)
			args := strings.Join(toStrings(dig(render, "args")), " ")
			for _, want := range []string{"db-bootstrap --byo-users", "--engine mysql", "--out /sql/init.sql", "--sweep-out /sql/sweep.sql", "--users=alethia_byo_aaaaaaaaaaaa,alethia_byo_bbbbbbbbbbbb"} {
				if !strings.Contains(args, want) {
					t.Errorf("render-sql args %q lack %q", args, want)
				}
			}
			if strings.Contains(args, "--result-path") || strings.Contains(args, "--skip-revoke") {
				t.Errorf("render-sql args %q", args)
			}
			if dig(main, "image") != mysqlClientImage || dig(main, "terminationMessagePath") != ByoDBUsersResultPath || dig(main, "terminationMessagePolicy") != "File" {
				t.Errorf("main container %v", main)
			}
			cmd := toStrings(dig(main, "command"))
			if len(cmd) != 3 || cmd[0] != "/bin/sh" || cmd[1] != "-c" {
				t.Fatalf("command %v", cmd)
			}
			script := cmd[2]
			tlsMode := "VERIFY_IDENTITY"
			if provider == "gcp" {
				tlsMode = "VERIFY_CA"
			}
			client := `run_db_client mysql --user="$BYO_DB_ADMIN_USER" --ssl-mode=` + tlsMode + ` --ssl-ca=/etc/alethia/db-ca/ca.pem`
			if provider == "azure" {
				client += " --enable-cleartext-plugin"
			}
			client += " -N -B"
			for _, want := range []string{
				"set -eu\n",
				"exec 3> /dev/termination-log\n" + client + ` "$BYO_DB_NAME" < /sql/init.sql` + "\n",
				"exec 3> /byo-result/result\n" + `if ! ` + client + ` --force "$BYO_DB_NAME" < /sql/sweep.sql; then`,
				`  "alethia-byo-users v1 count="*) ;;`,
				`  *) echo "alethia byo-users: the sweep wrote no result" >&2; exit 1 ;;`,
				"cat /byo-result/result > /dev/termination-log\n",
			} {
				if !strings.Contains(script, want) {
					t.Errorf("script lacks %q:\n%s", want, script)
				}
			}
			if strings.Index(script, "/sql/init.sql") > strings.Index(script, "/sql/sweep.sql") {
				t.Error("the sweep runs before the provision script")
			}
			if provider != "azure" && strings.Contains(script, "cleartext") {
				t.Errorf("%s enables the cleartext plugin", provider)
			}
			env := map[string]any{}
			for _, e := range dig(main, "env").([]any) {
				env[dig(e, "name").(string)] = e
			}
			if dig(env["MYSQL_TCP_PORT"], "value") != "3306" || dig(env["BYO_DB_NAME"], "value") != "app" || dig(env["MYSQL_HOST"], "value") != byoUsersTestOutputs[provider][map[string]string{"aws": "rds_cluster_endpoint", "gcp": "cloud_sql_ip", "azure": "azure_db_fqdn"}[provider]] {
				t.Errorf("connection env %v", env)
			}
			for name, e := range env {
				if secret, _ := dig(e, "valueFrom", "secretKeyRef", "name").(string); secret != "" && secret != byoDBUsersAdminName("env-1") {
					t.Errorf("the apply container reads %s (%s); only render-sql may read a user's password", secret, name)
				}
			}
			if provider == "azure" {
				if !strings.Contains(script, `MYSQL_PWD="$(cat /db-admin-token/token)"`) || dig(env["BYO_DB_ADMIN_USER"], "value") != "acme-dbadmin" {
					t.Errorf("Azure admin login: env %v\n%s", env, script)
				}
			} else if dig(env["MYSQL_PWD"], "valueFrom", "secretKeyRef", "key") != "password" || dig(env["BYO_DB_ADMIN_USER"], "valueFrom", "secretKeyRef", "key") != "username" {
				t.Errorf("%s admin credential env %v", provider, env)
			}
			mounts := map[string]any{}
			for _, m := range dig(main, "volumeMounts").([]any) {
				mounts[dig(m, "name").(string)] = m
			}
			if dig(mounts["sql"], "readOnly") != true || dig(mounts["byo-result"], "mountPath") != "/byo-result" || dig(mounts["byo-result"], "readOnly") != nil {
				t.Errorf("main mounts %v", mounts)
			}
			volumes := map[string]any{}
			for _, v := range dig(pod, "volumes").([]any) {
				volumes[dig(v, "name").(string)] = v
			}
			if dig(volumes["byo-result"], "emptyDir", "medium") != "Memory" {
				t.Errorf("volumes %v", volumes)
			}
			if _, ok := volumes["admin-token"]; ok != (provider == "azure") {
				t.Errorf("admin-token volume present = %v on %s", ok, provider)
			}
		})
	}
}

// TestByoDBUsersJob_MySQLSkipRevoke: with an incomplete declared set no sweep script is rendered or
// applied, so nothing can be revoked.
func TestByoDBUsersJob_MySQLSkipRevoke(t *testing.T) {
	_, render, main := byoUsersPod(t, renderByoUsersMySQLFor(t, "aws", true))
	args := strings.Join(toStrings(dig(render, "args")), " ")
	if !strings.Contains(args, "--skip-revoke") || strings.Contains(args, "--sweep-out") {
		t.Errorf("render-sql args %q", args)
	}
	script := toStrings(dig(main, "command"))[2]
	if strings.Contains(script, "sweep") || strings.Contains(script, "--force") {
		t.Errorf("--skip-revoke still applies a sweep:\n%s", script)
	}
}

// TestByoDBUsersJob_UnknownEngineRefused: an engine this Job has no dialect for is never rendered.
func TestByoDBUsersJob_UnknownEngineRefused(t *testing.T) {
	if _, err := RenderByoDBUsersJob(ByoDBUsersJobParams{Provider: "aws", Engine: "mariadb", RunnerImage: "img", Environment: "env-1",
		RunID: "r1", Outputs: byoUsersTestOutputs["aws"]}); err == nil {
		t.Fatal("rendered a run for an unknown engine")
	}
}

// TestByoDBUsersJob_MySQLContractWithTheRunner pins the spellings the MySQL run shares with
// `alethia db-bootstrap --byo-users` (apps/runner, a module this package cannot import): the
// --sweep-out flag, the result header the shell checks for, and the engine name.
func TestByoDBUsersJob_MySQLContractWithTheRunner(t *testing.T) {
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "runner", "internal", "agent", name))
		if err != nil {
			t.Fatalf("read the runner source: %v", err)
		}
		return string(b)
	}
	cmd, pg := read("db_bootstrap_byo.go"), read("db_bootstrap.go")
	for _, want := range []string{`fs.String("sweep-out", ""`, `const byoResultHeaderPrefix = "alethia-byo-users v1 count="`} {
		if !strings.Contains(cmd, want) {
			t.Errorf("the runner lacks %s", want)
		}
	}
	if !strings.Contains(pg, `engineMySQL    = "`+engineMySQL+`"`) {
		t.Errorf("the runner's MySQL engine name is not %q", engineMySQL)
	}
	if !strings.Contains(byoDBUsersMySQLScript(false, false, ""), `"alethia-byo-users v1 count="*)`) {
		t.Error("the shell checks for a header other than the runner's")
	}
}
