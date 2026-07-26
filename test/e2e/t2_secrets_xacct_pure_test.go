// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure unit tests for the #1268 cross-account secrets scenario. Untagged: these run in a bare
// `go test ./...` with no cloud, no cluster and no credentials, so a config/shape regression fails
// in CI instead of at 04:00 against a real cluster mid-provision.
package e2e

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// withXacctEnv sets the scenario env for one test and restores it after.
func withXacctEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

const testSHA = "0000000000000000000000000000000000000000000000000000000000000000"

func TestSecretsXacctDecide(t *testing.T) {
	awsComplete := map[string]string{
		envSecretsXacct:          "1",
		envSecretsXacctAccount:   "222222222222",
		envSecretsXacctRegion:    "us-east-1",
		envSecretsXacctRoleARN:   "arn:aws:iam::222222222222:role/AlethiaE2ESecretsReadRole",
		envSecretsXacctRemoteKey: "alethia-e2e/xacct-canary",
		envSecretsXacctExpectSHA: testSHA,
	}

	t.Run("absent is silently off", func(t *testing.T) {
		on, blocked, err := secretsXacctFromEnv("aws").decide()
		if on || blocked != "" || err != nil {
			t.Fatalf("unset ⇒ off with no reason and no error; got on=%v blocked=%q err=%v", on, blocked, err)
		}
	})

	t.Run("aws complete is on", func(t *testing.T) {
		withXacctEnv(t, awsComplete)
		on, blocked, err := secretsXacctFromEnv("aws").decide()
		if !on || blocked != "" || err != nil {
			t.Fatalf("complete aws config ⇒ on; got on=%v blocked=%q err=%v", on, blocked, err)
		}
	})

	// Every missing required key must be NAMED. A generic "misconfigured" would send a maintainer
	// hunting through eight env vars at the start of a 75-minute job.
	for _, missing := range []string{envSecretsXacctAccount, envSecretsXacctRegion, envSecretsXacctRoleARN, envSecretsXacctRemoteKey, envSecretsXacctExpectSHA} {
		t.Run("aws missing "+missing, func(t *testing.T) {
			withXacctEnv(t, awsComplete)
			t.Setenv(missing, "")
			on, _, err := secretsXacctFromEnv("aws").decide()
			if on {
				t.Fatal("an incompletely configured scenario must not run")
			}
			if err == nil || !strings.Contains(err.Error(), missing) {
				t.Fatalf("error must name the missing key %s, got %v", missing, err)
			}
		})
	}

	// Without the expected digest the test could watch a Secret appear and never check WHAT
	// appeared — a green run proving nothing about the account boundary.
	t.Run("a malformed sha256 is rejected", func(t *testing.T) {
		withXacctEnv(t, awsComplete)
		t.Setenv(envSecretsXacctExpectSHA, "abc123")
		if _, _, err := secretsXacctFromEnv("aws").decide(); err == nil || !strings.Contains(err.Error(), "sha256") {
			t.Fatalf("a short digest must be rejected, got %v", err)
		}
	})

	// A BLOCKED lane resolves to OFF carrying its reason — never a silent skip, and never an error
	// (the maintainer enabling the scenario globally should not red every non-AWS leg).
	for _, provider := range []string{"gcp", "azure", "alibaba", "hetzner"} {
		t.Run(provider+" is blocked with a reason", func(t *testing.T) {
			withXacctEnv(t, awsComplete)
			on, blocked, err := secretsXacctFromEnv(provider).decide()
			if on {
				t.Fatalf("%s cannot be proven today and must not run", provider)
			}
			if err != nil {
				t.Fatalf("a blocked lane is not an error, got %v", err)
			}
			if blocked == "" {
				t.Fatal("a blocked lane must carry its reason")
			}
		})
	}
}

// The lane verdicts are the SSOT the parity board, the recording script and the run half all quote.
// Keep them from rotting into a bare "not supported".
func TestSecretsXacctLaneReasonsAreSubstantive(t *testing.T) {
	if ok, reason := secretsXacctLane("aws"); !ok || reason != "" {
		t.Fatalf("aws must be the runnable lane, got ok=%v reason=%q", ok, reason)
	}
	for _, p := range []string{"gcp", "azure", "alibaba"} {
		ok, reason := secretsXacctLane(p)
		if ok {
			t.Fatalf("%s is not provable today", p)
		}
		if len(reason) < 80 {
			t.Errorf("%s: the blocked reason must explain WHY and what would unblock it, got %q", p, reason)
		}
		if !strings.Contains(reason, strings.Title(p)) && !strings.Contains(reason, strings.ToUpper(p)) {
			t.Errorf("%s: the reason should name the cloud, got %q", p, reason)
		}
	}
}

// providerConfig's KEYS are a contract with the connector catalog. Pin them against catalog.json so
// a rename there fails here, in unit tests, rather than as an opaque validation error on a real
// cluster (the same discipline as TestSeedAddOnsPinnedToCatalog).
func TestSecretsXacctProviderConfigPinnedToCatalog(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(thisFile), "..", "..", "packages", "core", "categories", "catalog.json"))
	if err != nil {
		t.Fatalf("read catalog: %v", err)
	}
	var catalog struct {
		Providers []struct {
			Slug           string `json:"slug"`
			ProviderConfig struct {
				Fields []struct {
					Key string `json:"key"`
				} `json:"fields"`
			} `json:"provider_config"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatalf("decode catalog: %v", err)
	}
	known := map[string]map[string]bool{}
	for _, c := range catalog.Providers {
		if !strings.HasSuffix(c.Slug, "-xacct") {
			continue
		}
		keys := map[string]bool{}
		for _, f := range c.ProviderConfig.Fields {
			keys[f.Key] = true
		}
		known[c.Slug] = keys
	}

	for provider, cfg := range map[string]secretsXacctConfig{
		"aws":     {provider: "aws", account: "1", region: "r", roleARN: "arn"},
		"gcp":     {provider: "gcp", projectID: "p", region: "r"},
		"azure":   {provider: "azure", account: "sub", vaultURL: "https://v/"},
		"alibaba": {provider: "alibaba", account: "1", region: "r", roleARN: "arn", oidcArn: "oidc"},
	} {
		slug := cfg.connectorSlug()
		fields, ok := known[slug]
		if !ok {
			t.Errorf("%s: connector %q not found in catalog.json", provider, slug)
			continue
		}
		for key := range cfg.providerConfig() {
			if !fields[key] {
				t.Errorf("%s: provider_config key %q is not declared by connector %q in catalog.json", provider, key, slug)
			}
		}
	}
}

// external_id is AWS-only and OPTIONAL, and is deliberately absent from catalog.json (no console
// surface can set it yet). The e2e seeds the snapshot directly, so it CAN exercise it — but only
// when supplied, and never on another cloud.
func TestSecretsXacctExternalIDIsAWSOnlyAndOptional(t *testing.T) {
	if _, ok := (secretsXacctConfig{provider: "aws", account: "1", region: "r", roleARN: "arn"}).providerConfig()["external_id"]; ok {
		t.Error("external_id must be omitted when unset — sending one where the trust policy has no ExternalId condition makes STS reject every assume")
	}
	if v := (secretsXacctConfig{provider: "aws", account: "1", region: "r", roleARN: "arn", externalID: "acme-7f3c"}).providerConfig()["external_id"]; v != "acme-7f3c" {
		t.Errorf("external_id must be forwarded when set, got %v", v)
	}
	for _, p := range []string{"gcp", "azure", "alibaba"} {
		cfg := secretsXacctConfig{provider: p, account: "1", region: "r", roleARN: "arn", oidcArn: "o", projectID: "p", vaultURL: "v", externalID: "acme"}
		if _, ok := cfg.providerConfig()["external_id"]; ok {
			t.Errorf("%s: external_id is an AWS-only STS control and must never be emitted", p)
		}
	}
}

// applyToSnapshot must APPEND. MaxConfigSnapshot assigns whole snapshot keys, so a full-bar run
// arrives here with `secrets` already populated — assigning would drop max-config's surface and
// report green on a run that covered less than it claimed.
func TestSecretsXacctApplyToSnapshotAppends(t *testing.T) {
	cfg := secretsXacctConfig{
		provider: "aws", account: "1", region: "r", roleARN: "arn",
		secretName: "canary", remoteKey: "canary", serviceName: "probe",
	}

	t.Run("onto an empty snapshot", func(t *testing.T) {
		snap := map[string]any{}
		cfg.applyToSnapshot(snap)
		if got := len(snap["secrets"].([]any)); got != 1 {
			t.Fatalf("secrets = %d, want 1", got)
		}
		if got := len(snap["services"].([]any)); got != 1 {
			t.Fatalf("services = %d, want 1", got)
		}
	})

	t.Run("onto a max-config snapshot", func(t *testing.T) {
		snap := map[string]any{
			"secrets":  []any{map[string]any{"name": "api-key", "generate": true}},
			"services": []any{map[string]any{"name": "web"}},
		}
		cfg.applyToSnapshot(snap)
		secrets := snap["secrets"].([]any)
		if len(secrets) != 2 {
			t.Fatalf("secrets = %d, want 2 (max-config's + ours) — assigning here silently drops the max-config surface", len(secrets))
		}
		if secrets[0].(map[string]any)["name"] != "api-key" {
			t.Error("the pre-existing secret must survive first")
		}
		if len(snap["services"].([]any)) != 2 {
			t.Error("services must append too")
		}
	})
}

// The binding is what makes the product render anything — consumption is binding-driven, so a
// snapshot carrying only the secret would provision a store nothing ever reads through, and the
// scenario would time out waiting for an ExternalSecret that was never generated.
func TestSecretsXacctSnapshotCarriesTheBinding(t *testing.T) {
	snap := map[string]any{}
	cfg := secretsXacctConfig{provider: "aws", account: "1", region: "r", roleARN: "arn", secretName: "canary", serviceName: "probe"}
	cfg.applyToSnapshot(snap)

	svc := snap["services"].([]any)[0].(map[string]any)
	binding := svc["bindings"].([]any)[0].(map[string]any)
	target := binding["target"].(map[string]any)
	if target["kind"] != "secret" || target["name"] != "canary" {
		t.Fatalf("binding target wrong: %+v", target)
	}
	inject := binding["inject"].([]any)[0].(map[string]any)
	if inject["from"] != "value" {
		t.Fatalf("a secret-kind binding must inject the `value` facet (the only one that materializes an ExternalSecret), got %v", inject["from"])
	}
}

func TestParseReadyCondition(t *testing.T) {
	cases := map[string]struct {
		json      string
		wantOK    bool
		wantReady bool
	}{
		// ESO v1beta1: the condition TYPE is Ready; SecretSynced is its REASON. Polling for a
		// `SecretSynced` TYPE would never match and would time out on a healthy cluster.
		"ready true":  {`{"status":{"conditions":[{"type":"Ready","status":"True","reason":"SecretSynced","message":"ok"}]}}`, true, true},
		"ready false": {`{"status":{"conditions":[{"type":"Ready","status":"False","reason":"SecretSyncedError","message":"AccessDenied"}]}}`, true, false},
		"no status":   {`{"status":{}}`, false, false},
		"other type":  {`{"status":{"conditions":[{"type":"Deleting","status":"True"}]}}`, false, false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			cond, ok, err := parseReadyCondition([]byte(c.json))
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if ok != c.wantOK {
				t.Errorf("ok = %v, want %v", ok, c.wantOK)
			}
			if isReady(cond, ok) != c.wantReady {
				t.Errorf("ready = %v, want %v", isReady(cond, ok), c.wantReady)
			}
		})
	}
	if _, _, err := parseReadyCondition([]byte("{not json")); err == nil {
		t.Error("malformed JSON must error, not read as not-ready (which would poll until timeout)")
	}
}

func TestAssertSecretValueSHA(t *testing.T) {
	value := []byte("s3cr3t-canary-value")
	sum := sha256.Sum256(value)
	want := hex.EncodeToString(sum[:])
	secret := func(k, v string) []byte {
		b, _ := json.Marshal(map[string]any{"data": map[string]string{k: base64.StdEncoding.EncodeToString([]byte(v))}})
		return b
	}

	if err := assertSecretValueSHA(secret("value", string(value)), "value", want); err != nil {
		t.Fatalf("matching value must pass: %v", err)
	}
	if err := assertSecretValueSHA(secret("value", "wrong"), "value", want); err == nil {
		t.Error("a mismatched value must fail — this is the assertion that makes the whole scenario non-vacuous")
	}
	if err := assertSecretValueSHA(secret("other", string(value)), "value", want); err == nil {
		t.Error("a missing key must fail")
	}
	if err := assertSecretValueSHA(secret("value", ""), "value", want); err == nil {
		t.Error("an empty value must fail, never pass as 'materialized'")
	}

	// The canary must never appear in an error string. A failure is exactly when output gets pasted
	// into an issue or a CI log, so leaking there would undo the whole compare-by-digest design.
	err := assertSecretValueSHA(secret("value", string(value)), "value", strings.Repeat("a", 64))
	if err == nil {
		t.Fatal("expected a mismatch")
	}
	if strings.Contains(err.Error(), string(value)) {
		t.Errorf("the error must NOT echo the secret value: %q", err)
	}
}

// The negative control is only meaningful if the namespace really carries the label the store
// refuses — a probe in an unlabelled namespace would sync and look like a scope leak.
func TestBuildDeniedNamespaceCarriesThePlacementLabel(t *testing.T) {
	y := buildDeniedNamespace(secretsXacctDeniedNS)
	for _, want := range []string{"kind: Namespace", "name: " + secretsXacctDeniedNS, `alethia.io/placement: "namespace"`} {
		if !strings.Contains(y, want) {
			t.Errorf("denied namespace missing %q:\n%s", want, y)
		}
	}
}

func TestBuildScopeProbeExternalSecret(t *testing.T) {
	y := buildScopeProbeExternalSecret("ns", "probe", "secretstore-aws-xacct", "alethia-e2e/canary")
	for _, want := range []string{
		"apiVersion: external-secrets.io/v1beta1",
		"kind: ClusterSecretStore",
		"name: secretstore-aws-xacct",
		"key: alethia-e2e/canary",
		"secretKey: value",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("scope probe missing %q:\n%s", want, y)
		}
	}
}

// The summary rides into the proof bundle, which is uploaded as an artifact and grep-scanned. It
// must carry verdicts and a digest, never the value or a credential.
func TestXacctSummaryCarriesNoSecrets(t *testing.T) {
	b, err := xacctSummaryJSON(xacctSummary{
		Provider: "aws", Slug: "aws-sm-xacct", Store: "secretstore-aws-xacct",
		TargetRef: "arn:aws:iam::222222222222:role/read", RemoteKey: "alethia-e2e/canary",
		StoreReady: true, SecretSynced: true, ValueMatched: true, ScopeDenied: true, Verdict: "PASS",
	})
	if err != nil {
		t.Fatal(err)
	}
	var s map[string]any
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatalf("summary must be valid JSON: %v", err)
	}
	if s["feature"] != "xacct-secrets" {
		t.Errorf("feature must be stamped for the ledger, got %v", s["feature"])
	}
	for _, forbidden := range []string{"secret_value", "value\":", "password", "token"} {
		if strings.Contains(string(b), forbidden) {
			t.Errorf("summary must not carry %q:\n%s", forbidden, b)
		}
	}
}
