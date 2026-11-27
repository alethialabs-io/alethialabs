// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"
)

// TestDocTree_DescribesTheDefaultBuild pins that the docs and man pages describe what a default
// build lists, whatever the generating environment has switched on: ops stays out even with its
// capability on, and the commands a person does run, `alethia mcp` among them, are in.
func TestDocTree_DescribesTheDefaultBuild(t *testing.T) {
	reapplyMetaAfter(t)
	modeEnv(t, map[string]string{OpsEnv: "1"})

	root, doc := DocTree()
	if root != rootCmd {
		t.Fatal("DocTree returned a tree other than the CLI's")
	}
	if !opsCmd.Hidden {
		t.Error("ops is listed in the docs tree with only the environment switching it on")
	}
	seen := map[string]bool{}
	for _, c := range doc.Commands {
		seen[c.Path] = true
		if strings.HasPrefix(c.Path, "alethia ops") {
			t.Errorf("%q is described for the docs", c.Path)
		}
	}
	for _, want := range []string{"alethia mcp", "alethia apply", "alethia project list"} {
		if !seen[want] {
			t.Errorf("%q is missing from the docs description", want)
		}
	}
}
