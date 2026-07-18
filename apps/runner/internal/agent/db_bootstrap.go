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

// db-bootstrap is the LEAST-PRIVILEGE half of keyless DB auth (#722). On the token-as-password clouds
// (AWS RDS IAM / Azure Entra) the cloud identity must map to a Postgres ROLE, and creating that role
// needs SQL — the cloud API can't do it. This subcommand (run as a one-shot ArgoCD PreSync Job,
// connected as the DB admin) creates a SCOPED role for the app instead of handing the app admin: it
// is the alternative to registering the app identity as a superuser/AAD-administrator.
//
// The role name is the fixed keylessDBUser ("alethia_app", shared with packages/core/manifests).
// GCP does NOT use this — its tofu already creates the CLOUD_IAM_SERVICE_ACCOUNT user; the Job there
// only ensures the grants.

// keylessBootstrapRole is the least-priv role every cloud converges on (matches manifests.keylessDBUser).
const keylessBootstrapRole = "alethia_app"

// safeIdent guards values interpolated into SQL identifiers/labels. Postgres role names + Entra oids
// are constrained; reject anything else rather than build injectable SQL (the admin runs this).
var safeIdent = regexp.MustCompile(`^[a-zA-Z0-9_.\-]+$`)

// bootstrapSQL returns the ordered SQL statements that create + scope the least-priv app role for a
// keyless database on the given provider. Pure + deterministic (unit-tested); the caller executes
// them as admin. `appOID` is the app cloud identity's object id (Azure only — maps the Entra login).
//
//   - AWS: create the role, grant the rds_iam group so it authenticates by IAM token, and grant it
//     working privileges on the database (CONNECT + schema usage) — never superuser/CREATEROLE.
//   - Azure: create a LOGIN role and attach the Entra security label binding it to the app's managed
//     identity (type=service), then the same working privileges.
func bootstrapSQL(provider, dbName, appOID string) ([]string, error) {
	if !safeIdent.MatchString(dbName) {
		return nil, fmt.Errorf("db-bootstrap: unsafe database name %q", dbName)
	}
	role := keylessBootstrapRole // a compile-time constant, always safe
	switch provider {
	case "aws":
		return []string{
			fmt.Sprintf(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %s WITH LOGIN; END IF; END $$;`, role, role),
			fmt.Sprintf(`GRANT rds_iam TO %s;`, role),
			fmt.Sprintf(`GRANT CONNECT ON DATABASE %s TO %s;`, dbName, role),
			fmt.Sprintf(`GRANT USAGE, CREATE ON SCHEMA public TO %s;`, role),
		}, nil
	case "azure":
		if !safeIdent.MatchString(appOID) {
			return nil, fmt.Errorf("db-bootstrap: unsafe app object id %q", appOID)
		}
		return []string{
			fmt.Sprintf(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %s WITH LOGIN; END IF; END $$;`, role, role),
			fmt.Sprintf(`SECURITY LABEL FOR "pgaadauth" ON ROLE %s IS 'aadauth,oid=%s,type=service';`, role, appOID),
			fmt.Sprintf(`GRANT CONNECT ON DATABASE %s TO %s;`, dbName, role),
			fmt.Sprintf(`GRANT USAGE, CREATE ON SCHEMA public TO %s;`, role),
		}, nil
	}
	return nil, fmt.Errorf("db-bootstrap: no least-priv role SQL for provider %q (gcp creates its IAM user via tofu)", provider)
}

// renderBootstrapSQL joins the statements into a single script (newline-separated) — the form the Job
// pipes into psql.
func renderBootstrapSQL(provider, dbName, appOID string) (string, error) {
	stmts, err := bootstrapSQL(provider, dbName, appOID)
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
	provider := fs.String("provider", "", "cloud provider (aws|azure)")
	dbName := fs.String("db", "", "target database name")
	appOID := fs.String("app-oid", "", "app cloud-identity object id (Azure — binds the Entra login)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *dbName == "" {
		return fmt.Errorf("db-bootstrap: --db is required")
	}
	sql, err := renderBootstrapSQL(*provider, *dbName, *appOID)
	if err != nil {
		return err
	}
	_, err = fmt.Fprint(os.Stdout, sql)
	return err
}
