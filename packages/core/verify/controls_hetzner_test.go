// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import "testing"

// TestHetznerProviderDetected asserts an hcloud plan is recognized as "hetzner" and
// runs the posture control set — no longer a vacuous supported-no-controls pass.
func TestHetznerProviderDetected(t *testing.T) {
	rep := evalFixture(t, "hetzner_pass.json")
	if rep.Provider != "hetzner" {
		t.Errorf("provider = %q, want %q", rep.Provider, "hetzner")
	}
	if !hasControl(rep, "HCLOUD-FW-001") || !hasControl(rep, "HCLOUD-NET-001") {
		t.Errorf("hetzner control set missing from an hcloud plan (controls: %+v)", rep.Controls)
	}
	// The SCOPE-001 backstop must NOT fire: hcloud is now a controlled provider.
	if hasControl(rep, "SCOPE-001") {
		t.Error("SCOPE-001 fired on an all-hcloud plan — hcloud should be controlled, not unrecognized")
	}
}

// TestHetznerShippedTemplateNoHardFail is the LOAD-BEARING proof from the adversarial
// review: the CURRENTLY SHIPPED Hetzner template (the only cloud with a real nightly
// apply) must evaluate to WARNS ONLY with ZERO hard fails under the new controls —
// otherwise tonight's `tofu apply` hard-blocks at the fail-closed gate.
//
// hetzner_shipped_warn.json faithfully mirrors the shipped template's plan shape:
// firewall_ids = [hcloud_firewall.this.id] (computed) on every server (servers.tf
// lines 36 & 71), and the firewall opening 6443/50000/50001 to 0.0.0.0/0 + ::/0 with
// everything else confined to the private CIDR (network.tf lines 75-120).
func TestHetznerShippedTemplateNoHardFail(t *testing.T) {
	rep := evalFixture(t, "hetzner_shipped_warn.json")

	// The guarantee: not blocking, and no control produced a hard fail.
	if rep.Blocking() {
		t.Fatalf("SHIPPED template BLOCKS at the gate (verdict=%s) — this bricks the nightly apply", rep.Verdict)
	}
	for _, c := range rep.Controls {
		if c.Status == StatusFail {
			t.Errorf("control %s hard-failed on the shipped template (findings: %+v) — must be warn at most", c.ID, c.Findings)
		}
	}
	if rep.Summary.Fail != 0 {
		t.Errorf("shipped template summary.Fail = %d, want 0", rep.Summary.Fail)
	}

	// Precise expectations: firewall present (pass), world-open management ports warn.
	if fw := controlByID(t, rep, "HCLOUD-FW-001"); fw.Status != StatusPass {
		t.Errorf("HCLOUD-FW-001 = %q, want pass (every server has firewall_ids, id computed)", fw.Status)
	}
	if net := controlByID(t, rep, "HCLOUD-NET-001"); net.Status != StatusWarn {
		t.Errorf("HCLOUD-NET-001 = %q, want warn (world-open 6443/50000/50001 are by-design posture notes)", net.Status)
	}
	if rep.Verdict != StatusWarn {
		t.Errorf("shipped template verdict = %q, want warn (warns only)", rep.Verdict)
	}
}

// TestHetznerCleanPass asserts the hardened variant (management ports confined to the
// private CIDR) is a genuine PASS — proving HCLOUD-NET-001 discriminates world-open
// from private-sourced management rules, not just "warns on everything".
func TestHetznerCleanPass(t *testing.T) {
	rep := evalFixture(t, "hetzner_pass.json")
	if rep.Verdict != StatusPass {
		t.Fatalf("hardened hetzner plan verdict = %q, want pass (controls: %+v)", rep.Verdict, rep.Controls)
	}
}

// TestHetznerOpenSSHHardFails pins the one always-wrong case: world-open :22 on Talos
// (no SSH daemon) is a hard fail that blocks.
func TestHetznerOpenSSHHardFails(t *testing.T) {
	rep := evalFixture(t, "hetzner_fail_open_ssh.json")
	if !rep.Blocking() {
		t.Fatalf("world-open SSH did not block (verdict=%s)", rep.Verdict)
	}
	if c := controlByID(t, rep, "HCLOUD-NET-001"); c.Status != StatusFail {
		t.Errorf("HCLOUD-NET-001 = %q, want fail for world-open :22", c.Status)
	}
	// The co-present world-open 6443 must not upgrade to fail — only 22 is fatal.
	if c := controlByID(t, rep, "HCLOUD-FW-001"); c.Status != StatusPass {
		t.Errorf("HCLOUD-FW-001 = %q, want pass (server is firewalled)", c.Status)
	}
}

// TestHetznerNoFirewallHardFails pins the bare-public-node case.
func TestHetznerNoFirewallHardFails(t *testing.T) {
	rep := evalFixture(t, "hetzner_fail_no_firewall.json")
	if !rep.Blocking() {
		t.Fatalf("a server with no firewall did not block (verdict=%s)", rep.Verdict)
	}
	if c := controlByID(t, rep, "HCLOUD-FW-001"); c.Status != StatusFail {
		t.Errorf("HCLOUD-FW-001 = %q, want fail for a server with no firewall_ids", c.Status)
	}
}

// TestHetznerComputedFirewallIsEvaluablePass proves the not-vacuous honesty edge: a
// firewall_ids = [computed] LIST LITERAL keeps its length, so the plan proves "a
// firewall is attached" (pass) even though the id is unknown until apply — it is NOT
// downgraded to not_evaluable, and NOT a silent pass over an absent attribute.
func TestHetznerComputedFirewallIsEvaluablePass(t *testing.T) {
	rep := evalFixture(t, "hetzner_shipped_warn.json")
	fw := controlByID(t, rep, "HCLOUD-FW-001")
	if fw.Status != StatusPass {
		t.Fatalf("HCLOUD-FW-001 = %q, want pass for computed-but-present firewall_ids", fw.Status)
	}
	if fw.Coverage == "" {
		t.Error("expected a coverage note that the firewall id is computed until apply")
	}
}
