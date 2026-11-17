// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package designfile

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"gopkg.in/yaml.v3"
)

// The add-ons half of the plan (#5528).
//
// An add-on in alethia.yaml is reconciled through the SAME request `alethia addon enable` sends, so
// it carries the same keep/clear rule: an omitted field keeps what is stored, `version: ""` removes
// the pin, each `settings` key merges over the stored ones (`key: null` resets it), and
// `values` / `values_file` replace the Advanced override whole (`values_file: ""` removes it).
//
// The plan compares only what the file declares. A setting is compared key by key against the
// stored settings the server returns with secrets removed; a reset (`key: null`) is compared against
// the catalog's default for that key, because that is what the server stores after a reset — so a
// reset settles after one apply instead of showing as a change forever.
//
// An add-on on the server that the file does not mention is UNMANAGED: listed, never disabled.

// AddonPlan is one add-on's difference in one environment.
type AddonPlan struct {
	ID     string `json:"id"`
	Action Action `json:"action"`
	// Changes are the declared fields that differ from the server's, for an `update`. A change to
	// one setting carries the setting's name in Key.
	Changes []FieldChange `json:"changes,omitempty"`

	// Request is what apply sends for a `create` or an `update`. Never serialized.
	Request api.EnableAddonParams `json:"-"`
	// SecretKeys are the add-on's secret settings, from the catalog AND the stored row, so a plan
	// can redact one even when only one of the two could name it.
	SecretKeys []string `json:"-"`
}

// AddonDefaultLabel is what a version change shows for "no pin": the catalog's default applies.
const AddonDefaultLabel = "(catalog default)"

// PlanAddons compares one environment's declared add-ons with the ones the server holds there.
//
// `existing` is nil for an environment that does not exist yet, which makes every declared add-on a
// `create`. It returns the per-add-on plans, the ids enabled on the server that the file does not
// mention (sorted), and any reason the environment's add-ons cannot be applied as written.
func PlanAddons(env Environment, existing []api.Addon, catalog *api.AddonCatalogDocument) ([]AddonPlan, []string, []string) {
	byID := map[string]api.Addon{}
	for _, row := range existing {
		byID[row.AddonID] = row
	}
	var plans []AddonPlan
	var problems []string
	declared := map[string]bool{}
	for _, a := range env.Addons {
		declared[a.ID] = true
		entry, _ := catalog.Addon(a.ID)
		row, enabled := byID[a.ID]
		secretKeys := append(append([]string(nil), entry.SecretKeys...), row.SecretKeys...)
		// Validate refuses a secret setting against the catalog; this is the same refusal against the
		// row's own list, so a catalog that could not name it still cannot let one through.
		if secret := SecretSettings(a.Settings, secretKeys); len(secret) > 0 {
			problems = append(problems, fmt.Sprintf(
				"add-on %s: %s is a secret setting — set it with `alethia addon enable %s --set %s=…` or in the console, never in alethia.yaml",
				a.ID, strings.Join(secret, ", "), a.ID, secret[0]))
			continue
		}
		override, clearOverride, declaresOverride, err := declaredOverride(a)
		if err != nil {
			problems = append(problems, fmt.Sprintf("add-on %s: %v", a.ID, err))
			continue
		}
		if !enabled {
			plans = append(plans, AddonPlan{ID: a.ID, Action: ActionCreate, Request: addonRequest(env.Name, a, nil), SecretKeys: secretKeys})
			continue
		}
		var changes []FieldChange
		if a.Version != nil {
			if c, ok := versionChange(*a.Version, row); ok {
				changes = append(changes, c)
			}
		}
		if a.Mode != "" && a.Mode != row.Mode {
			changes = append(changes, FieldChange{Field: "mode", From: row.Mode, To: a.Mode})
		}
		changes = append(changes, settingsChanges(a.Settings, row.Settings, entry.Defaults)...)
		if declaresOverride {
			current, _ := ParseOverride(derefString(row.ValuesYAML))
			want := override
			if clearOverride {
				want = nil
			}
			if !ValuesEqual(mapOrNil(want), mapOrNil(current)) {
				// THAT it changed, never what it says — not even a digest: a plan is printed into CI
				// logs, and a short hash of a low-entropy override (`password: hunter2`) falls to a
				// dictionary attack offline. So neither side is named; `from` is always null.
				changes = append(changes, FieldChange{Field: "values",
					To: overrideSummary(want, derefString(OverrideText(a)))})
			}
		}
		SortChanges(changes)
		p := AddonPlan{ID: a.ID, Action: ActionUnchanged, SecretKeys: secretKeys}
		if len(changes) > 0 {
			p.Action, p.Changes = ActionUpdate, changes
			p.Request = addonRequest(env.Name, a, changes)
		}
		plans = append(plans, p)
	}
	var unmanaged []string
	for _, row := range existing {
		if !declared[row.AddonID] {
			unmanaged = append(unmanaged, row.AddonID)
		}
	}
	sort.Strings(unmanaged)
	return plans, unmanaged, problems
}

// versionChange compares a declared pin with the row's: "" asks for no pin, anything else for that
// pin. Pinning the version the catalog already defaults to is still a change — the pin is what stops
// the version moving when the catalog's default does.
func versionChange(want string, row api.Addon) (FieldChange, bool) {
	have := derefString(row.Version)
	var from any = AddonDefaultLabel
	if row.VersionPinned {
		from = have
	}
	if want == "" {
		if !row.VersionPinned {
			return FieldChange{}, false
		}
		return FieldChange{Field: "version", From: from, To: AddonDefaultLabel}, true
	}
	if row.VersionPinned && have == want {
		return FieldChange{}, false
	}
	return FieldChange{Field: "version", From: from, To: want}, true
}

// settingsChanges compares each declared setting with the stored one. A declared null is a reset,
// compared against the catalog default the server will store; with no known default it equals an
// absent key, which is the rule DiffFields uses everywhere else.
func settingsChanges(declared, stored, defaults map[string]any) []FieldChange {
	var out []FieldChange
	for key, want := range declared {
		have := stored[key]
		target := want
		if want == nil {
			target = defaults[key]
		}
		if ValuesEqual(target, have) {
			continue
		}
		out = append(out, FieldChange{Field: "settings", Key: key, From: have, To: want})
	}
	return out
}

// declaredOverride reads what the file says about the Advanced values override: the mapping it
// declares, whether it asks for the override to be removed, and whether it says anything at all.
//
// An empty mapping, an empty file and `values_file: ""` all mean "no override", which is what the
// server stores for each of them.
func declaredOverride(a Addon) (map[string]any, bool, bool, error) {
	switch {
	case a.ValuesFile != nil:
		if *a.ValuesFile == "" {
			return nil, true, true, nil
		}
		m, err := ParseOverride(a.ValuesFileContent)
		if err != nil {
			return nil, false, true, fmt.Errorf("values_file %s: %w", *a.ValuesFile, err)
		}
		return m, len(m) == 0, true, nil
	case a.ValuesCleared:
		return nil, true, true, nil
	case a.Values != nil:
		return a.Values, len(a.Values) == 0, true, nil
	}
	return nil, false, false, nil
}

// ParseOverride reads an Advanced override as a mapping. Empty or whitespace is no override. Any
// other non-mapping is refused here because the server refuses it ("Advanced values must be valid
// YAML describing a mapping"), and a plan that says otherwise would promise an apply that fails.
func ParseOverride(text string) (map[string]any, error) {
	if strings.TrimSpace(text) == "" {
		return nil, nil
	}
	// The parser's own message is NOT carried: it quotes the offending text, and this text may be
	// any file in the repository.
	var node yaml.Node
	if err := yaml.Unmarshal([]byte(text), &node); err != nil {
		return nil, errors.New("is not valid YAML")
	}
	if len(node.Content) == 0 {
		return nil, nil
	}
	if node.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("must be a YAML mapping (key: value)")
	}
	out := map[string]any{}
	if err := node.Content[0].Decode(&out); err != nil {
		return nil, errors.New("is not valid YAML")
	}
	return out, nil
}

// overrideSummary says what a changed override becomes without naming its content in any form:
// `removed`, or `changed (N lines)` counting the lines of the text that will be sent. No hash —
// a digest of a low-entropy value can be brute-forced from a public CI log.
func overrideSummary(m map[string]any, text string) string {
	if len(m) == 0 {
		return OverrideRemoved
	}
	lines := strings.Count(strings.TrimRight(text, "\n"), "\n") + 1
	return fmt.Sprintf("changed (%s)", plural(lines, "line"))
}

// OverrideRemoved is how a plan names an override the file removes.
const OverrideRemoved = "removed"

// mapOrNil turns an empty mapping into nil, so "no override" compares and prints one way.
func mapOrNil(m map[string]any) any {
	if len(m) == 0 {
		return nil
	}
	return m
}

// addonRequest builds the `addon enable` request for a declared add-on.
//
// With no changes (a `create`) everything the file declares is sent. For an `update` only the
// fields that changed are sent — the rule #5526 set for components — and every field left out is
// kept by the server, exactly as an omitted flag is.
func addonRequest(env string, a Addon, changes []FieldChange) api.EnableAddonParams {
	p := api.EnableAddonParams{Env: env, AddonID: a.ID}
	all := changes == nil
	changed := map[string]bool{}
	settings := map[string]any{}
	for _, c := range changes {
		changed[c.Field] = true
		if c.Field == "settings" {
			settings[c.Key] = c.To
		}
	}
	if all || changed["version"] {
		p.Version = a.Version
	}
	if all || changed["mode"] {
		p.Mode = a.Mode
	}
	if all {
		settings = a.Settings
	}
	if len(settings) > 0 {
		p.Values = settings
	}
	if all || changed["values"] {
		p.ValuesYAML = OverrideText(a)
	}
	return p
}

// OverrideText is the override as `addon enable --values-file` sends it: nil to keep, "" to remove,
// and otherwise the file's own text — or the inline mapping rendered as YAML.
func OverrideText(a Addon) *string {
	cleared := ""
	switch {
	case a.ValuesFile != nil:
		if *a.ValuesFile == "" || strings.TrimSpace(a.ValuesFileContent) == "" {
			return &cleared
		}
		text := a.ValuesFileContent
		return &text
	case a.ValuesCleared:
		return &cleared
	case a.Values != nil:
		if len(a.Values) == 0 {
			return &cleared
		}
		// A mapping yaml.v3 just decoded always encodes, so the error has nothing to report.
		raw, _ := yaml.Marshal(a.Values)
		text := string(raw)
		return &text
	}
	return nil
}

// derefString reads an optional string, "" for none.
func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// plural renders a count with its noun — "1 line", "2 lines".
func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}
