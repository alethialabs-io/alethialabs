// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package designfile

import (
	"bytes"
	"strings"
	"testing"
)

// handWritten is a file the way a person keeps one: comments above and beside entries, blank lines
// between sections, a quoted scalar, fields in the order they thought of them, a list that is not
// indented under its key, and a field (`replicas_hint`) no schema of ours knows.
const handWritten = `# Boutique — production and one preview.
project: boutique

cloud:
  account: prod-account   # the connector's label
  region: nbg1

iac:
  version: "1.9.0"

environments:
# production owns the cluster
- name: prod
  stage: production
  components:
    cluster:
      # keep at least two nodes
      node_min_size: 2
      node_max_size: 3   # raise before a sale
      replicas_hint: {a: 1, b: [x, y]}
    databases:
      # the order book
      - name: orders
        engine: postgres
        size: 20

      - name: sessions
        engine: redis
  addons:
    - id: loki
    - id: external-dns
      version: 1.14.5
      settings:
        provider: cloudflare

# previews share prod's cluster
- name: dev-1
  stage: development
  namespace: boutique-dev-1
`

// mustDocument parses a file for editing.
func mustDocument(t *testing.T, src string) *Document {
	t.Helper()
	d, err := ParseDocument([]byte(src))
	if err != nil {
		t.Fatalf("ParseDocument: %v", err)
	}
	return d
}

// mustManifest is the design a document holds.
func mustManifest(t *testing.T, d *Document) *Manifest {
	t.Helper()
	m, err := d.Manifest()
	if err != nil {
		t.Fatalf("Manifest: %v", err)
	}
	return m
}

// update applies an edit to the document's design and returns the new file.
func update(t *testing.T, src string, edit func(m *Manifest)) (string, Result) {
	t.Helper()
	d := mustDocument(t, src)
	m := mustManifest(t, d)
	edit(m)
	res, err := d.Update(m)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	return string(res.Data), res
}

// changedLines is the lines of `after` that are not in `before` and the lines of `before` that are
// not in `after` — the two halves of a line diff, which is what a reviewer sees.
func changedLines(before, after string) (added, removed []string) {
	count := map[string]int{}
	for _, l := range strings.Split(before, "\n") {
		count[l]++
	}
	for _, l := range strings.Split(after, "\n") {
		if count[l] > 0 {
			count[l]--
			continue
		}
		added = append(added, l)
	}
	count = map[string]int{}
	for _, l := range strings.Split(after, "\n") {
		count[l]++
	}
	for _, l := range strings.Split(before, "\n") {
		if count[l] > 0 {
			count[l]--
			continue
		}
		removed = append(removed, l)
	}
	return added, removed
}

// wantLines fails unless the line diff is exactly the given one.
func wantLines(t *testing.T, before, after string, wantAdded, wantRemoved []string) {
	t.Helper()
	added, removed := changedLines(before, after)
	if strings.Join(added, "\n") != strings.Join(wantAdded, "\n") || strings.Join(removed, "\n") != strings.Join(wantRemoved, "\n") {
		t.Fatalf("line diff is not minimal.\n added: %q\n  want: %q\nremoved: %q\n  want: %q\n--- file ---\n%s", added, wantAdded, removed, wantRemoved, after)
	}
}

// component returns a pointer to one component entry of an environment.
func component(t *testing.T, m *Manifest, env, kind, name string) *Component {
	t.Helper()
	for i := range m.Environments {
		if m.Environments[i].Name != env {
			continue
		}
		for j := range m.Environments[i].Components {
			k := &m.Environments[i].Components[j]
			if k.Kind != kind {
				continue
			}
			for n := range k.Entries {
				if k.Entries[n].Name == name {
					return &k.Entries[n]
				}
			}
		}
	}
	t.Fatalf("no component %s/%s in %s", kind, name, env)
	return nil
}

func TestDocument_AnUnchangedDesignIsWrittenBackByteForByte(t *testing.T) {
	sources := map[string]string{
		"hand written":                   handWritten,
		"the package sample":             sample,
		"no trailing newline":            strings.TrimSuffix(handWritten, "\n"),
		"crlf":                           strings.ReplaceAll(handWritten, "\n", "\r\n"),
		"trailing blank lines":           handWritten + "\n\n",
		"flow style root":                "{project: p, cloud: {region: r}, environments: [{name: a, stage: production}]}\n",
		"document marker":                "---\n" + handWritten,
		"comment only":                   "# nothing yet\n",
		"empty":                          "",
		"odd indentation":                "project: p\ncloud:\n      region: r\nenvironments:\n   -   name: a\n       stage: production\n",
		"null singleton":                 "project: p\ncloud:\n  region: r\nenvironments:\n  - name: a\n    stage: production\n    components:\n      repositories:\n",
		"values that render differently": "project: p\ncloud:\n  region: r\nenvironments:\n  - name: a\n    stage: production\n    components:\n      cluster:\n        ratio: 1.0\n        when: 2026-01-02\n        label: 'single'\n        big: 0x10\n    addons:\n      - id: loki\n        version: 1.15\n",
	}
	for name, src := range sources {
		t.Run(name, func(t *testing.T) {
			d := mustDocument(t, src)
			res, err := d.Update(mustManifest(t, d))
			if err != nil {
				t.Fatalf("Update: %v", err)
			}
			if res.Whole {
				t.Fatalf("an unchanged design was written whole")
			}
			if !bytes.Equal(res.Data, []byte(src)) {
				t.Fatalf("round trip changed the file.\n--- want ---\n%s\n--- got ---\n%s", src, res.Data)
			}
			// And through the file's own parser, not only through Manifest().
			parsed, err := Parse([]byte(src))
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			again, err := d.Update(parsed)
			if err != nil || !bytes.Equal(again.Data, []byte(src)) {
				t.Fatalf("round trip through Parse changed the file (err %v):\n%s", err, again.Data)
			}
		})
	}
}

func TestDocument_AnUnchangedDesignSurvivesNormalizeWhenNothingWasDefaulted(t *testing.T) {
	// A file that already says everything Normalize would fill in is unchanged by it.
	src := "project: p\ncloud:\n  region: r\nenvironments:\n  - name: a # first\n    stage: production\n    placement: dedicated\n"
	out, _ := update(t, src, func(m *Manifest) { m.Normalize() })
	if out != src {
		t.Fatalf("Normalize changed a file that states its own defaults:\n%s", out)
	}
}

func TestDocument_ChangingOneFieldChangesOneLine(t *testing.T) {
	out, res := update(t, handWritten, func(m *Manifest) {
		component(t, m, "prod", "cluster", "").Fields["node_max_size"] = 5
	})
	if res.Whole {
		t.Fatal("a one-field change rewrote the file")
	}
	// The comment beside the value is kept on the line that replaces it.
	wantLines(t, handWritten, out,
		[]string{"      node_max_size: 5 # raise before a sale"},
		[]string{"      node_max_size: 3   # raise before a sale"})
}

func TestDocument_ChangingAFieldOfAListEntryChangesOneLine(t *testing.T) {
	out, _ := update(t, handWritten, func(m *Manifest) {
		component(t, m, "prod", "databases", "orders").Fields["size"] = 50
	})
	wantLines(t, handWritten, out, []string{"        size: 50"}, []string{"        size: 20"})
}

func TestDocument_AddingAFieldInsertsOneLine(t *testing.T) {
	out, _ := update(t, handWritten, func(m *Manifest) {
		component(t, m, "prod", "databases", "sessions").Fields["size"] = 5
	})
	wantLines(t, handWritten, out, []string{"        size: 5"}, nil)
	if !strings.Contains(out, "      - name: sessions\n        engine: redis\n        size: 5\n  addons:") {
		t.Fatalf("the new field is not at the end of its entry:\n%s", out)
	}
}

func TestDocument_AFieldNoSchemaKnowsIsKeptAsWritten(t *testing.T) {
	// `replicas_hint` is nothing this package has a type for. It must come through every edit
	// made elsewhere exactly as written — flow style and all.
	out, _ := update(t, handWritten, func(m *Manifest) {
		component(t, m, "prod", "cluster", "").Fields["node_min_size"] = 3
		component(t, m, "prod", "databases", "orders").Fields["engine"] = "mysql"
	})
	if !strings.Contains(out, "      replicas_hint: {a: 1, b: [x, y]}\n") {
		t.Fatalf("an unknown field was rewritten or lost:\n%s", out)
	}
	got, err := Parse([]byte(out))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	hint, ok := component(t, got, "prod", "cluster", "").Fields["replicas_hint"].(map[string]any)
	if !ok || hint["a"] != 1 {
		t.Fatalf("the unknown field does not read back: %#v", hint)
	}
}

func TestDocument_AddingAComponentToAnExistingKind(t *testing.T) {
	out, _ := update(t, handWritten, func(m *Manifest) {
		if err := m.Apply(Edit{Environment: "prod", Kind: "databases", Name: "audit", Action: ActionCreate,
			Fields: map[string]any{"engine": "postgres"}}); err != nil {
			t.Fatalf("Apply: %v", err)
		}
	})
	wantLines(t, handWritten, out, []string{"      - engine: postgres", "        name: audit"}, nil)
	if !strings.Contains(out, "        engine: redis\n      - engine: postgres\n        name: audit\n  addons:") {
		t.Fatalf("the new entry is not at the end of its list:\n%s", out)
	}
}

func TestDocument_AddingANewKindAndANewComponentsBlock(t *testing.T) {
	out, _ := update(t, handWritten, func(m *Manifest) {
		err := m.Apply(
			Edit{Environment: "prod", Kind: "caches", Name: "hot", Action: ActionCreate, Fields: map[string]any{"engine": "redis"}},
			Edit{Environment: "dev-1", Kind: "repositories", Action: ActionCreate, Fields: map[string]any{"apps_path": "overlays/dev-1"}},
		)
		if err != nil {
			t.Fatalf("Apply: %v", err)
		}
	})
	wantLines(t, handWritten, out, []string{
		"    caches:",
		"      - engine: redis",
		"        name: hot",
		"  components:",
		"    repositories:",
		"      apps_path: overlays/dev-1",
	}, nil)
	if !strings.Contains(out, "        engine: redis\n    caches:\n      - engine: redis\n        name: hot\n  addons:") {
		t.Fatalf("the new kind is not after the kinds already there:\n%s", out)
	}
	if !strings.HasSuffix(out, "  namespace: boutique-dev-1\n  components:\n    repositories:\n      apps_path: overlays/dev-1\n") {
		t.Fatalf("the new components block is not at the end of its environment:\n%s", out)
	}
}

func TestDocument_TakingAnEntryOutRemovesItsLinesAndItsComment(t *testing.T) {
	out, _ := update(t, handWritten, func(m *Manifest) {
		if err := m.Apply(Edit{Environment: "prod", Kind: "databases", Name: "sessions", Action: ActionRemove}); err != nil {
			t.Fatalf("Apply: %v", err)
		}
	})
	wantLines(t, handWritten, out, nil, []string{"      - name: sessions", "        engine: redis"})

	out, _ = update(t, handWritten, func(m *Manifest) {
		if err := m.Apply(Edit{Environment: "prod", Kind: "databases", Name: "orders", Action: ActionRemove}); err != nil {
			t.Fatalf("Apply: %v", err)
		}
	})
	wantLines(t, handWritten, out, nil,
		[]string{"      # the order book", "      - name: orders", "        engine: postgres", "        size: 20"})
}

func TestDocument_TakingTheLastEntryOutRemovesTheKind(t *testing.T) {
	out, _ := update(t, handWritten, func(m *Manifest) {
		err := m.Apply(
			Edit{Environment: "prod", Kind: "databases", Name: "orders", Action: ActionRemove},
			Edit{Environment: "prod", Kind: "databases", Name: "sessions", Action: ActionRemove},
		)
		if err != nil {
			t.Fatalf("Apply: %v", err)
		}
	})
	if strings.Contains(out, "databases") || strings.Contains(out, "orders") {
		t.Fatalf("the emptied kind is still in the file:\n%s", out)
	}
	if !strings.Contains(out, "      replicas_hint: {a: 1, b: [x, y]}\n") || !strings.Contains(out, "  addons:\n    - id: loki\n") {
		t.Fatalf("its neighbours did not survive:\n%s", out)
	}
}

func TestDocument_AddingAndRemovingAnEnvironment(t *testing.T) {
	out, _ := update(t, handWritten, func(m *Manifest) {
		m.Environments = append(m.Environments, Environment{Name: "dev-2", Stage: "development"})
	})
	wantLines(t, handWritten, out, []string{"- name: dev-2", "  stage: development"}, nil)
	if !strings.HasSuffix(out, "  namespace: boutique-dev-1\n- name: dev-2\n  stage: development\n") {
		t.Fatalf("the new environment is not last:\n%s", out)
	}

	out, _ = update(t, handWritten, func(m *Manifest) { m.Environments = m.Environments[:1] })
	wantLines(t, handWritten, out, nil,
		[]string{"# previews share prod's cluster", "- name: dev-1", "  stage: development", "  namespace: boutique-dev-1"})
}

func TestDocument_AnEnvironmentAddedFirstIsWrittenFirst(t *testing.T) {
	// Order is meaning here: the first environment is the default one.
	out, _ := update(t, handWritten, func(m *Manifest) {
		m.Environments = append([]Environment{{Name: "edge", Stage: "production"}}, m.Environments...)
	})
	got, err := Parse([]byte(out))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.Environments[0].Name != "edge" || got.Environments[1].Name != "prod" {
		t.Fatalf("order was not kept: %s, %s", got.Environments[0].Name, got.Environments[1].Name)
	}
	wantLines(t, handWritten, out, []string{"- name: edge", "  stage: production"}, nil)
	if !strings.Contains(out, "- name: edge\n  stage: production\n# production owns the cluster\n- name: prod\n") {
		t.Fatalf("the comment above prod did not stay with prod:\n%s", out)
	}
}

func TestDocument_ReorderingIsHonouredEvenThoughItCostsTheBlock(t *testing.T) {
	out, res := update(t, handWritten, func(m *Manifest) {
		m.Environments[0], m.Environments[1] = m.Environments[1], m.Environments[0]
	})
	got, err := Parse([]byte(out))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.Environments[0].Name != "dev-1" {
		t.Fatalf("the reorder was not written:\n%s", out)
	}
	if res.Whole {
		t.Fatal("a reorder of one list rewrote the whole file")
	}
	if !strings.HasPrefix(out, "# Boutique — production and one preview.\nproject: boutique\n\ncloud:\n  account: prod-account   # the connector's label\n") {
		t.Fatalf("the part of the file above the list was touched:\n%s", out)
	}
}

func TestDocument_ScalarsAndAddons(t *testing.T) {
	out, _ := update(t, handWritten, func(m *Manifest) {
		m.Cloud.Region = "fsn1"
		pin := "1.15.0"
		m.Environments[0].Addons[1].Version = &pin
		m.Environments[0].Addons[1].Settings["domainFilter"] = "example.com"
		m.Environments[0].Addons = append(m.Environments[0].Addons, Addon{ID: "cert-manager"})
	})
	wantLines(t, handWritten, out,
		[]string{"  region: fsn1", "      version: 1.15.0", "        domainFilter: example.com", "    - id: cert-manager"},
		[]string{"  region: nbg1", "      version: 1.14.5"})
}

func TestDocument_RemovingATopLevelBlock(t *testing.T) {
	out, _ := update(t, handWritten, func(m *Manifest) { m.IaC = IaC{} })
	wantLines(t, handWritten, out, nil, []string{"iac:", `  version: "1.9.0"`})
}

func TestDocument_AValueWrittenWithNothingInItTakesAValue(t *testing.T) {
	src := "project: p\ncloud:\n  region: r\niac:\nenvironments:\n  - name: a\n    stage: production\n    components:\n      repositories:   # defaults for now\n"
	out, _ := update(t, src, func(m *Manifest) {
		m.IaC.Version = "1.9.0"
		component(t, m, "a", "repositories", "").Fields["apps_path"] = "k8s"
	})
	want := "project: p\ncloud:\n  region: r\niac:\n  version: 1.9.0\nenvironments:\n  - name: a\n    stage: production\n    components:\n      repositories:\n        apps_path: k8s\n"
	if out != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out, want)
	}
}

func TestDocument_BlockScalarsAreNeverMistakenForComments(t *testing.T) {
	src := "project: p\ncloud:\n  region: r\nenvironments:\n  - name: a\n    stage: production\n    components:\n      cluster:\n        script: |\n          echo one\n          # not a comment\n\n        size: 1\n    addons:\n      - id: loki\n        values:\n          note: |-\n            first\n            # still text\n"
	out, _ := update(t, src, func(m *Manifest) {
		component(t, m, "a", "cluster", "").Fields["script"] = "echo two\n"
	})
	got, err := Parse([]byte(out))
	if err != nil {
		t.Fatalf("Parse: %v\n%s", err, out)
	}
	if got.Environments[0].Components[0].Entries[0].Fields["script"] != "echo two\n" {
		t.Fatalf("the block scalar was not replaced whole:\n%s", out)
	}
	if strings.Contains(out, "# not a comment") {
		t.Fatalf("a line of the old block scalar was left behind:\n%s", out)
	}
	if !strings.Contains(out, "            # still text\n") {
		t.Fatalf("the other block scalar was touched:\n%s", out)
	}

	// Removing the add-on whose last line looks like a comment takes that line with it.
	out, _ = update(t, src, func(m *Manifest) { m.Environments[0].Addons = nil })
	if strings.Contains(out, "still text") || strings.Contains(out, "addons") {
		t.Fatalf("part of the removed add-on was left behind:\n%s", out)
	}
}

func TestDocument_LineEndingsAndTheFinalNewlineAreKept(t *testing.T) {
	crlf := strings.ReplaceAll(handWritten, "\n", "\r\n")
	out, _ := update(t, crlf, func(m *Manifest) {
		component(t, m, "prod", "databases", "sessions").Fields["size"] = 5
	})
	if strings.Contains(strings.ReplaceAll(out, "\r\n", ""), "\n") || !strings.Contains(out, "        size: 5\r\n") {
		t.Fatalf("a bare line feed was written into a CRLF file:\n%q", out)
	}

	bare := strings.TrimSuffix(handWritten, "\n")
	out, _ = update(t, bare, func(m *Manifest) { m.Environments[1].Namespace = "other" })
	if strings.HasSuffix(out, "\n") || !strings.HasSuffix(out, "  namespace: other") {
		t.Fatalf("a final newline was added to a file that had none:\n%q", out)
	}
}

func TestDocument_UpdateIsDeterministicAndConverges(t *testing.T) {
	edit := func(m *Manifest) {
		component(t, m, "prod", "cluster", "").Fields["zones"] = []any{"a", "b"}
		component(t, m, "prod", "cluster", "").Fields["labels"] = map[string]any{"team": "shop", "tier": "gold"}
		m.Environments[1].Lifecycle = "ephemeral"
	}
	first, _ := update(t, handWritten, edit)
	for i := 0; i < 20; i++ {
		if again, _ := update(t, handWritten, edit); again != first {
			t.Fatalf("run %d wrote a different file:\n%s\n--- first ---\n%s", i, again, first)
		}
	}
	// Writing the same design onto the result changes nothing: the edit settles in one step.
	settled, res := update(t, first, edit)
	if settled != first || res.Whole {
		t.Fatalf("a second application changed the file:\n%s", settled)
	}
}

func TestDocument_EditingAndUndoingReturnsTheOriginalBytes(t *testing.T) {
	changed, _ := update(t, handWritten, func(m *Manifest) {
		component(t, m, "prod", "databases", "orders").Fields["size"] = 50
		m.Environments[1].Stage = "staging"
	})
	back, _ := update(t, changed, func(m *Manifest) {
		component(t, m, "prod", "databases", "orders").Fields["size"] = 20
		m.Environments[1].Stage = "development"
	})
	if back != handWritten {
		added, removed := changedLines(handWritten, back)
		t.Fatalf("undoing an edit did not restore the file. added %q removed %q", added, removed)
	}
}

func TestDocument_ShapesItCannotPatchAreWrittenOneLevelUpNotGuessed(t *testing.T) {
	// A flow mapping holds several entries on one line, so the line is rewritten — and only it.
	src := "project: p\ncloud: {account: acct, region: r}   # one line\nenvironments:\n  - name: a\n    stage: production\n"
	out, res := update(t, src, func(m *Manifest) { m.Cloud.Region = "fsn1" })
	if res.Whole {
		t.Fatal("a flow mapping forced a whole rewrite")
	}
	wantLines(t, src, out, []string{"cloud:", "  account: acct", "  region: fsn1"}, []string{"cloud: {account: acct, region: r}   # one line"})

	// The first key of a list entry carries the dash; the entry is rewritten rather than orphaned.
	src = "project: p\ncloud:\n  region: r\nenvironments:\n  - lifecycle: ephemeral\n    name: a\n    stage: production\n  - name: b\n    stage: staging\n"
	out, res = update(t, src, func(m *Manifest) { m.Environments[0].Lifecycle = "" })
	got, err := Parse([]byte(out))
	if err != nil || res.Whole {
		t.Fatalf("Parse: %v, whole %v\n%s", err, res.Whole, out)
	}
	if got.Environments[0].Lifecycle != "" || got.Environments[0].Name != "a" || !strings.HasSuffix(out, "  - name: b\n    stage: staging\n") {
		t.Fatalf("the entry was not rewritten cleanly:\n%s", out)
	}
}

func TestDocument_AFileWithNothingToPatchIsWrittenWhole(t *testing.T) {
	m := &Manifest{Project: "p", Cloud: Cloud{Region: "r"}, Environments: []Environment{{Name: "a", Stage: "production"}}}
	for name, src := range map[string]string{"empty": "", "comment only": "# todo\n", "flow root": "{project: old, cloud: {region: r}, environments: [{name: a, stage: production}]}\n"} {
		d := mustDocument(t, src)
		res, err := d.Update(m)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		want, _ := Render(m)
		if !res.Whole || !bytes.Equal(res.Data, want) {
			t.Fatalf("%s: whole %v, wrote:\n%s", name, res.Whole, res.Data)
		}
	}
}

func TestDocument_TheResultAlwaysMeansTheDesignAskedFor(t *testing.T) {
	// The property everything else rests on, over a spread of edits and awkward sources: whatever
	// Update writes parses back to exactly the design it was given.
	sources := []string{
		handWritten,
		sample,
		strings.ReplaceAll(handWritten, "\n", "\r\n"),
		"project: p\ncloud:\n      region: r\nenvironments:\n   -   name: prod\n       stage: production\n   -   name: dev-1\n       stage: development\n",
		"project: p\ncloud: {region: r}\nenvironments: [{name: prod, stage: production}, {name: dev-1, stage: development}]\n",
		"project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    components: {cluster: {node_min_size: 1}}\n  - {name: dev-1, stage: development}\n",
		"project: \"p\"\n\"cloud\":\n  \"region\": 'r'\nenvironments:\n  -\n    name: prod\n    stage: production\n  - name: dev-1\n    stage: development\n",
		"project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    components:\n      cluster:\n        note: \"two\n          # lines\"\n        after: 1\n  - name: dev-1\n    stage: development\n",
	}
	edits := map[string]func(m *Manifest){
		"field": func(m *Manifest) {
			_ = m.Apply(Edit{Environment: "prod", Kind: "cluster", Action: ActionUpdate, Fields: map[string]any{"node_min_size": 9}})
		},
		"nested": func(m *Manifest) {
			_ = m.Apply(Edit{Environment: "prod", Kind: "cluster", Action: ActionUpdate, Fields: map[string]any{"provider_config": map[string]any{"a": map[string]any{"b": []any{1, "two"}}, "gone": nil}}})
		},
		"new kind": func(m *Manifest) {
			_ = m.Apply(Edit{Environment: "dev-1", Kind: "caches", Name: "hot", Action: ActionCreate, Fields: map[string]any{"engine": "redis", "text": "line one\nline two\n"}})
		},
		"remove":  func(m *Manifest) { _ = m.Apply(Edit{Environment: "prod", Kind: "cluster", Action: ActionRemove}) },
		"scalars": func(m *Manifest) { m.Project, m.Cloud.Account, m.IaC.Version = "renamed", "other", "1.10.0" },
		"env first": func(m *Manifest) {
			m.Environments = append([]Environment{{Name: "zero", Stage: "production", Placement: "dedicated"}}, m.Environments...)
		},
		"env last": func(m *Manifest) {
			m.Environments = append(m.Environments, Environment{Name: "last", Stage: "staging", Addons: []Addon{{ID: "loki"}}})
		},
		"drop env": func(m *Manifest) { m.Environments = m.Environments[:1] },
		"swap":     func(m *Manifest) { m.Environments[0], m.Environments[1] = m.Environments[1], m.Environments[0] },
		"rename":   func(m *Manifest) { m.Environments[1].Name = "preview" },
		"addons": func(m *Manifest) {
			clear := ""
			m.Environments[0].Addons = []Addon{{ID: "loki", Version: &clear, Settings: map[string]any{"k": nil}}, {ID: "x", ValuesCleared: true}}
		},
		"everything": func(m *Manifest) {
			*m = Manifest{Project: "q", Cloud: Cloud{Region: "z"}, Environments: []Environment{{Name: "only", Stage: "production"}}}
		},
	}
	for si, src := range sources {
		for name, edit := range edits {
			d := mustDocument(t, src)
			m := mustManifest(t, d)
			edit(m)
			res, err := d.Update(m)
			if err != nil {
				t.Fatalf("source %d, %s: %v", si, name, err)
			}
			got, err := Parse(res.Data)
			if err != nil {
				t.Fatalf("source %d, %s: the result does not parse: %v\n%s", si, name, err, res.Data)
			}
			wantBytes, _ := canonicalBytes(m)
			gotBytes, _ := canonicalBytes(got)
			if !bytes.Equal(wantBytes, gotBytes) {
				t.Fatalf("source %d, %s: the result means something else.\n--- want ---\n%s\n--- got ---\n%s\n--- file ---\n%s", si, name, wantBytes, gotBytes, res.Data)
			}
			if _, err := ParseDocument(res.Data); err != nil {
				t.Fatalf("source %d, %s: the result cannot be opened for the next edit: %v", si, name, err)
			}
		}
	}
}

func TestParseDocument_Refusals(t *testing.T) {
	if _, err := ParseDocument([]byte("project: a\n---\nproject: b\n")); err == nil || !strings.Contains(err.Error(), "more than one YAML document") {
		t.Fatalf("a second document was accepted: %v", err)
	}
	if _, err := ParseDocument([]byte("project: a\nplacment: x\n")); err == nil {
		t.Fatal("an unknown key was accepted for editing")
	}
	if _, err := ParseDocument([]byte("a: [\n")); err == nil {
		t.Fatal("a broken document was accepted for editing")
	}
	d := mustDocument(t, sample)
	if _, err := d.Update(nil); err == nil {
		t.Fatal("Update accepted no design")
	}
	if string(d.Bytes()) != sample {
		t.Fatal("Bytes is not the source")
	}
}
