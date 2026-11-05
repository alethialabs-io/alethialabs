// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
)

// `alethia db-bootstrap --byo-users` renders the Postgres SQL for per-binding BYO database users
// (docs/adr/byo-binding-db-users.md §3, §5; slice 3 of #6438). It is pure: it reads the declared users
// from its arguments and their passwords from its environment, and writes SQL. The BYO users Job
// (slice 4) applies that SQL as the database administrator with
// `psql --single-transaction -v ON_ERROR_STOP=1`, so the whole script commits for every declared user
// or for none.
//
// What the rendered script guarantees, per run:
//
//   - every declared user exists, can LOG IN with the password in the store, carries this environment's
//     tag, may CONNECT to the environment's database, owns a schema of its own name and has it as its
//     search_path, and holds no other attribute, membership or grant this script gives it;
//   - a user's password is sent as a SCRAM-SHA-256 verifier computed here, never as plaintext;
//   - every per-binding user TAGGED WITH THIS ENVIRONMENT that is not declared is revoked, its objects
//     handed to a holder role of its own, so a later re-declaration gets every one of them back;
//   - below Postgres 15, PUBLIC no longer holds CREATE on schema public, or the run fails.

// byoUserPattern is the shape of a per-binding user (manifests.ByoBindingDBUser). It is anchored at
// both ends on purpose: the revocation sweep matches the same pattern in SQL, and the anchors are what
// keep a holder role ("…_r") and every first-class role out of it.
var byoUserPattern = regexp.MustCompile(`^` + manifests.ByoDBUserPrefix + `[0-9a-f]{12}$`)

// byoUserSQLPattern is byoUserPattern as a Postgres regular expression (the same ERE text).
const byoUserSQLPattern = `^` + manifests.ByoDBUserPrefix + `[0-9a-f]{12}$`

// byoHolderSuffix names the NOLOGIN role a revoked user's objects are handed to ("<user>_r").
const byoHolderSuffix = "_r"

// byoEnvTagPrefix starts the environment tag a per-binding user and its holder carry as their role
// comment. A user without CREATEROLE cannot change a role's comment, so a chart cannot re-tag itself.
const byoEnvTagPrefix = "alethia-env:"

// byoPasswordEnvPrefix starts the environment variable carrying one user's password: the prefix, then
// the user's 12-hex suffix (alethia_byo_0123456789ab → ALETHIA_BYO_DB_PASSWORD_0123456789ab). The BYO
// users Job sets one such variable per user, each from that user's own Secret.
const byoPasswordEnvPrefix = "ALETHIA_BYO_DB_PASSWORD_"

// byoConnectionLimit caps a per-binding user's concurrent connections.
const byoConnectionLimit = 20

// byoMinPasswordLen is the shortest password accepted. Tofu generates 32 characters; anything much
// shorter is not a password the store produced.
const byoMinPasswordLen = 16

// SCRAM-SHA-256 verifier parameters (RFC 5802 / RFC 7677). 4096 is Postgres's own default
// (scram_iterations) and 16 bytes its default salt length.
const (
	scramIterations = 4096
	scramSaltLen    = 16
)

// byoEnvIDPattern bounds the environment ID that goes into the tag literal. It is quoted as a literal
// anyway; the pattern keeps it to a shape a real environment ID has.
var byoEnvIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// byoResultPathPattern is the only shape of --result-path accepted: absolute, and no byte psql's \o
// would read as anything but a file name (no '|', whitespace, quote or backslash).
var byoResultPathPattern = regexp.MustCompile(`^/[A-Za-z0-9._/-]*$`)

// byoAlphanumeric is the only password alphabet accepted (tofu's `special = false`).
var byoAlphanumeric = regexp.MustCompile(`^[A-Za-z0-9]+$`)

// byoDollarTag delimits every DO block. No value interpolated into a DO body can contain it: the bodies
// carry only validated user names and the validated environment ID (doBlock re-checks).
const byoDollarTag = "$alethia_byo$"

// byoUser is one declared per-binding user and the password the store holds for it.
type byoUser struct {
	Name     string
	Password string
}

// byoUsersInput is everything the per-binding SQL is rendered from.
type byoUsersInput struct {
	EnvironmentID string    // this environment's ID; the tag every user and holder carries
	DBName        string    // the environment's database (configured; may contain any printable byte)
	Users         []byoUser // the declared set; empty means every tagged user of this env is revoked
	ResultPath    string    // where psql's \o writes the provisioned set (the termination message path)
	Salt          io.Reader // random source for SCRAM salts; nil means crypto/rand
}

// pgQuoteIdent double-quotes a Postgres identifier, doubling any embedded quote, as quote_ident does.
func pgQuoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// pgQuoteLiteral single-quotes a Postgres string literal, doubling any embedded quote. Callers pass
// only values without a backslash, so standard_conforming_strings does not matter.
func pgQuoteLiteral(s string) string {
	return `'` + strings.ReplaceAll(s, `'`, `''`) + `'`
}

// validateByoDBName refuses a database name Postgres would not store as given: empty, longer than
// NAMEDATALEN-1 (Postgres would silently truncate it and so target another database), or holding a
// control character. Every other byte is safe because the name is always quoted.
func validateByoDBName(db string) error {
	if db == "" {
		return errors.New("db-bootstrap --byo-users: --db is required")
	}
	if len(db) > 63 {
		return fmt.Errorf("db-bootstrap --byo-users: database name is %d bytes; Postgres keeps at most 63", len(db))
	}
	for _, r := range db {
		if r < 0x20 || r == 0x7f {
			return errors.New("db-bootstrap --byo-users: database name contains a control character")
		}
	}
	return nil
}

// scramSHA256Verifier computes the verifier Postgres stores for password (RFC 5802 §3, RFC 7677):
// SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>, all base64. Postgres accepts it in
// `PASSWORD '…'` and stores it as is, so the plaintext never reaches the server. The password must be
// ASCII alphanumeric, for which SASLprep is the identity.
func scramSHA256Verifier(password string, salt []byte, iterations int) (string, error) {
	salted, err := pbkdf2.Key(sha256.New, password, salt, iterations, sha256.Size)
	if err != nil {
		return "", fmt.Errorf("db-bootstrap --byo-users: scram: %w", err)
	}
	clientKey := hmacSHA256(salted, "Client Key")
	storedKey := sha256.Sum256(clientKey)
	serverKey := hmacSHA256(salted, "Server Key")
	b64 := base64.StdEncoding.EncodeToString
	return fmt.Sprintf("SCRAM-SHA-256$%d:%s$%s:%s", iterations, b64(salt), b64(storedKey[:]), b64(serverKey)), nil
}

// hmacSHA256 returns HMAC-SHA-256(key, msg).
func hmacSHA256(key []byte, msg string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return m.Sum(nil)
}

// doBlock wraps body in an anonymous DO block, refusing a body that could close the dollar quote.
func doBlock(body string) (string, error) {
	if strings.Contains(body, byoDollarTag) {
		return "", errors.New("db-bootstrap --byo-users: DO body contains its own dollar-quote tag")
	}
	return "DO " + byoDollarTag + "\n" + body + "\n" + byoDollarTag + ";", nil
}

// byoPublicPreflight is the pre-15 preflight (ADR §3). Below 150000 PUBLIC may CREATE in schema
// public, which would give every per-binding user a schema it does not own. It grants CREATE there
// explicitly to the roles that hold it through PUBLIC today (the administrator, and alethia_app where
// it exists), revokes it from PUBLIC, and then CHECKS the result: a GRANT or REVOKE by a role that may
// not make it is only a WARNING in Postgres, so the check is what turns "refused" into a failed run.
func byoPublicPreflight() (string, error) {
	app := pgQuoteLiteral(keylessBootstrapRole)
	return doBlock(`BEGIN
  IF current_setting('server_version_num')::int < 150000 AND to_regnamespace('public') IS NOT NULL THEN
    GRANT CREATE ON SCHEMA public TO CURRENT_USER;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = ` + app + `) THEN
      GRANT CREATE ON SCHEMA public TO ` + pgQuoteIdent(keylessBootstrapRole) + `;
    END IF;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    IF EXISTS (SELECT FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
               WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') THEN
      RAISE EXCEPTION 'alethia byo-users: CREATE on schema public could not be revoked from PUBLIC';
    END IF;
    IF NOT has_schema_privilege(CURRENT_USER, 'public', 'CREATE') THEN
      RAISE EXCEPTION 'alethia byo-users: the administrator lost CREATE on schema public';
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = ` + app + `)
       AND NOT has_schema_privilege(` + app + `, 'public', 'CREATE') THEN
      RAISE EXCEPTION 'alethia byo-users: alethia_app lost CREATE on schema public';
    END IF;
  END IF;
END`)
}

// byoProvisionSQL renders the statements that make one declared user exist (ADR §3), in order:
//
//  1. refuse a pre-existing role of that name that is not tagged with this environment (the name is
//     derived from the environment, so such a role was not made by this environment's runs); create
//     it NOLOGIN when absent;
//  2. tag it, give it LOGIN, the connection limit and the password verifier, and make the
//     administrator a member (managed admins are not superusers; REASSIGN and CREATE SCHEMA
//     AUTHORIZATION need it);
//  3. assert it holds no elevated attribute and no membership — a non-superuser administrator may not
//     even name SUPERUSER/REPLICATION/BYPASSRLS in ALTER ROLE, so this is checked, not set;
//  4. re-adopt: when a holder role is left by a revocation, hand back everything it owns and drop it;
//  5. CONNECT on the database, its own schema owned by it (asserted, since IF NOT EXISTS would
//     silently keep a schema someone else owns), and its search_path.
func byoProvisionSQL(env, db string, u byoUser, verifier string) ([]string, error) {
	user, holder := u.Name, u.Name+byoHolderSuffix
	tag := pgQuoteLiteral(byoEnvTagPrefix + env)
	ensure, err := doBlock(`BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = ` + pgQuoteLiteral(user) + `) THEN
    IF shobj_description((SELECT oid FROM pg_roles WHERE rolname = ` + pgQuoteLiteral(user) + `), 'pg_authid') IS DISTINCT FROM ` + tag + ` THEN
      RAISE EXCEPTION 'alethia byo-users: role % exists and is not tagged with this environment', ` + pgQuoteLiteral(user) + `;
    END IF;
  ELSE
    CREATE ROLE ` + pgQuoteIdent(user) + ` NOLOGIN;
  END IF;
END`)
	if err != nil {
		return nil, err
	}
	assert, err := doBlock(`BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = ` + pgQuoteLiteral(user) + `
             AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'alethia byo-users: role % holds an elevated attribute', ` + pgQuoteLiteral(user) + `;
  END IF;
  IF EXISTS (SELECT FROM pg_auth_members WHERE member = ` + pgQuoteLiteral(user) + `::regrole) THEN
    RAISE EXCEPTION 'alethia byo-users: role % is a member of another role', ` + pgQuoteLiteral(user) + `;
  END IF;
END`)
	if err != nil {
		return nil, err
	}
	readopt, err := doBlock(`BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = ` + pgQuoteLiteral(holder) + `) THEN
    IF shobj_description((SELECT oid FROM pg_roles WHERE rolname = ` + pgQuoteLiteral(holder) + `), 'pg_authid') IS DISTINCT FROM ` + tag + ` THEN
      RAISE EXCEPTION 'alethia byo-users: holder % is not tagged with this environment', ` + pgQuoteLiteral(holder) + `;
    END IF;
    REASSIGN OWNED BY ` + pgQuoteIdent(holder) + ` TO ` + pgQuoteIdent(user) + `;
    DROP OWNED BY ` + pgQuoteIdent(holder) + `;
    DROP ROLE ` + pgQuoteIdent(holder) + `;
  END IF;
END`)
	if err != nil {
		return nil, err
	}
	owner, err := doBlock(`BEGIN
  IF (SELECT nspowner FROM pg_namespace WHERE nspname = ` + pgQuoteLiteral(user) + `) IS DISTINCT FROM ` + pgQuoteLiteral(user) + `::regrole::oid THEN
    RAISE EXCEPTION 'alethia byo-users: schema % is not owned by its user', ` + pgQuoteLiteral(user) + `;
  END IF;
END`)
	if err != nil {
		return nil, err
	}
	qu, qdb := pgQuoteIdent(user), pgQuoteIdent(db)
	return []string{
		"-- " + user,
		ensure,
		"COMMENT ON ROLE " + qu + " IS " + tag + ";",
		fmt.Sprintf("ALTER ROLE %s WITH LOGIN CONNECTION LIMIT %d PASSWORD %s;", qu, byoConnectionLimit, pgQuoteLiteral(verifier)),
		"GRANT " + qu + " TO CURRENT_USER;",
		assert,
		readopt,
		"GRANT CONNECT ON DATABASE " + qdb + " TO " + qu + ";",
		"CREATE SCHEMA IF NOT EXISTS " + qu + " AUTHORIZATION " + qu + ";",
		owner,
		"ALTER ROLE " + qu + " IN DATABASE " + qdb + " SET search_path = " + qu + ";",
	}, nil
}

// byoNameArray renders the declared names as a Postgres name[] literal expression.
func byoNameArray(users []byoUser) string {
	quoted := make([]string, len(users))
	for i, u := range users {
		quoted[i] = pgQuoteLiteral(u.Name)
	}
	return "ARRAY[" + strings.Join(quoted, ", ") + "]::name[]"
}

// byoTaggedRolesSQL selects roles matching the per-binding pattern whose comment is this
// environment's tag. It is the one predicate both the revocation sweep and the result line use.
func byoTaggedRolesSQL(env string) string {
	return `SELECT a.rolname FROM pg_roles a
    JOIN pg_shdescription d ON d.objoid = a.oid AND d.classoid = 'pg_authid'::regclass
    WHERE a.rolname ~ ` + pgQuoteLiteral(byoUserSQLPattern) + `
      AND d.description = ` + pgQuoteLiteral(byoEnvTagPrefix+env)
}

// byoRevokeSQL renders the environment-scoped revocation sweep (ADR §5). A candidate matches the
// anchored per-binding pattern (so no holder and no first-class role) AND carries this environment's
// tag (so no untagged role and no other environment's user), and is not declared. Each is locked out,
// its sessions ended, its objects reassigned to its own tagged NOLOGIN holder, its remaining
// privileges dropped, and the role dropped.
func byoRevokeSQL(env string, users []byoUser) (string, error) {
	tag := pgQuoteLiteral(byoEnvTagPrefix + env)
	return doBlock(`DECLARE
  r record;
  holder name;
BEGIN
  FOR r IN ` + byoTaggedRolesSQL(env) + `
      AND a.rolname <> ALL (` + byoNameArray(users) + `)
    ORDER BY a.rolname
  LOOP
    holder := r.rolname || ` + pgQuoteLiteral(byoHolderSuffix) + `;
    EXECUTE format('ALTER ROLE %I NOLOGIN', r.rolname);
    PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = r.rolname;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = holder) THEN
      IF shobj_description((SELECT oid FROM pg_roles WHERE rolname = holder), 'pg_authid') IS DISTINCT FROM ` + tag + ` THEN
        RAISE EXCEPTION 'alethia byo-users: holder % is not tagged with this environment', holder;
      END IF;
    ELSE
      EXECUTE format('CREATE ROLE %I NOLOGIN', holder);
    END IF;
    EXECUTE format('COMMENT ON ROLE %I IS %L', holder, ` + tag + `);
    EXECUTE format('GRANT %I TO CURRENT_USER', holder);
    EXECUTE format('REASSIGN OWNED BY %I TO %I', r.rolname, holder);
    EXECUTE format('DROP OWNED BY %I', r.rolname);
    EXECUTE format('DROP ROLE %I', r.rolname);
  END LOOP;
END`)
}

// byoResultSQL renders the run's last statement: the declared users that now exist with LOGIN and
// this environment's tag, one per line, written through \o to resultPath so that nothing earlier in
// the run reaches it. The Job's runner reads that file as the pod's termination message (#6466).
func byoResultSQL(env, resultPath string, users []byoUser) []string {
	return []string{
		`\pset tuples_only on`,
		`\pset format unaligned`,
		`\o ` + resultPath,
		byoTaggedRolesSQL(env) + `
      AND a.rolcanlogin
      AND a.rolname = ANY (` + byoNameArray(users) + `)
    ORDER BY a.rolname;`,
		`\o`,
	}
}

// validateByoUsers checks every declared user's name and password and returns them sorted by name, so
// the rendered SQL does not depend on argument order. A refusal never quotes a password.
func validateByoUsers(users []byoUser) ([]byoUser, error) {
	out := append([]byoUser(nil), users...)
	seen := map[string]bool{}
	for _, u := range out {
		if !byoUserPattern.MatchString(u.Name) {
			return nil, fmt.Errorf("db-bootstrap --byo-users: %q is not a per-binding user (want %s)", u.Name, byoUserSQLPattern)
		}
		if seen[u.Name] {
			return nil, fmt.Errorf("db-bootstrap --byo-users: user %s is declared twice", u.Name)
		}
		seen[u.Name] = true
		if len(u.Password) < byoMinPasswordLen {
			return nil, fmt.Errorf("db-bootstrap --byo-users: password for %s is shorter than %d characters", u.Name, byoMinPasswordLen)
		}
		if !byoAlphanumeric.MatchString(u.Password) {
			return nil, fmt.Errorf("db-bootstrap --byo-users: password for %s is not alphanumeric", u.Name)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// renderByoUsersSQL renders the whole per-binding script: header, the pre-15 preflight, each declared
// user, the revocation sweep, and the result line. It is meant for
// `psql --single-transaction -v ON_ERROR_STOP=1`, which makes it one transaction; every statement is
// idempotent, so a second run converges on the same state (only the verifiers' salts differ).
func renderByoUsersSQL(in byoUsersInput) (string, error) {
	if !byoEnvIDPattern.MatchString(in.EnvironmentID) {
		return "", errors.New("db-bootstrap --byo-users: --env-id is missing or not an environment ID")
	}
	if err := validateByoDBName(in.DBName); err != nil {
		return "", err
	}
	// The path follows psql's \o, which treats a leading '|' as a shell command to pipe into: only a
	// plain absolute path is accepted, so the result line can never become a command.
	if !byoResultPathPattern.MatchString(in.ResultPath) {
		return "", errors.New("db-bootstrap --byo-users: --result-path must be a plain absolute path")
	}
	users, err := validateByoUsers(in.Users)
	if err != nil {
		return "", err
	}
	salt := in.Salt
	if salt == nil {
		salt = rand.Reader
	}
	preflight, err := byoPublicPreflight()
	if err != nil {
		return "", err
	}
	stmts := []string{
		"-- alethia db-bootstrap --byo-users (postgres). Apply with psql --single-transaction -v ON_ERROR_STOP=1.",
		"-- Passwords are carried as SCRAM-SHA-256 verifiers only.",
		preflight,
	}
	for _, u := range users {
		s := make([]byte, scramSaltLen)
		if _, err := io.ReadFull(salt, s); err != nil {
			return "", fmt.Errorf("db-bootstrap --byo-users: salt: %w", err)
		}
		verifier, err := scramSHA256Verifier(u.Password, s, scramIterations)
		if err != nil {
			return "", err
		}
		block, err := byoProvisionSQL(in.EnvironmentID, in.DBName, u, verifier)
		if err != nil {
			return "", err
		}
		stmts = append(stmts, block...)
	}
	revoke, err := byoRevokeSQL(in.EnvironmentID, users)
	if err != nil {
		return "", err
	}
	stmts = append(stmts, "-- revoke every undeclared per-binding user of this environment", revoke)
	stmts = append(stmts, byoResultSQL(in.EnvironmentID, in.ResultPath, users)...)
	return strings.Join(stmts, "\n") + "\n", nil
}

// byoPasswordEnv names the environment variable that carries user's password.
func byoPasswordEnv(user string) string {
	return byoPasswordEnvPrefix + strings.TrimPrefix(user, manifests.ByoDBUserPrefix)
}

// isByoUsersInvocation reports whether db-bootstrap was asked for the per-binding users script.
func isByoUsersInvocation(args []string) bool {
	for _, a := range args {
		if a == "--byo-users" || a == "-byo-users" || strings.HasPrefix(a, "--byo-users=") || strings.HasPrefix(a, "-byo-users=") {
			return true
		}
	}
	return false
}

// runDBBootstrapByoUsers is `alethia db-bootstrap --byo-users`: it parses the declared users, reads
// each password from its own environment variable, and writes the script to --out (0600) or stdout.
// --users must be given, even empty: the declared set has to be KNOWN before anything is revoked, and
// a missing flag is a misrender, not "no bindings".
func runDBBootstrapByoUsers(_ context.Context, args []string, getenv func(string) (string, bool), stdout io.Writer) error {
	fs := flag.NewFlagSet("db-bootstrap --byo-users", flag.ContinueOnError)
	fs.Bool("byo-users", false, "render the per-binding BYO users script")
	engine := fs.String("engine", enginePostgres, "database engine (postgres only; MySQL is a later slice)")
	fs.String("provider", "", "cloud provider (accepted for symmetry; the script is the same on every cloud)")
	envID := fs.String("env-id", "", "this environment's ID — the tag every per-binding user carries")
	dbName := fs.String("db", "", "the environment's database")
	usersFlag := fs.String("users", "", "comma-separated declared per-binding users (required; may be empty)")
	resultPath := fs.String("result-path", "/dev/termination-log", "file the provisioned set is written to")
	out := fs.String("out", "", "write the SQL to this file (0600) instead of stdout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *engine != enginePostgres && *engine != "" {
		return fmt.Errorf("db-bootstrap --byo-users: engine %q is not supported (postgres only)", *engine)
	}
	usersGiven := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "users" {
			usersGiven = true
		}
	})
	if !usersGiven {
		return errors.New("db-bootstrap --byo-users: --users is required (pass --users= for an empty declared set)")
	}
	var users []byoUser
	for _, name := range strings.Split(*usersFlag, ",") {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if !byoUserPattern.MatchString(name) {
			return fmt.Errorf("db-bootstrap --byo-users: %q is not a per-binding user (want %s)", name, byoUserSQLPattern)
		}
		pw, ok := getenv(byoPasswordEnv(name))
		if !ok {
			return fmt.Errorf("db-bootstrap --byo-users: no password for %s (%s is unset)", name, byoPasswordEnv(name))
		}
		users = append(users, byoUser{Name: name, Password: pw})
	}
	sql, err := renderByoUsersSQL(byoUsersInput{
		EnvironmentID: *envID,
		DBName:        *dbName,
		Users:         users,
		ResultPath:    *resultPath,
	})
	if err != nil {
		return err
	}
	if *out != "" {
		return os.WriteFile(*out, []byte(sql), 0o600)
	}
	_, err = fmt.Fprint(stdout, sql)
	return err
}
