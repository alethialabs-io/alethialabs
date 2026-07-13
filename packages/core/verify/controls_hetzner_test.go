// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"strings"
	"testing"
)

// Every hetzner fixture in this file is REAL `tofu show -json` output (OpenTofu
// v1.12.3 + hcloud provider 1.66.0) — see the _comment in each fixture. That is
// load-bearing: the first version of these controls read hand-crafted
// after_unknown shapes that real tofu never emits ([{}, {}] rule lists), which
// made both controls inert on production plans (everything not_evaluable). These
// tests run against the real shapes so that defect class cannot recur.

// TestHetznerProviderDetected asserts an hcloud plan is recognized as "hetzner" and
// runs the posture control set — no longer a vacuous supported-no-controls pass.
func TestHetznerProviderDetected(t *testing.T) {
	rep := evalCorpus(t, "hetzner_pass.json")
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

// TestHetznerShippedTemplateNoHardFail is the LOAD-BEARING proof from the
// adversarial review: the CURRENTLY SHIPPED Hetzner template (the only cloud with
// a real nightly apply) must evaluate to WARNS ONLY with ZERO hard fails under
// these controls — otherwise tonight's `tofu apply` hard-blocks at the fail-closed
// gate.
//
// hetzner_shipped_warn.json is a REAL plan from a faithful mirror of the shipped
// template: firewall_ids = [hcloud_firewall.this.id] (computed until apply) on
// every server (servers.tf lines 36 & 71), and the firewall opening tcp
// 6443/50000/50001 to 0.0.0.0/0 + ::/0 with everything else confined to the
// private CIDR (network.tf lines 69-121).
//
// Strengthened after the inert-controls defect: the controls must be EVALUABLE on
// this plan, not merely non-failing — a not_evaluable pass-through (the failure
// mode where the gate silently sees nothing) fails this test too.
func TestHetznerShippedTemplateNoHardFail(t *testing.T) {
	rep := evalCorpus(t, "hetzner_shipped_warn.json")

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

	// The anti-inertness half: both controls actually evaluated the plan.
	// Status pass/warn on a plan WITH servers + firewall rules mathematically
	// requires evaluable > 0 (resolveStatus only yields pass/warn from evaluated
	// resources); not_evaluable here would mean the controls went blind again.
	if rep.Summary.NotEvaluable != 0 {
		t.Errorf("shipped template summary.NotEvaluable = %d, want 0 — a control went blind on the real plan shape", rep.Summary.NotEvaluable)
	}
	fw := controlByID(t, rep, "HCLOUD-FW-001")
	if fw.Status != StatusPass {
		t.Errorf("HCLOUD-FW-001 = %q, want pass (every server's configuration references hcloud_firewall.this; coverage: %q)", fw.Status, fw.Coverage)
	}
	if !strings.Contains(fw.Coverage, "hcloud_firewall.this") {
		t.Errorf("HCLOUD-FW-001 coverage %q should cite the configuration reference proving the firewall attachment", fw.Coverage)
	}
	net := controlByID(t, rep, "HCLOUD-NET-001")
	if net.Status != StatusWarn {
		t.Errorf("HCLOUD-NET-001 = %q, want warn (world-open tcp 6443/50000/50001 are by-design posture notes)", net.Status)
	}
	if len(net.Findings) != 3 {
		t.Errorf("HCLOUD-NET-001 findings = %d, want exactly 3 (the three world-open management ports)", len(net.Findings))
	}
	if rep.Verdict != StatusWarn {
		t.Errorf("shipped template verdict = %q, want warn (warns only)", rep.Verdict)
	}
}

// TestHetznerCleanPass asserts the hardened variant (management ports confined to
// admin/private CIDRs) is a genuine PASS with everything evaluable — proving
// HCLOUD-NET-001 discriminates world-open from bounded sources, and that a
// computed-but-referenced firewall_ids is an evaluable pass, not not_evaluable.
func TestHetznerCleanPass(t *testing.T) {
	rep := evalCorpus(t, "hetzner_pass.json")
	if rep.Verdict != StatusPass {
		t.Fatalf("hardened hetzner plan verdict = %q, want pass (controls: %+v)", rep.Verdict, rep.Controls)
	}
	if rep.Summary.NotEvaluable != 0 {
		t.Errorf("summary.NotEvaluable = %d, want 0 (all values are visible on this plan)", rep.Summary.NotEvaluable)
	}
}

// TestHetznerOpenSSHHardFails pins the one always-wrong case: world-open tcp/22 on
// Talos (no SSH daemon) is a hard fail that blocks — on the REAL plan shape, where
// after_unknown.rule is a list of all-false maps (the shape that made v1 inert).
func TestHetznerOpenSSHHardFails(t *testing.T) {
	rep := evalCorpus(t, "hetzner_fail_open_ssh.json")
	if !rep.Blocking() {
		t.Fatalf("world-open SSH did not block (verdict=%s) — the control is inert on real plan shapes", rep.Verdict)
	}
	c := controlByID(t, rep, "HCLOUD-NET-001")
	if c.Status != StatusFail {
		t.Errorf("HCLOUD-NET-001 = %q, want fail for world-open tcp/22", c.Status)
	}
	// The server is firewalled (config references the firewall) — FW-001 passes,
	// isolating the block to the SSH rule.
	if fw := controlByID(t, rep, "HCLOUD-FW-001"); fw.Status != StatusPass {
		t.Errorf("HCLOUD-FW-001 = %q, want pass (server is firewalled)", fw.Status)
	}
}

// TestHetznerNoFirewallHardFails pins the bare-public-node case on a real plan:
// firewall_ids serializes as after_unknown:true even when NOT configured, so the
// judgment must come from the configuration section (no firewall_ids expression).
func TestHetznerNoFirewallHardFails(t *testing.T) {
	rep := evalCorpus(t, "hetzner_fail_no_firewall.json")
	if !rep.Blocking() {
		t.Fatalf("a server with no firewall did not block (verdict=%s)", rep.Verdict)
	}
	if c := controlByID(t, rep, "HCLOUD-FW-001"); c.Status != StatusFail {
		t.Errorf("HCLOUD-FW-001 = %q, want fail for a server with no firewall anywhere", c.Status)
	}
}

// TestHetznerDecoyAttachmentDoesNotNeutralize is the adversarial case: an
// hcloud_firewall_attachment that covers ONLY hcloud_server.covered must not
// blanket-neutralize FW-001 — the unrelated hcloud_server.bare still hard-fails.
func TestHetznerDecoyAttachmentDoesNotNeutralize(t *testing.T) {
	rep := evalCorpus(t, "hetzner_fail_decoy_attachment.json")
	if !rep.Blocking() {
		t.Fatalf("decoy attachment neutralized FW-001 (verdict=%s) — the bare server slipped through", rep.Verdict)
	}
	fw := controlByID(t, rep, "HCLOUD-FW-001")
	if fw.Status != StatusFail {
		t.Fatalf("HCLOUD-FW-001 = %q, want fail (hcloud_server.bare is uncovered)", fw.Status)
	}
	for _, f := range fw.Findings {
		if strings.HasPrefix(f.Address, "hcloud_server.covered") {
			t.Errorf("FW-001 flagged hcloud_server.covered, which the attachment protects: %+v", f)
		}
	}
	found := false
	for _, f := range fw.Findings {
		if strings.HasPrefix(f.Address, "hcloud_server.bare") {
			found = true
		}
	}
	if !found {
		t.Errorf("FW-001 findings %+v do not name hcloud_server.bare", fw.Findings)
	}
}

// TestHetznerSplitCIDRSSHFails: 0.0.0.0/1 + 128.0.0.0/1 on tcp/22 is world-open by
// union — the split-CIDR spelling must not evade the hard fail.
func TestHetznerSplitCIDRSSHFails(t *testing.T) {
	rep := evalCorpus(t, "hetzner_fail_split_cidr_ssh.json")
	if !rep.Blocking() {
		t.Fatalf("split-CIDR world-open SSH did not block (verdict=%s)", rep.Verdict)
	}
	if c := controlByID(t, rep, "HCLOUD-NET-001"); c.Status != StatusFail {
		t.Errorf("HCLOUD-NET-001 = %q, want fail for split-CIDR tcp/22", c.Status)
	}
}

// TestHetznerApplyToLabelNeverBricks: a firewall attached via apply_to
// label_selector (a legitimate BYO pattern) is not mappable to servers from the
// plan — FW-001 must be not_evaluable, NEVER a false hard fail.
func TestHetznerApplyToLabelNeverBricks(t *testing.T) {
	rep := evalCorpus(t, "hetzner_not_evaluable_apply_to.json")
	if rep.Blocking() {
		t.Fatalf("apply_to label-selector coverage caused a false hard fail (verdict=%s) — this bricks a legit BYO pattern", rep.Verdict)
	}
	fw := controlByID(t, rep, "HCLOUD-FW-001")
	if fw.Status != StatusNotEvaluable {
		t.Errorf("HCLOUD-FW-001 = %q, want not_evaluable (label-based coverage is honest-unknowable from the plan)", fw.Status)
	}
	if !strings.Contains(fw.Coverage, "apply_to") {
		t.Errorf("FW-001 coverage %q should explain the apply_to selector is why it cannot judge", fw.Coverage)
	}
}

// TestHetznerUDPAndICMPNotMisjudgedAsSSH: a world-open udp/22 is not SSH, and a
// portless world-open icmp rule (port "") must not be read as "covers port 22".
// Both are generic warns; neither may hard-fail.
func TestHetznerUDPAndICMPNotMisjudgedAsSSH(t *testing.T) {
	rep := evalCorpus(t, "hetzner_warn_udp_icmp.json")
	if rep.Blocking() {
		t.Fatalf("udp/icmp world-open rules were misjudged as SSH and blocked (verdict=%s)", rep.Verdict)
	}
	c := controlByID(t, rep, "HCLOUD-NET-001")
	if c.Status != StatusWarn {
		t.Fatalf("HCLOUD-NET-001 = %q, want warn (generic exposure notes)", c.Status)
	}
	if len(c.Findings) != 2 {
		t.Errorf("findings = %d, want 2 (one per world-open rule)", len(c.Findings))
	}
	for _, f := range c.Findings {
		if strings.Contains(f.Message, "SSH") {
			t.Errorf("a udp/icmp rule was labeled SSH: %s", f.Message)
		}
	}
}

// TestCoversWholeInternet unit-pins the union judgment the split-CIDR case rides
// on, including the non-covering shapes that must NOT count as world-open.
func TestCoversWholeInternet(t *testing.T) {
	cases := []struct {
		name    string
		sources []string
		want    bool
	}{
		{"v4 any", []string{"0.0.0.0/0"}, true},
		{"v6 any", []string{"::/0"}, true},
		{"split v4 halves", []string{"0.0.0.0/1", "128.0.0.0/1"}, true},
		{"split v4 quarters", []string{"192.0.0.0/2", "0.0.0.0/2", "128.0.0.0/2", "64.0.0.0/2"}, true},
		{"one v4 half only", []string{"0.0.0.0/1"}, false},
		{"halves with gap", []string{"0.0.0.0/2", "128.0.0.0/1"}, false},
		{"private cidr", []string{"10.100.0.0/16"}, false},
		{"empty", nil, false},
		{"garbage ignored", []string{"not-a-cidr", "10.0.0.0/8"}, false},
		{"v4 full among garbage", []string{"junk", "0.0.0.0/1", "128.0.0.0/1"}, true},
	}
	for _, tc := range cases {
		if got := coversWholeInternet(tc.sources); got != tc.want {
			t.Errorf("%s: coversWholeInternet(%v) = %v, want %v", tc.name, tc.sources, got, tc.want)
		}
	}
}

// TestHetznerNoConfigIsNotEvaluable pins honesty case 3 of the firewall judgment:
// a change-only plan (no configuration section) cannot distinguish a computed
// firewall_ids from an absent one — not_evaluable, never a guess in either
// direction.
func TestHetznerNoConfigIsNotEvaluable(t *testing.T) {
	plan := mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"hcloud_server.node","mode":"managed","type":"hcloud_server","name":"node",
         "provider_name":"registry.terraform.io/hetznercloud/hcloud",
         "change":{"actions":["create"],"after":{"name":"n1","server_type":"cpx31"},"after_unknown":{"firewall_ids":true}}}
      ]}`)
	rep, err := Evaluate(t.Context(), plan)
	if err != nil {
		t.Fatal(err)
	}
	fw := controlByID(t, rep, "HCLOUD-FW-001")
	if fw.Status != StatusNotEvaluable {
		t.Errorf("HCLOUD-FW-001 = %q, want not_evaluable when the plan has no configuration to consult", fw.Status)
	}
	if rep.Blocking() {
		t.Error("a config-less plan must not hard-block on FW-001 (honest gap, not a proven violation)")
	}
}
