// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaGovernance is the registry's entries for the governance family: who is in the organization and what they may do.
//
// Every runnable command of the family is listed with its facts and its examples. What each field
// means is documented once, on cmdmeta.Meta. The facts were checked against the command bodies:
// TestMetaGovernance_TheFactsMatchTheCommands holds the ones a test can read off the tree, and
// TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no entry.
//
// The examples use literal names — a member ada@example.com, a team called platform, a channel
// called "Ops Slack" — so each one can be run as written against things of that name. None carries
// a value that has to be copied out of another command's output.
var metaGovernance = []cmdmeta.Meta{
	{Path: "alethia org", Group: groupOrganization},
	{
		Path: "alethia org list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia org list", Note: "Every organization you belong to, with the active one marked"},
			{Cmd: "alethia org list --output json", Note: "The same list for a program"},
		},
	},
	{
		Path: "alethia org settings", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia org settings", Note: "The active organization's general settings"},
			{Cmd: "alethia org settings --org acme --output json", Note: "Another organization's settings, without switching to it"},
		},
	},
	// Changes the active organization stored on this machine. Nothing changes on the control
	// plane, so there is no request for a dry run to report.
	{
		Path: "alethia org switch", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia org switch acme", Note: "Make acme the organization your commands act in"},
			{Cmd: "alethia org switch", Note: "Pick from the organizations you belong to"},
		},
	},
	{Path: "alethia members", Group: groupOrganization},
	{
		Path: "alethia members list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia members list", Note: "Everyone in the active organization"},
			{Cmd: "alethia members list --output csv", Note: "The same list as rows for a spreadsheet"},
		},
	},
	// Sends an invitation each time it runs.
	{
		Path: "alethia members add", Mutates: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia members add ada@example.com --role admin", Note: "Invite someone as an admin"},
			{Cmd: "alethia members add", Note: "Be asked for the email and the role"},
			{Cmd: "alethia members add ada@example.com --dry-run --output json", Note: "Check the input and print the request, without inviting anyone"},
		},
	},
	// A second run finds the member already gone and says so.
	{
		Path: "alethia members remove", Mutates: true, Destructive: true, Idempotent: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia members remove --email ada@example.com", Note: "Remove a member; you type their email to confirm"},
			{Cmd: "alethia members remove --email ada@example.com --yes --output json", Note: "Remove a member from a script"},
		},
	},
	{Path: "alethia teams", Group: groupOrganization},
	{
		Path: "alethia teams list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia teams list", Note: "Every team and how many members it has"},
			{Cmd: "alethia teams list --output json"},
		},
	},
	{
		Path: "alethia teams create", Mutates: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia teams create platform", Note: "Create a team called platform"},
			{Cmd: "alethia teams create platform --output json", Note: "Create it and read the new team's id from the result"},
		},
	},
	{
		Path: "alethia teams delete", Mutates: true, Destructive: true, Idempotent: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia teams delete --name platform", Note: "Delete a team; you type its name to confirm"},
			{Cmd: "alethia teams delete --name platform --yes", Note: "Delete a team from a script"},
		},
	},
	{Path: "alethia roles", Group: groupOrganization},
	{
		Path: "alethia roles list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia roles list", Note: "The built-in templates and the organization's custom roles"},
			{Cmd: "alethia roles list --output json", Note: "Each role with its permission keys"},
		},
	},
	{
		Path: "alethia roles create", Mutates: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia roles create deployers --permission project:deploy --permission project:read", Note: "A custom role with two permissions"},
			{Cmd: "alethia roles create deployers", Note: "Choose the permissions from the control plane's catalog"},
		},
	},
	{
		Path: "alethia roles delete", Mutates: true, Destructive: true, Idempotent: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia roles delete --name deployers", Note: "Delete a custom role; you type its name to confirm"},
			{Cmd: "alethia roles delete --name deployers --dry-run", Note: "See which role would be deleted, and delete nothing"},
		},
	},
	{Path: "alethia grants", Group: groupOrganization},
	{
		Path: "alethia grants list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia grants list", Note: "Every access grant in the active organization"},
			{Cmd: "alethia grants list --output json"},
		},
	},
	// Writes a grant each time it runs.
	{
		Path: "alethia grants add", Mutates: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia grants add --principal ada@example.com --role viewer", Note: "Give one person the viewer role across the organization"},
			{Cmd: "alethia grants add --principal-type team --principal platform --permission project:deploy --resource-type project", Note: "Let a team deploy every project"},
			{Cmd: "alethia grants add --principal ada@example.com --permission project:delete --effect deny", Note: "Deny one permission, whatever else allows it"},
		},
	},
	{
		Path: "alethia grants remove", Mutates: true, Destructive: true, Idempotent: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia grants remove", Note: "Pick the grant to revoke from the list"},
		},
	},
	{Path: "alethia sso", Group: groupOrganization},
	{
		Path: "alethia sso list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia sso list", Note: "The identity providers the organization signs in through"},
		},
	},
	{
		Path: "alethia sso get", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia sso get --domain example.com", Note: "The provider that serves one email domain"},
			{Cmd: "alethia sso get --domain example.com --output json"},
		},
	},
	{Path: "alethia alerts", Group: groupOrganization},
	{
		Path: "alethia alerts list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia alerts list", Note: "Every alert rule and where it routes"},
			{Cmd: "alethia alerts list --output json"},
		},
	},
	{
		Path: "alethia alerts create", Mutates: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: `alethia alerts create "Job failures" --event system.job.failed --channel "Ops Slack" --severity critical`, Note: "Send every failed job to one channel"},
			{Cmd: "alethia alerts create", Note: "Be asked for the name, the events, the channels and the severity"},
		},
	},
	{
		Path: "alethia alerts delete", Mutates: true, Destructive: true, Idempotent: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: `alethia alerts delete "Job failures"`, Note: "Delete a rule by name; you are asked first"},
			{Cmd: `alethia alerts delete "Job failures" --yes`, Note: "Delete a rule from a script"},
		},
	},
	{Path: "alethia channels", Group: groupOrganization},
	{
		Path: "alethia channels list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia channels list", Note: "Every notification channel and whether it is verified"},
			{Cmd: "alethia channels list --output json"},
		},
	},
	{
		Path: "alethia channels create", Mutates: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: `alethia channels create "Ops Slack" --type slack --url https://hooks.slack.com/services/T000/B000/XXXX`, Note: "A Slack channel"},
			{Cmd: `alethia channels create "On-call" --type email --recipient oncall@example.com`, Note: "An email channel"},
			{Cmd: `alethia channels create "Pager" --type pagerduty --routing-key-stdin`, Note: "A PagerDuty channel, with the routing key piped in on stdin"},
		},
	},
	// Sends a test event each time it runs.
	{
		Path: "alethia channels verify", Mutates: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: `alethia channels verify "Ops Slack"`, Note: "Send one test event and mark the channel verified"},
		},
	},
	{
		Path: "alethia channels delete", Mutates: true, Destructive: true, Idempotent: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: `alethia channels delete "Ops Slack"`, Note: "Delete a channel by name; you are asked first"},
			{Cmd: `alethia channels delete "Ops Slack" --yes`, Note: "Delete a channel from a script"},
		},
	},
	{Path: "alethia classification", Group: groupOrganization},
	{
		Path: "alethia classification dimensions", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia classification dimensions", Note: "The taxonomy: every dimension and the value slugs it allows"},
			{Cmd: "alethia classification dimensions --output json"},
		},
	},
	{
		Path: "alethia classification show", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia classification show", Note: "Pick the resource kind, give its id, and read its values"},
		},
	},
	{
		Path: "alethia classification assign", Mutates: true, Idempotent: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia classification assign project_environment 6f1c2a9e-4b7d-4c1e-9a53-2d8e7f0b1c34 tier gold", Note: "Pin the gold value of the tier dimension to one environment"},
		},
	},
	{
		Path: "alethia classification unassign", Mutates: true, Destructive: true, Idempotent: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia classification unassign project_environment 6f1c2a9e-4b7d-4c1e-9a53-2d8e7f0b1c34 gold --yes", Note: "Clear the gold value from one environment, from a script"},
		},
	},
	{Path: "alethia token", Group: groupOrganization},
	{
		Path: "alethia token list", Idempotent: true, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia token list", Note: "Every service token, with its status"},
			{Cmd: "alethia token list --output json"},
		},
	},
	// Prints the new token, once. Mints a new token each time it runs.
	{
		Path: "alethia token create", Mutates: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputSecret,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia token create --name ci --expires-in-days 90", Note: "Mint a token for a pipeline; it is printed once"},
			{Cmd: "alethia token create --name ci --output json", Note: "The token as the `token` field of one document"},
		},
	},
	// Revokes without asking, and so carries no --yes: revoking a leaked token must not wait on
	// a prompt. A second run finds the token already revoked.
	{
		Path: "alethia token revoke", Mutates: true, Destructive: true, Idempotent: true, DryRun: cmdmeta.DryRunClient, Output: cmdmeta.OutputTable,
		Examples: []cmdmeta.Example{
			{Cmd: "alethia token revoke", Note: "Pick the token to revoke from the live ones"},
			{Cmd: "alethia token revoke --dry-run", Note: "Pick a token and see what would be revoked, without revoking it"},
		},
	},
}
