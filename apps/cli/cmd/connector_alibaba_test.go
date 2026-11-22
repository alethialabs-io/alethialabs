// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/connector"
)

// TestConnectorAlibabaCommandRegistered pins that the command is kept while the cloud is hidden:
// it is registered, it carries its own description, and the parent's help leaves it out until an
// operator re-enables the cloud.
func TestConnectorAlibabaCommandRegistered(t *testing.T) {
	cloudsRestoreHelp(t)
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

	cloudsOffer(t, "")
	if strings.Contains(connectorCmd.Short, "Alibaba") {
		t.Errorf("connector Short = %q, names a cloud that is not offered", connectorCmd.Short)
	}
	cloudsOffer(t, "alibaba")
	if connectorCmd.Short != "Connect cloud accounts (AWS, GCP, Azure, Alibaba and Hetzner)" {
		t.Errorf("connector Short = %q, want the re-enabled cloud listed", connectorCmd.Short)
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
