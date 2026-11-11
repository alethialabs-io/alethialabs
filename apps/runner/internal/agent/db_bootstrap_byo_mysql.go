// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
)

// byoUserLen is the length of every per-binding user name: the prefix and 12 hex characters.
var byoUserLen = len(manifests.ByoDBUserPrefix) + 12

// The MySQL dialect of `alethia db-bootstrap --byo-users` (docs/adr/byo-binding-db-users.md §3, §5;
// slice 5 of #6438). It keeps the Postgres dialect's rules, in what MySQL can express:
//
//   - a user's password is sent as a caching_sha2_password hash computed here, never as plaintext;
//   - every per-binding user carries this environment's tag, as the user ATTRIBUTE
//     {"alethia_env": "<environment-id>"}, and only a user with that tag is ever revoked;
//   - a pre-existing user of a declared name that is not tagged with this environment is refused;
//   - each user may work in a database of its own name (`alethia_byo_<h>`) with the keyless lane's
//     DDL+DML set (mysqlAppPrivileges), and nothing else this script grants;
//   - a revoked user is locked out first, then dropped, and its database is kept;
//   - nothing runs on a server older than MySQL 8.0.21.
//
// MySQL has no anonymous blocks, so there is no IF/RAISE outside a stored program, and creating one
// would leave an object behind. Every condition is therefore a PREPARE of one of two statements: a
// harmless `DO 0`, or a SELECT of a column named by the refusal's reason. No such column can exist (the
// SELECT has no FROM), so PREPARE fails with "Unknown column '<reason>'", which the mysql client
// reports with the line, and the run stops there (mysqlRefuseUnless).
//
// The script is TWO files, applied by two mysql invocations, because MySQL DDL is not transactional
// and the client has one error mode per invocation:
//
//  1. the PROVISION script (--out), applied WITHOUT --force, so the first error stops the run:
//     0. FLOOR: a server older than MySQL 8.0.21 is refused before anything changes.
//     1. LOCKOUT: every revocation candidate is locked (ACCOUNT LOCK), one statement.
//     2. PROVISION: every declared user, in name order. Each statement is atomic on its own, but
//     the phase is not: a failure leaves the users before it provisioned and the rest not, and the
//     run stops before the result is written, so the runner counts none of them (a failed Job
//     provisions nothing). The next run converges, because every statement is idempotent. A
//     user stays LOCKED until every check on it has passed, so a refused user can never log in.
//     The result is written last, as the only rows the script selects; the Job sends this
//     invocation's output to the termination message.
//  2. the SWEEP script (--sweep-out), applied WITH --force, so one candidate that cannot be dropped
//     does not stop the others: it ends each candidate's sessions, drops each candidate, and
//     rewrites the result with a `revocation-pending:<user>` line for every candidate still present
//     and a `sessions-not-ended:<user>` line for every candidate whose open sessions the administrator
//     could not end (mysqlByoUnkilledSQL), each list capped at mysqlByoMaxReported lines with a
//     `doubt:… +<n> more` line for the rest, and a `doubt:sessions-unrecorded` line when that record
//     was lost. Every KILL and DROP is built by the statement that selected its target
//     (mysqlByoSweepSQL), so no failed statement can leave a non-candidate to act on.
//     It exists only when revocation runs (no --skip-revoke).
//
// The result has the Postgres dialect's form: a header `alethia-byo-users v1 count=<n>`, then n
// lines, each a provisioned user, a pending revocation, a session report or a doubt. The runner
// parses it strictly (provisioner parseByoDBUsersResultLines).

// mysqlByoFloorReason is why a server older than MySQL 8.0.21 gets no per-binding user. 8.0.21 is the
// first release with user ATTRIBUTE and information_schema.USER_ATTRIBUTES, which carry the
// environment tag the revocation sweep selects by; without the tag no user can be revoked safely. The
// binding lane reports the same words as the facet's unsatisfied reason.
const mysqlByoFloorReason = "per-binding database users need MySQL 8.0.21 or newer"

// mysqlByoFloorVersionID is that floor as MYSQL_VERSION_ID (major*10000 + minor*100 + patch), the form
// a versioned comment `/*!80021 … */` is compared against by the server itself.
const mysqlByoFloorVersionID = "80021"

// mysqlByoEnvAttribute is the key of the environment tag inside the user ATTRIBUTE JSON object.
const mysqlByoEnvAttribute = "alethia_env"

// caching_sha2_password parameters. The stored form is `$A$<rounds/1000, 3 digits>$<20-byte
// salt><43-character SHA-256-crypt digest>`; 5000 rounds is the server's own default
// (caching_sha2_password_digest_rounds) and the least it accepts.
const (
	cachingSHA2Rounds   = 5000
	cachingSHA2SaltLen  = 20
	cachingSHA2DigestSz = 43
)

// mysqlByoMaxDrops bounds the candidates one sweep drops, and mysqlByoMaxKills the sessions it ends.
// MySQL has no loop outside a stored program, so each step is rendered; a candidate past the bound
// stays locked, is reported as revocation-pending, and is dropped by a later run.
const mysqlByoMaxDrops = 32

// mysqlByoMaxKills is a variable only so the real-server test of a session past the bound
// (TestByoUsersMySQLServer_SessionPastKillCapIsReported) can lower it instead of opening 65
// connections; nothing else assigns it.
var mysqlByoMaxKills = 64

// mysqlByoMaxReported bounds the `revocation-pending:` lines and, separately, the
// `sessions-not-ended:` lines one result carries, as the drops are bounded: past it one
// `doubt:<kind> +<n> more` line counts the rest. A backlog of revoked users therefore adds at most
// 2*(mysqlByoMaxReported+1) lines to the result, of which the kubelet keeps only the last 4096 bytes.
const mysqlByoMaxReported = 32

// mysqlByoStmt names the session variable and the prepared statement each check and step uses.
const mysqlByoStmt = "alethia_byo_s"

// cryptAlphabet is SHA-crypt's base-64 alphabet.
const cryptAlphabet = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// saltAlphabet is the alphabet the caching_sha2_password salt is drawn from here. The server accepts
// any byte but NUL and '$' in a salt; drawing from letters and digits keeps the stored string free of
// every byte a string literal would have to escape.
const saltAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// sha256Crypt is the SHA-256-crypt digest (Ulrich Drepper's "Unix crypt using SHA-256", the algorithm
// glibc's `$5$` and MySQL's caching_sha2_password both use) of password under salt and rounds, as its 43
// base-64 characters. It takes the salt as given: MySQL uses 20 bytes, where glibc truncates to 16.
func sha256Crypt(password, salt []byte, rounds int) string {
	// B = SHA256(P S P)
	b := sha256.New()
	b.Write(password)
	b.Write(salt)
	b.Write(password)
	sumB := b.Sum(nil)

	// A = SHA256(P S, then B per 32 bytes of P, then per bit of len(P): B for a 1, P for a 0)
	a := sha256.New()
	a.Write(password)
	a.Write(salt)
	n := len(password)
	for ; n > 32; n -= 32 {
		a.Write(sumB)
	}
	a.Write(sumB[:n])
	for n = len(password); n > 0; n >>= 1 {
		if n&1 != 0 {
			a.Write(sumB)
		} else {
			a.Write(password)
		}
	}
	sumA := a.Sum(nil)

	// P' = DP repeated to len(P), DP = SHA256(P repeated len(P) times)
	dp := sha256.New()
	for range password {
		dp.Write(password)
	}
	pSeq := repeatTo(dp.Sum(nil), len(password))

	// S' = DS repeated to len(S), DS = SHA256(S repeated 16 + A[0] times)
	ds := sha256.New()
	for i := 0; i < 16+int(sumA[0]); i++ {
		ds.Write(salt)
	}
	sSeq := repeatTo(ds.Sum(nil), len(salt))

	c := sumA
	for i := 0; i < rounds; i++ {
		h := sha256.New()
		if i&1 != 0 {
			h.Write(pSeq)
		} else {
			h.Write(c)
		}
		if i%3 != 0 {
			h.Write(sSeq)
		}
		if i%7 != 0 {
			h.Write(pSeq)
		}
		if i&1 != 0 {
			h.Write(c)
		} else {
			h.Write(pSeq)
		}
		c = h.Sum(nil)
	}

	var out strings.Builder
	enc := func(b2, b1, b0 byte, n int) {
		w := uint(b2)<<16 | uint(b1)<<8 | uint(b0)
		for ; n > 0; n-- {
			out.WriteByte(cryptAlphabet[w&0x3f])
			w >>= 6
		}
	}
	for _, t := range [][3]int{{0, 10, 20}, {21, 1, 11}, {12, 22, 2}, {3, 13, 23}, {24, 4, 14}, {15, 25, 5}, {6, 16, 26}, {27, 7, 17}, {18, 28, 8}, {9, 19, 29}} {
		enc(c[t[0]], c[t[1]], c[t[2]], 4)
	}
	enc(0, c[31], c[30], 3)
	return out.String()
}

// repeatTo returns sum repeated to exactly n bytes.
func repeatTo(sum []byte, n int) []byte {
	out := make([]byte, 0, n)
	for len(out) < n {
		out = append(out, sum[:min(len(sum), n-len(out))]...)
	}
	return out
}

// cachingSHA2Hash is the string MySQL stores for password under caching_sha2_password, which
// `IDENTIFIED WITH caching_sha2_password AS '<hash>'` accepts as is, so the plaintext never reaches the
// server. salt must be cachingSHA2SaltLen bytes, none of them NUL or '$'.
func cachingSHA2Hash(password string, salt []byte) (string, error) {
	if len(salt) != cachingSHA2SaltLen || strings.ContainsAny(string(salt), "\x00$") {
		return "", errors.New("db-bootstrap --byo-users: caching_sha2_password salt must be 20 bytes, none NUL or '$'")
	}
	return fmt.Sprintf("$A$%03d$%s%s", cachingSHA2Rounds/1000, salt, sha256Crypt([]byte(password), salt, cachingSHA2Rounds)), nil
}

// cachingSHA2Salt draws a salt from r, uniformly over saltAlphabet (rejection sampling: a byte at or
// past the largest multiple of the alphabet's size is discarded).
func cachingSHA2Salt(r io.Reader) ([]byte, error) {
	limit := byte(256 / len(saltAlphabet) * len(saltAlphabet))
	salt := make([]byte, 0, cachingSHA2SaltLen)
	buf := make([]byte, 1)
	for len(salt) < cachingSHA2SaltLen {
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, fmt.Errorf("db-bootstrap --byo-users: salt: %w", err)
		}
		if buf[0] < limit {
			salt = append(salt, saltAlphabet[int(buf[0])%len(saltAlphabet)])
		}
	}
	return salt, nil
}

// mysqlQuoteLiteral single-quotes a MySQL string literal, doubling any embedded quote. A backslash
// or NUL is refused rather than escaped: a backslash's meaning depends on the server's sql_mode
// (NO_BACKSLASH_ESCAPES), and no value this script quotes may contain either.
func mysqlQuoteLiteral(s string) (string, error) {
	if strings.ContainsAny(s, "\\\x00") {
		return "", errors.New("db-bootstrap --byo-users: a MySQL literal may not contain a backslash or NUL")
	}
	return "'" + strings.ReplaceAll(s, "'", "''") + "'", nil
}

// mustMySQLLiteral is mysqlQuoteLiteral for values validated before they get here (user names, the
// environment ID, hashes, fixed text); a refusal there is a defect in this file.
func mustMySQLLiteral(s string) string {
	q, err := mysqlQuoteLiteral(s)
	if err != nil {
		panic(err)
	}
	return q
}

// mysqlQuoteIdent backtick-quotes a MySQL identifier, doubling any embedded backtick. Inside
// backticks a backslash is an ordinary character in every sql_mode.
func mysqlQuoteIdent(s string) string {
	return "`" + strings.ReplaceAll(s, "`", "``") + "`"
}

// mysqlAccount is a per-binding user's account name, 'user'@'%'.
func mysqlAccount(user string) string {
	return mustMySQLLiteral(user) + "@'%'"
}

// mysqlRefusalMaxLen is MySQL's longest column name. A refusal reason is used as one, so a longer
// reason would fail with "Identifier name is too long" instead of naming itself.
const mysqlRefusalMaxLen = 64

// mysqlRefuseUnless renders a check: when cond is not TRUE (FALSE or NULL), PREPARE fails with
// "Unknown column '<reason>'", which stops a run applied without --force. reason must fit a column
// name and contain no backtick.
func mysqlRefuseUnless(cond, reason string) ([]string, error) {
	if len(reason) > mysqlRefusalMaxLen || strings.ContainsAny(reason, "`\x00") || strings.HasSuffix(reason, " ") {
		return nil, fmt.Errorf("db-bootstrap --byo-users: refusal %q cannot be a MySQL column name", reason)
	}
	refuse, err := mysqlQuoteLiteral("SELECT " + mysqlQuoteIdent(reason))
	if err != nil {
		return nil, err
	}
	return mysqlPrepared("IF(" + cond + ", 'DO 0', " + refuse + ")"), nil
}

// mysqlPrepared renders the statements that run the SQL text expr evaluates to as one prepared
// statement.
func mysqlPrepared(expr string) []string {
	return []string{
		"SET @" + mysqlByoStmt + " = " + expr + ";",
		"PREPARE " + mysqlByoStmt + " FROM @" + mysqlByoStmt + ";",
		"EXECUTE " + mysqlByoStmt + ";",
		"DEALLOCATE PREPARE " + mysqlByoStmt + ";",
	}
}

// mysqlByoTagged is the predicate, over information_schema.USER_ATTRIBUTES aliased a, of a user that
// carries this environment's tag.
func mysqlByoTagged(env string) string {
	return "JSON_UNQUOTE(JSON_EXTRACT(a.ATTRIBUTE, '$." + mysqlByoEnvAttribute + "')) = " + mustMySQLLiteral(env)
}

// mysqlByoDeclaredList renders the declared names as a binary IN list, or "" when there are none.
func mysqlByoDeclaredList(users []byoUser) string {
	if len(users) == 0 {
		return ""
	}
	quoted := make([]string, len(users))
	for i, u := range users {
		quoted[i] = mustMySQLLiteral(u.Name)
	}
	return "(" + strings.Join(quoted, ", ") + ")"
}

// mysqlByoCandidatesSQL selects the revocation candidates: a user on host '%' whose name matches the
// anchored per-binding pattern, case-sensitively (so no first-class user, and no name differing only
// in case), AND of exactly the per-binding length (ICU's `$` also matches before a final line
// terminator, so the pattern alone admits `<user>\n`, which Go's byoUserPattern does not; a literal
// may not carry the `\z` that would fix it in the pattern), AND that carries this environment's tag
// (so no untagged user and no other environment's) AND that is not declared. The lockout, the kills,
// the drops and the pending lines all share it, so they cannot disagree about which users they act
// on. Names compare as binary: MySQL user names are case-sensitive, and information_schema's
// collation is not.
func mysqlByoCandidatesSQL(env string, users []byoUser) string {
	q := `SELECT a.USER, a.HOST FROM information_schema.USER_ATTRIBUTES a
    WHERE REGEXP_LIKE(a.USER, ` + mustMySQLLiteral(byoUserSQLPattern) + `, 'c') AND CHAR_LENGTH(a.USER) = ` + strconv.Itoa(byoUserLen) + ` AND a.HOST = '%'
      AND ` + mysqlByoTagged(env)
	if list := mysqlByoDeclaredList(users); list != "" {
		q += `
      AND CAST(a.USER AS BINARY) NOT IN ` + list
	}
	return q
}

// mysqlByoGrantDB is an expression evaluating to the database part of a database-level GRANT for db,
// as the server will read it. With partial_revokes OFF (the default) MySQL reads '_' and '%' in a
// GRANT's database name as LIKE wildcards, so `alethia_byo_<h>` would also cover `alethiaXbyoX<h>`; the
// underscores are escaped then. With partial_revokes ON the server reads them literally, and an
// escape would be read as a backslash, so the name is given as is.
func mysqlByoGrantDB(db string) string {
	return "IF(@@partial_revokes, " + mustMySQLLiteral(db) + ", REPLACE(" + mustMySQLLiteral(db) + ", '_', CONCAT(CHAR(92 USING utf8mb4), '_')))"
}

// mysqlByoPrivilegeList is mysqlAppPrivileges as a quoted IN list of privilege names.
func mysqlByoPrivilegeList() string {
	parts := strings.Split(mysqlAppPrivileges, ", ")
	for i, p := range parts {
		parts[i] = mustMySQLLiteral(p)
	}
	return "(" + strings.Join(parts, ", ") + ")"
}

// mysqlByoProvisionSQL renders the statements that make one declared user exist (ADR §3), in order:
//
//  1. create it LOCKED when absent, with its hash, TLS required, the connection limit and this
//     environment's tag (CREATE USER IF NOT EXISTS leaves an existing user untouched);
//  2. refuse a user of that name that does not carry this environment's tag: the name is derived from
//     the environment, so such a user was not made by this environment's runs;
//  3. set its hash, TLS requirement and connection limit, every run (rotation; a reset by the user
//     itself is undone), and LOCK it again, so a user an earlier run unlocked is held to every check
//     below as well (new connections are refused between this statement and the unlock);
//  4. its database, created when absent and kept forever, and the DDL+DML set on it alone;
//  5. refuse a user that holds a global privilege, GRANT OPTION, a privilege on any other database, a
//     privilege outside the set, or a role — each of which only an administrator could have given it;
//  6. unlock it, last, so a user refused by any check above, whether new or provisioned by an
//     earlier run, is left locked and cannot log in.
func mysqlByoProvisionSQL(env string, u byoUser, hash string) ([]string, error) {
	user, account, lit := u.Name, mysqlAccount(u.Name), mustMySQLLiteral(u.Name)
	attr, err := json.Marshal(map[string]string{mysqlByoEnvAttribute: env})
	if err != nil {
		return nil, err
	}
	auth := "IDENTIFIED WITH caching_sha2_password AS " + mustMySQLLiteral(hash) +
		fmt.Sprintf(" REQUIRE SSL WITH MAX_USER_CONNECTIONS %d", byoConnectionLimit)
	tagged, err := mysqlRefuseUnless(`(SELECT COUNT(*) FROM information_schema.USER_ATTRIBUTES a
    WHERE CAST(a.USER AS BINARY) = `+lit+` AND a.HOST = '%' AND `+mysqlByoTagged(env)+`) = 1`,
		user+" is not tagged with this environment")
	if err != nil {
		return nil, err
	}
	grantee := mustMySQLLiteral(account)
	least, err := mysqlRefuseUnless(`(SELECT COUNT(*) FROM (
    SELECT 1 FROM information_schema.USER_PRIVILEGES p
      WHERE p.GRANTEE = `+grantee+` AND (p.PRIVILEGE_TYPE <> 'USAGE' OR p.IS_GRANTABLE <> 'NO')
    UNION ALL
    SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES p
      WHERE p.GRANTEE = `+grantee+`
        AND (p.TABLE_SCHEMA NOT IN (`+lit+`, REPLACE(`+lit+`, '_', CONCAT(CHAR(92 USING utf8mb4), '_')))
             OR p.PRIVILEGE_TYPE NOT IN `+mysqlByoPrivilegeList()+` OR p.IS_GRANTABLE <> 'NO')
    UNION ALL
    SELECT 1 FROM mysql.role_edges r WHERE CAST(r.TO_USER AS BINARY) = `+lit+` AND r.TO_HOST = '%') x) = 0`,
		user+" holds a privilege beyond its own")
	if err != nil {
		return nil, err
	}
	grant := mysqlPrepared("CONCAT(" + mustMySQLLiteral("GRANT "+mysqlAppPrivileges+" ON `") + ", " +
		mysqlByoGrantDB(user) + ", " + mustMySQLLiteral("`.* TO "+account) + ")")

	out := []string{
		"-- " + user,
		"CREATE USER IF NOT EXISTS " + account + " " + auth + " ACCOUNT LOCK ATTRIBUTE " + mustMySQLLiteral(string(attr)) + ";",
	}
	out = append(out, tagged...)
	out = append(out,
		// LOCKED again, as on creation, so the UNLOCK below is the only way back in: a user an earlier
		// run unlocked that now fails a check stays locked.
		"ALTER USER "+account+" "+auth+" ACCOUNT LOCK;",
		"CREATE DATABASE IF NOT EXISTS "+mysqlQuoteIdent(user)+";",
	)
	out = append(out, grant...)
	out = append(out, least...)
	return append(out, "ALTER USER "+account+" ACCOUNT UNLOCK;"), nil
}

// mysqlByoLockoutSQL renders phase 1: every candidate locked by one ALTER USER, or `DO 0` when there
// is none. group_concat_max_len is raised first (the script sets it), so a long list is never cut
// short into a statement naming fewer users.
func mysqlByoLockoutSQL(env string, users []byoUser) []string {
	return append([]string{"-- phase 1: lock out every revocation candidate"},
		mysqlPrepared(`(SELECT IFNULL(CONCAT('ALTER USER ', GROUP_CONCAT(CONCAT(QUOTE(c.USER), '@', QUOTE(c.HOST)) ORDER BY c.USER SEPARATOR ', '), ' ACCOUNT LOCK'), 'DO 0')
    FROM (`+mysqlByoCandidatesSQL(env, users)+`) c)`)...)
}

// mysqlByoResultSQL renders a result write: the header line, then the declared users that now exist
// UNLOCKED with this environment's tag, one per line, and with pending:
//
//   - `revocation-pending:<user>` for each of the first mysqlByoMaxReported candidates still present
//     (in binary name order), then `doubt:revocation-pending +<n> more` when n more are;
//   - `sessions-not-ended:<user>` for each of the first mysqlByoMaxReported users the sweep recorded
//     (mysqlByoUnkilledSQL), then `doubt:sessions-not-ended +<n> more` when n more were;
//   - `doubt:sessions-unrecorded` when that record is absent: the statement that writes it failed
//     under --force, or the client reconnected and lost the session's variables. A successful record
//     is never NULL (an empty set is JSON_ARRAY()), so a lost one is reported, never read as "none".
//
// Every line is an entry, so the header counts it. It is the only statement of either script that
// returns rows, so the Job can send an invocation's whole output to the termination message.
func mysqlByoResultSQL(env string, users []byoUser, pending bool) string {
	entries := `SELECT CONVERT(a.USER USING utf8mb4) AS line FROM information_schema.USER_ATTRIBUTES a
      JOIN mysql.user m ON CAST(m.User AS BINARY) = CAST(a.USER AS BINARY) AND CAST(m.Host AS BINARY) = CAST(a.HOST AS BINARY)
      WHERE a.HOST = '%' AND ` + mysqlByoTagged(env) + ` AND m.account_locked = 'N'`
	if list := mysqlByoDeclaredList(users); list != "" {
		entries += `
        AND CAST(a.USER AS BINARY) IN ` + list
	} else {
		entries += `
        AND FALSE`
	}
	if pending {
		cands := mysqlByoCandidatesSQL(env, users)
		limit := strconv.Itoa(mysqlByoMaxReported)
		unkilled := `JSON_TABLE(IFNULL(@alethia_byo_unkilled, JSON_ARRAY()), '$[*]' COLUMNS (n FOR ORDINALITY, u VARCHAR(32) PATH '$')) j`
		more := func(kind string) string {
			return `CONVERT(CONCAT(` + mustMySQLLiteral(mysqlByoDoubtPrefix+kind+" +") + `, COUNT(*) - ` + limit + `, ' more') USING utf8mb4)`
		}
		entries += `
    UNION ALL
    SELECT CONVERT(CONCAT(` + mustMySQLLiteral(byoPendingPrefix) + `, p.USER) USING utf8mb4)
      FROM (SELECT c.USER FROM (` + cands + `) c ORDER BY CAST(c.USER AS BINARY) LIMIT ` + limit + `) p
    UNION ALL
    SELECT ` + more("revocation-pending") + ` FROM (` + cands + `) c HAVING COUNT(*) > ` + limit + `
    UNION ALL
    SELECT CONVERT(CONCAT(` + mustMySQLLiteral(mysqlByoSessionsPrefix) + `, j.u) USING utf8mb4)
      FROM ` + unkilled + ` WHERE j.n <= ` + limit + `
    UNION ALL
    SELECT ` + more("sessions-not-ended") + ` FROM ` + unkilled + ` HAVING COUNT(*) > ` + limit + `
    UNION ALL
    SELECT CONVERT(` + mustMySQLLiteral(mysqlByoDoubtPrefix+mysqlByoSessionsUnrecorded) + ` USING utf8mb4) FROM DUAL WHERE @alethia_byo_unkilled IS NULL`
	}
	return `SELECT s.line FROM (
  SELECT 0 AS o, CONCAT(` + mustMySQLLiteral(byoResultHeaderPrefix) + `, COUNT(*)) AS line FROM (` + entries + `) r
  UNION ALL
  SELECT 1, r.line FROM (` + entries + `) r) s
    ORDER BY s.o, s.line;`
}

// mysqlByoSweepSQL renders phase 3 for an invocation with --force: each candidate's sessions ended,
// then each candidate dropped, one statement each, so a statement that fails (a KILL the administrator
// has no CONNECTION_ADMIN for; a DROP USER refused because the user is a stored object's DEFINER) is
// reported by the client and the next one still runs.
//
// Under --force a failed statement leaves every variable it would have set unchanged, so no KILL or
// DROP may ever be built from a value a failed statement could have left behind (the cursor's initial
// ” would otherwise name the anonymous account ”@'%'). Each step therefore resets the statement to
// `DO 0`, then selects the next candidate (or session) AND builds the statement acting on it in ONE
// `SELECT … INTO`: the text names only a row that statement itself read from the candidates query, or
// is `DO 0`. The cursor (the last name or id handled) is set by the same statement and only bounds
// the next selection; it is never a target. A step that fails runs `DO 0`, and the next step selects
// again above the cursor the last successful step left.
func mysqlByoSweepSQL(env string, users []byoUser) []string {
	cands := mysqlByoCandidatesSQL(env, users)
	run := []string{
		"PREPARE " + mysqlByoStmt + " FROM @" + mysqlByoStmt + ";",
		"EXECUTE " + mysqlByoStmt + ";",
		"DEALLOCATE PREPARE " + mysqlByoStmt + ";",
	}
	reset := "SET @" + mysqlByoStmt + " = 'DO 0';"
	out := []string{
		"-- phase 3a: end every candidate's sessions (a KILL that fails is reported in the Job log and skipped; the session can no longer authenticate, and the record below names its user)",
		"SET @alethia_byo_k = 0;",
	}
	for i := 0; i < mysqlByoMaxKills; i++ {
		out = append(out, reset, `SELECT MIN(p.ID), IFNULL(CONCAT('KILL ', MIN(p.ID)), 'DO 0') FROM information_schema.PROCESSLIST p
    WHERE p.ID > @alethia_byo_k AND CAST(p.USER AS BINARY) IN (SELECT CAST(c.USER AS BINARY) FROM (`+cands+`) c)
    INTO @alethia_byo_k, @`+mysqlByoStmt+`;`)
		out = append(out, run...)
	}
	out = append(out,
		"-- the record: the candidates with a session still open after the kills (all of them without PROCESS), reported after the drops",
		mysqlByoUnkilledSQL(env, users),
		"-- phase 3b: drop every candidate; its database is kept (a DROP USER that fails is reported and skipped; the user stays locked)",
		"SET @alethia_byo_u = '';",
	)
	next := "CONVERT(MIN(CAST(c.USER AS BINARY)) USING utf8mb4)"
	for i := 0; i < mysqlByoMaxDrops; i++ {
		out = append(out, reset, `SELECT `+next+`, IFNULL(CONCAT('DROP USER ', QUOTE(`+next+`), '@''%'''), 'DO 0') FROM (`+cands+`) c
    WHERE CAST(c.USER AS BINARY) > CAST(@alethia_byo_u AS BINARY)
    INTO @alethia_byo_u, @`+mysqlByoStmt+`;`)
		out = append(out, run...)
	}
	return out
}

// mysqlByoHasPrivilegeSQL is TRUE when the administrator holds one of privs (a quoted, comma-separated
// list of global privilege names), directly or through an enabled role. A privilege it cannot see
// reads as missing, so the doubt is reported, never hidden. Account names compare as BINARY: MySQL
// user names are case-sensitive and information_schema's collation is not, so otherwise another
// account that differs only in case and holds the privilege would read as the administrator holding
// it, and the warning it gates would be suppressed.
func mysqlByoHasPrivilegeSQL(privs string) string {
	grantees := `SELECT CAST(CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''', SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''') AS BINARY)
        UNION SELECT CAST(CONCAT('''', r.ROLE_NAME, '''@''', r.ROLE_HOST, '''') AS BINARY) FROM information_schema.ENABLED_ROLES r`
	return `EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES g WHERE g.PRIVILEGE_TYPE IN (` + privs + `)
      AND CAST(g.GRANTEE AS BINARY) IN (` + grantees + `))`
}

// mysqlByoCanSeeSessionsSQL is TRUE when the administrator holds PROCESS. Without it
// information_schema.PROCESSLIST lists only its own sessions, so the kill steps find nothing and no
// other user's session can be counted.
func mysqlByoCanSeeSessionsSQL() string {
	return mysqlByoHasPrivilegeSQL("'PROCESS'")
}

// mysqlByoSessionsPrefix starts a result line naming a revoked user whose open sessions this run
// could not end. The runner surfaces each as a deploy warning (provisioner byoDBUsersSessionsPrefix).
const mysqlByoSessionsPrefix = "sessions-not-ended:"

// mysqlByoDoubtPrefix starts a result line saying the run cannot vouch for part of its own report:
// `doubt:sessions-unrecorded`, or `doubt:<revocation-pending|sessions-not-ended> +<n> more` past the
// cap. The runner surfaces each as a deploy warning (provisioner byoDBUsersDoubtPrefix).
const mysqlByoDoubtPrefix = "doubt:"

// mysqlByoSessionsUnrecorded is the doubt reported when the record of unended sessions is absent.
const mysqlByoSessionsUnrecorded = "sessions-unrecorded"

// mysqlByoUnkilledSQL MEASURES, after the kills and before the drops, in ONE statement, the
// candidates with a session still open: with PROCESS, exactly those with a session in
// information_schema.PROCESSLIST that is not already being killed; without it, every candidate,
// because then no other user's session is visible and none can be ruled out. It is a measurement,
// not a prediction from privileges, so one rule covers an administrator that cannot kill, a session
// past mysqlByoMaxKills, and a kill step that failed under --force: DROP USER does not close a
// session, and a dropped user is never a candidate again, so this is the only report it gets. A
// session killed a moment ago and still listed reads as open, which over-reports, the safe
// direction. Every candidate is locked, so no session can open after the measurement. The sweep's
// result reads it back, after the drops, as `sessions-not-ended:<user>` lines; this statement never
// sets it to NULL, so NULL there means the record was lost (mysqlByoResultSQL).
func mysqlByoUnkilledSQL(env string, users []byoUser) string {
	return `SET @alethia_byo_unkilled = (SELECT IFNULL(JSON_ARRAYAGG(c.USER), JSON_ARRAY()) FROM (` + mysqlByoCandidatesSQL(env, users) + `) c
    WHERE NOT ` + mysqlByoCanSeeSessionsSQL() + `
      OR EXISTS (SELECT 1 FROM information_schema.PROCESSLIST p
        WHERE CAST(p.USER AS BINARY) = CAST(c.USER AS BINARY) AND p.COMMAND <> 'Killed'));`
}

// byoMySQLScripts is the rendered MySQL dialect: the provision script and, unless revocation is
// skipped, the sweep script.
type byoMySQLScripts struct {
	Provision string
	Sweep     string // "" with SkipRevoke
}

// mysqlByoMaxDBNameLen is MySQL's longest database name.
const mysqlByoMaxDBNameLen = 64

// renderByoUsersMySQL renders both MySQL scripts (see the file comment). in.DBName is the
// environment's database, the one the Job connects to; it is validated but appears in no statement,
// because a MySQL per-binding user works in a database of its own name. in.ResultPath is unused: the
// Job sends the invocation's output to the termination message.
func renderByoUsersMySQL(in byoUsersInput) (byoMySQLScripts, error) {
	if !byoEnvIDPattern.MatchString(in.EnvironmentID) {
		return byoMySQLScripts{}, errors.New("db-bootstrap --byo-users: --env-id is missing or not an environment ID")
	}
	if in.DBName == "" {
		return byoMySQLScripts{}, errors.New("db-bootstrap --byo-users: --db is required")
	}
	if len(in.DBName) > mysqlByoMaxDBNameLen {
		return byoMySQLScripts{}, fmt.Errorf("db-bootstrap --byo-users: database name is %d bytes; MySQL keeps at most %d", len(in.DBName), mysqlByoMaxDBNameLen)
	}
	users, err := validateByoUsers(in.Users)
	if err != nil {
		return byoMySQLScripts{}, err
	}
	salt := in.Salt
	if salt == nil {
		salt = rand.Reader
	}
	floor, err := mysqlRefuseUnless("@alethia_byo_floor = 1", mysqlByoFloorReason)
	if err != nil {
		return byoMySQLScripts{}, err
	}
	stmts := []string{
		"-- alethia db-bootstrap --byo-users (mysql), provision script. Apply with mysql -N -B, WITHOUT --force: the first error stops the run.",
		"-- Passwords are carried as caching_sha2_password hashes only. The final SELECT is the only one that returns rows.",
		"SET SESSION group_concat_max_len = 1048576;",
		"-- phase 0: refuse a server older than MySQL 8.0.21, before anything changes",
		"SET @alethia_byo_floor = 0 /*!" + mysqlByoFloorVersionID + " + 1 */;",
	}
	stmts = append(stmts, floor...)
	if in.SkipRevoke {
		stmts = append(stmts, "-- revocation skipped: the declared set is incomplete")
	} else {
		stmts = append(stmts, mysqlByoLockoutSQL(in.EnvironmentID, users)...)
	}
	stmts = append(stmts, "-- phase 2: every declared user; each stays locked until its checks have passed")
	for _, u := range users {
		s, err := cachingSHA2Salt(salt)
		if err != nil {
			return byoMySQLScripts{}, err
		}
		hash, err := cachingSHA2Hash(u.Password, s)
		if err != nil {
			return byoMySQLScripts{}, err
		}
		block, err := mysqlByoProvisionSQL(in.EnvironmentID, u, hash)
		if err != nil {
			return byoMySQLScripts{}, err
		}
		stmts = append(stmts, block...)
	}
	stmts = append(stmts, "-- result: the provisioned set, the only rows this script returns", mysqlByoResultSQL(in.EnvironmentID, users, false))
	out := byoMySQLScripts{Provision: strings.Join(stmts, "\n") + "\n"}
	if in.SkipRevoke {
		return out, nil
	}
	sweep := []string{
		"-- alethia db-bootstrap --byo-users (mysql), sweep script. Apply with mysql -N -B --force, after the provision script.",
		"SET SESSION group_concat_max_len = 1048576;",
	}
	sweep = append(sweep, mysqlByoSweepSQL(in.EnvironmentID, users)...)
	sweep = append(sweep, "-- result: the provisioned set and every candidate still present", mysqlByoResultSQL(in.EnvironmentID, users, true))
	out.Sweep = strings.Join(sweep, "\n") + "\n"
	return out, nil
}
