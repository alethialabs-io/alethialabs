// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"errors"
	"fmt"
	"strings"
)

// Activating previews must never place preview workloads in a namespace a BYO chart already deploys
// into (#6518, following #6494). #6494 refuses a NEW overlap at attach time and on a prefix change,
// but a chart stored in a preview namespace before it landed is only reported, and keeps deploying
// where it is. Once previews run, such a chart would share its namespace with untrusted PR code and
// the preview guardrail bundle.
//
// So the check is part of BOTH preview renderers' contract rather than a step their caller has to
// remember: RenderPreviewApplicationSet and RenderPreviewGuardrails each take the project's BYO
// chart placements as a required input (ByoCharts) and refuse through CheckPreviewByoOverlap. There
// is no activation caller yet; whichever one comes cannot render either half without answering
// "which BYO charts does this project have, and where".

// PreviewByoChart is one BYO chart attached to the project being given previews: its id and its
// STORED namespace, as the console holds it (blank, or the legacy "default", for a chart that chose
// none). Every environment's charts count: a placement-mode switch in the preview settings does not
// re-check the prefix, so the check cannot depend on which environment the previews land beside.
type PreviewByoChart struct {
	ID        string
	Namespace string
}

// PreviewByoOverlap is one chart namespace that falls among the project's preview namespaces.
type PreviewByoOverlap struct {
	ChartID   string
	Namespace string
}

// PreviewByoOverlapError refuses activation for a project whose BYO charts overlap its preview
// namespaces. It names every overlapping chart and namespace, so one refusal gives a person the
// whole list to fix rather than one chart per attempt.
type PreviewByoOverlapError struct {
	// Prefix is the EFFECTIVE preview prefix the renderers would use (blank defaults to "preview").
	Prefix   string
	Overlaps []PreviewByoOverlap
}

// Error lists each overlapping chart and namespace and the two ways out.
func (e *PreviewByoOverlapError) Error() string {
	parts := make([]string, 0, len(e.Overlaps))
	for _, o := range e.Overlaps {
		parts = append(parts, fmt.Sprintf("BYO chart %q in namespace %q", o.ChartID, o.Namespace))
	}
	return fmt.Sprintf("previews cannot be turned on: %s %s in this project's preview namespaces (%q and every namespace starting with %q). "+
		"Attach each chart again with a namespace that is not a preview namespace (leave it blank to use byo-<chart id>), or change the preview namespace prefix",
		strings.Join(parts, ", "), isOrAre(len(parts)), e.Prefix, e.Prefix+"-")
}

// isOrAre picks the verb for a list of n items.
func isOrAre(n int) string {
	if n == 1 {
		return "is"
	}
	return "are"
}

// ErrPreviewByoChartsUnknown refuses a render whose caller did not say which BYO charts the project
// has. A nil ByoCharts is "not looked up", which is not evidence of "none": only an explicit empty
// list says the project has no charts.
var ErrPreviewByoChartsUnknown = errors.New("the project's BYO charts are unknown, so whether they overlap the preview namespaces cannot be checked; " +
	"pass an empty list for a project with no BYO charts")

// previewNamespacePrefixOrDefault is the prefix both preview renderers render: the trimmed prefix,
// or "preview" when it is blank.
func previewNamespacePrefixOrDefault(prefix string) string {
	if p := strings.TrimSpace(prefix); p != "" {
		return p
	}
	return "preview"
}

// CheckPreviewByoOverlap refuses activation when any BYO chart of the project falls in a namespace
// the previews would use. It is the one entry point both preview renderers call; an activation
// caller may call it first to refuse before it renders anything.
//
// The rule is ByoPreviewNamespaceConflict's, the one #6494 uses at attach time, never a second copy.
// It is applied to the EFFECTIVE prefix: unlike #6494's stored-prefix input, an empty prefix here
// cannot mean "no preview configuration", because the renderers are about to render one, and they
// default a blank prefix to "preview".
//
// A chart's namespace is read as the runner deploys it: a blank or legacy "default" namespace
// becomes ByoChartNamespace(id) (provisioner.configureByoCharts). A legacy "default" chart whose move
// the runner refused stays in "default", so for that one BOTH namespaces are checked.
//
// charts == nil refuses with ErrPreviewByoChartsUnknown; a chart with a blank id refuses too,
// because its derived namespace cannot be known.
func CheckPreviewByoOverlap(namespacePrefix string, charts []PreviewByoChart) error {
	if charts == nil {
		return ErrPreviewByoChartsUnknown
	}
	prefix := previewNamespacePrefixOrDefault(namespacePrefix)
	var overlaps []PreviewByoOverlap
	for _, c := range charts {
		id := strings.TrimSpace(c.ID)
		if id == "" {
			return fmt.Errorf("a BYO chart has no id, so the namespace it deploys into cannot be checked against the preview namespaces")
		}
		for _, ns := range previewByoChartNamespaces(id, c.Namespace) {
			if ByoPreviewNamespaceConflict(ns, prefix) != "" {
				overlaps = append(overlaps, PreviewByoOverlap{ChartID: id, Namespace: ns})
			}
		}
	}
	if len(overlaps) > 0 {
		return &PreviewByoOverlapError{Prefix: prefix, Overlaps: overlaps}
	}
	return nil
}

// previewByoChartNamespaces is every namespace a chart stored with namespace ns may deploy into.
func previewByoChartNamespaces(id, ns string) []string {
	ns = strings.TrimSpace(ns)
	switch ns {
	case "":
		return []string{ByoChartNamespace(id)}
	case ByoLegacyDefaultNamespace:
		return []string{ByoLegacyDefaultNamespace, ByoChartNamespace(id)}
	default:
		return []string{ns}
	}
}
