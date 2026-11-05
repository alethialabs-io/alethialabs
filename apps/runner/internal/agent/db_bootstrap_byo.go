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
// (slice 4) applies that SQL as the database administrator with `psql -X -v ON_ERROR_STOP=1 -f <file>`
// — NOT --single-transaction: the script carries its own transactions, in three phases (ADR §3),
// after a version floor:
//
//  0. FLOOR: a server older than Postgres 15 is refused before anything changes (ADR §3).
//  1. LOCKOUT, committed first: every revocation candidate is set NOLOGIN, and once that has committed
//     its sessions are terminated. Revocation therefore fails SAFE: whatever later blocks a drop (an
//     object the role owns in another database, say), the role can no longer log in.
//  2. PROVISION: every declared user, after a check that PUBLIC holds no CREATE on schema public, in
//     one transaction that commits for every declared user or for none. The result line is written
//     right after it commits, so it reports committed state only, and with ON_ERROR_STOP a failed run
//     never reaches it.
//  3. SWEEP: each candidate's reassign/drop in a transaction of its own. A candidate that cannot be
//     dropped is rolled back alone, reported as a WARNING naming it, and stays NOLOGIN; the next run
//     retries. It never touches phase 2, which has already committed, so one stuck role cannot hold
//     every declared user hostage. The result file is then rewritten with a
//     `revocation-pending:<role>` line per candidate still present, and the run exits 0: provisioning
//     succeeded, and the pending revocation is reported where the runner reads.
//
// What the rendered script guarantees, per run:
//
//   - every declared user exists, can LOG IN with the password in the store, carries this environment's
//     tag, may CONNECT to the environment's database, owns a schema of its own name and has it as its
//     search_path, and holds no other attribute, membership or grant this script gives it;
//   - a user's password is sent as a SCRAM-SHA-256 verifier computed here, never as plaintext;
//   - every per-binding user TAGGED WITH THIS ENVIRONMENT that is not declared can no longer log in,
//     and is dropped, its objects handed to a holder role of its own so that a later re-declaration
//     gets every one of them back. A user that cannot be dropped stays locked out and is reported as
//     revocation-pending, without affecting anything else in the run;
//   - nothing runs on a server older than Postgres 15, and no user is provisioned in a database where
//     PUBLIC still holds CREATE on schema public;
//   - with --skip-revoke (an incomplete declared set), phases 1 and 3 are not rendered at all.

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
	// SkipRevoke renders provisioning only: no lockout, no sweep. The runner sets it when its declared
	// set is incomplete (a binding failed to resolve or render), as the ExternalSecret prune is
	// skipped then, because an incomplete set would revoke a binding that is still declared.
	SkipRevoke bool
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

// byoPGFloorReason is why a server older than Postgres 15 gets no per-binding user. The binding lane
// reports the same words as the facet's unsatisfied reason (#6466).
const byoPGFloorReason = "per-binding database users need PostgreSQL 15 or newer"

// byoVersionFloorSQL is phase 0: the run refuses a server older than Postgres 15 before it changes
// anything. Below 15, PUBLIC may CREATE in schema public by default, so a per-binding user could
// create objects outside its own schema. Rather than rewrite that default for every role on the
// server, this design sets a floor (ADR §3).
func byoVersionFloorSQL() (string, error) {
	return doBlock(`BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'alethia byo-users: ` + byoPGFloorReason + ` (this server is %)', current_setting('server_version');
  END IF;
END`)
}

// byoPublicCreateCheckSQL refuses an environment database where PUBLIC still holds CREATE on schema
// public. Postgres 15 removed that default only for databases created on 15 or later; a database
// carried over from an older major by pg_upgrade or a dump keeps its old ACL. It is a check, not a fix:
// revoking it would change what every first-class role may do, which is an operator's decision.
func byoPublicCreateCheckSQL() (string, error) {
	return doBlock(`BEGIN
  IF EXISTS (SELECT FROM pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
             WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') THEN
    RAISE EXCEPTION 'alethia byo-users: PUBLIC holds CREATE on schema public in this database (kept from a Postgres older than 15); revoke it before per-binding users can be provisioned';
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

// byoCandidatesSQL selects the revocation candidates: a role matching the anchored per-binding
// pattern (so no holder and no first-class role) AND carrying this environment's tag (so no untagged
// role and no other environment's user) AND not declared. The lockout and the sweep share it, so they
// cannot disagree about which roles they act on.
func byoCandidatesSQL(env string, users []byoUser) string {
	return byoTaggedRolesSQL(env) + `
      AND a.rolname <> ALL (` + byoNameArray(users) + `)
    ORDER BY a.rolname`
}

// byoLockoutSQL renders phase 1 (ADR §3): its own transaction setting every candidate NOLOGIN, then —
// only after that has COMMITTED, so a reconnect cannot slip in between — the termination of their
// sessions. Nothing here can be blocked by what a role owns, so it commits even when the main
// transaction's drop of that role later fails.
func byoLockoutSQL(env string, users []byoUser) ([]string, error) {
	lock, err := doBlock(`DECLARE
  r record;
BEGIN
  FOR r IN ` + byoCandidatesSQL(env, users) + `
  LOOP
    EXECUTE format('ALTER ROLE %I NOLOGIN', r.rolname);
  END LOOP;
END`)
	if err != nil {
		return nil, err
	}
	terminate, err := doBlock(`BEGIN
  PERFORM pg_terminate_backend(s.pid) FROM pg_stat_activity s
    WHERE s.usename IN (` + byoCandidatesSQL(env, users) + `);
END`)
	if err != nil {
		return nil, err
	}
	return []string{
		"-- phase 1: lock out every revocation candidate, committed on its own",
		"BEGIN;",
		lock,
		"COMMIT;",
		terminate,
	}, nil
}

// byoRevokeSQL renders phase 3, the revocation sweep (ADR §5). It runs at top level (never inside a
// transaction block), so the DO block may COMMIT: each candidate — already NOLOGIN since phase 1, set
// again here idempotently — has its objects reassigned to its own tagged NOLOGIN holder, its remaining
// privileges dropped and the role dropped, inside a subtransaction, and that candidate's work is
// committed before the next begins. A failure rolls back that candidate alone and is reported as a
// WARNING naming it; the role stays NOLOGIN and the next run retries.
func byoRevokeSQL(env string, users []byoUser) (string, error) {
	tag := pgQuoteLiteral(byoEnvTagPrefix + env)
	return doBlock(`DECLARE
  r record;
  holder name;
BEGIN
  FOR r IN ` + byoCandidatesSQL(env, users) + `
  LOOP
    holder := r.rolname || ` + pgQuoteLiteral(byoHolderSuffix) + `;
    BEGIN
    EXECUTE format('ALTER ROLE %I NOLOGIN', r.rolname);
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
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'alethia byo-users: revocation pending: % (it stays NOLOGIN; the next run retries): %', r.rolname, SQLERRM;
    END;
    COMMIT;
  END LOOP;
END`)
}

// byoPendingPrefix starts a result line naming a revocation candidate that phase 3 could not drop.
const byoPendingPrefix = "revocation-pending:"

// byoResultSQL renders a result write: the declared users that now exist with LOGIN and this
// environment's tag, one per line, written through \o to resultPath so that nothing else reaches it.
// With pending, it also lists `revocation-pending:<role>` for every candidate still present. \o
// truncates, so the write after phase 3 replaces the one after phase 2. The Job's runner reads that
// file as the pod's termination message (#6466).
func byoResultSQL(env, resultPath string, users []byoUser, pending bool) []string {
	query := byoTaggedRolesSQL(env) + `
      AND a.rolcanlogin
      AND a.rolname = ANY (` + byoNameArray(users) + `)`
	if pending {
		query = `SELECT p.rolname::text FROM (` + query + `) p
UNION ALL
SELECT ` + pgQuoteLiteral(byoPendingPrefix) + ` || c.rolname FROM (` + byoCandidatesSQL(env, users) + `) c`
	}
	return []string{
		`\pset tuples_only on`,
		`\pset format unaligned`,
		`\o ` + resultPath,
		query + `
    ORDER BY 1;`,
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

// renderByoUsersSQL renders the whole per-binding script: header, the version floor, each declared
// user, the revocation sweep, and the result line — as the three phases the package comment
// describes. It is meant for `psql -X -v ON_ERROR_STOP=1 -f`; every statement is idempotent, so a
// second run converges on the same state (only the verifiers' salts differ).
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
	floor, err := byoVersionFloorSQL()
	if err != nil {
		return "", err
	}
	publicCheck, err := byoPublicCreateCheckSQL()
	if err != nil {
		return "", err
	}
	stmts := []string{
		"-- alethia db-bootstrap --byo-users (postgres). Apply with psql -X -v ON_ERROR_STOP=1 -f (not --single-transaction).",
		"-- Passwords are carried as SCRAM-SHA-256 verifiers only.",
		"-- phase 0: refuse a server older than Postgres 15, before anything changes",
		floor,
	}
	if in.SkipRevoke {
		stmts = append(stmts, "-- revocation skipped: the declared set is incomplete")
	} else {
		lockout, err := byoLockoutSQL(in.EnvironmentID, users)
		if err != nil {
			return "", err
		}
		stmts = append(stmts, lockout...)
	}
	stmts = append(stmts, "-- phase 2: every declared user, in one transaction", "BEGIN;", publicCheck)
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
	// The result line reads COMMITTED state: it runs after phase 2, so a commit that fails can never
	// have reported a user as provisioned.
	stmts = append(stmts, "COMMIT;")
	stmts = append(stmts, byoResultSQL(in.EnvironmentID, in.ResultPath, users, false)...)
	if in.SkipRevoke {
		return strings.Join(stmts, "\n") + "\n", nil
	}
	revoke, err := byoRevokeSQL(in.EnvironmentID, users)
	if err != nil {
		return "", err
	}
	stmts = append(stmts, "-- phase 3: revoke every undeclared per-binding user of this environment, one transaction each", revoke)
	stmts = append(stmts, byoResultSQL(in.EnvironmentID, in.ResultPath, users, true)...)
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
// each password from its own environment variable, and writes the script to --out (0600), never to stdout.
// --users must be given, even empty: the declared set has to be KNOWN before anything is revoked, and
// a missing flag is a misrender, not "no bindings".
func runDBBootstrapByoUsers(_ context.Context, args []string, getenv func(string) (string, bool)) error {
	fs := flag.NewFlagSet("db-bootstrap --byo-users", flag.ContinueOnError)
	fs.Bool("byo-users", false, "render the per-binding BYO users script")
	engine := fs.String("engine", enginePostgres, "database engine (postgres only; MySQL is a later slice)")
	fs.String("provider", "", "cloud provider (accepted for symmetry; the script is the same on every cloud)")
	envID := fs.String("env-id", "", "this environment's ID — the tag every per-binding user carries")
	dbName := fs.String("db", "", "the environment's database")
	usersFlag := fs.String("users", "", "comma-separated declared per-binding users (required; may be empty)")
	resultPath := fs.String("result-path", "/dev/termination-log", "file the provisioned set is written to")
	out := fs.String("out", "", "write the SQL to this file, 0600 (required: the SQL is never printed)")
	skipRevoke := fs.Bool("skip-revoke", false, "provision only, revoke nothing (the declared set is incomplete)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	// The script carries password verifiers. A verifier cannot log in, but it is still never printed:
	// on stdout it would land in the pod log.
	if *out == "" {
		return errors.New("db-bootstrap --byo-users: --out is required (the script is never written to stdout)")
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
		SkipRevoke:    *skipRevoke,
		EnvironmentID: *envID,
		DBName:        *dbName,
		Users:         users,
		ResultPath:    *resultPath,
	})
	if err != nil {
		return err
	}
	return os.WriteFile(*out, []byte(sql), 0o600)
}
