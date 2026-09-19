// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// The fixture is dumped from the console's own builder (componentSchemaDocument() in
// apps/console/lib/cli/project-components.ts), so it IS the wire shape and not a hand-written
// approximation of it. The console side asserts it against componentSchemaWire in
// tests/validations/cli-contract.test.ts; this side strict-decodes it into the Go types.
func TestContract_ComponentSchema(t *testing.T) {
	var doc ComponentSchemaDocument
	strictDecode(t, "component_schema.json", &doc)
	assertNoExtraStructKeys(t, "component_schema.json", doc)

	if doc.Version == "" {
		t.Fatal("fixture has no version — the ETag/cache key the CLI revalidates on")
	}
	if len(doc.Kinds) < 13 {
		t.Fatalf("fixture publishes %d kinds; the registry had 14 when it was dumped, so a smaller "+
			"document is a truncated dump rather than a smaller registry", len(doc.Kinds))
	}
	// The two things the manifest reader asks the document: which kinds are singletons, and which
	// fields each takes. Both are pinned on the kinds the golden path writes.
	cluster, ok := doc.Kind("cluster")
	if !ok || !cluster.Singleton {
		t.Fatalf("cluster must be a published singleton, got ok=%v singleton=%v", ok, cluster.Singleton)
	}
	if !contains(cluster.Fields, "node_min_size") || !contains(cluster.Fields, "node_max_size") {
		t.Errorf("cluster fields %v lack the node sizing the demo sets", cluster.Fields)
	}
	repos, ok := doc.Kind("repositories")
	if !ok || !repos.Singleton || !contains(repos.Fields, "apps_path") {
		t.Errorf("repositories must be a singleton taking apps_path, got %+v", repos)
	}
	dbs, ok := doc.Kind("databases")
	if !ok || dbs.Singleton {
		t.Errorf("databases must be a published MULTI kind, got ok=%v %+v", ok, dbs)
	}
	// helm_registries is the kind the hand-typed CLI literal never learned about — the reason a
	// published document exists. Its absence here would mean the dump predates #3671's registry.
	if _, ok := doc.Kind("helm_registries"); !ok {
		t.Errorf("helm_registries is not in the fixture: %v", doc.KindNames())
	}
	if _, ok := doc.Kind("not_a_kind"); ok {
		t.Error("an unknown kind resolved")
	}
	if got := doc.KindNames(); len(got) != len(doc.Kinds) || got[0] > got[len(got)-1] {
		t.Errorf("KindNames is not the sorted full list: %v", got)
	}
}

// A nil document answers nothing rather than panicking — the manifest reader treats a missing
// schema as "could not check", and that path must not crash on the way to saying so.
func TestComponentSchema_NilDocument(t *testing.T) {
	var d *ComponentSchemaDocument
	if _, ok := d.Kind("cluster"); ok {
		t.Error("nil document resolved a kind")
	}
	if names := d.KindNames(); names != nil {
		t.Errorf("nil document listed kinds: %v", names)
	}
}

func TestGetComponentSchema(t *testing.T) {
	fixture, err := os.ReadFile(filepath.Join("testdata", "component_schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("returns the published document", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/cli/schema/components" {
				t.Errorf("unexpected path %s", r.URL.Path)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(fixture)
		}))
		defer srv.Close()
		t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
		c := NewClient("tok")
		doc, err := c.GetComponentSchema()
		if err != nil {
			t.Fatalf("GetComponentSchema: %v", err)
		}
		if len(doc.Kinds) == 0 || doc.Version == "" {
			t.Fatalf("empty document decoded: %+v", doc)
		}
	})
	t.Run("refuses a document with zero kinds", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(ComponentSchemaDocument{Version: "v", Kinds: nil})
		}))
		defer srv.Close()
		t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
		c := NewClient("tok")
		if _, err := c.GetComponentSchema(); err == nil {
			t.Fatal("a zero-kind document was accepted — a client caching it would refuse every component")
		}
	})
	t.Run("surfaces a server error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, `{"error":"nope"}`, http.StatusForbidden)
		}))
		defer srv.Close()
		t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
		c := NewClient("tok")
		if _, err := c.GetComponentSchema(); err == nil {
			t.Fatal("a 403 decoded as a document")
		}
	})
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
