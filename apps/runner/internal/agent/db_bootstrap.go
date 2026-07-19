// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"flag"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// db-bootstrap is the LEAST-PRIVILEGE half of keyless DB auth (#722). The cloud identity the app logs
// in as must map to a Postgres ROLE with working privileges, and that is SQL the cloud API can't do.
// This subcommand (run as a one-shot ArgoCD PreSync Job, connected as the DB admin) emits that SQL so
// the app gets a scoped role instead of admin/superuser:
//
//   - AWS / Azure: the app's cloud identity maps onto a fixed least-priv role (keylessDBUser,
//     "alethia_app", shared with packages/core/manifests). The Job CREATEs it, binds it to the cloud
//     identity (the rds_iam group / an Entra pgaadauth SECURITY LABEL), and grants working privileges.
//   - GCP: tofu already creates the app's CLOUD_IAM_SERVICE_ACCOUNT user, so there is NO role to
//     create — the Job only GRANTs it working privileges (its login name, an SA email minus the
//     .gserviceaccount.com suffix, is passed via --app-user).
//
// Every cloud grants only CONNECT + schema USAGE/CREATE — never superuser/CREATEROLE. On PostgreSQL
// 15+ (all three managed engines) CREATE on schema public is no longer implicit, so it is required
// for the app to create its tables; CONNECT/USAGE are idempotent belt-and-suspenders.

// keylessBootstrapRole is the least-priv role AWS/Azure converge on (matches manifests.keylessDBUser).
const keylessBootstrapRole = "alethia_app"

// safeIdent guards values interpolated into SQL identifiers/labels. Postgres role names + Entra oids
// are constrained; reject anything else rather than build injectable SQL (the admin runs this).
var safeIdent = regexp.MustCompile(`^[a-zA-Z0-9_.\-]+$`)

// safeGcpUser guards the GCP app login name — a CLOUD_IAM_SERVICE_ACCOUNT username, which is the SA
// email minus the ".gserviceaccount.com" suffix, so it also contains '@'. It is double-quoted in the
// emitted SQL; this reject-list still blocks anything that could break out of the quoted identifier.
var safeGcpUser = regexp.MustCompile(`^[a-zA-Z0-9_.@\-]+$`)

// bootstrapSQL returns the ordered SQL statements that create (AWS/Azure) or just scope (GCP) the
// least-priv app role for a keyless database on the given provider. Pure + deterministic
// (unit-tested); the caller executes them as admin. `appOID` is the app cloud identity's object id
// (Azure only — maps the Entra login). `appUser` is the app's existing login name (GCP only — the
// CLOUD_IAM_SERVICE_ACCOUNT user tofu created, which the grants target).
//
//   - AWS: create the role, grant the rds_iam group so it authenticates by IAM token, and grant it
//     working privileges on the database (CONNECT + schema usage) — never superuser/CREATEROLE.
//   - Azure: create a LOGIN role and attach the Entra security label binding it to the app's managed
//     identity (type=service), then the same working privileges.
//   - GCP: no role creation (tofu made the CLOUD_IAM_SERVICE_ACCOUNT user); grant that user CONNECT +
//     schema USAGE/CREATE. The username contains '@', so it is double-quoted.
func bootstrapSQL(provider, dbName, appOID, appUser string) ([]string, error) {
	if !safeIdent.MatchString(dbName) {
		return nil, fmt.Errorf("db-bootstrap: unsafe database name %q", dbName)
	}
	role := keylessBootstrapRole // a compile-time constant, always safe
	switch provider {
	case "aws":
		return []string{
			fmt.Sprintf(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %s WITH LOGIN; END IF; END $$;`, role, role),
			fmt.Sprintf(`GRANT rds_iam TO %s;`, role),
			fmt.Sprintf(`GRANT CONNECT ON DATABASE "%s" TO %s;`, dbName, role),
			fmt.Sprintf(`GRANT USAGE, CREATE ON SCHEMA public TO %s;`, role),
		}, nil
	case "azure":
		if !safeIdent.MatchString(appOID) {
			return nil, fmt.Errorf("db-bootstrap: unsafe app object id %q", appOID)
		}
		return []string{
			fmt.Sprintf(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %s WITH LOGIN; END IF; END $$;`, role, role),
			fmt.Sprintf(`SECURITY LABEL FOR "pgaadauth" ON ROLE %s IS 'aadauth,oid=%s,type=service';`, role, appOID),
			fmt.Sprintf(`GRANT CONNECT ON DATABASE "%s" TO %s;`, dbName, role),
			fmt.Sprintf(`GRANT USAGE, CREATE ON SCHEMA public TO %s;`, role),
		}, nil
	case "gcp":
		if !safeGcpUser.MatchString(appUser) {
			return nil, fmt.Errorf("db-bootstrap: unsafe gcp app user %q", appUser)
		}
		return []string{
			fmt.Sprintf(`GRANT CONNECT ON DATABASE "%s" TO "%s";`, dbName, appUser),
			fmt.Sprintf(`GRANT USAGE, CREATE ON SCHEMA public TO "%s";`, appUser),
		}, nil
	}
	return nil, fmt.Errorf("db-bootstrap: no least-priv role SQL for provider %q (want aws|azure|gcp)", provider)
}

// renderBootstrapSQL joins the statements into a single script (newline-separated) — the form the Job
// pipes into psql.
func renderBootstrapSQL(provider, dbName, appOID, appUser string) (string, error) {
	stmts, err := bootstrapSQL(provider, dbName, appOID, appUser)
	if err != nil {
		return "", err
	}
	return strings.Join(stmts, "\n") + "\n", nil
}

// RunDBBootstrap generates the least-priv role SQL for the requested provider and writes it to stdout,
// so the bootstrap Job can pipe it into psql (`alethia db-bootstrap … | psql "$ADMIN_DSN"`). Keeping
// generation here (not in the Job's shell) means the SQL is one reviewed, injection-guarded source of
// truth shared with the unit tests. Executing it against the DB as admin is the Job's job.
func RunDBBootstrap(_ context.Context, args []string) error {
	fs := flag.NewFlagSet("db-bootstrap", flag.ContinueOnError)
	provider := fs.String("provider", "", "cloud provider (aws|azure|gcp)")
	dbName := fs.String("db", "", "target database name")
	appOID := fs.String("app-oid", "", "app cloud-identity object id (Azure — binds the Entra login)")
	appUser := fs.String("app-user", "", "app login name to grant (GCP — the CLOUD_IAM_SERVICE_ACCOUNT user)")
	out := fs.String("out", "", "write the SQL to this file instead of stdout (the bootstrap Job's shared volume)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *dbName == "" {
		return fmt.Errorf("db-bootstrap: --db is required")
	}
	sql, err := renderBootstrapSQL(*provider, *dbName, *appOID, *appUser)
	if err != nil {
		return err
	}
	// The bootstrap Job's init container runs this in the runner image, which has no shell for a
	// `> file` redirect, so it writes the SQL to a shared volume via --out (0644 — it is not a secret;
	// role names/oids only). Absent --out, print to stdout (for local use / `| psql`).
	if *out != "" {
		return os.WriteFile(*out, []byte(sql), 0o644)
	}
	_, err = fmt.Fprint(os.Stdout, sql)
	return err
}
