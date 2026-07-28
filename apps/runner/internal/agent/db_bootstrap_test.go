// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"strings"
	"testing"
)

func TestBootstrapSQL_AWS_LeastPriv(t *testing.T) {
	sql, err := renderBootstrapSQL(bootstrapInput{Provider: "aws", DBName: "ordersdb"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"CREATE ROLE alethia_app WITH LOGIN",
		"GRANT rds_iam TO alethia_app", // IAM-token auth, not a password
		`GRANT CONNECT ON DATABASE "ordersdb" TO alethia_app`,
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("AWS bootstrap SQL missing %q:\n%s", want, sql)
		}
	}
	// Least-privilege: never superuser / createrole / the rds_superuser group.
	for _, bad := range []string{"SUPERUSER", "CREATEROLE", "rds_superuser"} {
		if strings.Contains(sql, bad) {
			t.Errorf("AWS bootstrap SQL must not grant %q:\n%s", bad, sql)
		}
	}
}

func TestBootstrapSQL_Azure_EntraLabel(t *testing.T) {
	oid := "11111111-2222-3333-4444-555555555555"
	sql, err := renderBootstrapSQL(bootstrapInput{Provider: "azure", DBName: "ordersdb", AppOID: oid})
	if err != nil {
		t.Fatal(err)
	}
	// The Entra security label binds the login role to the app's managed identity (type=service).
	if !strings.Contains(sql, `SECURITY LABEL FOR "pgaadauth" ON ROLE alethia_app IS 'aadauth,oid=`+oid+`,type=service'`) {
		t.Errorf("Azure bootstrap SQL missing the pgaadauth label:\n%s", sql)
	}
	if strings.Contains(sql, "SUPERUSER") {
		t.Errorf("Azure role must not be superuser (this is the least-priv alternative to app-as-admin):\n%s", sql)
	}
}

func TestBootstrapSQL_GCP_GrantsOnly(t *testing.T) {
	// GCP creates its CLOUD_IAM_SERVICE_ACCOUNT user via tofu, so the Job only GRANTs it working
	// privileges — no CREATE ROLE. The username (an SA email minus the suffix) is double-quoted.
	user := "appdb-1a2b3c4d@my-proj.iam"
	sql, err := renderBootstrapSQL(bootstrapInput{Provider: "gcp", DBName: "orders_prod", AppUser: user})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`GRANT CONNECT ON DATABASE "orders_prod" TO "` + user + `";`,
		`GRANT USAGE, CREATE ON SCHEMA public TO "` + user + `";`,
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("GCP bootstrap SQL missing %q:\n%s", want, sql)
		}
	}
	// Grants only — never a role creation or superuser.
	for _, bad := range []string{"CREATE ROLE", "SUPERUSER", "CREATEROLE", "cloudsqlsuperuser"} {
		if strings.Contains(sql, bad) {
			t.Errorf("GCP bootstrap SQL must not contain %q (grants only):\n%s", bad, sql)
		}
	}
}

func TestBootstrapSQL_AzureMySQL_AADUser(t *testing.T) {
	// Azure MySQL Flexible Server binds an Entra login by the app UAMI's CLIENT id (not the object id
	// the Postgres pgaadauth label uses), then grants DDL+DML scoped to the app's own database.
	clientID := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	sql, err := renderBootstrapSQL(bootstrapInput{
		Provider: "azure", Engine: engineMySQL, DBName: "ordersdb", AppClientID: clientID,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`CREATE AADUSER IF NOT EXISTS 'alethia_app' IDENTIFIED BY '` + clientID + `';`,
		"GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES ON `ordersdb`.* TO 'alethia_app';",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("Azure MySQL bootstrap SQL missing %q:\n%s", want, sql)
		}
	}
	// Genuinely the MySQL dialect (no Postgres leakage) and least-privilege (no global / admin grants).
	for _, bad := range []string{
		"pgaadauth", "SCHEMA public", "pg_roles", "CREATE ROLE", // Postgres-only constructs
		"*.*", "ALL PRIVILEGES", "WITH GRANT OPTION", "SUPER", "CREATE USER", // over-broad MySQL grants
	} {
		if strings.Contains(sql, bad) {
			t.Errorf("Azure MySQL bootstrap SQL must not contain %q:\n%s", bad, sql)
		}
	}
}

func TestBootstrapSQL_AWSMySQL_AuthenticationPlugin(t *testing.T) {
	// Aurora/RDS MySQL binds the login to IAM with AWSAuthenticationPlugin. No identity id appears in
	// the SQL — the IAM policy maps the pod's role to this exact username, so the literal here and the
	// rds-db:connect ARN's username segment must agree (AWS matches it case-sensitively).
	sql, err := renderBootstrapSQL(bootstrapInput{
		Provider: "aws", Engine: engineMySQL, DBName: "ordersdb",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`CREATE USER IF NOT EXISTS 'alethia_app'@'%' IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS';`,
		"GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES ON `ordersdb`.* TO 'alethia_app'@'%';",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("AWS MySQL bootstrap SQL missing %q:\n%s", want, sql)
		}
	}
	// The username MUST be the shared constant the IAM policy also names — a drift here is an
	// authentication failure that no test downstream would attribute to this file.
	if !strings.Contains(sql, keylessBootstrapRole) {
		t.Errorf("AWS MySQL bootstrap SQL must grant to %q (the IAM policy's dbuser segment):\n%s", keylessBootstrapRole, sql)
	}
	// Genuinely MySQL (no Postgres leakage), least-privilege, and no password/secret material.
	for _, bad := range []string{
		"pgaadauth", "SCHEMA public", "pg_roles", "CREATE ROLE", "rds_iam", // Postgres-only constructs
		"*.*", "ALL PRIVILEGES", "WITH GRANT OPTION", "SUPER", // over-broad MySQL grants
		"IDENTIFIED BY", // a password clause has no business on an IAM-authenticated user
	} {
		if strings.Contains(sql, bad) {
			t.Errorf("AWS MySQL bootstrap SQL must not contain %q:\n%s", bad, sql)
		}
	}
}

func TestBootstrapSQL_GCPMySQL_GrantsOnly(t *testing.T) {
	// tofu already created the CLOUD_IAM_SERVICE_ACCOUNT user (as on Postgres), so this is grants-only.
	// The target is the MySQL login form: Cloud SQL MySQL truncates the '@' and domain, so it is the
	// lowercase SA local part (#1505).
	sql, err := renderBootstrapSQL(bootstrapInput{
		Provider: "gcp", Engine: engineMySQL, DBName: "ordersdb", AppUser: "alethia-app",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES ON `ordersdb`.* TO 'alethia-app'@'%';"
	if !strings.Contains(sql, want) {
		t.Errorf("GCP MySQL bootstrap SQL missing %q:\n%s", want, sql)
	}
	// Grants ONLY — the user exists already, so any creation/identity clause would fail or, worse,
	// create a second unrelated local user that shadows the IAM one.
	for _, bad := range []string{
		"CREATE USER", "CREATE AADUSER", "IDENTIFIED", "AWSAuthenticationPlugin",
		"*.*", "ALL PRIVILEGES", "WITH GRANT OPTION", "SUPER",
		"SCHEMA public", "pg_roles", // Postgres leakage
	} {
		if strings.Contains(sql, bad) {
			t.Errorf("GCP MySQL bootstrap SQL must not contain %q (grants only):\n%s", bad, sql)
		}
	}
}

func TestBootstrapSQL_GCPMySQL_RejectsThePostgresLoginForm(t *testing.T) {
	// The whole #1505 trap: the Postgres form "sa@project.iam" names a user that does NOT exist on a
	// Cloud SQL MySQL instance, so GRANTing to it would let the Job report success while the app stayed
	// unprivileged. It must fail closed instead. Same for a >32ch or uppercase login.
	for _, user := range []string{
		"alethia-app@my-project.iam",                     // the Postgres form
		"alethia-app@my-project.iam.gserviceaccount.com", // the raw SA email
		"Alethia-App", // MySQL IAM logins must be lowercase
		"an-extremely-long-service-account-name-here", // >32 characters
	} {
		if _, err := renderBootstrapSQL(bootstrapInput{
			Provider: "gcp", Engine: engineMySQL, DBName: "ordersdb", AppUser: user,
		}); err == nil {
			t.Errorf("expected gcp mysql app user %q to be rejected", user)
		}
	}
}

func TestBootstrapSQL_MySQL_UnknownProviderRejected(t *testing.T) {
	// An unrecognised provider must fail explicitly, never silently fall through to Postgres SQL.
	if _, err := renderBootstrapSQL(bootstrapInput{
		Provider: "hetzner", Engine: engineMySQL, DBName: "ordersdb",
	}); err == nil {
		t.Error("expected --engine mysql on an unknown provider to be rejected")
	}
}

func TestBootstrapSQL_MySQL_PrivilegeSetIsIdenticalAcrossClouds(t *testing.T) {
	// The privilege surface is the security boundary, so it must not drift per-provider — a cloud that
	// quietly gained a wider GRANT is exactly the regression this pins.
	grants := map[string]string{}
	for _, tc := range []struct {
		provider string
		in       bootstrapInput
	}{
		{"aws", bootstrapInput{Provider: "aws", Engine: engineMySQL, DBName: "ordersdb"}},
		{"azure", bootstrapInput{Provider: "azure", Engine: engineMySQL, DBName: "ordersdb", AppClientID: "aaaa-bbbb"}},
		{"gcp", bootstrapInput{Provider: "gcp", Engine: engineMySQL, DBName: "ordersdb", AppUser: "alethia-app"}},
	} {
		stmts, err := bootstrapSQL(tc.in)
		if err != nil {
			t.Fatalf("%s: %v", tc.provider, err)
		}
		for _, s := range stmts {
			if strings.HasPrefix(s, "GRANT ") {
				// Compare the privilege list only — the target differs legitimately per cloud.
				grants[tc.provider] = strings.SplitN(s, " ON ", 2)[0]
			}
		}
	}
	if len(grants) != 3 {
		t.Fatalf("expected a GRANT from each cloud, got %v", grants)
	}
	if grants["aws"] != grants["azure"] || grants["aws"] != grants["gcp"] {
		t.Errorf("MySQL privilege set drifted across clouds: %v", grants)
	}
}

func TestBootstrapSQL_RejectsUnknownEngine(t *testing.T) {
	// A typo'd engine must fail loudly, not silently fall through to the Postgres dialect.
	if _, err := renderBootstrapSQL(bootstrapInput{Provider: "azure", Engine: "mysq", DBName: "ordersdb"}); err == nil {
		t.Error("expected an unknown --engine value to be rejected")
	}
}

func TestBootstrapSQL_RejectsUnsafeIdentifiers(t *testing.T) {
	if _, err := renderBootstrapSQL(bootstrapInput{Provider: "aws", DBName: "orders; DROP TABLE users;--"}); err == nil {
		t.Error("expected unsafe db name to be rejected (SQL-injection guard)")
	}
	if _, err := renderBootstrapSQL(bootstrapInput{Provider: "azure", DBName: "ordersdb", AppOID: "oid'); DROP--"}); err == nil {
		t.Error("expected unsafe app oid to be rejected")
	}
	// The GCP app user is double-quoted, so a quote/backslash that could break out is rejected.
	if _, err := renderBootstrapSQL(bootstrapInput{Provider: "gcp", DBName: "ordersdb", AppUser: `app"; DROP--`}); err == nil {
		t.Error("expected unsafe gcp app user to be rejected")
	}
	// The Azure MySQL client id is single-quoted in IDENTIFIED BY; a quote that could break out is rejected.
	if _, err := renderBootstrapSQL(bootstrapInput{
		Provider: "azure", Engine: engineMySQL, DBName: "ordersdb", AppClientID: `bad'); DROP--`,
	}); err == nil {
		t.Error("expected unsafe app client id to be rejected")
	}
}
