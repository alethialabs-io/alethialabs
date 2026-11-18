// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaClouds is the registry's entries for the clouds family: connecting cloud accounts and inspecting what they hold.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. Examples are added here, by the lane that owns the
// family's commands; TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no
// entry.
var metaClouds = []cmdmeta.Meta{
	{Path: "alethia connector", Group: groupDeploy},
	{Path: "alethia connector list", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia connector aws", Mutates: true, Clouds: []string{"aws"}, Output: cmdmeta.OutputTable},
	{Path: "alethia connector gcp", Mutates: true, Clouds: []string{"gcp"}, Output: cmdmeta.OutputTable},
	{Path: "alethia connector azure", Mutates: true, Clouds: []string{"azure"}, Output: cmdmeta.OutputTable},
	{Path: "alethia connector hetzner", Mutates: true, Clouds: []string{"hetzner"}, Output: cmdmeta.OutputTable},
	{Path: "alethia connector alibaba", Mutates: true, Clouds: []string{"alibaba"}, Output: cmdmeta.OutputTable},
	{Path: "alethia connector remove", Mutates: true, Destructive: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia provider", Group: groupInspect},
	{Path: "alethia provider status", Idempotent: true, Output: cmdmeta.OutputTable},
	// Re-runs the health probe and records its result on the identity.
	{Path: "alethia provider verify", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia cloud", Group: groupInspect},
	{Path: "alethia cloud inventory", Idempotent: true, Output: cmdmeta.OutputTable},
}
