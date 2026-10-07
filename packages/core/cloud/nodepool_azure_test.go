// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import "testing"

// Azure's lane of the node-pool contract (#5535). Registered from this file, as the harness asks
// (nodepool_contract_test.go), so no two cloud lanes edit the same line.
func init() { nodePoolProviders["azure"] = nodePoolTarget{provider: &azureProvider{}} }

// TestNodePoolContract_Azure holds the real Azure template to the cross-cloud node-pool contract:
// the three variables declared verbatim, every contract case carried in its tofu test, each value
// reaching its tfvar from the Cluster component's provider_config, and each knob settable on the
// Azure cluster card.
func TestNodePoolContract_Azure(t *testing.T) { assertNodePoolContract(t, "azure") }
