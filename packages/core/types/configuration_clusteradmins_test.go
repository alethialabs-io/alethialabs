// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

import (
	"encoding/json"
	"testing"
)

// TestConfigurationDecodesClusterAdminsAsAList pins the shape the API actually sends.
//
// `cluster_admins` was typed `*string` here while the sibling ProjectClusterConfig in this same
// package typed the same field `[]any` — and the API serialises the project_cluster_admins rows as
// an array. So `alethia project get <name>` failed on ANY project with an admin:
//
//	json: cannot unmarshal array into Go struct field Configuration.configuration.cluster_admins of type string
//
// Nothing in the repo read Configuration.ClusterAdmins, which is exactly why it sat: the only
// symptom was a demo-path command dying on a decode, and no test decoded a realistic payload.
func TestConfigurationDecodesClusterAdminsAsAList(t *testing.T) {
	// The shape the console returns: a list of admin objects, not a string.
	const payload = `{"cluster_admins":[{"principal":"group:platform","groups":["g-1"],"ordinal":0}]}`

	var c Configuration
	if err := json.Unmarshal([]byte(payload), &c); err != nil {
		t.Fatalf("decoding a real cluster_admins payload failed: %v", err)
	}
	if len(c.ClusterAdmins) != 1 {
		t.Fatalf("ClusterAdmins = %v, want one entry", c.ClusterAdmins)
	}
}

// TestConfigurationClusterAdminsTolerantOfEmpty — a project with no admins sends `[]` or null, and
// both must decode. Asserted because the fix would be worthless if it only handled the populated
// case: the empty one is what every fresh project sends, including the one a demo creates.
func TestConfigurationClusterAdminsTolerantOfEmpty(t *testing.T) {
	for _, payload := range []string{`{"cluster_admins":[]}`, `{"cluster_admins":null}`, `{}`} {
		var c Configuration
		if err := json.Unmarshal([]byte(payload), &c); err != nil {
			t.Errorf("decoding %s failed: %v", payload, err)
		}
		if len(c.ClusterAdmins) != 0 {
			t.Errorf("decoding %s gave %v, want empty", payload, c.ClusterAdmins)
		}
	}
}
