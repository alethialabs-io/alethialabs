// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaProject is the registry's entries for the project family.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. Examples are added here, by the lane that owns the
// family's commands; TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no
// entry.
var metaProject = []cmdmeta.Meta{
	{Path: "alethia project", Group: groupDeploy},
	{Path: "alethia project list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia project get", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia project create", Mutates: true, Output: cmdmeta.OutputTable},
	// Queues a plan job. No infrastructure changes, but a job is created each time.
	{Path: "alethia project plan", Mutates: true, LongRunning: true, Output: cmdmeta.OutputTable},
	{Path: "alethia project apply", Mutates: true, LongRunning: true, Output: cmdmeta.OutputTable},
	{Path: "alethia project destroy", Mutates: true, Destructive: true, LongRunning: true, Output: cmdmeta.OutputTable},
	{Path: "alethia project env list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia project env add", Mutates: true, Output: cmdmeta.OutputTable},
	{Path: "alethia project component kinds", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia project component list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia project component add", Mutates: true, Output: cmdmeta.OutputTable},
	{Path: "alethia project component remove", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	// Declarative: the document is the whole design, so applying it can remove a component the
	// document no longer lists, and applying it twice leaves what applying it once left.
	{Path: "alethia project design apply", Mutates: true, Destructive: true, Idempotent: true, DryRun: cmdmeta.DryRunServer, Output: cmdmeta.OutputTable},
}
