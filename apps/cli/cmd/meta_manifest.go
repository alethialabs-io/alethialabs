// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"

// metaManifest is the registry's entries for the manifest verbs: alethia.yaml in, alethia.yaml out, and the CLI's own configuration.
//
// Every runnable command of the family is listed with its facts filled in. What each field means
// is documented once, on cmdmeta.Meta. Examples are added here, by the lane that owns the
// family's commands; TestMeta_TheRegistryAndTheTreeAgree fails on a runnable command with no
// entry.
var metaManifest = []cmdmeta.Meta{
	// The dry run of `apply`: it reads and compares, and its exit code says what it found.
	{Path: "alethia plan", Group: groupDeploy, Idempotent: true, Output: cmdmeta.OutputTable},
	// Every run queues a deploy, so a second run is a second deploy.
	{Path: "alethia apply", Group: groupDeploy, Mutates: true, LongRunning: true, Output: cmdmeta.OutputTable},
	{Path: "alethia export", Group: groupDeploy, Idempotent: true, Output: cmdmeta.OutputDocument},
	{Path: "alethia config", Group: groupSettings, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia config get", Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia config set", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia config clear-context", Mutates: true, Idempotent: true, Output: cmdmeta.OutputTable},
	{Path: "alethia config export", Idempotent: true, Output: cmdmeta.OutputDocument},
}
