// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestCurrentOrgID(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)

	// --org flag wins.
	c := testCmd("table", false)
	c.Flags().String("org", "from-flag", "")
	if got, err := currentOrgID(c); err != nil || got != "from-flag" {
		t.Errorf("expected from-flag, got %q (%v)", got, err)
	}

	// No flag, no config → error.
	c2 := testCmd("table", false)
	c2.Flags().String("org", "", "")
	if _, err := currentOrgID(c2); err == nil {
		t.Error("expected error with no active org")
	}

	// No flag, config active org → that org.
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "cfg-org"}); err != nil {
		t.Fatal(err)
	}
	if got, err := currentOrgID(c2); err != nil || got != "cfg-org" {
		t.Errorf("expected cfg-org, got %q (%v)", got, err)
	}
}
