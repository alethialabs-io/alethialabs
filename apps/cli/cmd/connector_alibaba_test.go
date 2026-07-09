// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/connector"
)

func TestConnectorAlibabaCommandRegistered(t *testing.T) {
	var found bool
	var short string
	for _, c := range connectorCmd.Commands() {
		if c.Name() == "alibaba" {
			found = true
			short = c.Short
			break
		}
	}
	if !found {
		t.Fatal("`connector alibaba` command is not registered")
	}
	if !strings.Contains(short, "Alibaba") {
		t.Errorf("connector alibaba Short = %q, want it to mention Alibaba", short)
	}
	// The parent command's help should advertise Alibaba too (parity with AWS/GCP/Azure).
	if !strings.Contains(connectorCmd.Short, "Alibaba") {
		t.Errorf("connector Short = %q, want Alibaba listed", connectorCmd.Short)
	}
}

func TestAlibabaConnectorModuleEmbedded(t *testing.T) {
	m := connector.AlibabaConnectorModule
	for _, want := range []string{
		"alicloud_ims_oidc_provider", // the RAM OIDC provider
		"alicloud_ram_role",          // the assumable role
		"alethia-connector",          // pinned workload subject
		"var.alethia_issuer_url",     // issuer trust root (CLI overrides for self-host)
		`output "role_arn"`,          // the value the user pastes back
	} {
		if !strings.Contains(m, want) {
			t.Errorf("embedded Alibaba module missing %q", want)
		}
	}
}
