// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/designfile"
)

// The plan is computed by `packages/core/designfile` (plan.go, plan_addons.go), so `alethia plan`,
// `alethia apply` and the runner's design-file job read a file against the server by one rule.
// What stays in this package is what only a command does: fetching the schema and the catalog,
// printing the plan, and carrying it out. These are the names the commands use for the shared
// types — aliases, never copies.

// Action is what apply will do with one thing the file declares.
type Action = designfile.Action

const (
	// ActionCreate — it does not exist and will be created.
	ActionCreate = designfile.ActionCreate
	// ActionUpdate — it exists and at least one field the file declares differs from the
	// server's value. ComponentPlan.Changes lists them.
	ActionUpdate = designfile.ActionUpdate
	// ActionUnchanged — it exists, every field the file declares already matches, and it is left
	// as it is.
	ActionUnchanged = designfile.ActionUnchanged
)

const (
	// addonDefaultLabel is what a version change shows for "no pin": the catalog's default applies.
	addonDefaultLabel = designfile.AddonDefaultLabel
	// overrideRemoved is how a plan names an override the file removes.
	overrideRemoved = designfile.OverrideRemoved
)

type (
	// ApplyPlan is the difference between the file and the organization.
	ApplyPlan = designfile.Plan
	// EnvPlan is one environment's difference.
	EnvPlan = designfile.EnvPlan
	// ComponentPlan is one component's difference.
	ComponentPlan = designfile.ComponentPlan
	// AddonPlan is one add-on's difference in one environment.
	AddonPlan = designfile.AddonPlan
)

var (
	// componentValues is the server's current value of every settable field of a component.
	componentValues = designfile.ComponentValues
	// parseOverride reads an Advanced override as a mapping.
	parseOverride = designfile.ParseOverride
	// overrideText is the override as `addon enable --values-file` sends it.
	overrideText = designfile.OverrideText
)

// planReader is an applyClient as the plan reads it: the client's own reads, plus the CLI's rule
// for which cloud account a label names.
type planReader struct {
	applyClient
}

// ResolveCloudAccount finds the cloud account `cloud.account` names, by label or id, and refuses an
// ambiguous label.
func (r planReader) ResolveCloudAccount(ref string) (api.CloudIdentity, error) {
	identities, err := r.GetCloudIdentities()
	if err != nil {
		return api.CloudIdentity{}, fmt.Errorf("resolve cloud.account %q: %w", ref, err)
	}
	return matchCloudIdentity(identities, ref)
}

// computePlan compares the manifest with the organization. It reads and never writes. catalog is the
// add-on catalog when the file declares add-ons, and nil otherwise.
func computePlan(c applyClient, m *manifest.Manifest, catalog *api.AddonCatalogDocument) (*ApplyPlan, error) {
	return designfile.ComputePlan(planReader{c}, m, catalog)
}
