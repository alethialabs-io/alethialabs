// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaGovernance is the registry's entries for the governance family: who is in the organization and what they may do.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. Examples are added here, by the lane that owns the
// family's commands; TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no
// entry.
var metaGovernance = []cmdmeta.Meta{
	{Path: "alethia org", Group: groupOrganization},
	{Path: "alethia org list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia org settings", Idempotent: true, Output: cmdmeta.OutputTable},
	// Changes the active organization stored on this machine.
	{Path: "alethia org switch", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia members", Group: groupOrganization},
	{Path: "alethia members list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia members add", Mutates: true, Output: cmdmeta.OutputTable},
	{Path: "alethia members remove", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia teams", Group: groupOrganization},
	{Path: "alethia teams list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia teams create", Mutates: true, Output: cmdmeta.OutputTable},
	{Path: "alethia teams delete", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia roles", Group: groupOrganization},
	{Path: "alethia roles list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia roles create", Mutates: true, Output: cmdmeta.OutputTable},
	{Path: "alethia roles delete", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia grants", Group: groupOrganization},
	{Path: "alethia grants list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia grants add", Mutates: true, Output: cmdmeta.OutputTable},
	{Path: "alethia grants remove", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia sso", Group: groupOrganization},
	{Path: "alethia sso list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia sso get", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia alerts", Group: groupOrganization},
	{Path: "alethia alerts list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia alerts create", Mutates: true, Output: cmdmeta.OutputTable},
	{Path: "alethia alerts delete", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia channels", Group: groupOrganization},
	{Path: "alethia channels list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia channels create", Mutates: true, Output: cmdmeta.OutputTable},
	// Sends a test event each time it runs.
	{Path: "alethia channels verify", Mutates: true, Output: cmdmeta.OutputTable},
	{Path: "alethia channels delete", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia classification", Group: groupOrganization},
	{Path: "alethia classification dimensions", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia classification show", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia classification assign", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia classification unassign", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia token", Group: groupOrganization},
	{Path: "alethia token list", Idempotent: true, Output: cmdmeta.OutputTable},
	// Prints the new token, once.
	{Path: "alethia token create", Mutates: true, Output: cmdmeta.OutputSecret},
	{Path: "alethia token revoke", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
}
