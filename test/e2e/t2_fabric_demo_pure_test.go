// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the PURE fabric enterprise-demo helpers (#845) — no cloud, no Postgres, no
// e2e_t2 tag. These prove the acceptance gate cannot pass vacuously: an empty tier list is a HARD
// error rather than a zero-iteration success, an artifact that PRE-EXISTED the placements is
// refused rather than credited to them, a repo-root sync is refused rather than accepted as a
// per-tier overlay, and the verdict only reads green when every tier actually placed, was caused by
// its placement, converged, and delivered resources.
package e2e

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestFabricDemoSlug(t *testing.T) {
	cases := []struct {
		name, env, tier, want string
	}{
		{"plain", "30735441957-1", "dev", "e2e-demo-dev-30735441957-1"},
		{"uppercase + spaces", " Prod ", "Staging", "e2e-demo-staging-prod"},
		{"unsafe characters collapse", "a/b_c", "dev", "e2e-demo-dev-a-b-c"},
		{"empty tier falls back", "x", "", "e2e-demo-env-x"},
		{"empty env is dropped", "", "dev", "e2e-demo-dev"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := fabricDemoSlug(c.env, c.tier); got != c.want {
				t.Fatalf("fabricDemoSlug(%q, %q) = %q, want %q", c.env, c.tier, got, c.want)
			}
		})
	}

	// The k8s namespace limit is 63 chars and a slug that blows it is rejected by the API server
	// AFTER the placement job is already running — bound it here instead.
	long := fabricDemoSlug(strings.Repeat("verylongenvironment", 10), "staging")
	if len(long) > 63 {
		t.Fatalf("slug is %d chars (%q) — exceeds the 63-char RFC-1123 namespace limit", len(long), long)
	}
	if strings.HasSuffix(long, "-") {
		t.Fatalf("truncated slug %q ends in '-', which is not a valid namespace", long)
	}

	// Disjoint from the sibling placement scenarios: several placements run inside ONE cluster
	// lifetime, so colliding prefixes would have them fight over the same namespace.
	if ns := fabricDemoSlug("e", "dev"); strings.HasPrefix(ns, namespaceTenantSlug("e")) || strings.HasPrefix(ns, vclusterTenantSlug("e")) {
		t.Fatalf("fabric-demo slug %q collides with the #959/#1308 namespaces", ns)
	}
}

func TestFabricDemoVClusterSlugIsDisjoint(t *testing.T) {
	const env = "run-1"
	got := fabricDemoVClusterSlug(env)

	// #845 places its own vcluster inside the SAME Fabric lifetime as #1308's. Identical names would
	// have the two scenarios helm-install over each other and destroy each other's registration.
	if got == vclusterTenantSlug(env) {
		t.Fatalf("fabric-demo vcluster %q collides with #1308's %q", got, vclusterTenantSlug(env))
	}
	if got == namespaceTenantSlug(env) {
		t.Fatalf("fabric-demo vcluster %q collides with #959's namespace", got)
	}
	// The host namespace is `vcluster-<name>` (prefix adds 9), which must still fit 63.
	if len(got) > 54 {
		t.Fatalf("vcluster name %q is %d chars — `vcluster-` + it would exceed the 63-char namespace limit", got, len(got))
	}
	if len(fabricDemoVClusterSlug(strings.Repeat("longenv", 20))) > 54 {
		t.Fatal("a long env must still be bounded to 54 chars")
	}
}

func TestFabricDemoTiers(t *testing.T) {
	t.Run("default tracks the enterprise-demo layout", func(t *testing.T) {
		tiers, err := fabricDemoTiers("run1", "aws")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := []fabricDemoOverlayTier{{"dev", "boutique-dev"}, {"staging", "boutique-staging"}}
		if len(tiers) != len(want) {
			t.Fatalf("default tiers = %v, want %v", tiers, want)
		}
		for i := range want {
			if tiers[i] != want[i] {
				t.Fatalf("tier %d = %+v, want %+v", i, tiers[i], want[i])
			}
		}
	})

	t.Run("normalises case and whitespace", func(t *testing.T) {
		t.Setenv(envFabricDemoOverlays, " Dev = Boutique-Dev , staging=boutique-staging ")
		tiers, err := fabricDemoTiers("run1", "aws")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if tiers[0] != (fabricDemoOverlayTier{"dev", "boutique-dev"}) {
			t.Fatalf("tier 0 = %+v, want {dev boutique-dev}", tiers[0])
		}
	})

	t.Run("a bare tier falls back to the derived slug", func(t *testing.T) {
		t.Setenv(envFabricDemoOverlays, "dev")
		tiers, err := fabricDemoTiers("run1", "aws")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if tiers[0].Namespace != fabricDemoSlug("run1", "dev") {
			t.Fatalf("bare tier namespace = %q, want the derived slug %q", tiers[0].Namespace, fabricDemoSlug("run1", "dev"))
		}
	})

	t.Run("the per-provider override wins", func(t *testing.T) {
		t.Setenv(envFabricDemoOverlays, "dev=boutique-dev")
		t.Setenv(envFabricDemoOverlays+"_GCP", "qa=boutique-qa")
		tiers, err := fabricDemoTiers("run1", "gcp")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(tiers) != 1 || tiers[0].Tier != "qa" {
			t.Fatalf("gcp tiers = %v, want the per-provider override [qa]", tiers)
		}
	})

	// A BLANK value means "unset" and falls back to the default (t2Env's convention, shared by every
	// var in this harness) — so it can never yield zero tiers.
	t.Run("blank falls back to the default, never to zero tiers", func(t *testing.T) {
		t.Setenv(envFabricDemoOverlays, "   ")
		tiers, err := fabricDemoTiers("run1", "aws")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(tiers) != 2 {
			t.Fatalf("blank value = %v, want the 2 default tiers", tiers)
		}
	})

	// Every one of these must be a HARD error. A gate that quietly accepts them asserts nothing, or
	// has two placements fighting over one namespace, and still reports success.
	refuters := map[string]string{
		"only separators":        " , , ",
		"empty tier name":        "=boutique-dev",
		"duplicate tier":         "dev=boutique-dev,dev=other-ns",
		"duplicate namespace":    "dev=shared-ns,staging=shared-ns",
		"invalid namespace":      "dev=Boutique_Dev!",
		"namespace with a slash": "dev=boutique/dev",
	}
	for name, raw := range refuters {
		t.Run("refutes/"+name, func(t *testing.T) {
			t.Setenv(envFabricDemoOverlays, raw)
			tiers, err := fabricDemoTiers("run1", "aws")
			if err == nil {
				t.Fatalf("%s = %q was accepted (tiers=%v) — it must be a hard error", envFabricDemoOverlays, raw, tiers)
			}
		})
	}
}

// TestFabricDemoDefaultTracksTheProductTemplate is the vacuity trap the DEFAULTS sit in.
//
// The default namespaces are load-bearing: RenderNamespaceTenant pins the tenant AppProject to the
// single placed namespace, so if the overlays declare a different one, ArgoCD refuses every sync and
// nothing ever converges. infra/templates/argocd/user-apps-overlays.yaml is the in-repo source of
// truth for what the enterprise-demo overlays actually target. Reading it here means a drift between
// the demo's layout and this harness fails in 200ms, not two hours into a real cloud run.
func TestFabricDemoDefaultTracksTheProductTemplate(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	tmpl, err := os.ReadFile(filepath.Join(filepath.Dir(thisFile), "..", "..", "infra", "templates", "argocd", "user-apps-overlays.yaml"))
	if err != nil {
		t.Fatalf("read user-apps-overlays.yaml: %v", err)
	}
	body := string(tmpl)

	tiers, err := fabricDemoTiers("run1", "aws")
	if err != nil {
		t.Fatalf("default tiers: %v", err)
	}
	for _, tier := range tiers {
		if !strings.Contains(body, tier.Namespace) {
			t.Errorf("default tier %q maps to namespace %q, which the product's own ApplicationSet template never mentions — the defaults have drifted from the enterprise-demo layout, and a placement into the wrong namespace can never converge (the tenant AppProject refuses it)", tier.Tier, tier.Namespace)
		}
	}
}

func TestFabricDemoOverlayPathAndStage(t *testing.T) {
	if got := fabricDemoOverlayPath(" Dev "); got != "overlays/dev" {
		t.Fatalf("fabricDemoOverlayPath = %q, want overlays/dev", got)
	}
	stages := map[string]string{
		"dev": "development", "staging": "staging", "stage": "staging",
		"prod": "production", "production": "production", "qa": "development",
	}
	for tier, want := range stages {
		got := fabricDemoStage(tier)
		if got != want {
			t.Errorf("fabricDemoStage(%q) = %q, want %q", tier, got, want)
		}
		// Whatever the mapping, it must be a REAL environment_stage enum value — these snapshots are
		// the shape a customer's console would emit, and a demo that ships an impossible value is
		// not a demo.
		switch got {
		case "development", "staging", "production":
		default:
			t.Errorf("fabricDemoStage(%q) = %q, which is not an environment_stage enum value", tier, got)
		}
	}
}

func TestFabricDemoTimeout(t *testing.T) {
	if got := fabricDemoTimeout(); got != 10*time.Minute {
		t.Fatalf("default timeout = %s, want 10m", got)
	}
	t.Setenv(envFabricDemoTimeout, "3m")
	if got := fabricDemoTimeout(); got != 3*time.Minute {
		t.Fatalf("override timeout = %s, want 3m", got)
	}
	t.Setenv(envFabricDemoTimeout, "not-a-duration")
	if got := fabricDemoTimeout(); got != 10*time.Minute {
		t.Fatalf("a malformed duration must fall back to 10m, got %s", got)
	}
	t.Setenv(envFabricDemoTimeout, "-5m")
	if got := fabricDemoTimeout(); got != 10*time.Minute {
		t.Fatalf("a non-positive duration must fall back to 10m, got %s", got)
	}
}

func TestBuildFabricDemoSnapshot(t *testing.T) {
	p := fabricDemoParams{project: "acme", env: "run1", provider: "aws", region: "us-east-1", fabricClust: "acme-run1"}
	snap := buildFabricDemoSnapshot(p, fabricDemoOverlayTier{"dev", "boutique-dev"}, "https://github.com/o/r")

	if snap["placement_mode"] != "namespace" {
		t.Errorf("placement_mode = %v, want namespace", snap["placement_mode"])
	}
	if snap["namespace"] != "boutique-dev" {
		t.Errorf("namespace = %v, want boutique-dev — it must be the namespace the OVERLAY declares, or the tenant AppProject refuses every resource", snap["namespace"])
	}
	if snap["environment_stage"] != "development" {
		t.Errorf("environment_stage = %v, want development", snap["environment_stage"])
	}

	// A namespace placement runs NO tofu. Carrying a node shape would silently ask for one.
	cluster, ok := snap["cluster"].(map[string]any)
	if !ok || len(cluster) != 1 || cluster["cluster_name"] != "acme-run1" {
		t.Errorf("cluster = %v, want exactly {cluster_name: acme-run1} — any extra key is a node shape, and a placement provisions nothing", snap["cluster"])
	}

	repos, ok := snap["repositories"].(map[string]any)
	if !ok || repos["apps_destination_repo"] != "https://github.com/o/r" {
		t.Fatalf("repositories = %v, want the demo repo", snap["repositories"])
	}
	if repos["apps_path"] != "overlays/dev" {
		t.Errorf("apps_path = %v, want overlays/dev", repos["apps_path"])
	}
	// The refuter: without apps_path the runner renders the repo ROOT, every tier delivers the whole
	// repository, and "the dev overlay converged" means nothing.
	if repos["apps_path"] == "." || repos["apps_path"] == "" {
		t.Fatal("a root sync delivers the whole repo, not this tier's overlay — the Kustomize claim would be vacuous")
	}
}

func TestParseKubeIdents(t *testing.T) {
	const list = `{"items":[
	  {"metadata":{"name":"app-a","uid":"u1","creationTimestamp":"2026-08-01T10:00:00Z"}},
	  {"metadata":{"name":"app-b","uid":"u2","creationTimestamp":"2026-08-01T11:00:00Z"}}]}`
	got, err := parseKubeIdents([]byte(list))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 || got["app-a"].UID != "u1" || got["app-b"].Created != "2026-08-01T11:00:00Z" {
		t.Fatalf("parseKubeIdents = %+v", got)
	}

	empty, err := parseKubeIdents([]byte(`{"items":[]}`))
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty list = %+v, err=%v; want an empty map and no error", empty, err)
	}
	if _, err := parseKubeIdents([]byte(`not json`)); err == nil {
		t.Fatal("malformed JSON must be an error, not an empty baseline — an empty baseline would make every artifact look newly created")
	}
}

// TestAssertCausedByPlacement is the anti-vacuity refuter set. The "PRE-EXISTING artifact is
// refused" case is the one that fails if this scenario ever regresses to crediting a placement with
// something the base deploy created.
func TestAssertCausedByPlacement(t *testing.T) {
	const name = "app-acme-boutique-dev"
	cases := []struct {
		name           string
		before, after  map[string]kubeIdent
		wantErr        bool
		wantErrContain string
	}{
		{
			name:   "absent before, present after",
			before: map[string]kubeIdent{},
			after:  map[string]kubeIdent{name: {UID: "u1", Created: "2026-08-01T12:00:00Z"}},
		},
		{
			name:           "PRE-EXISTING artifact is refused",
			before:         map[string]kubeIdent{name: {UID: "u0", Created: "2026-08-01T09:00:00Z"}},
			after:          map[string]kubeIdent{name: {UID: "u0", Created: "2026-08-01T09:00:00Z"}},
			wantErr:        true,
			wantErrContain: "already existed BEFORE",
		},
		{
			name:    "pre-existing under a NEW uid is still refused",
			before:  map[string]kubeIdent{name: {UID: "u0"}},
			after:   map[string]kubeIdent{name: {UID: "u9"}},
			wantErr: true,
		},
		{
			name:           "absent after",
			before:         map[string]kubeIdent{},
			after:          map[string]kubeIdent{},
			wantErr:        true,
			wantErrContain: "created nothing",
		},
		{
			name:    "present after but with no uid",
			before:  map[string]kubeIdent{},
			after:   map[string]kubeIdent{name: {UID: "  "}},
			wantErr: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := assertCausedByPlacement("Application", name, c.before, c.after)
			if c.wantErr && err == nil {
				t.Fatal("expected an error — crediting a placement with an artifact it did not create makes the whole gate theatre")
			}
			if !c.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if c.wantErrContain != "" && !strings.Contains(err.Error(), c.wantErrContain) {
				t.Fatalf("error %q should mention %q", err.Error(), c.wantErrContain)
			}
		})
	}
}

func TestSameRepoURL(t *testing.T) {
	base := "https://github.com/alethialabs-io/enterprise-demo"
	for _, equal := range []string{base, base + ".git", base + "/", strings.ToUpper(base), " " + base + " "} {
		if !sameRepoURL(base, equal) {
			t.Errorf("sameRepoURL(%q, %q) = false, want true", base, equal)
		}
	}
	for _, diff := range []string{"https://github.com/other/repo", "", "   "} {
		if sameRepoURL(base, diff) {
			t.Errorf("sameRepoURL(%q, %q) = true, want false", base, diff)
		}
	}
	if sameRepoURL("", "") {
		t.Error("two empty URLs must not compare equal — that would make the repo precondition vacuous")
	}
}

func TestFabricDemoRepoPrecondition(t *testing.T) {
	const demo = "https://github.com/alethialabs-io/enterprise-demo"
	if err := fabricDemoRepoPrecondition("", demo); err != nil {
		t.Errorf("no base apps repo must be fine: %v", err)
	}
	if err := fabricDemoRepoPrecondition("https://github.com/acme/other", demo); err != nil {
		t.Errorf("a different base repo must be fine: %v", err)
	}
	for _, same := range []string{demo, demo + ".git", demo + "/", strings.ToUpper(demo)} {
		if err := fabricDemoRepoPrecondition(same, demo); err == nil {
			t.Errorf("base repo %q is the demo repo — the base ApplicationSet already delivers these overlays, so the placements would prove nothing and would collide", same)
		}
	}
}

func TestAssertTenantAppOverlay(t *testing.T) {
	const repo = "https://github.com/alethialabs-io/enterprise-demo"
	app := func(repoURL, path string) namespaceAppState {
		var a namespaceAppState
		a.Metadata.Name = "app-acme-boutique-dev"
		a.Spec.Source.RepoURL = repoURL
		a.Spec.Source.Path = path
		return a
	}

	if err := assertTenantAppOverlay(app(repo, "overlays/dev"), repo, "dev"); err != nil {
		t.Fatalf("the matching overlay must be accepted: %v", err)
	}
	if err := assertTenantAppOverlay(app(repo+".git", "overlays/dev"), repo, "dev"); err != nil {
		t.Fatalf("a .git suffix must not matter: %v", err)
	}

	t.Run("a repo-ROOT sync is refused", func(t *testing.T) {
		err := assertTenantAppOverlay(app(repo, "."), repo, "dev")
		if err == nil {
			t.Fatal("syncing the repo root is NOT a per-tier overlay proof — it is what the product did before apps_path was wired, and it converges Healthy just the same")
		}
		if !strings.Contains(err.Error(), "apps_path") {
			t.Errorf("the error should name apps_path so the cause is diagnosable; got %q", err.Error())
		}
	})

	if err := assertTenantAppOverlay(app(repo, ""), repo, "dev"); err == nil {
		t.Error("an empty source path must be refused")
	}
	if err := assertTenantAppOverlay(app(repo, "overlays/staging"), repo, "dev"); err == nil {
		t.Error("the WRONG tier's overlay must be refused — otherwise two tiers could both 'prove' the same directory")
	}
	if err := assertTenantAppOverlay(app("https://github.com/acme/other", "overlays/dev"), repo, "dev"); err == nil {
		t.Error("a foreign repo must be refused")
	}
}

func TestFabricDemoVClusterTier(t *testing.T) {
	tiers := []fabricDemoOverlayTier{{"dev", "boutique-dev"}, {"staging", "boutique-staging"}}

	got, err := fabricDemoVClusterTier("aws", tiers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Tier != "staging" {
		t.Fatalf("default vcluster tier = %q, want staging", got.Tier)
	}

	t.Run("an unknown tier is refused", func(t *testing.T) {
		t.Setenv(envFabricDemoVCluster, "prod")
		if _, err := fabricDemoVClusterTier("aws", tiers); err == nil {
			t.Fatal("a vcluster tier that is not among the configured tiers must be a hard error")
		}
	})

	// There is NO configuration that yields zero vcluster tiers, which is the property #845 needs:
	// a blank value falls back to the default (t2Env's convention), and any non-blank value that
	// does not name a configured tier is a hard error. So the headline differentiator can never be
	// silently dropped — only explicitly mis-configured, loudly.
	t.Run("blank falls back to the default, never to no vcluster", func(t *testing.T) {
		t.Setenv(envFabricDemoVCluster, "   ")
		got, err := fabricDemoVClusterTier("aws", tiers)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Tier != fabricDemoDefaultVClusterTier {
			t.Fatalf("blank value = %q, want the default %q", got.Tier, fabricDemoDefaultVClusterTier)
		}
	})
}

// passingFabricDemoSummary is the minimal fully-green verdict. Every refuter below breaks exactly
// one field of it, so each assertion is proven load-bearing rather than decorative.
func passingFabricDemoSummary() FabricDemoSummary {
	return FabricDemoSummary{
		Enabled:  true,
		Provider: "aws",
		Fabric:   "acme-run1",
		Repo:     "https://github.com/alethialabs-io/enterprise-demo",
		Tiers: []FabricDemoTier{
			{Tier: "dev", Namespace: "boutique-dev", Placed: true, TenantApp: "app-acme-boutique-dev", TenantProject: "tenant-acme-boutique-dev", SourcePath: "overlays/dev", CausedByPlacement: true, Converged: true, ResourceCount: 3},
			{Tier: "staging", Namespace: "boutique-staging", Placed: true, TenantApp: "app-acme-boutique-staging", TenantProject: "tenant-acme-boutique-staging", SourcePath: "overlays/staging", CausedByPlacement: true, Converged: true, ResourceCount: 3},
		},
		VCluster:           FabricDemoVCluster{Name: "e2e-vcdemo-run1", Tier: "staging", Placed: true, App: "vc-app", SourcePath: "overlays/staging", CausedByPlacement: true, ResourceCount: 2, Deregistered: true},
		ArgoNotReinstalled: true,
		ReceiptScope:       "fabric",
		FabricPlanSHA:      strings.Repeat("a", 64),
		DriftChecked:       true,
		DriftInSync:        true,
	}
}

func TestFabricDemoVerdictPass(t *testing.T) {
	if !fabricDemoVerdictPass(passingFabricDemoSummary()) {
		t.Fatal("the fully-green summary must pass, or every refuter below is meaningless")
	}

	refuters := map[string]func(*FabricDemoSummary){
		"disabled":                          func(s *FabricDemoSummary) { s.Enabled = false },
		"no tiers at all":                   func(s *FabricDemoSummary) { s.Tiers = nil },
		"a tier never placed":               func(s *FabricDemoSummary) { s.Tiers[0].Placed = false },
		"a tier's app PRE-EXISTED":          func(s *FabricDemoSummary) { s.Tiers[0].CausedByPlacement = false },
		"a tier never converged":            func(s *FabricDemoSummary) { s.Tiers[0].Converged = false },
		"a tier delivered nothing":          func(s *FabricDemoSummary) { s.Tiers[0].ResourceCount = 0 },
		"a tier synced the repo ROOT":       func(s *FabricDemoSummary) { s.Tiers[0].SourcePath = "." },
		"a tier synced the WRONG overlay":   func(s *FabricDemoSummary) { s.Tiers[0].SourcePath = "overlays/staging" },
		"no vcluster tier at all":           func(s *FabricDemoSummary) { s.VCluster = FabricDemoVCluster{} },
		"the vcluster never placed":         func(s *FabricDemoSummary) { s.VCluster.Placed = false },
		"the vcluster PRE-EXISTED":          func(s *FabricDemoSummary) { s.VCluster.CausedByPlacement = false },
		"the vcluster delivered nothing":    func(s *FabricDemoSummary) { s.VCluster.ResourceCount = 0 },
		"the vcluster leaked registration":  func(s *FabricDemoSummary) { s.VCluster.Deregistered = false },
		"argocd was reinstalled":            func(s *FabricDemoSummary) { s.ArgoNotReinstalled = false },
		"no verified fabric receipt":        func(s *FabricDemoSummary) { s.FabricPlanSHA = "" },
		"drift ran and reported not-synced": func(s *FabricDemoSummary) { s.DriftInSync = false },
		"drift ran and found drift":         func(s *FabricDemoSummary) { s.DriftDrifted = 2 },
	}
	for name, breakOne := range refuters {
		t.Run("refutes/"+name, func(t *testing.T) {
			s := passingFabricDemoSummary()
			breakOne(&s)
			if fabricDemoVerdictPass(s) {
				t.Fatalf("%q still read GREEN — that assertion is decorative, not load-bearing", name)
			}
		})
	}

	// An UN-RUN drift check must not gate: it is an optional layer, unlike the vcluster tier.
	s := passingFabricDemoSummary()
	s.DriftChecked, s.DriftInSync, s.DriftDrifted = false, false, 0
	if !fabricDemoVerdictPass(s) {
		t.Fatal("a drift check that never ran must not fail the verdict — only one that ran and reported badly")
	}
}

func TestFabricDemoSummaryVerdict(t *testing.T) {
	t.Run("skipped", func(t *testing.T) {
		got := fabricDemoSummaryVerdict(FabricDemoSummary{})
		if !strings.Contains(got, "skipped") || !strings.Contains(got, envFabricDemo) {
			t.Fatalf("verdict = %q, want a skip mentioning %s", got, envFabricDemo)
		}
	})

	t.Run("passing", func(t *testing.T) {
		got := fabricDemoSummaryVerdict(passingFabricDemoSummary())
		for _, want := range []string{"✅", "overlays/dev", "boutique-dev", "e2e-vcdemo-run1", "receipt(fabric)", "in_sync=true"} {
			if !strings.Contains(got, want) {
				t.Errorf("verdict %q is missing %q", got, want)
			}
		}
		// The digest is abbreviated, never dumped in full.
		if strings.Contains(got, strings.Repeat("a", 64)) {
			t.Errorf("verdict should abbreviate the plan digest, got %q", got)
		}
	})

	t.Run("failing", func(t *testing.T) {
		s := passingFabricDemoSummary()
		s.Tiers[0].ResourceCount = 0
		if got := fabricDemoSummaryVerdict(s); !strings.Contains(got, "❌") {
			t.Fatalf("a failing summary must render ❌, got %q", got)
		}
	})
}

func TestShortPlanSHA(t *testing.T) {
	if got := shortPlanSHA(""); got != "absent" {
		t.Errorf("empty digest = %q, want absent", got)
	}
	if got := shortPlanSHA("abc"); got != "abc" {
		t.Errorf("short digest = %q, want it verbatim", got)
	}
	if got := shortPlanSHA(strings.Repeat("f", 64)); got != strings.Repeat("f", 12)+"…" {
		t.Errorf("long digest = %q, want a 12-char abbreviation", got)
	}
}
