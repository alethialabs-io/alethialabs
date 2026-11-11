// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/alethialabs-io/alethialabs/packages/core/imagebuild"
	"github.com/alethialabs-io/alethialabs/packages/core/kubeaccess"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestByoProjectName covers slug sanitization: lowercasing, non-alnum collapse, trimming, the
// empty fallback, and the 63-char RFC1123 cap.
func TestByoProjectName(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"payments", "byo-payments"},
		{"My Project!", "byo-my-project"},
		{"  spaced  ", "byo-spaced"},
		{"UPPER_snake.Case", "byo-upper-snake-case"},
		{"", "byo-project"},
		{"---", "byo-project"},
		{strings.Repeat("a", 80), "byo-" + strings.Repeat("a", 59)}, // capped at 63
	}
	for _, tt := range tests {
		got := ByoProjectName(tt.in)
		if got != tt.want {
			t.Errorf("ByoProjectName(%q) = %q, want %q", tt.in, got, tt.want)
		}
		if len(got) > 63 {
			t.Errorf("ByoProjectName(%q) length %d exceeds 63", tt.in, len(got))
		}
	}
}

// TestByoRepoSecretName is deterministic + per-repo distinct + prefixed.
func TestByoRepoSecretName(t *testing.T) {
	a := ByoRepoSecretName("https://github.com/acme/payments-helm")
	b := ByoRepoSecretName("https://github.com/acme/payments-helm")
	c := ByoRepoSecretName("https://github.com/acme/other")
	if a != b {
		t.Errorf("not deterministic: %q vs %q", a, b)
	}
	if a == c {
		t.Errorf("distinct repos collided: %q", a)
	}
	if !strings.HasPrefix(a, "repo-byo-") {
		t.Errorf("missing prefix: %q", a)
	}
}

// TestRenderByoAppProject asserts the hardened defaults: repos + namespaces locked, cluster-scoped
// resources default-denied (empty whitelist), namespaced kinds limited to a whitelist (pinned under
// ArgoCD's matching by TestByoAppProjectAdmitsOnlyWorkloadKinds), RBAC/ServiceAccount
// namespace-blacklisted as well, and blank
// inputs deduped/dropped.
func TestRenderByoAppProject(t *testing.T) {
	out, err := RenderByoAppProject("byo-payments",
		[]string{"https://github.com/acme/payments-helm", "", "https://github.com/acme/payments-helm"},
		[]string{"payments", "payments", ""}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"name: byo-payments",
		"kind: AppProject",
		// Unquoted: yaml.v3 quotes only what NEEDS quoting, which is the point of marshalling.
		"- https://github.com/acme/payments-helm",
		"namespace: payments",
		"clusterResourceWhitelist: []",
		"namespaceResourceWhitelist:",
		"namespaceResourceBlacklist:",
		"kind: RoleBinding",
		"kind: ServiceAccount",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered AppProject missing %q:\n%s", want, out)
		}
	}
	// Dedupe: the repo appears exactly once, the namespace exactly once.
	if n := strings.Count(out, "payments-helm"); n != 1 {
		t.Errorf("expected repo once (deduped), got %d:\n%s", n, out)
	}
	if n := strings.Count(out, "namespace: payments"); n != 1 {
		t.Errorf("expected namespace once (deduped), got %d:\n%s", n, out)
	}
	// A wide-open whitelist must never appear.
	if strings.Contains(out, `kind: "*"`) {
		t.Errorf("BYO AppProject must not whitelist all cluster resources:\n%s", out)
	}
}

// TestRenderAddOnApplication_GitSource covers a BYO chart: git path source (not chart), pinned to
// its byo project, and MANUAL sync (no automated/prune/self-heal block).
func TestRenderAddOnApplication_GitSource(t *testing.T) {
	out, err := RenderAddOnApplication(types.AddOnInstall{
		ID:        "payments",
		Mode:      "managed",
		Source:    "git",
		Project:   "byo-payments",
		ChartRepo: "https://github.com/acme/payments-helm",
		Path:      "charts/payments",
		Version:   "main",
		Namespace: "payments",
		Values:    map[string]interface{}{"replicas": 2},
		SyncWave:  5,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"project: byo-payments",
		"path: charts/payments",
		`targetRevision: main`,
		"alethia.io/addon-source: git",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("git-source Application missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "chart: ") {
		t.Errorf("git-source Application must not set a Helm `chart:`:\n%s", out)
	}
	// REVERSED by #2910, deliberately. This used to assert the Application carried NO `automated`
	// block at all — "manual-sync". That was never a working state: an Application without
	// `automated` syncs only when something triggers it, and nothing in production ever did, so a
	// customer's chart deployed nothing at all and reported no error. The intent behind the old
	// assertion was that an untrusted chart must not be PRUNED or SELF-HEALED, and that intent is
	// kept exactly — both sub-options are false.
	if !strings.Contains(out, "automated:") {
		t.Errorf("BYO Application must auto-sync, or it deploys nothing (#2910):\n%s", out)
	}
	if !strings.Contains(out, "prune: false") || !strings.Contains(out, "selfHeal: false") {
		t.Errorf("BYO Application must have prune and selfHeal explicitly false:\n%s", out)
	}
}

// TestRenderAddOnApplication_HelmDefault is the regression guard: a marketplace add-on
// (Source unset) still renders the Helm `chart:` source, the "infra" project, and automated sync.
func TestRenderAddOnApplication_HelmDefault(t *testing.T) {
	out, err := RenderAddOnApplication(types.AddOnInstall{
		ID:        "kube-prometheus-stack",
		ChartRepo: "https://prometheus-community.github.io/helm-charts",
		Chart:     "kube-prometheus-stack",
		Version:   "57.0.0",
		Namespace: "monitoring",
		Values:    map[string]interface{}{},
		SyncWave:  1,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"project: infra",
		"chart: kube-prometheus-stack",
		"automated:",
		"selfHeal: true",
		"alethia.io/addon-source: helm",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("marketplace Application missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "path: ") {
		t.Errorf("Helm-source Application must not set a git `path:`:\n%s", out)
	}
}

// TestRenderByoNamespaces_RendersOneNamespacePerDestination pins the fix for the BYO-IaC sync
// failure found on gcp's first real run: the chart's Application carries CreateNamespace=true, but
// the hardened AppProject forbids cluster-scoped resources, so ArgoCD could never create it and
// every BYO sync died with `namespaces "<ns>" not found`.
func TestRenderByoNamespaces_RendersOneNamespacePerDestination(t *testing.T) {
	out, err := RenderByoNamespaces([]string{"byo-e2e", "payments"}, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{"kind: Namespace", "name: byo-e2e", "name: payments", "\n---\n"} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered namespaces missing %q:\n%s", want, out)
		}
	}
	if got := strings.Count(out, "kind: Namespace"); got != 2 {
		t.Errorf("want 2 Namespace documents, got %d:\n%s", got, out)
	}
}

// TestRenderByoNamespaces_DedupesAndDropsBlanks — two charts sharing a namespace must not render it
// twice (a duplicate document makes the multi-doc apply non-idempotent), and a blank namespace must
// not render a nameless Namespace, which the API server would reject and take the whole apply with it.
func TestRenderByoNamespaces_DedupesAndDropsBlanks(t *testing.T) {
	out, err := RenderByoNamespaces([]string{"shared", "", "shared", "other"}, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := strings.Count(out, "kind: Namespace"); got != 2 {
		t.Errorf("want 2 deduped Namespace documents, got %d:\n%s", got, out)
	}
	if strings.Contains(out, "name: \n") || strings.Contains(out, "name:\n") {
		t.Errorf("a blank namespace rendered a nameless Namespace:\n%s", out)
	}
}

// TestRenderByoNamespaces_EmptyIsEmptyNotAnError — no BYO charts must yield nothing to apply, and
// specifically NOT an error: a project with no git-source add-ons is the common case, and an error
// there would print a warning on every ordinary deploy.
func TestRenderByoNamespaces_EmptyIsEmptyNotAnError(t *testing.T) {
	for _, in := range [][]string{nil, {}, {""}, {"", ""}} {
		out, err := RenderByoNamespaces(in, nil, nil)
		if err != nil {
			t.Errorf("RenderByoNamespaces(%q) errored: %v", in, err)
		}
		if out != "" {
			t.Errorf("RenderByoNamespaces(%q) = %q, want empty", in, out)
		}
	}
}

// TestRenderByoNamespaces_CarriesCommonLabels — the sweep/classification labels (BYOC B1.4) must
// land on the namespace too. A namespace the runner created but the sweeper cannot recognise is an
// orphan by construction, which is the leak shape this repo has already paid for twice.
func TestRenderByoNamespaces_CarriesCommonLabels(t *testing.T) {
	out, err := RenderByoNamespaces([]string{"byo-e2e"}, map[string]string{"alethia.io/project-id": "p-123"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "alethia.io/project-id: p-123") {
		t.Errorf("common labels not injected into the namespace:\n%s", out)
	}
	if !strings.Contains(out, "alethia.io/managed-by: byo-charts") {
		t.Errorf("namespace lost its managed-by label:\n%s", out)
	}
}

// TestByoAppProjectStillForbidsClusterResources is the OTHER direction, and the one that matters
// most. The bug is fixable two ways: create the namespace as the trusted runner (what we did), or
// let the untrusted chart create it by whitelisting Namespace on the AppProject (what we must never
// do). This test fails if anyone ever takes the second route, so the fix cannot be "corrected" into
// a hole in the trust boundary later.
func TestByoAppProjectStillForbidsClusterResources(t *testing.T) {
	out, err := RenderByoAppProject("byo-p", []string{"https://example.com/r"}, []string{"byo-e2e"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "clusterResourceWhitelist: []") {
		t.Errorf("the hardened BYO AppProject must keep an EMPTY clusterResourceWhitelist — the "+
			"namespace is created by the runner, never by the chart:\n%s", out)
	}
	if strings.Contains(out, "kind: Namespace") {
		t.Errorf("the AppProject must not whitelist Namespace:\n%s", out)
	}
}

// TestRenderByoNamespaces_RefusesYamlInjection is #2540: the namespace reached the renderer
// unvalidated (`z.string().trim().optional()`, no DNS-1123 check, a plain `text()` column, so
// interior newlines survive), was interpolated RAW into hand-rolled YAML, and the result was applied
// as a standalone MULTI-DOCUMENT manifest with the cluster's admin kubeconfig.
//
// So an injected `---` produced arbitrary top-level objects created by the runner — the exact
// cluster-scoped power the hardened AppProject exists to deny an untrusted chart. The fix that
// created the namespace in order to honour that boundary had opened a way around it.
//
// This is the payload from the issue, not a sanitised stand-in.
func TestRenderByoNamespaces_RefusesYamlInjection(t *testing.T) {
	payload := "byo-e2e\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: pwn"

	out, err := RenderByoNamespaces([]string{payload}, nil, nil)
	if err == nil {
		t.Fatalf("an injected document was ACCEPTED — rendered:\n%s", out)
	}
	if out != "" {
		t.Errorf("a refused render must return no manifest at all, got:\n%s", out)
	}

	// The full payload is caught by the LENGTH rule, which is luck rather than defence — so the
	// case that matters is a SHORT one, where length cannot save us and only the charset rule can.
	// 30 characters, still a complete second document.
	short := "a\n---\nkind: ClusterRoleBinding"
	if len(short) > dns1123LabelMaxLen {
		t.Fatalf("the short payload must be under the length limit or it proves nothing (%d chars)", len(short))
	}
	out, err = RenderByoNamespaces([]string{short}, nil, nil)
	if err == nil {
		t.Fatalf("a SHORT injected document was ACCEPTED — rendered:\n%s", out)
	}
	if !strings.Contains(err.Error(), "DNS-1123") {
		t.Errorf("the short payload must be refused by the DNS-1123 rule, not incidentally; got: %v", err)
	}

	// And the structural half: even with validation removed, marshalling alone must make a hostile
	// value one absurd NAME rather than a second document. Encode the payload directly to prove the
	// encoder quotes it.
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	if err := enc.Encode(map[string]any{"name": short}); err != nil {
		t.Fatalf("encode: %v", err)
	}
	_ = enc.Close()
	if strings.Contains(buf.String(), "\n---\n") {
		t.Errorf("the encoder emitted a document separator from a VALUE — marshalling is not containing it:\n%s", buf.String())
	}
}

// TestRenderByoNamespaces_RefusesNamesKubernetesWould is the general case behind the injection one.
// Refusing rather than normalising is deliberate: the SAME string is written into the hardened
// AppProject's `destinations`, so silently rewriting it here would produce a project whose
// destination never matches the namespace the chart syncs into — an ArgoCD permission error naming
// neither cause.
func TestRenderByoNamespaces_RefusesNamesKubernetesWould(t *testing.T) {
	for _, bad := range []string{
		"Byo-E2E",               // uppercase
		"byo_e2e",               // underscore
		"-byo",                  // leading dash
		"byo-",                  // trailing dash
		"byo e2e",               // space
		"byo/e2e",               // slash
		`byo"e2e`,               // a quote — would break OUT of the AppProject's quoted form
		strings.Repeat("a", 64), // one over the DNS-1123 label limit
	} {
		if _, err := RenderByoNamespaces([]string{bad}, nil, nil); err == nil {
			t.Errorf("namespace %q was accepted; Kubernetes would refuse it", bad)
		}
	}
	// …and the boundary case on the other side of the length rule is still fine.
	if _, err := RenderByoNamespaces([]string{strings.Repeat("a", 63)}, nil, nil); err != nil {
		t.Errorf("a 63-character label is legal and must be accepted: %v", err)
	}
}

// TestRenderByoNamespaces_IsDeterministic — the render is committed to nothing, but it IS applied on
// every deploy, and a manifest that differs between identical deploys makes `kubectl apply` churn
// and any diff meaningless. Go randomises map iteration; this pins that the encoder does not.
func TestRenderByoNamespaces_IsDeterministic(t *testing.T) {
	labels := map[string]string{"z": "1", "a": "2", "m": "3", "alethia.io/project-id": "p-123"}
	first, err := RenderByoNamespaces([]string{"byo-e2e", "payments"}, labels, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for i := 0; i < 25; i++ {
		got, err := RenderByoNamespaces([]string{"byo-e2e", "payments"}, labels, nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != first {
			t.Fatalf("render is not deterministic (iteration %d):\nfirst:\n%s\ngot:\n%s", i, first, got)
		}
	}
}

// TestByoAppProjectRefusesYamlInjection is the AppProject half of #2540. #2576 closed this hole in
// RenderByoNamespaces and left it open here — and because prepareByoCharts only WARNS when the
// namespace renderer refuses, the value it rejected still reached RenderByoAppProject, which
// rendered it into a quoted scalar with text/template's zero escaping.
func TestByoAppProjectRefusesYamlInjection(t *testing.T) {
	// The payload that actually worked, verbatim: close the quoted scalar, open a second document,
	// then a block scalar with an EXPLICIT indent indicator whose `#` swallows the template's own
	// closing quote and whose body absorbs the remainder of the AppProject. Rendered two valid
	// documents, the second a ClusterRoleBinding to cluster-admin, applied with the admin kubeconfig.
	const pwn = "x\"\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\n" +
		"metadata:\n  name: pwned-by-byo\nroleRef:\n  apiGroup: rbac.authorization.k8s.io\n" +
		"  kind: ClusterRole\n  name: cluster-admin\nsubjects:\n  - kind: ServiceAccount\n" +
		"    name: default\n    namespace: kube-system\nswallow: |2 #"

	for _, tc := range []struct{ name, ns string }{
		{"the full payload", pwn},
		// A SHORT one too. The long payload is caught by the 63-character rule, which is luck rather
		// than defence — #2576's own lesson. Only the charset rule catches this one.
		{"a short one", "a\n---\nkind: Secret"},
		{"a bare quote", `byo"e2e`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := RenderByoAppProject("byo-p", []string{"https://example.com/r"}, []string{tc.ns}, nil)
			if err == nil {
				t.Fatalf("expected a refusal, got none. Rendered:\n%s", out)
			}
			if out != "" {
				t.Errorf("a refusal must render nothing, got:\n%s", out)
			}
		})
	}
}

// TestByoAppProjectSourceRepoCannotEscapeItsScalar covers the OTHER interpolation point in the same
// template. A chart repo URL is user-supplied and was rendered raw beside the namespaces; a fix that
// only guarded destinations would have moved the payload one field over.
func TestByoAppProjectSourceRepoCannotEscapeItsScalar(t *testing.T) {
	bad := "https://example.com/r\n---\nkind: ClusterRoleBinding"
	if _, err := RenderByoAppProject("byo-p", []string{bad}, []string{"byo-e2e"}, nil); err == nil {
		t.Fatal("a source repo carrying a newline must be refused")
	}
	// …and the forms that legitimately occur must still render. A URL allowlist would have refused
	// these, which is worse than the gap it closes.
	for _, ok := range []string{
		"https://github.com/acme/c.git",
		"ssh://git@github.com/acme/c.git",
		"git@github.com:acme/c.git",
	} {
		if _, err := RenderByoAppProject("byo-p", []string{ok}, []string{"byo-e2e"}, nil); err != nil {
			t.Errorf("legitimate repo %q was refused: %v", ok, err)
		}
	}
}

// TestByoAppProjectIsExactlyOneDocument is the structural half: whatever survives validation must
// never be able to add a document to the stream. Asserted by DECODING rather than by string match,
// because "no `---` in the output" is a weaker claim than "this parses to one object".
func TestByoAppProjectIsExactlyOneDocument(t *testing.T) {
	out, err := RenderByoAppProject("byo-p",
		[]string{"https://example.com/r"}, []string{"byo-e2e", "payments"},
		map[string]string{"alethia.io/project-id": "p-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	dec := yaml.NewDecoder(strings.NewReader(out))
	n := 0
	for {
		var doc yaml.Node
		if err := dec.Decode(&doc); err != nil {
			break
		}
		if len(doc.Content) > 0 {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("the AppProject must be exactly one document, got %d:\n%s", n, out)
	}
}

// TestByoAppProjectWhitelistIsEmptyNotNull pins the one field the whole hardening rests on.
// yaml.v3 marshals a NIL slice as `null`, and `clusterResourceWhitelist: null` is not the same
// statement as `clusterResourceWhitelist: []`. Nothing but this test stands between the two.
func TestByoAppProjectWhitelistIsEmptyNotNull(t *testing.T) {
	out, err := RenderByoAppProject("byo-p", []string{"https://example.com/r"}, []string{"byo-e2e"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "clusterResourceWhitelist: []") {
		t.Errorf("clusterResourceWhitelist must render as an empty LIST:\n%s", out)
	}
	if strings.Contains(out, "clusterResourceWhitelist: null") {
		t.Errorf("clusterResourceWhitelist rendered as null — a nil slice, not an empty one:\n%s", out)
	}
}

// TestEncodeByoDocsSeparatesEveryDocument pins what the shared encoder is actually for: N values in,
// one stream out, with a separator between documents and none before the first. RenderByoNamespaces
// depends on that exactly — the template it replaced wrote `{{ if $i }}---` by hand.
//
// It does NOT test the error arms, and the reason is worth recording. I tried to reach them by
// handing the encoder a channel; yaml.v3 PANICS on an unmarshalable type rather than returning an
// error ("cannot marshal type: chan int"). So `Encode` errors only on a write failure, and both
// callers write to a bytes.Buffer, which does not fail. The arms are genuinely unreachable rather
// than merely untested, which is why factoring them into ONE copy was the right answer to the
// coverage ratchet instead of writing a test that only appeared to exercise them.
func TestEncodeByoDocsSeparatesEveryDocument(t *testing.T) {
	out, err := encodeByoDocs("test",
		map[string]any{"kind": "A"},
		map[string]any{"kind": "B"},
		map[string]any{"kind": "C"},
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n := strings.Count(out, "\n---\n"); n != 2 {
		t.Errorf("three documents want two separators, got %d:\n%s", n, out)
	}
	if strings.HasPrefix(out, "---") {
		t.Errorf("the stream must not open with a separator:\n%s", out)
	}
	dec := yaml.NewDecoder(strings.NewReader(out))
	kinds := []string{}
	for {
		var doc map[string]any
		if err := dec.Decode(&doc); err != nil {
			break
		}
		if k, ok := doc["kind"].(string); ok {
			kinds = append(kinds, k)
		}
	}
	if strings.Join(kinds, ",") != "A,B,C" {
		t.Errorf("documents round-trip in order, got %v:\n%s", kinds, out)
	}
}

// ─────────────────────────── reserved platform namespaces (#6439) ───────────────────────────

// byoReservedGroup returns one group of byo_reserved_namespaces.json by id, failing when it is gone —
// a renamed group must red here rather than make the pin below compare against nothing.
func byoReservedGroup(t *testing.T, id string) []string {
	t.Helper()
	var list byoReservedNamespaceList
	if err := json.Unmarshal(byoReservedNamespacesJSON, &list); err != nil {
		t.Fatalf("byo_reserved_namespaces.json: %v", err)
	}
	for _, g := range list.Groups {
		if g.ID == id {
			return g.Namespaces
		}
	}
	t.Fatalf("byo_reserved_namespaces.json has no %q group", id)
	return nil
}

// sortedSet returns the distinct values of in, sorted, so two sets compare with reflect.DeepEqual.
func sortedSet(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}

// TestValidateByoNamespace_RefusesEveryReservedNamespace is the property: a BYO chart's destination is
// never a reserved platform namespace. EVERY name in EVERY group is driven through the validator and
// through both renderers that call it, and each refusal must name the namespace and say "reserved", so
// the person reading the deploy log or the form is told what to change.
func TestValidateByoNamespace_RefusesEveryReservedNamespace(t *testing.T) {
	var list byoReservedNamespaceList
	if err := json.Unmarshal(byoReservedNamespacesJSON, &list); err != nil {
		t.Fatalf("byo_reserved_namespaces.json: %v", err)
	}
	total := 0
	for _, g := range list.Groups {
		for _, ns := range g.Namespaces {
			total++
			if ByoNewlyReservedNamespaceReason(ns) != "" {
				// #6551: reserved only by a byoAttached "warn" group — an attached chart there is
				// REPORTED and kept (TestByoNewlyReserved_*), not refused.
				continue
			}
			err := validateByoNamespace(ns)
			if err == nil {
				t.Errorf("group %s: namespace %q accepted; it is reserved for the platform", g.ID, ns)
				continue
			}
			if !strings.Contains(err.Error(), "reserved") || !strings.Contains(err.Error(), ns) {
				t.Errorf("group %s: the refusal of %q must name it and say it is reserved, got: %v", g.ID, ns, err)
			}
			if _, err := RenderByoNamespaces([]string{"payments", ns}, nil, nil); err == nil {
				t.Errorf("RenderByoNamespaces accepted reserved %q", ns)
			}
			if _, err := RenderByoAppProject("byo-p", []string{"https://example.com/r"}, []string{ns}, nil); err == nil {
				t.Errorf("RenderByoAppProject accepted reserved %q", ns)
			}
		}
	}
	// The issue names these explicitly; assert them by NAME so a group reshuffle cannot drop one.
	for _, ns := range []string{"kube-system", "kube-public", "kube-node-lease", "argocd", "cert-manager", "external-secrets-operator", "ingress-nginx", "datadog"} {
		if validateByoNamespace(ns) == nil {
			t.Errorf("namespace %q must be refused", ns)
		}
	}
	if total < 20 {
		t.Fatalf("only %d reserved names were exercised — the list did not load", total)
	}
}

// TestValidateByoNamespace_RefusesReservedPrefixes covers the prefix half: a namespace Kubernetes
// reserves by convention, and a virtual cluster's host namespace, are refused whatever follows.
func TestValidateByoNamespace_RefusesReservedPrefixes(t *testing.T) {
	for _, ns := range []string{"kube-flannel", "kube-anything", "vcluster-dev", "vcluster-a"} {
		err := validateByoNamespace(ns)
		if err == nil || !strings.Contains(err.Error(), "reserved") {
			t.Errorf("namespace %q must be refused as reserved, got %v", ns, err)
		}
	}
}

// TestValidateByoNamespace_AcceptsOrdinaryNamespaces — the refusal must not reach ordinary names,
// including a BYO chart's own default (byo-<chart id>) and names that merely CONTAIN a reserved word
// or prefix. "default" is not among them: it is reserved (#6446).
func TestValidateByoNamespace_AcceptsOrdinaryNamespaces(t *testing.T) {
	for _, ns := range []string{"payments", "byo-e2e", "byo-api", "kubernetes-dashboard", "my-kube-system", "vault-client", "monitoring-team", "vcluster", "apps"} {
		if err := validateByoNamespace(ns); err != nil {
			t.Errorf("ordinary namespace %q refused: %v", ns, err)
		}
	}
}

// TestValidateByoNamespace_ShapeIsCheckedBeforeReservation — a hostile value is reported as malformed,
// never echoed back as a "reserved" name.
func TestValidateByoNamespace_ShapeIsCheckedBeforeReservation(t *testing.T) {
	err := validateByoNamespace("kube-system\n---")
	if err == nil || !strings.Contains(err.Error(), "DNS-1123") {
		t.Fatalf("a malformed value must be refused for its shape first, got %v", err)
	}
}

// TestByoReserved_PlatformTemplatesMatchTheRenderedTemplates pins the platformTemplates group to the
// platform's own ArgoCD templates, in BOTH directions: a new platform add-on whose namespace is not in
// the list reds here, and so does a list entry no template installs into any more.
//
// The templates are RENDERED, not grepped: every InfraFacts string is filled and every bool set true
// by reflection, once per cloud, so each provider-gated Application renders; then every document is
// decoded and its metadata.namespace, spec.destination.namespace and spec.destinations[].namespace are
// read. BOUNDARY: an Application gated on a fact that a non-empty string / true bool does not satisfy
// (an `eq .X "literal"` other than Provider, or a non-empty DNSConnector) is not rendered, and so not
// seen — the equality below then reds on the listed namespace nothing rendered, which is how
// cert-manager and external-dns were found missing from the first version of this test.
func TestByoReserved_PlatformTemplatesMatchTheRenderedTemplates(t *testing.T) {
	got := []string{}
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba", "hetzner", "digitalocean", "civo"} {
		facts := &InfraFacts{}
		v := reflect.ValueOf(facts).Elem()
		for i := 0; i < v.NumField(); i++ {
			// Maps and slices keep their zero value. That leaves sections INSIDE an Application
			// unrendered (`if .Labels`), never a namespace; an Application gated on one would be the
			// boundary stated above.
			if f := v.Field(i); f.Kind() == reflect.String {
				f.SetString("placeholder")
			} else if f.Kind() == reflect.Bool {
				f.SetBool(true)
			}
		}
		facts.Provider = provider
		// The DNS connector is the one string whose non-empty value DISABLES a branch: anything but
		// ""/"native"/"cloudflare" turns the DNS provider off, and with it external-dns and cert-manager.
		facts.DNSConnector = ""
		outDir, err := RenderApplications(templatesDir(t), facts)
		if err != nil {
			t.Fatalf("%s: RenderApplications: %v", provider, err)
		}
		files, err := filepath.Glob(filepath.Join(outDir, "*.yaml"))
		if err != nil || len(files) == 0 {
			t.Fatalf("%s: no rendered templates in %s (%v)", provider, outDir, err)
		}
		for _, f := range files {
			raw, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			dec := yaml.NewDecoder(bytes.NewReader(raw))
			for {
				var doc struct {
					Metadata struct {
						Namespace string `yaml:"namespace"`
					} `yaml:"metadata"`
					Spec struct {
						Destination struct {
							Namespace string `yaml:"namespace"`
						} `yaml:"destination"`
						Destinations []struct {
							Namespace string `yaml:"namespace"`
						} `yaml:"destinations"`
					} `yaml:"spec"`
				}
				if err := dec.Decode(&doc); err != nil {
					if errors.Is(err, io.EOF) {
						break
					}
					t.Fatalf("%s: %s: %v", provider, filepath.Base(f), err)
				}
				cands := []string{doc.Metadata.Namespace, doc.Spec.Destination.Namespace}
				for _, d := range doc.Spec.Destinations {
					cands = append(cands, d.Namespace)
				}
				for _, n := range cands {
					if n != "" && n != "*" && n != "placeholder" {
						got = append(got, n)
					}
				}
			}
		}
		_ = os.RemoveAll(outDir)
	}
	want := sortedSet(byoReservedGroup(t, "platformTemplates"))
	if gotSet := sortedSet(got); !reflect.DeepEqual(gotSet, want) {
		t.Errorf("platformTemplates in byo_reserved_namespaces.json = %v\n"+
			"but infra/templates/argocd renders into %v.\n"+
			"Edit the group to match (and its mirror in apps/console/lib/validations/byo-reserved-namespaces.ts).", want, gotSet)
	}
}

// TestByoReserved_PlatformRuntimeMatchesTheRunnersNamespaces pins platformRuntime to the namespace
// constants the runner itself installs into, in both directions. BOUNDARY: Go cannot enumerate
// constants, so this list is the one hand-kept part; the vcluster host prefix is pinned from
// packages/core/provisioner, which owns that constant.
func TestByoReserved_PlatformRuntimeMatchesTheRunnersNamespaces(t *testing.T) {
	runtime := []string{
		argoPreflightNamespace,       // ArgoCD itself
		hetznerRegistryNamespace,     // in-cluster registry (harbor.go)
		hetznerVaultNamespace,        // in-cluster secrets backend (vault.go)
		hetznerQueueNamespace,        // in-cluster queue (rabbitmq.go)
		secretsSaaSNamespaceForStore, // External Secrets' SaaS store
		kubeaccess.DefaultReadOnlyNamespace,
		imagebuild.DefaultNamespace,
	}
	if got, want := sortedSet(runtime), sortedSet(byoReservedGroup(t, "platformRuntime")); !reflect.DeepEqual(got, want) {
		t.Errorf("platformRuntime in byo_reserved_namespaces.json = %v, the runner's namespace constants are %v", want, got)
	}
}

// TestByoReserved_CoversEveryCatalogueAddOnFixture checks, from a plain `go test`, that the
// marketplaceAddOns group EQUALS the namespaces in the generated add-on fixtures
// (test/e2e/fixtures/addon_catalog.<cloud>.json, which CI keeps in step with the console's
// ADDON_CATALOG), unioned across every cloud. Both directions: an unreserved fixture namespace reds, and
// so does a listed namespace no fixture installs into. BOUNDARY: an add-on offered on no fixture cloud
// is absent from the union; the console's vitest, which reads ADDON_CATALOG itself, still sees it.
func TestByoReserved_CoversEveryCatalogueAddOnFixture(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "..", "..", "test", "e2e", "fixtures", "addon_catalog.*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no add-on catalogue fixtures found (%v)", err)
	}
	group := map[string]bool{}
	for _, n := range byoReservedGroup(t, "marketplaceAddOns") {
		group[n] = true
	}
	seen := 0
	fixtureNamespaces := []string{}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var addons []struct {
			ID        string `json:"id"`
			Namespace string `json:"namespace"`
		}
		if err := json.Unmarshal(raw, &addons); err != nil {
			t.Fatalf("%s: %v", filepath.Base(f), err)
		}
		for _, a := range addons {
			seen++
			fixtureNamespaces = append(fixtureNamespaces, a.Namespace)
			if a.Namespace == "" {
				t.Errorf("%s: add-on %s has no namespace", filepath.Base(f), a.ID)
				continue
			}
			if !group[a.Namespace] {
				t.Errorf("%s: add-on %s installs into %q, which marketplaceAddOns does not reserve", filepath.Base(f), a.ID, a.Namespace)
			}
		}
	}
	if seen == 0 {
		t.Fatal("the fixtures held no add-ons — nothing was checked")
	}
	if got, want := sortedSet(fixtureNamespaces), sortedSet(byoReservedGroup(t, "marketplaceAddOns")); !reflect.DeepEqual(got, want) {
		t.Errorf("marketplaceAddOns in byo_reserved_namespaces.json = %v, the add-on fixtures install into %v", want, got)
	}
}

// helmBlockStart opens a tofu block that installs or renders a Helm chart into a namespace.
var helmBlockStart = regexp.MustCompile(`^(resource "helm_release"|data "helm_template") "[^"]+" \{\s*$`)

// helmNamespaceAttr is the block's top-level `namespace = ...` attribute, with its value captured raw.
var helmNamespaceAttr = regexp.MustCompile(`^\s*namespace\s*=\s*(.+?)\s*$`)

// TestByoReserved_PlatformCategoriesMatchTheTofuHelmInstalls pins platformCategories to the Helm
// charts the platform installs through tofu, in BOTH directions: every `resource "helm_release"` and
// `data "helm_template"` block in infra/templates/**/*.tf contributes its `namespace` attribute.
//
// BOUNDARY, stated because it is a line scan rather than an HCL parse: a block is recognised only when
// its header sits on one line in canonical `tofu fmt` form, and only its top-level `namespace` line is
// read (depth 1, by counting braces). A NON-LITERAL namespace (a variable, a local) FAILS the test
// rather than being skipped, so a value this scan cannot read is never counted as covered. A block
// with no namespace attribute installs into "default" and is skipped: "default" is reserved, but by
// the platformWorkloads group (#6446), not this one. Other ways to create a namespace in tofu (kubernetes_namespace, a raw manifest) are not
// read; none exist under infra/templates today.
func TestByoReserved_PlatformCategoriesMatchTheTofuHelmInstalls(t *testing.T) {
	root := filepath.Join("..", "..", "..", "infra", "templates")
	got := []string{}
	blocks := 0
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".tf") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		depth := 0
		in := false
		for i, line := range strings.Split(string(raw), "\n") {
			if !in {
				if helmBlockStart.MatchString(line) {
					in, depth = true, 1
					blocks++
				}
				continue
			}
			if depth == 1 {
				if m := helmNamespaceAttr.FindStringSubmatch(line); m != nil {
					v := m[1]
					if len(v) < 2 || v[0] != '"' || v[len(v)-1] != '"' || strings.Contains(v[1:len(v)-1], "${") {
						t.Errorf("%s:%d: helm namespace %s is not a string literal; this pin cannot read it", path, i+1, v)
					} else {
						got = append(got, v[1:len(v)-1])
					}
				}
			}
			depth += strings.Count(line, "{") - strings.Count(line, "}")
			if depth <= 0 {
				in = false
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if blocks == 0 {
		t.Fatal("no helm_release / helm_template block found under infra/templates — the scan matched nothing")
	}
	if gotSet, want := sortedSet(got), sortedSet(byoReservedGroup(t, "platformCategories")); !reflect.DeepEqual(gotSet, want) {
		t.Errorf("platformCategories in byo_reserved_namespaces.json = %v\n"+
			"but the tofu Helm installs under infra/templates use %v.\n"+
			"Edit the group to match (and its mirror in apps/console/lib/validations/byo-reserved-namespaces.ts).", want, gotSet)
	}
}

// argoResourceInList is ArgoCD's own matcher for an AppProject resource list (isResourceInList in
// pkg/apis/application/v1alpha1/types.go, unchanged from v2.13 through the pinned v3.3.9): an entry
// matches when filepath.Match accepts its kind AND its group. Restated here so the test below asks
// the question ArgoCD asks, not whether a string appears in the YAML.
func argoResourceInList(group, kind string, list []byoGroupKind) bool {
	for _, item := range list {
		if ok, err := filepath.Match(item.Kind, kind); ok && err == nil {
			if ok, err := filepath.Match(item.Group, group); ok && err == nil {
				return true
			}
		}
	}
	return false
}

// TestByoAppProjectDeniesSecretSyncKinds pins that a BYO chart reads only the secret material its
// declared bindings give it: ArgoCD refuses every external-secrets.io and
// generators.external-secrets.io kind the chart might declare. The kinds are the CRDs ESO 0.9.20 (the
// pinned chart, infra/templates/argocd/external-secrets-operator.yaml) ships under
// config/crds/bases. The two cluster-scoped ones are refused by the empty clusterResourceWhitelist,
// which is asserted too. Ordinary workload kinds must stay permitted, or the deny is "fixed" by
// refusing every chart.
func TestByoAppProjectDeniesSecretSyncKinds(t *testing.T) {
	out, err := RenderByoAppProject("byo-p", []string{"https://example.com/r"}, []string{"byo-e2e"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var proj byoAppProject
	if err := yaml.Unmarshal([]byte(out), &proj); err != nil {
		t.Fatalf("parse rendered AppProject: %v\n%s", err, out)
	}
	black := proj.Spec.NamespaceResourceBlacklist

	namespaced := []byoGroupKind{
		{"external-secrets.io", "ExternalSecret"},
		{"external-secrets.io", "SecretStore"},
		{"external-secrets.io", "PushSecret"},
		{"generators.external-secrets.io", "ACRAccessToken"},
		{"generators.external-secrets.io", "ECRAuthorizationToken"},
		{"generators.external-secrets.io", "Fake"},
		{"generators.external-secrets.io", "GCRAccessToken"},
		{"generators.external-secrets.io", "GithubAccessToken"},
		{"generators.external-secrets.io", "Password"},
		{"generators.external-secrets.io", "VaultDynamicSecret"},
		{"generators.external-secrets.io", "Webhook"},
		// A subgroup a later ESO release might add.
		{"future.external-secrets.io", "Anything"},
	}
	for _, gk := range namespaced {
		if !argoResourceInList(gk.Group, gk.Kind, black) {
			t.Errorf("the BYO AppProject must deny %s/%s in a chart's namespace; blacklist is %+v", gk.Group, gk.Kind, black)
		}
	}

	if len(proj.Spec.ClusterResourceWhitelist) != 0 {
		t.Fatalf("clusterResourceWhitelist must stay empty, got %+v", proj.Spec.ClusterResourceWhitelist)
	}
	for _, kind := range []string{"ClusterSecretStore", "ClusterExternalSecret"} {
		if argoResourceInList("external-secrets.io", kind, proj.Spec.ClusterResourceWhitelist) {
			t.Errorf("cluster-scoped %s must not be whitelisted", kind)
		}
	}

	for _, gk := range []byoGroupKind{
		{"apps", "Deployment"}, {"", "Secret"}, {"", "ConfigMap"}, {"", "Service"}, {"batch", "Job"},
	} {
		if argoResourceInList(gk.Group, gk.Kind, black) {
			t.Errorf("the deny must not reach the ordinary workload kind %s/%s", gk.Group, gk.Kind)
		}
	}
}

// argoNamespacedPermitted is the namespaced branch of ArgoCD's AppProject.IsGroupKindNamePermitted
// (pkg/apis/application/v1alpha1/app_project_types.go, v3.3.9), restated so the test below asks the
// question ArgoCD asks of a namespaced resource in a sync:
//
//	isWhiteListed = namespaceWhitelist == nil || len(namespaceWhitelist) != 0 && isResourceInList(res, namespaceWhitelist)
//	isBlackListed = len(namespaceBlacklist) != 0 && isResourceInList(res, namespaceBlacklist)
//	return isWhiteListed && !isBlackListed
//
// The nil arm is the one that matters here: a project with NO namespaceResourceWhitelist admits every
// namespaced kind, so a render that drops the field is caught as an open project, not passed as an
// empty one. isResourceInList is argoResourceInList: filepath.Match on kind, then on group, which is
// how "" matches only the core group and "*" matches any group.
func argoNamespacedPermitted(group, kind string, white, black []byoGroupKind) bool {
	isWhiteListed := white == nil || len(white) != 0 && argoResourceInList(group, kind, white)
	isBlackListed := len(black) != 0 && argoResourceInList(group, kind, black)
	return isWhiteListed && !isBlackListed
}

// TestByoAppProjectAdmitsOnlyWorkloadKinds pins the closed list of namespaced kinds a BYO chart may
// create (#6485), in both directions, under ArgoCD's own matching applied to the RENDERED project:
// every workload kind below is admitted, and a sample of kinds outside the list is refused.
//
// The admitted set is written out here rather than read from byoWorkloadKinds, so that widening the
// list is a change to this test too: the rendered whitelist must equal it exactly.
func TestByoAppProjectAdmitsOnlyWorkloadKinds(t *testing.T) {
	out, err := RenderByoAppProject("byo-p", []string{"https://example.com/r"}, []string{"byo-e2e"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var proj byoAppProject
	if err := yaml.Unmarshal([]byte(out), &proj); err != nil {
		t.Fatalf("parse rendered AppProject: %v\n%s", err, out)
	}
	white, black := proj.Spec.NamespaceResourceWhitelist, proj.Spec.NamespaceResourceBlacklist
	if len(white) == 0 {
		t.Fatalf("namespaceResourceWhitelist must be present and non-empty: ArgoCD reads an absent one as "+
			"\"every namespaced kind\" and an empty one as \"none\"; got %+v in\n%s", white, out)
	}

	admitted := []byoGroupKind{
		{"apps", "Deployment"}, {"apps", "StatefulSet"}, {"apps", "DaemonSet"}, {"apps", "ReplicaSet"},
		{"batch", "Job"}, {"batch", "CronJob"}, {"", "Pod"},
		{"", "ConfigMap"}, {"", "Secret"}, {"", "PersistentVolumeClaim"},
		{"", "Service"}, {"networking.k8s.io", "Ingress"},
		{"autoscaling", "HorizontalPodAutoscaler"}, {"policy", "PodDisruptionBudget"},
	}
	for _, gk := range admitted {
		if !argoNamespacedPermitted(gk.Group, gk.Kind, white, black) {
			t.Errorf("a BYO chart must be able to create %q/%s; whitelist %+v, blacklist %+v", gk.Group, gk.Kind, white, black)
		}
	}
	key := func(gk byoGroupKind) string { return gk.Group + "/" + gk.Kind }
	var want, got []string
	for _, gk := range admitted {
		want = append(want, key(gk))
	}
	for _, gk := range white {
		got = append(got, key(gk))
	}
	if w, g := sortedSet(want), sortedSet(got); !reflect.DeepEqual(w, g) || len(got) != len(want) {
		t.Errorf("namespaceResourceWhitelist is %v, want exactly %v.\n"+
			"Adding a kind is a decision: add it to byoWorkloadKinds with its reason, and here.", got, want)
	}
	for _, gk := range white {
		if strings.ContainsAny(gk.Group+gk.Kind, "*?[") {
			t.Errorf("whitelist entry %q/%s is a pattern; ArgoCD would match it with filepath.Match and admit more than one kind", gk.Group, gk.Kind)
		}
	}

	// The protections #6479 and earlier added hold BY CONSTRUCTION: these kinds are refused by the
	// whitelist on its own, before the blacklist is consulted. Asked with a nil blacklist on purpose.
	identityAndSecretSync := []byoGroupKind{
		{"rbac.authorization.k8s.io", "Role"},
		{"rbac.authorization.k8s.io", "RoleBinding"},
		{"", "ServiceAccount"},
		{"external-secrets.io", "ExternalSecret"},
		{"external-secrets.io", "SecretStore"},
		{"external-secrets.io", "PushSecret"},
		{"generators.external-secrets.io", "Password"},
		{"future.external-secrets.io", "Anything"},
	}
	for _, gk := range identityAndSecretSync {
		if argoNamespacedPermitted(gk.Group, gk.Kind, white, nil) {
			t.Errorf("the whitelist alone must refuse %q/%s", gk.Group, gk.Kind)
		}
	}

	refused := append([]byoGroupKind{
		// Served by an operator's CRD: what such an object makes the operator do is its rule, not ours.
		{"cert-manager.io", "Certificate"},
		{"cert-manager.io", "Issuer"},
		{"argoproj.io", "Application"},
		{"monitoring.coreos.com", "ServiceMonitor"},
		// Core and built-in kinds deliberately left out.
		{"", "Endpoints"},
		{"discovery.k8s.io", "EndpointSlice"},
		{"", "ResourceQuota"},
		{"", "LimitRange"},
		// Refused as in the namespace-tenant and preview projects: a policy governs every pod its
		// selector matches, and nothing guarantees the namespace holds only this chart.
		{"networking.k8s.io", "NetworkPolicy"},
		{"", "Event"},
		{"coordination.k8s.io", "Lease"},
		// The group is part of the match: a listed kind in another group is not the listed kind.
		{"extensions", "Ingress"},
		{"apps", "ConfigMap"},
		{"apps.example.com", "Deployment"},
		{"", "Deployment"},
	}, identityAndSecretSync...)
	for _, gk := range refused {
		if argoNamespacedPermitted(gk.Group, gk.Kind, white, black) {
			t.Errorf("the BYO AppProject must refuse %q/%s in a chart's namespace; whitelist %+v", gk.Group, gk.Kind, white)
		}
	}
}

// byoPreviewCases is the table of namespaces checked against the preview prefix "pr" (#6494). The
// console's mirror is run over THIS table: apps/console/tests/lib/validations/
// byo-charts-preview-namespace.test.ts parses it out of this file, so keep each entry on one line in
// the {"ns", bool} form that test reads.
var byoPreviewCases = []struct {
	ns       string
	conflict bool
}{
	{"pr", true},       // the prefix itself: the vcluster arm's namespace
	{"pr-7", true},     // a namespace-arm preview: <prefix>-<pr number>
	{"pr-api", true},   // anything the `<prefix>-*` destination pattern admits
	{"pre-7", false},   // shares the substring "pr", not the "pr-" boundary
	{"prod", false},    // likewise
	{"pr7", false},     // no "-" after the prefix
	{"apr-7", false},   // the prefix is not at the start
	{"my-pr-1", false}, // nor here
}

// TestByoPreviewNamespaceConflict_UsesThePreviewRenderersPrefixSemantics is the property: a BYO chart
// conflicts with a project's previews exactly when one of the preview AppProjects the guardrails
// renderer emits would admit its namespace. The patterns are READ from RenderPreviewGuardrails for both
// placement modes, never restated here, so a change to how previews are named fails this test.
func TestByoPreviewNamespaceConflict_UsesThePreviewRenderersPrefixSemantics(t *testing.T) {
	var patterns []string
	for _, mode := range []types.PlacementMode{types.PlacementModeNamespace, types.PlacementModeVcluster} {
		in := basePreviewGuardrailsInput()
		in.NamespacePrefix = "pr"
		in.PlacementMode = mode
		if mode == types.PlacementModeVcluster {
			in.VClusterName = "vc"
		}
		out, err := RenderPreviewGuardrails(in)
		if err != nil {
			t.Fatalf("RenderPreviewGuardrails(%s): %v", mode, err)
		}
		for _, d := range decodeDocs(t, out) {
			if d["kind"] != "AppProject" {
				continue
			}
			spec, _ := d["spec"].(map[string]interface{})
			dests, _ := spec["destinations"].([]interface{})
			for _, raw := range dests {
				dest, _ := raw.(map[string]interface{})
				if ns, ok := dest["namespace"].(string); ok {
					patterns = append(patterns, ns)
				}
			}
		}
	}
	if len(patterns) == 0 {
		t.Fatal("read no preview destination namespaces; the test would pass on any rule")
	}
	for _, c := range byoPreviewCases {
		admitted := false
		for _, p := range patterns {
			if ok, _ := path.Match(p, c.ns); ok {
				admitted = true
			}
		}
		if admitted != c.conflict {
			t.Errorf("case table says %q conflict=%v, but the preview projects (%v) admit it=%v", c.ns, c.conflict, patterns, admitted)
		}
		got := ByoPreviewNamespaceConflict(c.ns, "pr")
		if (got != "") != c.conflict {
			t.Errorf("ByoPreviewNamespaceConflict(%q, \"pr\") = %q, want conflict=%v", c.ns, got, c.conflict)
		}
	}
}

// TestByoPreviewNamespaceConflict_NamesThePrefixAndTheWayOut — the refusal is read by the person who
// has to pick another namespace, so it names the namespace and the prefix, and says what to change.
func TestByoPreviewNamespaceConflict_NamesThePrefixAndTheWayOut(t *testing.T) {
	msg := ByoPreviewNamespaceConflict("preview-api", " preview ")
	for _, want := range []string{`"preview-api"`, `"preview"`, `"preview-"`, "Choose a namespace", "preview namespace prefix"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message must contain %q, got: %s", want, msg)
		}
	}
}

// TestByoPreviewNamespaceConflict_NoPreviewConfigurationConflictsWithNothing — an empty prefix is a
// project with no preview configuration, which has no preview namespaces. It is NOT the renderers'
// default "preview": that would refuse "preview-api" in a project that never configured previews.
func TestByoPreviewNamespaceConflict_NoPreviewConfigurationConflictsWithNothing(t *testing.T) {
	for _, ns := range []string{"preview", "preview-1", "payments"} {
		if got := ByoPreviewNamespaceConflict(ns, ""); got != "" {
			t.Errorf("with no preview prefix, %q must not conflict, got: %s", ns, got)
		}
	}
}

// TestPreviewNamespacePrefix_RefusesTheByoPrefix (#6494): a preview prefix of "byo", or one starting
// with "byo-", would make BYO charts' own namespaces preview namespaces, so every blank-namespace
// attach would conflict. A prefix that only shares the letters is still a valid prefix.
func TestPreviewNamespacePrefix_RefusesTheByoPrefix(t *testing.T) {
	for _, p := range []string{"byo", "byo-previews"} {
		err := validatePreviewNamespacePrefix("t", p)
		if err == nil || !strings.Contains(err.Error(), "reserved") || !strings.Contains(err.Error(), `"byo-"`) {
			t.Errorf("prefix %q must be refused as reserved for BYO namespaces, got %v", p, err)
		}
	}
	// The reason for the rule: under prefix "byo", a chart's own namespace is a preview namespace.
	if ByoPreviewNamespaceConflict(ByoChartNamespace("api"), "byo") == "" {
		t.Error("prefix byo must put byo-api in the previews — the rule above would be pointless otherwise")
	}
	for _, p := range []string{"byob", "by", "preview", "mybyo"} {
		if err := validatePreviewNamespacePrefix("t", p); err != nil {
			t.Errorf("prefix %q must be accepted, got %v", p, err)
		}
	}
}
