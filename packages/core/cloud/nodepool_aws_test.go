// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import "testing"

// init registers the AWS template in the node-pool contract harness (nodepool_contract_test.go),
// with the real aws provider: the harness reads infra/templates/project/aws and the generated
// template-knobs.json, and builds tfvars through awsProvider.ProviderTfvars.
func init() { nodePoolProviders["aws"] = nodePoolTarget{provider: &awsProvider{}} }

// TestNodePoolContract_AWS holds the AWS template to the cross-cloud node-pool contract (#5533):
// node_labels, node_taints and extra_node_pools declared as the reference declares them, every
// reference case carried in nodepool_contract.tftest.hcl, each value reachable from the Cluster
// component's provider_config, and each one a settable cluster knob (#5534).
func TestNodePoolContract_AWS(t *testing.T) { assertNodePoolContract(t, "aws") }
