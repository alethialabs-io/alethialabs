// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaBuiltin is the registry's entries for the two commands the command library provides itself: `help` and
// `completion`. cobra adds them to the tree; cmdmeta.Apply makes sure they are there before it
// groups them.
var metaBuiltin = []cmdmeta.Meta{
	{
		Path: "alethia help", Group: groupSettings, Idempotent: true, Output: cmdmeta.OutputNone,
		Examples: []cmdmeta.Example{{Cmd: "alethia help project", Note: "Show the help of one command"}},
	},
	{Path: "alethia completion", Group: groupSettings},
	{
		Path: "alethia completion bash", Idempotent: true, Output: cmdmeta.OutputDocument,
		Examples: []cmdmeta.Example{{Cmd: "alethia completion bash", Note: "Print the bash completion script"}},
	},
	{
		Path: "alethia completion zsh", Idempotent: true, Output: cmdmeta.OutputDocument,
		Examples: []cmdmeta.Example{{Cmd: "alethia completion zsh", Note: "Print the zsh completion script"}},
	},
	{
		Path: "alethia completion fish", Idempotent: true, Output: cmdmeta.OutputDocument,
		Examples: []cmdmeta.Example{{Cmd: "alethia completion fish", Note: "Print the fish completion script"}},
	},
	{
		Path: "alethia completion powershell", Idempotent: true, Output: cmdmeta.OutputDocument,
		Examples: []cmdmeta.Example{{Cmd: "alethia completion powershell", Note: "Print the PowerShell completion script"}},
	},
}
