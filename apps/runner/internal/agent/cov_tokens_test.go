// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Coverage proofs for the keyless token surfaces that previously only ran in-cluster: the three
// refresher loops (db-token / registry-token / helm-repo-token) past their first sleep, the cloud
// minters behind them, and both db-authproxy wire halves end to end — app handshake, token mint,
// TLS upstream authentication and splice.
//
// Everything here is offline and deterministic. The refresher sleep is driven through the
// committed refreshTimer seam; the AWS SDK is pointed at a local stub through AWS_ENDPOINT_URL;
// GCP credentials are a generated service account whose token_uri is a local server; and the
// upstream database is a loopback TLS listener trusted through the upstreamTLSConfig seam. No
// test reads an ambient credential, a cloud endpoint or the wall clock.
package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ─── shared harness ──────────────────────────────────────────────────────────────────────────

// tokMintStep is one scripted answer from a stubbed minter: a credential and how long it is
// valid, or the failure the loop must survive.
type tokMintStep struct {
	token string
	ttl   time.Duration
	err   error
}

// tokFireTimer replaces the shared refresher sleep with one that fires immediately for the first
// n waits and then never fires, so a loop's post-sleep arms run without any delay and the loop
// afterwards parks on the context instead of racing the script.
func tokFireTimer(t *testing.T, n int) {
	t.Helper()
	prev := refreshTimer
	var calls atomic.Int64
	refreshTimer = func(time.Duration) <-chan time.Time {
		if calls.Add(1) > int64(n) {
			return nil // a nil channel blocks forever: the ctx.Done arm wins
		}
		ch := make(chan time.Time, 1)
		ch <- time.Time{}
		return ch
	}
	t.Cleanup(func() { refreshTimer = prev })
}

// tokScript walks steps, cancelling ctx as the LAST step is served. The loop therefore performs
// its final write/patch and then returns ctx.Err() from the select — no goroutine, no sleep and
// no ordering ambiguity between the assertion and the loop.
func tokScript(t *testing.T, cancel context.CancelFunc, steps []tokMintStep) func() (string, time.Time, error) {
	t.Helper()
	i := 0
	return func() (string, time.Time, error) {
		if i >= len(steps) {
			t.Errorf("the minter was called %d times but the script has %d steps", i+1, len(steps))
			cancel()
			return "", time.Time{}, errors.New("script exhausted")
		}
		s := steps[i]
		i++
		if i == len(steps) {
			cancel()
		}
		return s.token, time.Now().Add(s.ttl), s.err
	}
}

// tokIsolateAWS points the AWS SDK at static fake credentials and away from IMDS, any ambient
// profile and any shared config file, so a mint behaves identically on a laptop that holds real
// credentials and in CI which holds none.
func tokIsolateAWS(t *testing.T) {
	t.Helper()
	// Every other credential source the SDK would consult — a CI runner's OIDC role, an ECS task
	// role, an ambient endpoint override — is removed, not merely overridden.
	tokUnsetEnv(t,
		"AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_DEFAULT_PROFILE",
		"AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_ECR", "AWS_ENDPOINT_URL_ECR_PUBLIC", "AWS_ENDPOINT_URL_STS",
	)
	missing := filepath.Join(t.TempDir(), "no-such-aws-file")
	for k, v := range map[string]string{
		"AWS_ACCESS_KEY_ID":           "AKIAALETHIATEST",
		"AWS_SECRET_ACCESS_KEY":       "alethia-test-secret",
		"AWS_EC2_METADATA_DISABLED":   "true",
		"AWS_REGION":                  "eu-west-1",
		"AWS_DEFAULT_REGION":          "eu-west-1",
		"AWS_CONFIG_FILE":             missing,
		"AWS_SHARED_CREDENTIALS_FILE": missing,
	} {
		t.Setenv(k, v)
	}
}

// tokUnsetEnv removes variables for the duration of the test — t.Setenv first so the ambient
// value is restored afterwards, then a real Unsetenv, because a variable set to "" is still
// "present" to some readers.
func tokUnsetEnv(t *testing.T, keys ...string) {
	t.Helper()
	for _, k := range keys {
		t.Setenv(k, "x")
		if err := os.Unsetenv(k); err != nil {
			t.Fatalf("unset %s: %v", k, err)
		}
	}
}

// tokStubAWS starts a local endpoint that answers the two AWS calls these minters make — the STS
// AssumeRole of a cross-account role and the ECR / ECR-Public authorization-token fetch — and
// points every AWS client at it. authToken is served verbatim so a malformed one can be tested;
// an empty data set is served when authToken is "".
func tokStubAWS(t *testing.T, authToken string, expiresAt *time.Time, public bool) {
	t.Helper()
	tokIsolateAWS(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Amz-Target") == "" {
			// STS speaks query/XML and carries no target header.
			w.Header().Set("Content-Type", "text/xml")
			_, _ = w.Write([]byte(`<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">` +
				`<AssumeRoleResult><Credentials>` +
				`<AccessKeyId>ASIAALETHIATEST</AccessKeyId><SecretAccessKey>assumed-secret</SecretAccessKey>` +
				`<SessionToken>assumed-token</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration>` +
				`</Credentials><AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/pull/session</Arn>` +
				`<AssumedRoleId>AROATEST:session</AssumedRoleId></AssumedRoleUser></AssumeRoleResult>` +
				`</AssumeRoleResponse>`))
			return
		}
		entry := map[string]any{}
		if authToken != "" {
			entry["authorizationToken"] = authToken
		}
		if expiresAt != nil {
			entry["expiresAt"] = float64(expiresAt.Unix())
		}
		var payload map[string]any
		switch {
		case authToken == "" && expiresAt == nil && public:
			payload = map[string]any{}
		case authToken == "" && expiresAt == nil:
			payload = map[string]any{"authorizationData": []map[string]any{}}
		case public:
			payload = map[string]any{"authorizationData": entry}
		default:
			payload = map[string]any{"authorizationData": []map[string]any{entry}}
		}
		b, err := json.Marshal(payload)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/x-amz-json-1.1")
		_, _ = w.Write(b)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AWS_ENDPOINT_URL", srv.URL)
}

// tokStubAWSRefuses points every AWS client at an endpoint that refuses the authorization-token
// call with a non-retryable client error, so the minters' service-error arms run without waiting
// out a retry ladder.
func tokStubAWSRefuses(t *testing.T) {
	t.Helper()
	tokIsolateAWS(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-amz-json-1.1")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"__type":"AccessDeniedException","message":"not authorized to perform ecr:GetAuthorizationToken"}`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AWS_ENDPOINT_URL", srv.URL)
}

// tokECRToken renders ECR's base64("user:password") authorization token.
func tokECRToken(user, pass string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
}

// ─── db-token: the refresh loop ──────────────────────────────────────────────────────────────

// TestTok_DBTokenLoop_RefreshRewritesAndSurvivesAFailedMint pins the sidecar's whole steady state:
// after the sleep it re-mints and re-writes the file, a failed refresh keeps the LAST good token
// on disk instead of truncating it, and a cancelled context ends the loop with the context error.
func TestTok_DBTokenLoop_RefreshRewritesAndSurvivesAFailedMint(t *testing.T) {
	tokFireTimer(t, 2)
	out := filepath.Join(t.TempDir(), "token")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	next := tokScript(t, cancel, []tokMintStep{
		{token: "first", ttl: time.Hour},
		{err: errors.New("identity endpoint blip")},
		{token: "third", ttl: time.Hour},
	})
	mint := func(context.Context) (string, time.Time, error) { return next() }

	err := runDBTokenLoop(ctx, mint, out, false)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("runDBTokenLoop = %v, want the context error", err)
	}
	got, rerr := os.ReadFile(out)
	if rerr != nil {
		t.Fatalf("read token file: %v", rerr)
	}
	if string(got) != "third" {
		t.Errorf("token file = %q, want the last successful mint", got)
	}
}

// TestTok_DBTokenLoop_KeepsLastTokenWhenTheRefreshFails proves the availability rule on its own:
// a refresh that never succeeds leaves the previously written credential untouched.
func TestTok_DBTokenLoop_KeepsLastTokenWhenTheRefreshFails(t *testing.T) {
	tokFireTimer(t, 1)
	out := filepath.Join(t.TempDir(), "token")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	next := tokScript(t, cancel, []tokMintStep{
		{token: "good", ttl: time.Hour},
		{err: errors.New("throttled")},
	})
	mint := func(context.Context) (string, time.Time, error) { return next() }

	if err := runDBTokenLoop(ctx, mint, out, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("runDBTokenLoop = %v, want the context error", err)
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read token file: %v", err)
	}
	if string(got) != "good" {
		t.Errorf("token file = %q, want the last good token kept", got)
	}
}

// TestTok_DBTokenLoop_FatalPaths locks the two failures that must take the sidecar down rather
// than leave a pod running against a credential that is missing or stale: the FIRST mint, and any
// write of the token file.
func TestTok_DBTokenLoop_FatalPaths(t *testing.T) {
	ctx := context.Background()
	mintErr := errors.New("no workload identity")
	fail := func(context.Context) (string, time.Time, error) { return "", time.Time{}, mintErr }
	err := runDBTokenLoop(ctx, fail, filepath.Join(t.TempDir(), "token"), true)
	if !errors.Is(err, mintErr) {
		t.Fatalf("initial mint failure = %v, want it fatal", err)
	}

	ok := func(context.Context) (string, time.Time, error) { return "tok", time.Now().Add(time.Hour), nil }
	err = runDBTokenLoop(ctx, ok, filepath.Join(t.TempDir(), "missing-dir", "token"), true)
	if err == nil || !strings.Contains(err.Error(), "db-token: write") {
		t.Fatalf("initial write failure = %v, want the write error", err)
	}

	// A write that fails on a LATER pass is fatal too — the file on disk is now stale and the
	// workload would authenticate with an expiring credential.
	tokFireTimer(t, 1)
	dir := t.TempDir()
	out := filepath.Join(dir, "sub", "token")
	if mkErr := os.MkdirAll(filepath.Dir(out), 0o700); mkErr != nil {
		t.Fatalf("mkdir: %v", mkErr)
	}
	calls := 0
	vanishing := func(context.Context) (string, time.Time, error) {
		calls++
		if calls == 2 {
			if rmErr := os.RemoveAll(filepath.Dir(out)); rmErr != nil {
				t.Errorf("remove token dir: %v", rmErr)
			}
		}
		return "tok", time.Now().Add(time.Hour), nil
	}
	err = runDBTokenLoop(context.Background(), vanishing, out, false)
	if err == nil || !strings.Contains(err.Error(), "db-token: write") {
		t.Fatalf("refresh write failure = %v, want the write error", err)
	}
}

// TestTok_WriteTokenFile_RefusesAnUnusableDirectory covers the temp-file creation failure: the
// token is never written outside the requested directory as a fallback.
func TestTok_WriteTokenFile_RefusesAnUnusableDirectory(t *testing.T) {
	err := writeTokenFile(filepath.Join(t.TempDir(), "absent", "token"), "secret")
	if err == nil {
		t.Fatal("writing into a missing directory must fail")
	}
	if strings.Contains(err.Error(), "secret") {
		t.Errorf("the error must not carry the token: %v", err)
	}
}

// ─── db-token: the subcommand + its minters ──────────────────────────────────────────────────

// TestTok_RunDBToken_Dispatch covers the sidecar entry point's provider switch: an unparseable
// flag set, the Azure branch (which fails closed off-cluster), and the AWS branch minting a real
// presigned RDS token and writing it once.
func TestTok_RunDBToken_Dispatch(t *testing.T) {
	if err := RunDBToken(context.Background(), []string{"--nope"}); err == nil {
		t.Fatal("an unknown flag must fail the subcommand")
	}

	err := RunDBToken(context.Background(), []string{
		"--provider", "azure", "--out", filepath.Join(t.TempDir(), "token"), "--once",
	})
	if err == nil || !strings.Contains(err.Error(), "db-token: initial mint") {
		t.Fatalf("azure off-cluster = %v, want the fail-fast initial mint error", err)
	}

	tokIsolateAWS(t)
	out := filepath.Join(t.TempDir(), "token")
	if err := RunDBToken(context.Background(), []string{
		"--provider", "aws", "--out", out, "--once",
		"--host", "db.eu-west-1.rds.amazonaws.com", "--port", "5432",
		"--region", "eu-west-1", "--user", "alethia_app",
	}); err != nil {
		t.Fatalf("RunDBToken aws: %v", err)
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read token file: %v", err)
	}
	if !strings.HasPrefix(string(got), "db.eu-west-1.rds.amazonaws.com:5432?Action=connect") {
		t.Errorf("token = %q, want a presigned RDS connect URL", got)
	}
	if !strings.Contains(string(got), "X-Amz-Expires") {
		t.Errorf("token = %q, want a presigned URL carrying an expiry", got)
	}
}

// TestTok_MintAWSDBToken covers all three arms of the RDS IAM minter: a config that cannot be
// loaded, credentials that cannot be resolved, and the successful in-process presign whose expiry
// is derived from the AWS-fixed 15-minute TTL.
func TestTok_MintAWSDBToken(t *testing.T) {
	tokIsolateAWS(t)
	t.Setenv("AWS_PROFILE", "no-such-profile")
	if _, _, err := mintAWSDBToken(context.Background(), "db.test:5432", "eu-west-1", "app"); err == nil ||
		!strings.Contains(err.Error(), "load AWS config") {
		t.Fatalf("err = %v, want the config-load failure", err)
	}

	tokIsolateAWS(t)
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	if _, _, err := mintAWSDBToken(context.Background(), "db.test:5432", "eu-west-1", "app"); err == nil ||
		!strings.Contains(err.Error(), "build RDS auth token") {
		t.Fatalf("err = %v, want the credential-resolution failure", err)
	}

	tokIsolateAWS(t)
	before := time.Now()
	tok, exp, err := mintAWSDBToken(context.Background(), "db.test:5432", "eu-west-1", "app")
	if err != nil {
		t.Fatalf("mintAWSDBToken: %v", err)
	}
	if !strings.Contains(tok, "DBUser=app") {
		t.Errorf("token %q must be signed for the requested user", tok)
	}
	if exp.Before(before.Add(awsRDSTokenTTL - time.Minute)) {
		t.Errorf("expiry %v is not the derived %v TTL", exp, awsRDSTokenTTL)
	}
}

// TestTok_MintAzureDBToken_FailsClosedWithoutWorkloadIdentity pins the off-cluster refusal: with
// no federated-identity environment the credential is never constructed, so no token request is
// attempted at all.
func TestTok_MintAzureDBToken_FailsClosedWithoutWorkloadIdentity(t *testing.T) {
	tokClearAzureEnv(t)
	_, _, err := mintAzureDBToken(context.Background())
	if err == nil || !strings.Contains(err.Error(), "azure workload identity credential") {
		t.Fatalf("err = %v, want the credential-construction refusal", err)
	}
}

// tokClearAzureEnv removes every Azure Workload Identity variable for the test, restoring the
// ambient values afterwards, so the credential constructor fails locally instead of reaching an
// identity endpoint.
func tokClearAzureEnv(t *testing.T) {
	t.Helper()
	tokUnsetEnv(t, "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_FEDERATED_TOKEN_FILE", "AZURE_AUTHORITY_HOST")
}

// ─── registry-token ──────────────────────────────────────────────────────────────────────────

// TestTok_RegistryTokenLoop_RefreshRepatchesAndSurvivesAFailedMint is the pull-secret twin of the
// db-token steady state: the Secret is re-patched after the sleep, a failed refresh leaves the
// last good Secret in place, and the loop ends on the context.
func TestTok_RegistryTokenLoop_RefreshRepatchesAndSurvivesAFailedMint(t *testing.T) {
	tokFireTimer(t, 2)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	next := tokScript(t, cancel, []tokMintStep{
		{token: `{"auths":{"r":{"password":"one"}}}`, ttl: time.Hour},
		{err: errors.New("assume-role throttled")},
		{token: `{"auths":{"r":{"password":"three"}}}`, ttl: time.Hour},
	})
	mint := func(context.Context) (string, time.Time, error) { return next() }

	var patched []string
	patch := func(_ context.Context, ns, name, dcj string) error {
		if ns != "acme" || name != "acme-pull" {
			t.Errorf("patched %s/%s, want acme/acme-pull", ns, name)
		}
		patched = append(patched, dcj)
		return nil
	}

	if err := runRegistryTokenLoop(ctx, mint, patch, "acme", "acme-pull", false); !errors.Is(err, context.Canceled) {
		t.Fatalf("runRegistryTokenLoop = %v, want the context error", err)
	}
	if len(patched) != 2 {
		t.Fatalf("patched %d times, want 2 (the failed refresh must not patch)", len(patched))
	}
	if !strings.Contains(patched[1], "three") {
		t.Errorf("second patch = %q, want the refreshed credential", patched[1])
	}
}

// TestTok_RegistryTokenLoop_RefreshPatchFailureIsFatal — a Secret we can no longer write is not
// something to retry silently: the workload's pulls will start failing, so the refresher exits.
func TestTok_RegistryTokenLoop_RefreshPatchFailureIsFatal(t *testing.T) {
	tokFireTimer(t, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mint := func(context.Context) (string, time.Time, error) {
		return "{}", time.Now().Add(time.Hour), nil
	}
	calls := 0
	patch := func(context.Context, string, string, string) error {
		calls++
		if calls == 2 {
			return errors.New("secrets \"acme-pull\" is forbidden")
		}
		return nil
	}
	err := runRegistryTokenLoop(ctx, mint, patch, "acme", "acme-pull", false)
	if err == nil || !strings.Contains(err.Error(), "registry-token: patch acme/acme-pull") {
		t.Fatalf("err = %v, want the patch failure", err)
	}
}

// TestTok_RegistryTokenLoop_InitialPatchIsFatal — a Secret that cannot be written on the FIRST
// pass means the refresher is misconfigured or unauthorized, so it must die rather than loop
// against a placeholder the workload can never pull with.
func TestTok_RegistryTokenLoop_InitialPatchIsFatal(t *testing.T) {
	mint := func(context.Context) (string, time.Time, error) {
		return "{}", time.Now().Add(time.Hour), nil
	}
	patch := func(context.Context, string, string, string) error {
		return errors.New("secrets \"acme-pull\" is forbidden")
	}
	err := runRegistryTokenLoop(context.Background(), mint, patch, "acme", "acme-pull", true)
	if err == nil || !strings.Contains(err.Error(), "registry-token: patch acme/acme-pull") {
		t.Fatalf("err = %v, want the initial patch failure", err)
	}
}

// TestTok_RunRegistryToken_Dispatch covers the refresher entry point's provider switch. Each
// branch is driven to the point where it fails closed off-cluster, which proves the right minter
// was wired without needing the target account's trust.
func TestTok_RunRegistryToken_Dispatch(t *testing.T) {
	if err := RunRegistryToken(context.Background(), []string{"--nope"}); err == nil {
		t.Fatal("an unknown flag must fail the subcommand")
	}

	base := []string{"--secret", "acme-pull", "--namespace", "acme", "--once"}

	t.Run("aws", func(t *testing.T) {
		tokIsolateAWS(t)
		t.Setenv("AWS_PROFILE", "no-such-profile")
		args := append([]string{"--provider", "aws", "--region", "eu-west-1",
			"--registry-host", "1234.dkr.ecr.eu-west-1.amazonaws.com"}, base...)
		if err := RunRegistryToken(context.Background(), args); err == nil ||
			!strings.Contains(err.Error(), "registry-token: initial mint") {
			t.Fatalf("err = %v, want the fail-fast initial mint error", err)
		}
	})

	t.Run("gcp", func(t *testing.T) {
		t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", filepath.Join(t.TempDir(), "absent.json"))
		args := append([]string{"--provider", "gcp", "--registry-host", "europe-docker.pkg.dev"}, base...)
		if err := RunRegistryToken(context.Background(), args); err == nil ||
			!strings.Contains(err.Error(), "find GCP credentials") {
			t.Fatalf("err = %v, want the credential-discovery failure", err)
		}
	})

	t.Run("azure", func(t *testing.T) {
		args := append([]string{"--provider", "azure", "--registry-host", "attacker.example.test"}, base...)
		if err := RunRegistryToken(context.Background(), args); err == nil ||
			!strings.Contains(err.Error(), "non-ACR host") {
			t.Fatalf("err = %v, want the host allowlist refusal", err)
		}
	})
}

// TestTok_RunRegistryToken_AWSEndToEnd drives the whole AWS refresher once — cross-account
// AssumeRole, ECR authorization token, dockerconfigjson, kubectl patch — against local stubs, and
// proves the pull token reaches the Secret base64'd and never on kubectl's argv.
func TestTok_RunRegistryToken_AWSEndToEnd(t *testing.T) {
	exp := time.Now().Add(11 * time.Hour)
	tokStubAWS(t, tokECRToken("AWS", "ecr-pull-password"), &exp, false)
	argvPath, patchPath := stubKubectl(t)

	err := RunRegistryToken(context.Background(), []string{
		"--provider", "aws", "--region", "eu-west-1",
		"--registry-host", "1234.dkr.ecr.eu-west-1.amazonaws.com",
		"--target-role-arn", "arn:aws:iam::210987654321:role/alethia-pull",
		"--secret", "acme-pull", "--namespace", "acme", "--once",
	})
	if err != nil {
		t.Fatalf("RunRegistryToken: %v", err)
	}
	argv, err := os.ReadFile(argvPath)
	if err != nil {
		t.Fatalf("read argv: %v", err)
	}
	if strings.Contains(string(argv), "ecr-pull-password") {
		t.Fatalf("the pull token reached kubectl's argv:\n%s", argv)
	}
	patch, err := os.ReadFile(patchPath)
	if err != nil {
		t.Fatalf("read patch: %v", err)
	}
	var decoded map[string]map[string]string
	if err := json.Unmarshal(patch, &decoded); err != nil {
		t.Fatalf("patch is not strategic-merge JSON: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(decoded["data"][".dockerconfigjson"])
	if err != nil {
		t.Fatalf("the patched value must be base64: %v", err)
	}
	if !strings.Contains(string(raw), "ecr-pull-password") {
		t.Errorf("the Secret does not carry the minted token: %s", raw)
	}
}

// TestTok_MintECRAuth covers the shared ECR authorization-token minter on every arm: the
// cross-account assume-role, the server-provided expiry versus the derived fallback, an empty
// authorization payload and a token that is not base64("user:password").
func TestTok_MintECRAuth(t *testing.T) {
	t.Run("cross-account with a server expiry", func(t *testing.T) {
		exp := time.Now().Add(9 * time.Hour).Truncate(time.Second)
		tokStubAWS(t, tokECRToken("AWS", "cross-account-pass"), &exp, false)
		user, pass, got, err := mintECRAuth(context.Background(), "eu-west-1",
			"arn:aws:iam::210987654321:role/alethia-pull")
		if err != nil {
			t.Fatalf("mintECRAuth: %v", err)
		}
		if user != "AWS" || pass != "cross-account-pass" {
			t.Errorf("credentials = (%q, %q)", user, pass)
		}
		if !got.Equal(exp) {
			t.Errorf("expiry = %v, want the server's %v", got, exp)
		}
	})

	t.Run("same-account falls back to the derived TTL", func(t *testing.T) {
		tokStubAWS(t, tokECRToken("AWS", "same-account-pass"), nil, false)
		before := time.Now()
		_, pass, exp, err := mintECRAuth(context.Background(), "eu-west-1", "")
		if err != nil {
			t.Fatalf("mintECRAuth: %v", err)
		}
		if pass != "same-account-pass" {
			t.Errorf("password = %q", pass)
		}
		if exp.Before(before.Add(ecrTokenTTLFallback - time.Minute)) {
			t.Errorf("expiry = %v, want the %v fallback", exp, ecrTokenTTLFallback)
		}
	})

	t.Run("no authorization data", func(t *testing.T) {
		tokStubAWS(t, "", nil, false)
		if _, _, _, err := mintECRAuth(context.Background(), "eu-west-1", ""); err == nil ||
			!strings.Contains(err.Error(), "no authorization data") {
			t.Fatalf("err = %v, want the empty-payload refusal", err)
		}
	})

	t.Run("malformed authorization token", func(t *testing.T) {
		tokStubAWS(t, "not-base64-at-all!!", nil, false)
		if _, _, _, err := mintECRAuth(context.Background(), "eu-west-1", ""); err == nil ||
			!strings.Contains(err.Error(), "decode ecr authorization token") {
			t.Fatalf("err = %v, want the decode failure", err)
		}
	})

	t.Run("config failure", func(t *testing.T) {
		tokIsolateAWS(t)
		t.Setenv("AWS_PROFILE", "no-such-profile")
		if _, _, _, err := mintECRAuth(context.Background(), "eu-west-1", ""); err == nil ||
			!strings.Contains(err.Error(), "load AWS config") {
			t.Fatalf("err = %v, want the config-load failure", err)
		}
	})

	t.Run("service refuses", func(t *testing.T) {
		tokStubAWSRefuses(t)
		if _, _, _, err := mintECRAuth(context.Background(), "eu-west-1", ""); err == nil ||
			!strings.Contains(err.Error(), "ecr GetAuthorizationToken") {
			t.Fatalf("err = %v, want the service failure", err)
		}
	})
}

// TestTok_MintECRDockerConfig renders the image-pull payload from a stubbed ECR and proves the
// auths key is the requested registry host.
func TestTok_MintECRDockerConfig(t *testing.T) {
	tokStubAWS(t, tokECRToken("AWS", "pull-pass"), nil, false)
	dcj, _, err := mintECRDockerConfig(context.Background(), "eu-west-1", "", "1234.dkr.ecr.eu-west-1.amazonaws.com")
	if err != nil {
		t.Fatalf("mintECRDockerConfig: %v", err)
	}
	var doc struct {
		Auths map[string]struct{ Username, Password, Auth string } `json:"auths"`
	}
	if err := json.Unmarshal([]byte(dcj), &doc); err != nil {
		t.Fatalf("dockerconfigjson is not JSON: %v", err)
	}
	entry, ok := doc.Auths["1234.dkr.ecr.eu-west-1.amazonaws.com"]
	if !ok {
		t.Fatalf("auths is keyed on the wrong host: %s", dcj)
	}
	if entry.Username != "AWS" || entry.Password != "pull-pass" {
		t.Errorf("credentials = (%q, %q)", entry.Username, entry.Password)
	}
}

// TestTok_MintGARDockerConfig covers the Artifact Registry minter on all three arms: credentials
// that cannot be discovered, a token endpoint that refuses, and the OAuth access token rendered
// into a dockerconfigjson under the fixed oauth2accesstoken login.
func TestTok_MintGARDockerConfig(t *testing.T) {
	t.Run("no credentials", func(t *testing.T) {
		t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", filepath.Join(t.TempDir(), "absent.json"))
		if _, _, err := mintGARDockerConfig(context.Background(), "europe-docker.pkg.dev"); err == nil ||
			!strings.Contains(err.Error(), "find GCP credentials") {
			t.Fatalf("err = %v, want the discovery failure", err)
		}
	})

	t.Run("token endpoint refuses", func(t *testing.T) {
		tokGoogleCredentials(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":"unauthorized_client"}`))
		})
		if _, _, err := mintGARDockerConfig(context.Background(), "europe-docker.pkg.dev"); err == nil ||
			!strings.Contains(err.Error(), "obtain GCP access token") {
			t.Fatalf("err = %v, want the token failure", err)
		}
	})

	t.Run("success", func(t *testing.T) {
		tokGoogleCredentials(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"ya29.gar-pull","token_type":"Bearer","expires_in":3600}`))
		})
		dcj, exp, err := mintGARDockerConfig(context.Background(), "europe-docker.pkg.dev")
		if err != nil {
			t.Fatalf("mintGARDockerConfig: %v", err)
		}
		if !strings.Contains(dcj, garTokenUser) || !strings.Contains(dcj, "ya29.gar-pull") {
			t.Errorf("dockerconfigjson = %s", dcj)
		}
		if exp.Before(time.Now()) {
			t.Errorf("expiry %v is already past", exp)
		}
	})
}

// tokGoogleCredentials writes a synthetic service-account key whose token endpoint is the local
// handler, and points GOOGLE_APPLICATION_CREDENTIALS at it — so the GCP minter runs its real
// discovery + JWT-assertion flow without a network or a real key.
func tokGoogleCredentials(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	sa := map[string]string{
		"type":           "service_account",
		"project_id":     "alethia-test",
		"private_key_id": "test-key-id",
		"private_key":    string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email":   "puller@alethia-test.iam.gserviceaccount.com",
		"client_id":      "1",
		"token_uri":      srv.URL + "/token",
	}
	blob, err := json.Marshal(sa)
	if err != nil {
		t.Fatalf("marshal service account: %v", err)
	}
	path := filepath.Join(t.TempDir(), "sa.json")
	if err := os.WriteFile(path, blob, 0o600); err != nil {
		t.Fatalf("write service account: %v", err)
	}
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", path)
}

// TestTok_MintACRDockerConfig_WiresTheRealGetter covers the production ACR entry point: the host
// allowlist is checked BEFORE any identity is touched, and a permitted host then fails closed
// off-cluster because no Workload Identity exists.
func TestTok_MintACRDockerConfig_WiresTheRealGetter(t *testing.T) {
	if _, _, err := mintACRDockerConfig(context.Background(), "attacker.example.test"); err == nil ||
		!strings.Contains(err.Error(), "non-ACR host") {
		t.Fatalf("err = %v, want the allowlist refusal", err)
	}

	tokClearAzureEnv(t)
	if _, _, err := mintACRDockerConfig(context.Background(), "acme.azurecr.io"); err == nil ||
		!strings.Contains(err.Error(), "obtain AAD token") {
		t.Fatalf("err = %v, want the AAD-token failure", err)
	}
	if _, err := workloadIdentityAADToken(context.Background(), acrAADScope); err == nil ||
		!strings.Contains(err.Error(), "azure workload identity credential") {
		t.Fatalf("err = %v, want the credential-construction refusal", err)
	}
}

// TestTok_MintACRDockerConfigWith_ExchangeFailurePropagates proves a failed refresh-token
// exchange is surfaced rather than turned into an empty credential.
func TestTok_MintACRDockerConfigWith_ExchangeFailurePropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()
	base, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse stub URL: %v", err)
	}
	client := srv.Client()
	client.Transport = rewriteTransport{base: base}

	getAAD := func(context.Context, string) (string, error) { return "aad-token", nil }
	_, _, err = mintACRDockerConfigWith(context.Background(), getAAD, client, "acme.azurecr.io")
	if err == nil || !strings.Contains(err.Error(), "status 502") {
		t.Fatalf("err = %v, want the exchange failure", err)
	}
}

// TestTok_ExchangeACRRefreshTokenAt_ErrorPaths covers the exchange's transport-level failures: a
// request that cannot be built, a server that cannot be reached, and a body that is not JSON.
func TestTok_ExchangeACRRefreshTokenAt_ErrorPaths(t *testing.T) {
	ctx := context.Background()
	if _, err := exchangeACRRefreshTokenAt(ctx, http.DefaultClient, "://not a url", "acme.azurecr.io", "aad"); err == nil {
		t.Fatal("an unbuildable request must fail")
	}

	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	addr := dead.URL
	dead.Close()
	if _, err := exchangeACRRefreshTokenAt(ctx, http.DefaultClient, addr+"/oauth2/exchange", "acme.azurecr.io", "aad"); err == nil ||
		!strings.Contains(err.Error(), "acr token exchange") {
		t.Fatalf("err = %v, want the transport failure", err)
	}

	garbage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>not json</html>"))
	}))
	defer garbage.Close()
	if _, err := exchangeACRRefreshTokenAt(ctx, garbage.Client(), garbage.URL, "acme.azurecr.io", "aad"); err == nil ||
		!strings.Contains(err.Error(), "decode") {
		t.Fatalf("err = %v, want the decode failure", err)
	}
}

// TestTok_PatchPullSecret_RefusesAnUnusableTempDir — the patch file is the only channel the token
// may travel through, so a temp file that cannot be created is a hard failure, not a fallback to
// argv.
func TestTok_PatchPullSecret_RefusesAnUnusableTempDir(t *testing.T) {
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "absent", "deeper"))
	if err := patchPullSecret(context.Background(), "acme", "acme-pull", "{}"); err == nil {
		t.Fatal("patchPullSecret must fail when the patch file cannot be created")
	}
	if err := patchHelmRepoSecret(context.Background(), "argocd", "repo-helm-abc", "AWS", "tok"); err == nil {
		t.Fatal("patchHelmRepoSecret must fail when the patch file cannot be created")
	}
}

// ─── helm-repo-token ─────────────────────────────────────────────────────────────────────────

// TestTok_HelmRepoTokenLoop_RefreshRepatchesAndSurvivesAFailedMint is the ArgoCD repo-cred twin of
// the other two steady states.
func TestTok_HelmRepoTokenLoop_RefreshRepatchesAndSurvivesAFailedMint(t *testing.T) {
	tokFireTimer(t, 2)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	next := tokScript(t, cancel, []tokMintStep{
		{token: "pass-one", ttl: time.Hour},
		{err: errors.New("ecr throttled")},
		{token: "pass-three", ttl: time.Hour},
	})
	mint := func(context.Context) (string, string, time.Time, error) {
		pass, exp, err := next()
		return "AWS", pass, exp, err
	}

	var passwords []string
	patch := func(_ context.Context, ns, name, user, pass string) error {
		if ns != "argocd" || name != "repo-helm-abc" || user != "AWS" {
			t.Errorf("patched %s/%s as %q", ns, name, user)
		}
		passwords = append(passwords, pass)
		return nil
	}

	if err := runHelmRepoTokenLoop(ctx, mint, patch, "argocd", "repo-helm-abc", false); !errors.Is(err, context.Canceled) {
		t.Fatalf("runHelmRepoTokenLoop = %v, want the context error", err)
	}
	if len(passwords) != 2 || passwords[1] != "pass-three" {
		t.Fatalf("patched passwords = %v, want the initial one and the refreshed one", passwords)
	}
}

// TestTok_HelmRepoTokenLoop_RefreshPatchFailureIsFatal — an unwritable repo-cred Secret ends the
// refresher rather than leaving ArgoCD to fail chart pulls silently.
func TestTok_HelmRepoTokenLoop_RefreshPatchFailureIsFatal(t *testing.T) {
	tokFireTimer(t, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mint := func(context.Context) (string, string, time.Time, error) {
		return "AWS", "pass", time.Now().Add(time.Hour), nil
	}
	calls := 0
	patch := func(context.Context, string, string, string, string) error {
		calls++
		if calls == 2 {
			return errors.New("forbidden")
		}
		return nil
	}
	err := runHelmRepoTokenLoop(ctx, mint, patch, "argocd", "repo-helm-abc", false)
	if err == nil || !strings.Contains(err.Error(), "helm-repo-token: patch argocd/repo-helm-abc") {
		t.Fatalf("err = %v, want the patch failure", err)
	}
}

// TestTok_RunHelmRepoToken_Dispatch covers the subcommand's two minter branches — ECR Public
// under the cluster's own identity, and private ECR via a cross-account role — plus its flag
// parse failure.
func TestTok_RunHelmRepoToken_Dispatch(t *testing.T) {
	if err := RunHelmRepoToken(context.Background(), []string{"--nope"}); err == nil {
		t.Fatal("an unknown flag must fail the subcommand")
	}

	t.Run("private ECR fails closed off-cluster", func(t *testing.T) {
		tokIsolateAWS(t)
		t.Setenv("AWS_PROFILE", "no-such-profile")
		err := RunHelmRepoToken(context.Background(), []string{
			"--secret", "repo-helm-abc", "--region", "eu-west-1",
			"--target-role-arn", "arn:aws:iam::210987654321:role/alethia-charts", "--once",
		})
		if err == nil || !strings.Contains(err.Error(), "helm-repo-token: initial mint") {
			t.Fatalf("err = %v, want the fail-fast initial mint error", err)
		}
	})

	t.Run("ECR Public end to end", func(t *testing.T) {
		exp := time.Now().Add(11 * time.Hour)
		tokStubAWS(t, tokECRToken("AWS", "public-chart-token"), &exp, true)
		argvPath, patchPath := stubKubectl(t)

		if err := RunHelmRepoToken(context.Background(), []string{
			"--secret", "repo-helm-abc", "--public", "--once",
		}); err != nil {
			t.Fatalf("RunHelmRepoToken: %v", err)
		}
		argv, err := os.ReadFile(argvPath)
		if err != nil {
			t.Fatalf("read argv: %v", err)
		}
		if strings.Contains(string(argv), "public-chart-token") {
			t.Fatalf("the chart token reached kubectl's argv:\n%s", argv)
		}
		if !strings.Contains(string(argv), "argocd") {
			t.Errorf("argv must default to the argocd namespace:\n%s", argv)
		}
		patch, err := os.ReadFile(patchPath)
		if err != nil {
			t.Fatalf("read patch: %v", err)
		}
		var decoded map[string]map[string]string
		if err := json.Unmarshal(patch, &decoded); err != nil {
			t.Fatalf("patch is not strategic-merge JSON: %v", err)
		}
		raw, err := base64.StdEncoding.DecodeString(decoded["data"]["password"])
		if err != nil {
			t.Fatalf("the patched password must be base64: %v", err)
		}
		if string(raw) != "public-chart-token" {
			t.Errorf("patched password = %q, want the minted token", raw)
		}
	})
}

// TestTok_MintECRPublicAuth covers the ECR Public minter's arms: a config that cannot load, an
// empty authorization payload, a malformed token, and the successful mint with the server expiry.
func TestTok_MintECRPublicAuth(t *testing.T) {
	t.Run("config failure", func(t *testing.T) {
		tokIsolateAWS(t)
		t.Setenv("AWS_PROFILE", "no-such-profile")
		if _, _, _, err := mintECRPublicAuth(context.Background()); err == nil ||
			!strings.Contains(err.Error(), "load AWS config") {
			t.Fatalf("err = %v, want the config-load failure", err)
		}
	})

	t.Run("service refuses", func(t *testing.T) {
		tokStubAWSRefuses(t)
		if _, _, _, err := mintECRPublicAuth(context.Background()); err == nil ||
			!strings.Contains(err.Error(), "ecr-public GetAuthorizationToken") {
			t.Fatalf("err = %v, want the service failure", err)
		}
	})

	t.Run("no authorization data", func(t *testing.T) {
		tokStubAWS(t, "", nil, true)
		if _, _, _, err := mintECRPublicAuth(context.Background()); err == nil ||
			!strings.Contains(err.Error(), "no authorization data") {
			t.Fatalf("err = %v, want the empty-payload refusal", err)
		}
	})

	t.Run("malformed token", func(t *testing.T) {
		tokStubAWS(t, "QVdT", nil, true) // base64("AWS") — no ':' separator
		if _, _, _, err := mintECRPublicAuth(context.Background()); err == nil ||
			!strings.Contains(err.Error(), "malformed ecr authorization token") {
			t.Fatalf("err = %v, want the separator refusal", err)
		}
	})

	t.Run("success", func(t *testing.T) {
		exp := time.Now().Add(10 * time.Hour).Truncate(time.Second)
		tokStubAWS(t, tokECRToken("AWS", "public-pass"), &exp, true)
		user, pass, got, err := mintECRPublicAuth(context.Background())
		if err != nil {
			t.Fatalf("mintECRPublicAuth: %v", err)
		}
		if user != "AWS" || pass != "public-pass" {
			t.Errorf("credentials = (%q, %q)", user, pass)
		}
		if !got.Equal(exp) {
			t.Errorf("expiry = %v, want the server's %v", got, exp)
		}
	})

	t.Run("derived expiry when the service omits one", func(t *testing.T) {
		tokStubAWS(t, tokECRToken("AWS", "public-pass"), nil, true)
		before := time.Now()
		_, _, exp, err := mintECRPublicAuth(context.Background())
		if err != nil {
			t.Fatalf("mintECRPublicAuth: %v", err)
		}
		if exp.Before(before.Add(ecrTokenTTLFallback - time.Minute)) {
			t.Errorf("expiry = %v, want the %v fallback", exp, ecrTokenTTLFallback)
		}
	})
}

// TestTok_PatchHelmRepoSecret_SurfacesKubectlFailure keeps a rejected patch visible instead of
// leaving a silently stale chart credential.
func TestTok_PatchHelmRepoSecret_SurfacesKubectlFailure(t *testing.T) {
	dir := t.TempDir()
	script := "#!/bin/sh\necho 'Error from server (Forbidden)' 1>&2\nexit 1\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatalf("write stub kubectl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	err := patchHelmRepoSecret(context.Background(), "argocd", "repo-helm-abc", "AWS", "tok")
	if err == nil || !strings.Contains(err.Error(), "kubectl patch failed") {
		t.Fatalf("err = %v, want the kubectl failure", err)
	}
	if strings.Contains(err.Error(), "tok") {
		t.Errorf("the error must not echo the credential: %v", err)
	}
}

// ─── db-authproxy: the upstream TLS harness ──────────────────────────────────────────────────

// tokUpstreamCert generates a throwaway certificate for 127.0.0.1 and returns it with a pool
// containing only itself.
func tokUpstreamCert(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "alethia-test-upstream"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse certificate: %v", err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, pool
}

// tokStubUpstream starts a loopback database stub and points the proxy's upstream TLS trust at
// its certificate — the ONLY thing the seam changes; the handshake is still verified. handle runs
// per connection and receives the raw socket plus an upgrade function.
func tokStubUpstream(t *testing.T, handle func(raw net.Conn, upgrade func(net.Conn) (*tls.Conn, error))) string {
	t.Helper()
	cert, pool := tokUpstreamCert(t)
	prev := upstreamTLSConfig
	upstreamTLSConfig = func(serverName string) *tls.Config {
		return &tls.Config{ServerName: serverName, RootCAs: pool, MinVersion: tls.VersionTLS12}
	}
	t.Cleanup(func() { upstreamTLSConfig = prev })

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	upgrade := func(raw net.Conn) (*tls.Conn, error) {
		c := tls.Server(raw, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
		if err := c.Handshake(); err != nil {
			return nil, err
		}
		return c, nil
	}
	go func() {
		for {
			conn, aerr := ln.Accept()
			if aerr != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				handle(conn, upgrade)
			}()
		}
	}()
	return ln.Addr().String()
}

// tokFeed returns a connection that yields b and then EOF, for the readers whose failure modes
// are about malformed or truncated input.
func tokFeed(t *testing.T, b []byte) net.Conn {
	t.Helper()
	srv, cli := net.Pipe()
	go func() {
		defer func() { _ = cli.Close() }()
		_, _ = cli.Write(b)
	}()
	t.Cleanup(func() { _ = srv.Close() })
	return srv
}

// ─── db-authproxy: MySQL ─────────────────────────────────────────────────────────────────────

// tokMySQLServerCaps is what the stub database advertises: TLS plus the framing flags the proxy
// is willing to negotiate downstream.
const tokMySQLServerCaps = mysqlCapProtocol41 | mysqlCapSSL | mysqlCapSecureConn |
	mysqlCapDeprecateEOF | mysqlCapPluginAuth | mysqlCapConnectWithDB

// tokMySQLStub speaks the server side of the upstream connection phase — greeting, TLS upgrade,
// AuthSwitchRequest, OK — and then echoes whatever the splice carries. The login and the token it
// received are published on gotUser / gotToken when those are non-nil. reject makes it answer the
// handshake response with an ERR_Packet instead, which is how a real database refuses an identity
// it does not know.
func tokMySQLStub(gotUser, gotToken chan<- string, reject bool) func(net.Conn, func(net.Conn) (*tls.Conn, error)) {
	return func(raw net.Conn, upgrade func(net.Conn) (*tls.Conn, error)) {
		if err := mysqlWritePacket(raw, 0, mysqlServerHandshake(tokMySQLServerCaps)); err != nil {
			return
		}
		if _, _, err := mysqlReadPacket(raw); err != nil { // SSLRequest
			return
		}
		tlsConn, err := upgrade(raw)
		if err != nil {
			return
		}
		resp, _, err := mysqlReadPacket(tlsConn)
		if err != nil {
			return
		}
		if gotUser != nil {
			if end := indexByteFrom(resp, 32, 0); end > 32 {
				gotUser <- string(resp[32:end])
			} else {
				gotUser <- ""
			}
		}
		if reject {
			mysqlWriteError(tlsConn, 3, 1045, "28000", "Access denied for user 'alethia_app'")
			return
		}
		sw := append([]byte{0xFE}, []byte(mysqlClearPasswordPlugin)...)
		sw = append(sw, 0)
		if err := mysqlWritePacket(tlsConn, 3, sw); err != nil {
			return
		}
		auth, _, err := mysqlReadPacket(tlsConn)
		if err != nil {
			return
		}
		if gotToken != nil {
			gotToken <- strings.TrimRight(string(auth), "\x00")
		}
		if err := mysqlWritePacket(tlsConn, 5, mysqlOKPacket()); err != nil {
			return
		}
		// Post-auth the stub is an echo server, which is all the splice needs.
		buf := make([]byte, 64)
		n, err := tlsConn.Read(buf)
		if err != nil {
			return
		}
		_, _ = tlsConn.Write(buf[:n])
	}
}

// TestTok_HandleMySQLConn_EndToEnd is the whole MySQL sidecar in one test: the app handshakes
// with no credential, the proxy mints a token, authenticates upstream over a VERIFIED TLS
// connection with the token as a cleartext password, tells the app it is in, and then splices.
// It proves the credential reaches the database and never the app.
func TestTok_HandleMySQLConn_EndToEnd(t *testing.T) {
	gotToken := make(chan string, 1)
	gotUser := make(chan string, 1)
	addr := tokStubUpstream(t, tokMySQLStub(gotUser, gotToken, false))

	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEngineMySQL, Upstream: addr,
		Listen: "127.0.0.1:3306", User: "alethia_app", Region: "eu-west-1"}
	app, proxy := net.Pipe()
	defer func() { _ = app.Close() }()

	done := make(chan error, 1)
	go func() {
		done <- handleMySQLConn(context.Background(), cfg, proxy,
			func(context.Context) (string, error) { return "minted-db-token", nil })
	}()

	if _, _, err := mysqlReadPacket(app); err != nil {
		t.Fatalf("read the proxy greeting: %v", err)
	}
	clientCaps := mysqlCapProtocol41 | mysqlCapSecureConn | mysqlCapDeprecateEOF | mysqlCapConnectWithDB
	if err := mysqlWritePacket(app, 1, mysqlHandshakeResponseFixture(clientCaps, 33, "ignored", "orders")); err != nil {
		t.Fatalf("write the app handshake response: %v", err)
	}
	okPacket, _, err := mysqlReadPacket(app)
	if err != nil {
		t.Fatalf("read the proxy OK: %v", err)
	}
	if len(okPacket) == 0 || okPacket[0] != 0x00 {
		t.Fatalf("payload % x is not an OK_Packet", okPacket)
	}

	if _, err := app.Write([]byte("SELECT 1")); err != nil {
		t.Fatalf("write a query through the splice: %v", err)
	}
	echo := make([]byte, 8)
	_ = app.SetReadDeadline(time.Now().Add(10 * time.Second))
	if _, err := readFullConn(app, echo); err != nil {
		t.Fatalf("read the spliced response: %v", err)
	}
	if string(echo) != "SELECT 1" {
		t.Errorf("spliced response = %q", echo)
	}
	_ = app.Close()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("handleMySQLConn: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("handleMySQLConn did not return after the app closed")
	}
	select {
	case tok := <-gotToken:
		if tok != "minted-db-token" {
			t.Errorf("upstream received %q, want the minted token", tok)
		}
	default:
		t.Error("the upstream never received a token")
	}
	select {
	case user := <-gotUser:
		if user != "alethia_app" {
			t.Errorf("upstream login = %q, want the platform identity", user)
		}
	default:
		t.Error("the upstream never received a login")
	}
}

// TestTok_HandleMySQLConn_LocalHandshakeFailure — an app that hangs up during its own handshake
// is reported as a local failure, and no token is ever minted for it.
func TestTok_HandleMySQLConn_LocalHandshakeFailure(t *testing.T) {
	app, proxy := net.Pipe()
	_ = app.Close()
	minted := false
	err := handleMySQLConn(context.Background(), authProxyConfig{Engine: authProxyEngineMySQL}, proxy,
		func(context.Context) (string, error) { minted = true; return "tok", nil })
	if err == nil || !strings.Contains(err.Error(), "mysql: local handshake") {
		t.Fatalf("err = %v, want the local-handshake failure", err)
	}
	if minted {
		t.Error("a token was minted for a connection that never handshook")
	}
}

// TestTok_HandleMySQLConn_AppVanishesBeforeTheOK — the app hangs up while the upstream leg is in
// flight. The proxy must report the failed OK rather than splice a connection nobody is on.
func TestTok_HandleMySQLConn_AppVanishesBeforeTheOK(t *testing.T) {
	addr := tokStubUpstream(t, tokMySQLStub(nil, nil, false))
	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEngineMySQL, Upstream: addr,
		Listen: "127.0.0.1:3306", User: "alethia_app", Region: "eu-west-1"}

	app, proxy := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- handleMySQLConn(context.Background(), cfg, proxy,
			func(context.Context) (string, error) { return "tok", nil })
	}()

	if _, _, err := mysqlReadPacket(app); err != nil {
		t.Fatalf("read greeting: %v", err)
	}
	caps := mysqlCapProtocol41 | mysqlCapSecureConn | mysqlCapDeprecateEOF
	if err := mysqlWritePacket(app, 1, mysqlHandshakeResponseFixture(caps, 33, "app", "")); err != nil {
		t.Fatalf("write handshake response: %v", err)
	}
	_ = app.Close()

	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "send OK to client") {
			t.Fatalf("err = %v, want the OK-write failure", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("handleMySQLConn did not return")
	}
}

// TestTok_MySQLDialUpstream_UpstreamRejectsTheLogin surfaces the server's own reason: an IAM user
// the database does not know must produce the access-denied text, not a generic failure.
func TestTok_MySQLDialUpstream_UpstreamRejectsTheLogin(t *testing.T) {
	addr := tokStubUpstream(t, tokMySQLStub(nil, nil, true))
	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEngineMySQL, Upstream: addr,
		Listen: "127.0.0.1:3306", User: "alethia_app", Region: "eu-west-1"}
	hs := mysqlClientHandshake{Caps: mysqlCapProtocol41 | mysqlCapSecureConn | mysqlCapDeprecateEOF}

	conn, err := mysqlDialUpstream(context.Background(), cfg, hs, "tok")
	if conn != nil {
		_ = conn.Close()
		t.Fatal("a rejected login must not yield a connection")
	}
	if err == nil || !strings.Contains(err.Error(), "Access denied") {
		t.Fatalf("err = %v, want the upstream rejection surfaced", err)
	}
}

// TestTok_MySQLDialUpstream_UntrustedCertificate is the MySQL twin of the PostgreSQL proof: a
// database whose certificate does not verify never receives the token.
func TestTok_MySQLDialUpstream_UntrustedCertificate(t *testing.T) {
	cert, _ := tokUpstreamCert(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		conn, aerr := ln.Accept()
		if aerr != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		if werr := mysqlWritePacket(conn, 0, mysqlServerHandshake(tokMySQLServerCaps)); werr != nil {
			return
		}
		if _, _, rerr := mysqlReadPacket(conn); rerr != nil {
			return
		}
		s := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
		_ = s.Handshake()
	}()

	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEngineMySQL, Upstream: ln.Addr().String(),
		Listen: "127.0.0.1:3306", User: "alethia_app", Region: "eu-west-1"}
	conn, err := mysqlDialUpstream(context.Background(), cfg, mysqlClientHandshake{Caps: mysqlCapProtocol41}, "tok")
	if conn != nil {
		_ = conn.Close()
		t.Fatal("a connection was returned to an unverifiable server")
	}
	if err == nil || !strings.Contains(err.Error(), "TLS handshake") {
		t.Fatalf("err = %v, want the verification failure", err)
	}
}

// TestTok_HandleMySQLConn_UpstreamFailureTellsTheApp — when the database cannot be reached the
// driver gets an ERR_Packet naming the stage, not a bare closed socket.
func TestTok_HandleMySQLConn_UpstreamFailureTellsTheApp(t *testing.T) {
	app, proxy := net.Pipe()
	defer func() { _ = app.Close() }()

	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEngineMySQL,
		Upstream: "127.0.0.1:1", Listen: "127.0.0.1:3306", User: "alethia_app", Region: "eu-west-1"}
	done := make(chan error, 1)
	go func() {
		done <- handleMySQLConn(context.Background(), cfg, proxy,
			func(context.Context) (string, error) { return "tok", nil })
	}()

	if _, _, err := mysqlReadPacket(app); err != nil {
		t.Fatalf("read greeting: %v", err)
	}
	caps := mysqlCapProtocol41 | mysqlCapSecureConn
	if err := mysqlWritePacket(app, 1, mysqlHandshakeResponseFixture(caps, 33, "app", "")); err != nil {
		t.Fatalf("write handshake response: %v", err)
	}
	_ = app.SetReadDeadline(time.Now().Add(10 * time.Second))
	p, _, err := mysqlReadPacket(app)
	if err != nil {
		t.Fatalf("read ERR packet: %v", err)
	}
	if len(p) == 0 || p[0] != 0xFF {
		t.Fatalf("payload % x is not an ERR_Packet", p)
	}
	if !strings.Contains(mysqlErrText(p), "could not authenticate upstream") {
		t.Errorf("ERR text = %q", mysqlErrText(p))
	}
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "mysql: upstream") {
			t.Fatalf("err = %v, want the upstream failure", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("handleMySQLConn did not return")
	}
}

// TestTok_MySQLAcceptClient_Failures covers the local half's three refusals: a socket that cannot
// take the greeting, one that never answers it, and an answer with the wrong sequence id.
func TestTok_MySQLAcceptClient_Failures(t *testing.T) {
	app, proxy := net.Pipe()
	_ = app.Close()
	if _, err := mysqlAcceptClient(proxy); err == nil || !strings.Contains(err.Error(), "write initial handshake") {
		t.Fatalf("err = %v, want the greeting-write failure", err)
	}

	app2, proxy2 := net.Pipe()
	go func() {
		_, _, _ = mysqlReadPacket(app2)
		_ = app2.Close()
	}()
	if _, err := mysqlAcceptClient(proxy2); err == nil || !strings.Contains(err.Error(), "read handshake response") {
		t.Fatalf("err = %v, want the response-read failure", err)
	}

	app3, proxy3 := net.Pipe()
	defer func() { _ = app3.Close() }()
	go func() {
		_, _, _ = mysqlReadPacket(app3)
		caps := mysqlCapProtocol41 | mysqlCapSecureConn
		_ = mysqlWritePacket(app3, 7, mysqlHandshakeResponseFixture(caps, 33, "app", ""))
	}()
	if _, err := mysqlAcceptClient(proxy3); err == nil || !strings.Contains(err.Error(), "sequence 7") {
		t.Fatalf("err = %v, want the sequence refusal", err)
	}
}

// TestTok_MySQLParseHandshakeResponse_Malformed walks every truncation the parser must refuse
// rather than mirror a half-read identity upstream.
func TestTok_MySQLParseHandshakeResponse_Malformed(t *testing.T) {
	header := func(caps uint32) []byte {
		b := make([]byte, 32)
		binary.LittleEndian.PutUint32(b[0:4], caps)
		return b
	}
	lenEncCap := uint32(0x00200000)

	cases := []struct {
		name string
		in   []byte
		want string
	}{
		{"too short", make([]byte, 8), "too short"},
		{"unterminated username", append(header(mysqlCapProtocol41), []byte("appuser")...), "unterminated username"},
		{"truncated secure-connection auth data",
			append(header(mysqlCapProtocol41|mysqlCapSecureConn), append([]byte("app"), 0)...), "truncated auth data"},
		{"unterminated plain auth data",
			append(header(mysqlCapProtocol41), append([]byte("app"), 0)...), "unterminated auth data"},
		{"malformed length-encoded auth data",
			append(header(mysqlCapProtocol41|mysqlCapPluginAuth|lenEncCap), append([]byte("app"), 0)...), "auth data"},
		{"unterminated database",
			append(header(mysqlCapProtocol41|mysqlCapSecureConn|mysqlCapConnectWithDB),
				[]byte{'a', 'p', 'p', 0, 0, 'o', 'r', 'd'}...), "unterminated database"},
		{"auth-data length runs past the packet",
			append(header(mysqlCapProtocol41|mysqlCapSecureConn|mysqlCapConnectWithDB),
				[]byte{'a', 'p', 'p', 0, 200}...), "truncated database"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := mysqlParseHandshakeResponse(tc.in); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}

	// The length-encoded auth-data branch on its happy path: 1 byte of auth data, then the database.
	ok := append(header(mysqlCapProtocol41|mysqlCapPluginAuth|lenEncCap|mysqlCapConnectWithDB),
		[]byte{'a', 'p', 'p', 0, 1, 0xAA, 'o', 'r', 'd', 's', 0}...)
	hs, err := mysqlParseHandshakeResponse(ok)
	if err != nil {
		t.Fatalf("length-encoded auth data must parse: %v", err)
	}
	if hs.Database != "ords" {
		t.Errorf("Database = %q, want \"ords\"", hs.Database)
	}

	// A pre-CLIENT_SECURE_CONNECTION client: the auth response is NUL-terminated instead of
	// length-prefixed, and the database still has to be found after it.
	plain := append(header(mysqlCapProtocol41|mysqlCapConnectWithDB),
		[]byte{'a', 'p', 'p', 0, 'p', 'w', 0, 's', 'h', 'o', 'p', 0}...)
	hs, err = mysqlParseHandshakeResponse(plain)
	if err != nil {
		t.Fatalf("NUL-terminated auth data must parse: %v", err)
	}
	if hs.Database != "shop" {
		t.Errorf("Database = %q, want \"shop\"", hs.Database)
	}
}

// TestTok_MySQLDialUpstream_Failures covers the two upstream failures before any credential is
// sent: an unreachable address and a server that hangs up before greeting.
func TestTok_MySQLDialUpstream_Failures(t *testing.T) {
	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEngineMySQL,
		Upstream: "127.0.0.1:1", Listen: "127.0.0.1:3306", User: "alethia_app", Region: "eu-west-1"}
	if _, err := mysqlDialUpstream(context.Background(), cfg, mysqlClientHandshake{}, "tok"); err == nil ||
		!strings.Contains(err.Error(), "dial 127.0.0.1:1") {
		t.Fatalf("err = %v, want the dial failure", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		conn, aerr := ln.Accept()
		if aerr != nil {
			return
		}
		_ = conn.Close()
	}()
	cfg.Upstream = ln.Addr().String()
	if _, err := mysqlDialUpstream(context.Background(), cfg, mysqlClientHandshake{}, "tok"); err == nil ||
		!strings.Contains(err.Error(), "read server handshake") {
		t.Fatalf("err = %v, want the greeting-read failure", err)
	}
}

// TestTok_MySQLFinishAuth_EdgeCases covers the auth loop's remaining arms: an empty packet, a
// challenge-response continuation, an unknown packet type, and a socket that dies before the
// token can be delivered.
func TestTok_MySQLFinishAuth_EdgeCases(t *testing.T) {
	if err := mysqlFinishAuth(tokFeed(t, nil), "tok"); err == nil ||
		!strings.Contains(err.Error(), "read auth response") {
		t.Fatalf("err = %v, want the read failure", err)
	}

	empty := tokFeed(t, []byte{0, 0, 0, 2})
	if err := mysqlFinishAuth(empty, "tok"); err == nil || !strings.Contains(err.Error(), "empty auth packet") {
		t.Fatalf("err = %v, want the empty-packet refusal", err)
	}

	more := tokFeed(t, []byte{1, 0, 0, 2, 0x01})
	if err := mysqlFinishAuth(more, "tok"); err == nil || !strings.Contains(err.Error(), "AuthMoreData") {
		t.Fatalf("err = %v, want the AuthMoreData refusal", err)
	}

	unknown := tokFeed(t, []byte{1, 0, 0, 2, 0x42})
	if err := mysqlFinishAuth(unknown, "tok"); err == nil || !strings.Contains(err.Error(), "unexpected auth packet type") {
		t.Fatalf("err = %v, want the unknown-type refusal", err)
	}

	closed := tokFeed(t, func() []byte {
		sw := append([]byte{0xFE}, []byte(mysqlClearPasswordPlugin)...)
		sw = append(sw, 0)
		return append([]byte{byte(len(sw)), 0, 0, 2}, sw...)
	}())
	if err := mysqlFinishAuth(closed, "tok"); err == nil || !strings.Contains(err.Error(), "send cleartext token") {
		t.Fatalf("err = %v, want the token-write failure", err)
	}
}

// TestTok_MySQLReadPacket_TruncatedBody — a header promising more than the peer sends is an
// error, not a short read the caller would parse as a valid packet.
//
// The sibling "packet too large" guard is deliberately NOT exercised: a MySQL packet length is
// three bytes, so the largest value expressible is 16777215, one below the mysqlMaxPacket
// (16<<20) ceiling it compares against. The branch cannot be reached from the wire.
func TestTok_MySQLReadPacket_TruncatedBody(t *testing.T) {
	truncated := tokFeed(t, []byte{4, 0, 0, 0, 'a'})
	if _, _, err := mysqlReadPacket(truncated); err == nil {
		t.Fatal("a truncated body must fail")
	}
}

// TestTok_MySQLErrText_ShortPacket — a runt ERR_Packet must not be indexed into.
func TestTok_MySQLErrText_ShortPacket(t *testing.T) {
	if got := mysqlErrText([]byte{0xFF, 0x15}); got != "unknown error" {
		t.Errorf("mysqlErrText = %q, want \"unknown error\"", got)
	}
}

// TestTok_IndexByteFrom_OutOfRange pins the bounds guard the handshake parsers rely on.
func TestTok_IndexByteFrom_OutOfRange(t *testing.T) {
	if got := indexByteFrom([]byte("abc"), 9, 'b'); got != -1 {
		t.Errorf("indexByteFrom past the end = %d, want -1", got)
	}
	if got := indexByteFrom([]byte("abc"), -1, 'b'); got != -1 {
		t.Errorf("indexByteFrom with a negative start = %d, want -1", got)
	}
	if got := indexByteFrom([]byte("abc"), 1, 'c'); got != 2 {
		t.Errorf("indexByteFrom = %d, want 2", got)
	}
}

// ─── db-authproxy: PostgreSQL ────────────────────────────────────────────────────────────────

// tokPostgresStub speaks the server side of the upstream leg — SSLRequest, TLS upgrade, cleartext
// password request, AuthenticationOk — and then sends a ReadyForQuery, which is what the splice
// must carry through untouched. The login and token are published when the channels are non-nil.
func tokPostgresStub(gotUser, gotToken chan<- string) func(net.Conn, func(net.Conn) (*tls.Conn, error)) {
	return func(raw net.Conn, upgrade func(net.Conn) (*tls.Conn, error)) {
		var ssl [8]byte
		if _, err := readFullConn(raw, ssl[:]); err != nil {
			return
		}
		if _, err := raw.Write([]byte{'S'}); err != nil {
			return
		}
		tlsConn, err := upgrade(raw)
		if err != nil {
			return
		}
		var lenBuf [4]byte
		if _, err := readFullConn(tlsConn, lenBuf[:]); err != nil {
			return
		}
		body := make([]byte, binary.BigEndian.Uint32(lenBuf[:])-4)
		if _, err := readFullConn(tlsConn, body); err != nil {
			return
		}
		if gotUser != nil {
			fields := strings.Split(string(body[4:]), "\x00")
			for i := 0; i+1 < len(fields); i += 2 {
				if fields[i] == "user" {
					gotUser <- fields[i+1]
					break
				}
			}
		}
		if err := pgWriteMessage(tlsConn, 'R', binary.BigEndian.AppendUint32(nil, pgAuthCleartext)); err != nil {
			return
		}
		typ, pw, err := pgReadMessage(tlsConn)
		if err != nil || typ != 'p' {
			return
		}
		if gotToken != nil {
			gotToken <- strings.TrimRight(string(pw), "\x00")
		}
		if err := pgWriteMessage(tlsConn, 'R', binary.BigEndian.AppendUint32(nil, pgAuthOK)); err != nil {
			return
		}
		// What a real server sends after AuthenticationOk must flow through untouched.
		_ = pgWriteMessage(tlsConn, 'Z', []byte{'I'})
	}
}

// TestTok_HandlePostgresConn_EndToEnd is the PostgreSQL twin of the MySQL end-to-end proof: the
// app's SSLRequest is declined on loopback, the upstream leg is a VERIFIED TLS connection carrying
// the token as a cleartext password, the app gets its own AuthenticationOk, and the server's
// post-auth stream reaches the app through the splice untouched.
func TestTok_HandlePostgresConn_EndToEnd(t *testing.T) {
	gotToken := make(chan string, 1)
	gotUser := make(chan string, 1)
	addr := tokStubUpstream(t, tokPostgresStub(gotUser, gotToken))

	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEnginePostgres, Upstream: addr,
		Listen: "127.0.0.1:5432", User: "alethia_app", Region: "eu-west-1"}
	app, proxy := net.Pipe()
	defer func() { _ = app.Close() }()

	done := make(chan error, 1)
	go func() {
		done <- handlePostgresConn(context.Background(), cfg, proxy,
			func(context.Context) (string, error) { return "minted-pg-token", nil })
	}()

	req := binary.BigEndian.AppendUint32(nil, 8)
	req = binary.BigEndian.AppendUint32(req, pgSSLRequestCode)
	if _, err := app.Write(req); err != nil {
		t.Fatalf("write SSLRequest: %v", err)
	}
	var declined [1]byte
	_ = app.SetReadDeadline(time.Now().Add(10 * time.Second))
	if _, err := readFullConn(app, declined[:]); err != nil {
		t.Fatalf("read the SSL decline: %v", err)
	}
	if declined[0] != 'N' {
		t.Fatalf("SSL response = %q, want 'N' on the loopback hop", declined[0])
	}
	if _, err := app.Write(pgStartupMessage(map[string]string{"database": "orders"}, "whatever")); err != nil {
		t.Fatalf("write startup: %v", err)
	}

	typ, _, err := pgReadMessage(app)
	if err != nil {
		t.Fatalf("read AuthenticationOk: %v", err)
	}
	if typ != 'R' {
		t.Fatalf("message type = %q, want 'R'", typ)
	}
	typ, body, err := pgReadMessage(app)
	if err != nil {
		t.Fatalf("read the spliced ReadyForQuery: %v", err)
	}
	if typ != 'Z' || string(body) != "I" {
		t.Errorf("spliced message = %q/%q, want ReadyForQuery(I)", typ, body)
	}
	_ = app.Close()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("handlePostgresConn: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("handlePostgresConn did not return after the app closed")
	}
	select {
	case tok := <-gotToken:
		if tok != "minted-pg-token" {
			t.Errorf("upstream received %q, want the minted token", tok)
		}
	default:
		t.Error("the upstream never received a token")
	}
	select {
	case user := <-gotUser:
		if user != "alethia_app" {
			t.Errorf("upstream login = %q, want the platform identity", user)
		}
	default:
		t.Error("the upstream never received a login")
	}
}

// TestTok_HandlePostgresConn_AppVanishesBeforeAuthenticationOk — the driver hangs up while the
// upstream leg is in flight; the proxy reports the failed AuthenticationOk instead of splicing a
// connection nobody is on.
func TestTok_HandlePostgresConn_AppVanishesBeforeAuthenticationOk(t *testing.T) {
	addr := tokStubUpstream(t, tokPostgresStub(nil, nil))
	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEnginePostgres, Upstream: addr,
		Listen: "127.0.0.1:5432", User: "alethia_app", Region: "eu-west-1"}

	app, proxy := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- handlePostgresConn(context.Background(), cfg, proxy,
			func(context.Context) (string, error) { return "tok", nil })
	}()
	if _, err := app.Write(pgStartupMessage(map[string]string{"database": "orders"}, "app")); err != nil {
		t.Fatalf("write startup: %v", err)
	}
	_ = app.Close()

	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "send AuthenticationOk") {
			t.Fatalf("err = %v, want the AuthenticationOk-write failure", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("handlePostgresConn did not return")
	}
}

// TestTok_HandlePostgresConn_UpstreamFailureTellsTheApp — an unreachable database becomes an
// ErrorResponse the driver can report, not a silent hang-up.
func TestTok_HandlePostgresConn_UpstreamFailureTellsTheApp(t *testing.T) {
	app, proxy := net.Pipe()
	defer func() { _ = app.Close() }()

	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEnginePostgres,
		Upstream: "127.0.0.1:1", Listen: "127.0.0.1:5432", User: "alethia_app", Region: "eu-west-1"}
	done := make(chan error, 1)
	go func() {
		done <- handlePostgresConn(context.Background(), cfg, proxy,
			func(context.Context) (string, error) { return "tok", nil })
	}()

	if _, err := app.Write(pgStartupMessage(map[string]string{"database": "orders"}, "app")); err != nil {
		t.Fatalf("write startup: %v", err)
	}
	_ = app.SetReadDeadline(time.Now().Add(10 * time.Second))
	typ, body, err := pgReadMessage(app)
	if err != nil {
		t.Fatalf("read ErrorResponse: %v", err)
	}
	if typ != 'E' || !strings.Contains(pgErrText(body), "could not authenticate upstream") {
		t.Errorf("message = %q/%q, want the upstream failure", typ, pgErrText(body))
	}
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "postgres: upstream") {
			t.Fatalf("err = %v, want the upstream failure", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("handlePostgresConn did not return")
	}
}

// TestTok_HandlePostgresConn_LocalStartupFailure — an app that hangs up mid-startup never causes
// a mint.
func TestTok_HandlePostgresConn_LocalStartupFailure(t *testing.T) {
	app, proxy := net.Pipe()
	_ = app.Close()
	minted := false
	err := handlePostgresConn(context.Background(), authProxyConfig{Engine: authProxyEnginePostgres}, proxy,
		func(context.Context) (string, error) { minted = true; return "tok", nil })
	if err == nil || !strings.Contains(err.Error(), "postgres: local startup") {
		t.Fatalf("err = %v, want the local-startup failure", err)
	}
	if minted {
		t.Error("a token was minted for a connection that never started up")
	}
}

// TestTok_PGAcceptClient_Failures covers the startup reader's refusals: an unknown protocol
// version, an implausible length, a truncated body, a startup carrying no parameters, and a
// socket that dies before the SSL decline can be written.
func TestTok_PGAcceptClient_Failures(t *testing.T) {
	unknown := binary.BigEndian.AppendUint32(nil, 8)
	unknown = binary.BigEndian.AppendUint32(unknown, 12345)
	if _, err := pgAcceptClient(tokFeed(t, unknown)); err == nil ||
		!strings.Contains(err.Error(), "unsupported startup protocol version") {
		t.Fatalf("err = %v, want the version refusal", err)
	}

	if _, err := pgAcceptClient(tokFeed(t, []byte{0, 0, 0, 3})); err == nil ||
		!strings.Contains(err.Error(), "implausible startup length") {
		t.Fatalf("err = %v, want the length refusal", err)
	}

	if _, err := pgAcceptClient(tokFeed(t, []byte{0, 0, 0, 64, 0, 0})); err == nil ||
		!strings.Contains(err.Error(), "read startup body") {
		t.Fatalf("err = %v, want the truncated-body failure", err)
	}

	if _, err := pgAcceptClient(tokFeed(t, []byte{0, 0})); err == nil ||
		!strings.Contains(err.Error(), "read startup length") {
		t.Fatalf("err = %v, want the truncated-header failure", err)
	}

	empty := binary.BigEndian.AppendUint32(nil, 9)
	empty = binary.BigEndian.AppendUint32(empty, pgProtocolVersion3)
	empty = append(empty, 0)
	if _, err := pgAcceptClient(tokFeed(t, empty)); err == nil ||
		!strings.Contains(err.Error(), "no parameters") {
		t.Fatalf("err = %v, want the empty-parameters refusal", err)
	}

	// A client that vanishes between its SSLRequest and our decline.
	app, proxy := net.Pipe()
	go func() {
		req := binary.BigEndian.AppendUint32(nil, 8)
		req = binary.BigEndian.AppendUint32(req, pgGSSENCRequestCode)
		_, _ = app.Write(req)
		_ = app.Close()
	}()
	if _, err := pgAcceptClient(proxy); err == nil || !strings.Contains(err.Error(), "decline SSL") {
		t.Fatalf("err = %v, want the decline-write failure", err)
	}
}

// TestTok_PGDialUpstream_Failures covers the upstream leg's failures before and during TLS: an
// unreachable address, a server that hangs up before answering the SSLRequest, a certificate that
// does not verify, and an upstream that rejects the login.
func TestTok_PGDialUpstream_Failures(t *testing.T) {
	cfg := authProxyConfig{Provider: "aws", Engine: authProxyEnginePostgres,
		Upstream: "127.0.0.1:1", Listen: "127.0.0.1:5432", User: "alethia_app", Region: "eu-west-1"}
	if _, err := pgDialUpstream(context.Background(), cfg, map[string]string{"database": "d"}, "tok"); err == nil ||
		!strings.Contains(err.Error(), "dial 127.0.0.1:1") {
		t.Fatalf("err = %v, want the dial failure", err)
	}

	t.Run("hangs up before the SSL response", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		defer func() { _ = ln.Close() }()
		go func() {
			conn, aerr := ln.Accept()
			if aerr != nil {
				return
			}
			_ = conn.Close()
		}()
		c := cfg
		c.Upstream = ln.Addr().String()
		if _, err := pgDialUpstream(context.Background(), c, map[string]string{"database": "d"}, "tok"); err == nil ||
			!strings.Contains(err.Error(), "read SSLRequest response") {
			t.Fatalf("err = %v, want the SSL-response failure", err)
		}
	})

	t.Run("untrusted certificate", func(t *testing.T) {
		cert, _ := tokUpstreamCert(t)
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		defer func() { _ = ln.Close() }()
		go func() {
			conn, aerr := ln.Accept()
			if aerr != nil {
				return
			}
			defer func() { _ = conn.Close() }()
			var ssl [8]byte
			if _, rerr := readFullConn(conn, ssl[:]); rerr != nil {
				return
			}
			if _, werr := conn.Write([]byte{'S'}); werr != nil {
				return
			}
			s := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
			_ = s.Handshake()
		}()
		c := cfg
		c.Upstream = ln.Addr().String()
		if _, err := pgDialUpstream(context.Background(), c, map[string]string{"database": "d"}, "tok"); err == nil ||
			!strings.Contains(err.Error(), "TLS handshake") {
			t.Fatalf("err = %v, want the verification failure — the proxy must not trust an unknown CA", err)
		}
	})

	t.Run("upstream rejects the login", func(t *testing.T) {
		addr := tokStubUpstream(t, func(raw net.Conn, upgrade func(net.Conn) (*tls.Conn, error)) {
			var ssl [8]byte
			if _, err := readFullConn(raw, ssl[:]); err != nil {
				return
			}
			if _, err := raw.Write([]byte{'S'}); err != nil {
				return
			}
			tlsConn, err := upgrade(raw)
			if err != nil {
				return
			}
			var lenBuf [4]byte
			if _, err := readFullConn(tlsConn, lenBuf[:]); err != nil {
				return
			}
			body := make([]byte, binary.BigEndian.Uint32(lenBuf[:])-4)
			if _, err := readFullConn(tlsConn, body); err != nil {
				return
			}
			_ = pgWriteMessage(tlsConn, 'E', []byte("SFATAL\x00C28000\x00Mpassword authentication failed\x00\x00"))
		})
		c := cfg
		c.Upstream = addr
		_, err := pgDialUpstream(context.Background(), c, map[string]string{"database": "d"}, "tok")
		if err == nil || !strings.Contains(err.Error(), "password authentication failed") {
			t.Fatalf("err = %v, want the upstream rejection surfaced", err)
		}
	})
}

// TestTok_PGFinishAuth_EdgeCases covers the authentication loop's remaining arms: a read failure,
// a truncated Authentication message, an unsupported method code, an unexpected message type, and
// a socket that dies before the password can be sent.
func TestTok_PGFinishAuth_EdgeCases(t *testing.T) {
	if err := pgFinishAuth(tokFeed(t, nil), "tok"); err == nil ||
		!strings.Contains(err.Error(), "read auth response") {
		t.Fatalf("err = %v, want the read failure", err)
	}

	truncated := []byte{'R'}
	truncated = binary.BigEndian.AppendUint32(truncated, 6)
	truncated = append(truncated, 0, 0)
	if err := pgFinishAuth(tokFeed(t, truncated), "tok"); err == nil ||
		!strings.Contains(err.Error(), "truncated authentication message") {
		t.Fatalf("err = %v, want the truncation refusal", err)
	}

	unsupported := []byte{'R'}
	unsupported = binary.BigEndian.AppendUint32(unsupported, 8)
	unsupported = binary.BigEndian.AppendUint32(unsupported, 7) // GSSAPI
	if err := pgFinishAuth(tokFeed(t, unsupported), "tok"); err == nil ||
		!strings.Contains(err.Error(), "unsupported authentication method 7") {
		t.Fatalf("err = %v, want the unsupported-method refusal", err)
	}

	unexpected := []byte{'Q'}
	unexpected = binary.BigEndian.AppendUint32(unexpected, 4)
	if err := pgFinishAuth(tokFeed(t, unexpected), "tok"); err == nil ||
		!strings.Contains(err.Error(), "unexpected message") {
		t.Fatalf("err = %v, want the unexpected-message refusal", err)
	}

	cleartext := []byte{'R'}
	cleartext = binary.BigEndian.AppendUint32(cleartext, 8)
	cleartext = binary.BigEndian.AppendUint32(cleartext, pgAuthCleartext)
	if err := pgFinishAuth(tokFeed(t, cleartext), "tok"); err == nil ||
		!strings.Contains(err.Error(), "send cleartext token") {
		t.Fatalf("err = %v, want the password-write failure", err)
	}
}

// TestTok_PGReadMessage_RefusesAnImplausibleLength — a length header outside the bounded range is
// refused rather than allocated, on both the header and the body.
func TestTok_PGReadMessage_RefusesAnImplausibleLength(t *testing.T) {
	short := []byte{'R'}
	short = binary.BigEndian.AppendUint32(short, 2)
	if _, _, err := pgReadMessage(tokFeed(t, short)); err == nil ||
		!strings.Contains(err.Error(), "implausible message length") {
		t.Fatalf("err = %v, want the length refusal", err)
	}

	huge := []byte{'R'}
	huge = binary.BigEndian.AppendUint32(huge, pgMaxStartupSize+1)
	if _, _, err := pgReadMessage(tokFeed(t, huge)); err == nil ||
		!strings.Contains(err.Error(), "implausible message length") {
		t.Fatalf("err = %v, want the length refusal", err)
	}

	if _, _, err := pgReadMessage(tokFeed(t, []byte{'R', 0})); err == nil {
		t.Fatal("a truncated header must fail")
	}

	truncatedBody := []byte{'R'}
	truncatedBody = binary.BigEndian.AppendUint32(truncatedBody, 12)
	truncatedBody = append(truncatedBody, 1, 2)
	if _, _, err := pgReadMessage(tokFeed(t, truncatedBody)); err == nil {
		t.Fatal("a truncated body must fail")
	}
}

// TestTok_PGErrText_WithoutAMessageField falls back rather than returning an empty reason.
func TestTok_PGErrText_WithoutAMessageField(t *testing.T) {
	if got := pgErrText([]byte("SFATAL\x00C28000\x00\x00")); got != "unknown error" {
		t.Errorf("pgErrText = %q, want \"unknown error\"", got)
	}
}

// TestTok_UpstreamTLSConfig_IsVerifiedAndModern pins what the production seam returns: the real
// server name, certificate verification ON, and TLS 1.2 as the floor. A test may swap the trust
// anchor; it must never be able to make production skip verification.
func TestTok_UpstreamTLSConfig_IsVerifiedAndModern(t *testing.T) {
	cfg := upstreamTLSConfig("db.eu-west-1.rds.amazonaws.com")
	if cfg.ServerName != "db.eu-west-1.rds.amazonaws.com" {
		t.Errorf("ServerName = %q", cfg.ServerName)
	}
	if cfg.InsecureSkipVerify {
		t.Error("the upstream hop must always verify the database certificate")
	}
	if cfg.MinVersion != tls.VersionTLS12 {
		t.Errorf("MinVersion = %#x, want TLS 1.2", cfg.MinVersion)
	}
	if cfg.RootCAs != nil {
		t.Error("production must use the platform trust store, not a bundled pool")
	}
}
