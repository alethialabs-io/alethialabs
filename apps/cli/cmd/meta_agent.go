// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaAgent is the registry's entries for agent identities.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. Examples are added here, by the lane that owns the
// family's commands; TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no
// entry.
var metaAgent = []cmdmeta.Meta{
	{Path: "alethia agent", Group: groupOrganization},
	{Path: "alethia agent list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia agent get", Idempotent: true, Output: cmdmeta.OutputTable},
}
