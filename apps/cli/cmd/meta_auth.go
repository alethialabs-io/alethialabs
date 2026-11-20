// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaAuth is the registry's entries for signing in and out.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. Examples are added here, by the lane that owns the
// family's commands; TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no
// entry.
var metaAuth = []cmdmeta.Meta{
	// Stores a credential on this machine, in the system keychain or an owner-only file. Already
	// being signed in changes nothing without --force. It waits for the browser half, which is a
	// wait on a person and not a queued job, so it is not long-running in the registry's sense.
	{
		Path: "alethia login", Group: groupStart, Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia login", Note: "Sign in from the browser and store the credential in the system keychain."},
			{Cmd: "alethia login --web-origin https://alethia.example.com", Note: "Sign in to a self-hosted control plane and remember its URL."},
			{Cmd: "alethia login --no-browser", Note: "Print the URL to open on another machine."},
			{Cmd: "alethia login --force --output json", Note: "Replace the stored session and print the result as json."},
		},
	},
	// Removes the stored credential from the keychain and the file, and the kubeconfig credential
	// cache. It removes only what this machine holds and nothing in the control plane, so it is not
	// destructive in the registry's sense; a second run finds nothing and succeeds.
	{
		Path: "alethia logout", Group: groupSettings, Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia logout", Note: "Remove the stored credential and the cached kubeconfig credentials."},
			{Cmd: "alethia logout --output json", Note: "Report what was removed as json."},
		},
	},
	{
		Path: "alethia whoami", Group: groupSettings, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia whoami", Note: "Show the user, the active organization and where the credential came from."},
			{Cmd: "alethia whoami --output json", Note: "The same as one json object."},
		},
	},
	{Path: "alethia auth", Group: groupSettings},
	// Reads the credential store and sends nothing.
	{
		Path: "alethia auth status", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia auth status", Note: "Show which credential is in use, where it is stored and when it expires."},
			{Cmd: "alethia auth status --output json", Note: "The same as one json object; exits 4 when there is no credential."},
		},
	},
}
