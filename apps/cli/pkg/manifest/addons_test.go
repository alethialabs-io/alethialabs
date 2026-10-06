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

func TestLoadValuesFiles_IsConfinedToTheManifestDirectory(t *testing.T) {
	outside := t.TempDir()
	secret := filepath.Join(outside, "credentials")
	if err := os.WriteFile(secret, []byte("aws_secret_access_key = SENTINEL\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.Symlink(secret, filepath.Join(dir, "link.yaml")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "linkdir")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "helm"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "helm", "ok.yaml"), []byte("a: 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "helm", "ok.yaml"), filepath.Join(dir, "inside.yaml")); err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct {
		path    string
		refused bool
	}{
		"an absolute path":             {secret, true},
		"a .. that climbs out":         {"../" + filepath.Base(outside) + "/credentials", true},
		"a .. hidden mid-path":         {"helm/../../" + filepath.Base(outside) + "/credentials", true},
		"a symlinked file leading out": {"link.yaml", true},
		"a symlinked directory out":    {"linkdir/credentials", true},
		"a file inside":                {"helm/ok.yaml", false},
		"a .. that stays inside":       {"helm/../helm/ok.yaml", false},
		"a symlink that stays inside":  {"inside.yaml", false},
	} {
		t.Run(name, func(t *testing.T) {
			src := "project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n      - id: loki\n        values_file: " + tc.path + "\n"
			m := mustParse(t, src)
			err := m.LoadValuesFiles(dir)
			if !tc.refused {
				if err != nil || m.Environments[0].Addons[0].ValuesFileContent != "a: 1\n" {
					t.Fatalf("a path inside was refused or not read: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), "inside the directory that holds alethia.yaml") {
				t.Fatalf("LoadValuesFiles = %v, want the confinement rule named", err)
			}
			if strings.Contains(err.Error(), "SENTINEL") || strings.Contains(m.Environments[0].Addons[0].ValuesFileContent, "SENTINEL") {
				t.Fatal("the outside file was read")
			}
		})
	}
}

// loadOneValuesFile loads a one-add-on manifest whose values_file is path, relative to dir.
func loadOneValuesFile(t *testing.T, dir, path string) (*Manifest, error) {
	t.Helper()
	m := mustParse(t, "project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n      - id: loki\n        values_file: "+path+"\n")
	return m, m.LoadValuesFiles(dir)
}

// The refusal must not be an existence oracle and must not print the runner's paths: a missing and
// an existing outside path read IDENTICALLY, through every route out (#5567 review).
func TestLoadValuesFiles_AnOutsidePathIsRefusedTheSameWhetherOrNotItExists(t *testing.T) {
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "present"), []byte("a: 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for _, name := range []string{"present", "absent"} {
		if err := os.Symlink(filepath.Join(outside, name), filepath.Join(dir, "link-"+name)); err != nil {
			t.Fatal(err)
		}
	}
	up := "../" + filepath.Base(outside) + "/"
	for route, pair := range map[string][2]string{
		"a .. out":         {up + "present", up + "absent"},
		"an absolute path": {filepath.Join(outside, "present"), filepath.Join(outside, "absent")},
		"a symlink out":    {"link-present", "link-absent"},
	} {
		t.Run(route, func(t *testing.T) {
			var texts [2]string
			for i, path := range pair {
				_, err := loadOneValuesFile(t, dir, path)
				if err == nil {
					t.Fatalf("%s was not refused", path)
				}
				// Strip the path as written — the only path an error may name — and compare the rest.
				texts[i] = strings.ReplaceAll(err.Error(), path, "<path>")
				for _, leaked := range []string{outside, dir, "no such file", "lstat"} {
					if strings.Contains(texts[i], leaked) {
						t.Errorf("the refusal of %s leaks %q: %s", path, leaked, err)
					}
				}
			}
			if texts[0] != texts[1] {
				t.Errorf("an existing and a missing outside path read differently:\n  %s\n  %s", texts[0], texts[1])
			}
		})
	}
}

func TestLoadValuesFiles_ADirectoryIsUnreadableWithoutItsPath(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "helm"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := loadOneValuesFile(t, dir, "helm")
	if err == nil || !strings.Contains(err.Error(), `values_file "helm": cannot be read as a file`) || strings.Contains(err.Error(), dir) {
		t.Errorf("a directory = %v, want it refused by the path as written", err)
	}
}

// The folder holding alethia.yaml may itself be reached through a symlink (macOS's /var is one; a
// CI checkout can be). Files inside it must still read, and the fence must still hold. Built from
// t.TempDir and os.Symlink, so it runs on Linux, where TempDir is not under a symlink.
func TestLoadValuesFiles_TheManifestFolderIsASymlink(t *testing.T) {
	folder := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder, "v.yaml"), []byte("a: 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "credentials"), []byte("SENTINEL\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// An absolute symlink INSIDE the folder folder that points back into it, written via the link.
	if err := os.Symlink(filepath.Join(folder, "v.yaml"), filepath.Join(folder, "again.yaml")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "credentials"), filepath.Join(folder, "out.yaml")); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "project")
	if err := os.Symlink(folder, link); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"v.yaml", "again.yaml"} {
		m, err := loadOneValuesFile(t, link, path)
		if err != nil || m.Environments[0].Addons[0].ValuesFileContent != "a: 1\n" {
			t.Errorf("%s through a symlinked folder = %v, want it read", path, err)
		}
	}
	m, err := loadOneValuesFile(t, link, "out.yaml")
	if err == nil || !strings.Contains(err.Error(), "inside the directory that holds alethia.yaml") ||
		strings.Contains(m.Environments[0].Addons[0].ValuesFileContent, "SENTINEL") {
		t.Errorf("a symlink out of a symlinked folder = %v, want it refused", err)
	}
}

func TestValidate_RefusesAnUnknownAddonSetting(t *testing.T) {
	r := addonRules()
	r.Addons.Addons[1].Settings = []string{"provider", "domainFilter", "apiToken"}
	m := mustParse(t, "project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n      - id: external-dns\n        settings:\n          provider: cloudflare\n          domainFiltr: x\n")
	err := m.Validate(r)
	if err == nil || !strings.Contains(err.Error(), "external-dns does not take the setting domainFiltr (it takes: provider, domainFilter, apiToken)") {
		t.Fatalf("Validate = %v, want the misspelt setting refused", err)
	}
	// No settings list from the server is "could not check": the same file is not refused for it.
	r.Addons.Addons[1].Settings = nil
	if err := m.Validate(r); err != nil {
		t.Errorf("without a settings list nothing may be refused as unknown: %v", err)
	}
}

func TestValidate_AWholeProviderConfigNullIsRefused(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "component_schema_provider_config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema api.ComponentSchemaDocument
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	r := testRules()
	r.Schema = &schema
	for name, value := range map[string]string{"null": "null", "empty": "", "a list": "[a]", "a scalar": "x"} {
		m := mustParse(t, "project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    components:\n      cluster:\n        provider_config: "+value+"\n")
		if err := m.Validate(r); err == nil || !strings.Contains(err.Error(), "provider_config must be a mapping") {
			t.Errorf("%s: Validate = %v, want it refused", name, err)
		}
	}
}
