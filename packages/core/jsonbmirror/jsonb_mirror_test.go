// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The mechanism behind the `Mirrors the Go X` comments in the console, across the ENROLLED
// files listed in tsMirrorFiles below.
//
// Every one of those comments asserted in prose that a TypeScript interface carried the same wire
// shape as a Go struct in packages/core. Nothing enforced it. A comment cannot fail, so a field
// added on one side and not the other is invisible until a value silently zero-fills in
// production — which is the whole point of these payloads riding jobs.execution_metadata.
//
// ENROLMENT IS THE WHOLE MECHANISM, and it is the half that failed quietly. The file started
// enforcing exactly ONE console file, which read as "the mirror claims are locked" and meant
// "the mirror claims IN THAT FILE are locked". #4455 measured the difference: eight claims —
// seven in the marketplace add-on install spec, one in the console's Rekor anchoring mirror —
// were watched by nothing at all, while this file's header said the coverage was complete.
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
// WHY THIS PACKAGE, and not packages/core/types where 3 of its 23 subjects live: `go mod tidy`
// records checksums for the TESTS of packages the main module imports, and apps/cli imports
// packages/core/types. Putting this file there pulled argocd's and drift's whole external
// closure — aws-sdk-go-v2, eks, iam, ec2, sts, smithy — into apps/cli/go.sum, and would have
// re-broken that module's standalone tidy check on any future dependency change under a package
// this test merely names. jsonbmirror is imported by nothing, so it cannot do that to anyone.
// Verified, not assumed: with the file here, apps/cli/go.sum is byte-identical to dev's.
//
// THREE KINDS OF LOCK, because a claim is not always about a struct:
//
//   - a FIXTURE PAIR (mirrorPairs) — the three-way lock above. The strong one.
//   - a VALUE VOCABULARY (valueVocabularies) — the accepted string values of a union, compared
//     against the Go `const (…)` block that defines them.
//   - a SYMBOL CLAIM (symbolClaims) — for a claim whose Go side is a FUNCTION the console
//     re-implements (verify.VerifyAnchor). It locks that the named Go symbol still exists with
//     the signature the claim depends on, and DELIBERATELY NOTHING MORE: the behavioural
//     agreement between a Node implementation and a Go one is pinned by each side's own tests,
//     and pretending a fixture could express it would be the empty comfort this file removes.
//
// A claim of the form `Type.Field` is answered by its OWNER's lock plus a check that the Go
// struct really declares that field — see claimCoverage. The five such claims in the add-on
// install spec are locked that way, and renaming the Go field turns them red.
//
// NOT locked here, enumerated so the coverage cannot be overread. This list is the whole of it:
// every OTHER `Mirrors the Go X` claim in an enrolled file has a pair in mirrorPairs below, and
// the review that produced this list found three claims an earlier, vaguer version of it had not
// named — so a claim that is hard to lock gets a line here, never silence.
//
//   - `ArgocdHealthStatus` / `ArgocdSyncStatus` — VALUES only. Their Go side is ArgoCD's own
//     vocabulary written as bare string literals (argocd/health.go), not a declared constant
//     set, so there is nothing to compare a union against. The FIELDS typed by them are locked.
//   - `GitopsStatusReport.mode` ("gitops" | "direct") — VALUES only, same reason:
//     `argocd.GitopsStatus.Mode` is a bare `string` whose two legal values live in a comment.
//   - `HelmRegistryProviderConfig` — its comment claims the keys match what the Go providers
//     READ out of ProviderConfig (categories/helm_registry_*.go). That is a claim about provider
//     BEHAVIOUR, not about a struct's tags; no fixture can express it, and pretending otherwise
//     would be the same empty comfort this file exists to remove.
//
// Everything else in an enrolled file that names a Go type is locked, including the three the
// review caught: `DriftDetail` (which was stale — it was missing `attributes`), `ProbeDetail` /
// `ProbeResult`, and `ServiceBindingOutputKeys`.
//
// One nesting boundary is deliberate and is stated rather than left to be discovered:
// types.ServiceBinding, reached through ChartWorkloadBinding.bindings, gets no pair of its own.
// Its TypeScript `target` is an inline object literal with no exported interface, so
// tsInterfaceFields has no subject to read — there is nothing to compare, and inventing an
// interface to satisfy this test would be the test dictating the console's shape. Its keys are
// still strict-decoded (DisallowUnknownFields is recursive) through the two fixtures that carry
// one, so additive drift inside it is caught; a RENAME inside it is not.
package jsonbmirror

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
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// The console files whose `Mirrors the Go X` claims this test enforces, relative to the
// monorepo root. ENROLMENT IS THE WHOLE MECHANISM: a claim in a file that is not in this list
// is watched by nothing, which is what #4455 measured — seven claims in the add-on marketplace
// spec and one in the Rekor anchoring mirror sat outside the single file this list used to be.
//
// Adding a file here is not free and is not meant to be: every `Mirrors the Go X` phrase it
// carries must from then on be answered by a fixture pair, a value vocabulary, a symbol claim or
// a named unlockableClaims entry, or TestJSONBMirror_EveryClaimIsLockedOrNamed goes red.
const (
	// tsMirrorFile is the jobs.execution_metadata payload family, and was for a while the whole
	// enrolled set.
	//
	// THE IDENTIFIER IS LOAD-BEARING OUTSIDE THIS PACKAGE, and nothing enforces that: the census
	// in scripts/check-cli-surface.mjs reads this file's enrolled set with the literal regex
	// /tsMirrorFile\s*=\s*"([^"]+)"/, refuses to report counter 4 at all when it matches nothing,
	// and compares each claim's FILE against the single path it captures. So renaming this const
	// silently turns that counter from a number into a refusal, and the census still reads only
	// this one file — the claims in the two files below are locked HERE and still counted
	// unlocked THERE until that reader learns to take a list (#4455 · its file belongs to #3664).
	tsMirrorFile = "apps/console/types/jsonb.types.ts"
	// tsFileAddons is the marketplace add-on install spec that rides the DEPLOY job's config
	// snapshot — the same wire, a different file.
	tsFileAddons = "apps/console/lib/addons/types.ts"
	// tsFileAnchor is the console-side Rekor anchoring mirror. It declares no mirrored
	// INTERFACE; its single claim is about a Go FUNCTION and is locked as a symbol claim.
	tsFileAnchor = "apps/console/lib/evidence/receipt-anchor.ts"
)

// tsMirrorFiles is the enrolled set, in the order the claim inventory reports them.
func tsMirrorFiles() []string {
	return []string{tsMirrorFile, tsFileAddons, tsFileAnchor}
}

// fixtureDir holds one committed fixture per mirrored shape. The fixtures are hand-written
// (they ARE the declared wire shape, not a dump of a run), so there is no generator to name:
// a failure here is fixed by editing the fixture, the Go struct or the TS interface until the
// three agree.
const fixtureDir = "testdata/jsonb"

// mirrorPair is one `Mirrors the Go X` claim made enforceable: a TypeScript interface, the Go
// struct it claims to mirror, and the committed fixture that is the agreed wire shape.
type mirrorPair struct {
	// TSFile is the enrolled console file the interface is declared in.
	TSFile string
	// TSName is the exported interface name in TSFile.
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
		{TSFile: tsMirrorFile, TSName: "AddOnStatusEntry", GoName: "argocd.AddOnHealth", Fixture: "addon_status_entry.json",
			New: func() any { return new(argocd.AddOnHealth) }},
		{TSFile: tsMirrorFile, TSName: "SecurityReport", GoName: "argocd.SecurityPosture", Fixture: "security_report.json",
			New: func() any { return new(argocd.SecurityPosture) }},
		{TSFile: tsMirrorFile, TSName: "GitopsStatusReport", GoName: "argocd.GitopsStatus", Fixture: "gitops_status.json",
			New: func() any { return new(argocd.GitopsStatus) }},
		{TSFile: tsMirrorFile, TSName: "GitopsServiceHealth", GoName: "argocd.ServiceHealth", Fixture: "gitops_service_health.json",
			New: func() any { return new(argocd.ServiceHealth) }},

		// ── drift ──
		{TSFile: tsMirrorFile, TSName: "DriftPosture", GoName: "drift.Posture", Fixture: "drift_posture.json",
			New: func() any { return new(drift.Posture) }},
		{TSFile: tsMirrorFile, TSName: "DriftDetail", GoName: "drift.ResourceDrift", Fixture: "drift_detail.json",
			New: func() any { return new(drift.ResourceDrift) }},
		{TSFile: tsMirrorFile, TSName: "DriftNormalizedResource", GoName: "drift.NormalizedResource", Fixture: "drift_normalized_resource.json",
			New: func() any { return new(drift.NormalizedResource) }},

		// ── verify (the elench gate + its evidence receipt) ──
		{TSFile: tsMirrorFile, TSName: "VerifyFinding", GoName: "verify.Finding", Fixture: "verify_finding.json",
			New: func() any { return new(verify.Finding) }},
		{TSFile: tsMirrorFile, TSName: "VerifyControlResult", GoName: "verify.ControlResult", Fixture: "verify_control_result.json",
			New: func() any { return new(verify.ControlResult) }},
		{TSFile: tsMirrorFile, TSName: "VerifySummary", GoName: "verify.Summary", Fixture: "verify_summary.json",
			New: func() any { return new(verify.Summary) }},
		{TSFile: tsMirrorFile, TSName: "VerifyReport", GoName: "verify.Report", Fixture: "verify_report.json",
			New: func() any { return new(verify.Report) }},
		{TSFile: tsMirrorFile, TSName: "RecordedException", GoName: "verify.RecordedException", Fixture: "recorded_exception.json",
			New: func() any { return new(verify.RecordedException) }},
		{TSFile: tsMirrorFile, TSName: "VerifyOverrideInput", GoName: "verify.Override", Fixture: "verify_override.json",
			New: func() any { return new(verify.Override) }},
		{TSFile: tsMirrorFile, TSName: "VerifyReceiptBody", GoName: "verify.Receipt", Fixture: "verify_receipt.json",
			New: func() any { return new(verify.Receipt) }},
		{TSFile: tsMirrorFile, TSName: "SignedReceipt", GoName: "verify.SignedReceipt", Fixture: "signed_receipt.json",
			New: func() any { return new(verify.SignedReceipt) }},
		{TSFile: tsMirrorFile, TSName: "RekorInclusionProof", GoName: "verify.RekorInclusionProof", Fixture: "rekor_inclusion_proof.json",
			New: func() any { return new(verify.RekorInclusionProof) }},
		{TSFile: tsMirrorFile, TSName: "RekorAnchor", GoName: "verify.RekorAnchor", Fixture: "rekor_anchor.json",
			New: func() any { return new(verify.RekorAnchor) }},

		// ── packages/core/types (the BYO-IaC binding output map) ──
		{TSFile: tsMirrorFile, TSName: "ServiceBindingOutputKeys", GoName: "types.ServiceBindingOutputKeys", Fixture: "service_binding_output_keys.json",
			New: func() any { return new(types.ServiceBindingOutputKeys) }},

		// ── provisioner (the PROBE_CLUSTER liveness probe) ──
		{TSFile: tsMirrorFile, TSName: "ProbeResult", GoName: "provisioner.ProbeResult", Fixture: "probe_result.json",
			New: func() any { return new(provisioner.ProbeResult) }},
		{TSFile: tsMirrorFile, TSName: "ProbeDetail", GoName: "provisioner.ProbeDetail", Fixture: "probe_detail.json",
			New: func() any { return new(provisioner.ProbeDetail) }},

		// ── packages/core/types (the ANALYZE_REPO digest) ──
		{TSFile: tsMirrorFile, TSName: "RepoFile", GoName: "types.RepoFile", Fixture: "repo_file.json",
			New: func() any { return new(types.RepoFile) }},
		{TSFile: tsMirrorFile, TSName: "DetectedService", GoName: "types.DetectedService", Fixture: "detected_service.json",
			New: func() any { return new(types.DetectedService) }},
		{TSFile: tsMirrorFile, TSName: "RepoDigest", GoName: "types.RepoDigest", Fixture: "repo_digest.json",
			New: func() any { return new(types.RepoDigest) }},

		// ── the marketplace add-on install spec (apps/console/lib/addons/types.ts) ──
		//
		// Same wire, a different console file: this shape rides the DEPLOY job's config
		// snapshot under `addons` and the runner renders one ArgoCD Application per entry.
		// The two nested shapes are paired for the reason the header gives — a lock that
		// stops at the first level of nesting is a lock with a hole in it.
		{TSFile: tsFileAddons, TSName: "AddOnInstallSpec", GoName: "types.AddOnInstall", Fixture: "addon_install.json",
			New: func() any { return new(types.AddOnInstall) }},
		{TSFile: tsFileAddons, TSName: "AddOnSecretRef", GoName: "types.AddOnSecretRef", Fixture: "addon_secret_ref.json",
			New: func() any { return new(types.AddOnSecretRef) }},
		{TSFile: tsFileAddons, TSName: "AddOnBootstrap", GoName: "types.AddOnBootstrap", Fixture: "addon_bootstrap.json",
			New: func() any { return new(types.AddOnBootstrap) }},
		{TSFile: tsFileAddons, TSName: "ChartWorkloadBindingSpec", GoName: "types.ChartWorkloadBinding", Fixture: "chart_workload_binding.json",
			New: func() any { return new(types.ChartWorkloadBinding) }},
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

// wireFieldName reports the JSON key a struct field marshals under and whether it reaches the
// wire at all. It exists so the two walkers below cannot keep divergent copies of
// encoding/json's field rules — including the one that is easy to get backwards:
//
// An embedded field of an UNEXPORTED STRUCT type is NOT skipped by encoding/json. It promotes
// that struct's exported, tagged fields onto the wire (typeFields: "Do not ignore embedded
// fields of unexported struct types since they may have exported fields"). Probed rather than
// assumed: `struct{ commonFields; Address string }` with an unexported
// `commonFields{Kind string `json:"kind"`}` marshals as {"kind":…,"address":…}. Only embedded
// fields of unexported NON-struct types are genuinely invisible.
//
// Dropping such a field on `!IsExported()` alone would hide a real wire field from every check
// in this file — the lock would report green over a key it cannot see, which is the failure mode
// the rest of the file is built to avoid.
func wireFieldName(f reflect.StructField) (string, bool, error) {
	embeddedStruct := false
	if f.Anonymous {
		ft := f.Type
		for ft.Kind() == reflect.Pointer {
			ft = ft.Elem()
		}
		embeddedStruct = ft.Kind() == reflect.Struct
	}
	if !f.IsExported() && !embeddedStruct {
		return "", false, nil
	}
	tag := f.Tag.Get("json")
	name, _, _ := strings.Cut(tag, ",")
	if tag == "-" {
		return "", false, nil // encoding/json's explicit "not on the wire".
	}
	if f.Anonymous && name == "" {
		// Untagged embedding flattens the embedded struct's fields into this JSON object.
		// None of the mirrored types embed today; refusing is what keeps a future embed from
		// widening the wire shape past this lock instead of being silently dropped.
		return "", false, fmt.Errorf("embeds %s with no json tag — tag it or flatten it; this lock does not model promoted fields", f.Type)
	}
	if name == "" {
		name = f.Name // encoding/json's default when the tag names no key.
	}
	return name, true, nil
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
		name, onWire, err := wireFieldName(t.Field(i))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", t, err)
		}
		if !onWire {
			continue
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
		// Same decision as goJSONFields, from the same function: two hand-kept copies of
		// encoding/json's field rules are two chances to disagree, and the direction that
		// matters here is silent under-reporting.
		name, onWire, err := wireFieldName(t.Field(i))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", t, err)
		}
		if !onWire {
			continue
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

// consoleSource returns one enrolled file's contents with comments stripped, or skips the test
// when there is no monorepo checkout. Inside a monorepo the file MUST be there: a missing mirror
// source is drift of the loudest kind, not a reason to pass.
func consoleSource(t *testing.T, file string) string {
	t.Helper()
	return stripTSComments(consoleSourceRaw(t, file))
}

// consoleSourceRaw is the same file with its COMMENTS intact — the mirror claims live in them.
func consoleSourceRaw(t *testing.T, file string) string {
	t.Helper()
	root, err := monorepoRoot()
	if err != nil {
		t.Fatalf("locating the monorepo root: %v", err)
	}
	if root == "" {
		t.Skip("not a monorepo checkout — the console half of the mirror is not present")
	}
	path := filepath.Join(root, file)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v\nThis test IS the mechanism behind that file's `Mirrors the Go X` "+
			"comments. If the file moved, update the tsFile* constant; do not delete the lock.", file, err)
	}
	return string(raw)
}

// consoleSources reads every enrolled file once, comments stripped, keyed by path. Each mirror
// pair names the file it belongs to, so nothing reads a subject out of the wrong source.
func consoleSources(t *testing.T) map[string]string {
	t.Helper()
	out := make(map[string]string, len(tsMirrorFiles()))
	for _, f := range tsMirrorFiles() {
		out[f] = consoleSource(t, f)
	}
	return out
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

// maskTSStrings returns src with the CONTENTS of every string / template literal replaced by
// 'x', preserving the quotes, the byte length and every newline. Index-for-index identical to
// src, so a match found on the masked text slices the original exactly.
//
// It exists because stripTSComments deliberately KEEPS string literals — the value vocabularies
// are read out of them — which means every brace-counting scan below would otherwise count a
// `}` inside a literal. That is not hypothetical in the quiet direction: a property declared
// after a brace-bearing literal gets swallowed into the previous segment and silently dropped
// from the parsed field set, and the console↔fixture comparison then reports green over a
// property the console really does declare.
//
// Scans run on the mask; literals are read from the original.
func maskTSStrings(src string) string {
	out := []byte(src)
	for i := 0; i < len(src); {
		c := src[i]
		if c != '"' && c != '\'' && c != '`' {
			i++
			continue
		}
		quote := c
		i++ // the opening quote stays
		for i < len(src) {
			switch {
			case src[i] == '\\' && i+1 < len(src):
				out[i], out[i+1] = 'x', 'x'
				i += 2
				continue
			case src[i] == quote:
				i++ // the closing quote stays
			case src[i] == '\n':
				i++ // keep newlines: an unterminated literal must not swallow the file
			default:
				out[i] = 'x'
				i++
				continue
			}
			break
		}
	}
	return string(out)
}

var tsPropertyRe = regexp.MustCompile(`^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:`)

// tsInterfaceBody returns the text between the braces of `export interface <name> { … }` in
// comment-stripped source.
func tsInterfaceBody(src, name string) (string, error) {
	// Find and brace-scan on the string-masked copy so a `{` or `}` inside a literal cannot
	// move the interface's end; the indices are valid in src because the mask is length-preserving.
	masked := maskTSStrings(src)
	re := regexp.MustCompile(`(?m)^export interface ` + regexp.QuoteMeta(name) + `\b[^{]*\{`)
	loc := re.FindStringIndex(masked)
	if loc == nil {
		return "", fmt.Errorf("no `export interface %s` in the console source — it was renamed or "+
			"deleted; update the mirrorPairs entry rather than dropping the lock", name)
	}
	depth := 0
	for i := loc[1] - 1; i < len(masked); i++ {
		switch masked[i] {
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
	// Segment the string-masked body: a `;`, `}` or `]` inside a literal must not end a
	// property or move the depth. Property NAMES never live inside a literal, so reading them
	// off the mask loses nothing.
	masked := maskTSStrings(body)
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
	for i := range len(masked) {
		c := masked[i]
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
	// `[^;]+` must not stop at a `;` inside a literal, so the span is found on the mask and
	// the literals are then read from the original text.
	re := regexp.MustCompile(`(?m)^export type ` + regexp.QuoteMeta(name) + `\s*=([^;]+);`)
	loc := re.FindStringSubmatchIndex(maskTSStrings(src))
	if loc == nil {
		return nil, fmt.Errorf("no `export type %s = …` in %s", name, tsMirrorFile)
	}
	return literalsOf(src[loc[2]:loc[3]], "union "+name)
}

// tsPropertyUnion returns the string literals of an INLINE union written as one interface
// property (`severity: "high" | "medium" | "low";`), sorted.
func tsPropertyUnion(src, iface, prop string) ([]string, error) {
	body, err := tsInterfaceBody(src, iface)
	if err != nil {
		return nil, err
	}
	re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(prop) + `\s*\??\s*:([^;]+);`)
	loc := re.FindStringSubmatchIndex(maskTSStrings(body))
	if loc == nil {
		return nil, fmt.Errorf("no `%s:` property in interface %s", prop, iface)
	}
	return literalsOf(body[loc[2]:loc[3]], iface+"."+prop)
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
	srcs := consoleSources(t)
	for _, p := range mirrorPairs() {
		t.Run(p.TSName, func(t *testing.T) {
			raw := readFixture(t, p.Fixture)
			keys, err := fixtureKeys(raw)
			if err != nil {
				t.Fatalf("%s: %v", p.Fixture, err)
			}
			tsFields, err := tsInterfaceFields(srcs[p.TSFile], p.TSName)
			if err != nil {
				t.Fatalf("%s: %v", p.TSFile, err)
			}
			if err := diffFieldSets(p.TSFile+" "+p.TSName, tsFields, p.Fixture, keys); err != nil {
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
	// GoType is the type the console names when it claims to mirror this vocabulary, so a
	// `Mirrors the Go X` claim answered by a vocabulary counts as covered. Empty when the Go
	// side has no named type (the GitopsStep* constants).
	GoType string
}

func valueVocabularies() []valueVocabulary {
	return []valueVocabulary{
		{
			Name:     "DriftNormalizedReason ↔ drift.NormalizedReason",
			TS:       func(src string) ([]string, error) { return tsUnionLiterals(src, "DriftNormalizedReason") },
			GoPath:   filepath.Join("..", "drift", "normalize.go"),
			GoAnchor: "ReasonEmptyCollection",
			GoType:   "drift.NormalizedReason",
		},
		{
			Name:     "DriftResourceKind ↔ drift.Kind",
			TS:       func(src string) ([]string, error) { return tsUnionLiterals(src, "DriftResourceKind") },
			GoPath:   filepath.Join("..", "drift", "drift.go"),
			GoAnchor: "KindModified",
			GoType:   "drift.Kind",
		},
		{
			Name:     "VerifyStatus ↔ verify.Status",
			TS:       func(src string) ([]string, error) { return tsUnionLiterals(src, "VerifyStatus") },
			GoPath:   filepath.Join("..", "verify", "types.go"),
			GoAnchor: "StatusPass",
			GoType:   "verify.Status",
		},
		{
			Name:     "VerifyControlResult.severity ↔ verify.Severity",
			TS:       func(src string) ([]string, error) { return tsPropertyUnion(src, "VerifyControlResult", "severity") },
			GoPath:   filepath.Join("..", "verify", "types.go"),
			GoAnchor: "SeverityHigh",
			GoType:   "verify.Severity",
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
	src := consoleSource(t, tsMirrorFile)
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

// ─────────────────────────── the inventory cannot go stale ───────────────────────────

var (
	// commentContinuationRe joins a claim that wraps across comment lines (` * ` or `// `), so
	// the claim regex below sees one line whether or not the author wrapped it.
	commentContinuationRe = regexp.MustCompile("\\n[ \t]*(?:\\*/?|//)[ \t]*")
	// mirrorClaimRe matches the exact phrase this file's contract is written in.
	mirrorClaimRe = regexp.MustCompile("(?i)mirrors the go `([^`]+)`")
)

// mirrorClaims returns the claims the console makes, EXACTLY AS WRITTEN — `verify.Report`,
// `RepoDigest`, `AddOnInstall.Source` — read out of the comments of an enrolled file. Derived
// from the source rather than listed, because a hand-kept inventory of what a guard watches
// stops covering silently and nothing says so.
//
// It used to reduce every claim to its last dotted segment, which reads `pkg.Type` correctly and
// `Type.Field` catastrophically: `AddOnInstall.Source` became the claim "Source", a name no Go
// type has, so nothing could ever answer it. Resolving the two readings is claimCoverage's job,
// and it cannot do it on a name whose owner has already been thrown away.
func mirrorClaims(raw string) ([]string, error) {
	flat := commentContinuationRe.ReplaceAllString(raw, " ")
	seen := map[string]bool{}
	var out []string
	for _, m := range mirrorClaimRe.FindAllStringSubmatch(flat, -1) {
		name := strings.TrimSpace(m[1])
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("found no `Mirrors the Go X` claims in the source — the phrase " +
			"changed, and this check would then police an empty set")
	}
	slices.Sort(out)
	return out, nil
}

// lastSegment is the part of a dotted name after the final dot — the TYPE in `verify.Report`,
// and the FIELD in `AddOnInstall.Source`. Which of the two a claim means is decided by
// claimCoverage, never here.
func lastSegment(s string) string {
	if i := strings.LastIndex(s, "."); i >= 0 {
		return s[i+1:]
	}
	return s
}

// symbolClaim is a claim whose Go side is NOT a struct: a function the console re-implements.
// No fixture pair can express "these two verifiers agree" — the console's copy runs in Node and
// this test runs in Go, and the agreement is behavioural rather than structural.
//
// What a symbol claim locks is strictly weaker and is stated as such: that the Go symbol the
// comment names still EXISTS, with the signature the comment's claim depends on. That is the
// drift a rename or a deletion causes, and it is the drift that leaves the console pointing at
// nothing. It is not a proof that the two implementations agree, and nothing here says it is.
type symbolClaim struct {
	// Claim is the text inside the backticks, as the console writes it.
	Claim string
	// GoPath is the Go source file, relative to packages/core.
	GoPath string
	// Decl must match the declaration in that file. It pins the SIGNATURE, not just the name,
	// so a symbol that survives as something else — a variable, a method, a differently-shaped
	// function — is reported rather than silently accepted.
	Decl *regexp.Regexp
	// Why records what this claim cannot be, so the weaker lock is never read as the strong one.
	Why string
}

func symbolClaims() []symbolClaim {
	return []symbolClaim{
		{
			Claim:  "verify.VerifyAnchor",
			GoPath: filepath.Join("..", "verify", "rekor.go"),
			Decl:   regexp.MustCompile(`(?m)^func VerifyAnchor\(r Receipt, a \*RekorAnchor, logKey \*ecdsa\.PublicKey\) error \{`),
			Why: "verify.VerifyAnchor is a FUNCTION, and " + tsFileAnchor + " re-implements its " +
				"offline checks in Node. A fixture pair locks a wire SHAPE; there is no shape here " +
				"to lock, and the behavioural agreement is pinned on each side by its own tests " +
				"(verify/rekor_test.go and the console's vitest suite). What is locked here is that " +
				"the Go symbol the console names still exists with that signature.",
		},
	}
}

// assertSymbolDeclared is the symbol lock. Split out from its test so the mutation control can
// call the same function on a claim that is known to be wrong.
func assertSymbolDeclared(sc symbolClaim) error {
	raw, err := os.ReadFile(sc.GoPath)
	if err != nil {
		return fmt.Errorf("`%s`: read %s: %w", sc.Claim, sc.GoPath, err)
	}
	if !sc.Decl.Match(raw) {
		return fmt.Errorf("`%s` is claimed as mirrored but %s declares nothing matching %s — "+
			"the symbol was renamed, deleted or reshaped, and the console comment now points at "+
			"nothing. Fix the claim or fix the regex; do not delete the lock.",
			sc.Claim, sc.GoPath, sc.Decl)
	}
	return nil
}

// TestJSONBMirror_SymbolClaimsResolve runs the symbol locks.
func TestJSONBMirror_SymbolClaimsResolve(t *testing.T) {
	for _, sc := range symbolClaims() {
		t.Run(sc.Claim, func(t *testing.T) {
			if err := assertSymbolDeclared(sc); err != nil {
				t.Errorf("%v", err)
			}
		})
	}
}

// TestJSONBMirror_SymbolClaimLockFires proves the symbol lock can say no — both when the file is
// there and the declaration is not, and when the file itself is gone. A "found nothing" that
// reads as "nothing is wrong" is the failure mode every source-reading guard in this file is
// built against.
func TestJSONBMirror_SymbolClaimLockFires(t *testing.T) {
	real := symbolClaims()[0]

	renamed := real
	renamed.Decl = regexp.MustCompile(`(?m)^func NoSuchSymbolAnywhere\(`)
	assertReports(t, "symbol lock (declaration absent)", assertSymbolDeclared(renamed), renamed.GoPath)

	moved := real
	moved.GoPath = filepath.Join("..", "verify", "no_such_file.go")
	assertReports(t, "symbol lock (file absent)", assertSymbolDeclared(moved), "no_such_file.go")

	// And the real one must still resolve, or the two controls above prove nothing about it.
	if err := assertSymbolDeclared(real); err != nil {
		t.Errorf("the real symbol claim does not resolve: %v", err)
	}
}

// unlockableClaims are the `Mirrors the Go X` claims that CANNOT become a fixture pair, each
// with the reason it cannot. It is deliberately a code-level list rather than prose: an entry
// here is the only way past the test below, so adding one is a visible act in a diff.
//
// Empty today, and it stays empty on purpose. The two non-coverages in this file's header are
// VALUE vocabularies whose interfaces are locked, and the one claim with no struct behind it —
// verify.VerifyAnchor — is a symbolClaim, which locks something rather than merely naming what
// it does not lock. An entry here is the last resort, not the first.
var unlockableClaims = map[string]string{}

// TestJSONBMirror_EveryClaimIsLockedOrNamed is what keeps this file honest as the console grows.
// The set of claims is DERIVED from every enrolled console source; each one must be answered by
// a fixture pair, by a value vocabulary, by a symbol claim, or by a named entry in
// unlockableClaims. A new `Mirrors the Go X` comment therefore turns this red until it is locked
// or its exemption is written down — which is the failure the review found by hand: three claims
// existed that the header did not mention and no pair covered.
func TestJSONBMirror_EveryClaimIsLockedOrNamed(t *testing.T) {
	total := 0
	for _, file := range tsMirrorFiles() {
		t.Run(file, func(t *testing.T) {
			claims, err := mirrorClaims(consoleSourceRaw(t, file))
			if err != nil {
				t.Fatalf("%s: %v", file, err)
			}
			total += len(claims)
			if err := assertClaimsCovered(claims); err != nil {
				t.Errorf("%s: %v", file, err)
				return // never follow a failure with a line that reads like an all-clear.
			}
			t.Logf("%s: %d claims, all covered", file, len(claims))
		})
	}
	t.Logf("%d claims across %d enrolled files", total, len(tsMirrorFiles()))
}

// assertClaimsCovered is the guard: it reports every claim that no pair, vocabulary, symbol lock
// or named exemption answers. Separated from the test so the mutation test below can call it on
// a claim set that is known to be uncovered, rather than restating its logic.
func assertClaimsCovered(claims []string) error {
	covered := coveredTypes()
	var problems []string
	for _, c := range claims {
		if err := claimCoverage(covered, c); err != nil {
			problems = append(problems, err.Error())
		}
	}
	if problems == nil {
		return nil
	}
	return fmt.Errorf("these `Mirrors the Go X` claims are not locked:\n  %s\n"+
		"Add a mirrorPairs entry (a fixture is all it needs), a symbolClaim when the Go side is a "+
		"function, or — if the claim genuinely cannot be expressed as either — add it to "+
		"unlockableClaims WITH its reason. A claim that is none of those is the "+
		"comment-without-a-mechanism this whole file exists to abolish.",
		strings.Join(problems, "\n  "))
}

// coveredTypes maps a locked Go TYPE name to the struct type behind it, or to nil when the thing
// that answers the claim has no struct (a value vocabulary, a symbol claim). The reflect.Type is
// what lets a `Type.Field` claim be checked against the real field set rather than waved through.
func coveredTypes() map[string]reflect.Type {
	covered := map[string]reflect.Type{}
	for _, p := range mirrorPairs() {
		t := reflect.TypeOf(p.New())
		for t.Kind() == reflect.Pointer {
			t = t.Elem()
		}
		covered[lastSegment(p.GoName)] = t
	}
	for _, v := range valueVocabularies() {
		if v.GoType != "" {
			covered[lastSegment(v.GoType)] = nil
		}
	}
	for _, sc := range symbolClaims() {
		covered[lastSegment(sc.Claim)] = nil
	}
	return covered
}

// claimCoverage answers ONE claim, resolving the two ways a dotted claim can be read:
//
//	pkg.Type    — the last segment names the locked type          (verify.Report)
//	Type.Field  — the OWNER is the locked type, the last segment
//	              is one of its Go fields                          (AddOnInstall.Source)
//
// The second reading is not a wave-through: the field must actually exist on the locked Go
// struct. A claim that a console property mirrors `AddOnInstall.PodSecurity` therefore goes red
// when that Go field is renamed — which is the whole difference between a comment and a lock.
func claimCoverage(covered map[string]reflect.Type, claim string) error {
	if _, ok := covered[lastSegment(claim)]; ok {
		return nil
	}
	if unlockableClaims[lastSegment(claim)] != "" {
		return nil
	}
	if i := strings.LastIndex(claim, "."); i >= 0 {
		owner, field := lastSegment(claim[:i]), claim[i+1:]
		if t, ok := covered[owner]; ok {
			if t == nil {
				// The owner is locked by something with no struct behind it, so there is no
				// field set to check the second half against. Refusing is the honest answer:
				// accepting would report a field claim as locked by a lock that cannot see it.
				return fmt.Errorf("`%s`: %s is locked by a vocabulary or a symbol claim, which "+
					"has no field set — a field-level claim on it cannot be checked", claim, owner)
			}
			if f, ok := t.FieldByName(field); ok && f.IsExported() {
				return nil
			}
			return fmt.Errorf("`%s`: %s is locked, but %s declares no exported field %q — the "+
				"Go field was renamed or removed and the console comment still names it",
				claim, owner, t, field)
		}
	}
	return fmt.Errorf("`%s`: nothing here locks it", claim)
}

// TestJSONBMirror_NoOrphanFixtures pairs the fixture DIRECTORY against the pair table in both
// directions. A fixture left behind when its pair was deleted is a lock that stopped running
// while its evidence stayed in the tree, which reads to the next person as coverage.
func TestJSONBMirror_NoOrphanFixtures(t *testing.T) {
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatalf("read %s: %v", fixtureDir, err)
	}
	var onDisk []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			onDisk = append(onDisk, e.Name())
		}
	}
	var referenced []string
	for _, p := range mirrorPairs() {
		referenced = append(referenced, p.Fixture)
	}
	slices.Sort(onDisk)
	slices.Sort(referenced)
	if err := diffFieldSets("the pair table", referenced, fixtureDir, onDisk); err != nil {
		t.Errorf("%v", err)
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
	srcs := consoleSources(t)
	const probe = "__mirror_drift_probe__"

	for _, p := range mirrorPairs() {
		t.Run(p.TSName, func(t *testing.T) {
			raw := readFixture(t, p.Fixture)
			goFields, err := goJSONFields(reflect.TypeOf(p.New()))
			if err != nil {
				t.Fatalf("%s: %v", p.GoName, err)
			}
			tsFields, err := tsInterfaceFields(srcs[p.TSFile], p.TSName)
			if err != nil {
				t.Fatalf("%s: %v", p.TSFile, err)
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

// TestJSONBMirror_ClaimInventoryLockFires proves the inventory check can actually say no, and —
// the part that matters more — that the derivation SEES a claim written the way the console
// really writes them. A claim regex that silently matched nothing would leave the whole check
// policing an empty set while reporting success.
func TestJSONBMirror_ClaimInventoryLockFires(t *testing.T) {
	// A wrapped claim is the normal case in this file: the phrase ends one comment line and the
	// backticked type opens the next. Missing those would under-report the inventory silently.
	wrapped := "/**\n * One resource that has drifted — mirrors the Go\n * `drift.ResourceDrift` (packages/core/drift).\n */"
	got, err := mirrorClaims(wrapped)
	if err != nil {
		t.Fatalf("a wrapped claim was not seen at all: %v", err)
	}
	if !slices.Equal(got, []string{"drift.ResourceDrift"}) {
		t.Errorf("wrapped claim parsed as %v, want [drift.ResourceDrift]", got)
	}
	// A single-line claim, and a bare (undotted) type name, both count.
	if got, err := mirrorClaims("// Mirrors the Go `RepoDigest` (packages/core/types)."); err != nil || !slices.Equal(got, []string{"RepoDigest"}) {
		t.Errorf("single-line claim parsed as %v (err %v), want [RepoDigest]", got, err)
	}
	// A FIELD-level claim keeps its owner. Reducing it to its last segment — which is what this
	// parser used to do — turns `AddOnInstall.Source` into the claim "Source", which no Go type
	// answers and no lock can ever cover.
	if got, err := mirrorClaims("// Mirrors the Go `AddOnInstall.Source`."); err != nil || !slices.Equal(got, []string{"AddOnInstall.Source"}) {
		t.Errorf("field-level claim parsed as %v (err %v), want [AddOnInstall.Source]", got, err)
	}
	// Nothing to find must be an error, not an empty pass.
	if _, err := mirrorClaims("// this file makes no claims at all"); err == nil {
		t.Error("mirrorClaims accepted a source with no claims — the check would police nothing")
	}
	// And an uncovered claim must be named, while a covered one must not be dragged in with it.
	err = assertClaimsCovered([]string{"argocd.AddOnHealth", "NothingLocksThis"})
	assertReports(t, "claim-inventory lock", err, "NothingLocksThis")
	if err != nil && strings.Contains(err.Error(), "AddOnHealth") {
		t.Errorf("a covered claim was reported as uncovered: %v", err)
	}

	// ── the field-claim reading, in both directions ──
	//
	// A field that exists is covered by its owner's pair; a field that does NOT exist must be
	// reported, or the reading would wave through every `Type.Field` claim ever written and the
	// five such claims in the add-on spec would be locked in name only.
	if err := assertClaimsCovered([]string{"AddOnInstall.PodSecurity"}); err != nil {
		t.Errorf("a real field of a locked type was reported as uncovered: %v", err)
	}
	assertReports(t, "field-claim lock", assertClaimsCovered([]string{"AddOnInstall.NoSuchField"}), "NoSuchField")
	// An UNLOCKED owner is not made covered by having a plausible-looking field name after it.
	assertReports(t, "field-claim lock (owner unlocked)", assertClaimsCovered([]string{"NoSuchType.Name"}), "NoSuchType.Name")
	// A symbol claim covers its own name and nothing beneath it: there is no field set to check.
	if err := assertClaimsCovered([]string{"verify.VerifyAnchor"}); err != nil {
		t.Errorf("the symbol claim did not cover itself: %v", err)
	}
	assertReports(t, "field-claim lock (owner has no field set)",
		assertClaimsCovered([]string{"VerifyAnchor.Something"}), "no field set")
}

// TestJSONBMirror_VocabularyLockFires proves the value-vocabulary comparison speaks when the two
// sides disagree, by handing the real comparator a vocabulary with one value added and one
// dropped. Without this the vocabulary test would be indistinguishable from one that always
// finds the sets equal.
func TestJSONBMirror_VocabularyLockFires(t *testing.T) {
	src := consoleSource(t, tsMirrorFile)
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

// TestJSONBMirror_GoFieldsMatchEncodingJSON pins the field walkers against the only authority
// that matters: what `encoding/json` ACTUALLY does. Every expectation below is read off a real
// marshal rather than written out here, so this test cannot agree with a wrong implementation by
// having been built from it.
func TestJSONBMirror_GoFieldsMatchEncodingJSON(t *testing.T) {
	type promoted struct {
		Kind string `json:"kind"`
	}
	type invisible string

	// ── Case 1: the ordinary shape. The tag rules, `json:"-"`, and the untagged default must
	// produce exactly the keys encoding/json writes — no more, no fewer.
	t.Run("plain fields match the marshalled keys", func(t *testing.T) {
		type sample struct {
			Address  string `json:"address"`
			Ignored  string `json:"-"`
			Untagged string
			hidden   string //nolint:unused // an unexported non-embedded field is off the wire
		}
		raw, err := json.Marshal(sample{Address: "a.b", Ignored: "x", Untagged: "u", hidden: "h"})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		want, err := fixtureKeys(raw)
		if err != nil {
			t.Fatalf("%v", err)
		}
		got, err := goJSONFields(reflect.TypeOf(sample{}))
		if err != nil {
			t.Fatalf("goJSONFields: %v", err)
		}
		if !slices.Equal(got, want) {
			t.Errorf("goJSONFields disagrees with encoding/json.\n  goJSONFields: %v\n  marshalled:   %v", got, want)
		}
	})

	// ── Case 2: the one the `!IsExported()` shortcut got wrong. reflect calls an embedded
	// unexported STRUCT field unexported, but encoding/json promotes its tagged fields onto the
	// wire. Skipping it would drop a REAL key from every comparison in this file and report
	// green over it. The contract here is to REFUSE, not to model promotion — but the refusal
	// has to be reachable, which is exactly what it was not.
	t.Run("an embedded unexported struct is refused, not skipped", func(t *testing.T) {
		type sample struct {
			promoted
			Address string `json:"address"`
		}
		raw, err := json.Marshal(sample{promoted: promoted{Kind: "modified"}, Address: "a.b"})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		emitted, err := fixtureKeys(raw)
		if err != nil {
			t.Fatalf("%v", err)
		}
		if !slices.Contains(emitted, "kind") {
			t.Fatalf("premise broken: encoding/json no longer promotes an embedded unexported "+
				"struct's fields (emitted %v). Re-derive this test from the new behaviour.", emitted)
		}
		got, err := goJSONFields(reflect.TypeOf(sample{}))
		if err == nil {
			t.Errorf("goJSONFields returned %v with no error, but encoding/json writes %v — "+
				"the promoted key %q is on the wire and outside this lock", got, emitted, "kind")
		}
	})

	// ── Case 3: an embedded unexported NON-struct really is invisible to encoding/json, so
	// refusing it would be a false alarm. The two cases differ only by the embedded type's kind.
	t.Run("an embedded unexported non-struct is genuinely off the wire", func(t *testing.T) {
		type sample struct {
			invisible
			Address string `json:"address"`
		}
		raw, err := json.Marshal(sample{invisible: "i", Address: "a.b"})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		want, err := fixtureKeys(raw)
		if err != nil {
			t.Fatalf("%v", err)
		}
		got, err := goJSONFields(reflect.TypeOf(sample{}))
		if err != nil {
			t.Fatalf("goJSONFields refused a field encoding/json ignores: %v", err)
		}
		if !slices.Equal(got, want) {
			t.Errorf("goJSONFields %v, encoding/json %v", got, want)
		}
	})

	// ── The anti-vacuity walker must make the same decisions, from the same function. A field
	// goJSONFields reports and zeroValuedFields skips is a field that can arrive empty unnoticed.
	t.Run("zeroValuedFields makes the same decisions", func(t *testing.T) {
		type sample struct {
			invisible
			Address  string `json:"address"`
			Untagged string
		}
		fields, err := goJSONFields(reflect.TypeOf(sample{}))
		if err != nil {
			t.Fatalf("%v", err)
		}
		zero, err := zeroValuedFields(&sample{})
		if err != nil {
			t.Fatalf("%v", err)
		}
		if !slices.Equal(zero, fields) {
			t.Errorf("an all-zero value should report every wire field as zero.\n  zeroValuedFields: %v\n  goJSONFields:     %v", zero, fields)
		}
		// And the inverse: a value with every wire field set reports none — including when the
		// off-wire embedded field is the only thing populated, which must not count as coverage.
		full, err := zeroValuedFields(&sample{invisible: "i", Address: "a.b", Untagged: "u"})
		if err != nil {
			t.Fatalf("%v", err)
		}
		if len(full) != 0 {
			t.Errorf("a fully populated value reported %v as zero", full)
		}
		offWireOnly, err := zeroValuedFields(&sample{invisible: "i"})
		if err != nil {
			t.Fatalf("%v", err)
		}
		if !slices.Equal(offWireOnly, fields) {
			t.Errorf("setting only the off-wire embedded field must leave every wire field zero: %v", offWireOnly)
		}
	})
}

// TestJSONBMirror_TSParserSurvivesCommentsAndLiterals guards the two assumptions the TypeScript
// parsing rests on: comments are removed, and string literals are neither mangled nor counted as
// structure.
//
// The fixture puts a hostile literal — one holding `}`, `]` and `;` — BEFORE other properties on
// purpose. An earlier version of this test placed the brace-bearing literal on the LAST property
// and passed for the wrong reason: the depth counter went to -1 there, no later `;` or newline
// flushed a segment, and the final property was recovered only by the unconditional flush after
// the loop. Anything declared after it would have been swallowed into the previous segment and
// dropped — and a property dropped from the parsed set makes the console↔fixture comparison
// agree over a property the console really declares. Every hostile literal below is therefore
// followed by at least one more property.
func TestJSONBMirror_TSParserSurvivesCommentsAndLiterals(t *testing.T) {
	const src = "export interface X {\n" +
		"\t/** health ∈ {Healthy, Degraded} — braces and a ; inside a doc comment. */\n" +
		"\tmode: \"gitops\" | \"direct\"; // trailing comment with a } in it\n" +
		"\tclosing: \"a } b\";\n" +
		"\tafterBrace: string;\n" +
		"\tbracket: \"x ] y\";\n" +
		"\tafterBracket: number;\n" +
		"\tsemi: \"p ; q\";\n" +
		"\tafterSemi: boolean;\n" +
		"}\n" +
		"\n" +
		"export type Vocab = \"a ; b\" | \"c }\";\n"

	stripped := stripTSComments(src)
	if strings.Contains(stripped, "Healthy") || strings.Contains(stripped, "trailing comment") {
		t.Fatalf("comments survived stripping:\n%s", stripped)
	}
	if !strings.Contains(stripped, `"a } b"`) || !strings.Contains(stripped, `"p ; q"`) {
		t.Fatalf("a string literal was mangled by the stripper:\n%s", stripped)
	}

	// Every declared property must come back — especially the ones AFTER a hostile literal.
	fields, err := tsInterfaceFields(stripped, "X")
	if err != nil {
		t.Fatalf("%v", err)
	}
	want := []string{"afterBrace", "afterBracket", "afterSemi", "bracket", "closing", "mode", "semi"}
	if !slices.Equal(fields, want) {
		t.Errorf("properties were lost to a literal.\n  got:  %v\n  want: %v", fields, want)
	}

	// The interface body must not be truncated at the `}` inside a literal either — if it were,
	// nothing after `closing` would be visible at all.
	if _, err := tsPropertyUnion(stripped, "X", "mode"); err != nil {
		t.Errorf("tsPropertyUnion: %v", err)
	}

	// A `;` inside a union member must not end the declaration early.
	vocab, err := tsUnionLiterals(stripped, "Vocab")
	if err != nil {
		t.Fatalf("tsUnionLiterals: %v", err)
	}
	if !slices.Equal(vocab, []string{"a ; b", "c }"}) {
		t.Errorf("union literals were truncated by punctuation inside them: %v", vocab)
	}

	// maskTSStrings must be index-for-index substitutable for the source it masks, or every
	// span it locates would slice the original at the wrong offset.
	if masked := maskTSStrings(src); len(masked) != len(src) {
		t.Errorf("mask changed the length: %d vs %d", len(masked), len(src))
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
