// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// The add-ons section of alethia.yaml (#5528): load, validate and render.

const addonsSample = `project: boutique
cloud:
  region: nbg1
environments:
  - name: prod
    stage: production
    addons:
      - id: cert-manager
      - id: external-dns
        version: 1.15.0
        mode: gitops
        settings:
          provider: cloudflare
          txtOwnerId: null
      - id: kube-prometheus-stack
        values_file: helm/kps.yaml
  - name: staging
    stage: staging
    addons:
      - id: external-dns
        version: ""
        values:
          replicaCount: 2
      - id: loki
        version: null
        values: null
      - id: tempo
        values_file: ""
`

// testCatalog is a catalog fixture in the wire shape `GET /api/cli/schema/addons` serves, with the
// server's real chart-version pattern (apps/console/lib/addons/chart-version.ts).
func testCatalog() *api.AddonCatalogDocument {
	return &api.AddonCatalogDocument{
		Addons: []api.AddonCatalogEntry{
			{ID: "cert-manager", Version: "1.14.4"},
			{ID: "external-dns", Version: "1.14.5", SecretKeys: []string{"apiToken"}},
			{ID: "kube-prometheus-stack", Version: "58.2.1", SecretKeys: []string{"grafanaAdminPassword"}},
			{ID: "loki", Version: "6.0.0"},
			{ID: "tempo", Version: "1.0.0"},
		},
		ChartVersion: api.ChartVersionRule{
			Pattern:   `^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$`,
			MaxLength: 64,
			Refusal:   "A chart version must be one exact version, such as 58.2.1.",
		},
	}
}

func addonRules() Rules {
	r := testRules()
	r.Addons = testCatalog()
	r.AddonModes = []string{"managed", "gitops"}
	return r
}

func strPtr(s string) *string { return &s }

func TestParse_ReadsAddonsWithKeepAndClearApart(t *testing.T) {
	m := mustParse(t, addonsSample)
	prod, staging := m.Environments[0].Addons, m.Environments[1].Addons
	if len(prod) != 3 || len(staging) != 3 {
		t.Fatalf("addons: prod %d, staging %d", len(prod), len(staging))
	}
	want := Addon{
		ID: "external-dns", Version: strPtr("1.15.0"), Mode: "gitops",
		Settings: map[string]any{"provider": "cloudflare", "txtOwnerId": nil},
	}
	if !reflect.DeepEqual(prod[1], want) {
		t.Errorf("external-dns = %#v, want %#v", prod[1], want)
	}
	// Omitted is KEEP (nil); "" and null are both CLEAR (a pointer to "").
	if prod[0].Version != nil {
		t.Errorf("cert-manager: an omitted version must be nil (keep), got %q", *prod[0].Version)
	}
	for _, a := range []Addon{staging[0], staging[1]} {
		if a.Version == nil || *a.Version != "" {
			t.Errorf("%s: `version: \"\"` and `version: null` must both clear, got %v", a.ID, a.Version)
		}
	}
	if prod[2].ValuesFile == nil || *prod[2].ValuesFile != "helm/kps.yaml" {
		t.Errorf("values_file: %v", prod[2].ValuesFile)
	}
	if !staging[1].ValuesCleared || staging[1].Values != nil {
		t.Errorf("loki: `values: null` must clear the override: %+v", staging[1])
	}
	if staging[2].ValuesFile == nil || *staging[2].ValuesFile != "" {
		t.Errorf("tempo: `values_file: \"\"` must clear the override: %v", staging[2].ValuesFile)
	}
	if err := m.Validate(addonRules()); err != nil {
		t.Errorf("a valid add-ons section was refused: %v", err)
	}
}

func TestParse_AnUnquotedNumericVersionKeepsItsText(t *testing.T) {
	m := mustParse(t, "project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n      - id: loki\n        version: 1.10\n")
	if v := m.Environments[0].Addons[0].Version; v == nil || *v != "1.10" {
		t.Fatalf("version 1.10 decoded as %v — YAML's float reading would have made it 1.1", v)
	}
}

func TestParse_RefusesAnUnknownAddonKey(t *testing.T) {
	for name, src := range map[string]string{
		"unknown key":      "      - id: loki\n        chart: grafana/loki\n",
		"a scalar entry":   "      - loki\n",
		"settings as list": "      - id: loki\n        settings: [a, b]\n",
		"values as scalar": "      - id: loki\n        values: replicaCount=2\n",
		"a duplicate key":  "      - id: loki\n        mode: managed\n        mode: gitops\n",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Parse([]byte("project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n" + src))
			if err == nil {
				t.Fatal("parsed; want a refusal")
			}
			if name == "unknown key" && (!strings.Contains(err.Error(), `"chart"`) || !strings.Contains(err.Error(), "values_file")) {
				t.Errorf("the refusal should name the key and the keys an add-on takes: %v", err)
			}
		})
	}
}

func TestValidate_Addons(t *testing.T) {
	base := "project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n"
	for name, tc := range map[string]struct {
		src  string
		want string
	}{
		"both values forms": {
			"      - id: loki\n        values:\n          a: 1\n        values_file: x.yaml\n", "not both",
		},
		"values null and a file": {
			"      - id: loki\n        values: null\n        values_file: x.yaml\n", "not both",
		},
		"unknown add-on id": {
			"      - id: lokii\n", `"lokii" is not a catalog add-on (have: cert-manager, external-dns, kube-prometheus-stack, loki, tempo)`,
		},
		"duplicate id": {
			"      - id: loki\n      - id: loki\n", "declare each add-on once per environment",
		},
		"missing id": {
			"      - mode: managed\n", "`id` is required",
		},
		"a version range": {
			"      - id: loki\n        version: ^6.0.0\n", `version "^6.0.0" — A chart version must be one exact version`,
		},
		"a two-part version": {
			"      - id: loki\n        version: \"6.0\"\n", `version "6.0"`,
		},
		"an over-long version": {
			"      - id: loki\n        version: 1.0.0-" + strings.Repeat("a", 64) + "\n", "at most 64 characters",
		},
		"an unknown mode": {
			"      - id: loki\n        mode: helm\n", `mode "helm" is not one of gitops | managed`,
		},
		"a secret setting": {
			"      - id: external-dns\n        settings:\n          provider: cloudflare\n          apiToken: abc\n",
			"apiToken is a secret setting, and alethia.yaml is committed to git — set it with `alethia addon enable external-dns --set apiToken=…` or in the console",
		},
		"a secret setting reset with null is still refused": {
			"      - id: external-dns\n        settings:\n          apiToken: null\n", "apiToken is a secret setting",
		},
	} {
		t.Run(name, func(t *testing.T) {
			m := mustParse(t, base+tc.src)
			err := m.Validate(addonRules())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Validate = %v, want it to contain %q", err, tc.want)
			}
		})
	}
}

func TestValidate_AddonsWithoutACatalogCheckShapeOnly(t *testing.T) {
	src := "project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n" +
		"      - id: not-in-any-catalog\n        version: ^1\n        settings:\n          apiToken: x\n"
	m := mustParse(t, src)
	r := testRules() // no catalog: "could not check" is not "refused"
	if err := m.Validate(r); err != nil {
		t.Errorf("without a catalog only the shape is checked, got %v", err)
	}
	m = mustParse(t, src+"      - id: not-in-any-catalog\n")
	if err := m.Validate(r); err == nil || !strings.Contains(err.Error(), "once per environment") {
		t.Errorf("a duplicate needs no catalog to refuse: %v", err)
	}
}

func TestRender_AddonsRoundTripInFileOrder(t *testing.T) {
	m := mustParse(t, addonsSample)
	out, err := Render(m)
	if err != nil {
		t.Fatal(err)
	}
	text := string(out)
	// File order, not sorted: cert-manager, external-dns, kube-prometheus-stack.
	cm, ed, kps := strings.Index(text, "id: cert-manager"), strings.Index(text, "id: external-dns"), strings.Index(text, "id: kube-prometheus-stack")
	if cm < 0 || ed < cm || kps < ed {
		t.Errorf("add-ons are not in file order:\n%s", text)
	}
	for _, want := range []string{"version: 1.15.0", "mode: gitops", "txtOwnerId: null", "values_file: helm/kps.yaml", `version: ""`, "values: null", `values_file: ""`} {
		if !strings.Contains(text, want) {
			t.Errorf("render lost %q:\n%s", want, text)
		}
	}
	again, err := Parse(out)
	if err != nil {
		t.Fatalf("rendered manifest does not parse: %v\n%s", err, text)
	}
	again.Normalize()
	if !reflect.DeepEqual(again.Environments[0].Addons, m.Environments[0].Addons) ||
		!reflect.DeepEqual(again.Environments[1].Addons, m.Environments[1].Addons) {
		t.Errorf("round trip changed the add-ons:\n got %#v\nwant %#v", again.Environments, m.Environments)
	}
}

func TestRender_NoAddonsWritesNoAddonsKey(t *testing.T) {
	out, err := Render(mustParse(t, sample))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "addons") {
		t.Errorf("a manifest without add-ons grew an addons key:\n%s", out)
	}
}

func TestLoadValuesFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "helm"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "helm", "kps.yaml"), []byte("grafana:\n  replicas: 2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := mustParse(t, addonsSample)
	if err := m.LoadValuesFiles(dir); err != nil {
		t.Fatal(err)
	}
	if got := m.Environments[0].Addons[2].ValuesFileContent; got != "grafana:\n  replicas: 2\n" {
		t.Errorf("values_file content = %q", got)
	}
	if err := m.LoadValuesFiles(t.TempDir()); err == nil || !strings.Contains(err.Error(), `values_file "helm/kps.yaml"`) {
		t.Errorf("a missing values file must be named, got %v", err)
	}
}

// TestValidate_ANestedProviderConfigMappingValidates is item B moved from #5529: a component whose
// published schema carries `provider_config` accepts a nested mapping under it, read from a schema
// fixture in the wire shape `GET /api/cli/schema/components` serves.
func TestValidate_ANestedProviderConfigMappingValidates(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "component_schema_provider_config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema api.ComponentSchemaDocument
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	m := mustParse(t, `project: p
cloud:
  region: eu-west-1
environments:
  - name: prod
    stage: production
    components:
      cluster:
        node_max_size: 3
        provider_config:
          eks_cluster_log_types: [api, audit]
          eks_endpoint_public_access: false
      databases:
        - name: orders
          engine: postgres
          provider_config:
            rds_backup_retention_period: 14
            rds_performance_insights: null
`)
	r := testRules()
	r.Schema = &schema
	if err := m.Validate(r); err != nil {
		t.Fatalf("a nested provider_config mapping was refused: %v", err)
	}
	cluster, _ := m.Environments[0].Components.Kind("cluster")
	pc, ok := cluster.Entries[0].Fields["provider_config"].(map[string]any)
	if !ok || pc["eks_endpoint_public_access"] != false {
		t.Errorf("provider_config did not decode as a nested mapping: %#v", cluster.Entries[0].Fields["provider_config"])
	}
	// And the kind that does NOT publish provider_config still refuses it.
	bad := mustParse(t, "project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    components:\n      repositories:\n        provider_config:\n          a: 1\n")
	if err := bad.Validate(r); err == nil || !strings.Contains(err.Error(), "repositories does not take provider_config") {
		t.Errorf("repositories must refuse provider_config, got %v", err)
	}
}
