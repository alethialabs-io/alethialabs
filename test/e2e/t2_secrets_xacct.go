// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cross-account keyless cloud-secret-manager in-cluster read (#1268) — the PURE half.
//
// Proves the last unproven link in epic #1206: a workload in a cluster in account A actually reads a
// secret living in account B's cloud secret manager, with NO credential anywhere. The customer
// bootstraps a least-privilege read grant in B that trusts our cluster's own workload identity, and
// the in-cluster External Secrets Operator performs the read directly (spec.provider.aws.role /
// gcpsm.projectID / azurekv.vaultUrl / alibaba.auth.rrsa.roleArn).
//
// Everything here is deterministic and unit-tested without a cloud (t2_secrets_xacct_pure_test.go);
// the *_run_test.go sibling drives it against a real cluster under the e2e_t2 build tag.
package e2e

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/categories"
)

// Scenario env. Every per-cloud value also honours the "<base>_<PROVIDER>" override idiom
// (t2ArgoEnvForProvider), so a future cloud can carry its own target without disturbing aws.
const (
	envSecretsXacct          = "ALETHIA_E2E_SECRETS_XACCT"                 // truthy ⇒ enable
	envSecretsXacctAccount   = "ALETHIA_E2E_SECRETS_XACCT_ACCOUNT"         // aws/alibaba account id · azure subscription id
	envSecretsXacctRegion    = "ALETHIA_E2E_SECRETS_XACCT_REGION"          // aws/alibaba
	envSecretsXacctRoleARN   = "ALETHIA_E2E_SECRETS_XACCT_ROLE_ARN"        // aws/alibaba: the target-account read role
	envSecretsXacctOIDCArn   = "ALETHIA_E2E_SECRETS_XACCT_OIDC_ARN"        // alibaba: the target-account RAM OIDC provider
	envSecretsXacctProjectID = "ALETHIA_E2E_SECRETS_XACCT_PROJECT_ID"      // gcp: the target project
	envSecretsXacctVaultURL  = "ALETHIA_E2E_SECRETS_XACCT_VAULT_URL"       // azure: the target Key Vault URL
	envSecretsXacctRemoteKey = "ALETHIA_E2E_SECRETS_XACCT_REMOTE_KEY"      // the canary secret's name in account B
	envSecretsXacctExpectSHA = "ALETHIA_E2E_SECRETS_XACCT_EXPECT_SHA256"   // sha256 of the canary VALUE
	envSecretsXacctSummary   = "ALETHIA_E2E_SECRETS_XACCT_SUMMARY"         // where to write the proof summary
	envSecretsXacctExternal  = "ALETHIA_E2E_SECRETS_XACCT_EXTERNAL_ID"     // aws, OPTIONAL
	envSecretsXacctService   = "ALETHIA_E2E_SECRETS_XACCT_SERVICE"         // the service whose binding materializes the secret
	envSecretsXacctSecret    = "ALETHIA_E2E_SECRETS_XACCT_SECRET_NAME"     // the PROJECT secret name (== remote key by contract)
	envSecretsXacctProbeNS   = "ALETHIA_E2E_SECRETS_XACCT_PROBE_NAMESPACE" // where the product-rendered ExternalSecret lands
)

// The ExternalSecret the PRODUCT renders lands in the generated app manifests' namespace. Kept as a
// constant mirror of provisioner.appNamespace (unexported there) rather than guessed — the run half
// allows an override for a future placement model, but the default must track the product.
const secretsXacctDefaultNS = "default"

// secretsXacctDeniedNS is the NEGATIVE control: a namespace labelled alethia.io/placement=namespace,
// which every *-xacct ClusterSecretStore refuses via spec.conditions (#1306). An ExternalSecret there
// must NOT sync — that is what proves the tenant scoping is real and not decorative.
const (
	secretsXacctDeniedNS = "alethia-e2e-xacct-denied"
	secretsXacctProbeES  = "xacct-scope-probe"
	secretsXacctDataKey  = "value"
)

// secretsXacctConfig is the resolved scenario input.
type secretsXacctConfig struct {
	provider     string
	account      string // aws/alibaba account id · azure subscription id
	region       string
	roleARN      string
	oidcArn      string
	projectID    string
	vaultURL     string
	externalID   string
	remoteKey    string // the canary's name in account B
	secretName   string // the PROJECT secret name
	serviceName  string // the service carrying the secret-kind binding
	probeNS      string
	expectSHA256 string
	summaryPath  string
	enabled      bool
}

// secretsXacctEnabled reports whether the opt-in scenario was requested. Off by default: the base T2
// proof is unchanged unless a maintainer opts in.
func secretsXacctEnabled() bool { return t2Truthy(os.Getenv(envSecretsXacct)) }

// secretsXacctLane is the SINGLE source of truth for which clouds this scenario can actually prove,
// and why the others cannot. It is asserted by the pure tests and read by both the run half and
// scripts/e2e/secrets-e2e.sh, so a lane's status cannot rot in one place while looking green in
// another.
//
// The blocker in every non-AWS case is the same shape: the cross-account grant in account B must
// name the CLUSTER's external-secrets identity, and that identity is recreated on every provision.
// GCP/Azure are unblocked by ADOPTING a standing identity (the external_secrets_* template
// variables) — until an adopted identity is actually wired into the nightly, the lane records
// BLOCKED rather than pretending to cover the cloud.
func secretsXacctLane(provider string) (ok bool, blocked string) {
	switch provider {
	case "aws":
		return true, ""
	case "gcp":
		return false, "GCP: the per-run external-secrets GSA cannot carry a pre-applied cross-project grant — GCP rewrites a deleted SA's binding to `deleted:serviceAccount:...?uid=` and a same-named recreation does not inherit it, and GCP IAM has no principal-pattern condition. Unblocked by adopting a standing GSA (external_secrets_service_account_email); enable this lane once the nightly supplies one."
	case "azure":
		return false, "Azure: the cross-subscription Key Vault role assignment binds the managed identity's OBJECT ID, regenerated on every create, so a pre-applied grant dies with the identity. Unblocked by adopting a standing identity (external_secrets_identity_name/_resource_group); additionally needs a SECOND subscription in the same tenant, which is not available today."
	case "alibaba":
		return false, "Alibaba: ESO's RRSA performs a single AssumeRoleWithOIDC, so account B must host a RAM OIDC provider registered against THIS cluster's ACK issuer — inherently per-cluster, with no stable form. The alibaba e2e role also grants no ram:*. Honest exclusion, not a gap."
	default:
		return false, fmt.Sprintf("%s has no cross-account cloud secret manager.", provider)
	}
}

// secretsXacctFromEnv resolves the scenario config for a provider.
//
// The target REGION is required explicitly rather than defaulted to the cluster's: the canary lives
// wherever account B put it, which need not be — and for a genuine cross-account test usually is
// not — the region the cluster runs in. Defaulting them together would silently read the wrong
// region and surface as a confusing ResourceNotFound at sync time.
func secretsXacctFromEnv(provider string) secretsXacctConfig {
	c := secretsXacctConfig{
		provider:     provider,
		enabled:      secretsXacctEnabled(),
		account:      t2ArgoEnvForProvider(envSecretsXacctAccount, provider, ""),
		region:       t2ArgoEnvForProvider(envSecretsXacctRegion, provider, ""),
		roleARN:      t2ArgoEnvForProvider(envSecretsXacctRoleARN, provider, ""),
		oidcArn:      t2ArgoEnvForProvider(envSecretsXacctOIDCArn, provider, ""),
		projectID:    t2ArgoEnvForProvider(envSecretsXacctProjectID, provider, ""),
		vaultURL:     t2ArgoEnvForProvider(envSecretsXacctVaultURL, provider, ""),
		externalID:   t2ArgoEnvForProvider(envSecretsXacctExternal, provider, ""),
		remoteKey:    t2ArgoEnvForProvider(envSecretsXacctRemoteKey, provider, ""),
		expectSHA256: strings.ToLower(strings.TrimSpace(t2ArgoEnvForProvider(envSecretsXacctExpectSHA, provider, ""))),
		serviceName:  t2Env(envSecretsXacctService, "xacct-probe"),
		probeNS:      t2Env(envSecretsXacctProbeNS, secretsXacctDefaultNS),
		summaryPath:  t2Env(envSecretsXacctSummary, ""),
	}
	// By product contract the project secret's NAME is its remote key (the same contract the SaaS
	// lane adopted in #1207), so default them together rather than making the caller repeat it.
	c.secretName = t2Env(envSecretsXacctSecret, c.remoteKey)
	return c
}

// decide resolves whether the scenario runs. Mirrors t2ArgoRepos.decide:
//   - not requested                    → (false, nil), silent
//   - requested on a BLOCKED lane      → (false, nil) + the recorded reason (the run half logs it)
//   - requested but partly configured  → ERROR naming every missing key, BEFORE any cloud spend
//
// expectSHA256 is REQUIRED whenever the scenario is on. Without it the test could observe a Secret
// materialize and never check WHAT materialized — a green run that proves nothing about the account
// boundary, which is the entire claim.
func (c secretsXacctConfig) decide() (bool, string, error) {
	if !c.enabled {
		return false, "", nil
	}
	if ok, blocked := secretsXacctLane(c.provider); !ok {
		return false, blocked, nil
	}
	var missing []string
	need := func(key, v string) {
		if strings.TrimSpace(v) == "" {
			missing = append(missing, key)
		}
	}
	need(envSecretsXacctRemoteKey, c.remoteKey)
	need(envSecretsXacctExpectSHA, c.expectSHA256)
	switch c.provider {
	case "aws":
		need(envSecretsXacctAccount, c.account)
		need(envSecretsXacctRegion, c.region)
		need(envSecretsXacctRoleARN, c.roleARN)
	case "gcp":
		need(envSecretsXacctProjectID, c.projectID)
	case "azure":
		need(envSecretsXacctAccount, c.account)
		need(envSecretsXacctVaultURL, c.vaultURL)
	case "alibaba":
		need(envSecretsXacctAccount, c.account)
		need(envSecretsXacctRegion, c.region)
		need(envSecretsXacctRoleARN, c.roleARN)
		need(envSecretsXacctOIDCArn, c.oidcArn)
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return false, "", fmt.Errorf("%s is enabled for %s but these are unset: %s", envSecretsXacct, c.provider, strings.Join(missing, ", "))
	}
	if len(c.expectSHA256) != 64 {
		return false, "", fmt.Errorf("%s must be a 64-char hex sha256 of the canary value, got %d chars", envSecretsXacctExpectSHA, len(c.expectSHA256))
	}
	return true, "", nil
}

// connectorSlug is the *-xacct connector this cloud's project secret selects.
func (c secretsXacctConfig) connectorSlug() string {
	switch c.provider {
	case "aws":
		return "aws-sm-xacct"
	case "gcp":
		return "gcp-sm-xacct"
	case "azure":
		return "azure-kv-xacct"
	case "alibaba":
		return "alibaba-kms-xacct"
	}
	return ""
}

// storeName is the ClusterSecretStore the deploy must render. Delegates to the product SSOT so a
// rename there breaks compilation here rather than producing a test that polls a store nobody makes.
func (c secretsXacctConfig) storeName() string { return categories.XacctStoreName(c.provider) }

// providerConfig is the connector's provider_config for this cloud. The KEYS are the contract with
// packages/core/categories/catalog.json — a pure test pins them against the catalog, so a rename
// there fails in unit tests rather than at 04:00 against a real cluster.
func (c secretsXacctConfig) providerConfig() map[string]any {
	switch c.provider {
	case "aws":
		pc := map[string]any{
			"target_account_id": c.account,
			"region":            c.region,
			"target_role_arn":   c.roleARN,
		}
		// OPTIONAL, and absent from catalog.json today — the e2e seeds the snapshot directly, so it
		// can exercise the field the console cannot yet set (a dangling control worth proving).
		if c.externalID != "" {
			pc["external_id"] = c.externalID
		}
		return pc
	case "gcp":
		pc := map[string]any{"target_project_id": c.projectID}
		if c.region != "" {
			pc["region"] = c.region
		}
		return pc
	case "azure":
		return map[string]any{
			"target_subscription_id": c.account,
			"vault_url":              c.vaultURL,
		}
	case "alibaba":
		return map[string]any{
			"target_account_id":        c.account,
			"region":                   c.region,
			"target_role_arn":          c.roleARN,
			"target_oidc_provider_arn": c.oidcArn,
		}
	}
	return nil
}

// applyToSnapshot layers the scenario onto a DEPLOY config_snapshot: the cross-account project
// secret, plus a service whose secret-kind binding is what actually makes the product render an
// ExternalSecret (consumption is binding-driven — a project secret alone materializes nothing).
//
// It APPENDS to any existing `secrets`/`services` rather than assigning. MaxConfigSnapshot writes
// whole keys (base[key] = decoded), so on a full-bar run this must layer ON TOP of the max-config
// surface; assigning here would silently drop max-config's secret and report green on a run that
// covered less than it claimed.
func (c secretsXacctConfig) applyToSnapshot(snap map[string]any) {
	secret := map[string]any{
		"name":            c.secretName,
		"generate":        false,
		"provider":        c.connectorSlug(),
		"provider_config": c.providerConfig(),
	}
	snap["secrets"] = append(existingList(snap, "secrets"), secret)

	svc := map[string]any{
		"name": c.serviceName,
		"bindings": []any{map[string]any{
			"target": map[string]any{"kind": "secret", "name": c.secretName},
			"inject": []any{map[string]any{"env": "XACCT_CANARY", "from": "value"}},
		}},
	}
	snap["services"] = append(existingList(snap, "services"), svc)
}

// existingList reads a snapshot key as a list, tolerating absent/foreign shapes (the snapshot is
// JSON-shaped `map[string]any`, so a value may arrive as []any from a decode or as a typed slice
// from a builder).
func existingList(snap map[string]any, key string) []any {
	switch v := snap[key].(type) {
	case []any:
		return v
	case nil:
		return nil
	default:
		return nil
	}
}

// ── in-cluster observation (pure parsers over kubectl -o json output) ──────────────────────────

// esCondition is one ExternalSecret/ClusterSecretStore status condition.
type esCondition struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

// parseReadyCondition extracts the ESO `Ready` condition. On external-secrets v1beta1 (chart 0.9.12)
// the condition TYPE is `Ready`; `SecretSynced` is a REASON on it, not a type of its own — polling
// for a `SecretSynced` type would never match and the scenario would time out on a healthy cluster.
//
// ok is false while the condition is absent (the controller has not reconciled yet) — the caller
// keeps polling rather than treating "no status" as failure.
func parseReadyCondition(objJSON []byte) (cond esCondition, ok bool, err error) {
	var obj struct {
		Status struct {
			Conditions []esCondition `json:"conditions"`
		} `json:"status"`
	}
	if err := json.Unmarshal(objJSON, &obj); err != nil {
		return esCondition{}, false, fmt.Errorf("decode status: %w", err)
	}
	for _, c := range obj.Status.Conditions {
		if c.Type == "Ready" {
			return c, true, nil
		}
	}
	return esCondition{}, false, nil
}

// isReady reports whether the Ready condition is True.
func isReady(cond esCondition, ok bool) bool { return ok && cond.Status == "True" }

// decodeSecretDataKey pulls one base64 key out of a core/v1 Secret. Fail-closed: a missing or empty
// key is an error, never an empty value that would make a comparison trivially pass.
func decodeSecretDataKey(secretJSON []byte, key string) ([]byte, error) {
	var obj struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal(secretJSON, &obj); err != nil {
		return nil, fmt.Errorf("decode Secret: %w", err)
	}
	enc, ok := obj.Data[key]
	if !ok {
		keys := make([]string, 0, len(obj.Data))
		for k := range obj.Data {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		return nil, fmt.Errorf("Secret has no key %q (present: %v)", key, keys)
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return nil, fmt.Errorf("key %q is not valid base64: %w", key, err)
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("key %q decoded to an EMPTY value — the cross-account read produced nothing", key)
	}
	return raw, nil
}

// assertSecretValueSHA compares the materialized value against the expected sha256.
//
// The VALUE never leaves this function — not in the return, not in the error, not in a log. The
// whole point of comparing digests is that the canary never enters CI config, job logs or the proof
// bundle; an error that echoed the value would undo that in the one situation (a failure) where the
// output is most likely to be pasted somewhere.
func assertSecretValueSHA(secretJSON []byte, key, wantSHA string) error {
	raw, err := decodeSecretDataKey(secretJSON, key)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, wantSHA) {
		return fmt.Errorf("cross-account value mismatch: sha256=%s want %s (%d bytes read)", got, strings.ToLower(wantSHA), len(raw))
	}
	return nil
}

// ── the negative control ──────────────────────────────────────────────────────────────────────

// buildDeniedNamespace renders a namespace carrying alethia.io/placement=namespace — the label every
// *-xacct store's spec.conditions refuses (#1306).
func buildDeniedNamespace(ns string) string {
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: %s
  labels:
    alethia.io/placement: "namespace"
`, ns)
}

// buildScopeProbeExternalSecret renders an ExternalSecret against the cross-account store, for the
// NEGATIVE control only. The positive assertion deliberately uses the PRODUCT-rendered ExternalSecret
// instead: hand-authoring the positive case would prove ESO works, not that Alethia wires it.
func buildScopeProbeExternalSecret(ns, name, store, remoteKey string) string {
	return fmt.Sprintf(`apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: %s
  namespace: %s
spec:
  refreshInterval: 1m
  secretStoreRef:
    name: %s
    kind: ClusterSecretStore
  target:
    name: %s
    creationPolicy: Owner
  data:
    - secretKey: %s
      remoteRef:
        key: %s
`, name, ns, store, name, secretsXacctDataKey, remoteKey)
}

// ── proof summary ─────────────────────────────────────────────────────────────────────────────

// xacctSummary is the machine-readable record folded into the proof bundle. Names, verdicts and a
// digest only — never the canary value, and never a credential.
type xacctSummary struct {
	Feature      string `json:"feature"`
	Provider     string `json:"provider"`
	Slug         string `json:"connector_slug"`
	Store        string `json:"store"`
	TargetRef    string `json:"target_ref,omitempty"`
	RemoteKey    string `json:"remote_key"`
	StoreReady   bool   `json:"store_ready"`
	SecretSynced bool   `json:"secret_synced"`
	ValueMatched bool   `json:"value_matched"`
	ScopeDenied  bool   `json:"scope_denied"`
	Verdict      string `json:"verdict"`
	Detail       string `json:"detail,omitempty"`
}

// xacctSummaryJSON renders the summary for the proof bundle.
func xacctSummaryJSON(s xacctSummary) ([]byte, error) {
	s.Feature = "xacct-secrets"
	return json.MarshalIndent(s, "", "  ")
}
