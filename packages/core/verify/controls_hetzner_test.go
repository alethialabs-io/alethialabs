// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"testing"
)

// TestHetznerShippedTemplateWarnsOnlyZeroFails is the LOAD-BEARING proof for B0.1
// (grill#3). It runs a faithful representation of the CURRENTLY SHIPPED
// infra/templates/project/hetzner plan through the new Hetzner control set and asserts
// the gate produces WARNS ONLY, ZERO FAILS. If the new controls ever hard-fail the
// template Alethia ships, the nightly provision bricks — so this test is the guard
// that a control regression which fails the shipped template breaks the build.
func TestHetznerShippedTemplateWarnsOnlyZeroFails(t *testing.T) {
	rep := evalCorpus(t, "hetzner_shipped_template_warn.json")

	if rep.Summary.Fail != 0 {
		t.Fatalf("shipped Hetzner template produced %d FAIL(s) — this would brick tonight's nightly; controls=%+v",
			rep.Summary.Fail, rep.Controls)
	}
	if rep.Blocking() {
		t.Fatalf("shipped Hetzner template BLOCKS (verdict=%s) — must be non-blocking", rep.Verdict)
	}
	if rep.Verdict != StatusWarn {
		t.Errorf("shipped template verdict = %q, want warn (world-open 6443/50000/50001 are by-design warns)", rep.Verdict)
	}
	if rep.Provider != "hetzner" {
		t.Errorf("provider = %q, want hetzner", rep.Provider)
	}

	// The servers reference the firewall (firewall_ids unknown-until-apply) → FW passes.
	fw := controlByID(t, rep, "HCLOUD-FW-001")
	if fw.Status != StatusPass {
		t.Errorf("HCLOUD-FW-001 = %q, want pass (servers carry firewall_ids); findings=%+v", fw.Status, fw.Findings)
	}
	// The three world-open k8s/Talos ports warn; port 22 is NOT world-open → no fail.
	net := controlByID(t, rep, "HCLOUD-NET-001")
	if net.Status != StatusWarn {
		t.Errorf("HCLOUD-NET-001 = %q, want warn; findings=%+v", net.Status, net.Findings)
	}
	if len(net.Findings) != 3 {
		t.Errorf("HCLOUD-NET-001 findings = %d, want 3 (6443 + 50000 + 50001 world-open); %+v", len(net.Findings), net.Findings)
	}
	// SCOPE-001 must not fire — hcloud is controlled, the rest are supported cluster-layer.
	if hasControl(rep, "SCOPE-001") {
		t.Error("SCOPE-001 fired on the shipped Hetzner template (all providers are recognized)")
	}
}

// TestHetznerServerWithoutFirewallFails proves HCLOUD-FW-001 has teeth: a server with
// no firewall (no firewall_ids, no attachment) is a hard fail.
func TestHetznerServerWithoutFirewallFails(t *testing.T) {
	rep := evalCorpus(t, "hetzner_fail_no_firewall.json")
	if !rep.Blocking() {
		t.Fatalf("firewall-less server: verdict = %q, want fail/blocking", rep.Verdict)
	}
	fw := controlByID(t, rep, "HCLOUD-FW-001")
	if fw.Status != StatusFail || len(fw.Findings) != 1 {
		t.Errorf("HCLOUD-FW-001 = %q findings=%+v, want fail with one finding", fw.Status, fw.Findings)
	}
}

// TestHetznerWorldOpenSSHFails proves HCLOUD-NET-001 has teeth on its ONE hard-fail
// case: SSH (tcp/22) open to 0.0.0.0/0. The co-located server carries a firewall, so
// the only failure is the SSH rule.
func TestHetznerWorldOpenSSHFails(t *testing.T) {
	rep := evalCorpus(t, "hetzner_fail_ssh_world_open.json")
	if !rep.Blocking() {
		t.Fatalf("world-open SSH: verdict = %q, want fail/blocking", rep.Verdict)
	}
	if controlByID(t, rep, "HCLOUD-FW-001").Status != StatusPass {
		t.Error("HCLOUD-FW-001 should pass (server references the firewall) — failure must be isolated to SSH")
	}
	net := controlByID(t, rep, "HCLOUD-NET-001")
	if net.Status != StatusFail {
		t.Errorf("HCLOUD-NET-001 = %q, want fail on world-open SSH; findings=%+v", net.Status, net.Findings)
	}
}

// TestHetznerWorldOpenK8sApiWarnsNotFails pins the by-design distinction: the
// Kubernetes API (6443) open to the world WARNS (surfaced, non-blocking) — it must not
// hard-fail, or the shipped template would be unusable.
func TestHetznerWorldOpenK8sApiWarnsNotFails(t *testing.T) {
	plan := mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"hcloud_firewall.k","mode":"managed","type":"hcloud_firewall","name":"k",
         "provider_name":"registry.terraform.io/hetznercloud/hcloud",
         "change":{"actions":["create"],"after":{"name":"k","rule":[
           {"direction":"in","protocol":"tcp","port":"6443","source_ips":["0.0.0.0/0"]}
         ]},"after_unknown":{"id":true}}}
      ]}`)
	rep, err := Evaluate(context.Background(), plan)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Blocking() {
		t.Fatalf("world-open 6443 must not block; verdict=%s", rep.Verdict)
	}
	net := controlByID(t, rep, "HCLOUD-NET-001")
	if net.Status != StatusWarn {
		t.Errorf("HCLOUD-NET-001 = %q, want warn for world-open 6443; findings=%+v", net.Status, net.Findings)
	}
}

// TestHetznerComputedFirewallRulesNotEvaluable pins the honesty surface: a firewall
// whose rule block is computed until apply cannot be judged — not_evaluable, never a
// silent pass.
func TestHetznerComputedFirewallRulesNotEvaluable(t *testing.T) {
	plan := mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"hcloud_firewall.c","mode":"managed","type":"hcloud_firewall","name":"c",
         "provider_name":"registry.terraform.io/hetznercloud/hcloud",
         "change":{"actions":["create"],"after":{"name":"c"},"after_unknown":{"id":true,"rule":true}}}
      ]}`)
	rep, err := Evaluate(context.Background(), plan)
	if err != nil {
		t.Fatal(err)
	}
	net := controlByID(t, rep, "HCLOUD-NET-001")
	if net.Status != StatusNotEvaluable {
		t.Errorf("HCLOUD-NET-001 = %q, want not_evaluable for a computed rule block; coverage=%q", net.Status, net.Coverage)
	}
}

// TestPortRangeCoversSSH unit-pins the port-spec parser that decides SSH-open.
func TestPortRangeCoversSSH(t *testing.T) {
	cases := map[string]bool{
		"22": true, "any": true, "20-30": true, "1-65535": true,
		"": false, "6443": false, "50000": false, "23-80": false, "8080": false,
	}
	for port, want := range cases {
		if got := portRangeCoversSSH(port); got != want {
			t.Errorf("portRangeCoversSSH(%q) = %v, want %v", port, got, want)
		}
	}
}
