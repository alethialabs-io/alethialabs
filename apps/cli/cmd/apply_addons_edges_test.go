// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
)

// The edges of the add-on plan (#5528): every refusal and failure arm, each with the sentence it
// must carry.

// failingAddonFake fails one add-on route.
type failingAddonFake struct {
	addonFake
	catalogErr, listErr error
}

func (f *failingAddonFake) GetAddonCatalog() (*api.AddonCatalogDocument, error) {
	if f.catalogErr != nil {
		return nil, f.catalogErr
	}
	return f.addonFake.GetAddonCatalog()
}
func (f *failingAddonFake) GetProjectAddons(project, env string) (*api.ProjectAddons, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.addonFake.GetProjectAddons(project, env)
}

// writeAddonManifest writes body as alethia.yaml (plus files) into a fresh directory.
func writeAddonManifest(t *testing.T, body string, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(dir, manifest.FileName)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

const lokiOnProd = "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n      - id: loki\n"

func TestPlanFromFile_AddonReadFailuresAreReported(t *testing.T) {
	for name, tc := range map[string]struct {
		f     *failingAddonFake
		body  string
		files map[string]string
		want  string
	}{
		"the catalog cannot be read": {
			&failingAddonFake{addonFake: *addonServer(), catalogErr: errors.New("catalog down")}, lokiOnProd, nil, "catalog down",
		},
		"an environment's add-ons cannot be listed": {
			&failingAddonFake{addonFake: *addonServer(), listErr: errors.New("list down")}, lokiOnProd, nil, "list add-ons of web/prod: list down",
		},
		"a values file is missing": {
			&failingAddonFake{addonFake: *addonServer()}, lokiOnProd + "        values_file: nope.yaml\n", nil, `values_file "nope.yaml"`,
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := planFromFile(tc.f, writeAddonManifest(t, tc.body, tc.files))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("planFromFile = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestComputePlan_AnAddonValuesFileThatIsNotAMappingIsRefused(t *testing.T) {
	for name, content := range map[string]string{
		"a list":        "- a\n- b\n",
		"a scalar":      "just text\n",
		"broken YAML":   "a: [1, 2\n",
		"an alias loop": "a: &x\n  b: *x\n",
	} {
		t.Run(name, func(t *testing.T) {
			plan, err := planFromFile(addonServer(), writeAddonManifest(t, lokiOnProd+"        values_file: v.yaml\n", map[string]string{"v.yaml": content}))
			if err != nil {
				t.Fatal(err)
			}
			refusal := plan.refusal()
			if refusal == nil || !strings.Contains(refusal.Error(), "add-on loki: values_file v.yaml") {
				t.Fatalf("refusal = %v, want the values file named", refusal)
			}
		})
	}
}

func TestParseOverride_NoOverrideForms(t *testing.T) {
	for name, text := range map[string]string{"empty": "", "blank": "  \n", "comment only": "# nothing here\n"} {
		m, err := parseOverride(text)
		if err != nil || m != nil {
			t.Errorf("%s: parseOverride = %v, %v — want no override", name, m, err)
		}
	}
}

func TestComputePlan_AddonModeAndEmptyOverride(t *testing.T) {
	f := addonServer()
	f.addons = map[string][]api.Addon{"prod": {{AddonID: "loki", Mode: "managed", Version: sptr("6.0.0"), ValuesYAML: sptr("a: 1\n")}}}
	plan, err := planFromFile(f, writeAddonManifest(t, lokiOnProd+"        mode: gitops\n        values: {}\n", nil))
	if err != nil {
		t.Fatal(err)
	}
	got := plan.Environments[0].Addons[0]
	want := []FieldChange{
		{Field: "mode", From: "managed", To: "gitops"},
		{Field: "values", From: nil, To: overrideRemoved},
	}
	if !reflect.DeepEqual(got.Changes, want) {
		t.Fatalf("changes = %#v, want %#v", got.Changes, want)
	}
	// An empty inline mapping removes the override, exactly as values_file: "" does.
	if got.request.ValuesYAML == nil || *got.request.ValuesYAML != "" || got.request.Mode != "gitops" {
		t.Errorf("request = %+v, want mode gitops and the override removed", got.request)
	}
	var out bytes.Buffer
	renderAddons(&out, EnvPlan{Name: "prod", Addons: []AddonPlan{got}}, func(string) []string { return nil })
	if !strings.Contains(out.String(), "~ loki  values: removed\n") {
		t.Errorf("a removed override renders as:\n%s", out.String())
	}
}

func TestOverrideText(t *testing.T) {
	empty, file := "", "f.yaml"
	for name, tc := range map[string]struct {
		a    manifest.Addon
		want *string
	}{
		"nothing said":              {manifest.Addon{}, nil},
		"an empty values file":      {manifest.Addon{ValuesFile: &file, ValuesFileContent: " \n"}, &empty},
		"values: null":              {manifest.Addon{ValuesCleared: true}, &empty},
		"values_file: \"\"":         {manifest.Addon{ValuesFile: &empty}, &empty},
		"an inline mapping as YAML": {manifest.Addon{Values: map[string]any{"a": 1}}, sptr("a: 1\n")},
	} {
		got := overrideText(tc.a)
		if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
			t.Errorf("%s: overrideText = %v, want %v", name, got, tc.want)
		}
	}
	if derefString(nil) != "" {
		t.Error("derefString(nil) must be empty")
	}
}

// initAddonClient is an applyClient that serves only the catalog.
type initAddonClient struct {
	applyClient
	err error
}

func (c initAddonClient) GetAddonCatalog() (*api.AddonCatalogDocument, error) {
	if c.err != nil {
		return nil, c.err
	}
	return addonCatalog(), nil
}

func TestInitAddons_OnATerminal(t *testing.T) {
	t.Cleanup(upResetFlags)
	upResetFlags()
	projTTY(t)

	prev := runHuhForm
	t.Cleanup(func() { runHuhForm = prev })

	// Nothing picked is a valid answer: no add-ons.
	runHuhForm = func(...*huh.Group) error { return nil }
	got, err := initAddons(initAddonClient{})
	if err != nil || len(got) != 0 {
		t.Errorf("an empty pick = %v, %v — want no add-ons", got, err)
	}

	// A refused form is reported, not read as "none".
	runHuhForm = func(...*huh.Group) error { return errBoom }
	if _, err := initAddons(initAddonClient{}); !errors.Is(err, errBoom) {
		t.Errorf("form error = %v, want it carried", err)
	}

	// The catalog could not be read: init cannot check, so it says so.
	if _, err := initAddons(initAddonClient{err: errors.New("catalog down")}); err == nil || !strings.Contains(err.Error(), "catalog down") {
		t.Errorf("catalog error = %v", err)
	}
}

func TestParseInitAddons_RefusesAnEmptyID(t *testing.T) {
	if _, err := parseInitAddons([]string{"@1.0.0"}); err == nil || !strings.Contains(err.Error(), "needs its catalog id") {
		t.Errorf("parseInitAddons(@1.0.0) = %v", err)
	}
}
