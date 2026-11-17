// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"slices"
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// What this build of the CLI offers: which clouds, and which optional command groups.
//
// Both answers are asked in one place so that a help line, a picker, a refusal and the command
// registry cannot come to disagree about them. The clouds are the catalog's offered set
// (packages/core/catalog), which the console and the docs derive from too. The optional groups are
// switches on this machine.
//
// Neither is an authority. The control plane decides what it accepts; these decide only what the
// CLI lists and suggests.

// CapabilityOps is the capability the `ops` command group sits behind.
const CapabilityOps = "ops"

// OpsEnv turns the ops capability on when it is set to a true value: 1, true, yes or on.
const OpsEnv = "ALETHIA_OPS"

// capabilityEnv maps each capability to the environment variable that switches it on. It is the
// whole list of capabilities: a name that is not a key here is never enabled, and
// TestMeta_EveryCapabilityNamedIsKnown fails on a registry entry that names one.
var capabilityEnv = map[string]string{
	CapabilityOps: OpsEnv,
}

// Enabled reports whether a capability is switched on for this invocation. An unknown capability
// is off.
func Enabled(capability string) bool {
	name, known := capabilityEnv[capability]
	if !known {
		return false
	}
	raw, _ := lookupEnv(name)
	return switchOn(raw)
}

// switchOn reads one spelling of an on/off environment switch. Anything that is not a recognised
// "on" is off, the empty string included.
func switchOn(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "yes", "on":
		return true
	}
	on, err := strconv.ParseBool(strings.TrimSpace(raw))
	return err == nil && on
}

// EnabledCloudProviders returns the clouds this build offers, in the catalog's order: the offered
// set of the catalog, kept to the values the cloud_provider enum has. A cloud the catalog hides is
// absent unless the operator re-enabled it (catalog.HiddenCloudsEnv).
func EnabledCloudProviders() []types.CloudProvider {
	var out []types.CloudProvider
	for _, slug := range catalog.MustLoad().OfferedProviders() {
		provider := types.CloudProvider(slug)
		if slices.Contains(types.AllCloudProviders, provider) {
			out = append(out, provider)
		}
	}
	return out
}

// CloudEnabled reports whether one cloud is offered by this build, by slug.
func CloudEnabled(slug string) bool {
	return slices.Contains(EnabledCloudProviders(), types.CloudProvider(slug))
}

// enabledCloudNames returns the short display name of each offered cloud, in the catalog's order:
// AWS, GCP, Azure, Hetzner.
func enabledCloudNames() []string {
	connectable := catalog.MustLoad().Live.Providers
	var out []string
	for _, provider := range EnabledCloudProviders() {
		for _, c := range connectable {
			if c.Slug == string(provider) {
				out = append(out, c.ShortName)
			}
		}
	}
	return out
}

// enabledCloudList returns the offered clouds as one phrase for a sentence: "AWS, GCP, Azure and
// Hetzner". It is the wording the console and the docs use for the same list.
func enabledCloudList() string {
	return joinWithAnd(enabledCloudNames())
}

// joinWithAnd joins names with commas and a final "and", with no comma before it.
func joinWithAnd(names []string) string {
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}
