// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"strconv"
	"strings"
)

// hetznerControls is the Hetzner (hcloud) control set.
//
// Hetzner is TOKEN-AUTH — an API token is the ceiling. There is no OIDC / workload
// federation / IAM role surface to bind, so the keyless / OIDC-sub / least-privilege
// controls that anchor the AWS/GCP/Azure sets simply do not apply here (there is
// nothing of that shape in an hcloud plan to assert against). Auditing hcloud for
// "no static keys" would be theatre: the token IS the credential by design.
//
// What Hetzner DOES expose, and what these controls assert, is NETWORK / FIREWALL
// POSTURE — the only meaningful attack surface a Hetzner plan can misconfigure:
//   - HCLOUD-FW-001: every server must be behind a firewall (no bare public node).
//   - HCLOUD-NET-001: world-open SSH (22) is always wrong on Talos; world-open
//     management ports (Kubernetes API 6443, Talos apid 50000/50001) are a recorded
//     WARN, not a block — they are open BY DESIGN today (the runner reaches the API/
//     apid externally; K8s mTLS + Talos machine identity is the real auth layer).
//
// Every value these controls read (firewall_ids length, rule source_ips, rule port)
// is deterministically parseable from the plan JSON. Where a value is computed until
// apply the control returns not_evaluable (honest), never a silent pass.
func hetznerControls(planned []plannedResource) []ControlResult {
	return []ControlResult{
		controlHCloudServerFirewall(planned),
		controlHCloudFirewallExposure(planned),
	}
}

// controlHCloudServerFirewall — HCLOUD-FW-001 (hard fail). Every planned
// hcloud_server must be attached to at least one firewall — either inline via a
// non-empty `firewall_ids`, or covered by an hcloud_firewall_attachment that targets
// it. A server with no firewall is a bare public node on the internet, the clearest
// posture violation an hcloud plan can make.
//
// Honesty: `firewall_ids` is frequently a computed reference on first apply
// (firewall_ids = [hcloud_firewall.this.id], the id being unknown until apply). A
// LIST LITERAL keeps its LENGTH even when the element values are computed, so the
// plan still proves "≥1 firewall attached" — that is an evaluable PASS, noted in
// coverage. Only when the whole attribute's presence/length is unknown (and no
// attachment is visible) does the server become not_evaluable rather than a fail.
//
// The shipped template attaches `firewall_ids = [hcloud_firewall.this.id]` to every
// server (infra/templates/project/hetzner/servers.tf lines 36 and 71), so it PASSES.
func controlHCloudServerFirewall(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "HCLOUD-FW-001",
		Title:      "Every server is behind a firewall",
		Severity:   SeverityHigh,
		Provider:   "hetzner",
		Frameworks: []string{"SOC2-CC6.6"},
	}

	// Any firewall_attachment in the plan is a possible external coverage source. We
	// cannot map an attachment's computed server_ids back to a specific server
	// address deterministically, so an attachment's presence downgrades a would-be
	// fail to not_evaluable (coverage exists but is unverifiable here) — never a
	// silent pass, never a false fail.
	attachmentsPresent := false
	for _, r := range planned {
		if r.rtype == "hcloud_firewall_attachment" {
			attachmentsPresent = true
			break
		}
	}

	failed, relevant, evaluable, notEval := 0, 0, 0, 0
	var coverage []string

	for _, r := range planned {
		if r.rtype != "hcloud_server" {
			continue
		}
		relevant++
		count, lengthKnown := serverFirewallCount(r)
		switch {
		case count > 0:
			evaluable++
			if firewallIDsComputed(r) {
				coverage = append(coverage, r.address+": firewall attached (id computed until apply)")
			}
		case !lengthKnown:
			// firewall_ids present but its length is unknown until apply.
			notEval++
			coverage = append(coverage, r.address+": firewall_ids length not known until apply")
		case attachmentsPresent:
			// Known-empty inline, but a firewall_attachment may cover it; can't confirm.
			notEval++
			coverage = append(coverage, r.address+": no inline firewall_ids; an hcloud_firewall_attachment may cover it (unverifiable in plan)")
		default:
			failed++
			c.Findings = append(c.Findings, Finding{
				Address: r.address,
				Message: "server has no firewall_ids and no covering hcloud_firewall_attachment — it is a bare public node; attach it to an hcloud_firewall",
			})
		}
	}

	resolveStatus(&c, failed, 0, evaluable, relevant, notEval, coverage)
	return c
}

// controlHCloudFirewallExposure — HCLOUD-NET-001. Inspects every inbound firewall
// rule the plan can see:
//   - world-open SSH (source 0.0.0.0/0 or ::/0 on port 22, or an "any"-port rule
//     that subsumes 22) is a HARD FAIL. Talos has no SSH daemon — a world-open 22 is
//     always a misconfiguration, never legitimate.
//   - world-open Kubernetes API (6443) or Talos apid (50000/50001) is a WARN, not a
//     block: these ARE open to the internet by design today. The runner reaches the
//     API / apid externally to bootstrap and drive the cluster, and the real auth
//     layer is Kubernetes mTLS + Talos machine identity, not an IP allowlist. Blocking
//     here would brick the shipped template's nightly apply — so it is recorded as a
//     posture note, not a gate.
//   - any OTHER world-open inbound port is a generic WARN (surfaced, not blocked).
//
// Rules whose source or port is computed until apply are not_evaluable (coverage
// note), never a silent pass. The shipped template opens 6443/50000/50001 to the
// world and confines everything else to the private network CIDR
// (infra/templates/project/hetzner/network.tf lines 75-120), so it evaluates to
// WARN — never a hard fail.
func controlHCloudFirewallExposure(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "HCLOUD-NET-001",
		Title:      "No world-open SSH; management ports flagged",
		Severity:   SeverityHigh,
		Provider:   "hetzner",
		Frameworks: []string{"CIS-4.1", "SOC2-CC6.6"},
	}

	failed, warned, relevant, evaluable, notEval := 0, 0, 0, 0, 0
	var coverage []string

	for _, r := range planned {
		if r.rtype != "hcloud_firewall" {
			continue
		}
		// The `rule` block list is wholly unknown ONLY when after_unknown marks it a
		// bare `true`. A LIST of per-element unknown-maps ([{}, {}]) is terraform's
		// representation of a KNOWN block list (each {} = nothing unknown here), so we
		// must NOT treat that as not_evaluable — the per-rule ruleUnknown check below
		// handles element-level computed fields precisely.
		if ruleListWhollyUnknown(r.afterUnknown) {
			relevant++
			notEval++
			coverage = append(coverage, r.address+": firewall rules not known until apply")
			continue
		}
		rules, ok := r.after["rule"].([]any)
		if !ok {
			continue
		}
		for i, raw := range rules {
			rule, ok := asObject(raw)
			if !ok {
				continue
			}
			if !strings.EqualFold(asString(rule["direction"]), "in") {
				continue // egress rules are out of scope for this control
			}
			relevant++
			ruleAddr := r.address + ".rule[" + strconv.Itoa(i) + "]"
			if ruleUnknown(r.afterUnknown, i) {
				notEval++
				coverage = append(coverage, ruleAddr+": source/port not known until apply")
				continue
			}
			sources := toStringSlice(rule["source_ips"])
			port := asString(rule["port"])
			evaluable++
			if !isWorldOpen(sources) {
				continue // confined to specific sources (e.g. the private CIDR) — fine
			}
			switch {
			case portRuleCovers(port, 22):
				failed++
				c.Findings = append(c.Findings, Finding{
					Address: ruleAddr,
					Message: "world-open SSH (source " + strings.Join(sources, ",") + " on port " + portLabel(port) + ") — Talos runs no SSH daemon; a world-open 22 is always a misconfiguration",
				})
			case portRuleCovers(port, 6443) || portRuleCovers(port, 50000) || portRuleCovers(port, 50001):
				warned++
				c.Findings = append(c.Findings, Finding{
					Address: ruleAddr,
					Message: "world-open management port " + portLabel(port) + " (Kubernetes API / Talos apid) — open to the internet BY DESIGN today (runner reaches the API/apid externally; K8s mTLS + Talos machine identity is the auth layer). Recorded as posture, not blocked",
				})
			default:
				warned++
				c.Findings = append(c.Findings, Finding{
					Address: ruleAddr,
					Message: "world-open inbound port " + portLabel(port) + " (source " + strings.Join(sources, ",") + ") — confirm this exposure is intended",
				})
			}
		}
	}

	resolveStatus(&c, failed, warned, evaluable, relevant, notEval, coverage)
	return c
}

// serverFirewallCount inspects an hcloud_server's firewall_ids across `after` and
// `after_unknown` and returns how many firewalls are attached plus whether that
// count is trustworthy (the list length is known). A LIST LITERAL keeps its length
// even when the element ids are computed until apply, so a computed
// firewall_ids = [ref] still reports count 1, lengthKnown true.
func serverFirewallCount(r plannedResource) (count int, lengthKnown bool) {
	// Prefer the known `after` value — its length is authoritative when present.
	if lst, ok := r.after["firewall_ids"].([]any); ok {
		return len(lst), true
	}
	// Fall back to `after_unknown`: a computed list literal keeps its element count.
	if m, ok := asObject(r.afterUnknown); ok {
		switch t := m["firewall_ids"].(type) {
		case []any:
			return len(t), true // known length, element values computed
		case bool:
			if t {
				return 0, false // whole attribute unknown (length unknown)
			}
		}
	}
	// Absent from both → known empty (no firewall attached).
	return 0, true
}

// firewallIDsComputed reports whether a server's firewall_ids element values are
// computed until apply (so the count is known but the specific firewall ids are not).
func firewallIDsComputed(r plannedResource) bool {
	m, ok := asObject(r.afterUnknown)
	if !ok {
		return false
	}
	switch t := m["firewall_ids"].(type) {
	case bool:
		return t
	case []any:
		for _, e := range t {
			if b, ok := e.(bool); ok && b {
				return true
			}
			if _, ok := e.(map[string]any); ok {
				return true
			}
		}
	}
	return false
}

// ruleListWhollyUnknown reports whether a firewall's entire `rule` block list is
// computed until apply — represented as a bare `true` in after_unknown. A list value
// (per-element unknown-maps) is a KNOWN block list and is NOT wholly unknown.
func ruleListWhollyUnknown(afterUnknown any) bool {
	m, ok := asObject(afterUnknown)
	if !ok {
		return false
	}
	b, ok := m["rule"].(bool)
	return ok && b
}

// ruleUnknown reports whether firewall rule i has any computed field in the plan's
// after_unknown (a rule whose source_ips or port is not yet known cannot be judged).
func ruleUnknown(afterUnknown any, i int) bool {
	m, ok := asObject(afterUnknown)
	if !ok {
		return false
	}
	rules, ok := m["rule"].([]any)
	if !ok || i >= len(rules) {
		return false
	}
	ru, ok := asObject(rules[i])
	if !ok {
		// A bare `true` at this position means the whole rule is unknown.
		if b, ok := rules[i].(bool); ok {
			return b
		}
		return false
	}
	if b, ok := ru["port"].(bool); ok && b {
		return true
	}
	switch src := ru["source_ips"].(type) {
	case bool:
		return src
	case []any:
		// A list of unknown source entries means the sources are not fully known.
		return true
	}
	return false
}

// isWorldOpen reports whether a source_ips list contains an any-address CIDR
// (0.0.0.0/0 or ::/0) — i.e. the rule is open to the entire internet.
func isWorldOpen(sources []string) bool {
	for _, s := range sources {
		switch strings.TrimSpace(s) {
		case "0.0.0.0/0", "::/0":
			return true
		}
	}
	return false
}

// portRuleCovers reports whether an hcloud firewall rule's `port` field covers the
// given target port. The field is a single port ("22"), a range ("50000-50001"), or
// "any"/empty (all ports — which subsumes every target).
func portRuleCovers(port string, target int) bool {
	port = strings.TrimSpace(port)
	if port == "" || strings.EqualFold(port, "any") {
		return true
	}
	if i := strings.IndexByte(port, '-'); i > 0 {
		lo, err1 := strconv.Atoi(strings.TrimSpace(port[:i]))
		hi, err2 := strconv.Atoi(strings.TrimSpace(port[i+1:]))
		if err1 != nil || err2 != nil {
			return false
		}
		return target >= lo && target <= hi
	}
	n, err := strconv.Atoi(port)
	return err == nil && n == target
}

// portLabel renders a firewall rule's port field for a finding message, normalising
// the all-ports sentinel to a readable form.
func portLabel(port string) string {
	port = strings.TrimSpace(port)
	if port == "" || strings.EqualFold(port, "any") {
		return "any (all ports)"
	}
	return port
}
