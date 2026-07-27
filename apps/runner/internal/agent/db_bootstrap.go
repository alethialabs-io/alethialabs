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

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
)

// db-bootstrap is the LEAST-PRIVILEGE half of keyless DB auth (#722). The cloud identity the app logs
// in as must map to a database ROLE/USER with working privileges, and that is SQL the cloud API can't
// do. This subcommand (run as a one-shot ArgoCD PreSync Job, connected as the DB admin) emits that SQL
// so the app gets a scoped role instead of admin/superuser. The dialect is selected by --engine:
//
// PostgreSQL (--engine postgres, the default — AWS RDS / Azure Flexible Server / GCP Cloud SQL):
//   - AWS / Azure: the app's cloud identity maps onto a fixed least-priv role (keylessDBUser,
//     "alethia_app", shared with packages/core/manifests). The Job CREATEs it, binds it to the cloud
//     identity (the rds_iam group / an Entra pgaadauth SECURITY LABEL), and grants working privileges.
//   - GCP: tofu already creates the app's CLOUD_IAM_SERVICE_ACCOUNT user, so there is NO role to
//     create — the Job only GRANTs it working privileges (its login name, an SA email minus the
//     .gserviceaccount.com suffix, is passed via --app-user).
//     Every cloud grants only CONNECT + schema USAGE/CREATE — never superuser/CREATEROLE. On PostgreSQL
//     15+ (all three managed engines) CREATE on schema public is no longer implicit, so it is required
//     for the app to create its tables; CONNECT/USAGE are idempotent belt-and-suspenders.
//
// MySQL (--engine mysql — all three clouds, #1506):
//   - Every cloud grants the SAME least-priv DDL+DML set scoped to the app's own database
//     (mysqlAppPrivileges) — never *.* / GRANT OPTION / SUPER. They differ only in how the login binds
//     to the cloud identity.
//   - AWS: `CREATE USER … IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS'`. No identity id appears in
//     the SQL — the IAM policy maps the pod's role to the DB username, so the rds-db:connect ARN's
//     username segment and this literal must agree (both keylessBootstrapRole), and AWS matches it
//     case-sensitively.
//   - Azure binds an Entra login with `CREATE AADUSER '<alias>' IDENTIFIED BY '<uami-client-id>'`
//     (the IDENTIFIED BY value is the app UAMI's *client id*, not the object id the Postgres pgaadauth
//     label uses).
//   - GCP: tofu already created the CLOUD_IAM_SERVICE_ACCOUNT user (as on Postgres), so the Job emits
//     GRANTs only. The target is the MySQL login form — Cloud SQL MySQL truncates the '@' and domain,
//     so it is the lowercase SA local part, not the Postgres "sa@project.iam" form (#1505).

// keylessBootstrapRole is the least-priv role/user AWS/Azure converge on. It is NOT a second literal:
// it aliases packages/core's exported constant, so the login this Job CREATEs and the one the rendered
// manifests tell the app to connect as cannot drift apart. The third site — the AWS IAM policy ARN in
// infra/templates/project/aws/irsa.tf — cannot import Go, and is asserted against the same constant by
// TestKeylessDBUserMatchesIRSAPolicy in packages/core/manifests.
const keylessBootstrapRole = manifests.KeylessDBUser

// Database engines the bootstrap SQL generator supports. An empty --engine is treated as postgres for
// back-compatibility with the pre-MySQL callers.
const (
	enginePostgres = "postgres"
	engineMySQL    = "mysql"
)

// safeIdent guards values interpolated into SQL identifiers/labels. Postgres role names + Entra oids
// are constrained; reject anything else rather than build injectable SQL (the admin runs this).
var safeIdent = regexp.MustCompile(`^[a-zA-Z0-9_.\-]+$`)

// safeGcpUser guards the GCP app login name — a CLOUD_IAM_SERVICE_ACCOUNT username, which is the SA
// email minus the ".gserviceaccount.com" suffix, so it also contains '@'. It is double-quoted in the
// emitted SQL; this reject-list still blocks anything that could break out of the quoted identifier.
var safeGcpUser = regexp.MustCompile(`^[a-zA-Z0-9_.@\-]+$`)

// safeMySQLUser guards a GCP Cloud SQL **MySQL** IAM login. Deliberately stricter than safeGcpUser:
// MySQL truncates the '@' and domain from the SA email, requires the login be all lowercase, and caps
// usernames at 32 characters on 8.0+ (#1505). Excluding '@' is what makes passing the Postgres form
// ("sa@project.iam") a hard error rather than a GRANT against a nonexistent user.
var safeMySQLUser = regexp.MustCompile(`^[a-z0-9_.\-]{1,32}$`)

// bootstrapInput is the set of values the bootstrap SQL generator interpolates. Grouped into a struct
// (rather than a growing positional arg list) so each field's meaning and injection guard stay clear.
type bootstrapInput struct {
	Provider    string // aws | azure | gcp
	Engine      string // "" | postgres (default) | mysql
	DBName      string // the target database
	AppOID      string // Azure Postgres — the app cloud identity's Entra object id (binds the pgaadauth login)
	AppUser     string // GCP — the app's existing CLOUD_IAM_SERVICE_ACCOUNT login the grants target
	AppClientID string // Azure MySQL — the app UAMI client id bound via CREATE AADUSER … IDENTIFIED BY
}

// bootstrapSQL returns the ordered SQL statements that create/scope the least-priv app role (Postgres)
// or Entra AAD user (MySQL) for a keyless database. Pure + deterministic (unit-tested); the caller
// executes them as admin. The dialect is chosen by in.Engine: "mysql" takes the Azure MySQL path; an
// empty or "postgres" engine takes the historical per-provider PostgreSQL paths.
func bootstrapSQL(in bootstrapInput) ([]string, error) {
	if !safeIdent.MatchString(in.DBName) {
		return nil, fmt.Errorf("db-bootstrap: unsafe database name %q", in.DBName)
	}
	switch in.Engine {
	case engineMySQL:
		return mysqlBootstrapSQL(in)
	case enginePostgres, "": // empty defaults to postgres (pre-MySQL callers pass no --engine)
		return postgresBootstrapSQL(in)
	default:
		// Reject an unknown engine explicitly — never silently emit Postgres SQL for a typo'd engine
		// (e.g. "mysq"), which would apply the wrong dialect against a real server.
		return nil, fmt.Errorf("db-bootstrap: unknown engine %q (want postgres|mysql)", in.Engine)
	}
}

// postgresBootstrapSQL emits the PostgreSQL least-priv role SQL, selected by provider.
//
//   - AWS: create the role, grant the rds_iam group so it authenticates by IAM token, and grant it
//     working privileges on the database (CONNECT + schema usage) — never superuser/CREATEROLE.
//   - Azure: create a LOGIN role and attach the Entra security label binding it to the app's managed
//     identity (type=service, keyed by object id), then the same working privileges.
//   - GCP: no role creation (tofu made the CLOUD_IAM_SERVICE_ACCOUNT user); grant that user CONNECT +
//     schema USAGE/CREATE. The username contains '@', so it is double-quoted.
func postgresBootstrapSQL(in bootstrapInput) ([]string, error) {
	role := keylessBootstrapRole // a compile-time constant, always safe
	switch in.Provider {
	case "aws":
		return []string{
			fmt.Sprintf(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %s WITH LOGIN; END IF; END $$;`, role, role),
			fmt.Sprintf(`GRANT rds_iam TO %s;`, role),
			fmt.Sprintf(`GRANT CONNECT ON DATABASE "%s" TO %s;`, in.DBName, role),
			fmt.Sprintf(`GRANT USAGE, CREATE ON SCHEMA public TO %s;`, role),
		}, nil
	case "azure":
		if !safeIdent.MatchString(in.AppOID) {
			return nil, fmt.Errorf("db-bootstrap: unsafe app object id %q", in.AppOID)
		}
		return []string{
			fmt.Sprintf(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %s WITH LOGIN; END IF; END $$;`, role, role),
			fmt.Sprintf(`SECURITY LABEL FOR "pgaadauth" ON ROLE %s IS 'aadauth,oid=%s,type=service';`, role, in.AppOID),
			fmt.Sprintf(`GRANT CONNECT ON DATABASE "%s" TO %s;`, in.DBName, role),
			fmt.Sprintf(`GRANT USAGE, CREATE ON SCHEMA public TO %s;`, role),
		}, nil
	case "gcp":
		if !safeGcpUser.MatchString(in.AppUser) {
			return nil, fmt.Errorf("db-bootstrap: unsafe gcp app user %q", in.AppUser)
		}
		return []string{
			fmt.Sprintf(`GRANT CONNECT ON DATABASE "%s" TO "%s";`, in.DBName, in.AppUser),
			fmt.Sprintf(`GRANT USAGE, CREATE ON SCHEMA public TO "%s";`, in.AppUser),
		}, nil
	}
	return nil, fmt.Errorf("db-bootstrap: no least-priv role SQL for provider %q (want aws|azure|gcp)", in.Provider)
}

// mysqlAppPrivileges is the least-priv DDL+DML set the app gets on its OWN database, shared by all
// three clouds so the privilege surface can't drift per-provider. Never *.*, never GRANT OPTION,
// never SUPER — the app creates and uses its own tables and nothing else.
const mysqlAppPrivileges = "SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES"

// mysqlBootstrapSQL emits the least-priv MySQL dialect for the requested provider. All three clouds
// converge on the same GRANT (mysqlAppPrivileges, scoped to the app's own database); they differ only
// in how the login is BOUND to the cloud identity:
//
//   - AWS (Aurora/RDS MySQL): `IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS'` — no identity id is
//     embedded in the SQL at all. The IAM policy maps the pod's role to a DB username, so the
//     rds-db:connect ARN's username segment and this literal MUST agree (both are keylessBootstrapRole
//     / manifests.keylessDBUser). AWS documents that "the user name used for IAM authentication must
//     match the case of the user name in the database", which is why the constant is lowercase and
//     interpolated verbatim rather than normalized here.
//   - Azure (MySQL Flexible Server): binds an Entra login with
//     `CREATE AADUSER '<alias>' IDENTIFIED BY '<client-id>'` — the IDENTIFIED BY value is the app
//     UAMI's *client id* (distinct from the object id the Postgres pgaadauth SECURITY LABEL uses).
//   - GCP (Cloud SQL MySQL): tofu already created the CLOUD_IAM_SERVICE_ACCOUNT user, exactly like the
//     Postgres path, so there is NO user to create and NO password/identity clause — grants only.
//     The target is the MySQL login form (#1505): Cloud SQL MySQL truncates the '@' and domain from the
//     SA email, so it is the lowercase local part, NOT the Postgres "sa@project.iam" form.
func mysqlBootstrapSQL(in bootstrapInput) ([]string, error) {
	switch in.Provider {
	case "aws":
		user := keylessBootstrapRole // a compile-time constant, always safe
		return []string{
			// IF NOT EXISTS keeps the PreSync Job idempotent across re-syncs. No IAM id appears here —
			// the binding is the IAM policy's dbuser:<cluster-resource-id>/<user> ARN (#1504/#1509).
			fmt.Sprintf(`CREATE USER IF NOT EXISTS '%s'@'%%' IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS';`, user),
			fmt.Sprintf("GRANT %s ON `%s`.* TO '%s'@'%%';", mysqlAppPrivileges, in.DBName, user),
		}, nil
	case "azure":
		if !safeIdent.MatchString(in.AppClientID) {
			return nil, fmt.Errorf("db-bootstrap: unsafe app client id %q", in.AppClientID)
		}
		user := keylessBootstrapRole // a compile-time constant, always safe; single-quoted → '<user>'@'%'
		return []string{
			// IF NOT EXISTS keeps the PreSync Job idempotent across re-syncs. (Azure's exact CREATE AADUSER
			// grammar — incl. IF NOT EXISTS acceptance and the precise UAMI value — is confirmed by the
			// main-gated real-apply e2e, #1450.)
			fmt.Sprintf(`CREATE AADUSER IF NOT EXISTS '%s' IDENTIFIED BY '%s';`, user, in.AppClientID),
			// Least-privilege: DDL+DML scoped to the app's own database — never *.* / GRANT OPTION / SUPER.
			fmt.Sprintf("GRANT %s ON `%s`.* TO '%s';", mysqlAppPrivileges, in.DBName, user),
		}, nil
	case "gcp":
		// Guarded by the MySQL form, not the Postgres one: passing "sa@project.iam" here would GRANT to
		// a user that does not exist on a Cloud SQL MySQL instance, so the Job would report success while
		// the app stayed unprivileged. Fail closed instead.
		if !safeMySQLUser.MatchString(in.AppUser) {
			return nil, fmt.Errorf("db-bootstrap: unsafe or non-MySQL gcp app user %q (want the lowercase, <=32ch service-account local part — Cloud SQL MySQL truncates the @ and domain)", in.AppUser)
		}
		return []string{
			fmt.Sprintf("GRANT %s ON `%s`.* TO '%s'@'%%';", mysqlAppPrivileges, in.DBName, in.AppUser),
		}, nil
	}
	return nil, fmt.Errorf("db-bootstrap: no keyless mysql bootstrap SQL for provider %q (want aws|azure|gcp)", in.Provider)
}

// renderBootstrapSQL joins the statements into a single script (newline-separated) — the form the Job
// pipes into its DB client (psql / mysql).
func renderBootstrapSQL(in bootstrapInput) (string, error) {
	stmts, err := bootstrapSQL(in)
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
	engine := fs.String("engine", "", "database engine (postgres|mysql; default postgres)")
	dbName := fs.String("db", "", "target database name")
	appOID := fs.String("app-oid", "", "app cloud-identity object id (Azure Postgres — binds the Entra login)")
	appUser := fs.String("app-user", "", "app login name to grant (GCP — the CLOUD_IAM_SERVICE_ACCOUNT user)")
	appClientID := fs.String("app-client-id", "", "app UAMI client id (Azure MySQL — bound via CREATE AADUSER … IDENTIFIED BY)")
	out := fs.String("out", "", "write the SQL to this file instead of stdout (the bootstrap Job's shared volume)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *dbName == "" {
		return fmt.Errorf("db-bootstrap: --db is required")
	}
	// Friendly CLI-level guards for the MySQL engine so a misconfigured Job fails with a clear message
	// (bootstrapSQL enforces the same invariants, but its "unsafe app client id" error reads oddly for
	// a simply-missing flag).
	if *engine == engineMySQL {
		switch *provider {
		case "azure":
			if *appClientID == "" {
				return fmt.Errorf("db-bootstrap: --engine mysql --provider azure requires --app-client-id (the app UAMI client id)")
			}
		case "gcp":
			if *appUser == "" {
				return fmt.Errorf("db-bootstrap: --engine mysql --provider gcp requires --app-user (the Cloud SQL IAM login — the lowercase service-account local part, NOT the Postgres sa@project.iam form)")
			}
		case "aws":
			// Nothing extra: AWSAuthenticationPlugin embeds no identity id, and the username is the
			// shared keylessBootstrapRole constant that the IAM policy's ARN also names.
		default:
			return fmt.Errorf("db-bootstrap: --engine mysql requires --provider aws|azure|gcp (got %q)", *provider)
		}
	}
	sql, err := renderBootstrapSQL(bootstrapInput{
		Provider:    *provider,
		Engine:      *engine,
		DBName:      *dbName,
		AppOID:      *appOID,
		AppUser:     *appUser,
		AppClientID: *appClientID,
	})
	if err != nil {
		return err
	}
	// The bootstrap Job's init container runs this in the runner image, which has no shell for a
	// `> file` redirect, so it writes the SQL to a shared volume via --out (0644 — it is not a secret;
	// role names / oids / UAMI client ids only, all non-secret identifiers). Absent --out, print to
	// stdout (for local use / `| psql`).
	if *out != "" {
		return os.WriteFile(*out, []byte(sql), 0o644)
	}
	_, err = fmt.Fprint(os.Stdout, sql)
	return err
}
