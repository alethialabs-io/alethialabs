// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import "testing"

// init registers the Hetzner template in the node-pool contract harness (nodepool_contract_test.go),
// with the real hetzner provider: the harness reads infra/templates/project/hetzner and the generated
// template-knobs.json, and builds tfvars through hetznerProvider.ProviderTfvars.
func init() { nodePoolProviders["hetzner"] = nodePoolTarget{provider: &hetznerProvider{}} }

// TestNodePoolContract_Hetzner holds the Hetzner template to the cross-cloud node-pool contract
// (#5533): node_labels, node_taints and extra_node_pools declared as the reference declares them,
// every reference case carried in nodepool_contract.tftest.hcl, each value reachable from the Cluster
// component's provider_config, and each one a settable cluster knob (#5536).
func TestNodePoolContract_Hetzner(t *testing.T) { assertNodePoolContract(t, "hetzner") }
