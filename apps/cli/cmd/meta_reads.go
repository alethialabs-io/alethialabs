// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaReads is the registry's entries for the read-only reports, bring-your-own sources and add-ons.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. Examples are added here, by the lane that owns the
// family's commands; TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no
// entry.
var metaReads = []cmdmeta.Meta{
	{Path: "alethia activity", Group: groupInspect, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia billing", Group: groupOrganization, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia usage", Group: groupOrganization, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia cost", Group: groupInspect},
	{Path: "alethia cost show", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia drift", Group: groupInspect},
	{Path: "alethia drift show", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia staged", Group: groupInspect},
	{Path: "alethia staged list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia probes", Group: groupInspect},
	{Path: "alethia probes list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia protection", Group: groupInspect},
	{Path: "alethia protection list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia promotion", Group: groupInspect},
	{Path: "alethia promotion list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia promotion get", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia repo", Group: groupInspect},
	{Path: "alethia repo list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia iac", Group: groupDeploy},
	{Path: "alethia iac show", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia iac attach", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia iac scan", Mutates: true, LongRunning: true, Output: cmdmeta.OutputTable},
	{Path: "alethia iac detach", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia chart", Group: groupDeploy},
	{Path: "alethia chart list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia chart attach", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia chart scan", Mutates: true, LongRunning: true, Output: cmdmeta.OutputTable},
	{Path: "alethia chart detach", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia addon", Group: groupDeploy},
	{Path: "alethia addon list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia addon enable", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia addon disable", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	// Opens a pull request.
	{Path: "alethia addon bump", Mutates: true, Output: cmdmeta.OutputTable},
}
