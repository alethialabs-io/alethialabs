// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure unit tests for the #1047 cross-account keyless REGISTRY scenario. Untagged: these run in a
// bare `go test ./...` with no cloud, no cluster and no credentials, so a config/shape regression
// fails in CI instead of at 04:00 against a real cluster mid-provision.
package e2e

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// awsRegistryEnv is a complete AWS scenario config, reused as the base every sub-case perturbs.
func awsRegistryEnv() map[string]string {
	return map[string]string{
		envXacctRegistry:        "1",
		envXacctRegistryAccount: "270587882865",
		envXacctRegistryRegion:  "us-east-1",
		envXacctRegistryRoleARN: "arn:aws:iam::270587882865:role/AlethiaE2EEcrPullRole",
		envXacctRegistryHost:    "270587882865.dkr.ecr.us-east-1.amazonaws.com",
		envXacctRegistryImage:   "270587882865.dkr.ecr.us-east-1.amazonaws.com/alethia-e2e/canary:v1",
		// The apps repo is a hard requirement: the refresher and the probe workload reach the cluster
		// only through GitOps.
		envArgoAppsRepo: "https://github.com/alethialabs-io/e2e-apps.git",
		envArgoGitToken: "ghp_notarealtoken",
	}
}

func TestXacctRegistryDecide(t *testing.T) {
	t.Run("absent is silently off", func(t *testing.T) {
		on, blocked, err := xacctRegistryFromEnv("aws").decide()
		if on || blocked != "" || err != nil {
			t.Fatalf("unset ⇒ off with no reason and no error; got on=%v blocked=%q err=%v", on, blocked, err)
		}
	})

	t.Run("aws complete is on", func(t *testing.T) {
		withXacctEnv(t, awsRegistryEnv())
		on, blocked, err := xacctRegistryFromEnv("aws").decide()
		if !on || blocked != "" || err != nil {
			t.Fatalf("complete aws config ⇒ on; got on=%v blocked=%q err=%v", on, blocked, err)
		}
	})

	// Every missing required key must be NAMED. A generic "misconfigured" would send a maintainer
	// hunting through eight env vars at the start of a 75-minute job.
	for _, missing := range []string{
		envXacctRegistryAccount, envXacctRegistryRegion, envXacctRegistryRoleARN,
		envXacctRegistryHost, envXacctRegistryImage, envArgoAppsRepo, envArgoGitToken,
	} {
		t.Run("aws missing "+missing, func(t *testing.T) {
			withXacctEnv(t, awsRegistryEnv())
			t.Setenv(missing, "")
			on, _, err := xacctRegistryFromEnv("aws").decide()
			if on {
				t.Fatal("an incompletely configured scenario must not run")
			}
			if err == nil || !strings.Contains(err.Error(), missing) {
				t.Fatalf("error must name the missing key %s, got %v", missing, err)
			}
		})
	}

	// The single most dangerous misconfiguration: a probe image that is not in the cross-account
	// registry at all. The pod would come up, every assertion downstream would pass, and the run
	// would report a cross-account pull that never touched the foreign account.
	t.Run("an image outside the registry host is rejected", func(t *testing.T) {
		withXacctEnv(t, awsRegistryEnv())
		t.Setenv(envXacctRegistryImage, "docker.io/library/nginx:1.27")
		on, _, err := xacctRegistryFromEnv("aws").decide()
		if on {
			t.Fatal("an image outside the configured registry must not run — it would prove nothing")
		}
		if err == nil || !strings.Contains(err.Error(), envXacctRegistryImage) {
			t.Fatalf("error must name the image variable, got %v", err)
		}
	})

	// The refresher and the imagePullSecret are namespaced together; a probe elsewhere could never
	// resolve the Secret, and the run would look like a federation failure.
	t.Run("a foreign namespace is rejected", func(t *testing.T) {
		withXacctEnv(t, awsRegistryEnv())
		t.Setenv(envXacctRegistryNamespace, "somewhere-else")
		if _, _, err := xacctRegistryFromEnv("aws").decide(); err == nil || !strings.Contains(err.Error(), envXacctRegistryNamespace) {
			t.Fatalf("a non-default namespace must be rejected by name, got %v", err)
		}
	})

	// gcp and azure are FIRST-CLASS lanes here (unlike #1268, where only aws can run). If either ever
	// silently degrades to blocked, this catches it.
	t.Run("gcp complete is on", func(t *testing.T) {
		withXacctEnv(t, map[string]string{
			envXacctRegistry:          "1",
			envXacctRegistryProjectID: "itgix-adp",
			envXacctRegistryRegion:    "us-central1",
			envXacctRegistryReaderSA:  "gar-reader@itgix-adp.iam.gserviceaccount.com",
			envXacctRegistryHost:      "us-central1-docker.pkg.dev",
			envXacctRegistryImage:     "us-central1-docker.pkg.dev/itgix-adp/alethia-e2e/canary:v1",
			envArgoAppsRepo:           "https://github.com/alethialabs-io/e2e-apps.git",
			envArgoGitToken:           "ghp_notarealtoken",
		})
		on, blocked, err := xacctRegistryFromEnv("gcp").decide()
		if !on || blocked != "" || err != nil {
			t.Fatalf("complete gcp config ⇒ on; got on=%v blocked=%q err=%v", on, blocked, err)
		}
	})

	t.Run("azure complete is on", func(t *testing.T) {
		withXacctEnv(t, map[string]string{
			envXacctRegistry:         "1",
			envXacctRegistryAccount:  "00000000-0000-0000-0000-000000000000",
			envXacctRegistryClientID: "11111111-1111-1111-1111-111111111111",
			envXacctRegistryHost:     "alethiae2e.azurecr.io",
			envXacctRegistryImage:    "alethiae2e.azurecr.io/alethia-e2e/canary:v1",
			envArgoAppsRepo:          "https://github.com/alethialabs-io/e2e-apps.git",
			envArgoGitToken:          "ghp_notarealtoken",
		})
		on, blocked, err := xacctRegistryFromEnv("azure").decide()
		if !on || blocked != "" || err != nil {
			t.Fatalf("complete azure config ⇒ on; got on=%v blocked=%q err=%v", on, blocked, err)
		}
	})

	// An excluded cloud resolves to OFF carrying its reason — never a silent skip, and never an error
	// (a maintainer enabling the scenario globally must not red every non-registry leg).
	for _, provider := range []string{"alibaba", "hetzner"} {
		t.Run(provider+" is excluded with a reason", func(t *testing.T) {
			withXacctEnv(t, awsRegistryEnv())
			on, blocked, err := xacctRegistryFromEnv(provider).decide()
			if on {
				t.Fatalf("%s has no cross-account keyless registry and must not run", provider)
			}
			if err != nil {
				t.Fatalf("an excluded cloud is not an error, got %v", err)
			}
			if blocked == "" {
				t.Fatal("an excluded cloud must carry its reason")
			}
		})
	}
}

// The lane verdicts are the SSOT the parity board, the recording script and the run half all quote.
// Keep them from rotting into a bare "not supported".
func TestXacctRegistryLaneReasonsAreSubstantive(t *testing.T) {
	for _, p := range []string{"aws", "gcp", "azure"} {
		if ok, reason := xacctRegistryLane(p); !ok || reason != "" {
			t.Fatalf("%s must be a runnable lane (the trust anchor is a standing customer object, not a per-run identity), got ok=%v reason=%q", p, ok, reason)
		}
	}
	for _, p := range []string{"alibaba", "hetzner"} {
		ok, reason := xacctRegistryLane(p)
		if ok {
			t.Fatalf("%s has no cross-account keyless registry connector", p)
		}
		if len(reason) < 80 {
			t.Errorf("%s: the exclusion must explain WHY and what would change it, got %q", p, reason)
		}
		if !strings.Contains(strings.ToLower(reason), p) {
			t.Errorf("%s: the reason should name the cloud, got %q", p, reason)
		}
	}
}

func TestImageIsUnderHost(t *testing.T) {
	host := "270587882865.dkr.ecr.us-east-1.amazonaws.com"
	cases := map[string]struct {
		image string
		want  bool
	}{
		"same host with a tag":    {host + "/alethia-e2e/canary:v1", true},
		"same host with a digest": {host + "/alethia-e2e/canary@sha256:" + strings.Repeat("a", 64), true},
		"case-insensitive host":   {strings.ToUpper(host) + "/x:v1", true},
		"docker hub":              {"docker.io/library/nginx:1.27", false},
		"implicit docker hub":     {"nginx:1.27", false},
		"host only in the path":   {"evil.example.com/" + host + "/x:v1", false},
		"a different ecr account": {"111111111111.dkr.ecr.us-east-1.amazonaws.com/x:v1", false},
		"empty image":             {"", false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := imageIsUnderHost(c.image, host); got != c.want {
				t.Errorf("imageIsUnderHost(%q) = %v, want %v", c.image, got, c.want)
			}
		})
	}
	if imageIsUnderHost(host+"/x:v1", "") {
		t.Error("an empty host must never match — it would disable the check entirely")
	}
}

// providerConfig's KEYS are a contract with the connector catalog. Pin them against catalog.json so a
// rename there fails here, in unit tests, rather than as an opaque `registry/<slug> validation
// failed` mid-provision (the same discipline as TestSecretsXacctProviderConfigPinnedToCatalog).
func TestXacctRegistryProviderConfigPinnedToCatalog(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRootFromThisFile(t), "packages", "core", "categories", "catalog.json"))
	if err != nil {
		t.Fatalf("read catalog: %v", err)
	}
	var catalog struct {
		Providers []struct {
			Category       string `json:"category"`
			Slug           string `json:"slug"`
			ProviderConfig struct {
				Fields []struct {
					Key      string `json:"key"`
					Required bool   `json:"required"`
				} `json:"fields"`
			} `json:"provider_config"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatalf("decode catalog: %v", err)
	}
	declared := map[string]map[string]bool{}
	required := map[string][]string{}
	for _, c := range catalog.Providers {
		if c.Category != "registry" || !strings.HasSuffix(c.Slug, "-xacct") {
			continue
		}
		keys := map[string]bool{}
		for _, f := range c.ProviderConfig.Fields {
			keys[f.Key] = true
			if f.Required {
				required[c.Slug] = append(required[c.Slug], f.Key)
			}
		}
		declared[c.Slug] = keys
	}
	if len(declared) != 3 {
		t.Fatalf("expected ecr/gar/acr cross-account registry connectors in catalog.json, found %d", len(declared))
	}

	for provider, cfg := range map[string]xacctRegistryConfig{
		"aws":   {provider: "aws", account: "1", region: "r", host: "h", roleARN: "arn"},
		"gcp":   {provider: "gcp", projectID: "p", region: "r", host: "h", readerSA: "sa"},
		"azure": {provider: "azure", account: "sub", region: "r", host: "h", clientID: "cid"},
	} {
		slug := cfg.connectorSlug()
		fields, ok := declared[slug]
		if !ok {
			t.Errorf("%s: connector %q not found in catalog.json", provider, slug)
			continue
		}
		pc := cfg.providerConfig()
		for key := range pc {
			if !fields[key] {
				t.Errorf("%s: provider_config key %q is not declared by connector %q in catalog.json", provider, key, slug)
			}
		}
		// The inverse matters more: a REQUIRED field the scenario never sets fails the connector's
		// own Validate at deploy time, minutes into a real provision.
		for _, key := range required[slug] {
			if _, ok := pc[key]; !ok {
				t.Errorf("%s: catalog.json requires provider_config.%s for %q but the scenario never sets it", provider, key, slug)
			}
		}
	}
}

// The pull Secret's name is a THREE-way coupling: the manifest the product renders, the
// imagePullSecret it attaches to app pods, and the Secret this scenario polls. Delegating to the
// product's own namer is what keeps them one thing.
func TestXacctRegistryPullSecretNameMatchesProduct(t *testing.T) {
	for provider, want := range map[string]string{
		"aws":   "ecr-xacct-pull",
		"gcp":   "gar-xacct-pull",
		"azure": "acr-xacct-pull",
	} {
		if got := (xacctRegistryConfig{provider: provider}).pullSecretName(); got != want {
			t.Errorf("%s: pull secret = %q, want %q", provider, got, want)
		}
	}
}

// applyToSnapshot must APPEND. MaxConfigSnapshot assigns whole snapshot keys, so a full-bar run
// arrives here with `container_registries` already populated — assigning would drop max-config's
// native registry and report green on a run that covered less than it claimed.
func TestXacctRegistryApplyToSnapshotAppends(t *testing.T) {
	cfg := xacctRegistryConfig{
		provider: "aws", account: "1", region: "r", roleARN: "arn",
		host: "h.example.com", image: "h.example.com/app:v1", serviceName: "probe",
	}

	t.Run("onto an empty snapshot", func(t *testing.T) {
		snap := map[string]any{}
		cfg.applyToSnapshot(snap)
		if got := len(snap["container_registries"].([]any)); got != 1 {
			t.Fatalf("container_registries = %d, want 1", got)
		}
		if got := len(snap["services"].([]any)); got != 1 {
			t.Fatalf("services = %d, want 1", got)
		}
	})

	t.Run("onto a max-config snapshot", func(t *testing.T) {
		snap := map[string]any{
			// Exactly what maxconfig.go's registry kind seeds: a NATIVE row (provider unset), which
			// categories' dominantProvider skips — so the appended pluggable row still wins.
			"container_registries": []any{map[string]any{"name": "app-images"}},
			"services":             []any{map[string]any{"name": "web"}},
		}
		cfg.applyToSnapshot(snap)
		regs := snap["container_registries"].([]any)
		if len(regs) != 2 {
			t.Fatalf("container_registries = %d, want 2 (max-config's + ours) — assigning here silently drops the native registry", len(regs))
		}
		if regs[0].(map[string]any)["name"] != "app-images" {
			t.Error("the pre-existing native registry must survive first")
		}
		if p, _ := regs[1].(map[string]any)["provider"].(string); p != "ecr-xacct" {
			t.Errorf("the appended row must select the keyless connector, got %q", p)
		}
		if len(snap["services"].([]any)) != 2 {
			t.Error("services must append too")
		}
	})
}

// The probe service must actually RUN the cross-account image — a service with no image source would
// render a workload that pulls nothing, and every downstream assertion would be about an empty pod.
func TestXacctRegistrySnapshotServiceRunsTheImage(t *testing.T) {
	snap := map[string]any{}
	cfg := xacctRegistryConfig{provider: "gcp", projectID: "p", region: "r", readerSA: "sa",
		host: "us-docker.pkg.dev", image: "us-docker.pkg.dev/p/app:v1", serviceName: "probe"}
	cfg.applyToSnapshot(snap)

	svc := snap["services"].([]any)[0].(map[string]any)
	source := svc["source"].(map[string]any)
	if source["kind"] != "image" || source["image"] != cfg.image {
		t.Fatalf("the probe service must source the cross-account image directly, got %+v", source)
	}
}

// The skip marker is a COUPLING with the provisioner. If the product rewords its fail-closed skip,
// assertion (a) stops matching and a refusal reads as "nothing refused" — which is precisely the
// shape of silence this whole unit exists to eliminate.
func TestXacctRegistrySkipMarkerPinnedToProvisioner(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRootFromThisFile(t), "packages", "core", "provisioner", "manifests_gen.go"))
	if err != nil {
		t.Fatalf("read manifests_gen.go: %v", err)
	}
	if !strings.Contains(string(raw), refresherSkipMarker) {
		t.Fatalf("writeRegistryRefresher no longer emits %q — xacctRegistryRenderSkips would report a REFUSAL as a clean render. Update both together.", refresherSkipMarker)
	}
}

func TestXacctRegistryRenderSkips(t *testing.T) {
	t.Run("a clean deploy yields none", func(t *testing.T) {
		meta := []byte(`{"gitops_status":{"manifest_warnings":["api: repo-sourced service not built yet"]}}`)
		skips, err := xacctRegistryRenderSkips(meta)
		if err != nil || len(skips) != 0 {
			t.Fatalf("unrelated warnings must not match; got %v err=%v", skips, err)
		}
	})
	t.Run("a fail-closed refusal is surfaced", func(t *testing.T) {
		meta := []byte(`{"gitops_status":{"manifest_warnings":[
			"keyless registry ecr-xacct: missing tofu output \"ecr_pull_irsa_arn\" — pull refresher not rendered (fail-closed)"]}}`)
		skips, err := xacctRegistryRenderSkips(meta)
		if err != nil {
			t.Fatal(err)
		}
		if len(skips) != 1 || !strings.Contains(skips[0], "ecr_pull_irsa_arn") {
			t.Fatalf("the refusal and its reason must both surface, got %v", skips)
		}
	})
	t.Run("no gitops_status reads as none, not as an error", func(t *testing.T) {
		if skips, err := xacctRegistryRenderSkips([]byte(`{}`)); err != nil || len(skips) != 0 {
			t.Fatalf("an absent gitops_status is not a refusal; got %v err=%v", skips, err)
		}
	})
	if _, err := xacctRegistryRenderSkips([]byte("{not json")); err == nil {
		t.Error("malformed metadata must error, never read as a clean render")
	}
}

// dockerConfig renders a .dockerconfigjson Secret exactly as the product ships and the refresher
// patches it.
func dockerConfigSecret(t *testing.T, doc string) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"data": map[string]string{".dockerconfigjson": base64.StdEncoding.EncodeToString([]byte(doc))},
	})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAssertPullSecretMinted(t *testing.T) {
	const host = "270587882865.dkr.ecr.us-east-1.amazonaws.com"

	t.Run("the shipped placeholder is not minted", func(t *testing.T) {
		minted, err := assertPullSecretMinted(dockerConfigSecret(t, `{"auths":{}}`), host)
		if err != nil {
			t.Fatal(err)
		}
		if minted {
			t.Fatal(`{"auths":{}} is the placeholder the manifest ships — treating it as minted would pass before the refresher ever ran`)
		}
	})

	t.Run("an entry with no material is not minted", func(t *testing.T) {
		doc := `{"auths":{"` + host + `":{"username":"AWS","password":"","auth":""}}}`
		minted, err := assertPullSecretMinted(dockerConfigSecret(t, doc), host)
		if err != nil || minted {
			t.Fatalf("an empty credential must not count as minted; got minted=%v err=%v", minted, err)
		}
	})

	t.Run("a real credential is minted", func(t *testing.T) {
		doc := `{"auths":{"` + host + `":{"username":"AWS","password":"eyJwYXlsb2FkIjoi","auth":"QVdTOmV5SndZWGxzYjJGayI="}}}`
		minted, err := assertPullSecretMinted(dockerConfigSecret(t, doc), host)
		if err != nil || !minted {
			t.Fatalf("a non-empty credential for the host must count as minted; got minted=%v err=%v", minted, err)
		}
	})

	// A mint against a DIFFERENT host would poll to the deadline and then report a timeout, hiding a
	// configuration error behind what looks like a federation failure.
	t.Run("a wrong-host mint errors immediately", func(t *testing.T) {
		doc := `{"auths":{"111111111111.dkr.ecr.us-east-1.amazonaws.com":{"auth":"eA=="}}}`
		_, err := assertPullSecretMinted(dockerConfigSecret(t, doc), host)
		if err == nil || !strings.Contains(err.Error(), "different registry host") {
			t.Fatalf("a mint for another registry must be a hard error, got %v", err)
		}
	})

	t.Run("a missing key errors", func(t *testing.T) {
		b, _ := json.Marshal(map[string]any{"data": map[string]string{"other": "eA=="}})
		if _, err := assertPullSecretMinted(b, host); err == nil {
			t.Error("a Secret with no .dockerconfigjson must error, never read as not-yet-minted")
		}
	})

	// The token is the one thing that must never reach a CI log or a proof bundle, and a failure is
	// exactly when output gets pasted into an issue.
	t.Run("no error echoes the token", func(t *testing.T) {
		const token = "SUPERSECRETPULLTOKEN"
		doc := `{"auths":{"other.example.com":{"username":"AWS","password":"` + token + `","auth":"` + token + `"}}}`
		_, err := assertPullSecretMinted(dockerConfigSecret(t, doc), host)
		if err == nil {
			t.Fatal("expected a wrong-host error")
		}
		if strings.Contains(err.Error(), token) {
			t.Errorf("the error must NOT echo the pull token: %q", err)
		}
	})
}

func TestParsePodSpecView(t *testing.T) {
	deploy := []byte(`{"spec":{"template":{"spec":{
		"imagePullSecrets":[{"name":"ecr-xacct-pull"}],
		"containers":[{"name":"probe","image":"h/app:v1"}]}}}}`)
	v, err := parsePodSpecView(deploy)
	if err != nil {
		t.Fatal(err)
	}
	if !v.hasPullSecret("ecr-xacct-pull") {
		t.Error("the product-attached imagePullSecret must be visible — it is the whole subject of the assertion")
	}
	if v.hasPullSecret("dockerhub-pull") {
		t.Error("hasPullSecret must not match a different secret")
	}
	if !v.hasImage("h/app:v1") || v.hasImage("other:v1") {
		t.Errorf("image matching is wrong: %+v", v.Images)
	}

	// A pod with NO imagePullSecrets is the regression this catches: the registry selection never
	// reached the generated workload.
	bare, err := parsePodSpecView([]byte(`{"spec":{"template":{"spec":{"containers":[{"image":"h/app:v1"}]}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if bare.hasPullSecret("ecr-xacct-pull") || len(bare.ImagePullSecrets) != 0 {
		t.Error("an unattached pod must report no pull secrets")
	}
	if _, err := parsePodSpecView([]byte("{not json")); err == nil {
		t.Error("malformed JSON must error")
	}
}

func TestParsePullState(t *testing.T) {
	cases := map[string]struct {
		json       string
		wantPulled bool
		wantFailed bool
	}{
		"running":         {`{"status":{"containerStatuses":[{"state":{"running":{}}}]}}`, true, false},
		"terminated":      {`{"status":{"containerStatuses":[{"state":{"terminated":{}}}]}}`, true, false},
		"backoff":         {`{"status":{"containerStatuses":[{"state":{"waiting":{"reason":"ImagePullBackOff","message":"denied"}}}]}}`, false, true},
		"first failure":   {`{"status":{"containerStatuses":[{"state":{"waiting":{"reason":"ErrImagePull","message":"401"}}}]}}`, false, true},
		"still creating":  {`{"status":{"containerStatuses":[{"state":{"waiting":{"reason":"ContainerCreating"}}}]}}`, false, false},
		"no statuses yet": {`{"status":{}}`, false, false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			st, err := parsePullState([]byte(c.json))
			if err != nil {
				t.Fatal(err)
			}
			if st.Pulled != c.wantPulled || st.Failed != c.wantFailed {
				t.Errorf("pulled=%v failed=%v, want pulled=%v failed=%v", st.Pulled, st.Failed, c.wantPulled, c.wantFailed)
			}
		})
	}
	// ContainerCreating is NOT a failure and must never be: the negative control would then "pass"
	// while the image was still being fetched.
	if st, _ := parsePullState([]byte(`{"status":{"containerStatuses":[{"state":{"waiting":{"reason":"ContainerCreating"}}}]}}`)); st.Failed {
		t.Error("ContainerCreating must not read as a pull failure")
	}
	if _, err := parsePullState([]byte("{not json")); err == nil {
		t.Error("malformed JSON must error")
	}
}

// The negative control is only meaningful if the default ServiceAccount attaches nothing — otherwise
// every pod in the namespace inherits the pull credential and "no imagePullSecrets" changes nothing.
func TestParseServiceAccountPullSecrets(t *testing.T) {
	none, err := parseServiceAccountPullSecrets([]byte(`{"metadata":{"name":"default"}}`))
	if err != nil || len(none) != 0 {
		t.Fatalf("a bare ServiceAccount attaches nothing; got %v err=%v", none, err)
	}
	some, err := parseServiceAccountPullSecrets([]byte(`{"imagePullSecrets":[{"name":"ecr-xacct-pull"}]}`))
	if err != nil || len(some) != 1 || some[0] != "ecr-xacct-pull" {
		t.Fatalf("an attached secret must surface (it VOIDS the control); got %v err=%v", some, err)
	}
}

func TestBuildUnauthenticatedPullPod(t *testing.T) {
	y := buildUnauthenticatedPullPod(xacctRegistryDeniedPod, "default", "h.example.com/app:v1")
	for _, want := range []string{
		"kind: Pod",
		"name: " + xacctRegistryDeniedPod,
		"serviceAccountName: default",
		"automountServiceAccountToken: false",
		"image: h.example.com/app:v1",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("negative control missing %q:\n%s", want, y)
		}
	}
	// The control's entire meaning is the ABSENCE of a pull credential.
	if strings.Contains(y, "imagePullSecrets") {
		t.Errorf("the negative control must attach NO imagePullSecrets, or it proves nothing:\n%s", y)
	}
}

// The summary rides into the proof bundle, which is uploaded as an artifact and grep-scanned. It must
// carry verdicts and identity references, never a pull token.
func TestXacctRegistrySummaryCarriesNoSecrets(t *testing.T) {
	b, err := xacctRegistrySummaryJSON(xacctRegistrySummary{
		Provider: "aws", Slug: "ecr-xacct", RegistryHost: "acct.dkr.ecr.us-east-1.amazonaws.com",
		PullSecret: "ecr-xacct-pull", TargetRef: "arn:aws:iam::270587882865:role/pull",
		Image:             "acct.dkr.ecr.us-east-1.amazonaws.com/app:v1",
		RefresherRendered: true, IdentityAnnotated: true, SecretMinted: true,
		ImagePulled: true, ScopeDenied: true, Verdict: "PASS",
	})
	if err != nil {
		t.Fatal(err)
	}
	var s map[string]any
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatalf("summary must be valid JSON: %v", err)
	}
	if s["feature"] != "xacct-registry" {
		t.Errorf("feature must be stamped for the ledger, got %v", s["feature"])
	}
	for _, forbidden := range []string{"dockerconfigjson", "password", "token", "auth\":"} {
		if strings.Contains(string(b), forbidden) {
			t.Errorf("summary must not carry %q:\n%s", forbidden, b)
		}
	}
}

// repoRootFromThisFile resolves the repository root from this test file's own location, so the pins
// above work regardless of the working directory `go test` was invoked from.
func repoRootFromThisFile(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Join(filepath.Dir(thisFile), "..", "..")
}
