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
	// Stores a credential on this machine. Already being signed in changes nothing without --force.
	{Path: "alethia login", Group: groupStart, Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia logout", Group: groupSettings, Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia whoami", Group: groupSettings, Idempotent: true, Output: cmdmeta.OutputTable},
}
