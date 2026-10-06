// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/zclconf/go-cty/cty"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The node-pool contract (#5533, epic #5523): node_labels, node_taints and extra_node_pools, said the
// same way on every cloud. The RULES live in ONE place, testdata/nodepool/reference/variables.tf, and
// its cases in testdata/nodepool/reference/nodepool_contract.tftest.hcl. Read the comments there for
// what each rule is and why; this file only holds a cloud to them.
//
// assertNodePoolContract is the helper every cloud lane calls from its own nodepool_<cloud>_test.go
// (#5534 aws, #5535 azure, #5536 hetzner, #5537 gcp), so the lanes never share a file. It is defined
// in a _test.go file on purpose: that keeps `testing` and the HCL parser out of production code, and
// is still visible to every test file of package cloud. Nothing here runs it against a real cloud;
// until a lane lands, its cloud does not declare the variables, and that is not a failure of this unit.
//
// What it checks, and the boundary of each check:
//
//  1. DECLARED — infra/templates/project/<cloud>/variables.tf declares the three variables with a
//     `type`, `default` and `nullable` token-equal to the reference (whitespace and comments do not
//     count), and carries EVERY reference `validation` block, condition and error_message both. A lane
//     may add validations and rewrite descriptions; it may not drop or weaken a rule. Token equality
//     is the boundary: a validation rewritten into an equivalent but different expression is reported
//     as missing, which is the safe direction — the reference is copied, not re-derived.
//  2. PROVEN — infra/templates/project/<cloud>/nodepool_contract.tftest.hcl carries every reference
//     run under its name, with the same contract-variable VALUES (evaluated, so layout does not count)
//     and the same expect_failures. That is what turns "the validation is written" into "the validation
//     refuses", on that cloud's real template: a text check cannot prove a rule rejects anything, the
//     lane's `tofu test` run does (.github/workflows/infra-templates.yml runs it). The one allowed
//     difference is a pool's instance_type; the reference tftest's header says why and how far.
//  3. REACHABLE — a value in the Cluster component's provider_config arrives at the same-named tfvar
//     unchanged (the passthrough is generic, so this fails only if a provider reserves the key or
//     overwrites it), and a cluster that sets none of them gets none of them as tfvars, which is the
//     Go half of "defaults render byte-identically". The template half is each lane's own plan test.
//  4. SETTABLE — the generated template-knobs.json files each variable under the cloud's `cluster`
//     component as an offerable knob: that is the one definition the canvas card and the CLI /
//     alethia.yaml write boundary (#5529) both read, so a knob that fails this cannot be set by a user
//     even though the template would accept it.

// nodePoolContractVars are the three cloud-neutral root variables the contract fixes.
var nodePoolContractVars = []string{"node_labels", "node_taints", "extra_node_pools"}

// nodePoolReferenceDir is the reference module, relative to the repo root.
const nodePoolReferenceDir = "packages/core/cloud/testdata/nodepool/reference"

// nodePoolTestFile is the name every lane gives its contract tftest, beside its variables.tf.
const nodePoolTestFile = "nodepool_contract.tftest.hcl"

// nodePoolInstanceTypePattern is the contract's instance_type grammar (reference variables.tf). It
// bounds the one substitution a lane's tftest may make.
var nodePoolInstanceTypePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// nodePoolProviders maps each cloud that carries the contract to its provider. Alibaba is excluded
// from epic #5523.
var nodePoolProviders = map[string]CloudProvider{
	"aws":     &awsProvider{},
	"azure":   &azureProvider{},
	"gcp":     &gcpProvider{},
	"hetzner": &hetznerProvider{},
}

// nodePoolSubject is one thing held to the contract: a cloud's template files, the knobs manifest
// and the provider that builds its tfvars. A real cloud and a fixture are both subjects.
type nodePoolSubject struct {
	cloud       string
	variablesTF string
	tftest      string
	knobsJSON   string
	provider    CloudProvider
}

// assertNodePoolContract fails t once per way the cloud's template breaks the node-pool contract.
// Each cloud lane calls it from its own nodepool_<cloud>_test.go.
func assertNodePoolContract(t *testing.T, cloud string) {
	t.Helper()
	provider, ok := nodePoolProviders[cloud]
	if !ok {
		t.Fatalf("assertNodePoolContract: %q is not a cloud of the node-pool contract (aws, azure, gcp, hetzner)", cloud)
	}
	root := templateRepoRoot(t)
	dir := filepath.Join(root, "infra", "templates", "project", cloud)
	subject := nodePoolSubject{
		cloud:       cloud,
		variablesTF: filepath.Join(dir, "variables.tf"),
		tftest:      filepath.Join(dir, nodePoolTestFile),
		knobsJSON:   filepath.Join(root, "apps", "console", "lib", "cloud-providers", "generated", "template-knobs.json"),
		provider:    provider,
	}
	for _, v := range nodePoolContractViolations(filepath.Join(root, filepath.FromSlash(nodePoolReferenceDir)), subject) {
		t.Errorf("%s: %s", cloud, v)
	}
}

// nodePoolContractViolations returns every way subject breaks the contract in refDir, one sentence
// each; none means it conforms.
func nodePoolContractViolations(refDir string, s nodePoolSubject) []string {
	var out []string
	out = append(out, nodePoolDeclarationViolations(filepath.Join(refDir, "variables.tf"), s.variablesTF)...)
	out = append(out, nodePoolTestViolations(filepath.Join(refDir, nodePoolTestFile), s.tftest)...)
	out = append(out, nodePoolReachabilityViolations(s.provider)...)
	out = append(out, nodePoolKnobViolations(s.knobsJSON, s.cloud)...)
	return out
}

// ── parsing ──────────────────────────────────────────────────────────────────────────────────────

// parseHCLFile reads and parses one native-syntax HCL file.
func parseHCLFile(path string) (*hclsyntax.Body, []byte, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	f, diags := hclsyntax.ParseConfig(src, path, hcl.InitialPos)
	if diags.HasErrors() {
		return nil, nil, diags
	}
	body, ok := f.Body.(*hclsyntax.Body)
	if !ok {
		return nil, nil, fmt.Errorf("%s: not native HCL syntax", path)
	}
	return body, src, nil
}

// exprTokens renders an expression as its token sequence with newlines and comments dropped, so two
// expressions compare equal exactly when they differ only in layout.
func exprTokens(src []byte, expr hclsyntax.Expression) string {
	rng := expr.Range()
	toks, _ := hclsyntax.LexExpression(rng.SliceBytes(src), rng.Filename, rng.Start)
	var b strings.Builder
	for _, tk := range toks {
		switch tk.Type {
		case hclsyntax.TokenNewline, hclsyntax.TokenComment, hclsyntax.TokenEOF:
			continue
		}
		b.Write(tk.Bytes)
		b.WriteByte(' ')
	}
	return strings.TrimSpace(b.String())
}

// tfVariable is a `variable` block reduced to what the contract compares.
type tfVariable struct {
	attrs       map[string]string // type, default, nullable → their token sequences
	validations []string          // each validation block's condition and error_message tokens
}

// parseVariables returns the `variable` blocks of a variables.tf by name.
func parseVariables(path string) (map[string]tfVariable, error) {
	body, src, err := parseHCLFile(path)
	if err != nil {
		return nil, err
	}
	vars := map[string]tfVariable{}
	for _, blk := range body.Blocks {
		if blk.Type != "variable" || len(blk.Labels) != 1 {
			continue
		}
		v := tfVariable{attrs: map[string]string{}}
		for _, name := range []string{"type", "default", "nullable"} {
			if a, ok := blk.Body.Attributes[name]; ok {
				v.attrs[name] = exprTokens(src, a.Expr)
			}
		}
		for _, vb := range blk.Body.Blocks {
			if vb.Type != "validation" {
				continue
			}
			var parts []string
			for _, name := range []string{"condition", "error_message"} {
				if a, ok := vb.Body.Attributes[name]; ok {
					parts = append(parts, exprTokens(src, a.Expr))
				}
			}
			v.validations = append(v.validations, strings.Join(parts, " ⟂ "))
		}
		vars[blk.Labels[0]] = v
	}
	return vars, nil
}

// tfRun is a tftest `run` block reduced to what the contract compares.
type tfRun struct {
	vars           map[string]any // contract variable → its evaluated value
	expectFailures string         // token sequence, "" when absent
}

// tfTest is a parsed .tftest.hcl: its runs by name, in file order, and the contract variables it
// sets at file level.
type tfTest struct {
	runs     map[string]tfRun
	order    []string
	fileVars []string
}

// parseTFTest parses a .tftest.hcl, evaluating the contract variables each run sets.
func parseTFTest(path string) (tfTest, error) {
	body, src, err := parseHCLFile(path)
	if err != nil {
		return tfTest{}, err
	}
	tt := tfTest{runs: map[string]tfRun{}}
	for _, blk := range body.Blocks {
		switch {
		case blk.Type == "variables":
			for _, name := range nodePoolContractVars {
				if _, ok := blk.Body.Attributes[name]; ok {
					tt.fileVars = append(tt.fileVars, name)
				}
			}
		case blk.Type == "run" && len(blk.Labels) == 1:
			r := tfRun{vars: map[string]any{}}
			if a, ok := blk.Body.Attributes["expect_failures"]; ok {
				r.expectFailures = exprTokens(src, a.Expr)
			}
			for _, vb := range blk.Body.Blocks {
				if vb.Type != "variables" {
					continue
				}
				for _, name := range nodePoolContractVars {
					a, ok := vb.Body.Attributes[name]
					if !ok {
						continue
					}
					val, diags := a.Expr.Value(nil)
					if diags.HasErrors() {
						return tfTest{}, fmt.Errorf("%s: run %q: %s is not a literal value: %s", path, blk.Labels[0], name, diags.Error())
					}
					r.vars[name] = ctyToGo(val)
				}
			}
			tt.runs[blk.Labels[0]] = r
			tt.order = append(tt.order, blk.Labels[0])
		}
	}
	return tt, nil
}

// ctyToGo converts a literal cty value to plain Go values (numbers as exact decimal strings) so two
// values compare with reflect.DeepEqual.
func ctyToGo(v cty.Value) any {
	if v.IsNull() {
		return nil
	}
	ty := v.Type()
	switch {
	case ty == cty.String:
		return v.AsString()
	case ty == cty.Number:
		return v.AsBigFloat().Text('g', -1)
	case ty == cty.Bool:
		return v.True()
	case ty.IsListType() || ty.IsTupleType() || ty.IsSetType():
		out := []any{}
		for it := v.ElementIterator(); it.Next(); {
			_, e := it.Element()
			out = append(out, ctyToGo(e))
		}
		return out
	case ty.IsMapType() || ty.IsObjectType():
		out := map[string]any{}
		for it := v.ElementIterator(); it.Next(); {
			k, e := it.Element()
			out[k.AsString()] = ctyToGo(e)
		}
		return out
	}
	return v.GoString()
}

// ── 1. declared ──────────────────────────────────────────────────────────────────────────────────

// nodePoolDeclarationViolations compares the subject's three variable blocks to the reference's.
func nodePoolDeclarationViolations(refPath, subjectPath string) []string {
	ref, err := parseVariables(refPath)
	if err != nil {
		return []string{fmt.Sprintf("cannot read the reference variables: %v", err)}
	}
	got, err := parseVariables(subjectPath)
	if err != nil {
		return []string{fmt.Sprintf("cannot read %s: %v", subjectPath, err)}
	}
	var out []string
	for _, name := range nodePoolContractVars {
		want := ref[name]
		have, ok := got[name]
		if !ok {
			out = append(out, fmt.Sprintf("%s declares no variable %q: copy it from %s/variables.tf", subjectPath, name, nodePoolReferenceDir))
			continue
		}
		for _, attr := range []string{"type", "default", "nullable"} {
			if have.attrs[attr] != want.attrs[attr] {
				out = append(out, fmt.Sprintf("variable %q has %s `%s`, the contract says `%s`: one shape on every cloud, or a file stops being portable", name, attr, have.attrs[attr], want.attrs[attr]))
			}
		}
		present := map[string]bool{}
		for _, v := range have.validations {
			present[v] = true
		}
		for i, v := range want.validations {
			if !present[v] {
				out = append(out, fmt.Sprintf("variable %q is missing the contract's validation #%d (or carries a changed copy of it); a lane may add validations but must keep every reference validation verbatim: %.160s…", name, i+1, v))
			}
		}
	}
	return out
}

// ── 2. proven ────────────────────────────────────────────────────────────────────────────────────

// nodePoolTestViolations compares the subject's contract tftest to the reference cases.
func nodePoolTestViolations(refPath, subjectPath string) []string {
	ref, err := parseTFTest(refPath)
	if err != nil {
		return []string{fmt.Sprintf("cannot read the reference cases: %v", err)}
	}
	if _, err := os.Stat(subjectPath); errors.Is(err, os.ErrNotExist) {
		return []string{fmt.Sprintf("%s does not exist: every lane proves the contract's %d cases in its own tofu test, starting from a copy of %s/%s", subjectPath, len(ref.order), nodePoolReferenceDir, nodePoolTestFile)}
	}
	got, err := parseTFTest(subjectPath)
	if err != nil {
		return []string{fmt.Sprintf("cannot read %s: %v", subjectPath, err)}
	}
	var out []string
	for _, name := range got.fileVars {
		out = append(out, fmt.Sprintf("%s sets %s at file level, which changes every case that leaves it unset: set it inside a run", subjectPath, name))
	}
	for _, name := range ref.order {
		want := ref.runs[name]
		have, ok := got.runs[name]
		if !ok {
			out = append(out, fmt.Sprintf("%s has no run %q: a lane carries every contract case", subjectPath, name))
			continue
		}
		if have.expectFailures != want.expectFailures {
			out = append(out, fmt.Sprintf("run %q expects failures `%s`, the contract case expects `%s`", name, have.expectFailures, want.expectFailures))
		}
		for _, v := range nodePoolContractVars {
			w, inRef := want.vars[v]
			h, inGot := have.vars[v]
			switch {
			case !inRef && inGot:
				out = append(out, fmt.Sprintf("run %q sets %s, which the contract case leaves at its default", name, v))
			case inRef && !inGot:
				out = append(out, fmt.Sprintf("run %q does not set %s, which the contract case sets", name, v))
			case inRef:
				if msg := compareCaseValue(v, w, h); msg != "" {
					out = append(out, fmt.Sprintf("run %q: %s", name, msg))
				}
			}
		}
	}
	return out
}

// compareCaseValue compares one contract variable's value in a lane's run with the reference case,
// allowing the one substitution the contract permits: a pool's grammar-valid instance_type replaced
// by another grammar-valid one. It returns "" when they agree.
func compareCaseValue(name string, want, have any) string {
	if name == "extra_node_pools" {
		wl, wok := want.([]any)
		hl, hok := have.([]any)
		if wok && hok && len(wl) == len(hl) {
			wl, hl = append([]any{}, wl...), append([]any{}, hl...)
			for i := range wl {
				wp, wpok := wl[i].(map[string]any)
				hp, hpok := hl[i].(map[string]any)
				if !wpok || !hpok {
					continue
				}
				wt, _ := wp["instance_type"].(string)
				ht, _ := hp["instance_type"].(string)
				if wt == ht || !nodePoolInstanceTypePattern.MatchString(wt) {
					continue
				}
				if !nodePoolInstanceTypePattern.MatchString(ht) {
					return fmt.Sprintf("pool %d substitutes instance_type %q, which breaks the contract's instance_type grammar, so the case would fail for the wrong reason", i, ht)
				}
				wl[i], hl[i] = withoutKey(wp, "instance_type"), withoutKey(hp, "instance_type")
			}
			want, have = wl, hl
		}
	}
	if !reflect.DeepEqual(want, have) {
		w, _ := json.Marshal(want)
		h, _ := json.Marshal(have)
		return fmt.Sprintf("%s is %s, the contract case sets %s", name, h, w)
	}
	return ""
}

// withoutKey returns a copy of m without key.
func withoutKey(m map[string]any, key string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		if k != key {
			out[k] = v
		}
	}
	return out
}

// ── 3. reachable ─────────────────────────────────────────────────────────────────────────────────

// nodePoolSampleConfig is a structured value per contract variable, shaped as the console stores a
// provider_config JSON value (numbers as float64).
func nodePoolSampleConfig() map[string]any {
	return map[string]any{
		"node_labels": map[string]any{"team": "payments"},
		"node_taints": []any{map[string]any{"key": "dedicated", "value": "batch", "effect": "NoSchedule"}},
		"extra_node_pools": []any{map[string]any{
			"name": "batch", "instance_type": "m7g.large", "min_size": float64(1), "max_size": float64(4), "arch": "arm64",
		}},
	}
}

// nodePoolReachabilityViolations checks that each contract variable rides the Cluster component's
// provider_config to its tfvar unchanged, and that a cluster setting none of them emits none.
func nodePoolReachabilityViolations(provider CloudProvider) []string {
	var out []string
	cfg := &types.ProjectConfig{ProjectName: "p", Cluster: types.ProjectClusterConfig{ProviderConfig: nodePoolSampleConfig()}}
	tf := provider.ProviderTfvars(cfg)
	want := nodePoolSampleConfig()
	for _, name := range nodePoolContractVars {
		if !reflect.DeepEqual(tf[name], want[name]) {
			out = append(out, fmt.Sprintf("the Cluster component's provider_config[%q] does not reach the %s tfvar unchanged (got %v): the provider reserves or overwrites the key, so a user cannot set it", name, name, tf[name]))
		}
	}
	bare := provider.ProviderTfvars(&types.ProjectConfig{ProjectName: "p"})
	for _, name := range nodePoolContractVars {
		if v, ok := bare[name]; ok {
			out = append(out, fmt.Sprintf("a cluster that sets nothing gets a %s tfvar (%v): the default must be the template's own, so the render stays byte-identical", name, v))
		}
	}
	return out
}

// ── 4. settable ──────────────────────────────────────────────────────────────────────────────────

// nodePoolKnob is the part of a template-knobs.json entry that decides whether a user may set it
// (apps/console/lib/cloud-providers/template-knobs.ts, offerableKnobs).
type nodePoolKnob struct {
	Cloud            string   `json:"cloud"`
	Component        string   `json:"component"`
	Name             string   `json:"name"`
	ReadBy           []string `json:"readBy"`
	ReportedByOutput bool     `json:"reportedByOutput"`
	Reachable        bool     `json:"reachable"`
	Ceiling          bool     `json:"ceiling"`
	OwnedByProvider  bool     `json:"ownedByProvider"`
	Typed            bool     `json:"typed"`
}

// nodePoolKnobViolations checks the knobs manifest offers each contract variable on the cloud's
// cluster card, with offerableKnobs' own five filters.
func nodePoolKnobViolations(path, cloud string) []string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return []string{fmt.Sprintf("cannot read %s: %v", path, err)}
	}
	var manifest struct {
		Knobs []nodePoolKnob `json:"knobs"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return []string{fmt.Sprintf("cannot parse %s: %v", path, err)}
	}
	regen := "regenerate it with `pnpm -C apps/console gen:template-knobs`"
	var out []string
	for _, name := range nodePoolContractVars {
		var k *nodePoolKnob
		for i := range manifest.Knobs {
			if manifest.Knobs[i].Cloud == cloud && manifest.Knobs[i].Name == name {
				k = &manifest.Knobs[i]
			}
		}
		var why []string
		switch {
		case k == nil:
			why = append(why, "it is not in the manifest")
		default:
			if k.Component != "cluster" {
				why = append(why, fmt.Sprintf("it is filed under component %q, not cluster", k.Component))
			}
			if !k.Reachable {
				why = append(why, "it is not reachable through provider_config")
			}
			if len(k.ReadBy) == 0 && !k.ReportedByOutput {
				why = append(why, "no resource or module reads it")
			}
			if k.Ceiling {
				why = append(why, "it is marked a ceiling")
			}
			if k.OwnedByProvider {
				why = append(why, "the provider owns it")
			}
			if k.Typed {
				why = append(why, "a typed field sets it")
			}
		}
		if len(why) > 0 {
			out = append(out, fmt.Sprintf("%s is not a settable cluster knob on %s in %s (%s), so neither the canvas nor the CLI can set it; wire it, then %s", name, cloud, path, strings.Join(why, "; "), regen))
		}
	}
	return out
}

// ── the helper's own tests ───────────────────────────────────────────────────────────────────────

// nodePoolFixtureDir is testdata/nodepool, absolute.
func nodePoolFixtureDir(t *testing.T) string {
	t.Helper()
	return filepath.Join(templateRepoRoot(t), "packages", "core", "cloud", "testdata", "nodepool")
}

// conformingSubject is the conforming fixture as a Hetzner-shaped lane.
func conformingSubject(t *testing.T) nodePoolSubject {
	t.Helper()
	dir := filepath.Join(nodePoolFixtureDir(t), "conforming")
	return nodePoolSubject{
		cloud:       "hetzner",
		variablesTF: filepath.Join(dir, "variables.tf"),
		tftest:      filepath.Join(dir, nodePoolTestFile),
		knobsJSON:   filepath.Join(dir, "template-knobs.json"),
		provider:    &hetznerProvider{},
	}
}

// requireViolation fails t unless violations has one containing want.
func requireViolation(t *testing.T, violations []string, want string) {
	t.Helper()
	for _, v := range violations {
		if strings.Contains(v, want) {
			return
		}
	}
	t.Errorf("expected a violation containing %q, got %d:\n  %s", want, len(violations), strings.Join(violations, "\n  "))
}

// writeMutated writes src's content with old replaced by new into a temp file named like src.
func writeMutated(t *testing.T, src, old, replacement string) string {
	t.Helper()
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), old) {
		t.Fatalf("fixture drift: %s no longer contains %q, so this mutation would test nothing", src, old)
	}
	path := filepath.Join(t.TempDir(), filepath.Base(src))
	if err := os.WriteFile(path, []byte(strings.Replace(string(b), old, replacement, 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestNodePoolContract_ConformingFixturePasses: a lane-shaped file set that keeps every rule (with
// its own descriptions, layout, extra validation, extra run and substituted instance types) is clean.
func TestNodePoolContract_ConformingFixturePasses(t *testing.T) {
	ref := filepath.Join(nodePoolFixtureDir(t), "reference")
	if v := nodePoolContractViolations(ref, conformingSubject(t)); len(v) > 0 {
		t.Errorf("the conforming fixture has %d violations:\n  %s", len(v), strings.Join(v, "\n  "))
	}
}

// TestNodePoolContract_BrokenVariablesFixturesFail: each testdata/nodepool/broken/<rule>/variables.tf
// breaks one rule, and the helper names it. The table and the directory must agree both ways, so a
// fixture without an expectation (or the reverse) fails instead of going untested.
func TestNodePoolContract_BrokenVariablesFixturesFail(t *testing.T) {
	expect := map[string]string{
		"missing_variable":    `declares no variable "node_taints"`,
		"type_drift":          `variable "extra_node_pools" has type`,
		"default_drift":       `variable "node_labels" has default`,
		"nullable_dropped":    `variable "extra_node_pools" has nullable`,
		"validation_dropped":  `variable "node_taints" is missing the contract's validation #3`,
		"validation_weakened": `variable "node_labels" is missing the contract's validation #2`,
	}
	brokenDir := filepath.Join(nodePoolFixtureDir(t), "broken")
	entries, err := os.ReadDir(brokenDir)
	if err != nil {
		t.Fatal(err)
	}
	var found []string
	for _, e := range entries {
		found = append(found, e.Name())
	}
	var want []string
	for k := range expect {
		want = append(want, k)
	}
	sort.Strings(found)
	sort.Strings(want)
	if !reflect.DeepEqual(found, want) {
		t.Fatalf("broken fixtures %v and expectations %v disagree", found, want)
	}
	ref := filepath.Join(nodePoolFixtureDir(t), "reference")
	for name, substr := range expect {
		t.Run(name, func(t *testing.T) {
			s := conformingSubject(t)
			s.variablesTF = filepath.Join(brokenDir, name, "variables.tf")
			requireViolation(t, nodePoolContractViolations(ref, s), substr)
		})
	}
}

// TestNodePoolContract_BrokenLaneTestsFail: a lane's tftest that drops, weakens or re-aims a case is
// caught. Each mutation is one edit to the conforming fixture.
func TestNodePoolContract_BrokenLaneTestsFail(t *testing.T) {
	cases := []struct {
		name, old, replacement, want string
	}{
		{"a run is dropped", `run "nodepool_refuses_the_platform_arch_taint" {`, `run "renamed" {`,
			`has no run "nodepool_refuses_the_platform_arch_taint"`},
		{"a refusal's value is made valid", `key    = "alethia.io/arch"`, `key    = "example.com/arch"`,
			`run "nodepool_refuses_the_platform_arch_taint": node_taints is`},
		{"expect_failures is dropped", "      },\n    ]\n  }\n\n  expect_failures = [var.node_taints]\n}\n\n# alethia.io/arch",
			"      },\n    ]\n  }\n}\n\n# alethia.io/arch", "expects failures ``, the contract case expects"},
		{"a contract variable is set at file level", "variables {\n  worker_count = 3\n}", "variables {\n  worker_count = 3\n  node_labels  = { team = \"x\" }\n}",
			"sets node_labels at file level"},
		{"an instance_type refusal is substituted away", `instance_type = "m7g large"`, `instance_type = "cx32"`,
			`run "nodepool_refuses_an_instance_type_with_a_space": extra_node_pools is`},
		{"a substitution breaks the grammar", "      {\n        name          = \"batch\"\n        instance_type = \"cx32\"\n        min_size      = 5",
			"      {\n        name          = \"batch\"\n        instance_type = \"cx 32\"\n        min_size      = 5", `substitutes instance_type "cx 32"`},
		{"a case sets a variable the reference leaves alone", "run \"nodepool_defaults_plan\" {\n  command = plan\n",
			"run \"nodepool_defaults_plan\" {\n  command = plan\n\n  variables {\n    node_labels = {}\n  }\n", `run "nodepool_defaults_plan" sets node_labels`},
	}
	ref := filepath.Join(nodePoolFixtureDir(t), "reference")
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := conformingSubject(t)
			s.tftest = writeMutated(t, s.tftest, tc.old, tc.replacement)
			requireViolation(t, nodePoolContractViolations(ref, s), tc.want)
		})
	}
	t.Run("the file is missing", func(t *testing.T) {
		s := conformingSubject(t)
		s.tftest = filepath.Join(t.TempDir(), nodePoolTestFile)
		requireViolation(t, nodePoolContractViolations(ref, s), "does not exist")
	})
}

// TestNodePoolContract_UnsettableKnobsFail: a knob the manifest does not offer on the cluster card is
// caught, for each of the filters a lane is likely to trip.
func TestNodePoolContract_UnsettableKnobsFail(t *testing.T) {
	cases := []struct {
		name, old, replacement, want string
	}{
		{"not read by anything", "\"name\": \"node_labels\",\n      \"kind\": \"map\",\n      \"required\": false,\n      \"sensitive\": false,\n      \"declaredAt\": \"infra/templates/project/hetzner/variables.tf:1\",\n      \"readBy\": [\n        \"hetzner\"\n      ]",
			"\"name\": \"node_labels\",\n      \"kind\": \"map\",\n      \"required\": false,\n      \"sensitive\": false,\n      \"declaredAt\": \"infra/templates/project/hetzner/variables.tf:1\",\n      \"readBy\": []",
			"node_labels is not a settable cluster knob on hetzner"},
		{"filed under another component", "\"component\": \"cluster\",\n      \"name\": \"extra_node_pools\"", "\"component\": \"platform\",\n      \"name\": \"extra_node_pools\"",
			`filed under component "platform"`},
		{"absent", "\"name\": \"node_taints\"", "\"name\": \"node_taints_renamed\"", "node_taints is not a settable cluster knob on hetzner"},
	}
	ref := filepath.Join(nodePoolFixtureDir(t), "reference")
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := conformingSubject(t)
			s.knobsJSON = writeMutated(t, s.knobsJSON, tc.old, tc.replacement)
			requireViolation(t, nodePoolContractViolations(ref, s), tc.want)
		})
	}
}

// reservingProvider is a provider whose tfvars drop one key (as a reserved key would) and inject
// another (as a provider-set default would).
type reservingProvider struct {
	CloudProvider
	drop, inject string
}

// ProviderTfvars returns the wrapped provider's tfvars with drop removed and inject set.
func (p reservingProvider) ProviderTfvars(config *types.ProjectConfig) map[string]interface{} {
	tf := p.CloudProvider.ProviderTfvars(config)
	delete(tf, p.drop)
	if p.inject != "" {
		tf[p.inject] = []any{}
	}
	return tf
}

// TestNodePoolContract_UnreachableOrDefaultedFails: a provider that swallows a contract key, or emits
// one the user never set, is caught.
func TestNodePoolContract_UnreachableOrDefaultedFails(t *testing.T) {
	ref := filepath.Join(nodePoolFixtureDir(t), "reference")
	s := conformingSubject(t)
	s.provider = reservingProvider{CloudProvider: &hetznerProvider{}, drop: "node_taints"}
	requireViolation(t, nodePoolContractViolations(ref, s), `provider_config["node_taints"] does not reach`)

	s.provider = reservingProvider{CloudProvider: &hetznerProvider{}, inject: "extra_node_pools"}
	requireViolation(t, nodePoolContractViolations(ref, s), "a cluster that sets nothing gets a extra_node_pools tfvar")
}

// TestNodePoolContract_ReferenceCasesAreWellFormed: every case is named for the contract, a refusal
// expects exactly one variable to fail, an acceptance expects none, and every variable is refused by
// at least one case.
func TestNodePoolContract_ReferenceCasesAreWellFormed(t *testing.T) {
	tt, err := parseTFTest(filepath.Join(nodePoolFixtureDir(t), "reference", nodePoolTestFile))
	if err != nil {
		t.Fatal(err)
	}
	refused := map[string]bool{}
	for _, name := range tt.order {
		r := tt.runs[name]
		if !strings.HasPrefix(name, "nodepool_") {
			t.Errorf("run %q: contract cases are named nodepool_*, so a lane's own runs cannot collide with them", name)
		}
		isRefusal := strings.HasPrefix(name, "nodepool_refuses_")
		switch {
		case isRefusal && !regexp.MustCompile(`^\[ var \. [a-z_]+ \]$`).MatchString(r.expectFailures):
			t.Errorf("run %q is a refusal and must expect exactly one variable to fail, got `%s`", name, r.expectFailures)
		case !isRefusal && r.expectFailures != "":
			t.Errorf("run %q is an acceptance and must expect nothing to fail, got `%s`", name, r.expectFailures)
		}
		if isRefusal {
			refused[strings.TrimSuffix(strings.TrimPrefix(r.expectFailures, "[ var . "), " ]")] = true
		}
	}
	for _, v := range nodePoolContractVars {
		if !refused[v] {
			t.Errorf("no case refuses a value of %s", v)
		}
	}
}

// TestNodePoolContract_ReferenceRunsEveryCase runs `tofu test` on the reference module and on the
// conforming fixture: every refusal must refuse and every acceptance must plan. The Go job in ci.yml
// installs tofu for packages/core, so in CI a missing binary is a failure, not a skip.
func TestNodePoolContract_ReferenceRunsEveryCase(t *testing.T) {
	if _, err := exec.LookPath("tofu"); err != nil {
		if os.Getenv("CI") != "" {
			t.Fatal("tofu is not on PATH in CI: the node-pool contract's cases would go unproven")
		}
		t.Skip("tofu not on PATH — skipping the node-pool contract's tofu test")
	}
	for _, name := range []string{"reference", "conforming"} {
		t.Run(name, func(t *testing.T) {
			src := filepath.Join(nodePoolFixtureDir(t), name)
			tt, err := parseTFTest(filepath.Join(src, nodePoolTestFile))
			if err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			for _, f := range []string{"variables.tf", nodePoolTestFile} {
				b, err := os.ReadFile(filepath.Join(src, f))
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, f), b, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.Command("tofu", "test", "-no-color")
			cmd.Dir = dir
			out, err := cmd.CombinedOutput()
			want := strconv.Itoa(len(tt.order)) + " passed, 0 failed"
			if err != nil || !strings.Contains(string(out), want) {
				t.Fatalf("tofu test in %s: want %q, err=%v\n%s", name, want, err, out)
			}
		})
	}
}
