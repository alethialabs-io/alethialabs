// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaShell is the registry's entries for the shell: the root command and the first-run verbs hanging directly off it.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. Examples are added here, by the lane that owns the
// family's commands; TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no
// entry.
var metaShell = []cmdmeta.Meta{
	// A bare `alethia` prints the banner and the help.
	{Path: "alethia", Idempotent: true, Output: cmdmeta.OutputNone},
	{Path: "alethia up", Group: groupStart, Mutates: true, LongRunning: true, Output: cmdmeta.OutputTable},
	// Writes alethia.yaml and the CLI's own configuration; it may also sign in.
	{Path: "alethia init", Group: groupStart, Mutates: true, Output: cmdmeta.OutputTable},
	{Path: "alethia version", Group: groupSettings, Idempotent: true, Output: cmdmeta.OutputTable},
	// Replaces the CLI's own binary. Already being on the latest release changes nothing.
	{Path: "alethia update", Group: groupSettings, Mutates: true, Idempotent: true, Output: cmdmeta.OutputNone},
	// Opens a browser. Nothing is written anywhere.
	{Path: "alethia open", Group: groupSettings, Idempotent: true, Output: cmdmeta.OutputNone},
}
