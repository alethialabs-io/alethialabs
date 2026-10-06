// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The add-on catalog client (#5528): GET /api/cli/schema/addons, and the lookups the CLI's
// manifest validation runs over it.

func TestGetAddonCatalog(t *testing.T) {
	fixture, err := os.ReadFile(filepath.Join("testdata", "addon_catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("returns the published document", func(t *testing.T) {
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assertAuth(t, r)
			if r.Method != "GET" || r.URL.Path != "/api/cli/schema/addons" {
				t.Errorf("got %s %s", r.Method, r.URL.Path)
			}
			_, _ = w.Write(fixture)
		}))
		doc, err := client.GetAddonCatalog()
		if err != nil {
			t.Fatalf("GetAddonCatalog: %v", err)
		}
		if len(doc.Addons) != 1 || doc.ChartVersion.Pattern == "" {
			t.Errorf("decoded %+v", doc)
		}
	})
	t.Run("refuses a catalog with zero add-ons", func(t *testing.T) {
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"addons": []any{}, "chart_version": map[string]any{}})
		}))
		if _, err := client.GetAddonCatalog(); err == nil || !strings.Contains(err.Error(), "zero add-ons") {
			t.Errorf("err = %v, want the zero-add-on refusal", err)
		}
	})
	t.Run("reports a failed fetch", func(t *testing.T) {
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		if _, err := client.GetAddonCatalog(); err == nil || !strings.Contains(err.Error(), "failed to fetch the add-on catalog") {
			t.Errorf("err = %v", err)
		}
	})
}

func TestAddonCatalogDocument_Lookups(t *testing.T) {
	doc := &AddonCatalogDocument{Addons: []AddonCatalogEntry{{ID: "loki"}, {ID: "cert-manager"}}}
	if a, ok := doc.Addon("loki"); !ok || a.ID != "loki" {
		t.Errorf("Addon(loki) = %+v, %v", a, ok)
	}
	if _, ok := doc.Addon("nope"); ok {
		t.Error("Addon(nope) found something")
	}
	if got := doc.IDs(); !reflect.DeepEqual(got, []string{"cert-manager", "loki"}) {
		t.Errorf("IDs() = %v, want sorted", got)
	}
	// A nil document is "no catalog": nothing found, nothing listed — never a panic.
	var none *AddonCatalogDocument
	if _, ok := none.Addon("loki"); ok || none.IDs() != nil {
		t.Error("a nil catalog answered")
	}
}

func TestEnableAddon_VersionThreeStates(t *testing.T) {
	var got map[string]any
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = nil
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	pin, clear := "1.15.0", ""
	for name, tc := range map[string]struct {
		version *string
		want    any
		present bool
	}{
		"omitted keeps": {nil, nil, false},
		`"" clears`:     {&clear, nil, true},
		"a pin":         {&pin, "1.15.0", true},
	} {
		if err := client.EnableAddon(EnableAddonParams{Project: "shop", AddonID: "loki", Version: tc.version}); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		v, present := got["version"]
		if present != tc.present || v != tc.want {
			t.Errorf("%s: version = %v (present %v), want %v (present %v)", name, v, present, tc.want, tc.present)
		}
	}
}
