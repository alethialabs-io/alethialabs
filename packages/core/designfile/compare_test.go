// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package designfile

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// actions is every Action anywhere in a comparison.
func actions(c *Comparison) []Action {
	var out []Action
	for _, e := range c.Environments {
		out = append(out, e.Action)
		for _, comp := range e.Components {
			out = append(out, comp.Action)
		}
		for _, a := range e.Addons {
			out = append(out, a.Action)
		}
	}
	return out
}

func TestCompare_AFileComparedWithItselfChangesNothing(t *testing.T) {
	c := Compare(mustParse(t, handWritten), mustParse(t, handWritten))
	if c.HasChanges() || len(c.Fields) != 0 || len(c.Omitted()) != 0 {
		t.Fatalf("a file differs from itself: %+v", c)
	}
	for _, a := range actions(c) {
		if a != ActionUnchanged {
			t.Fatalf("action %q in a comparison of a file with itself", a)
		}
	}
}

func TestCompare_ANewFileCreatesEverythingItDeclares(t *testing.T) {
	c := Compare(nil, mustParse(t, handWritten))
	if !c.HasChanges() {
		t.Fatal("a new file changes nothing")
	}
	for _, a := range actions(c) {
		if a != ActionCreate {
			t.Fatalf("action %q for a file that did not exist", a)
		}
	}
	if got := Compare(nil, nil); len(got.Environments) != 0 || got.HasChanges() {
		t.Fatalf("nothing compared with nothing: %+v", got)
	}
}

func TestCompare_WhatTheFileStopsMentioningIsOmittedNeverRemoved(t *testing.T) {
	before := mustParse(t, handWritten)
	after := mustParse(t, handWritten)
	// Take out one of everything: an environment, a whole kind, one entry of a list, an add-on,
	// one field of a component and one setting of an add-on.
	after.Environments = after.Environments[:1]
	if err := after.Apply(
		Edit{Environment: "prod", Kind: "databases", Name: "sessions", Action: ActionRemove},
	); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	prod := &after.Environments[0]
	prod.Addons = prod.Addons[1:]
	delete(prod.Addons[0].Settings, "provider")
	delete(component(t, after, "prod", "cluster", "").Fields, "node_max_size")

	c := Compare(before, after)
	if c.HasChanges() {
		t.Fatalf("leaving things out counted as a change: %+v", c)
	}
	want := []string{"prod: databases/sessions", "prod: add-on loki", "environment dev-1"}
	if got := c.Omitted(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Omitted() = %q, want %q", got, want)
	}
	for _, a := range actions(c) {
		if a == ActionRemove {
			t.Fatal("an omission was reported as a removal")
		}
	}
	cluster := c.Environments[0].Components[0]
	if cluster.Kind != "cluster" || cluster.Action != ActionUnchanged || len(cluster.Changes) != 0 ||
		!reflect.DeepEqual(cluster.OmittedFields, []string{"node_max_size"}) {
		t.Fatalf("a field left out is not reported as left out and unchanged: %+v", cluster)
	}
	dns := c.Environments[0].Addons[0]
	if dns.ID != "external-dns" || dns.Action != ActionUnchanged {
		t.Fatalf("a setting left out changed the add-on: %+v", dns)
	}
	// An emptied file omits everything and still removes nothing.
	empty := Compare(before, &Manifest{})
	if got := empty.Omitted(); !reflect.DeepEqual(got, []string{"environment dev-1", "environment prod"}) {
		t.Fatalf("an empty file omits %q", got)
	}
	raw, err := json.Marshal(empty)
	if err != nil || strings.Contains(string(raw), `"remove"`) {
		t.Fatalf("an empty file serialised a removal: %s (%v)", raw, err)
	}
}

func TestCompare_NothingAFileCanSayProducesARemoval(t *testing.T) {
	// The claim is "never", so it is checked over every pair of a spread of files rather than on
	// one example: full, emptied, reordered, renamed, and with explicit nulls everywhere a null
	// can be written.
	sources := []string{
		handWritten,
		sample,
		"",
		"project: p\ncloud:\n  region: r\nenvironments: []\n",
		"project: boutique\ncloud:\n  region: nbg1\nenvironments:\n  - name: dev-1\n    stage: development\n  - name: prod\n    stage: production\n    components:\n      cluster:\n      databases: []\n    addons: []\n",
		"project: boutique\ncloud:\n  region: nbg1\nenvironments:\n  - name: prod\n    stage: production\n    lifecycle:\n    components:\n      cluster:\n        node_min_size: null\n        provider_config:\n          a: null\n    addons:\n      - id: external-dns\n        version:\n        settings:\n          provider: null\n        values: null\n",
	}
	for i, a := range sources {
		for j, b := range sources {
			for _, act := range actions(Compare(mustParse(t, a), mustParse(t, b))) {
				if act == ActionRemove {
					t.Fatalf("comparing source %d with %d produced a removal", i, j)
				}
			}
		}
	}
}

func TestCompare_ReportsCreatesAndUpdatesWithTheirFields(t *testing.T) {
	before := mustParse(t, handWritten)
	after := mustParse(t, handWritten)
	after.Cloud.Region = "fsn1"
	after.IaC.Version = ""
	after.Environments[1].Stage = "staging"
	pin := "1.15.0"
	after.Environments[0].Addons[1].Version = &pin
	after.Environments[0].Addons[1].Settings["provider"] = "route53"
	after.Environments[0].Addons = append(after.Environments[0].Addons, Addon{ID: "cert-manager"})
	after.Environments = append(after.Environments, Environment{Name: "dev-2", Stage: "development"})
	if err := after.Apply(
		Edit{Environment: "prod", Kind: "databases", Name: "orders", Action: ActionUpdate, Fields: map[string]any{"size": 50}},
		Edit{Environment: "prod", Kind: "caches", Name: "hot", Action: ActionCreate, Fields: map[string]any{"engine": "redis"}},
	); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	c := Compare(before, after)
	if !c.HasChanges() {
		t.Fatal("no change reported")
	}
	wantFields := []FieldChange{
		{Field: "cloud.region", From: "nbg1", To: "fsn1"},
		{Field: "iac.version", From: "1.9.0", To: nil},
	}
	if !reflect.DeepEqual(c.Fields, wantFields) {
		t.Fatalf("project fields = %+v, want %+v", c.Fields, wantFields)
	}
	prod, dev1, dev2 := c.Environments[0], c.Environments[1], c.Environments[2]
	if prod.Action != ActionUpdate || dev1.Action != ActionUpdate || dev2.Action != ActionCreate {
		t.Fatalf("environment actions: %s %s %s", prod.Action, dev1.Action, dev2.Action)
	}
	if !reflect.DeepEqual(dev1.Fields, []FieldChange{{Field: "stage", From: "development", To: "staging"}}) {
		t.Fatalf("dev-1 fields = %+v", dev1.Fields)
	}
	byRef := map[string]ComponentChange{}
	for _, comp := range prod.Components {
		byRef[componentRefText(comp.Kind, comp.Name)] = comp
	}
	if got := byRef["databases/orders"]; got.Action != ActionUpdate || len(got.Changes) != 1 ||
		got.Changes[0].Field != "size" || !ValuesEqual(got.Changes[0].From, 20) || !ValuesEqual(got.Changes[0].To, 50) {
		t.Fatalf("databases/orders = %+v", got)
	}
	if byRef["caches/hot"].Action != ActionCreate || byRef["cluster"].Action != ActionUnchanged || byRef["databases/sessions"].Action != ActionUnchanged {
		t.Fatalf("component actions: %+v", byRef)
	}
	dns := prod.Addons[1]
	wantAddon := []FieldChange{
		{Field: "settings", Key: "provider", From: "cloudflare", To: "route53"},
		{Field: "version", From: "1.14.5", To: "1.15.0"},
	}
	if dns.Action != ActionUpdate || !reflect.DeepEqual(dns.Changes, wantAddon) {
		t.Fatalf("external-dns = %+v, want %+v", dns, wantAddon)
	}
	if prod.Addons[0].Action != ActionUnchanged || prod.Addons[2].Action != ActionCreate {
		t.Fatalf("add-on actions: %+v", prod.Addons)
	}
}

func TestCompare_AddonValuesAndClearsAreCompared(t *testing.T) {
	base := "project: p\ncloud:\n  region: r\nenvironments:\n  - name: a\n    stage: production\n    addons:\n      - id: x\n"
	before := mustParse(t, base+"        mode: managed\n        values:\n          k: 1\n")
	after := mustParse(t, base+"        mode: gitops\n        values: null\n")
	got := Compare(before, after).Environments[0].Addons[0]
	want := []FieldChange{
		{Field: "mode", From: "managed", To: "gitops"},
		{Field: "values", From: map[string]any{"k": 1}, To: nil},
	}
	if got.Action != ActionUpdate || !reflect.DeepEqual(got.Changes, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	file := mustParse(t, base+"        values_file: helm/x.yaml\n")
	if got := Compare(before, file).Environments[0].Addons[0]; len(got.Changes) != 1 || got.Changes[0].Field != "values_file" {
		t.Fatalf("values_file: %+v", got)
	}
}

func TestCompare_EnvironmentsMatchByTheNameTheServerWouldStore(t *testing.T) {
	// Parsed and NOT normalized, so the two names really are spelt differently here.
	before, err := Parse([]byte("project: p\ncloud:\n  region: r\nenvironments:\n  - name: Prod\n    stage: production\n"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	after, err := Parse([]byte("project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n"))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	c := Compare(before, after)
	if len(c.Environments) != 1 || c.Environments[0].Action != ActionUnchanged {
		t.Fatalf("`Prod` and `prod` were read as two environments: %+v", c.Environments)
	}
}

func TestApply_Edits(t *testing.T) {
	m := mustParse(t, handWritten)
	err := m.Apply(
		Edit{Environment: "PROD", Kind: "cluster", Action: ActionUpdate, Fields: map[string]any{
			"node_min_size":   4,
			"provider_config": map[string]any{"a": 1},
		}},
		Edit{Environment: "prod", Kind: "cluster", Action: ActionUpdate, Fields: map[string]any{
			"provider_config": map[string]any{"b": nil},
			"labels":          map[string]any{"x": "y"},
		}},
		Edit{Environment: "dev-1", Kind: "dns", Action: ActionCreate},
		Edit{Environment: "dev-1", Kind: "nothing-there", Name: "x", Action: ActionRemove},
	)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	cluster := component(t, m, "prod", "cluster", "").Fields
	if cluster["node_min_size"] != 4 || cluster["node_max_size"] != 3 {
		t.Fatalf("a field was not set, or one not named was touched: %v", cluster)
	}
	// provider_config is merged key by key, and an explicit null is kept as one.
	pc, _ := StringKeyed(cluster["provider_config"])
	if v, ok := pc["b"]; pc["a"] != 1 || !ok || v != nil {
		t.Fatalf("provider_config was not merged key by key: %v", pc)
	}
	if dns, ok := m.Environments[1].Components.Kind("dns"); !ok || dns.List || len(dns.Entries) != 1 {
		t.Fatalf("a bare one-per-environment component was not declared: %+v", m.Environments[1].Components)
	}
	out, err := Render(m)
	if err != nil || !strings.Contains(string(out), "b: null") {
		t.Fatalf("the explicit null is not written (%v):\n%s", err, out)
	}
}

func TestApply_RefusesWhatItCannotPlaceAndLeavesTheManifestAlone(t *testing.T) {
	for name, bad := range map[string]Edit{
		"no such environment": {Environment: "nope", Kind: "cluster", Action: ActionUpdate},
		"no kind":             {Environment: "prod", Action: ActionUpdate},
		"name on a singleton": {Environment: "prod", Kind: "cluster", Name: "main", Action: ActionUpdate},
		"no name on a list":   {Environment: "prod", Kind: "databases", Action: ActionUpdate},
		"a comparison result": {Environment: "prod", Kind: "cluster", Action: ActionOmitted},
		"another one":         {Environment: "prod", Kind: "cluster", Action: ActionUnchanged},
		"an action not known": {Environment: "prod", Kind: "cluster", Action: Action("destroy")},
	} {
		m := mustParse(t, handWritten)
		before, _ := Render(m)
		// A good edit first: a refusal must not leave it applied.
		err := m.Apply(Edit{Environment: "prod", Kind: "cluster", Action: ActionUpdate, Fields: map[string]any{"node_min_size": 9}}, bad)
		if err == nil {
			t.Fatalf("%s: accepted", name)
		}
		if !strings.Contains(err.Error(), "edit 1 (") {
			t.Fatalf("%s: the refusal does not say which edit: %v", name, err)
		}
		after, _ := Render(m)
		if string(before) != string(after) {
			t.Fatalf("%s: a refused batch changed the manifest", name)
		}
	}
}

func TestClone_SharesNothing(t *testing.T) {
	m := mustParse(t, handWritten)
	c, err := m.Clone()
	if err != nil {
		t.Fatalf("Clone: %v", err)
	}
	component(t, c, "prod", "cluster", "").Fields["node_min_size"] = 99
	c.Environments[0].Addons[1].Settings["provider"] = "other"
	if component(t, m, "prod", "cluster", "").Fields["node_min_size"] != 2 || m.Environments[0].Addons[1].Settings["provider"] != "cloudflare" {
		t.Fatal("changing the copy changed the original")
	}
}

func TestFields_DiffComparesOnlyWhatIsDeclaredAndByMeaning(t *testing.T) {
	declared := map[string]any{
		"same_int":        2,
		"same_list":       []any{1, "a"},
		"same_map":        map[any]any{"k": 1},
		"changed":         "new",
		"added":           true,
		"cleared":         nil,
		"provider_config": map[string]any{"keep": 1, "set": "x", "drop": nil, "gone_already": nil},
	}
	current := map[string]any{
		"same_int":        float64(2),
		"same_list":       []any{float64(1), "a"},
		"same_map":        map[string]any{"k": json.Number("1")},
		"changed":         "old",
		"cleared":         "was",
		"not_declared":    "left alone",
		"provider_config": map[string]any{"keep": float64(1), "set": "w", "drop": "v", "undeclared": 7},
	}
	got := DiffFields(declared, current)
	want := []FieldChange{
		{Field: "added", From: nil, To: true},
		{Field: "changed", From: "old", To: "new"},
		{Field: "cleared", From: "was", To: nil},
		{Field: "provider_config", Key: "drop", From: "v", To: nil},
		{Field: "provider_config", Key: "set", From: "w", To: "x"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("DiffFields = %+v\nwant %+v", got, want)
	}
	if got[3].Label() != "provider_config.drop" || got[0].Label() != "added" {
		t.Fatalf("labels: %q %q", got[3].Label(), got[0].Label())
	}
	body := ChangedFields(got)
	wantBody := map[string]any{"added": true, "changed": "new", "cleared": nil, "provider_config": map[string]any{"drop": nil, "set": "x"}}
	if !reflect.DeepEqual(body, wantBody) {
		t.Fatalf("ChangedFields = %#v", body)
	}
	// A merged field that is not a mapping on the file's side is compared whole.
	if whole := DiffFields(map[string]any{"provider_config": "oops"}, current); len(whole) != 1 || whole[0].Key != "" {
		t.Fatalf("a non-mapping provider_config: %+v", whole)
	}
}

func TestFields_ValuesCompareAndFormatByMeaning(t *testing.T) {
	type named struct {
		A int `json:"a"`
	}
	equal := [][2]any{
		{1, 1.0}, {uint8(3), int64(3)}, {float32(2), 2}, {json.Number("7"), 7},
		{named{A: 1}, map[string]any{"a": 1}}, {[]string{"a"}, []any{"a"}}, {nil, nil},
	}
	for _, p := range equal {
		if !ValuesEqual(p[0], p[1]) {
			t.Errorf("%#v and %#v should be equal", p[0], p[1])
		}
	}
	different := [][2]any{{1, "1"}, {nil, ""}, {[]any{1}, []any{1, 2}}, {json.Number("x"), 0}, {true, 1}}
	for _, p := range different {
		if ValuesEqual(p[0], p[1]) {
			t.Errorf("%#v and %#v should differ", p[0], p[1])
		}
	}
	// A value JSON cannot hold is compared as itself rather than dropped.
	ch := make(chan int)
	if !ValuesEqual(ch, ch) || ValuesEqual(ch, make(chan int)) {
		t.Error("a value with no JSON form must equal only itself")
	}
	for in, want := range map[any]string{nil: "(unset)", "": `""`, "x": "x", 3: "3", true: "true"} {
		if got := FormatFieldValue(in); got != want {
			t.Errorf("FormatFieldValue(%#v) = %q, want %q", in, got, want)
		}
	}
	if got := FormatFieldValue(map[any]any{"a": []any{1, "b"}}); got != `{"a":[1,"b"]}` {
		t.Errorf("FormatFieldValue(map) = %q", got)
	}
	if got := FormatFieldValue(ch); !strings.HasPrefix(got, "0x") {
		t.Errorf("FormatFieldValue(chan) = %q", got)
	}
	if _, ok := StringKeyed("not a map"); ok {
		t.Error("a string is not a mapping")
	}
}
