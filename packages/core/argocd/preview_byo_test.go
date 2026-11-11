// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"errors"
	"strings"
	"testing"
)

// previewRenderers renders both halves of a project's previews for the same prefix and BYO charts.
// Activation applies both, so every #6518 property is asserted of both: a guard on one half only
// would let the other render.
func previewRenderers(prefix string, charts []PreviewByoChart) map[string]func() (string, error) {
	return map[string]func() (string, error){
		"RenderPreviewApplicationSet": func() (string, error) {
			in := basePreviewInput()
			in.NamespacePrefix = prefix
			in.ByoCharts = charts
			return RenderPreviewApplicationSet(in)
		},
		"RenderPreviewGuardrails": func() (string, error) {
			in := basePreviewGuardrailsInput()
			in.NamespacePrefix = prefix
			in.ByoCharts = charts
			return RenderPreviewGuardrails(in)
		},
	}
}

// overlapError unwraps the typed refusal, or fails the test.
func overlapError(t *testing.T, name string, err error) *PreviewByoOverlapError {
	t.Helper()
	var oe *PreviewByoOverlapError
	if !errors.As(err, &oe) {
		t.Fatalf("%s: error = %v, want a *PreviewByoOverlapError", name, err)
	}
	return oe
}

// TestPreviewActivation_RendersWhenNoChartOverlaps — charts outside the preview namespaces, including
// one with no namespace of its own (it deploys into byo-<id>) and one that only shares the prefix's
// letters, do not stop activation.
func TestPreviewActivation_RendersWhenNoChartOverlaps(t *testing.T) {
	charts := []PreviewByoChart{
		{ID: "api", Namespace: "payments"},
		{ID: "web", Namespace: ""},
		{ID: "old", Namespace: ByoLegacyDefaultNamespace},
		{ID: "db", Namespace: "previews"},
	}
	for name, render := range previewRenderers("preview", charts) {
		out, err := render()
		if err != nil {
			t.Fatalf("%s: unexpected refusal: %v", name, err)
		}
		if out == "" {
			t.Fatalf("%s: rendered nothing", name)
		}
	}
}

// TestPreviewActivation_RefusesAnOverlappingChart — one chart in a preview namespace refuses both
// halves, renders nothing, and names the chart, the namespace and the two ways out.
func TestPreviewActivation_RefusesAnOverlappingChart(t *testing.T) {
	charts := []PreviewByoChart{{ID: "payments", Namespace: "payments"}, {ID: "api", Namespace: "preview-api"}}
	for name, render := range previewRenderers("preview", charts) {
		out, err := render()
		if out != "" {
			t.Errorf("%s: rendered output alongside a refusal", name)
		}
		oe := overlapError(t, name, err)
		want := []PreviewByoOverlap{{ChartID: "api", Namespace: "preview-api"}}
		if len(oe.Overlaps) != 1 || oe.Overlaps[0] != want[0] {
			t.Errorf("%s: overlaps = %+v, want %+v", name, oe.Overlaps, want)
		}
		for _, s := range []string{`BYO chart "api" in namespace "preview-api" is`, `"preview-"`, "Attach each chart again", "change the preview namespace prefix"} {
			if !strings.Contains(err.Error(), s) {
				t.Errorf("%s: refusal must contain %q, got: %v", name, s, err)
			}
		}
		if strings.Contains(err.Error(), `"payments"`) {
			t.Errorf("%s: refusal names a chart that does not overlap: %v", name, err)
		}
	}
}

// TestPreviewActivation_NamesEveryOverlappingChart — the refusal lists ALL of them, so a person fixes
// the project in one pass rather than one chart per attempt.
func TestPreviewActivation_NamesEveryOverlappingChart(t *testing.T) {
	charts := []PreviewByoChart{
		{ID: "api", Namespace: "pr"},
		{ID: "db", Namespace: "payments"},
		{ID: "web", Namespace: "pr-web"},
	}
	for name, render := range previewRenderers("pr", charts) {
		_, err := render()
		oe := overlapError(t, name, err)
		want := []PreviewByoOverlap{{ChartID: "api", Namespace: "pr"}, {ChartID: "web", Namespace: "pr-web"}}
		if len(oe.Overlaps) != len(want) {
			t.Fatalf("%s: overlaps = %+v, want %+v", name, oe.Overlaps, want)
		}
		for i := range want {
			if oe.Overlaps[i] != want[i] {
				t.Errorf("%s: overlap %d = %+v, want %+v", name, i, oe.Overlaps[i], want[i])
			}
		}
		for _, s := range []string{`BYO chart "api" in namespace "pr"`, `BYO chart "web" in namespace "pr-web" are`} {
			if !strings.Contains(err.Error(), s) {
				t.Errorf("%s: refusal must contain %q, got: %v", name, s, err)
			}
		}
	}
}

// TestPreviewActivation_RefusesUnknownCharts — nil is "nobody looked", not "none". Only an explicit
// empty list renders.
func TestPreviewActivation_RefusesUnknownCharts(t *testing.T) {
	for name, render := range previewRenderers("preview", nil) {
		out, err := render()
		if !errors.Is(err, ErrPreviewByoChartsUnknown) {
			t.Errorf("%s: error = %v, want ErrPreviewByoChartsUnknown", name, err)
		}
		if out != "" {
			t.Errorf("%s: rendered output for unknown charts", name)
		}
	}
	for name, render := range previewRenderers("preview", []PreviewByoChart{}) {
		if _, err := render(); err != nil {
			t.Errorf("%s: an explicit empty list must render, got %v", name, err)
		}
	}
}

// TestPreviewActivation_UsesTheAttachRulesBoundary — the overlap is #6494's rule
// (ByoPreviewNamespaceConflict), so it agrees with that rule's case table: "pre-7", "prod", "pr7",
// "apr-7" and "my-pr-1" share the letters "pr" but are not preview namespaces and do not refuse.
func TestPreviewActivation_UsesTheAttachRulesBoundary(t *testing.T) {
	for _, c := range byoPreviewCases {
		err := CheckPreviewByoOverlap("pr", []PreviewByoChart{{ID: "chart", Namespace: c.ns}})
		var oe *PreviewByoOverlapError
		if got := errors.As(err, &oe); got != c.conflict {
			t.Errorf("namespace %q under prefix \"pr\": refused=%v (%v), want %v", c.ns, got, err, c.conflict)
		}
		if !c.conflict && err != nil {
			t.Errorf("namespace %q: unexpected error %v", c.ns, err)
		}
	}
}

// TestPreviewActivation_BlankPrefixIsTheRenderedDefault — unlike #6494's stored-prefix input, a blank
// prefix here is the "preview" the renderers will render, so a chart in preview-api still refuses.
func TestPreviewActivation_BlankPrefixIsTheRenderedDefault(t *testing.T) {
	for name, render := range previewRenderers("  ", []PreviewByoChart{{ID: "api", Namespace: "preview-api"}}) {
		_, err := render()
		if oe := overlapError(t, name, err); oe.Prefix != "preview" {
			t.Errorf("%s: prefix = %q, want the rendered default \"preview\"", name, oe.Prefix)
		}
	}
}

// TestPreviewActivation_ReadsAChartsNamespaceAsTheRunnerDeploysIt — a blank namespace is the chart's
// own byo-<id>, and a legacy "default" chart may be in either (the runner refuses its move when
// byo-<id> is taken). The renderers' own prefix validator refuses every prefix that could match
// byo-<id>, so these arms are exercised through the entry point directly.
func TestPreviewActivation_ReadsAChartsNamespaceAsTheRunnerDeploysIt(t *testing.T) {
	err := CheckPreviewByoOverlap("byo", []PreviewByoChart{{ID: "api", Namespace: ""}})
	var oe *PreviewByoOverlapError
	if !errors.As(err, &oe) || len(oe.Overlaps) != 1 || oe.Overlaps[0].Namespace != ByoChartNamespace("api") {
		t.Errorf("blank namespace: got %v, want an overlap at %q", err, ByoChartNamespace("api"))
	}
	err = CheckPreviewByoOverlap("default", []PreviewByoChart{{ID: "old", Namespace: ByoLegacyDefaultNamespace}})
	if !errors.As(err, &oe) || len(oe.Overlaps) != 1 || oe.Overlaps[0].Namespace != ByoLegacyDefaultNamespace {
		t.Errorf("legacy default namespace: got %v, want an overlap at %q", err, ByoLegacyDefaultNamespace)
	}
}

// TestPreviewActivation_RefusesAChartWithNoID — a chart with no id has no knowable derived namespace,
// so it fails closed rather than being skipped.
func TestPreviewActivation_RefusesAChartWithNoID(t *testing.T) {
	err := CheckPreviewByoOverlap("preview", []PreviewByoChart{{ID: " ", Namespace: "payments"}})
	if err == nil || !strings.Contains(err.Error(), "has no id") {
		t.Errorf("error = %v, want the no-id refusal", err)
	}
}

// TestPreviewActivation_RefusesAStoredByoPrefix (#6518 review) — a config saved before #6494 refused
// the prefix may still hold "byo" or "byo-…". Both halves refuse it, whatever the charts.
func TestPreviewActivation_RefusesAStoredByoPrefix(t *testing.T) {
	for _, p := range []string{"byo", "byo-previews"} {
		for name, render := range previewRenderers(p, []PreviewByoChart{}) {
			if _, err := render(); err == nil || !strings.Contains(err.Error(), "reserved") {
				t.Errorf("%s with prefix %q: error = %v, want the reserved-prefix refusal", name, p, err)
			}
		}
	}
}
