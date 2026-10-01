// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const (
	shaApps  = "cfe20cf21f03ac6e87ca0be5ebc65939c88daef6"
	shaChart = "8644405b600000632e1b84a7bc7359dbdc948cee"
	shaAI    = "d5b9bed058b6fdf7e03bede73ac0e03738b2a697"
)

// testCharts is the OCI pin map the harness resolves before any spend — the tags starter-ai pins,
// with the digests their registries served for them when this was written.
func testCharts() map[string]ociChartPin {
	return map[string]ociChartPin{
		"kserve-crd": {File: "addons/kserve-crd.yaml", RepoURL: "oci://ghcr.io/kserve/charts/kserve-crd", Tag: "v0.15.2",
			Digest: "sha256:d78ee8127353921f443a2c644335b8d45cacd1234fff81eb6a62c8eb73d55933"},
		"kserve": {File: "addons/kserve.yaml", RepoURL: "oci://ghcr.io/kserve/charts/kserve", Tag: "v0.15.2",
			Digest: "sha256:3f4e61bb603dd70c51fd6f352eb9bb1f40b06a2b29c138acccb8896d09b94fdd"},
		"kueue": {File: "addons/kueue.yaml", RepoURL: "oci://registry.k8s.io/kueue/charts/kueue", Tag: "0.19.5",
			Digest: "sha256:570cdfce9f9928a8cf36ea814278e2e56651d2e7f2dac3363ebf3e0cda303bc2"},
	}
}

// testCommits is the resolved-HEAD map the harness builds before any spend.
func testCommits() map[string]string {
	return map[string]string{starterAppsRepo: shaApps, starterChartRepo: shaChart, starterAIRepo: shaAI}
}

func clearTemplatesEnv(t *testing.T) {
	t.Helper()
	for _, v := range []string{envTemplates, "ALETHIA_E2E_MAX_CONFIG", "ALETHIA_E2E_ALL_ADDONS"} {
		t.Setenv(v, "")
	}
}

func TestTemplatesDecide(t *testing.T) {
	clearTemplatesEnv(t)
	if on, err := templatesFromEnv("hetzner").decide(); on || err != nil {
		t.Fatalf("off: got on=%v err=%v, want a clean no-op", on, err)
	}
	t.Setenv(envTemplates, "1")
	if on, err := templatesFromEnv("hetzner").decide(); !on || err != nil {
		t.Fatalf("hetzner: got on=%v err=%v, want on", on, err)
	}
	for _, cloud := range []string{"aws", "gcp", "azure", "alibaba", ""} {
		on, err := templatesFromEnv(cloud).decide()
		if on || err == nil || !strings.Contains(err.Error(), "hetzner only") {
			t.Errorf("%q: got on=%v err=%v, want a refusal naming hetzner", cloud, on, err)
		}
	}
	t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
	if on, err := templatesFromEnv("hetzner").decide(); on || err == nil {
		t.Errorf("beside ALL_ADDONS: got on=%v err=%v, want a refusal", on, err)
	}
}

// The resolver and this file must name the same cloud, and the resolver's fidelity must be what
// turns this scenario on — a dimension whose switch nothing emits proves nothing.
func TestTemplatesProviderMatchesTheResolver(t *testing.T) {
	_, thisFile, _, _ := runtime.Caller(0)
	resolver := filepath.Join(filepath.Dir(thisFile), "..", "..", "scripts", "e2e", "resolve-dimension.sh")
	out, err := exec.Command("bash", resolver, "--providers", "templates").Output()
	if err != nil {
		t.Fatalf("resolve-dimension.sh --providers templates: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != templatesProvider {
		t.Errorf("resolver restricts templates to %q, this file to %q", got, templatesProvider)
	}
	fid, err := exec.Command("bash", resolver, "--fidelity", "templates").Output()
	if err != nil {
		t.Fatalf("resolve-dimension.sh --fidelity templates: %v", err)
	}
	if !strings.Contains(string(fid), envTemplates+"=1") {
		t.Errorf("the templates fidelity does not set %s=1:\n%s", envTemplates, fid)
	}
}

func TestTemplatesApplyToSnapshot(t *testing.T) {
	// The shape a05NormalizeSnapshot leaves behind: add-ons as []any of maps.
	snap := map[string]any{
		"addons":       []any{map[string]any{"id": "reloader", "mode": "managed"}},
		"repositories": map[string]any{"apps_destination_repo": "https://example.com/stale", "apps_path": "overlays/dev"},
	}
	if err := (templatesConfig{provider: "hetzner", enabled: true}).applyToSnapshot(snap); err != nil {
		t.Fatal(err)
	}
	repos := snap["repositories"].(map[string]any)
	if repos["apps_destination_repo"] != starterAIRepo {
		t.Errorf("apps repo = %v, want %s", repos["apps_destination_repo"], starterAIRepo)
	}
	if _, ok := repos["apps_path"]; ok {
		t.Error("apps_path survived — the tutorial leaves the overlay path EMPTY, and a path turns overlay discovery off")
	}
	addons := snap["addons"].([]any)
	if len(addons) != 3 {
		t.Fatalf("got %d add-ons, want reloader + 2 BYO charts: %v", len(addons), addons)
	}
	if m, ok := addons[0].(map[string]any); !ok || m["id"] != "reloader" {
		t.Errorf("the seeded add-on was not preserved: %v", addons[0])
	}
	want := map[string]string{starterChartAddonID: starterChartRepo, starterAIAddonID: starterAIRepo}
	for _, a := range addons[1:] {
		b := a.(types.AddOnInstall)
		if want[b.ID] != b.ChartRepo || b.Path != "chart" || b.Version != "HEAD" || b.Source != "git" || b.Mode != "managed" {
			t.Errorf("BYO chart %+v is not the tutorial's (repo, path chart, ref HEAD, git, managed)", b)
		}
	}
	if c, _ := snap["webhook_ca_consumers"].([]string); len(c) != 1 || c[0] != "kserve" {
		t.Errorf("webhook_ca_consumers = %v, want [kserve] — the AI Workloads template's marker", snap["webhook_ca_consumers"])
	}
	// The ProjectConfig the runner decodes must carry every one of those.
	raw, _ := json.Marshal(snap)
	var pc types.ProjectConfig
	if err := json.Unmarshal(raw, &pc); err != nil {
		t.Fatal(err)
	}
	if pc.Repositories.AppsDestinationRepo != starterAIRepo || len(pc.WebhookCAConsumers) != 1 || len(pc.AddOns) != 3 {
		t.Errorf("the runner would read repo=%q consumers=%v addons=%d", pc.Repositories.AppsDestinationRepo, pc.WebhookCAConsumers, len(pc.AddOns))
	}
	// Twice is a refusal, never a duplicate chart.
	if err := (templatesConfig{}).applyToSnapshot(snap); err == nil {
		t.Error("a second application installed the charts twice")
	}
}

func TestTemplatesPhaseBChangesOnlyTheAppsRepo(t *testing.T) {
	a := map[string]any{"addons": []any{}, "cluster": map[string]any{"node_desired_size": 2}}
	if err := (templatesConfig{}).applyToSnapshot(a); err != nil {
		t.Fatal(err)
	}
	beforeA, _ := json.Marshal(a)
	b, err := templatesPhaseBSnapshot(a)
	if err != nil {
		t.Fatal(err)
	}
	if afterA, _ := json.Marshal(a); string(afterA) != string(beforeA) {
		t.Error("phase B mutated phase A's snapshot")
	}
	if got := b["repositories"].(map[string]any)["apps_destination_repo"]; got != starterAppsRepo {
		t.Errorf("phase B apps repo = %v, want %s", got, starterAppsRepo)
	}
	// Everything else identical.
	b["repositories"].(map[string]any)["apps_destination_repo"] = starterAIRepo
	bj, _ := json.Marshal(b)
	var aNorm map[string]any
	_ = json.Unmarshal(beforeA, &aNorm)
	aj, _ := json.Marshal(aNorm)
	if string(aj) != string(bj) {
		t.Errorf("phase B changed more than the apps repo:\nA %s\nB %s", aj, bj)
	}
	if _, err := templatesPhaseBSnapshot(map[string]any{}); err == nil {
		t.Error("a snapshot that is not phase A was re-pointed anyway")
	}
}

// appsJSON renders a `kubectl get applications -o json` payload.
func appsJSON(t *testing.T, apps map[string]templateAppObserved) []byte {
	t.Helper()
	var items []map[string]any
	for name, o := range apps {
		res := make([]map[string]any, o.Resources)
		for i := range res {
			res[i] = map[string]any{"kind": "ConfigMap", "name": "x"}
		}
		items = append(items, map[string]any{
			"metadata": map[string]any{"name": name},
			"spec":     map[string]any{"source": map[string]any{"repoURL": o.RepoURL, "chart": o.Chart, "targetRevision": o.TargetRevision}},
			"status": map[string]any{
				"health":    map[string]any{"status": o.Health},
				"sync":      map[string]any{"status": o.Sync, "revision": o.Revision},
				"resources": res,
			},
		})
	}
	raw, err := json.Marshal(map[string]any{"items": items})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// greenPhaseA is a fully-converged phase A as ArgoCD would report it.
func greenPhaseA() map[string]templateAppObserved {
	git := func(repo, sha string, n int) templateAppObserved {
		return templateAppObserved{Health: "Healthy", Sync: "Synced", Revision: sha, RepoURL: repo, TargetRevision: "HEAD", Resources: n}
	}
	// ArgoCD 3.x reports a native OCI source's synced revision as the manifest DIGEST.
	oci := func(app string) templateAppObserved {
		pin := testCharts()[app]
		return templateAppObserved{Health: "Healthy", Sync: "Synced", Revision: pin.Digest, RepoURL: pin.RepoURL, TargetRevision: pin.Tag, Resources: 4}
	}
	return map[string]templateAppObserved{
		"apps":                git(starterAIRepo, shaAI, 2),
		"addons":              git(starterAIRepo, shaAI, 3),
		"kserve-crd":          oci("kserve-crd"),
		"kserve":              oci("kserve"),
		"kueue":               oci("kueue"),
		"cert-manager":        {Health: "Healthy", Sync: "Synced", Revision: "v1.18.2", RepoURL: "https://charts.jetstack.io", Resources: 40},
		"addon-starter-ai":    git(starterAIRepo+".git", shaAI, 12),
		"addon-starter-chart": git(starterChartRepo, shaChart, 3),
	}
}

func TestTemplatesPhaseAGreen(t *testing.T) {
	observed, err := parseTemplateApps(appsJSON(t, greenPhaseA()))
	if err != nil {
		t.Fatal(err)
	}
	results, err := evaluateTemplateApps(templatesPhaseAExpect(), observed, testCommits(), testCharts())
	if err != nil {
		t.Fatalf("a converged phase A failed: %v", err)
	}
	if len(results) != len(templatesPhaseAExpect()) {
		t.Fatalf("got %d rows, want one per expected Application", len(results))
	}
	for _, r := range results {
		if r.Source == templateSourceGit && r.Revision != r.ExpectedRevision {
			t.Errorf("%s: recorded revision %q vs expected %q", r.Application, r.Revision, r.ExpectedRevision)
		}
	}
}

// Each way phase A can look converged while proving something else must fail — and name the app.
func TestTemplatesPhaseARefusals(t *testing.T) {
	cases := []struct {
		name, app, mustSay string
		mutate             func(o *templateAppObserved)
		drop               bool
	}{
		{name: "a stale template commit", app: "apps", mustSay: "not the template's HEAD",
			mutate: func(o *templateAppObserved) { o.Revision = "0000000000000000000000000000000000000000" }},
		{name: "a fork instead of the template", app: "addon-starter-chart", mustSay: "not the template",
			mutate: func(o *templateAppObserved) { o.RepoURL = "https://github.com/someone/alethia-starter-chart" }},
		{name: "an empty render", app: "addon-starter-ai", mustSay: "rendered nothing",
			mutate: func(o *templateAppObserved) { o.Resources = 0 }},
		{name: "Progressing", app: "kserve", mustSay: "health=Progressing",
			mutate: func(o *templateAppObserved) { o.Health = "Progressing" }},
		{name: "OutOfSync", app: "addons", mustSay: "sync=OutOfSync",
			mutate: func(o *templateAppObserved) { o.Sync = "OutOfSync" }},
		{name: "a chart version the template did not pin", app: "kueue", mustSay: "not the pinned chart version",
			mutate: func(o *templateAppObserved) { o.Revision = "0.20.0" }},
		{name: "cert-manager missing", app: "cert-manager", mustSay: "MISSING", drop: true},
		{name: "kserve-crd missing", app: "kserve-crd", mustSay: "MISSING", drop: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			obs := greenPhaseA()
			if c.drop {
				delete(obs, c.app)
			} else {
				o := obs[c.app]
				c.mutate(&o)
				obs[c.app] = o
			}
			results, err := evaluateTemplateApps(templatesPhaseAExpect(), obs, testCommits(), testCharts())
			if err == nil || !strings.Contains(err.Error(), c.app) || !strings.Contains(err.Error(), c.mustSay) {
				t.Fatalf("want a refusal naming %q and %q, got %v", c.app, c.mustSay, err)
			}
			for _, r := range results {
				if (r.Application == c.app) == r.OK {
					t.Errorf("%s: ok=%v, want only %s failed", r.Application, r.OK, c.app)
				}
			}
		})
	}
	// No resolved commit is not a pass.
	if _, err := evaluateTemplateApps(templatesPhaseAExpect(), greenPhaseA(), map[string]string{}, testCharts()); err == nil {
		t.Error("with no resolved commit the revision check passed anyway")
	}
	if _, err := evaluateTemplateApps(nil, greenPhaseA(), testCommits(), testCharts()); err == nil {
		t.Error("an empty expected set passed")
	}
}

func TestTemplatesPhaseBAllowsAnEmptyAddonsButNothingElse(t *testing.T) {
	g := func(n int) templateAppObserved {
		return templateAppObserved{Health: "Healthy", Sync: "Synced", Revision: shaApps, RepoURL: starterAppsRepo, TargetRevision: "HEAD", Resources: n}
	}
	obs := map[string]templateAppObserved{"apps": g(3), "apps-dev": g(3), "apps-staging": g(3), "addons": g(0)}
	if _, err := evaluateTemplateApps(templatesPhaseBExpect(), obs, testCommits(), testCharts()); err != nil {
		t.Fatalf("a converged phase B failed: %v", err)
	}
	obs["apps-dev"] = g(0)
	if _, err := evaluateTemplateApps(templatesPhaseBExpect(), obs, testCommits(), testCharts()); err == nil || !strings.Contains(err.Error(), "apps-dev") {
		t.Errorf("an empty overlay passed: %v", err)
	}
	// Still pointing at starter-ai: the re-point never happened.
	obs["apps-dev"] = g(3)
	stale := g(2)
	stale.RepoURL, stale.Revision = starterAIRepo, shaAI
	obs["apps"] = stale
	if _, err := evaluateTemplateApps(templatesPhaseBExpect(), obs, testCommits(), testCharts()); err == nil {
		t.Error("a root still syncing starter-ai passed phase B")
	}
}

func TestParseLsRemoteHead(t *testing.T) {
	if got, err := parseLsRemoteHead(shaAI + "\tHEAD\n"); err != nil || got != shaAI {
		t.Fatalf("got %q %v", got, err)
	}
	for _, bad := range []string{"", "deadbeef\tHEAD\n", shaAI + "\trefs/heads/main\n", shaAI + "\tHEAD\n" + shaApps + "\tHEAD\n"} {
		if _, err := parseLsRemoteHead(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestParseHcloudServerCosts(t *testing.T) {
	server := func(name, typ, loc, net, gross string) map[string]any {
		return map[string]any{
			"name": name,
			"server_type": map[string]any{"name": typ, "prices": []any{
				map[string]any{"location": "fsn1", "price_hourly": map[string]any{"net": "9.9", "gross": "9.9"}},
				map[string]any{"location": loc, "price_hourly": map[string]any{"net": net, "gross": gross}},
			}},
			"datacenter": map[string]any{"location": map[string]any{"name": loc}},
		}
	}
	raw, _ := json.Marshal(map[string]any{"servers": []any{
		server("w-1", "cpx32", "nbg1", "0.0200", "0.0238"),
		server("cp-1", "cpx32", "nbg1", "0.0200", "0.0238"),
		server("w-2", "cpx32", "nbg1", "0.0200", "0.0238"),
	}})
	servers, net, gross, err := parseHcloudServerCosts(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 3 || servers[0].Name != "cp-1" {
		t.Errorf("servers = %+v", servers)
	}
	// Each server priced for ITS location, not the first price in the list (fsn1's 9.9).
	if net < 0.0599 || net > 0.0601 || gross < 0.0713 || gross > 0.0715 {
		t.Errorf("net=%v gross=%v, want 0.06 / 0.0714", net, gross)
	}
	empty, _ := json.Marshal(map[string]any{"servers": []any{}})
	if _, _, _, err := parseHcloudServerCosts(empty); err == nil {
		t.Error("no servers priced as free")
	}
	noPrice, _ := json.Marshal(map[string]any{"servers": []any{server("w", "cpx32", "hel1", "1", "1")}})
	var v map[string]any
	_ = json.Unmarshal(noPrice, &v)
	s := v["servers"].([]any)[0].(map[string]any)
	s["datacenter"] = map[string]any{"location": map[string]any{"name": "ash"}}
	noPrice, _ = json.Marshal(v)
	if _, _, _, err := parseHcloudServerCosts(noPrice); err == nil {
		t.Error("a server with no price for its location was priced anyway")
	}
}

func TestTemplatesSummaryLifecycle(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	s := newTemplatesSummary("hetzner", "c", testCommits())
	if s.Verdict != templateNotRun || len(s.Templates) != 3 {
		t.Fatalf("skeleton: %+v", s)
	}
	for _, v := range s.Templates {
		if v.Commit == "" || v.Path == "" || v.Verdict != templateNotRun {
			t.Errorf("skeleton row %+v", v)
		}
	}
	obs := greenPhaseA()
	resA, err := evaluateTemplateApps(templatesPhaseAExpect(), obs, testCommits(), testCharts())
	if err != nil {
		t.Fatal(err)
	}
	s.record(resA, nil, now)
	if s.template("ai").Verdict != templatePass || s.template("chart").Verdict != templatePass || s.template("apps").Verdict != templateNotRun {
		t.Fatalf("after phase A: %+v", s.Templates)
	}
	if s.Verdict != templateNotRun {
		t.Errorf("overall %s with apps not run, want NOT_RUN", s.Verdict)
	}
	s.fail([]string{"apps"}, "redeploy died", now)
	if s.template("apps").Verdict != templateFail || s.Verdict != templateFail || s.template("ai").Verdict != templatePass {
		t.Fatalf("after a phase-B failure: %+v", s.Templates)
	}
	// A failed chart row fails only the chart.
	obs["addon-starter-chart"] = templateAppObserved{Health: "Degraded", Sync: "Synced", Revision: shaChart, RepoURL: starterChartRepo, Resources: 3}
	res2, err2 := evaluateTemplateApps(templatesPhaseAExpect(), obs, testCommits(), testCharts())
	s2 := newTemplatesSummary("hetzner", "c", testCommits())
	s2.record(res2, err2, now)
	if s2.template("chart").Verdict != templateFail || s2.template("ai").Verdict != templatePass {
		t.Errorf("a chart failure leaked: chart=%s ai=%s", s2.template("chart").Verdict, s2.template("ai").Verdict)
	}
	path := filepath.Join(t.TempDir(), "sub", "templates-summary.json")
	if err := writeTemplatesSummary(path, s); err != nil {
		t.Fatal(err)
	}
	var back TemplatesSummary
	raw, _ := os.ReadFile(path)
	if err := json.Unmarshal(raw, &back); err != nil || back.Verdict != templateFail || len(back.Templates) != 3 {
		t.Errorf("round trip: %v %+v", err, back)
	}
	if err := writeTemplatesSummary("", s); err != nil {
		t.Errorf("an unset path must be a no-op: %v", err)
	}
}

// The committed shape must hold the templates, and the check must be able to say NO — a sizing
// guard that passes every shape is not one.
func TestTemplatesShapeFixture(t *testing.T) {
	_, thisFile, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(thisFile), "fixtures", "cluster_json.templates.hetzner.json"))
	if err != nil {
		t.Fatal(err)
	}
	var shape struct {
		InstanceTypes []string `json:"instance_types"`
		NodeSize      struct {
			VCPU     int `json:"vcpu"`
			MemoryGB int `json:"memory_gb"`
		} `json:"node_size"`
		Min     int `json:"node_min_size"`
		Max     int `json:"node_max_size"`
		Desired int `json:"node_desired_size"`
	}
	if err := json.Unmarshal(raw, &shape); err != nil {
		t.Fatal(err)
	}
	if len(shape.InstanceTypes) != 1 || shape.InstanceTypes[0] != "cpx32" {
		t.Errorf("instance_types = %v — the sizing argument (templatesShapeWhy) is for cpx32", shape.InstanceTypes)
	}
	if shape.Min != shape.Desired || shape.Max != shape.Desired {
		t.Errorf("min/max/desired %d/%d/%d — Hetzner reads worker_count from desired; keep them equal so the shape is what is bought", shape.Min, shape.Max, shape.Desired)
	}
	if err := templatesShapeFits(shape.InstanceTypes[0], shape.Desired, shape.NodeSize.VCPU*1000, shape.NodeSize.MemoryGB*1024); err != nil {
		t.Errorf("the committed shape does not hold the templates: %v", err)
	}
	for _, c := range []struct {
		typ         string
		n, cpu, mem int
	}{{"cpx22", 1, 2000, 4096}, {"cpx32", 1, 4000, 8192}} {
		if templatesShapeFits(c.typ, c.n, c.cpu, c.mem) == nil {
			t.Errorf("%s x%d passed the sizing check — it cannot hold the AI chart beside the platform", c.typ, c.n)
		}
	}
}

func TestTemplatesBudgetTerm(t *testing.T) {
	for _, v := range T2BudgetScenarioEnv() {
		t.Setenv(v, "")
	}
	t.Setenv("ALETHIA_E2E_ARGO_TIMEOUT", "")
	off, err := ResolveT2Budget("hetzner", "ladder")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(envTemplates, "1")
	on, err := ResolveT2Budget("hetzner", "ladder")
	if err != nil {
		t.Fatal(err)
	}
	if on.Ctx-off.Ctx != templatesBudget() {
		t.Errorf("templates widened ctx by %s, want its whole term %s", on.Ctx-off.Ctx, templatesBudget())
	}
	// The base assertion's widening is INSIDE that term, not on top of it.
	if argoTimeoutFor(true)-argoTimeoutFor(false) != templatesAIConverge {
		t.Error("argoTimeoutFor does not widen by exactly templatesAIConverge")
	}
}

// The cost read refuses before it asks anything it cannot scope: no cluster to select by, or no
// token to ask with, is an error — never an empty bill.
func TestHcloudServerCostsRefusesUnscopedReads(t *testing.T) {
	if c, err := hcloudServerCosts(t.Context(), "tok", " "); err == nil || c != nil {
		t.Errorf("no cluster name: got %v, %v", c, err)
	}
	if c, err := hcloudServerCosts(t.Context(), "", "alethia-nl-1"); err == nil || c != nil {
		t.Errorf("no token: got %v, %v", c, err)
	}
}

// phaseBAddonsRefusedJSON is phase B as hetzner/templates run 36901344033 left it: every other
// Application converged, and `addons` Healthy + OutOfSync at the new commit, still holding the three
// child Applications starter-ai's addons/ created. Its status carries the cause — a last operation
// that Succeeded at the OLD commit, a SyncError condition, and three resources marked for pruning —
// and the shape is ArgoCD's own (.status.operationState / .conditions / .resources[].requiresPruning),
// checked field by field against the `addons` Application CAPTURED on the kind + pinned argo-cd rig
// that reproduced #5210 (actions run 36908058283, phaseB-apps.json): the condition message below is
// that capture's, with the commits swapped for this file's test SHAs.
func phaseBAddonsRefusedJSON(t *testing.T) []byte {
	t.Helper()
	green := func(name string) map[string]any {
		return map[string]any{
			"metadata": map[string]any{"name": name},
			"spec":     map[string]any{"source": map[string]any{"repoURL": starterAppsRepo, "targetRevision": "HEAD"}},
			"status": map[string]any{
				"health":         map[string]any{"status": "Healthy"},
				"sync":           map[string]any{"status": "Synced", "revision": shaApps},
				"operationState": map[string]any{"phase": "Succeeded", "message": "successfully synced (all tasks run)", "syncResult": map[string]any{"revision": shaApps}},
				"resources":      []any{map[string]any{"kind": "Namespace", "name": "starter", "status": "Synced"}},
			},
		}
	}
	child := func(name string) map[string]any {
		return map[string]any{"group": "argoproj.io", "kind": "Application", "namespace": "argocd", "name": name, "status": "OutOfSync", "requiresPruning": true}
	}
	addons := map[string]any{
		"metadata": map[string]any{"name": "addons"},
		"spec":     map[string]any{"source": map[string]any{"repoURL": starterAppsRepo, "targetRevision": "HEAD"}},
		"status": map[string]any{
			"health": map[string]any{"status": "Healthy"},
			"sync":   map[string]any{"status": "OutOfSync", "revision": shaApps},
			"operationState": map[string]any{
				"phase": "Succeeded", "message": "successfully synced (all tasks run)",
				"operation":  map[string]any{"sync": map[string]any{"revision": shaAI}},
				"syncResult": map[string]any{"revision": shaAI},
			},
			"conditions": []any{map[string]any{"type": "SyncError", "message": "Skipping sync attempt to [" + shaApps + "]: auto-sync will wipe out all resources"}},
			"resources":  []any{child("kueue"), child("kserve-crd"), child("kserve")},
		},
	}
	raw, err := json.Marshal(map[string]any{"items": []any{green("apps"), green("apps-dev"), green("apps-staging"), addons}})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// #5210: a not-converged Application must carry its CAUSE into the summary — the last operation,
// the conditions and the resources that are not Synced — and the error the run fails with must
// print it too. The first phase-B red recorded `sync=OutOfSync` and nothing else, which three
// different causes fit equally.
func TestTemplatesSummaryRecordsTheCauseOfANotConvergedApplication(t *testing.T) {
	observed, err := parseTemplateApps(phaseBAddonsRefusedJSON(t))
	if err != nil {
		t.Fatal(err)
	}
	results, evalErr := evaluateTemplateApps(templatesPhaseBExpect(), observed, testCommits(), testCharts())
	if evalErr == nil {
		t.Fatal("a refused prune passed phase B")
	}
	for _, want := range []string{"auto-sync will wipe out all resources", "Succeeded at " + shaAI, "argoproj.io/Application argocd/kueue OutOfSync (requires pruning)"} {
		if !strings.Contains(evalErr.Error(), want) {
			t.Errorf("the run's error does not carry %q:\n%v", want, evalErr)
		}
	}

	s := newTemplatesSummary(templatesProvider, "c", testCommits())
	s.record(results, evalErr, time.Unix(0, 0))
	path := filepath.Join(t.TempDir(), "templates-summary.json")
	if err := writeTemplatesSummary(path, s); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var back TemplatesSummary
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	var addons, apps *templateAppResult
	for i, r := range back.template("apps").Applications {
		switch r.Application {
		case "addons":
			addons = &back.template("apps").Applications[i]
		case "apps":
			apps = &back.template("apps").Applications[i]
		}
	}
	if addons == nil || apps == nil {
		t.Fatalf("summary lost a row: %s", raw)
	}
	if addons.OK || addons.OperationPhase != "Succeeded" || addons.OperationRevision != shaAI || addons.OperationMessage == "" {
		t.Errorf("addons: the last operation was not recorded (phase=%q rev=%q msg=%q)", addons.OperationPhase, addons.OperationRevision, addons.OperationMessage)
	}
	if len(addons.Conditions) != 1 || !strings.HasPrefix(addons.Conditions[0], "SyncError: ") || !strings.Contains(addons.Conditions[0], "wipe out all resources") {
		t.Errorf("addons: conditions = %q", addons.Conditions)
	}
	wantRes := []string{
		"argoproj.io/Application argocd/kserve OutOfSync (requires pruning)",
		"argoproj.io/Application argocd/kserve-crd OutOfSync (requires pruning)",
		"argoproj.io/Application argocd/kueue OutOfSync (requires pruning)",
	}
	if strings.Join(addons.NotSyncedResources, "|") != strings.Join(wantRes, "|") {
		t.Errorf("addons: not_synced_resources = %q, want %q", addons.NotSyncedResources, wantRes)
	}
	// A passing row stays as it was: the cause fields are for the losers.
	if apps.OperationPhase != "" || apps.Conditions != nil || apps.NotSyncedResources != nil {
		t.Errorf("a passing row carries cause fields: %+v", *apps)
	}

	// An Application with NO operation must say so, not leave a blank that reads as "fine".
	obs := observed["addons"]
	obs.OperationPhase, obs.OperationMessage, obs.OperationRevision = "", "", ""
	observed["addons"] = obs
	results, _ = evaluateTemplateApps(templatesPhaseBExpect(), observed, testCommits(), testCharts())
	for _, r := range results {
		if r.Application == "addons" && r.OperationPhase != noOperation {
			t.Errorf("addons with no operation recorded operation_phase=%q, want %q", r.OperationPhase, noOperation)
		}
	}
}
