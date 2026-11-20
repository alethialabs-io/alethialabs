// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/credstore"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/golang-jwt/jwt/v5"
	"github.com/imroc/req/v3"
)

// credentialsFileMode is the permission mode of the CLI credentials file. It holds the
// live access token, the 90-day refresh token and the raw git-provider OAuth token, so
// it is owner read/write only — never group- or world-readable. os.Create asks for 0666
// and leaves the result to the caller's umask (0644 under the common 022), which on a
// shared box, a CI runner or a container layer lets any other local uid read the bearer
// and act as the user. Matches utils.SecretFileMode and the 0600 the CLI already uses
// for its non-secret config and the update cache.
const credentialsFileMode os.FileMode = 0o600

// userCodeAlphabet is RFC 8628 §6.1's recommended character set — upper-case consonants,
// so it spells no words and carries no digits — minus L, which is read back as 1 as often
// as I and O are read back as 1 and 0. No 0/O, no 1/I/L, nothing a user can mistype.
const userCodeAlphabet = "BCDFGHJKMNPQRSTVWXZ"

// userCodeLength is how many alphabet characters a user_code carries (excluding the
// separator): 19^8 ≈ 1.7e10 combinations, short enough to read off a terminal.
const userCodeLength = 8

// configDirMode is the permission mode of the CLI's own configuration directory: the owner and
// nobody else. It holds the credentials file when one is used, and the preferences beside it.
const configDirMode os.FileMode = 0o700

// credentialStoreTimeout is how long the system keychain is given to answer one call. A keychain
// that is waiting for an unlock nobody will give must not hold the command; past the limit the
// credentials file is used instead.
const credentialStoreTimeout = 3 * time.Second

// credentialStore is the system keychain as the CLI reaches it. It is a variable so a test can put
// another Store in its place.
var credentialStore = credstore.Bounded(credstore.Keyring(), credentialStoreTimeout)

func getCredentialsPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "alethia", "credentials.json"), nil
}

func getAuthToken() (string, error) {
	return getAuthTokenInternal(true)
}

// ServiceTokenEnv is the environment variable a NON-INTERACTIVE caller sets instead of logging in.
//
// This is the whole mechanism behind "drive Alethia from your own CI". Before it, the only way in
// was the device flow — `alethia login` opens a browser and waits for a human to approve — which is
// the right experience at a terminal and an impossible one in a pipeline. `--no-input` did not help:
// it suppresses PROMPTS, it does not supply a credential, so a pipeline still failed with
// "authentication required. Please run `alethia login`".
const ServiceTokenEnv = "ALETHIA_TOKEN"

// serviceTokenFlag is the --token value, set by the root command's persistent flag. The flag WINS
// over the environment, matching every other tool's precedence: the more specific, more deliberate
// source is the one nearer the invocation.
var serviceTokenFlag string

// serviceToken returns the non-interactive credential, if one was supplied.
//
// Trimmed, because a token pasted into a CI secret picks up a trailing newline more often than not,
// and a credential that fails for an invisible reason is the worst kind to debug.
func serviceToken() string {
	token, _ := suppliedToken()
	return token
}

// credentialSource names where the credential of the running command came from.
type credentialSource string

// The four places a credential can come from, in the order they are consulted.
const (
	// credentialFromFlag is the --token flag.
	credentialFromFlag credentialSource = "flag"
	// credentialFromEnv is the ALETHIA_TOKEN environment variable.
	credentialFromEnv credentialSource = "env"
	// credentialFromKeychain is the operating system's credential store.
	credentialFromKeychain credentialSource = "keychain"
	// credentialFromFile is the owner-only credentials file in the CLI's configuration directory.
	credentialFromFile credentialSource = "file"
)

// suppliedToken returns the token the caller supplied directly and which of the two ways it came:
// the --token flag first, then the environment. It returns "" when neither is set.
func suppliedToken() (string, credentialSource) {
	if t := strings.TrimSpace(serviceTokenFlag); t != "" {
		return t, credentialFromFlag
	}
	if t := strings.TrimSpace(os.Getenv(ServiceTokenEnv)); t != "" {
		return t, credentialFromEnv
	}
	return "", ""
}

// storedCredential is a sign-in as the CLI keeps it, in the system keychain or in the credentials
// file: the tokens the control plane issued, and the control plane that issued them.
//
// The token fields are the embedded exchange response, so a credentials file an older CLI wrote
// reads as one with no origin, and a file this CLI writes still reads in an older one.
type storedCredential struct {
	types.ExchangeResponse
	// Origin is the control-plane URL that issued the credential. A credential is used for that
	// control plane and no other.
	Origin string `json:"origin,omitempty"`
	// KeepInFile records that the user asked for the credentials file with --insecure-storage, so a
	// later renewal does not move the credential into the keychain.
	KeepInFile bool `json:"keep_in_file,omitempty"`
}

// credentialPlaceholder is what a stored credential prints as.
const credentialPlaceholder = "credential (redacted)"

// String keeps a credential out of anything that formats it: a log line, an error, a test failure.
func (storedCredential) String() string { return credentialPlaceholder }

// GoString is String for the %#v verb.
func (storedCredential) GoString() string { return credentialPlaceholder }

// authRequiredMessage is the sentence every command reports when it has no credential to send.
const authRequiredMessage = "authentication required. Please run `alethia login`"

// errNotSignedIn is what resolving a credential returns when there is none to send. It is a plain
// sentinel: every command in the tree receives it from getAuthToken, and the exit code those
// commands report for it is theirs to change. The commands of this family report it through
// asAuthRequired, which gives it the authentication class.
var errNotSignedIn = errors.New(authRequiredMessage)

// asAuthRequired gives a missing credential the authentication class, so the command exits with the
// code that class owns and names the next step. Any other error is returned as it came.
func asAuthRequired(err error) error {
	if !errors.Is(err, errNotSignedIn) {
		return err
	}
	e := clierr.Wrap(clierr.CodeAuthRequired, err)
	e.Hint = "alethia login   (in a pipeline, set " + ServiceTokenEnv + " to a service token instead)"
	return e
}

// normalizeOrigin reduces a control-plane URL to the part that identifies it: scheme and host in
// lower case, with no path and no trailing slash.
func normalizeOrigin(origin string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(origin), "/")
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return strings.ToLower(trimmed)
	}
	return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host)
}

// credentialAccount is the keychain account a control plane's credential is filed under: its host,
// with the port when the URL names one.
func credentialAccount(origin string) string {
	parsed, err := url.Parse(strings.TrimSpace(origin))
	if err != nil || parsed.Host == "" {
		return normalizeOrigin(origin)
	}
	return strings.ToLower(parsed.Host)
}

// issuedBy reports whether cred may be used for origin. A credential that records no origin was
// written before origins were recorded, and is accepted.
func (c storedCredential) issuedBy(origin string) bool {
	return c.Origin == "" || normalizeOrigin(c.Origin) == normalizeOrigin(origin)
}

// readKeychainCredential returns the credential the system keychain holds for origin. It returns
// credstore.ErrNotFound when there is none it can use, and the store's own error when the store
// could not be asked.
func readKeychainCredential(origin string) (storedCredential, error) {
	var cred storedCredential
	secret, err := credentialStore.Get(credentialAccount(origin))
	if err != nil {
		return cred, err
	}
	if err := json.Unmarshal([]byte(secret), &cred); err != nil || cred.AccessToken == "" || !cred.issuedBy(origin) {
		return storedCredential{}, credstore.ErrNotFound
	}
	return cred, nil
}

// readFileCredential returns the credential in the credentials file when it may be used for origin.
// It returns errNotSignedIn when the file is absent, is not a credential, or belongs to another
// control plane.
func readFileCredential(origin string) (storedCredential, error) {
	var cred storedCredential
	path, err := getCredentialsPath()
	if err != nil {
		return cred, fmt.Errorf("error getting credentials path: %w", err)
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return cred, errNotSignedIn
	}
	if err != nil {
		return cred, fmt.Errorf("error reading credentials file: %w", err)
	}
	if err := json.Unmarshal(data, &cred); err != nil || cred.AccessToken == "" || !cred.issuedBy(origin) {
		return storedCredential{}, errNotSignedIn
	}
	return cred, nil
}

// loadStoredCredential returns the stored sign-in for the current control plane and where it was
// found: the system keychain first, then the credentials file. A keychain that cannot be asked is
// passed over without a word, because the file is the stated fallback for exactly that host.
func loadStoredCredential() (storedCredential, credentialSource, error) {
	origin := WebOrigin()
	if cred, err := readKeychainCredential(origin); err == nil {
		return cred, credentialFromKeychain, nil
	}
	cred, err := readFileCredential(origin)
	if err != nil {
		return storedCredential{}, "", err
	}
	return cred, credentialFromFile, nil
}

// credentialWrite reports where a credential was stored.
type credentialWrite struct {
	// Source is where the credential now lives.
	Source credentialSource
	// Path is the credentials file, when Source is the file.
	Path string
	// Migrated reports that a credentials file was replaced by the keychain entry and removed.
	Migrated bool
	// MigratedFrom is the file that was removed, when Migrated is set.
	MigratedFrom string
	// Requested reports that the file was used because the user asked for it.
	Requested bool
}

// storeCredential stores cred for the current control plane: in the system keychain when it works,
// otherwise in the owner-only credentials file.
//
// The keychain is believed only after the entry has been read back and matches what was written.
// Until then the credentials file is left exactly as it was; after it, the file is removed, so a
// credential is never in both places and never in neither.
func storeCredential(cred storedCredential) (credentialWrite, error) {
	origin := WebOrigin()
	cred.Origin = normalizeOrigin(origin)
	account := credentialAccount(origin)

	if !cred.KeepInFile && writeKeychainCredential(account, cred) {
		write := credentialWrite{Source: credentialFromKeychain}
		path, err := getCredentialsPath()
		if err != nil {
			// No configuration directory, so no credentials file to remove either.
			return write, nil
		}
		switch err := os.Remove(path); {
		case err == nil:
			write.Migrated, write.MigratedFrom = true, path
		case !errors.Is(err, os.ErrNotExist):
			return write, fmt.Errorf(
				"the credential is in the system keychain, but the credentials file %s could not be removed: %w",
				path, err)
		}
		return write, nil
	}

	path, err := getCredentialsPath()
	if err != nil {
		return credentialWrite{}, fmt.Errorf("error getting credentials path: %w", err)
	}
	if err := writeCredentialFile(path, cred); err != nil {
		return credentialWrite{}, err
	}
	// The keychain outranks the file when a credential is read, so an entry left there would hide
	// the one just written. Nothing to do when the keychain cannot be reached: it cannot be read
	// either.
	_ = credentialStore.Delete(account)
	return credentialWrite{Source: credentialFromFile, Path: path, Requested: cred.KeepInFile}, nil
}

// writeKeychainCredential stores cred in the system keychain under account and reports whether the
// entry read back is the one that was written. An entry that does not read back is removed.
func writeKeychainCredential(account string, cred storedCredential) bool {
	// A credential is strings and one flag, so encoding it cannot fail.
	payload, _ := json.Marshal(cred)
	if err := credentialStore.Set(account, string(payload)); err != nil {
		return false
	}
	if got, err := credentialStore.Get(account); err == nil && got == string(payload) {
		return true
	}
	_ = credentialStore.Delete(account)
	return false
}

// reportCredentialWrite says, in one line on stderr, where a credential was stored. After a sign-in
// it always says; after a renewal it says only when the credential moved, so an ordinary command
// stays quiet.
func reportCredentialWrite(write credentialWrite, previous credentialSource, signedIn bool) {
	switch {
	case write.Migrated:
		printer.Note(fmt.Sprintf(
			"Credential moved into the system keychain; the credentials file %s was removed.", write.MigratedFrom))
	case write.Source == credentialFromKeychain:
		if signedIn {
			printer.Note("Credential stored in the system keychain.")
		}
	case write.Requested:
		if signedIn {
			printer.Note(fmt.Sprintf(
				"Credential stored in the owner-only file %s, as --insecure-storage asked.", write.Path))
		}
	case signedIn || previous != credentialFromFile:
		printer.Note(fmt.Sprintf(
			"No system keychain is available here, so the credential is stored in the owner-only file %s.", write.Path))
	}
}

// tokenClaims reads the claims an access token carries, without verifying it: the control plane
// verifies, the CLI only needs to know when to renew. It reports false for a token that is not one.
func tokenClaims(token string) (jwt.MapClaims, bool) {
	claims := jwt.MapClaims{}
	if _, _, err := jwt.NewParser().ParseUnverified(token, claims); err != nil {
		return nil, false
	}
	return claims, true
}

// tokenExpiry returns when an access token stops being accepted, read from the token itself. It
// reports false for a token that does not say.
func tokenExpiry(token string) (time.Time, bool) {
	claims, ok := tokenClaims(token)
	if !ok {
		return time.Time{}, false
	}
	// The parser decodes a number as a float64, so that is the one shape an expiry has.
	exp, ok := claims["exp"].(float64)
	if !ok {
		return time.Time{}, false
	}
	return time.Unix(int64(exp), 0), true
}

// tokenRenewalMargin is how long before its expiry a stored access token is renewed.
const tokenRenewalMargin = time.Minute

func getAuthTokenInternal(promptLogin bool) (string, error) {
	// A supplied token SHORT-CIRCUITS the whole stored-credential dance: nothing is read, no renewal
	// is attempted, nothing is written to the keychain or to disk. That is the point — a CI runner
	// has no home directory worth persisting to, and a credential written to one is a credential
	// left behind.
	//
	// It is checked FIRST so that setting it works even on a machine that happens to hold a stale
	// sign-in: an explicit credential must not be silently outranked by an implicit one. It also
	// has nothing to renew it with, so no renewal is registered for it.
	if t := serviceToken(); t != "" {
		api.SetTokenRefresher(nil)
		return t, nil
	}

	cred, source, err := loadStoredCredential()
	if errors.Is(err, errNotSignedIn) {
		// The interactive "log in now?" prompt + device flow is irreducible TUI
		// glue (see resolveLogin in login.go); keep it out of this token-state logic.
		return resolveLogin("", promptLogin)
	}
	if err != nil {
		return "", err
	}

	token, err := usableAccessToken(cred, source)
	if errors.Is(err, errCredentialUnusable) {
		return resolveLogin("", promptLogin)
	}
	if err != nil {
		return "", err
	}
	if cred.RefreshToken == "" {
		api.SetTokenRefresher(nil)
	} else {
		// The credential came from the store, so there is something to renew it with when the
		// control plane refuses it mid-command.
		api.SetTokenRefresher(renewStoredCredential)
	}
	return token, nil
}

// errCredentialUnusable is the answer for a stored credential that has expired and cannot be renewed.
var errCredentialUnusable = errors.New("the stored credential has expired and could not be renewed")

// usableAccessToken returns cred's access token, renewing it first when it has expired or is about
// to. A failure to save the renewed credential is returned as it is; every other failure is
// errCredentialUnusable, which the caller answers by asking for a sign-in.
func usableAccessToken(cred storedCredential, source credentialSource) (string, error) {
	if _, ok := tokenClaims(cred.AccessToken); !ok {
		return "", errCredentialUnusable
	}
	// A token that names no expiry is treated as expired, so it is renewed rather than trusted.
	expires, _ := tokenExpiry(cred.AccessToken)
	if expires.After(time.Now().Add(tokenRenewalMargin)) {
		return cred.AccessToken, nil
	}
	if cred.RefreshToken == "" {
		return "", errCredentialUnusable
	}
	// STDERR, not stdout. This line is a diagnostic about the session, not part of the answer the
	// command was asked for: on stdout it lands INSIDE `alethia jobs list -o json > jobs.json`
	// whenever the stored token happens to be in its last minute, and the file no longer parses.
	fmt.Fprintln(os.Stderr, "Access token expired, refreshing...")
	renewed, err := renewCredential(cred, source)
	var saveErr *credentialSaveError
	if errors.As(err, &saveErr) {
		return "", err
	}
	if err != nil {
		return "", errCredentialUnusable
	}
	return renewed, nil
}

// credentialSaveError is a renewed credential that could not be stored.
type credentialSaveError struct{ cause error }

// Error names the failure without naming the credential.
func (e *credentialSaveError) Error() string {
	return fmt.Sprintf("failed to save new credentials: %v", e.cause)
}

// Unwrap returns the underlying failure.
func (e *credentialSaveError) Unwrap() error { return e.cause }

// renewCredential exchanges cred's refresh token for a new access token, stores the result and
// returns the new token. A credentials file is moved into the keychain by the same write.
func renewCredential(cred storedCredential, source credentialSource) (string, error) {
	renewed, err := refreshAccessToken(cred.RefreshToken)
	if err != nil {
		return "", err
	}
	cred.AccessToken = renewed
	write, err := storeCredential(cred)
	if err != nil {
		return "", &credentialSaveError{cause: err}
	}
	reportCredentialWrite(write, source, false)
	return renewed, nil
}

// renewStoredCredential is what the API client calls when the control plane refuses the token of a
// request in flight: it renews the stored credential once and returns the new access token. It is
// registered only for a credential that came from the store.
func renewStoredCredential() (string, error) {
	if serviceToken() != "" {
		return "", errors.New("a supplied token cannot be renewed")
	}
	cred, source, err := loadStoredCredential()
	if err != nil {
		return "", err
	}
	if cred.RefreshToken == "" {
		return "", errCredentialUnusable
	}
	return renewCredential(cred, source)
}

func refreshAccessToken(refreshToken string) (string, error) {
	refreshURL := fmt.Sprintf("%s/api/auth/cli/refresh", WebOrigin())

	client := req.C()
	var result struct {
		AccessToken string `json:"access_token"`
	}
	var errMsg struct {
		Error string `json:"error"`
	}

	resp, err := client.R().
		SetBody(map[string]string{"refresh_token": refreshToken}).
		SetSuccessResult(&result).
		SetErrorResult(&errMsg).
		Post(refreshURL)

	if err != nil {
		return "", err
	}

	if resp.IsErrorState() {
		return "", fmt.Errorf("server returned %d: %s", resp.StatusCode, errMsg.Error)
	}

	// Fail closed on a 2xx that carries no token. A captive-portal 200, a content-type
	// change or a schema drift would otherwise yield ("", nil) — and getAuthTokenInternal
	// would take its success branch, persist the empty token over the stored credential
	// and hand the caller an `Authorization: Bearer ` header.
	if result.AccessToken == "" {
		return "", fmt.Errorf("refresh succeeded (HTTP %d) but returned no access_token", resp.StatusCode)
	}

	return result.AccessToken, nil
}

// ensureConfigDir creates the CLI's configuration directory for the owner alone, and takes group and
// world access away from one that already exists with more. It only ever removes access, so a
// directory the owner made read-only stays read-only. The tightening is best-effort: on a
// filesystem without POSIX modes the directory still works.
func ensureConfigDir(dir string) error {
	if err := os.MkdirAll(dir, configDirMode); err != nil {
		return err
	}
	if info, err := os.Stat(dir); err == nil {
		if mode := info.Mode().Perm(); mode&^configDirMode != 0 {
			_ = os.Chmod(dir, mode&configDirMode)
		}
	}
	return nil
}

// saveCredentials writes creds to path with owner-only (0600) permissions. It also
// tightens an already-existing looser file, so a credentials.json an older CLI created
// world-readable is repaired the first time a token refresh writes through here.
func saveCredentials(path string, creds types.ExchangeResponse) error {
	return writeCredentialFile(path, storedCredential{ExchangeResponse: creds})
}

// credentialTempPattern names the file a credential is written to before it is renamed into place.
const credentialTempPattern = ".credentials-*"

// credentialTempPrefix is what every such file's name starts with.
var credentialTempPrefix = strings.TrimSuffix(credentialTempPattern, "*")

// removeCredentialTempFiles deletes what an interrupted write left beside the credentials file, and
// reports whether there was anything. A write that completes leaves nothing behind, and a
// directory that is not there holds nothing.
func removeCredentialTempFiles(dir string) (bool, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	removed := false
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), credentialTempPrefix) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil {
			return removed, err
		}
		removed = true
	}
	return removed, nil
}

// writeCredentialFile writes cred to path as an owner-only (0600) file. The file is written beside
// its destination and renamed into place, so a reader sees the old credential or the new one and
// never half of either, and a file an older CLI left with wider access is replaced by a tight one.
func writeCredentialFile(path string, cred storedCredential) error {
	dir := filepath.Dir(path)
	if err := ensureConfigDir(dir); err != nil {
		return err
	}
	// os.CreateTemp creates the file 0600, whatever the umask.
	tmp, err := os.CreateTemp(dir, credentialTempPattern)
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	// Best-effort: on a filesystem without POSIX modes the write is what matters.
	_ = tmp.Chmod(credentialsFileMode)

	encoder := json.NewEncoder(tmp)
	encoder.SetIndent("", "  ")
	writeErr := encoder.Encode(cred)
	if closeErr := tmp.Close(); writeErr == nil {
		writeErr = closeErr
	}
	if writeErr == nil {
		writeErr = os.Rename(tmpPath, path)
	}
	if writeErr != nil {
		_ = os.Remove(tmpPath)
		return writeErr
	}
	return nil
}

// newUserCode returns a fresh RFC 8628 user_code — eight characters from an unambiguous
// alphabet, hyphenated in the middle so it reads back cleanly ("BCDF-GHJK"). The CLI
// prints it next to the login URL and the browser shows the code it is about to approve,
// so a user handed a phished device-code link can see it is not the one their terminal
// printed and refuse.
//
// The modulo is very slightly biased (256 mod 19 ≠ 0). That is deliberate and harmless:
// the user_code is a value a human compares, not the credential — the device_code is
// still a 122-bit UUID, and the code is useless without it.
func newUserCode() string {
	buf := make([]byte, userCodeLength)
	// crypto/rand.Read never returns an error — it fills the buffer entirely or panics —
	// so there is no error arm to handle here.
	_, _ = rand.Read(buf)

	out := make([]byte, 0, userCodeLength+1)
	for i, b := range buf {
		if i == userCodeLength/2 {
			out = append(out, '-')
		}
		out = append(out, userCodeAlphabet[int(b)%len(userCodeAlphabet)])
	}
	return string(out)
}
