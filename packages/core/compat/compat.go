// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package compat

import (
	"fmt"
	"strconv"
	"strings"
)

// Evaluate judges a proposed config against the embedded matrix and returns a
// structured Report. It is pure and deterministic (same Subject → same Report):
// no I/O, no clock, no external policy runtime — the property a preflight gate
// and a signed receipt both rely on. It emits granular per-coupling controls:
//
//   - COMPAT-K8S-CLOUD-<PROVIDER> — the cluster K8s minor is offered by the cloud.
//   - COMPAT-COMPONENT-<ID>       — the K8s minor is within the component version's window.
//   - COMPAT-ADDON-<ID>           — the K8s minor is within the add-on's window.
//
// The cardinal rule (from verify): a version the matrix has no data for yields
// not_evaluable with a plain-language Coverage note — NEVER a silent pass.
func Evaluate(s Subject) *Report {
	m := MustLoad()
	rep := &Report{CatalogVersion: m.CatalogVersion}

	for _, provider := range s.Providers {
		rep.Controls = append(rep.Controls, evalK8sCloud(m, provider, s.K8sVersion))
	}
	for _, c := range s.Components {
		rep.Controls = append(rep.Controls, evalComponent(m, s.K8sVersion, c))
	}
	for _, a := range s.AddOns {
		rep.Controls = append(rep.Controls, evalAddOn(m, s.K8sVersion, a))
	}

	rep.finalize()
	return rep
}

// evalK8sCloud checks that the cluster Kubernetes minor is offered by the cloud.
func evalK8sCloud(m *Matrix, provider, k8s string) ControlResult {
	c := ControlResult{
		ID:       "COMPAT-K8S-CLOUD-" + strings.ToUpper(provider),
		Title:    fmt.Sprintf("Kubernetes availability on %s", provider),
		Severity: SeverityHigh,
	}
	cloud, ok := m.Cloud(provider)
	if !ok || len(cloud.Supported) == 0 {
		c.Status = StatusNotEvaluable
		c.Coverage = fmt.Sprintf("no supported Kubernetes versions recorded for cloud %q", provider)
		return c
	}
	kv, ok := parseMinor(k8s)
	if !ok {
		c.Status = StatusNotEvaluable
		c.Coverage = "cluster Kubernetes version is unset or unparseable"
		return c
	}
	for _, sv := range cloud.Supported {
		if pv, ok := parseMinor(sv); ok && pv == kv {
			c.Status = StatusPass
			return c
		}
	}
	c.Status = StatusFail
	c.Findings = []Finding{{
		Address: fmt.Sprintf("%s/k8s@%s", provider, k8s),
		Message: fmt.Sprintf("Kubernetes %s is not offered by %s (supported: %s)", k8s, provider, strings.Join(cloud.Supported, ", ")),
	}}
	return c
}

// evalComponent checks the cluster Kubernetes minor against a component version's window.
func evalComponent(m *Matrix, k8s string, ref ComponentRef) ControlResult {
	c := ControlResult{
		ID:       "COMPAT-COMPONENT-" + strings.ToUpper(ref.ID),
		Title:    fmt.Sprintf("%s %s ↔ Kubernetes", ref.ID, ref.Version),
		Severity: SeverityHigh,
	}
	rel, ok := m.Release(ref.ID, ref.Version)
	if !ok {
		c.Status = StatusNotEvaluable
		c.Coverage = fmt.Sprintf("no compatibility data recorded for %s %s", ref.ID, ref.Version)
		return c
	}
	status, detail := checkK8sRange(k8s, rel.K8sMin, rel.K8sMax)
	applyRangeResult(&c, status, detail, ref.ID+"@"+ref.Version, k8s, rel.K8sMin, rel.K8sMax)
	return c
}

// evalAddOn checks the cluster Kubernetes minor against an add-on chart's window.
func evalAddOn(m *Matrix, k8s string, ref AddOnRef) ControlResult {
	c := ControlResult{
		ID:       "COMPAT-ADDON-" + strings.ToUpper(ref.ID),
		Title:    fmt.Sprintf("add-on %s ↔ Kubernetes", ref.ID),
		Severity: SeverityMedium,
	}
	rng, ok := m.AddOnRange(ref.ID)
	if !ok {
		c.Status = StatusNotEvaluable
		c.Coverage = fmt.Sprintf("add-on %q is not in the compatibility matrix", ref.ID)
		return c
	}
	status, detail := checkK8sRange(k8s, rng.K8sMin, rng.K8sMax)
	applyRangeResult(&c, status, detail, ref.ID, k8s, rng.K8sMin, rng.K8sMax)
	return c
}

// applyRangeResult writes a range-check outcome onto a control, attaching a
// finding on fail and a coverage note on not_evaluable.
func applyRangeResult(c *ControlResult, status Status, detail, address, k8s, min, max string) {
	c.Status = status
	switch status {
	case StatusFail:
		c.Findings = []Finding{{
			Address: address,
			Message: fmt.Sprintf("requires Kubernetes %s, cluster is %s", rangeLabel(min, max), k8s),
		}}
	case StatusNotEvaluable:
		c.Coverage = detail
	case StatusPass, StatusWarn:
		// A clean pass carries no finding/coverage; a range check never emits warn.
	}
}

// checkK8sRange returns the status of a cluster Kubernetes minor against a
// [min, max] window. Both bounds empty means no window is recorded (not_evaluable,
// never a pass); an empty single bound is unbounded on that side.
func checkK8sRange(k8s, min, max string) (Status, string) {
	if min == "" && max == "" {
		return StatusNotEvaluable, "no Kubernetes compatibility range recorded"
	}
	kv, ok := parseMinor(k8s)
	if !ok {
		return StatusNotEvaluable, "cluster Kubernetes version is unset or unparseable"
	}
	if min != "" {
		mn, ok := parseMinor(min)
		if !ok {
			return StatusNotEvaluable, fmt.Sprintf("recorded lower bound %q is unparseable", min)
		}
		if cmpMinor(kv, mn) < 0 {
			return StatusFail, ""
		}
	}
	if max != "" {
		mx, ok := parseMinor(max)
		if !ok {
			return StatusNotEvaluable, fmt.Sprintf("recorded upper bound %q is unparseable", max)
		}
		if cmpMinor(kv, mx) > 0 {
			return StatusFail, ""
		}
	}
	return StatusPass, ""
}

// rangeLabel renders a [min, max] window for a human message, e.g. "1.33+",
// "≤1.32", or "1.34–1.36".
func rangeLabel(min, max string) string {
	switch {
	case min != "" && max != "":
		return min + "–" + max
	case min != "":
		return min + "+"
	case max != "":
		return "≤" + max
	default:
		return "any"
	}
}

// minor is a parsed (major, minor) Kubernetes version; patch is ignored.
type minor struct {
	major int
	min   int
}

// parseMinor parses a Kubernetes version string ("1.35", "1.35.6", "v1.35") into
// its (major, minor). It ignores any patch component and a leading "v".
func parseMinor(v string) (minor, bool) {
	v = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(v), "v"))
	if v == "" {
		return minor{}, false
	}
	parts := strings.Split(v, ".")
	if len(parts) < 2 {
		return minor{}, false
	}
	maj, err1 := strconv.Atoi(parts[0])
	mn, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return minor{}, false
	}
	return minor{major: maj, min: mn}, true
}

// cmpMinor orders two parsed minors: -1 if a<b, 0 if equal, 1 if a>b.
func cmpMinor(a, b minor) int {
	if a.major != b.major {
		if a.major < b.major {
			return -1
		}
		return 1
	}
	switch {
	case a.min < b.min:
		return -1
	case a.min > b.min:
		return 1
	default:
		return 0
	}
}

// finalize tallies the Summary and computes the Verdict by precedence:
// fail > warn > not_evaluable > pass (an empty report is not_evaluable). Any
// in-scope control that could not be judged yields not_evaluable rather than a
// vacuous pass — the honesty rule.
func (r *Report) finalize() {
	for _, c := range r.Controls {
		switch c.Status {
		case StatusPass:
			r.Summary.Pass++
		case StatusFail:
			r.Summary.Fail++
		case StatusWarn:
			r.Summary.Warn++
		case StatusNotEvaluable:
			r.Summary.NotEvaluable++
		}
	}
	switch {
	case r.Summary.Fail > 0:
		r.Verdict = StatusFail
	case r.Summary.Warn > 0:
		r.Verdict = StatusWarn
	case r.Summary.NotEvaluable > 0:
		r.Verdict = StatusNotEvaluable
	case r.Summary.Pass > 0:
		r.Verdict = StatusPass
	default:
		r.Verdict = StatusNotEvaluable
	}
}
