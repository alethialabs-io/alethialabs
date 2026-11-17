// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaOps is the registry's entries for the ops family: privileged incident recovery.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. Examples are added here, by the lane that owns the
// family's commands; TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no
// entry.
var metaOps = []cmdmeta.Meta{
	// The whole group sits behind one capability, named on its parent: everything below a
	// command that is not listed is not listed either.
	{Path: "alethia ops", Group: groupOrganization, Idempotent: true, Capability: CapabilityOps, Output: cmdmeta.OutputNone},
	{Path: "alethia ops session", Mutates: true, Output: cmdmeta.OutputTable},
	{Path: "alethia ops approve", Mutates: true, Output: cmdmeta.OutputTable},
	{Path: "alethia ops inspect-job", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia ops retry-job", Mutates: true, LongRunning: true, Output: cmdmeta.OutputTable},
	{Path: "alethia ops cancel-job", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia ops drain-runner", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia ops restart-runner", Mutates: true, Output: cmdmeta.OutputTable},
	{Path: "alethia ops unstick-env", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia ops replay-webhook", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia ops force-release-lock", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia ops orphan-detect", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia ops orphan-clean", Mutates: true, Destructive: true, Output: cmdmeta.OutputTable},
	{Path: "alethia ops state-surgery", Mutates: true, Destructive: true, LongRunning: true, Output: cmdmeta.OutputTable},
}
