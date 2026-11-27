// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/spf13/cobra"
)

// DocTree returns the command tree and its description as the generated docs and man pages show
// them (tools/gendocs).
//
// The registry is applied with every capability switched off, whatever the environment says, so
// the result is what a default build lists: a command behind a switch, such as `alethia ops`, has
// no man page and no row in the generated reference. The clouds are the ones this build offers, so
// a command specific to a hidden cloud is left out as well.
//
// It is the only way a program outside this package reaches the tree, and it does not run it.
func DocTree() (*cobra.Command, cmdmeta.Document) {
	registry := commandRegistry()
	registry.Apply(rootCmd, docOptions())
	return rootCmd, registry.Describe(rootCmd)
}

// docOptions are the registry options of a default build: no capability on, and the clouds the
// catalog offers.
func docOptions() cmdmeta.Options {
	return cmdmeta.Options{
		Enabled:      func(string) bool { return false },
		CloudEnabled: CloudEnabled,
	}
}
