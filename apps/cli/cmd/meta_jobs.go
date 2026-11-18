// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaJobs is the registry's entries for jobs, clusters and verification.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. Examples are added here, by the lane that owns the
// family's commands; TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no
// entry.
var metaJobs = []cmdmeta.Meta{
	{Path: "alethia jobs", Group: groupInspect},
	{Path: "alethia jobs list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia jobs get", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia jobs logs", Idempotent: true, Output: cmdmeta.OutputDocument},
	{Path: "alethia jobs cancel", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia cluster", Group: groupInspect},
	{Path: "alethia cluster list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia cluster get", Idempotent: true, Output: cmdmeta.OutputTable},
	// Mints a short-lived credential each time. Nothing is kept by the control plane, so repeating
	// it is safe.
	{Path: "alethia cluster kubeconfig", Idempotent: true, Output: cmdmeta.OutputSecret},
	{Path: "alethia cluster token", Idempotent: true, Output: cmdmeta.OutputSecret},
	{Path: "alethia verify", Group: groupInspect},
	{Path: "alethia verify receipt", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia verify show", Idempotent: true, Output: cmdmeta.OutputTable},
}
