// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"strings"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// rc builds one resource change for a spend-policy fixture.
func rc(typ, addr string, actions tfjson.Actions, after, unknown map[string]any) *tfjson.ResourceChange {
	return &tfjson.ResourceChange{
		Address: addr,
		Type:    typ,
		Change:  &tfjson.Change{Actions: actions, After: after, AfterUnknown: unknown},
	}
}

var (
	actCreate  = tfjson.Actions{tfjson.ActionCreate}
	actUpdate  = tfjson.Actions{tfjson.ActionUpdate}
	actReplace = tfjson.Actions{tfjson.ActionDelete, tfjson.ActionCreate}
	actDestroy = tfjson.Actions{tfjson.ActionDelete}
	actNoop    = tfjson.Actions{tfjson.ActionNoop}
)

// planOf wraps resource changes into a plan.
func planOf(changes ...*tfjson.ResourceChange) *tfjson.Plan {
	return &tfjson.Plan{ResourceChanges: changes}
}

// TestSpendPolicyBlock proves every control in the policy can go RED, and that each stays green
// on the shapes the e2e actually provisions. A table with only green rows would pass on a
// function that always returns false.
func TestSpendPolicyBlock(t *testing.T) {
	capPolicy := SpendPolicy{HcloudServerTypes: []string{"cpx22", "cpx32", "cx33"}}
	prepaid := SpendPolicy{RefusePrepaid: true}
	server := func(typ string, a tfjson.Actions) *tfjson.ResourceChange {
		return rc("hcloud_server", "hcloud_server.workers[\"w1\"]", a, map[string]any{"server_type": typ}, map[string]any{})
	}
	crEE := func(payment string, a tfjson.Actions) *tfjson.ResourceChange {
		return rc("alicloud_cr_ee_instance", "module.cr[0].alicloud_cr_ee_instance.this", a,
			map[string]any{"payment_type": payment, "instance_type": "Basic"}, map[string]any{})
	}

	tests := []struct {
		name        string
		plan        *tfjson.Plan
		policy      SpendPolicy
		wantBlocked bool
		wantMsgHas  string
	}{
		// Disabled: the default for every customer apply.
		{name: "zero policy ignores a huge server", plan: planOf(server("ccx63", actCreate)), policy: SpendPolicy{}, wantBlocked: false},
		{name: "zero policy ignores a subscription", plan: planOf(crEE("Subscription", actCreate)), policy: SpendPolicy{}, wantBlocked: false},
		{name: "zero policy with no plan is not a block", plan: nil, policy: SpendPolicy{}, wantBlocked: false},

		// Fail-closed when on and the plan was not readable.
		{name: "cap on, no plan JSON fail-closes", plan: nil, policy: capPolicy, wantBlocked: true, wantMsgHas: "could not be read"},
		{name: "prepaid on, no plan JSON fail-closes", plan: nil, policy: prepaid, wantBlocked: true, wantMsgHas: "could not be read"},

		// Hetzner cap — red.
		{name: "server type above the cap is refused", plan: planOf(server("ccx63", actCreate)), policy: capPolicy, wantBlocked: true, wantMsgHas: `"ccx63"`},
		{name: "an update to a type above the cap is refused", plan: planOf(server("cpx52", actUpdate)), policy: capPolicy, wantBlocked: true, wantMsgHas: `"cpx52"`},
		{name: "a replace into a type above the cap is refused", plan: planOf(server("cx53", actReplace)), policy: capPolicy, wantBlocked: true, wantMsgHas: `"cx53"`},
		{name: "a server_type unknown until apply is refused", plan: planOf(rc("hcloud_server", "hcloud_server.x", actCreate, map[string]any{}, map[string]any{"server_type": true})), policy: capPolicy, wantBlocked: true, wantMsgHas: "not known until apply"},
		{name: "a server with no server_type is refused", plan: planOf(rc("hcloud_server", "hcloud_server.x", actCreate, map[string]any{}, map[string]any{})), policy: capPolicy, wantBlocked: true, wantMsgHas: "no readable server_type"},
		{name: "one bad server among good ones is refused", plan: planOf(server("cpx22", actCreate), server("ccx13", actCreate)), policy: capPolicy, wantBlocked: true, wantMsgHas: `"ccx13"`},
		// Hetzner cap — green.
		{name: "floor type is allowed", plan: planOf(server("cpx22", actCreate)), policy: capPolicy, wantBlocked: false},
		{name: "heavy and demo types are allowed", plan: planOf(server("cpx32", actCreate), server("cx33", actCreate)), policy: capPolicy, wantBlocked: false},
		{name: "type match ignores case", plan: planOf(server("CPX22", actCreate)), policy: capPolicy, wantBlocked: false},
		{name: "deleting an oversize server is not refused", plan: planOf(server("ccx63", actDestroy)), policy: capPolicy, wantBlocked: false},
		{name: "an existing oversize server left alone is not refused", plan: planOf(server("ccx63", actNoop)), policy: capPolicy, wantBlocked: false},
		{name: "the cap reads only hcloud_server", plan: planOf(rc("hcloud_load_balancer", "hcloud_load_balancer.x", actCreate, map[string]any{"server_type": "ccx63"}, nil)), policy: capPolicy, wantBlocked: false},

		// Alibaba prepaid — red.
		{name: "CR EE subscription is refused", plan: planOf(crEE("Subscription", actCreate)), policy: prepaid, wantBlocked: true, wantMsgHas: "payment_type"},
		{name: "subscription match ignores case", plan: planOf(crEE("SUBSCRIPTION", actCreate)), policy: prepaid, wantBlocked: true, wantMsgHas: "payment_type"},
		{name: "PrePaid instance_charge_type is refused", plan: planOf(rc("alicloud_cs_kubernetes_node_pool", "alicloud_cs_kubernetes_node_pool.x", actCreate, map[string]any{"instance_charge_type": "PrePaid"}, nil)), policy: prepaid, wantBlocked: true, wantMsgHas: "instance_charge_type"},
		// Alibaba prepaid — green.
		{name: "pay-as-you-go is allowed", plan: planOf(crEE("PayAsYouGo", actCreate), rc("alicloud_cs_kubernetes_node_pool", "np", actCreate, map[string]any{"instance_charge_type": "PostPaid"}, nil)), policy: prepaid, wantBlocked: false},
		{name: "releasing a subscription is not refused", plan: planOf(crEE("Subscription", actDestroy)), policy: prepaid, wantBlocked: false},
		{name: "an existing subscription left alone is not refused", plan: planOf(crEE("Subscription", actNoop)), policy: prepaid, wantBlocked: false},
		{name: "the prepaid check reads only alicloud resources", plan: planOf(rc("aws_instance", "aws_instance.x", actCreate, map[string]any{"payment_type": "Subscription"}, nil)), policy: prepaid, wantBlocked: false},

		// A control that is off does not fire on the other cloud's shape.
		{name: "cap alone ignores a subscription", plan: planOf(crEE("Subscription", actCreate)), policy: capPolicy, wantBlocked: false},
		{name: "prepaid alone ignores an oversize server", plan: planOf(server("ccx63", actCreate)), policy: prepaid, wantBlocked: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			blocked, msg := spendPolicyBlock(tt.plan, tt.policy)
			if blocked != tt.wantBlocked {
				t.Fatalf("blocked = %v, want %v (msg %q)", blocked, tt.wantBlocked, msg)
			}
			if tt.wantBlocked && !strings.Contains(msg, tt.wantMsgHas) {
				t.Errorf("msg %q does not contain %q", msg, tt.wantMsgHas)
			}
			if !tt.wantBlocked && msg != "" {
				t.Errorf("an allowed plan returned a message: %q", msg)
			}
		})
	}
}

// TestSpendPolicyEnabled pins which policies count as switched on.
func TestSpendPolicyEnabled(t *testing.T) {
	if (SpendPolicy{}).Enabled() {
		t.Error("the zero policy must be disabled — it is the default for every customer apply")
	}
	if !(SpendPolicy{HcloudServerTypes: []string{"cpx22"}}).Enabled() {
		t.Error("a server-type cap must enable the policy")
	}
	if !(SpendPolicy{RefusePrepaid: true}).Enabled() {
		t.Error("RefusePrepaid must enable the policy")
	}
}
