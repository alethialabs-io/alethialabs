// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// T2 KUBECONFIG-MINT proof (#5287) — the PURE half. Deliberately UNTAGGED, like t2_day2_access.go,
// so the classifier, the tier verdicts, the expiry rule, the summary writer and the no-token canary
// are unit-tested in every `go test ./...` with no cluster, no cloud and no build tag
// (t2_kubeconfig_mint_pure_test.go). The orchestration that drives them against a live cluster is
// the e2e_t2-tagged t2_kubeconfig_mint_run_test.go.
//
// # What it proves
//
// After the cluster is up, a READ-ONLY and an ADMIN kubeconfig are minted through the real mint
// channel (#5250) and each is held to its tier, against the real API server:
//
//	read-only   lists nodes and pods (allowed), is REFUSED a create and a delete, is REFUSED a
//	            secrets read, and carries an expiry no later than the TTL plus 5 minutes of skew.
//	admin       creates a scratch namespace, a ConfigMap in it, and deletes both (allowed).
//
// "Refused" means HTTP 403 from the API server — the status CODE, never the text of an error. A 401
// is NOT a refusal (the credential did not authenticate, which proves nothing about RBAC), and an
// answer that is neither 2xx nor 403 is an error. So an allowed read-only write is a FAIL, and so is
// one that merely errored.
//
// # Which driver minted it — recorded, because the two prove different things
//
//	cli             the `cli-demo` dimension, where a real console and the real `alethia` binary
//	                exist: `alethia cluster kubeconfig <project> --static --output <file> --no-input`
//	                for the READ-ONLY tiers. This proves the whole path a person runs. The ADMIN tier
//	                cannot be minted this way, by policy: the CLI here authenticates with a seeded
//	                SERVICE TOKEN (there is no person to sign in), and a service token never mints
//	                admin (#5310). So on cli-demo the CLI's `--admin` request is asserted REFUSED —
//	                exit non-zero, no request row, no file — and the admin tier itself is minted
//	                through the runner channel below. Each tier records the driver that minted it.
//	runner-channel  every other dimension, the scheduled floor among them. There is no console and no
//	                CLI on those legs (building the console costs ~3 minutes per leg and the CLI talks to
//	                nothing else), so the harness writes the mint request exactly as the console's
//	                request route does — the MINT_KUBECONFIG job and the request row in ONE transaction
//	                — and the REAL runner serves it through the shim's copy of the runner channel
//	                (t2_kubeconfig_mint_shim.go). The client half (key, open, strict decode) is the same
//	                kubeaccess code the CLI calls. This proves the runner's minters and the tiers on
//	                every cloud, every night; it does NOT prove the CLI, and the summary says which.
//
// # No credential reaches the bundle
//
// The summary carries tiers, booleans, status codes, reasons, expiries and the endpoint's privacy —
// never a token, a key or a kubeconfig. That is not left to good intentions: the writer refuses to
// write a summary that contains any credential minted in the run, and after the run every file the
// proof bundle is built from (the summary, the runner log, the test log) is scanned for those same
// literals. A hit fails the proof at its own named stage.
package e2e

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Environment knobs.
const (
	// envKubeconfigMint turns the proof OFF when set to a falsy value. Unset means ON: it costs
	// seconds and no spend, so it runs on every leg that reaches a cluster unless someone says not to.
	envKubeconfigMint = "ALETHIA_E2E_KUBECONFIG_MINT"
	// envKubeconfigMintSummary is where the summary JSON is written for capture-proof.sh.
	envKubeconfigMintSummary = "ALETHIA_E2E_KUBECONFIG_MINT_SUMMARY"
)

// Budget and policy.
const (
	// kubeconfigMintBudget is the ladder term (t2_budget.go) and the ctx the whole proof runs under.
	// Each mint is one runner job that answers in seconds, and the checks are a handful of API calls;
	// this is the ceiling a hung mint is cut at, not what a healthy run spends.
	kubeconfigMintBudget = 4 * time.Minute
	// kubeconfigMintTTL is the TTL every mint asks for: the minimum the channel accepts, so the
	// credentials this proof leaves behind are the shortest-lived ones the product can issue.
	kubeconfigMintTTL = 15 * time.Minute
	// kubeconfigMintExpirySkew is the clock skew the read-only expiry may run past the TTL — the same
	// 5 minutes kubeaccess.MintReadOnlyToken allows before it refuses a token itself.
	kubeconfigMintExpirySkew = 5 * time.Minute
)

// The drivers (see the file comment).
const (
	kubeconfigMintDriverCLI    = "cli"
	kubeconfigMintDriverRunner = "runner-channel"
)

// The tiers and shapes, as the wire spells them.
const (
	mintTierReadonly = "readonly"
	mintTierAdmin    = "admin"
	mintShapeStatic  = "static"
	mintShapeExec    = "exec"
)

// The named stages a failure is reported at. A red proof names one of these, never "the test".
const (
	mintStageSetup   = "setup"
	mintStageMint    = "mint"
	mintStageOpen    = "open"
	mintStageAssert  = "assert"
	mintStageExpiry  = "expiry"
	mintStageExec    = "exec"
	mintStageCanary  = "canary"
	mintStageSummary = "summary"
)

// KubeconfigMintEnabled reports whether the proof runs. ON unless envKubeconfigMint is explicitly
// falsy, so the scheduled nightly takes it with no variable set.
func KubeconfigMintEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envKubeconfigMint))) {
	case "0", "false", "no", "off":
		return false
	}
	return true
}

// kubeOutcome is how the API server answered one request.
type kubeOutcome string

const (
	kubeAllowed         kubeOutcome = "allowed"         // 2xx
	kubeRefused         kubeOutcome = "refused"         // 403: authenticated, and RBAC said no
	kubeUnauthenticated kubeOutcome = "unauthenticated" // 401: proves nothing about RBAC
	kubeError           kubeOutcome = "error"           // a transport error, or any other status
)

// classifyKubeAnswer maps one API answer onto an outcome by its STATUS CODE. The Status reason is
// read only to be recorded beside it. A transport error is an error, never a refusal.
func classifyKubeAnswer(code int, body []byte, err error) (kubeOutcome, string) {
	if err != nil {
		return kubeError, ""
	}
	var st struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(body, &st)
	switch {
	case code >= 200 && code < 300:
		return kubeAllowed, st.Reason
	case code == http.StatusForbidden:
		return kubeRefused, st.Reason
	case code == http.StatusUnauthorized:
		return kubeUnauthenticated, st.Reason
	default:
		return kubeError, st.Reason
	}
}

// kubeCheck is one request a tier must be allowed or refused.
type kubeCheck struct {
	Name   string
	Method string
	Path   string
	Body   []byte
	Want   kubeOutcome // kubeAllowed or kubeRefused
	// MinItems, when > 0, requires an allowed LIST to return at least that many items — a list that
	// is allowed and empty proves the identity can call it, not that it can see anything.
	MinItems int
}

// KubeCheckResult is one check's answer, as it goes into the summary. No body is kept.
type KubeCheckResult struct {
	Name       string `json:"name"`
	Want       string `json:"want"`
	StatusCode int    `json:"status_code"`
	Reason     string `json:"reason,omitempty"`
	Outcome    string `json:"outcome"`
	Items      *int   `json:"items,omitempty"`
	Pass       bool   `json:"pass"`
	Error      string `json:"error,omitempty"`
}

// checkPasses is the verdict over one answer: an allowed check passes only when ALLOWED, a refused
// check only when REFUSED. Everything else — including a write that errored rather than being
// refused — fails.
func checkPasses(want, got kubeOutcome) bool {
	switch want {
	case kubeAllowed:
		return got == kubeAllowed
	case kubeRefused:
		return got == kubeRefused
	default:
		return false
	}
}

// kubeDoer is the one call the checks need. *kubeaccess.Client implements it.
type kubeDoer interface {
	Do(ctx context.Context, method, path, contentType string, body []byte) (int, []byte, error)
}

// countListItems returns len(.items) of a LIST answer, or -1 when the body is not a list.
func countListItems(body []byte) int {
	var l struct {
		Items []json.RawMessage `json:"items"`
	}
	if json.Unmarshal(body, &l) != nil || l.Items == nil {
		return -1
	}
	return len(l.Items)
}

// runKubeChecks sends every check in order and records each answer. It never stops early: a tier
// that fails one check still reports the rest, so one run shows the whole shape of a defect.
func runKubeChecks(ctx context.Context, kube kubeDoer, checks []kubeCheck) []KubeCheckResult {
	out := make([]KubeCheckResult, 0, len(checks))
	for _, c := range checks {
		ct := ""
		if c.Body != nil {
			ct = "application/json"
		}
		code, body, err := kube.Do(ctx, c.Method, c.Path, ct, c.Body)
		got, reason := classifyKubeAnswer(code, body, err)
		r := KubeCheckResult{
			Name: c.Name, Want: string(c.Want), StatusCode: code, Reason: reason,
			Outcome: string(got), Pass: checkPasses(c.Want, got),
		}
		if err != nil {
			// kubeaccess errors name the method, path and server — never a header or a body.
			r.Error = err.Error()
		}
		if got == kubeAllowed && c.MinItems > 0 {
			n := countListItems(body)
			r.Items = &n
			if n < c.MinItems {
				r.Pass = false
				r.Error = fmt.Sprintf("the list was allowed but returned %d item(s), want at least %d", n, c.MinItems)
			}
		}
		out = append(out, r)
	}
	return out
}

// awaitFirstRead polls one allowed read until the API server admits it, for at most `within`. A
// freshly minted read-only identity rides a ClusterRoleBinding created seconds earlier, and the RBAC
// authorizer learns of it through an informer — a 403 in that window is propagation, not the tier.
// It only ever WAITS: nothing it sees is recorded, and the checks that follow ask every question
// afresh, so it cannot turn a refusal the tier owes into a pass. Returns the last outcome.
func awaitFirstRead(ctx context.Context, kube kubeDoer, path string, within, every time.Duration) kubeOutcome {
	deadline := time.Now().Add(within)
	for {
		code, body, err := kube.Do(ctx, http.MethodGet, path, "", nil)
		got, _ := classifyKubeAnswer(code, body, err)
		if got == kubeAllowed || time.Now().After(deadline) {
			return got
		}
		select {
		case <-ctx.Done():
			return got
		case <-time.After(every):
		}
	}
}

// configMapBody is a minimal ConfigMap manifest.
func configMapBody(name string) []byte {
	b, _ := json.Marshal(map[string]any{
		"apiVersion": "v1", "kind": "ConfigMap",
		"metadata": map[string]any{"name": name, "labels": map[string]string{"app.kubernetes.io/managed-by": "alethia-e2e"}},
		"data":     map[string]string{"proof": "kubeconfig-mint"},
	})
	return b
}

// namespaceBody is a minimal Namespace manifest.
func namespaceBody(name string) []byte {
	b, _ := json.Marshal(map[string]any{
		"apiVersion": "v1", "kind": "Namespace",
		"metadata": map[string]any{"name": name, "labels": map[string]string{"app.kubernetes.io/managed-by": "alethia-e2e"}},
	})
	return b
}

// readOnlyChecks is what a read-only credential must and must not do. The writes target `default`
// with a name nothing else uses: under RBAC a forbidden request is refused before the object is
// looked up, so a correct read-only tier answers 403 whether or not the object exists, while a tier
// that wrongly allows the write answers 201 / 404 — both of which fail.
func readOnlyChecks(suffix string) []kubeCheck {
	cm := "alethia-kc-ro-" + suffix
	return []kubeCheck{
		{Name: "list-nodes", Method: http.MethodGet, Path: "/api/v1/nodes", Want: kubeAllowed, MinItems: 1},
		{Name: "list-pods", Method: http.MethodGet, Path: "/api/v1/pods?limit=200", Want: kubeAllowed, MinItems: 1},
		{Name: "create-configmap", Method: http.MethodPost, Path: "/api/v1/namespaces/default/configmaps", Body: configMapBody(cm), Want: kubeRefused},
		{Name: "delete-configmap", Method: http.MethodDelete, Path: "/api/v1/namespaces/default/configmaps/" + cm, Want: kubeRefused},
		{Name: "list-secrets", Method: http.MethodGet, Path: "/api/v1/namespaces/kube-system/secrets", Want: kubeRefused},
	}
}

// adminChecks is the harmless write an admin credential must be allowed: a scratch namespace, a
// ConfigMap in it, and the deletion of both. The deletions are checks too — a credential that can
// create and not clean up is not the admin tier.
func adminChecks(suffix string) []kubeCheck {
	ns := "alethia-kc-e2e-" + suffix
	cm := "alethia-kc-admin-" + suffix
	return []kubeCheck{
		{Name: "list-nodes", Method: http.MethodGet, Path: "/api/v1/nodes", Want: kubeAllowed, MinItems: 1},
		{Name: "create-namespace", Method: http.MethodPost, Path: "/api/v1/namespaces", Body: namespaceBody(ns), Want: kubeAllowed},
		{Name: "create-configmap", Method: http.MethodPost, Path: "/api/v1/namespaces/" + ns + "/configmaps", Body: configMapBody(cm), Want: kubeAllowed},
		{Name: "delete-configmap", Method: http.MethodDelete, Path: "/api/v1/namespaces/" + ns + "/configmaps/" + cm, Want: kubeAllowed},
		{Name: "delete-namespace", Method: http.MethodDelete, Path: "/api/v1/namespaces/" + ns, Want: kubeAllowed},
	}
}

// staticKubeconfig is the one cluster and one user a static mint carries. The credential fields are
// held in memory only; String() never prints them.
type staticKubeconfig struct {
	Server         string
	CAData         string
	Token          string
	ClientCertData string
	ClientKeyData  string
}

// String redacts the credential, so an accidental %v cannot leak it.
func (k staticKubeconfig) String() string {
	return fmt.Sprintf("staticKubeconfig{server=%s credential=%s}", k.Server, k.credentialKind())
}

// credentialKind names what the file authenticates with, without its value.
func (k staticKubeconfig) credentialKind() string {
	switch {
	case k.Token != "":
		return "bearer-token"
	case k.ClientCertData != "":
		return "client-certificate"
	default:
		return "none"
	}
}

// secrets lists the values that must never appear in the bundle.
func (k staticKubeconfig) secrets() []string {
	return credentialSecrets(k.Token, k.ClientKeyData)
}

// parseStaticKubeconfig reads a static kubeconfig: exactly one cluster and one user, a server, a CA,
// and exactly one credential. Its errors never quote the file — they say which field is wrong.
func parseStaticKubeconfig(raw []byte) (staticKubeconfig, error) {
	var doc struct {
		Clusters []struct {
			Cluster struct {
				Server string `yaml:"server"`
				CAData string `yaml:"certificate-authority-data"`
			} `yaml:"cluster"`
		} `yaml:"clusters"`
		Users []struct {
			User struct {
				Token          string         `yaml:"token"`
				ClientCertData string         `yaml:"client-certificate-data"`
				ClientKeyData  string         `yaml:"client-key-data"`
				Exec           map[string]any `yaml:"exec"`
			} `yaml:"user"`
		} `yaml:"users"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return staticKubeconfig{}, errors.New("the kubeconfig is not YAML")
	}
	if len(doc.Clusters) != 1 || len(doc.Users) != 1 {
		return staticKubeconfig{}, fmt.Errorf("a static kubeconfig names exactly one cluster and one user (got %d and %d)", len(doc.Clusters), len(doc.Users))
	}
	u := doc.Users[0].User
	if u.Exec != nil {
		return staticKubeconfig{}, errors.New("the kubeconfig's user is an exec plugin, not a static credential")
	}
	k := staticKubeconfig{
		Server: strings.TrimSpace(doc.Clusters[0].Cluster.Server), CAData: strings.TrimSpace(doc.Clusters[0].Cluster.CAData),
		Token: strings.TrimSpace(u.Token), ClientCertData: strings.TrimSpace(u.ClientCertData), ClientKeyData: strings.TrimSpace(u.ClientKeyData),
	}
	if k.Server == "" || k.CAData == "" {
		return staticKubeconfig{}, errors.New("the kubeconfig has no server or no certificate-authority-data")
	}
	hasCert := k.ClientCertData != "" || k.ClientKeyData != ""
	if (k.Token != "") == hasCert {
		return staticKubeconfig{}, errors.New("a static kubeconfig carries exactly one credential: a token, or a client certificate and key")
	}
	if hasCert && (k.ClientCertData == "" || k.ClientKeyData == "") {
		return staticKubeconfig{}, errors.New("the client certificate and key must both be present")
	}
	return k, nil
}

// credentialSecrets builds the canary list from the values a credential carries: a bearer token, and
// a base64 client key together with the key material it decodes to (a leak could be either form).
// Fragments too short to be distinctive are dropped so the scan cannot fire on ordinary text.
func credentialSecrets(token, clientKeyB64 string) []string {
	var out []string
	add := func(s string) {
		if s = strings.TrimSpace(s); len(s) >= 16 {
			out = append(out, s)
		}
	}
	add(token)
	add(clientKeyB64)
	if raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(clientKeyB64)); err == nil {
		if blk, _ := pem.Decode(raw); blk != nil {
			// The PEM body as it would appear inside the key file: its first 64 characters are
			// distinctive key material and are what a decoded leak would carry.
			enc := base64.StdEncoding.EncodeToString(blk.Bytes)
			if len(enc) > 64 {
				enc = enc[:64]
			}
			add(enc)
		}
	}
	return out
}

// Where an expiry was read from, best first.
const (
	expiryFromTokenClaim   = "token-exp-claim"       // the API server's own `exp` in a JWT
	expiryFromCertNotAfter = "client-cert-not-after" // the certificate's NotAfter
	expiryFromRunner       = "runner-reported"       // the expiry the runner sealed beside the credential
	expiryUnknown          = "unknown"
)

// jwtExpiry reads the `exp` claim of a JWT without verifying it — the API server verifies it on every
// request; this only reports what it says.
func jwtExpiry(token string) (time.Time, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		Exp *json.Number `json:"exp"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Exp == nil {
		return time.Time{}, false
	}
	secs, err := claims.Exp.Int64()
	if err != nil || secs <= 0 {
		return time.Time{}, false
	}
	return time.Unix(secs, 0).UTC(), true
}

// certNotAfter reads NotAfter from a base64 PEM client certificate.
func certNotAfter(certB64 string) (time.Time, bool) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(certB64))
	if err != nil {
		return time.Time{}, false
	}
	blk, _ := pem.Decode(raw)
	if blk == nil {
		return time.Time{}, false
	}
	cert, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		return time.Time{}, false
	}
	return cert.NotAfter.UTC(), true
}

// credentialExpiry is when the credential in k stops working, from the credential itself where it
// says (a JWT's exp, a certificate's NotAfter), else from what the runner reported, else unknown.
func credentialExpiry(k staticKubeconfig, reported time.Time) (time.Time, string) {
	if k.Token != "" {
		if t, ok := jwtExpiry(k.Token); ok {
			return t, expiryFromTokenClaim
		}
	}
	if k.ClientCertData != "" {
		if t, ok := certNotAfter(k.ClientCertData); ok {
			return t, expiryFromCertNotAfter
		}
	}
	if !reported.IsZero() {
		return reported.UTC(), expiryFromRunner
	}
	return time.Time{}, expiryUnknown
}

// readOnlyExpiryOK is the read-only tier's lifetime rule: the credential must still be valid at
// `now`, and must expire no later than the request time plus the TTL plus the allowed skew. An
// unknown expiry fails — a read-only token is a JWT, so not being able to read it is itself a defect.
func readOnlyExpiryOK(expires time.Time, source string, requested, now time.Time, ttl time.Duration) error {
	if expires.IsZero() || source == expiryUnknown {
		return errors.New("the read-only credential's expiry could not be read")
	}
	if !expires.After(now) {
		return fmt.Errorf("the read-only credential already expired at %s", expires.Format(time.RFC3339))
	}
	if limit := requested.Add(ttl + kubeconfigMintExpirySkew); expires.After(limit) {
		return fmt.Errorf("the read-only credential expires at %s, past the TTL %s plus %s skew (%s)",
			expires.Format(time.RFC3339), ttl, kubeconfigMintExpirySkew, limit.Format(time.RFC3339))
	}
	return nil
}

// KubeconfigMintTier is one minted tier's result, as it goes into the summary.
type KubeconfigMintTier struct {
	Tier            string            `json:"tier"`
	Shape           string            `json:"shape"`
	TTLSeconds      int               `json:"ttl_seconds"`
	Minted          bool              `json:"minted"`
	MintStatus      string            `json:"mint_status"`
	FailedReason    string            `json:"failed_reason,omitempty"`
	PrivateEndpoint *bool             `json:"private_endpoint"`
	CredentialKind  string            `json:"credential_kind,omitempty"`
	ExpiresAt       string            `json:"expires_at,omitempty"`
	ExpirySource    string            `json:"expiry_source,omitempty"`
	ExpiresInSec    *int64            `json:"expires_in_seconds,omitempty"`
	ExpiryWithinTTL *bool             `json:"expiry_within_ttl,omitempty"`
	ExpiryError     string            `json:"expiry_error,omitempty"`
	Driver          string            `json:"driver,omitempty"` // who minted THIS tier, when not the summary's driver (tierMintDriver)
	Checks          []KubeCheckResult `json:"checks"`
	Error           string            `json:"error,omitempty"`
	Verdict         string            `json:"verdict"`
}

// tierPasses is one tier's verdict: minted, at least one check, every check passed, and — for the
// read-only tier — an expiry inside the TTL.
func tierPasses(t KubeconfigMintTier) bool {
	if !t.Minted || len(t.Checks) == 0 || t.Error != "" {
		return false
	}
	for _, c := range t.Checks {
		if !c.Pass {
			return false
		}
	}
	if t.Tier == mintTierReadonly && t.Shape == mintShapeStatic {
		return t.ExpiryWithinTTL != nil && *t.ExpiryWithinTTL
	}
	return true
}

// finishTier stamps a tier's verdict.
func finishTier(t *KubeconfigMintTier) {
	if tierPasses(*t) {
		t.Verdict = "PASS"
	} else {
		t.Verdict = "FAIL"
	}
}

// KubeconfigMintSummary is the machine-readable proof, written to envKubeconfigMintSummary.
type KubeconfigMintSummary struct {
	Enabled         bool                 `json:"enabled"`
	Provider        string               `json:"provider"`
	Driver          string               `json:"driver"`
	PrivateEndpoint *bool                `json:"private_endpoint"`
	Tiers           []KubeconfigMintTier `json:"tiers"`
	FailedStage     string               `json:"failed_stage,omitempty"`
	FailedDetail    string               `json:"failed_detail,omitempty"`
	CanaryScanned   []string             `json:"canary_scanned,omitempty"`
	CanaryClean     bool                 `json:"canary_clean"`
	DurationSeconds float64              `json:"duration_seconds"`
	Verdict         string               `json:"verdict"`
}

// tierMintDriver is the driver that mints one static tier under the run's driver. It is the run's
// driver for every tier but one: under the CLI driver the ADMIN tier goes through the runner
// channel, because the CLI on cli-demo holds a service token and a service token is refused an admin
// mint by policy (#5310, credentialMayMintTier). What the CLI proves for admin is that refusal
// (cliAdminRefusalCheck), not a mint.
func tierMintDriver(runDriver, tier string) string {
	if runDriver == kubeconfigMintDriverCLI && tier == mintTierAdmin {
		return kubeconfigMintDriverRunner
	}
	return runDriver
}

// cliAdminRefusalCheckName names the check that holds the CLI to the service-token admin policy.
const cliAdminRefusalCheckName = "cli-admin-mint-refused-for-service-token"

// cliAdminRefusalCheck judges `alethia cluster kubeconfig --static --admin` run with a service token.
// It passes only when the CLI FAILED and nothing was produced: no request row (the console refuses
// before writing one) and no kubeconfig file. Exit 0, a row, or a file is the policy not holding —
// outcome "allowed". A row-read error means the absence could not be established — outcome "error",
// never a pass. The CLI's text is not read: the status-to-sentence mapping is the CLI's to change.
func cliAdminRefusalCheck(runErr error, rowWritten bool, rowReadErr error, fileWritten bool) KubeCheckResult {
	r := KubeCheckResult{Name: cliAdminRefusalCheckName, Want: string(kubeRefused)}
	switch {
	case runErr == nil || rowWritten || fileWritten:
		r.Outcome = string(kubeAllowed)
		r.Error = fmt.Sprintf("a service token was not refused an admin mint (cli exit ok=%t, request row=%t, file=%t)",
			runErr == nil, rowWritten, fileWritten)
	case rowReadErr != nil:
		r.Outcome = string(kubeError)
		r.Error = "could not read the mint rows to confirm none was written: " + rowReadErr.Error()
	default:
		r.Outcome, r.Pass = string(kubeRefused), true
	}
	return r
}

// requiredStaticTiers are the two tiers every proof must carry, both static.
var requiredStaticTiers = []string{mintTierReadonly, mintTierAdmin}

// summaryPasses is the whole proof's verdict: no failed stage, a clean canary, BOTH static tiers
// present and passing, and every other recorded tier passing too. A summary missing a tier fails — a
// proof that silently ran one tier must not read like one that ran both.
func summaryPasses(s KubeconfigMintSummary) bool {
	if !s.Enabled || s.FailedStage != "" || !s.CanaryClean {
		return false
	}
	for _, want := range requiredStaticTiers {
		found := false
		for _, t := range s.Tiers {
			if t.Tier == want && t.Shape == mintShapeStatic {
				found = true
			}
		}
		if !found {
			return false
		}
	}
	for _, t := range s.Tiers {
		if !tierPasses(t) {
			return false
		}
	}
	return true
}

// firstFailedTier names the first tier that failed and why, for the verdict line and the stage.
func firstFailedTier(s KubeconfigMintSummary) (KubeconfigMintTier, bool) {
	for _, t := range s.Tiers {
		if !tierPasses(t) {
			return t, true
		}
	}
	return KubeconfigMintTier{}, false
}

// summarizeKubeconfigMint renders the one-line verdict, in the shape of the bundle's other lines.
func summarizeKubeconfigMint(s KubeconfigMintSummary) string {
	if !s.Enabled {
		return "kubeconfig-mint: skipped (" + envKubeconfigMint + " is off)"
	}
	icon := "✅"
	if !summaryPasses(s) {
		icon = "❌"
	}
	parts := make([]string, 0, len(s.Tiers))
	for _, t := range s.Tiers {
		p := fmt.Sprintf("%s/%s %s", t.Tier, t.Shape, t.Verdict)
		if t.Driver != "" && t.Driver != s.Driver {
			p += " [" + t.Driver + "]"
		}
		if t.ExpiresAt != "" {
			p += fmt.Sprintf(" (expires %s via %s)", t.ExpiresAt, t.ExpirySource)
		}
		if !t.Minted && t.FailedReason != "" {
			p += fmt.Sprintf(" — mint %s: %s", t.MintStatus, t.FailedReason)
		}
		for _, c := range t.Checks {
			if !c.Pass {
				p += fmt.Sprintf(" — %s want %s got %s (HTTP %d)", c.Name, c.Want, c.Outcome, c.StatusCode)
				break
			}
		}
		parts = append(parts, p)
	}
	private := "unknown"
	if s.PrivateEndpoint != nil {
		private = fmt.Sprintf("%t", *s.PrivateEndpoint)
	}
	line := fmt.Sprintf("%s kubeconfig-mint (%s): %s · private_endpoint=%s · canary clean=%t",
		icon, s.Driver, strings.Join(parts, " · "), private, s.CanaryClean)
	if s.FailedStage != "" {
		line += fmt.Sprintf(" · FAILED at stage %s", s.FailedStage)
		if s.FailedDetail != "" {
			line += ": " + s.FailedDetail
		}
	}
	return line
}

// containsAnySecret reports whether data holds any of the secrets. It never says which.
func containsAnySecret(data []byte, secrets []string) bool {
	for _, s := range secrets {
		if s != "" && bytes.Contains(data, []byte(s)) {
			return true
		}
	}
	return false
}

// errSummaryCarriesCredential is the writer's refusal. It names no value.
var errSummaryCarriesCredential = errors.New("refusing to write the kubeconfig-mint summary: it contains a minted credential")

// writeKubeconfigMintSummary persists the summary as indented JSON — unless it contains any of the
// credentials minted in the run, in which case it writes NOTHING and returns an error. It then reads
// the file back and checks it again, so what is on disk is what was checked.
func writeKubeconfigMintSummary(path string, s KubeconfigMintSummary, secrets []string) error {
	s.Verdict = summarizeKubeconfigMint(s)
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if containsAnySecret(b, secrets) {
		return errSummaryCarriesCredential
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return err
	}
	back, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if containsAnySecret(back, secrets) {
		_ = os.Remove(path)
		return errSummaryCarriesCredential
	}
	return nil
}

// scanFilesForSecrets is the no-token canary over the files the proof bundle is built from. It
// returns the paths that contain any credential minted in the run (never the credential), and skips
// paths that are empty or do not exist — the caller records which paths it scanned, so a skipped one
// is visible rather than silently "clean". It refuses to vouch for anything when there is nothing to
// look for: an empty secret list would make every file clean by construction.
func scanFilesForSecrets(paths []string, secrets []string) (scanned, hits []string, err error) {
	if len(secrets) == 0 {
		return nil, nil, errors.New("the canary has no credential to look for — nothing was minted, so it cannot vouch for the bundle")
	}
	for _, p := range paths {
		if strings.TrimSpace(p) == "" {
			continue
		}
		data, rerr := os.ReadFile(p)
		if errors.Is(rerr, os.ErrNotExist) {
			continue
		}
		if rerr != nil {
			return scanned, hits, fmt.Errorf("canary could not read %s: %w", p, rerr)
		}
		scanned = append(scanned, p)
		if containsAnySecret(data, secrets) {
			hits = append(hits, p)
		}
	}
	return scanned, hits, nil
}

// redactSecrets replaces every credential in s with a marker, for text that must be logged (a CLI's
// stderr). It is a last line of defence; the canary above is what fails the run.
func redactSecrets(s string, secrets []string) string {
	for _, sec := range secrets {
		if sec != "" {
			s = strings.ReplaceAll(s, sec, "<redacted-credential>")
		}
	}
	return s
}
