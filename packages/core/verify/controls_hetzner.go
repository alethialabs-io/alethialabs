// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"strconv"
	"strings"
)

// hetznerControls is the Hetzner Cloud (hcloud) control set.
//
// Hetzner is TOKEN-AUTH: an API token is the ceiling of authority — there is no
// OIDC / workload-identity / role-assumption surface to bind, unlike AWS/GCP/Azure.
// So, deliberately, there are NO keyless / federated-subject / least-privilege
// *authority* controls to author here; on Hetzner they would be vacuous (there is
// nothing keyless to prove). What a Hetzner plan CAN be judged on is NETWORK
// POSTURE — the blast-radius the plan sets up:
//
//   - HCLOUD-FW-001 — are the VMs actually behind a firewall at all.
//   - HCLOUD-NET-001 — is the firewall's world-open ingress limited to the ports the
//     platform genuinely needs (SSH open to the world is a hard fail; the Kubernetes
//     API / Talos apid are open by design and warn).
//
// These are HARDENING controls, not authority controls — honest framing so the signed
// receipt never implies an OIDC/keyless assurance that Hetzner's token model cannot
// give. Everything the plan JSON cannot show (computed rule blocks, firewall ids not
// known until apply, coverage via an unresolvable stand-alone attachment) is reported
// as not_evaluable / coverage, never a silent pass — mirroring the other clouds.
func hetznerControls(planned []plannedResource) []ControlResult {
	return []ControlResult{
		controlHetznerServerFirewall(planned),
		controlHetznerWorldOpenIngress(planned),
	}
}

// controlHetznerServerFirewall — HCLOUD-FW-001. Every hcloud_server must sit behind a
// firewall. A VM with none is reachable on every port its OS listens on — the Hetzner
// analogue of a default-open security group. A server attaches a firewall either
// inline via the `firewall_ids` argument (how Alethia's shipped Talos template does
// it) or through a stand-alone hcloud_firewall_attachment; this control honours both.
//
// Honesty: `firewall_ids = [hcloud_firewall.x.id]` is unknown-until-apply in the plan
// (the firewall id isn't known yet) — that is a firewall REFERENCE, not a missing
// firewall, so it counts as protected. And when a stand-alone attachment exists whose
// `server_ids` are computed (the usual case), we cannot map it to a specific server,
// so a server with no inline firewall becomes not_evaluable rather than a false fail.
func controlHetznerServerFirewall(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "HCLOUD-FW-001",
		Title:      "Servers are attached to a firewall",
		Severity:   SeverityHigh,
		Provider:   "hetzner",
		Frameworks: []string{"SOC2-CC6.6"},
	}

	// A stand-alone attachment's server_ids are computed in a real plan, so its
	// presence means "some servers are being firewalled" but we can't say WHICH from
	// the plan. Record that so we don't hard-fail a server it might in fact cover.
	attachmentUnresolvable := false
	for _, r := range planned {
		if r.rtype == "hcloud_firewall_attachment" {
			attachmentUnresolvable = true
		}
	}

	failed, relevant, evaluable, notEval := 0, 0, 0, 0
	var coverage []string

	for _, r := range planned {
		if r.rtype != "hcloud_server" {
			continue
		}
		relevant++

		// Known non-empty firewall_ids → protected.
		if nonEmptySlice(r.after["firewall_ids"]) {
			evaluable++
			continue
		}
		// firewall_ids present but computed (references a firewall id not known until
		// apply) → the server DOES reference a firewall → protected.
		if firewallIDsUnknown(r.afterUnknown) {
			evaluable++
			continue
		}
		// No inline firewall. If a stand-alone attachment we can't map to this server
		// exists, we cannot honestly call it unprotected → not_evaluable.
		if attachmentUnresolvable {
			notEval++
			coverage = append(coverage, r.address+": no inline firewall_ids; a stand-alone hcloud_firewall_attachment exists whose server_ids are not resolvable from the plan, so coverage of this server cannot be confirmed")
			continue
		}
		// Genuinely no firewall anywhere in the plan for this server.
		evaluable++
		failed++
		c.Findings = append(c.Findings, Finding{
			Address: r.address,
			Message: "hcloud_server has no firewall (no firewall_ids and no hcloud_firewall_attachment) — the VM is reachable on every port its OS listens on; attach a firewall",
		})
	}

	resolveStatus(&c, failed, 0, evaluable, relevant, notEval, coverage)
	return c
}

// controlHetznerWorldOpenIngress — HCLOUD-NET-001. Inspect hcloud_firewall ingress
// rules for world-open sources (0.0.0.0/0 or ::/0):
//
//   - SSH (TCP 22) open to the world is a hard FAIL. It is the classic brute-force /
//     lateral-movement doorway, and the platform never needs 22 internet-reachable —
//     Talos runs no SSH daemon and management is over the private network. A world-open
//     "any"/all-ports rule (or a range that spans 22) counts as SSH-open too.
//   - ANY OTHER world-open ingress is a WARN. Alethia's shipped Talos template
//     deliberately exposes the Kubernetes API (6443) and Talos apid (50000/50001) to
//     the world, so failing those would brick every provision — but they are still
//     blast-radius worth surfacing, so they warn rather than pass silently.
//
// A firewall whose rule block is computed / not present in the plan is not_evaluable
// (coverage note), never a silent pass.
func controlHetznerWorldOpenIngress(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "HCLOUD-NET-001",
		Title:      "No world-open SSH; world-open ingress surfaced",
		Severity:   SeverityHigh,
		Provider:   "hetzner",
		Frameworks: []string{"SOC2-CC6.6"},
	}
	failed, warned, relevant, evaluable, notEval := 0, 0, 0, 0, 0
	var coverage []string

	for _, r := range planned {
		if r.rtype != "hcloud_firewall" {
			continue
		}
		relevant++
		rules, ok := r.after["rule"].([]any)
		if !ok || len(rules) == 0 {
			// Rule block computed until apply or not present in the plan.
			notEval++
			coverage = append(coverage, r.address+": firewall rule block not inspectable in the plan (computed or absent)")
			continue
		}
		evaluable++
		for _, raw := range rules {
			rule, ok := asObject(raw)
			if !ok {
				continue
			}
			if !strings.EqualFold(asString(rule["direction"]), "in") {
				continue // egress is out of scope for this ingress control
			}
			src, open := worldOpenSource(rule["source_ips"])
			if !open {
				continue
			}
			port := strings.TrimSpace(asString(rule["port"]))
			proto := strings.ToLower(strings.TrimSpace(asString(rule["protocol"])))
			if (proto == "tcp" || proto == "") && portRangeCoversSSH(port) {
				failed++
				c.Findings = append(c.Findings, Finding{
					Address: r.address,
					Message: "firewall opens SSH to the world (port " + portLabel(port) + "/" + protoLabel(proto) + " from " + src + ") — 22 must never be internet-reachable; restrict the source to an admin range or the private network",
				})
				continue
			}
			warned++
			c.Findings = append(c.Findings, Finding{
				Address: r.address,
				Message: "firewall opens port " + portLabel(port) + "/" + protoLabel(proto) + " to the world (from " + src + ") — expected for the Kubernetes API (6443) / Talos apid (50000-50001); surfaced as posture, not blocking",
			})
		}
	}

	resolveStatus(&c, failed, warned, evaluable, relevant, notEval, coverage)
	return c
}

// nonEmptySlice reports whether v is a non-empty JSON array (a known, populated
// firewall_ids list means the server references a firewall).
func nonEmptySlice(v any) bool {
	switch t := v.(type) {
	case []any:
		return len(t) > 0
	case []string:
		return len(t) > 0
	default:
		return false
	}
}

// firewallIDsUnknown reports whether the server's firewall_ids attribute is
// computed/unknown until apply — i.e. it references a firewall id that isn't known
// yet (the shipped template's `firewall_ids = [hcloud_firewall.this.id]`). Unlike the
// generic attrUnknown, an EMPTY unknown array ([]) is treated as "not a reference"
// (false) so a server that genuinely sets firewall_ids to nothing is still caught.
func firewallIDsUnknown(afterUnknown any) bool {
	m, ok := asObject(afterUnknown)
	if !ok {
		return false
	}
	switch t := m["firewall_ids"].(type) {
	case bool:
		return t
	case []any:
		for _, e := range t {
			switch ev := e.(type) {
			case bool:
				if ev {
					return true
				}
			case map[string]any, []any:
				return true // nested unknown structure
			}
		}
		return false
	default:
		return false
	}
}

// worldOpenSource reports whether an ingress rule's source_ips opens it to the whole
// internet, and returns the matched CIDR for the finding message.
func worldOpenSource(v any) (string, bool) {
	for _, s := range toStringSlice(v) {
		switch strings.TrimSpace(s) {
		case "0.0.0.0/0":
			return "0.0.0.0/0", true
		case "::/0":
			return "::/0", true
		}
	}
	return "", false
}

// portRangeCoversSSH reports whether a Hetzner firewall rule `port` spec includes port
// 22. Hetzner accepts a single port ("22"), a range ("20-30"), or "any" (all ports);
// an empty spec (icmp/gre/esp rules carry no port) does not cover 22.
func portRangeCoversSSH(port string) bool {
	switch port {
	case "":
		return false
	case "any":
		return true
	}
	if i := strings.IndexByte(port, '-'); i > 0 {
		lo, err1 := strconv.Atoi(strings.TrimSpace(port[:i]))
		hi, err2 := strconv.Atoi(strings.TrimSpace(port[i+1:]))
		if err1 != nil || err2 != nil {
			return false
		}
		return lo <= 22 && 22 <= hi
	}
	return port == "22"
}

// portLabel renders a (possibly empty) port spec for a finding message.
func portLabel(port string) string {
	if port == "" {
		return "(none)"
	}
	return port
}

// protoLabel renders a (possibly empty) protocol for a finding message.
func protoLabel(proto string) string {
	if proto == "" {
		return "any"
	}
	return proto
}
