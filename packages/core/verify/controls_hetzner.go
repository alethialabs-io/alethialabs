// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"net/netip"
	"sort"
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
// PLAN-SHAPE NOTE (empirically verified against OpenTofu 1.12.3 + hcloud provider
// 1.66.0 — see testdata/corpus/hetzner_*.json, all captured from real `tofu show
// -json` output, never hand-crafted):
//
//   - An hcloud_server's `firewall_ids` is a SET-typed computed attribute: on a
//     create plan it serializes as after:null + after_unknown:true — for BOTH a
//     server that references a firewall AND a bare server with none configured.
//     The plan VALUES cannot distinguish them; only the plan's `configuration`
//     section can (expressions.firewall_ids.references). HCLOUD-FW-001 therefore
//     judges from the configuration, and is honestly not_evaluable when the plan
//     carries no configuration section at all.
//   - A fully-known firewall `rule` block list serializes in after_unknown as
//     [{"destination_ips":[], "source_ips":[false,false]}, …] — collection shape
//     is preserved with all-false leaves. Only a `true` leaf (or a bare `true`
//     for the whole list) means "unknown until apply". Reading any list under
//     after_unknown as "unknown" would make every real rule not_evaluable and the
//     SSH hard-fail unreachable (the exact defect this shape note guards against).
func hetznerControls(planned []plannedResource) []ControlResult {
	return []ControlResult{
		controlHCloudServerFirewall(planned),
		controlHCloudFirewallExposure(planned),
	}
}

// controlHCloudServerFirewall — HCLOUD-FW-001 (hard fail). Every planned
// hcloud_server must be protected by a firewall:
//
//   - inline: `firewall_ids` known non-empty in the plan values, OR configured
//     with a reference to a same-plan hcloud_firewall / a non-empty literal
//     (the value itself is computed until apply — see the plan-shape note above);
//   - or external: a same-plan hcloud_firewall_attachment whose configuration
//     `server_ids` references this server.
//
// Honesty rules (never a silent pass, never a false brick):
//   - `firewall_ids` configured from something unresolvable in the plan (a var/
//     local) → not_evaluable with a note naming the expression.
//   - an hcloud_firewall_attachment using label_selectors, or whose server refs
//     are invisible (no configuration in the plan) → not_evaluable for servers it
//     might cover. A DECOY attachment (referencing only OTHER servers) does NOT
//     neutralize the control — an uncovered bare server still hard-fails.
//   - any hcloud_firewall with an `apply_to` selector (the label-based BYO
//     pattern) → an otherwise-unprotected server is not_evaluable, never a false
//     hard-fail: label→server matching is not resolvable from the plan.
//   - a plan with no configuration section: a computed firewall_ids cannot be
//     distinguished from an absent one → not_evaluable, stated plainly.
func controlHCloudServerFirewall(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "HCLOUD-FW-001",
		Title:      "Every server is behind a firewall",
		Severity:   SeverityHigh,
		Provider:   "hetzner",
		Frameworks: []string{"SOC2-CC6.6"},
	}

	attachments := collectFirewallAttachments(planned)
	applyToPresent := anyFirewallHasApplyTo(planned)

	failed, relevant, evaluable, notEval := 0, 0, 0, 0
	var coverage []string

	for _, r := range planned {
		if r.rtype != "hcloud_server" {
			continue
		}
		relevant++
		verdict, note := judgeServerFirewall(&r, attachments, applyToPresent)
		if note != "" {
			coverage = append(coverage, r.address+": "+note)
		}
		switch verdict {
		case fwProtected:
			evaluable++
		case fwNotEvaluable:
			notEval++
		case fwUnprotected:
			failed++
			c.Findings = append(c.Findings, Finding{
				Address: r.address,
				Message: "server has no firewall: no firewall_ids in its configuration and no hcloud_firewall_attachment references it — a bare public node; attach it to an hcloud_firewall",
			})
		}
	}

	resolveStatus(&c, failed, 0, evaluable, relevant, notEval, coverage)
	return c
}

// fwVerdict is the per-server outcome of the firewall-coverage judgment.
type fwVerdict int

const (
	fwProtected fwVerdict = iota
	fwUnprotected
	fwNotEvaluable
)

// fwAttachment is a planned hcloud_firewall_attachment reduced to what the
// coverage judgment needs.
type fwAttachment struct {
	address string
	// serverRefs are the configuration references of its server_ids (absolute,
	// module-prefixed). Empty when the plan has no configuration.
	serverRefs []string
	// usesLabels is true when the attachment selects servers by label_selectors —
	// coverage exists but is not mappable to specific servers from the plan.
	usesLabels bool
	// refsVisible is true when the plan's configuration shows the attachment's
	// server_ids expression (so an empty serverRefs really means "references no
	// server", not "we can't see").
	refsVisible bool
}

// collectFirewallAttachments gathers the plan's hcloud_firewall_attachment
// resources with their configuration server references.
func collectFirewallAttachments(planned []plannedResource) []fwAttachment {
	var out []fwAttachment
	for _, r := range planned {
		if r.rtype != "hcloud_firewall_attachment" {
			continue
		}
		a := fwAttachment{address: r.address}
		if ls := toStringSlice(r.after["label_selectors"]); len(ls) > 0 {
			a.usesLabels = true
		}
		if r.hasConfig() {
			if r.configExprs["label_selectors"] != nil {
				a.usesLabels = true
			}
			if r.configExprs["server_ids"] != nil {
				a.refsVisible = true
				a.serverRefs = r.exprRefs("server_ids")
			}
		}
		out = append(out, a)
	}
	return out
}

// anyFirewallHasApplyTo reports whether any planned hcloud_firewall carries an
// `apply_to` selector (label/server based self-attachment).
func anyFirewallHasApplyTo(planned []plannedResource) bool {
	for _, r := range planned {
		if r.rtype != "hcloud_firewall" {
			continue
		}
		if lst, ok := r.after["apply_to"].([]any); ok && len(lst) > 0 {
			return true
		}
	}
	return false
}

// judgeServerFirewall classifies one hcloud_server's firewall coverage. The note
// (when non-empty) is appended to the control's coverage line.
func judgeServerFirewall(r *plannedResource, attachments []fwAttachment, applyToPresent bool) (fwVerdict, string) {
	// 1. A known plan value wins: a concrete firewall_ids list is authoritative.
	if lst, ok := r.after["firewall_ids"].([]any); ok {
		if len(lst) > 0 {
			return fwProtected, ""
		}
		// Known-empty inline — only external coverage can save it.
		return judgeExternalCoverage(r, attachments, applyToPresent)
	}

	// 2. Value computed until apply (after:null + after_unknown:true — the normal
	//    create-plan shape). The configuration is the only honest evidence.
	if r.hasConfig() {
		if expr := r.configExprs["firewall_ids"]; expr != nil {
			for _, ref := range r.exprRefs("firewall_ids") {
				if strings.Contains(ref, "hcloud_firewall.") {
					return fwProtected, "firewall_ids computed until apply; configuration references " + ref
				}
			}
			if konst, ok := r.exprConstant("firewall_ids"); ok {
				if lst, ok := konst.([]any); ok && len(lst) > 0 {
					return fwProtected, "firewall_ids is a non-empty literal in configuration"
				}
				// A literal empty list — configured to no firewall.
				return judgeExternalCoverage(r, attachments, applyToPresent)
			}
			// Configured, but from something the plan can't resolve (var/local/
			// other-resource output) — an honest gap, not a guess either way.
			return fwNotEvaluable, "firewall_ids is configured from an expression the plan cannot resolve (" + strings.Join(r.exprRefs("firewall_ids"), ", ") + ")"
		}
		// Configuration visible and firewall_ids simply not set → bare server
		// unless something external covers it.
		return judgeExternalCoverage(r, attachments, applyToPresent)
	}

	// 3. No configuration in the plan at all: a computed firewall_ids is
	//    indistinguishable from an absent one (verified: both serialize as
	//    after:null + after_unknown:true). Honest not_evaluable.
	if attrUnknown(r.afterUnknown, "firewall_ids") {
		return fwNotEvaluable, "firewall_ids computed until apply and the plan carries no configuration to show whether a firewall is referenced"
	}
	// Not in after, not unknown, no config — nothing suggests a firewall.
	return judgeExternalCoverage(r, attachments, applyToPresent)
}

// judgeExternalCoverage handles a server with no inline firewall: an attachment
// that references it protects it; unmappable coverage (label selectors, apply_to,
// invisible refs) is not_evaluable; nothing at all is a hard fail.
func judgeExternalCoverage(r *plannedResource, attachments []fwAttachment, applyToPresent bool) (fwVerdict, string) {
	base := baseAddress(r.address)
	unmappable := false
	for _, a := range attachments {
		if refsInclude(a.serverRefs, base) {
			return fwProtected, "covered by " + a.address
		}
		if a.usesLabels || !a.refsVisible {
			unmappable = true
		}
	}
	if unmappable {
		return fwNotEvaluable, "no inline firewall_ids; an hcloud_firewall_attachment selects servers in a way the plan cannot map to this one"
	}
	if applyToPresent {
		return fwNotEvaluable, "no inline firewall_ids; an hcloud_firewall with an apply_to selector is present and label-based coverage is not resolvable from the plan"
	}
	return fwUnprotected, ""
}

// refsInclude reports whether a reference list names the resource `base` (either
// exactly or via an attribute path like base+".id").
func refsInclude(refs []string, base string) bool {
	for _, ref := range refs {
		if ref == base || strings.HasPrefix(ref, base+".") {
			return true
		}
	}
	return false
}

// controlHCloudFirewallExposure — HCLOUD-NET-001. Inspects every inbound firewall
// rule the plan can see:
//   - world-open TCP SSH (source covering the whole internet, port 22 or an
//     "any"-port rule that subsumes 22) is a HARD FAIL. Talos has no SSH daemon —
//     a world-open 22 is always a misconfiguration, never legitimate. "Covering
//     the whole internet" is a UNION judgment: 0.0.0.0/0 and ::/0 count, and so
//     does a split-CIDR spelling (0.0.0.0/1 + 128.0.0.0/1) — evasion by
//     enumeration is still world-open.
//   - a broad-but-partial source on TCP 22 (any single v4 prefix ≤ /8 or v6
//     prefix ≤ /16) is a WARN — not provably world-open, but far too broad for a
//     port that should not be open at all; stated rather than silently passed.
//   - world-open TCP Kubernetes API (6443) or Talos apid (50000/50001) is a WARN,
//     not a block: these ARE open to the internet by design today. The runner
//     reaches the API / apid externally to bootstrap and drive the cluster, and
//     the real auth layer is Kubernetes mTLS + Talos machine identity, not an IP
//     allowlist. Blocking here would brick the shipped template's nightly apply.
//   - any OTHER world-open inbound rule (other TCP ports, UDP, ICMP, …) is a
//     generic WARN naming the protocol/port. Only TCP rules covering port 22 can
//     hard-fail — a UDP "port 22" or a portless ICMP rule is NOT SSH and must not
//     be misjudged as such.
//
// Rules whose source or port is computed until apply are not_evaluable (coverage
// note), never a silent pass. The shipped template opens TCP 6443/50000/50001 to
// the world and confines everything else to the private network CIDR
// (infra/templates/project/hetzner/network.tf lines 69-121), so it evaluates to
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
			proto := strings.ToLower(strings.TrimSpace(asString(rule["protocol"])))
			evaluable++

			world := coversWholeInternet(sources)
			if !world {
				// Not provably world-open. One stated heuristic backstop: a very
				// broad partial source on TCP 22 is warned, not silently passed.
				if proto == "tcp" && portRuleCovers(port, 22) && hasVeryBroadSource(sources) {
					warned++
					c.Findings = append(c.Findings, Finding{
						Address: ruleAddr,
						Message: "SSH (tcp/22) open to a very broad source range (" + strings.Join(sources, ",") + ") — Talos runs no SSH daemon; this port should not be open at all",
					})
				}
				continue
			}
			switch {
			case proto == "tcp" && portRuleCovers(port, 22):
				failed++
				c.Findings = append(c.Findings, Finding{
					Address: ruleAddr,
					Message: "world-open SSH (source " + strings.Join(sources, ",") + " on tcp port " + portLabel(port) + ") — Talos runs no SSH daemon; a world-open 22 is always a misconfiguration",
				})
			case proto == "tcp" && (portRuleCovers(port, 6443) || portRuleCovers(port, 50000) || portRuleCovers(port, 50001)):
				warned++
				c.Findings = append(c.Findings, Finding{
					Address: ruleAddr,
					Message: "world-open management port tcp/" + portLabel(port) + " (Kubernetes API / Talos apid) — open to the internet BY DESIGN today (runner reaches the API/apid externally; K8s mTLS + Talos machine identity is the auth layer). Recorded as posture, not blocked",
				})
			default:
				warned++
				c.Findings = append(c.Findings, Finding{
					Address: ruleAddr,
					Message: "world-open inbound " + protoPortLabel(proto, port) + " (source " + strings.Join(sources, ",") + ") — confirm this exposure is intended",
				})
			}
		}
	}

	resolveStatus(&c, failed, warned, evaluable, relevant, notEval, coverage)
	return c
}

// ruleListWhollyUnknown reports whether a firewall's entire `rule` block list is
// computed until apply — represented as a bare `true` in after_unknown. A list
// value (per-element unknown maps) is a KNOWN block list and is NOT wholly
// unknown (see the plan-shape note on hetznerControls).
func ruleListWhollyUnknown(afterUnknown any) bool {
	m, ok := asObject(afterUnknown)
	if !ok {
		return false
	}
	b, ok := m["rule"].(bool)
	return ok && b
}

// ruleUnknown reports whether firewall rule i has a computed field this control
// depends on (direction / protocol / port / source_ips), per the plan's
// after_unknown. Real tofu preserves collection shape with all-false leaves for
// fully-known values (source_ips: [false,false]) — only a `true` leaf means
// unknown. An all-false / empty structure is KNOWN.
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
	for _, key := range []string{"direction", "protocol", "port"} {
		if b, ok := ru[key].(bool); ok && b {
			return true
		}
	}
	return anyUnknownLeaf(ru["source_ips"])
}

// anyUnknownLeaf reports whether an after_unknown value contains any `true` leaf
// — i.e. some part of it really is unknown until apply. false/empty/all-false
// structures are fully known.
func anyUnknownLeaf(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case []any:
		for _, e := range t {
			if anyUnknownLeaf(e) {
				return true
			}
		}
	case map[string]any:
		for _, e := range t {
			if anyUnknownLeaf(e) {
				return true
			}
		}
	}
	return false
}

// coversWholeInternet reports whether a source_ips list covers the entire
// internet in either address family — 0.0.0.0/0, ::/0, or a UNION of prefixes
// that adds up to full coverage (the split-CIDR spelling, e.g. 0.0.0.0/1 +
// 128.0.0.0/1). Unparseable entries are ignored (they cannot prove coverage).
func coversWholeInternet(sources []string) bool {
	var v4, v6 []netip.Prefix
	for _, s := range sources {
		p, err := netip.ParsePrefix(strings.TrimSpace(s))
		if err != nil {
			continue
		}
		if p.Addr().Is4() {
			v4 = append(v4, p)
		} else {
			v6 = append(v6, p)
		}
	}
	return unionCoversAll(v4, netip.AddrFrom4([4]byte{})) ||
		unionCoversAll(v6, netip.IPv6Unspecified())
}

// unionCoversAll reports whether the union of `prefixes` covers the entire
// address space of the family starting at `first` (0.0.0.0 or ::). Sweep-line
// over the sorted [first,last] ranges; Addr.Next() returning the invalid Addr on
// overflow is the "walked past the last address" sentinel.
func unionCoversAll(prefixes []netip.Prefix, first netip.Addr) bool {
	if len(prefixes) == 0 {
		return false
	}
	type rng struct{ lo, hi netip.Addr }
	rs := make([]rng, 0, len(prefixes))
	for _, p := range prefixes {
		rs = append(rs, rng{p.Masked().Addr(), prefixLast(p)})
	}
	sort.Slice(rs, func(i, j int) bool { return rs[i].lo.Compare(rs[j].lo) < 0 })
	cur := first
	for _, r := range rs {
		if !cur.IsValid() {
			return true // already swept past the family's last address
		}
		if r.lo.Compare(cur) > 0 {
			return false // gap
		}
		if r.hi.Compare(cur) >= 0 {
			cur = r.hi.Next()
		}
	}
	return !cur.IsValid()
}

// prefixLast returns the last (highest) address of a prefix.
func prefixLast(p netip.Prefix) netip.Addr {
	a := p.Masked().Addr()
	if a.Is4() {
		b := a.As4()
		for i := p.Bits(); i < 32; i++ {
			b[i/8] |= 1 << (7 - i%8)
		}
		return netip.AddrFrom4(b)
	}
	b := a.As16()
	for i := p.Bits(); i < 128; i++ {
		b[i/8] |= 1 << (7 - i%8)
	}
	return netip.AddrFrom16(b)
}

// hasVeryBroadSource reports whether any single source prefix is broad enough to
// be indistinguishable from world-open in practice: IPv4 ≤ /8 or IPv6 ≤ /16.
// Used only as a stated WARN backstop on SSH rules that are not provably
// world-open by union.
func hasVeryBroadSource(sources []string) bool {
	for _, s := range sources {
		p, err := netip.ParsePrefix(strings.TrimSpace(s))
		if err != nil {
			continue
		}
		if p.Addr().Is4() && p.Bits() <= 8 {
			return true
		}
		if !p.Addr().Is4() && p.Bits() <= 16 {
			return true
		}
	}
	return false
}

// portRuleCovers reports whether an hcloud firewall rule's `port` field covers
// the given target port. The field is a single port ("22"), a range
// ("50000-50001"), or "any"/empty (all ports — which subsumes every target).
// NB callers must gate on protocol: only TCP/UDP rules carry ports; an ICMP
// rule's port is always "" and must not be read as "covers everything".
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

// portLabel renders a firewall rule's port field for a finding message,
// normalising the all-ports sentinel to a readable form.
func portLabel(port string) string {
	port = strings.TrimSpace(port)
	if port == "" || strings.EqualFold(port, "any") {
		return "any (all ports)"
	}
	return port
}

// protoPortLabel renders "udp port 22" / "icmp" / "tcp port any (all ports)" for
// generic exposure findings.
func protoPortLabel(proto, port string) string {
	switch proto {
	case "icmp", "esp", "gre":
		return proto // portless protocols
	case "":
		return "port " + portLabel(port)
	default:
		return proto + " port " + portLabel(port)
	}
}
