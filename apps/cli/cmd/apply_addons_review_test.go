// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// Review findings on #5567: a plan never prints an override's content, redacts a secret the row
// names, and a second apply of the same file sends nothing.

const sentinel = "SENTINEL-c0ffee"

func TestPlan_NeverPrintsAnOverridesContent(t *testing.T) {
	f := addonServer()
	f.addons = map[string][]api.Addon{"prod": {{AddonID: "loki", Mode: "managed", Version: sptr("6.0.0"),
		ValuesYAML: sptr("stored: " + sentinel + "-stored\n")}}}
	plan, err := planFromFile(f, writeAddonManifest(t, lokiOnProd+"        values_file: v.yaml\n",
		map[string]string{"v.yaml": "token: " + sentinel + "-file\nother: 2\n"}))
	if err != nil {
		t.Fatal(err)
	}
	if a := plan.Environments[0].Addons[0]; a.Action != ActionUpdate {
		t.Fatalf("the override differs, so this is an update: %+v", a)
	}
	var table bytes.Buffer
	renderPlan(&table, plan)
	asJSON, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	for name, out := range map[string]string{"table": table.String(), "json": string(asJSON)} {
		if strings.Contains(out, sentinel) {
			t.Errorf("the %s plan printed override content:\n%s", name, out)
		}
		if !strings.Contains(out, "sha256:") {
			t.Errorf("the %s plan does not name the change by digest:\n%s", name, out)
		}
	}
	// The content is still what apply SENDS.
	if req := plan.Environments[0].Addons[0].request; req.ValuesYAML == nil || !strings.Contains(*req.ValuesYAML, sentinel+"-file") {
		t.Errorf("apply would not send the file: %+v", req.ValuesYAML)
	}
}

func TestPlan_ABrokenValuesFileIsRefusedWithoutQuotingIt(t *testing.T) {
	// A duplicate key is the case yaml.v3 quotes in its message ("mapping key %q already defined").
	for name, content := range map[string]string{
		"a duplicate key": sentinel + ": 1\n" + sentinel + ": 2\n",
		"a broken flow":   "a: [" + sentinel + "\n",
	} {
		plan, err := planFromFile(addonServer(), writeAddonManifest(t, lokiOnProd+"        values_file: v.yaml\n",
			map[string]string{"v.yaml": content}))
		if err != nil {
			t.Fatal(err)
		}
		refusal := plan.refusal()
		if refusal == nil || strings.Contains(refusal.Error(), sentinel) || !strings.Contains(refusal.Error(), "is not valid YAML") {
			t.Errorf("%s: refusal = %v — want a refusal that does not quote the file", name, refusal)
		}
	}
}

func TestRenderAddons_RedactsASecretTheRowNames(t *testing.T) {
	// The catalog names no secret; the row's own list does. The plan must still redact it.
	e := EnvPlan{Name: "prod", Addons: []AddonPlan{{ID: "custom", Action: ActionUpdate, secretKeys: []string{"token"},
		Changes: []FieldChange{{Field: "settings", Key: "token", From: sentinel, To: sentinel + "2"}}}}}
	var out bytes.Buffer
	renderAddons(&out, e, func(string) []string { return nil })
	if strings.Contains(out.String(), sentinel) || !strings.Contains(out.String(), "settings.token: (secret) → (secret)") {
		t.Errorf("a secret the row names was printed:\n%s", out.String())
	}
}

// statefulAddonFake applies EnableAddon the way the server does, so a second plan sees the result.
type statefulAddonFake struct{ *addonFake }

func (f statefulAddonFake) EnableAddon(p api.EnableAddonParams) error {
	if err := f.addonFake.EnableAddon(p); err != nil {
		return err
	}
	rows := f.addons[p.Env]
	i := -1
	for j, r := range rows {
		if r.AddonID == p.AddonID {
			i = j
		}
	}
	if i < 0 {
		entry, _ := f.catalog.Addon(p.AddonID)
		settings := map[string]any{}
		for k, v := range entry.Defaults {
			settings[k] = v
		}
		rows = append(rows, api.Addon{AddonID: p.AddonID, Mode: "managed", Version: sptr(entry.Version), Settings: settings})
		i = len(rows) - 1
	}
	row := &rows[i]
	entry, _ := f.catalog.Addon(p.AddonID)
	if p.Mode != "" {
		row.Mode = p.Mode
	}
	for k, v := range p.Values { // merged key by key; null resets to the default
		if v == nil {
			if d, ok := entry.Defaults[k]; ok {
				row.Settings[k] = d
			} else {
				delete(row.Settings, k)
			}
			continue
		}
		row.Settings[k] = v
	}
	if p.ValuesYAML != nil {
		if *p.ValuesYAML == "" {
			row.ValuesYAML = nil
		} else {
			row.ValuesYAML = sptr(*p.ValuesYAML)
		}
	}
	if p.Version != nil {
		row.VersionPinned = *p.Version != ""
		row.Version = sptr(entry.Version)
		if row.VersionPinned {
			row.Version = sptr(*p.Version)
		}
	}
	f.addons[p.Env] = rows
	return nil
}

func TestApply_TwiceTheSecondSendsNothing(t *testing.T) {
	base := addonServer()
	base.envs = append(base.envs, api.Environment{ID: "e2", Name: "staging", Stage: "staging", PlacementMode: "namespace"})
	base.addons["staging"] = nil
	f := statefulAddonFake{base}
	files := map[string]string{"kps.yaml": "grafana:\n  replicas: 2\n"}

	first := planAddonManifest2(t, f, addonManifest, files)
	if _, err := executeApply(f, &bytes.Buffer{}, ui.FormatTable, first, "", false); err != nil {
		t.Fatal(err)
	}
	if len(base.enabled) == 0 {
		t.Fatal("the first apply sent nothing — the fixture is not exercising anything")
	}
	base.enabled = nil

	second := planAddonManifest2(t, f, addonManifest, files)
	for _, e := range second.Environments {
		for _, a := range e.Addons {
			if a.Action != ActionUnchanged {
				t.Errorf("%s/%s after one apply: %s %+v — want unchanged", e.Name, a.ID, a.Action, a.Changes)
			}
		}
	}
	if _, err := executeApply(f, &bytes.Buffer{}, ui.FormatTable, second, "", false); err != nil {
		t.Fatal(err)
	}
	if len(base.enabled) != 0 {
		t.Errorf("the second apply sent %+v — want nothing", base.enabled)
	}
}

// planAddonManifest2 is planAddonManifest for any applyClient.
func planAddonManifest2(t *testing.T, c applyClient, body string, files map[string]string) *ApplyPlan {
	t.Helper()
	plan, err := planFromFile(c, writeAddonManifest(t, body, files))
	if err != nil {
		t.Fatal(err)
	}
	return plan
}
