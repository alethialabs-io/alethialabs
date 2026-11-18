// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaRunners is the registry's entries for the runners family: runners and the managed fleet.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. Examples are added here, by the lane that owns the
// family's commands; TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no
// entry.
var metaRunners = []cmdmeta.Meta{
	{Path: "alethia runner", Group: groupDeploy},
	{Path: "alethia runner list", Idempotent: true, Output: cmdmeta.OutputTable},
	// The clouds are the ones a runner template exists for (packages/core/runners).
	{Path: "alethia runner deploy", Mutates: true, LongRunning: true, Clouds: []string{"aws"}, Output: cmdmeta.OutputTable},
	// Prints the new runner's registration token.
	{Path: "alethia runner register", Mutates: true, Output: cmdmeta.OutputSecret},
	{Path: "alethia runner destroy", Mutates: true, Destructive: true, LongRunning: true, Output: cmdmeta.OutputTable},
	{Path: "alethia runner remove", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia fleet", Group: groupDeploy},
	{Path: "alethia fleet list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia fleet set", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
}
