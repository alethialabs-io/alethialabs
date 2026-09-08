// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

const sample = `project: boutique
cloud:
  account: prod-account
  region: nbg1
iac:
  version: "1.9.0"
environments:
  - name: prod
    stage: production
    components:
      cluster:
        node_min_size: 2
        node_max_size: 3
  - name: dev-1
    stage: development
    namespace: boutique-dev-1
    components:
      repositories:
        apps_destination_repo: https://github.com/alethialabs-io/alethia-examples
        apps_path: examples/online-boutique/overlays/dev-1
      databases:
        - name: orders
          engine: postgres
        - name: carts
          engine: postgres
`

func testRules() Rules {
	return Rules{
		Stages:     []string{"development", "staging", "production"},
		Placements: []string{"namespace", "vcluster", "dedicated"},
		Lifecycles: []string{"persistent", "ephemeral"},
		Schema:     testSchema(),
	}
}

func testSchema() *api.ComponentSchemaDocument {
	return &api.ComponentSchemaDocument{
		Version: "v1",
		Kinds: []api.ComponentSchemaKind{
			{Kind: "cluster", Singleton: true, Fields: []string{"cluster_version", "node_min_size", "node_max_size"}},
			{Kind: "repositories", Singleton: true, Fields: []string{"apps_destination_repo", "apps_path"}},
			{Kind: "databases", Singleton: false, Fields: []string{"engine", "engine_version"}},
		},
	}
}

func mustParse(t *testing.T, src string) *Manifest {
	t.Helper()
	m, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	m.Normalize()
	return m
}

func TestParse_ReadsTheWholeShape(t *testing.T) {
	m := mustParse(t, sample)
	if m.Project != "boutique" || m.Cloud.Account != "prod-account" || m.Cloud.Region != "nbg1" || m.IaC.Version != "1.9.0" {
		t.Fatalf("scalars: %+v", m)
	}
	if len(m.Environments) != 2 {
		t.Fatalf("environments: %+v", m.Environments)
	}
	prod, dev := m.Environments[0], m.Environments[1]
	// Position fills the placement: the first owns the Fabric, the rest share it.
	if prod.Placement != "dedicated" || dev.Placement != "namespace" {
		t.Errorf("placement defaults: prod=%q dev=%q", prod.Placement, dev.Placement)
	}
	cluster, ok := prod.Components.Kind("cluster")
	if !ok || cluster.List || len(cluster.Entries) != 1 {
		t.Fatalf("cluster: ok=%v %+v", ok, cluster)
	}
	if got := cluster.Entries[0].Fields["node_max_size"]; got != 3 {
		t.Errorf("yaml keeps scalar types: node_max_size=%v (%T)", got, got)
	}
	dbs, ok := dev.Components.Kind("databases")
	if !ok || !dbs.List || len(dbs.Entries) != 2 || dbs.Entries[0].Name != "orders" || dbs.Entries[1].Name != "carts" {
		t.Fatalf("databases: ok=%v %+v", ok, dbs)
	}
	if _, leaked := dbs.Entries[0].Fields["name"]; leaked {
		t.Error("the entry's name is its identity, not a settable field, and must not be sent as one")
	}
	// Kind order is file order, so a refusal can point at the entry the person wrote.
	if dev.Components[0].Kind != "repositories" || dev.Components[1].Kind != "databases" {
		t.Errorf("kind order lost: %+v", dev.Components)
	}
	if err := m.Validate(testRules()); err != nil {
		t.Fatalf("the sample must validate: %v", err)
	}
}

func TestParse_RefusesAnUnknownKey(t *testing.T) {
	_, err := Parse([]byte("project: x\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    placment: dedicated\n"))
	if err == nil || !strings.Contains(err.Error(), "placment") {
		t.Fatalf("a misspelt key must be refused by name, got: %v", err)
	}
}

func TestParse_ABareSingletonKeyDeclaresIt(t *testing.T) {
	m := mustParse(t, "project: x\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    components:\n      repositories:\n")
	k, ok := m.Environments[0].Components.Kind("repositories")
	if !ok || k.List || len(k.Entries) != 1 || len(k.Entries[0].Fields) != 0 {
		t.Fatalf("a bare key must declare the singleton with no fields: ok=%v %+v", ok, k)
	}
}

func TestParse_RefusesTheWrongComponentShapes(t *testing.T) {
	cases := map[string]string{
		"a scalar under a kind": "components:\n      cluster: big\n",
		"a scalar list entry":   "components:\n      databases:\n        - orders\n",
		"a kind twice":          "components:\n      cluster:\n        node_min_size: 1\n      cluster:\n        node_min_size: 2\n",
		"components as a list":  "components:\n      - cluster\n",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			src := "project: x\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    " + body
			if _, err := Parse([]byte(src)); err == nil {
				t.Fatalf("parsed:\n%s", src)
			}
		})
	}
}

func TestNormalize_DropsANamespaceADedicatedEnvironmentCannotUse(t *testing.T) {
	m := mustParse(t, "project: x\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    namespace: leaked\n")
	if m.Environments[0].Namespace != "" {
		t.Errorf("namespace survived on a dedicated environment: %+v", m.Environments[0])
	}
}

func TestValidate_NamesEveryProblemAtOnce(t *testing.T) {
	m := mustParse(t, `project: ""
cloud:
  region: ""
environments:
  - name: prod
    stage: prod
    placement: huge
    components:
      cluster:
        - name: a
  - name: Prod
    stage: production
    placement: namespace
    namespace: Bad_NS
    lifecycle: forever
    components:
      warehouses:
        - name: x
      databases:
        engine: postgres
      repositories:
        apps_path: p
        colour: red
`)
	err := m.Validate(testRules())
	if err == nil {
		t.Fatal("validated")
	}
	msg := err.Error()
	for _, want := range []string{
		"`project` is required",
		"`cloud.region` is required",
		"stage \"prod\" is not one of",
		"placement \"huge\" is not one of",
		"one per environment",       // cluster written as a list
		"is also environments[0]'s", // Prod normalises to prod
		"namespace \"Bad_NS\"",
		"lifecycle \"forever\"",
		"unknown component kind",
		"databases components are named",
		"does not take colour",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("missing %q in:\n%s", want, msg)
		}
	}
	if n := strings.Count(msg, "\n  - "); n < 11 {
		t.Errorf("expected every problem listed, got %d lines:\n%s", n, msg)
	}
}

func TestValidate_ListEntriesNeedNames(t *testing.T) {
	m := mustParse(t, "project: x\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    components:\n      databases:\n        - engine: postgres\n        - name: a\n        - name: a\n")
	err := m.Validate(testRules())
	if err == nil {
		t.Fatal("validated")
	}
	if !strings.Contains(err.Error(), "needs a `name`") || !strings.Contains(err.Error(), "used twice") {
		t.Errorf("unexpected: %v", err)
	}
}

// Without a schema the CLI cannot know the kinds, and "could not check" must not become
// "refused": only the shape rules that hold for every kind still apply.
func TestValidate_NoSchemaChecksShapeOnly(t *testing.T) {
	rules := testRules()
	rules.Schema = nil
	m := mustParse(t, "project: x\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n    components:\n      anything:\n        whatever: 1\n      things:\n        - engine: x\n")
	err := m.Validate(rules)
	if err == nil || strings.Contains(err.Error(), "unknown component kind") || !strings.Contains(err.Error(), "needs a `name`") {
		t.Fatalf("unexpected: %v", err)
	}
}

func TestValidate_SingleProblemHasNoHeading(t *testing.T) {
	m := mustParse(t, "project: x\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: nonsense\n    placement: namespace\n")
	err := m.Validate(testRules())
	if err == nil || strings.Contains(err.Error(), "problems:") {
		t.Fatalf("one problem must read as one line: %v", err)
	}
}

// The "one environment must be dedicated" rule is the SERVER's, and the server applies it
// conditionally — only where a matrix brings a project's first Fabric into being. So it is not a
// Validate finding at all: it is a question the caller asks once it knows whether the project
// exists. Refusing it unconditionally rejected `dev-1: namespace` added to a project whose prod
// environment was created in the console, which is precisely what a manifest is for.
func TestNeedsADedicatedEnvironment(t *testing.T) {
	shared := mustParse(t, "project: x\ncloud:\n  region: r\nenvironments:\n  - name: dev\n    stage: development\n    placement: namespace\n")
	if !shared.NeedsADedicatedEnvironment() {
		t.Error("a matrix of only shared placements needs one that owns the Fabric")
	}
	// And it is NOT a Validate problem, so a file adding an environment to an existing project
	// passes the reader and is decided by the caller.
	if err := shared.Validate(testRules()); err != nil {
		t.Errorf("Validate refused a shared-only matrix: %v", err)
	}
	owned := mustParse(t, sample)
	if owned.NeedsADedicatedEnvironment() {
		t.Error("the sample's first environment is dedicated")
	}
	var empty Manifest
	if empty.NeedsADedicatedEnvironment() {
		t.Error("a manifest with no environments needs nothing; `environments` being required is Validate's finding")
	}
}

func TestDeclaresComponents(t *testing.T) {
	if !mustParse(t, sample).DeclaresComponents() {
		t.Error("the sample declares components")
	}
	bare := mustParse(t, "project: x\ncloud:\n  region: r\nenvironments:\n  - name: prod\n    stage: production\n")
	if bare.DeclaresComponents() {
		t.Error("a file with no components must not make the caller fetch the schema")
	}
}

func TestEnvironmentSpecs_RoundTrip(t *testing.T) {
	m := mustParse(t, sample)
	specs := m.EnvironmentSpecs()
	if len(specs) != 2 || !specs[0].IsDefault || specs[1].IsDefault {
		t.Fatalf("the first environment is the default: %+v", specs)
	}
	if specs[1].PlacementMode != "namespace" || specs[1].Namespace != "boutique-dev-1" {
		t.Errorf("placement not carried: %+v", specs[1])
	}
	back := FromEnvironmentSpecs(specs)
	for i := range back {
		if back[i].Name != m.Environments[i].Name || back[i].Placement != m.Environments[i].Placement || back[i].Namespace != m.Environments[i].Namespace {
			t.Errorf("round trip lost a field: %+v vs %+v", back[i], m.Environments[i])
		}
	}
}

func TestLookup_AnswersEveryScalarKey(t *testing.T) {
	m := mustParse(t, sample)
	want := map[string]string{
		"project": "boutique", "cloud.account": "prod-account", "cloud.region": "nbg1",
		"iac.version": "1.9.0", "stage": "production", "placement": "dedicated",
	}
	for _, key := range ScalarKeys() {
		got, ok := m.Lookup(key)
		if !ok || got != want[key] {
			t.Errorf("Lookup(%q) = %q, %v; want %q", key, got, ok, want[key])
		}
	}
	if _, ok := m.Lookup("environments"); ok {
		t.Error("a non-scalar key must not resolve")
	}
	var empty Manifest
	if _, ok := empty.Lookup("stage"); ok {
		t.Error("a manifest with no environments has no default stage")
	}
	var nilM *Manifest
	if _, ok := nilM.Lookup("project"); ok {
		t.Error("a nil manifest resolves nothing")
	}
}

func TestRenderAndWrite_RoundTrip(t *testing.T) {
	m := mustParse(t, sample)
	out, err := Render(m)
	if err != nil {
		t.Fatal(err)
	}
	again, err := Parse(out)
	if err != nil {
		t.Fatalf("rendered manifest does not parse:\n%s\n%v", out, err)
	}
	again.Normalize()
	if again.Project != m.Project || len(again.Environments) != 2 {
		t.Fatalf("round trip: %+v", again)
	}
	dbs, _ := again.Environments[1].Components.Kind("databases")
	if !dbs.List || len(dbs.Entries) != 2 || dbs.Entries[1].Name != "carts" || dbs.Entries[1].Fields["engine"] != "postgres" {
		t.Errorf("list round trip: %+v", dbs)
	}
	if !strings.Contains(string(out), "project: boutique") || strings.Contains(string(out), "lifecycle") {
		t.Errorf("render shape:\n%s", out)
	}

	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	if err := Write(path, m, false); err != nil {
		t.Fatal(err)
	}
	if err := Write(path, m, false); err == nil {
		t.Error("overwrote an existing manifest without --force")
	}
	if err := Write(path, m, true); err != nil {
		t.Errorf("--force overwrite: %v", err)
	}
	found, ok := Find(dir)
	if !ok || found != path {
		t.Errorf("Find: %q %v", found, ok)
	}
	if _, ok := Find(filepath.Join(dir, "sub")); ok {
		t.Error("Find looked somewhere other than the directory given")
	}
	loaded, err := Load(path)
	if err != nil || loaded.Project != "boutique" {
		t.Errorf("Load: %+v %v", loaded, err)
	}
	if _, err := Load(filepath.Join(dir, "missing.yaml")); !os.IsNotExist(err) {
		t.Errorf("a missing file must report as such: %v", err)
	}
	if err := os.WriteFile(path, []byte("project: [\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), path) {
		t.Errorf("a broken file must be reported by path: %v", err)
	}
}

// ── aliases ───────────────────────────────────────────────────────────────────────────────
//
// Both forms, because the first implementation caught only the second and claimed both. The
// MERGE KEY is the one a person actually writes: the whole-value alias makes dev's cluster
// identical to prod's, including the field they wanted to change, so nobody wants it.

func TestParse_RefusesAMergeKey(t *testing.T) {
	_, err := Parse([]byte(`project: boutique
cloud:
  region: nbg1
environments:
  - name: prod
    stage: production
    components:
      cluster: &base
        node_min_size: 5
  - name: dev
    stage: development
    components:
      cluster:
        <<: *base
        node_min_size: 1
`))
	if err == nil {
		t.Fatal("a merge key resolved silently — this is the cross-environment dependency the refusal is for")
	}
	for _, want := range []string{"*base", "line 14", "defined on line 8", "write the fields out"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not say %q:\n%v", want, err)
		}
	}
}

func TestParse_RefusesAWholeValueAlias(t *testing.T) {
	_, err := Parse([]byte(`project: boutique
cloud:
  region: nbg1
environments:
  - name: prod
    stage: production
    components:
      cluster: &base
        node_min_size: 5
  - name: dev
    stage: development
    components:
      cluster: *base
`))
	if err == nil || !strings.Contains(err.Error(), "*base") {
		t.Fatalf("a whole-value alias was accepted: %v", err)
	}
}

// Outside `components` too — `project`, `cloud` and the environment scalars had no arm at all.
func TestParse_RefusesAnAliasOutsideComponents(t *testing.T) {
	_, err := Parse([]byte(`project: &name boutique
cloud:
  region: nbg1
environments:
  - name: *name
    stage: production
`))
	if err == nil || !strings.Contains(err.Error(), "*name") {
		t.Fatalf("an alias in an environment name was accepted: %v", err)
	}
}

// The control. Without it, a refusal that fired on every document would pass all three tests
// above while making the reader useless.
func TestParse_AnAnchorWithNoAliasIsNotRefused(t *testing.T) {
	// An anchor is only a definition; nothing resolves until something refers to it. Refusing
	// the definition would reject a document that means exactly what it says.
	m, err := Parse([]byte("project: &unused boutique\ncloud:\n  region: nbg1\nenvironments:\n  - name: prod\n    stage: production\n"))
	if err != nil {
		t.Fatalf("an unused anchor was refused: %v", err)
	}
	if m.Project != "boutique" {
		t.Errorf("the anchored scalar did not decode: %+v", m)
	}
	// And the ordinary sample, which has neither, still parses.
	if _, err := Parse([]byte(sample)); err != nil {
		t.Fatalf("the sample manifest was refused: %v", err)
	}
}

// A document that does not parse is the strict decoder's error to report, with its own message.
// The alias pass must not swallow it or replace it.
func TestParse_ABrokenDocumentKeepsItsOwnError(t *testing.T) {
	_, err := Parse([]byte("project: [\n"))
	if err == nil {
		t.Fatal("a malformed document parsed")
	}
	if strings.Contains(err.Error(), "alias") {
		t.Errorf("the alias pass reported a syntax error as an alias problem: %v", err)
	}
}

// Exists takes a FILE and Find takes a DIRECTORY. Confusing them is silent in the direction that
// matters: `Find("alethia.yaml")` asks about `alethia.yaml/alethia.yaml`, which never exists, so a
// caller checking "is there already a manifest here?" would answer no and overwrite one.
func TestExistsAndFindAnswerDifferentQuestions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	if Exists(path) {
		t.Error("Exists is true before anything is written")
	}
	if err := os.WriteFile(path, []byte(sample), 0o644); err != nil {
		t.Fatal(err)
	}
	if !Exists(path) {
		t.Error("Exists is false for a file that is there")
	}
	if Exists(dir) {
		t.Error("Exists is true for a DIRECTORY, so a directory named alethia.yaml would read as a manifest")
	}
	if found, ok := Find(dir); !ok || found != path {
		t.Errorf("Find(dir) = %q %v", found, ok)
	}
	// The confusion itself, pinned: Find over a FILE path finds nothing.
	if _, ok := Find(path); ok {
		t.Error("Find accepted a file path — the two helpers have become interchangeable")
	}
}
