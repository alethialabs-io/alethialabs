// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The mechanism behind the `Mirrors the Go X` comments in apps/console/types/jsonb.types.ts.
//
// Roughly twenty TypeScript interfaces in that file assert, in prose, that they carry the same
// wire shape as a Go struct in packages/core. Nothing enforced it. A comment cannot fail, so a
// field added on one side and not the other is invisible until a value silently zero-fills in
// production — which is the whole point of these payloads riding jobs.execution_metadata.
//
// Each claim becomes a committed fixture in testdata/jsonb/ plus a three-way lock:
//
//	TS property set  ==  fixture key set  ==  Go json-tag set
//
// Both drift directions are covered, and by construction rather than by a threshold:
//
//   - ADDITIVE drift — one side grew a field. `decodeStrict` runs the fixture through
//     DisallowUnknownFields (recursively, so nested shapes are covered too) and the field-set
//     equality reports the new name.
//   - REMOVAL / RENAME drift — one side still models a field the wire no longer carries. The
//     field-set equality reports it. This is deliberately stronger than re-marshalling the
//     decoded value, which is the idiom in packages/core/api/contract_test.go: re-marshalling
//     cannot see a dropped `omitempty` field, because the dropped field decodes to its zero
//     value and then marshals away again. Comparing the struct TYPE's tag set has no such hole.
//
// Vacuity is the failure mode a fixture test invites — a fixture that decodes to zero fields
// passes every assertion — so on top of the name equality every fixture must populate EVERY
// top-level field: `zeroValuedFields` names any field that decoded to its zero value and the
// test fails on it. That is why several fixtures are internally inconsistent as data (a drift
// posture that is both `in_sync` and has `drifted: 1`, a gitops status that carries both a
// `failed_step` and health). They are SHAPE fixtures. What a real run produces is pinned by the
// producing package's own tests (drift_test.go, gitops_status_test.go, receipt_test.go); what is
// pinned here is that every field crosses the boundary intact.
//
// The mutation test at the bottom proves each lock actually fires, by CALLING the same guard
// functions the locks call — a test that re-implements what it tests tests nothing about it.
//
// packages/core must stay vendorable standalone, so the console half is read through the
// monorepo root (identified by go.work) and skipped when there is no monorepo checkout. Same
// idiom as argocd/apps_path_mirror_test.go and categories/secrets_runtime_read_mirror_test.go.
//
// NOT locked here, stated so the coverage is not overread: `ArgocdHealthStatus` and
// `ArgocdSyncStatus`. Their Go side is ArgoCD's own vocabulary written as bare string literals
// (argocd/health.go), not a declared constant set, so there is nothing on the Go side to compare
// a union against. The FIELDS typed by them are locked; the value vocabulary is not.
package types_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/drift"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// tsMirrorFile is the console file whose `Mirrors the Go X` claims this test enforces,
// relative to the monorepo root.
const tsMirrorFile = "apps/console/types/jsonb.types.ts"

// fixtureDir holds one committed fixture per mirrored shape. The fixtures are hand-written
// (they ARE the declared wire shape, not a dump of a run), so there is no generator to name:
// a failure here is fixed by editing the fixture, the Go struct or the TS interface until the
// three agree.
const fixtureDir = "testdata/jsonb"

// mirrorPair is one `Mirrors the Go X` claim made enforceable: a TypeScript interface, the Go
// struct it claims to mirror, and the committed fixture that is the agreed wire shape.
type mirrorPair struct {
	// TSName is the exported interface name in tsMirrorFile.
	TSName string
	// Fixture is the file name inside fixtureDir.
	Fixture string
	// New returns a fresh pointer to the Go struct, so each check decodes into a clean value.
	New func() any
	// GoName is the Go type as the console comment names it, used only in failure messages.
	GoName string
}

// mirrorPairs is the inventory. Every `Mirrors the Go X` comment in tsMirrorFile appears here,
// together with the nested shapes those claims reach — a lock that stops at the first level of
// nesting is a lock with a hole in it.
func mirrorPairs() []mirrorPair {
	return []mirrorPair{
		// ── argocd ──
		{TSName: "AddOnStatusEntry", GoName: "argocd.AddOnHealth", Fixture: "addon_status_entry.json",
			New: func() any { return new(argocd.AddOnHealth) }},
		{TSName: "SecurityReport", GoName: "argocd.SecurityPosture", Fixture: "security_report.json",
			New: func() any { return new(argocd.SecurityPosture) }},
		{TSName: "GitopsStatusReport", GoName: "argocd.GitopsStatus", Fixture: "gitops_status.json",
			New: func() any { return new(argocd.GitopsStatus) }},
		{TSName: "GitopsServiceHealth", GoName: "argocd.ServiceHealth", Fixture: "gitops_service_health.json",
			New: func() any { return new(argocd.ServiceHealth) }},

		// ── drift ──
		{TSName: "DriftPosture", GoName: "drift.Posture", Fixture: "drift_posture.json",
			New: func() any { return new(drift.Posture) }},
		{TSName: "DriftResource", GoName: "drift.ResourceDrift", Fixture: "drift_resource.json",
			New: func() any { return new(drift.ResourceDrift) }},
		{TSName: "DriftNormalizedResource", GoName: "drift.NormalizedResource", Fixture: "drift_normalized_resource.json",
			New: func() any { return new(drift.NormalizedResource) }},

		// ── verify (the elench gate + its evidence receipt) ──
		{TSName: "VerifyFinding", GoName: "verify.Finding", Fixture: "verify_finding.json",
			New: func() any { return new(verify.Finding) }},
		{TSName: "VerifyControlResult", GoName: "verify.ControlResult", Fixture: "verify_control_result.json",
			New: func() any { return new(verify.ControlResult) }},
		{TSName: "VerifySummary", GoName: "verify.Summary", Fixture: "verify_summary.json",
			New: func() any { return new(verify.Summary) }},
		{TSName: "VerifyReport", GoName: "verify.Report", Fixture: "verify_report.json",
			New: func() any { return new(verify.Report) }},
		{TSName: "RecordedException", GoName: "verify.RecordedException", Fixture: "recorded_exception.json",
			New: func() any { return new(verify.RecordedException) }},
		{TSName: "VerifyOverrideInput", GoName: "verify.Override", Fixture: "verify_override.json",
			New: func() any { return new(verify.Override) }},
		{TSName: "VerifyReceiptBody", GoName: "verify.Receipt", Fixture: "verify_receipt.json",
			New: func() any { return new(verify.Receipt) }},
		{TSName: "SignedReceipt", GoName: "verify.SignedReceipt", Fixture: "signed_receipt.json",
			New: func() any { return new(verify.SignedReceipt) }},
		{TSName: "RekorInclusionProof", GoName: "verify.RekorInclusionProof", Fixture: "rekor_inclusion_proof.json",
			New: func() any { return new(verify.RekorInclusionProof) }},
		{TSName: "RekorAnchor", GoName: "verify.RekorAnchor", Fixture: "rekor_anchor.json",
			New: func() any { return new(verify.RekorAnchor) }},

		// ── packages/core/types (the ANALYZE_REPO digest) ──
		{TSName: "RepoFile", GoName: "types.RepoFile", Fixture: "repo_file.json",
			New: func() any { return new(types.RepoFile) }},
		{TSName: "DetectedService", GoName: "types.DetectedService", Fixture: "detected_service.json",
			New: func() any { return new(types.DetectedService) }},
		{TSName: "RepoDigest", GoName: "types.RepoDigest", Fixture: "repo_digest.json",
			New: func() any { return new(types.RepoDigest) }},
	}
}

// ─────────────────────────── the guards ───────────────────────────
//
// Each is a pure function returning an error rather than a *testing.T assertion, so the
// mutation test at the bottom can invoke the SAME function on a mutated input and check that it
// speaks. Nothing below re-implements anything above it.

// decodeStrict unmarshals data into v with DisallowUnknownFields, which rejects an unknown key
// at every level of the document, not just the top. A non-nil error means the wire carries a
// field the Go type does not model — additive drift.
func decodeStrict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("strict decode: %w", err)
	}
	return nil
}

// fixtureKeys returns the fixture's top-level object keys, sorted. It errors on a non-object
// document rather than returning an empty set, because an empty set would let every field-set
// comparison below pass by having nothing to compare.
func fixtureKeys(data []byte) ([]string, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil, fmt.Errorf("fixture is not a JSON object: %w", err)
	}
	if len(obj) == 0 {
		return nil, fmt.Errorf("fixture decodes to zero keys — a fixture that carries nothing asserts nothing")
	}
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys, nil
}

// goJSONFields returns the JSON key names a struct type marshals, sorted. It is read off the
// TYPE, not off a marshalled value, so an `omitempty` field that happens to hold its zero value
// is still reported — which is what makes the removal direction of the lock sound.
func goJSONFields(t reflect.Type) ([]string, error) {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return nil, fmt.Errorf("%s is not a struct", t)
	}
	var names []string
	for i := range t.NumField() {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		tag := f.Tag.Get("json")
		name, _, _ := strings.Cut(tag, ",")
		if name == "-" && tag == "-" {
			continue
		}
		if f.Anonymous && name == "" {
			// An embedded struct promotes its fields into the same JSON object. None of the
			// mirrored types embed today; refusing rather than silently flattening keeps a
			// future embed from quietly widening the wire shape past this lock.
			return nil, fmt.Errorf("%s embeds %s with no json tag — flatten it or tag it; this lock does not model promoted fields", t, f.Type)
		}
		if name == "" {
			name = f.Name // encoding/json's default when the tag names no key.
		}
		names = append(names, name)
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("%s marshals no JSON fields", t)
	}
	slices.Sort(names)
	return names, nil
}

// diffFieldSets compares two field-name sets and returns an error naming every name that is in
// one and not the other. nil means they agree exactly.
func diffFieldSets(leftLabel string, left []string, rightLabel string, right []string) error {
	var onlyLeft, onlyRight []string
	for _, n := range left {
		if !slices.Contains(right, n) {
			onlyLeft = append(onlyLeft, n)
		}
	}
	for _, n := range right {
		if !slices.Contains(left, n) {
			onlyRight = append(onlyRight, n)
		}
	}
	if onlyLeft == nil && onlyRight == nil {
		return nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s and %s have drifted apart", leftLabel, rightLabel)
	if onlyLeft != nil {
		fmt.Fprintf(&b, "\n  only in %s: %s", leftLabel, strings.Join(onlyLeft, ", "))
	}
	if onlyRight != nil {
		fmt.Fprintf(&b, "\n  only in %s: %s", rightLabel, strings.Join(onlyRight, ", "))
	}
	return fmt.Errorf("%s", b.String())
}

// zeroValuedFields returns the JSON key names of the top-level struct fields that decoded to
// their zero value. It is the anti-vacuity check: a fixture that names a field but leaves it
// empty proves nothing about that field crossing the boundary, and the failure names the field
// rather than reporting a count.
func zeroValuedFields(v any) ([]string, error) {
	rv := reflect.ValueOf(v)
	for rv.Kind() == reflect.Pointer {
		if rv.IsNil() {
			return nil, fmt.Errorf("nil value")
		}
		rv = rv.Elem()
	}
	if rv.Kind() != reflect.Struct {
		return nil, fmt.Errorf("%s is not a struct", rv.Type())
	}
	var zero []string
	t := rv.Type()
	for i := range t.NumField() {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		tag := f.Tag.Get("json")
		name, _, _ := strings.Cut(tag, ",")
		if name == "-" && tag == "-" {
			continue
		}
		if name == "" {
			name = f.Name
		}
		if rv.Field(i).IsZero() {
			zero = append(zero, name)
		}
	}
	slices.Sort(zero)
	return zero, nil
}

// ─────────────────────────── reading the two sources ───────────────────────────

// monorepoRoot walks up to the directory holding go.work. "" when this is not a monorepo
// checkout — packages/core must stay vendorable on its own, and the console half of the mirror
// simply is not there in that case.
func monorepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", nil
		}
		dir = parent
	}
}

// consoleSource returns tsMirrorFile's contents with comments stripped, or skips the test when
// there is no monorepo checkout. Inside a monorepo the file MUST be there: a missing mirror
// source is drift of the loudest kind, not a reason to pass.
func consoleSource(t *testing.T) string {
	t.Helper()
	root, err := monorepoRoot()
	if err != nil {
		t.Fatalf("locating the monorepo root: %v", err)
	}
	if root == "" {
		t.Skip("not a monorepo checkout — the console half of the mirror is not present")
	}
	path := filepath.Join(root, tsMirrorFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v\nThis test IS the mechanism behind that file's `Mirrors the Go X` "+
			"comments. If the file moved, update tsMirrorFile; do not delete the lock.", tsMirrorFile, err)
	}
	return stripTSComments(string(raw))
}

// readFixture reads one committed fixture. Fixtures live inside packages/core, so unlike the
// console source they are present in a standalone checkout and their absence is always a fault.
func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureDir, name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return raw
}

// stripTSComments removes // and /* */ comments while leaving string and template literals
// intact, so the brace scanning below cannot be thrown off by a brace inside a doc comment
// (jsonb.types.ts has several, e.g. "Health ∈ {Healthy, Progressing, …}").
func stripTSComments(src string) string {
	var out strings.Builder
	out.Grow(len(src))
	for i := 0; i < len(src); {
		c := src[i]
		switch {
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			i += 2
			for i+1 < len(src) && (src[i] != '*' || src[i+1] != '/') {
				// Keep newlines so line-oriented reading of the result stays sane.
				if src[i] == '\n' {
					out.WriteByte('\n')
				}
				i++
			}
			i = min(i+2, len(src))
		case c == '"' || c == '\'' || c == '`':
			quote := c
			out.WriteByte(c)
			i++
			for i < len(src) {
				if src[i] == '\\' && i+1 < len(src) {
					out.WriteString(src[i : i+2])
					i += 2
					continue
				}
				out.WriteByte(src[i])
				if src[i] == quote {
					i++
					break
				}
				i++
			}
		default:
			out.WriteByte(c)
			i++
		}
	}
	return out.String()
}

var tsPropertyRe = regexp.MustCompile(`^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:`)

// tsInterfaceBody returns the text between the braces of `export interface <name> { … }` in
// comment-stripped source.
func tsInterfaceBody(src, name string) (string, error) {
	re := regexp.MustCompile(`(?m)^export interface ` + regexp.QuoteMeta(name) + `\b[^{]*\{`)
	loc := re.FindStringIndex(src)
	if loc == nil {
		return "", fmt.Errorf("no `export interface %s` in %s — it was renamed or deleted; "+
			"update the mirrorPairs entry rather than dropping the lock", name, tsMirrorFile)
	}
	depth := 0
	for i := loc[1] - 1; i < len(src); i++ {
		switch src[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return src[loc[1]:i], nil
			}
		}
	}
	return "", fmt.Errorf("unbalanced braces reading interface %s", name)
}

// tsInterfaceFields returns the property names an interface declares, sorted. Nested object and
// index-signature members are skipped by the depth tracking, so only the interface's OWN
// top-level properties come back — the same level fixtureKeys and goJSONFields report.
func tsInterfaceFields(src, name string) ([]string, error) {
	body, err := tsInterfaceBody(src, name)
	if err != nil {
		return nil, err
	}
	var (
		names   []string
		depth   int
		segment strings.Builder
	)
	flush := func() {
		if m := tsPropertyRe.FindStringSubmatch(segment.String()); m != nil {
			names = append(names, m[1])
		}
		segment.Reset()
	}
	for i := range len(body) {
		c := body[i]
		switch c {
		case '{', '[', '(':
			depth++
		case '}', ']', ')':
			depth--
		}
		if depth == 0 && (c == ';' || c == '\n') {
			flush()
			continue
		}
		segment.WriteByte(c)
	}
	flush()
	if len(names) == 0 {
		return nil, fmt.Errorf("parsed zero properties out of interface %s — the parser, not the "+
			"interface, is what changed; fix it rather than accepting an empty set", name)
	}
	slices.Sort(names)
	return names, nil
}

var tsStringLiteralRe = regexp.MustCompile(`"([^"]*)"`)

// tsUnionLiterals returns the string literals of `export type <name> = "a" | "b";`, sorted.
func tsUnionLiterals(src, name string) ([]string, error) {
	re := regexp.MustCompile(`(?m)^export type ` + regexp.QuoteMeta(name) + `\s*=([^;]+);`)
	m := re.FindStringSubmatch(src)
	if m == nil {
		return nil, fmt.Errorf("no `export type %s = …` in %s", name, tsMirrorFile)
	}
	return literalsOf(m[1], "union "+name)
}

// tsPropertyUnion returns the string literals of an INLINE union written as one interface
// property (`severity: "high" | "medium" | "low";`), sorted.
func tsPropertyUnion(src, iface, prop string) ([]string, error) {
	body, err := tsInterfaceBody(src, iface)
	if err != nil {
		return nil, err
	}
	re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(prop) + `\s*\??\s*:([^;]+);`)
	m := re.FindStringSubmatch(body)
	if m == nil {
		return nil, fmt.Errorf("no `%s:` property in interface %s", prop, iface)
	}
	return literalsOf(m[1], iface+"."+prop)
}

// literalsOf pulls the double-quoted literals out of a type expression, failing when there are
// none — an empty vocabulary would compare equal to nothing and report success.
func literalsOf(expr, what string) ([]string, error) {
	var out []string
	for _, m := range tsStringLiteralRe.FindAllStringSubmatch(expr, -1) {
		out = append(out, m[1])
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s declares no string literals — the parser is what changed", what)
	}
	slices.Sort(out)
	return out, nil
}

var goConstBlockRe = regexp.MustCompile(`(?ms)^const \((.*?)^\)`)

// goConstBlockStrings returns the string values of the `const ( … )` block that declares
// anchor, sorted. The SET is derived from the block rather than listed here, so a constant
// added to the same vocabulary is caught whatever it is named — a hand-written list of what a
// guard watches stops covering silently.
func goConstBlockStrings(path, anchor string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	for _, m := range goConstBlockRe.FindAllStringSubmatch(string(raw), -1) {
		block := m[1]
		if !regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(anchor) + `\b`).MatchString(block) {
			continue
		}
		var out []string
		for _, lit := range regexp.MustCompile(`(?m)^\s*\w+[^=\n]*=\s*"([^"]*)"`).FindAllStringSubmatch(block, -1) {
			out = append(out, lit[1])
		}
		if len(out) == 0 {
			return nil, fmt.Errorf("the const block declaring %s in %s holds no string constants — the parser is what changed", anchor, path)
		}
		slices.Sort(out)
		return out, nil
	}
	return nil, fmt.Errorf("no `const (…)` block declaring %s in %s", anchor, path)
}

// ─────────────────────────── the locks ───────────────────────────

// TestJSONBMirror_GoStructMatchesFixture is the Go half: every mirrored fixture strict-decodes
// into its Go struct, the struct's tag set equals the fixture's key set in both directions, and
// every field lands populated.
func TestJSONBMirror_GoStructMatchesFixture(t *testing.T) {
	for _, p := range mirrorPairs() {
		t.Run(p.TSName, func(t *testing.T) {
			raw := readFixture(t, p.Fixture)
			v := p.New()

			if err := decodeStrict(raw, v); err != nil {
				t.Fatalf("%s carries a field %s does not model (additive drift): %v",
					p.Fixture, p.GoName, err)
			}

			keys, err := fixtureKeys(raw)
			if err != nil {
				t.Fatalf("%s: %v", p.Fixture, err)
			}
			goFields, err := goJSONFields(reflect.TypeOf(v))
			if err != nil {
				t.Fatalf("%s: %v", p.GoName, err)
			}
			if err := diffFieldSets(p.GoName, goFields, p.Fixture, keys); err != nil {
				t.Errorf("%s", err)
			}

			zero, err := zeroValuedFields(v)
			if err != nil {
				t.Fatalf("%s: %v", p.GoName, err)
			}
			if len(zero) > 0 {
				t.Errorf("%s decoded these fields to their zero value: %s\n"+
					"A field the fixture leaves empty is a field this mirror does not actually "+
					"exercise — give it a distinctive value in %s.",
					p.GoName, strings.Join(zero, ", "), p.Fixture)
			}
		})
	}
}

// TestJSONBMirror_ConsoleInterfaceMatchesFixture is the TypeScript half: the interface the
// console declares must declare exactly the fixture's keys. Together with the Go half above,
// this is what turns `Mirrors the Go X` from a comment into a lock — neither side is derived
// from the other, so a change to either one alone goes red.
func TestJSONBMirror_ConsoleInterfaceMatchesFixture(t *testing.T) {
	src := consoleSource(t)
	for _, p := range mirrorPairs() {
		t.Run(p.TSName, func(t *testing.T) {
			raw := readFixture(t, p.Fixture)
			keys, err := fixtureKeys(raw)
			if err != nil {
				t.Fatalf("%s: %v", p.Fixture, err)
			}
			tsFields, err := tsInterfaceFields(src, p.TSName)
			if err != nil {
				t.Fatalf("%v", err)
			}
			if err := diffFieldSets(tsMirrorFile+" "+p.TSName, tsFields, p.Fixture, keys); err != nil {
				t.Errorf("%s\nThe console interface claims to mirror %s. Bring the interface, the "+
					"fixture and the Go struct back into agreement.", err, p.GoName)
			}
		})
	}
}

// valueVocabulary is one string-union the console declares against the Go constant set that
// defines it. A field whose NAME matches but whose accepted VALUES do not is drift the
// field-set locks above cannot see.
type valueVocabulary struct {
	// Name is used in failure messages.
	Name string
	// TS reads the console's literals.
	TS func(src string) ([]string, error)
	// GoPath / GoAnchor locate the Go `const (…)` block that defines the vocabulary.
	GoPath, GoAnchor string
}

func valueVocabularies() []valueVocabulary {
	return []valueVocabulary{
		{
			Name:     "DriftNormalizedReason ↔ drift.NormalizedReason",
			TS:       func(src string) ([]string, error) { return tsUnionLiterals(src, "DriftNormalizedReason") },
			GoPath:   filepath.Join("..", "drift", "normalize.go"),
			GoAnchor: "ReasonEmptyCollection",
		},
		{
			Name:     "DriftResourceKind ↔ drift.Kind",
			TS:       func(src string) ([]string, error) { return tsUnionLiterals(src, "DriftResourceKind") },
			GoPath:   filepath.Join("..", "drift", "drift.go"),
			GoAnchor: "KindModified",
		},
		{
			Name:     "VerifyStatus ↔ verify.Status",
			TS:       func(src string) ([]string, error) { return tsUnionLiterals(src, "VerifyStatus") },
			GoPath:   filepath.Join("..", "verify", "types.go"),
			GoAnchor: "StatusPass",
		},
		{
			Name:     "VerifyControlResult.severity ↔ verify.Severity",
			TS:       func(src string) ([]string, error) { return tsPropertyUnion(src, "VerifyControlResult", "severity") },
			GoPath:   filepath.Join("..", "verify", "types.go"),
			GoAnchor: "SeverityHigh",
		},
		{
			Name:     "GitopsFailedStep ↔ argocd GitopsStep*",
			TS:       func(src string) ([]string, error) { return tsUnionLiterals(src, "GitopsFailedStep") },
			GoPath:   filepath.Join("..", "argocd", "gitops_status.go"),
			GoAnchor: "GitopsStepArgocdInstall",
		},
	}
}

// TestJSONBMirror_ValueVocabularies locks the accepted VALUES of the mirrored string unions,
// not just the field names carrying them. A console that accepts a value the runner never emits
// renders a state that cannot happen; a console missing one the runner does emit renders nothing.
func TestJSONBMirror_ValueVocabularies(t *testing.T) {
	src := consoleSource(t)
	for _, v := range valueVocabularies() {
		t.Run(v.Name, func(t *testing.T) {
			tsValues, err := v.TS(src)
			if err != nil {
				t.Fatalf("%v", err)
			}
			goValues, err := goConstBlockStrings(v.GoPath, v.GoAnchor)
			if err != nil {
				t.Fatalf("%v", err)
			}
			if err := diffFieldSets("console", tsValues, v.GoPath, goValues); err != nil {
				t.Errorf("%s", err)
			}
		})
	}
}

// ─────────────────────────── proving the locks fire ───────────────────────────

// TestJSONBMirror_LocksFire mutates each side of every pair and requires the guard the real
// lock uses to report it. It calls decodeStrict / diffFieldSets / zeroValuedFields directly:
// re-deriving the answer here would verify a copy of the guard rather than the guard.
//
// Per pair it proves, for EVERY field rather than for one sampled field:
//
//	added on the wire   → decodeStrict errors, and both field-set locks name the new key
//	removed from the wire → both field-set locks name the dropped key
//	emptied on the wire  → zeroValuedFields names the field
func TestJSONBMirror_LocksFire(t *testing.T) {
	src := consoleSource(t)
	const probe = "__mirror_drift_probe__"

	for _, p := range mirrorPairs() {
		t.Run(p.TSName, func(t *testing.T) {
			raw := readFixture(t, p.Fixture)
			goFields, err := goJSONFields(reflect.TypeOf(p.New()))
			if err != nil {
				t.Fatalf("%s: %v", p.GoName, err)
			}
			tsFields, err := tsInterfaceFields(src, p.TSName)
			if err != nil {
				t.Fatalf("%v", err)
			}
			var base map[string]json.RawMessage
			if err := json.Unmarshal(raw, &base); err != nil {
				t.Fatalf("%s is not a JSON object: %v", p.Fixture, err)
			}

			// ── ADDITIVE: the wire grew a field neither side models. ──
			t.Run("added", func(t *testing.T) {
				mutated := cloneWithout(base, "")
				mutated[probe] = json.RawMessage(`"drift"`)
				data := remarshal(t, mutated)

				if err := decodeStrict(data, p.New()); err == nil {
					t.Errorf("decodeStrict accepted an unknown %q key — DisallowUnknownFields is not doing anything for %s", probe, p.GoName)
				}
				keys, err := fixtureKeys(data)
				if err != nil {
					t.Fatalf("mutated fixture: %v", err)
				}
				assertReports(t, "Go field-set lock", diffFieldSets(p.GoName, goFields, "wire", keys), probe)
				assertReports(t, "console field-set lock", diffFieldSets(p.TSName, tsFields, "wire", keys), probe)
			})

			// ── REMOVAL: the wire dropped a field the other two sides still model. ──
			for key := range base {
				t.Run("removed/"+key, func(t *testing.T) {
					data := remarshal(t, cloneWithout(base, key))
					keys, err := fixtureKeys(data)
					if err != nil {
						t.Fatalf("mutated fixture: %v", err)
					}
					assertReports(t, "Go field-set lock", diffFieldSets(p.GoName, goFields, "wire", keys), key)
					assertReports(t, "console field-set lock", diffFieldSets(p.TSName, tsFields, "wire", keys), key)
				})
			}

			// ── VACUITY: the wire still names the field but carries nothing in it. ──
			for key := range base {
				t.Run("emptied/"+key, func(t *testing.T) {
					mutated := cloneWithout(base, "")
					mutated[key] = json.RawMessage(`null`)
					v := p.New()
					if err := decodeStrict(remarshal(t, mutated), v); err != nil {
						t.Fatalf("nulling %q should still decode: %v", key, err)
					}
					zero, err := zeroValuedFields(v)
					if err != nil {
						t.Fatalf("%v", err)
					}
					if !slices.Contains(zero, key) {
						t.Errorf("zeroValuedFields did not name %q after the wire emptied it — the "+
							"anti-vacuity check would not notice %s.%s arriving empty", key, p.GoName, key)
					}
				})
			}
		})
	}
}

// TestJSONBMirror_VocabularyLockFires proves the value-vocabulary comparison speaks when the two
// sides disagree, by handing the real comparator a vocabulary with one value added and one
// dropped. Without this the vocabulary test would be indistinguishable from one that always
// finds the sets equal.
func TestJSONBMirror_VocabularyLockFires(t *testing.T) {
	src := consoleSource(t)
	for _, v := range valueVocabularies() {
		t.Run(v.Name, func(t *testing.T) {
			goValues, err := goConstBlockStrings(v.GoPath, v.GoAnchor)
			if err != nil {
				t.Fatalf("%v", err)
			}
			tsValues, err := v.TS(src)
			if err != nil {
				t.Fatalf("%v", err)
			}
			if len(tsValues) == 0 {
				t.Fatalf("%s parsed an empty console vocabulary", v.Name)
			}
			added := append(slices.Clone(goValues), "__unmodelled_value__")
			assertReports(t, "vocabulary lock (value added on the Go side)",
				diffFieldSets("console", tsValues, "go", added), "__unmodelled_value__")

			dropped := slices.Clone(goValues)[1:]
			assertReports(t, "vocabulary lock (value dropped on the Go side)",
				diffFieldSets("console", tsValues, "go", dropped), goValues[0])
		})
	}
}

// TestJSONBMirror_ParsersFailLoudOnAMissingSubject pins the branch every source-reading guard
// gets wrong: "found nothing" must not read as "nothing is wrong".
func TestJSONBMirror_ParsersFailLoudOnAMissingSubject(t *testing.T) {
	const src = "export interface Present {\n\tfoo: string;\n}\n"
	if _, err := tsInterfaceFields(src, "Absent"); err == nil {
		t.Error("tsInterfaceFields returned no error for an interface that does not exist")
	}
	if _, err := tsUnionLiterals(src, "Absent"); err == nil {
		t.Error("tsUnionLiterals returned no error for a union that does not exist")
	}
	if _, err := tsPropertyUnion(src, "Present", "absent"); err == nil {
		t.Error("tsPropertyUnion returned no error for a property that does not exist")
	}
	if _, err := goConstBlockStrings(filepath.Join("..", "verify", "types.go"), "NoSuchConstant"); err == nil {
		t.Error("goConstBlockStrings returned no error for a const block that does not exist")
	}
	if _, err := fixtureKeys([]byte(`{}`)); err == nil {
		t.Error("fixtureKeys accepted an empty object — an empty fixture passes every comparison")
	}
	if _, err := fixtureKeys([]byte(`[1,2]`)); err == nil {
		t.Error("fixtureKeys accepted a non-object document")
	}
	if err := diffFieldSets("a", []string{"x"}, "b", []string{"x"}); err != nil {
		t.Errorf("diffFieldSets reported a difference between identical sets: %v", err)
	}
}

// TestJSONBMirror_CommentStripperKeepsBracesInsideStrings guards the one assumption the TS
// parser rests on: comments are removed, string literals are not. A stripper that ate a string
// would silently shrink an interface's property set and every comparison would still pass.
func TestJSONBMirror_CommentStripperKeepsBracesInsideStrings(t *testing.T) {
	const src = "export interface X {\n" +
		"\t/** health ∈ {Healthy, Degraded} — a brace inside a doc comment. */\n" +
		"\tmode: \"gitops\" | \"direct\"; // trailing comment with a } in it\n" +
		"\tlabel: \"a } b\";\n" +
		"}\n"
	stripped := stripTSComments(src)
	if strings.Contains(stripped, "Healthy") || strings.Contains(stripped, "trailing comment") {
		t.Fatalf("comments survived stripping:\n%s", stripped)
	}
	if !strings.Contains(stripped, `"a } b"`) {
		t.Fatalf("a string literal was mangled by the stripper:\n%s", stripped)
	}
	fields, err := tsInterfaceFields(stripped, "X")
	if err != nil {
		t.Fatalf("%v", err)
	}
	if !slices.Equal(fields, []string{"label", "mode"}) {
		t.Errorf("got %v, want [label mode]", fields)
	}
}

// assertReports fails unless err is non-nil AND names want. An error that fires without saying
// what drifted sends the next reader to diff two files by eye.
func assertReports(t *testing.T, what string, err error, want string) {
	t.Helper()
	if err == nil {
		t.Errorf("%s stayed silent about %q", what, want)
		return
	}
	if !strings.Contains(err.Error(), want) {
		t.Errorf("%s fired but did not name %q: %v", what, want, err)
	}
}

// cloneWithout copies a fixture object, dropping key when it is non-empty.
func cloneWithout(base map[string]json.RawMessage, key string) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(base))
	for k, v := range base {
		if key != "" && k == key {
			continue
		}
		out[k] = v
	}
	return out
}

func remarshal(t *testing.T, obj map[string]json.RawMessage) []byte {
	t.Helper()
	data, err := json.Marshal(obj)
	if err != nil {
		t.Fatalf("re-marshal mutated fixture: %v", err)
	}
	return data
}
