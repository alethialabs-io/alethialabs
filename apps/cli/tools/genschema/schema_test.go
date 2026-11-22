// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/designfile"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

// committedSchema is the file the docs site serves, relative to this package.
var committedSchema = filepath.Join("..", "..", filepath.FromSlash(defaultOut))

// The committed file is exactly what the generator writes. A key added to the file's types without
// regenerating fails here, with the command that fixes it.
func TestSchema_TheCommittedFileIsWhatTheGeneratorWrites(t *testing.T) {
	want, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(committedSchema)
	if err != nil {
		t.Fatalf("read the committed schema: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s is not what the generator writes. Regenerate it: cd apps/cli && go run ./tools/genschema",
			committedSchema)
	}
}

// The schema's address is the one `alethia export` writes into a file's first line, and the
// committed file sits where the docs site serves that address from.
func TestSchema_ItIsServedAtTheAddressExportWrites(t *testing.T) {
	root, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	if root.ID != designfile.SchemaURL || root.Schema != draft {
		t.Errorf("$id = %q, $schema = %q", root.ID, root.Schema)
	}
	// The docs site serves apps/docs/public under /docs.
	if served := "/docs/" + strings.TrimPrefix(filepath.ToSlash(defaultOut), "../docs/public/"); !strings.HasSuffix(designfile.SchemaURL, served) {
		t.Errorf("the schema is committed where the site serves %s, and export names %s", served, designfile.SchemaURL)
	}
	if !strings.HasSuffix(designfile.SchemaComment, designfile.SchemaURL) {
		t.Errorf("the comment export writes does not name the schema: %q", designfile.SchemaComment)
	}
}

// validManifest is a file that uses every key the schema declares, in every spelling the reader
// takes for the keys that have more than one.
const validManifest = `project: boutique
cloud:
  account: prod-account
  region: eu-west-1
iac:
  version: 1.8.0
environments:
  - name: prod
    stage: production
    placement: dedicated
    lifecycle: persistent
    components:
      cluster:
        node_min_size: 1
      repositories:
      databases:
        - name: orders
          engine: postgres
    addons:
      - id: loki
      - id: external-dns
        version: 1.15
        mode: managed
        settings:
          provider: cloudflare
          domainFilter: null
        values:
          replicas: 2
      - id: kube-prometheus-stack
        version: ""
        mode: null
        settings: null
        values_file: helm/kps.yaml
      - id: falco
        version: null
        values: null
      - id: velero
        values_file: null
  - name: dev-1
    stage: development
    placement: namespace
    namespace: boutique-dev-1
`

// decode reads a YAML document the way a YAML language server sees it: plain maps, lists and
// scalars.
func decode(t *testing.T, doc string) any {
	t.Helper()
	var v any
	if err := yaml.Unmarshal([]byte(doc), &v); err != nil {
		t.Fatalf("the test document is not YAML: %v\n%s", err, doc)
	}
	return v
}

// The schema never refuses what the reader accepts: a file with every key, in every accepted
// spelling, parses AND validates.
func TestSchema_AcceptsWhatTheReaderAccepts(t *testing.T) {
	if _, err := designfile.Parse([]byte(validManifest)); err != nil {
		t.Fatalf("the reader refuses the test document, so it proves nothing: %v", err)
	}
	root, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	if problems := check(root, decode(t, validManifest), "$"); len(problems) > 0 {
		t.Errorf("the schema refuses a file the reader accepts:\n  %s", strings.Join(problems, "\n  "))
	}
	// Every key the schema declares is in the document, so the check above covered each of them.
	for _, key := range declaredKeys(root, "") {
		if !strings.Contains(validManifest, lastSegment(key)+":") {
			t.Errorf("the test document has no %s, so that key's schema was never checked", key)
		}
	}
}

// lastSegment is the key name at the end of a path.
func lastSegment(path string) string {
	path = strings.TrimSuffix(path, "[]")
	return path[strings.LastIndex(path, ".")+1:]
}

// declaredKeys lists the path of every property the schema declares, depth first.
func declaredKeys(s *Schema, path string) []string {
	var out []string
	for _, p := range s.Properties {
		at := p.Name
		if path != "" {
			at = path + "." + p.Name
		}
		out = append(out, at)
		out = append(out, declaredKeys(p.Schema, at)...)
		if p.Schema.Items != nil {
			out = append(out, declaredKeys(p.Schema.Items, at+"[]")...)
		}
	}
	return out
}

// Every key the schema declares is a key the reader takes, and a key the schema does not declare
// is one the reader refuses — at each of the four closed objects.
func TestSchema_ItsKeysAreTheReadersKeys(t *testing.T) {
	root, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range declaredKeys(root, "") {
		if _, ok := descriptions[key]; !ok {
			t.Errorf("the schema declares %s and no description is written for it", key)
		}
	}
	for name, doc := range map[string]string{
		"the file":       validManifest + "colour: blue\n",
		"cloud":          strings.Replace(validManifest, "  region: eu-west-1\n", "  region: eu-west-1\n  zone: a\n", 1),
		"iac":            strings.Replace(validManifest, "  version: 1.8.0\n", "  version: 1.8.0\n  engine: tofu\n", 1),
		"an environment": strings.Replace(validManifest, "    lifecycle: persistent\n", "    lifecycle: persistent\n    tier: gold\n", 1),
		"an add-on":      strings.Replace(validManifest, "      - id: loki\n", "      - id: loki\n        values_cleared: true\n", 1),
	} {
		if _, err := designfile.Parse([]byte(doc)); err == nil {
			t.Errorf("%s: the reader accepts a key the schema does not declare", name)
		}
		if problems := check(root, decode(t, doc), "$"); len(problems) == 0 {
			t.Errorf("%s: the schema accepts a key the reader refuses", name)
		}
	}
}

// Every key the schema requires is one the reader's own validation requires: a file without it is
// refused by `alethia plan` before anything is sent.
func TestSchema_RequiresOnlyWhatTheReaderRequires(t *testing.T) {
	root, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	rules := designfile.Rules{
		Stages:     enumStrings(types.AllEnvironmentStages),
		Placements: enumStrings(types.AllPlacementModes),
		AddonModes: enumStrings(types.AllAddonModes),
	}
	refused := func(doc string) bool {
		m, err := designfile.Parse([]byte(doc))
		if err != nil {
			return true
		}
		m.Normalize()
		return m.Validate(rules) != nil
	}
	minimal := "project: p\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n      - id: loki\n"
	if refused(minimal) {
		t.Fatal("the reader refuses the minimal document, so it proves nothing")
	}
	if problems := check(root, decode(t, minimal), "$"); len(problems) > 0 {
		t.Fatalf("the schema refuses the minimal document: %v", problems)
	}
	for name, without := range map[string]string{
		"project":                    strings.Replace(minimal, "project: p\n", "", 1),
		"cloud":                      strings.Replace(minimal, "cloud:\n  region: r\n", "", 1),
		"cloud.region":               strings.Replace(minimal, "  region: r\n", "  account: a\n", 1),
		"environments":               "project: p\ncloud:\n  region: r\n",
		"environments (empty)":       "project: p\ncloud:\n  region: r\nenvironments: []\n",
		"environments[].name":        strings.Replace(minimal, "  - name: prod\n    stage: production\n", "  - stage: production\n", 1),
		"environments[].stage":       strings.Replace(minimal, "    stage: production\n", "", 1),
		"environments[].addons[].id": strings.Replace(minimal, "      - id: loki\n", "      - version: 1.0.0\n", 1),
		"a listed component's name":  minimal + "    components:\n      databases:\n        - engine: postgres\n",
	} {
		if !refused(without) {
			t.Errorf("%s: the reader accepts a file without it", name)
		}
		if problems := check(root, decode(t, without), "$"); len(problems) == 0 {
			t.Errorf("%s: the schema accepts a file without it", name)
		}
	}
	// And nothing else is required: the count is the list above, less the empty-list case.
	if got := countRequired(root); got != 8 {
		t.Errorf("the schema requires %d keys; each one needs a row in this test", got)
	}
}

// countRequired counts every `required` entry in the schema, whatever keyword it sits under.
func countRequired(s *Schema) int {
	if s == nil {
		return 0
	}
	n := len(s.Required)
	for _, p := range s.Properties {
		n += countRequired(p.Schema)
	}
	n += countRequired(s.Items)
	if extra, ok := s.AdditionalProperties.(*Schema); ok {
		n += countRequired(extra)
	}
	for _, alt := range s.OneOf {
		n += countRequired(alt)
	}
	return n
}

// enumStrings is a generated enum list as plain strings.
func enumStrings[T ~string](values []T) []string {
	out := make([]string, len(values))
	for i, v := range values {
		out[i] = string(v)
	}
	return out
}

// The closed vocabularies are the generated lists, and a value outside one is refused by the schema
// as it is by the reader.
func TestSchema_TheVocabulariesAreTheGeneratedLists(t *testing.T) {
	root, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	env := root.Properties.Get("environments").Items
	for key, want := range map[string][]string{
		"stage":     enumStrings(types.AllEnvironmentStages),
		"placement": enumStrings(types.AllPlacementModes),
	} {
		var got []string
		for _, v := range env.Properties.Get(key).Enum {
			got = append(got, fmt.Sprint(v))
		}
		if !slices.Equal(got, want) {
			t.Errorf("%s is %v, want the generated list %v", key, got, want)
		}
	}
	mode := env.Properties.Get("addons").Items.Properties.Get("mode").Enum
	if len(mode) != len(types.AllAddonModes)+1 || mode[len(mode)-1] != nil {
		t.Errorf("an add-on mode is one of the generated list, or null: %v", mode)
	}
	bad := strings.Replace(validManifest, "stage: production", "stage: qa", 1)
	if problems := check(root, decode(t, bad), "$"); len(problems) == 0 {
		t.Error("the schema accepts a stage outside the list")
	}
}

// A file the YAML reader would not even type correctly is refused: the wrong shape under a key.
func TestSchema_RefusesTheWrongShape(t *testing.T) {
	root, err := Build()
	if err != nil {
		t.Fatal(err)
	}
	for name, doc := range map[string]string{
		"environments as a mapping":   "project: p\ncloud:\n  region: r\nenvironments:\n  prod: {}\n",
		"a component kind as text":    strings.Replace(validManifest, "      repositories:\n", "      repositories: yes please\n", 1),
		"a list entry with no name":   strings.Replace(validManifest, "        - name: orders\n", "        - label: orders\n", 1),
		"an add-on's settings a list": strings.Replace(validManifest, "        settings: null\n", "        settings: [a]\n", 1),
		"the file as a list":          "- project: p\n",
	} {
		if problems := check(root, decode(t, doc), "$"); len(problems) == 0 {
			t.Errorf("%s: the schema accepts it", name)
		}
	}
}

// The generator refuses to write a schema it cannot stand behind: a key with no sentence, a
// sentence with no key, and a Go type it does not know.
func TestBuild_RefusesWhatItCannotDescribe(t *testing.T) {
	saved := descriptions["project"]
	delete(descriptions, "project")
	descriptions["colour"] = "A key the file does not have."
	t.Cleanup(func() {
		descriptions["project"] = saved
		delete(descriptions, "colour")
	})
	_, err := Build()
	if err == nil {
		t.Fatal("a schema with an undescribed key was generated")
	}
	for _, want := range []string{"no description is written for the key project", "a key the file does not have: colour"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not say %q:\n%v", want, err)
		}
	}
	if _, err := Generate(); err == nil {
		t.Error("Generate wrote a schema Build refused")
	}

	g := &generator{used: map[string]bool{}}
	g.value(reflectTypeOfInt, "count")
	if len(g.problems) != 1 || !strings.Contains(g.problems[0], "count") {
		t.Errorf("an unknown Go type was described without a word: %v", g.problems)
	}

	savedType := addonKeyTypes["mode"]
	delete(addonKeyTypes, "mode")
	t.Cleanup(func() { addonKeyTypes["mode"] = savedType })
	g = &generator{used: map[string]bool{}}
	g.addon("environments[].addons[]")
	if len(g.problems) != 1 || !strings.Contains(g.problems[0], "mode") {
		t.Errorf("an add-on key with no type was described without a word: %v", g.problems)
	}
}

// The command writes the schema to the file it is given, or to stdout, and refuses a flag it does
// not have.
func TestRun_WritesTheSchema(t *testing.T) {
	want, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	if err := run([]string{"-out", "-"}, &stdout); err != nil || !bytes.Equal(stdout.Bytes(), want) {
		t.Errorf("-out - did not write the schema to stdout: %v", err)
	}
	path := filepath.Join(t.TempDir(), "nested", "schema.json")
	if err := run([]string{"-out", path}, &stdout); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, want) {
		t.Errorf("-out FILE did not write the schema: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(want, &parsed); err != nil || parsed["$id"] != designfile.SchemaURL {
		t.Errorf("what was written is not the schema document: %v", err)
	}
	if err := run([]string{"-nope"}, &stdout); err == nil {
		t.Error("an unknown flag was accepted")
	}
	blocked := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocked, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"-out", filepath.Join(blocked, "under", "schema.json")}, &stdout); err == nil {
		t.Error("writing under a file was not refused")
	}

	delete(descriptions, "project")
	t.Cleanup(func() {
		descriptions["project"] = "The project's name. It is unique in the organization, and it is how apply finds a project that already exists."
	})
	if err := run([]string{"-out", "-"}, &stdout); err == nil {
		t.Error("run wrote a schema the generator refused")
	}
}
