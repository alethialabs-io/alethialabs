// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifest

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"gopkg.in/yaml.v3"
)

// Add-ons in `alethia.yaml` (#5528).
//
//	environments:
//	  - name: staging
//	    stage: staging
//	    addons:
//	      - id: loki
//	      - id: external-dns
//	        version: 1.14.5          # a pin; "" or null removes it, omitted keeps the stored one
//	        settings:
//	          provider: cloudflare
//	          domainFilter: null     # resets this setting to the add-on's default
//	      - id: kube-prometheus-stack
//	        values_file: helm/kps-staging.yaml   # relative to alethia.yaml
//
// # The same rule as `alethia addon enable`
//
// An entry means exactly what the same flags would mean, because `apply` sends it through the same
// request: an omitted field keeps what is stored; `version: ""` (or null) removes the pin; each
// `settings` key is merged over the stored ones and `key: null` resets it; `values` / `values_file`
// replace the stored Advanced override whole and `values_file: ""` (or `values: null`) removes it.
// A file that names one setting therefore cannot reset the others, and a stored secret is never
// touched, because the file cannot carry one.
//
// # What the file never does
//
// It never disables an add-on. One that is enabled on the server and absent from the file is
// reported as unmanaged and left running — the same promise the file makes for environments and
// components, because a manifest that can uninstall by omission is one nobody dares edit.

// Addon is one catalog add-on an environment declares.
type Addon struct {
	// ID is the catalog id, e.g. `external-dns`.
	ID string `json:"id"`
	// Version is the chart-version pin: nil keeps the stored pin, "" removes it, anything else pins.
	Version *string `json:"version,omitempty"`
	// Mode is the delivery mode; empty keeps the stored one (managed on a first install).
	Mode string `json:"mode,omitempty"`
	// Settings are the add-on's own knobs, merged key by key over the stored ones. A nil value
	// resets that key to the add-on's default.
	Settings map[string]any `json:"settings,omitempty"`
	// Values is an inline Advanced Helm-values override, replacing the stored one whole.
	Values map[string]any `json:"values,omitempty"`
	// ValuesCleared records `values: null` — remove the stored override.
	ValuesCleared bool `json:"values_cleared,omitempty"`
	// ValuesFile is a Helm-values file relative to alethia.yaml: nil not given, "" remove the override.
	ValuesFile *string `json:"values_file,omitempty"`
	// ValuesFileContent is ValuesFile's content, read by LoadValuesFiles. Never written back.
	ValuesFileContent string `json:"-"`
}

// addonKeys are the keys an add-on entry takes, in the order Render writes them.
var addonKeys = []string{"id", "version", "mode", "settings", "values", "values_file"}

// UnmarshalYAML reads one add-on entry, refusing an unknown key and keeping the difference between
// an omitted field and a null one — the difference between "keep" and "clear".
func (a *Addon) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("an add-on must be a mapping with an `id` (line %d)", node.Line)
	}
	out := Addon{}
	seen := map[string]bool{}
	for i := 0; i+1 < len(node.Content); i += 2 {
		keyNode, val := node.Content[i], node.Content[i+1]
		key := keyNode.Value
		if seen[key] {
			return fmt.Errorf("add-on key %q is given twice (line %d)", key, keyNode.Line)
		}
		seen[key] = true
		isNull := val.Kind == yaml.ScalarNode && val.Tag == "!!null"
		switch key {
		case "id":
			if val.Kind != yaml.ScalarNode || isNull {
				return fmt.Errorf("add-on `id` must be a catalog id (line %d)", val.Line)
			}
			out.ID = strings.TrimSpace(val.Value)
		case "version":
			// The RAW scalar text, whatever YAML would type it as: `version: 1.15` is the version
			// 1.15, not the float 1.15 — and the version rule then refuses it by name.
			v, err := clearableScalar(key, val)
			if err != nil {
				return err
			}
			out.Version = v
		case "mode":
			if val.Kind != yaml.ScalarNode {
				return fmt.Errorf("add-on `mode` must be a delivery mode (line %d)", val.Line)
			}
			if !isNull {
				out.Mode = strings.TrimSpace(val.Value)
			}
		case "settings":
			if isNull {
				continue
			}
			m, err := decodeMapping(key, val)
			if err != nil {
				return err
			}
			out.Settings = m
		case "values":
			if isNull {
				out.ValuesCleared = true
				continue
			}
			m, err := decodeMapping(key, val)
			if err != nil {
				return err
			}
			out.Values = m
		case "values_file":
			v, err := clearableScalar(key, val)
			if err != nil {
				return err
			}
			out.ValuesFile = v
		default:
			return fmt.Errorf("add-on key %q is not one of %s (line %d)", key, strings.Join(addonKeys, ", "), keyNode.Line)
		}
	}
	*a = out
	return nil
}

// clearableScalar reads a scalar that may be null: nil is never returned for a present key, so a
// present `null` and a present `""` both become a pointer to "" — "clear it".
func clearableScalar(key string, val *yaml.Node) (*string, error) {
	if val.Kind != yaml.ScalarNode {
		return nil, fmt.Errorf("add-on `%s` must be a single value (line %d)", key, val.Line)
	}
	v := ""
	if val.Tag != "!!null" {
		v = strings.TrimSpace(val.Value)
	}
	return &v, nil
}

// decodeMapping decodes a mapping node, refusing any other shape.
func decodeMapping(key string, val *yaml.Node) (map[string]any, error) {
	if val.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("add-on `%s` must be a mapping of key: value (line %d)", key, val.Line)
	}
	out := map[string]any{}
	if err := val.Decode(&out); err != nil {
		return nil, fmt.Errorf("add-on `%s`: %w", key, err)
	}
	return out, nil
}

// MarshalYAML writes the entry in the order a person writes it, keeping "clear" visible: a removed
// pin is written as `version: ""` and a removed override as `values_file: ""` or `values: null`.
func (a Addon) MarshalYAML() (any, error) {
	node := &yaml.Node{Kind: yaml.MappingNode}
	add := func(key string, v any) error {
		var val yaml.Node
		if err := val.Encode(v); err != nil {
			return err
		}
		node.Content = append(node.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: key}, &val)
		return nil
	}
	if err := add("id", a.ID); err != nil {
		return nil, err
	}
	if a.Version != nil {
		if err := add("version", *a.Version); err != nil {
			return nil, err
		}
	}
	if a.Mode != "" {
		if err := add("mode", a.Mode); err != nil {
			return nil, err
		}
	}
	if a.Settings != nil {
		if err := add("settings", a.Settings); err != nil {
			return nil, err
		}
	}
	switch {
	case a.Values != nil:
		if err := add("values", a.Values); err != nil {
			return nil, err
		}
	case a.ValuesCleared:
		node.Content = append(node.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Value: "values"},
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"})
	}
	if a.ValuesFile != nil {
		if err := add("values_file", *a.ValuesFile); err != nil {
			return nil, err
		}
	}
	return node, nil
}

// DeclaresAddons reports whether any environment declares an add-on — whether the catalog is needed.
func (m *Manifest) DeclaresAddons() bool {
	for _, e := range m.Environments {
		if len(e.Addons) > 0 {
			return true
		}
	}
	return false
}

// valuesFileRule is the sentence a values_file is refused with when it is outside alethia.yaml's
// directory OR does not exist. The two are deliberately one sentence: a pull request that edits
// only alethia.yaml must not learn, from a public CI log, whether a path exists on the runner —
// including through a committed symlink, whose target cannot be checked without being followed.
const valuesFileRule = "a values_file must name an existing file inside the directory that holds alethia.yaml — " +
	"no absolute path, no `..` out of it, and no symlink that leads out of it"

// errValuesFileUnreadable is the refusal for a confined file that exists but cannot be read (a
// directory, no permission). The OS error is not carried: it names the runner's absolute path.
var errValuesFileUnreadable = errors.New("cannot be read as a file")

// LoadValuesFiles reads every add-on's `values_file`, relative to dir (alethia.yaml's directory).
//
// Read at plan time, not apply time, so the plan diffs the file that will be sent. A missing or
// unreadable file is an error naming the entry: silently sending no override would read as "keep",
// which is not what a person who named a file asked for.
//
// CONFINED TO dir, because alethia.yaml is reviewed as code and run by CI. A pull request that edits
// only this file could otherwise name `/home/runner/.aws/credentials`, or a symlink to it, and have
// `apply` send the runner's credentials to the server as a values override. So an absolute path is
// refused, and so is any path that resolves outside dir once `..` and symlinks are followed.
//
// The fence is the DIRECTORY, not the set of tracked files: a file a CI step writes into the
// workspace is inside it. Every error names the path only as alethia.yaml wrote it, never the
// runner's resolved absolute path.
func (m *Manifest) LoadValuesFiles(dir string) error {
	var p Problems
	for i := range m.Environments {
		e := &m.Environments[i]
		for j := range e.Addons {
			a := &e.Addons[j]
			if a.ValuesFile == nil || *a.ValuesFile == "" {
				continue
			}
			raw, err := readConfined(dir, *a.ValuesFile)
			if err != nil {
				p = append(p, fmt.Sprintf("environments[%s].addons[%s]: values_file %q: %v", e.Name, a.ID, *a.ValuesFile, err))
				continue
			}
			a.ValuesFileContent = string(raw)
		}
	}
	if len(p) == 0 {
		return nil
	}
	return p
}

// readConfined reads rel inside dir, or refuses it. No error it returns carries an OS error,
// because an OS error names the resolved absolute path.
func readConfined(dir, rel string) ([]byte, error) {
	path, err := confinedPath(dir, rel)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, errValuesFileUnreadable
	}
	return raw, nil
}

// confinedPath resolves rel inside dir, refusing anything that lands outside it: an absolute path,
// a `..` that climbs out, or a symlink (anywhere on the path) that leads out. The answer is the
// fully resolved path, so what is read is exactly what was checked.
//
// The LEXICAL check runs first and touches no filesystem: an absolute path or a `..` out of dir is
// refused before anything is stat'ed, so the refusal cannot depend on whether it exists. Only a path
// that is lexically inside is then resolved, and a failure to resolve it is refused with the same
// sentence as a path outside, because a committed symlink can point anywhere.
func confinedPath(dir, rel string) (string, error) {
	refuse := errors.New(valuesFileRule)
	if filepath.IsAbs(rel) || filepath.VolumeName(rel) != "" {
		return "", refuse
	}
	clean := filepath.Clean(rel)
	if escapes(clean) {
		return "", refuse
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", errors.New("the directory that holds alethia.yaml cannot be resolved")
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", errors.New("the directory that holds alethia.yaml cannot be resolved")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(root, clean))
	if err != nil {
		return "", refuse
	}
	inside, err := filepath.Rel(root, resolved)
	if err != nil || escapes(inside) {
		return "", refuse
	}
	return resolved, nil
}

// escapes reports whether a cleaned relative path leaves the directory it is relative to.
func escapes(clean string) bool {
	return clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || filepath.IsAbs(clean)
}

// validateAddons checks one environment's add-ons.
//
// The catalog is the server's, passed in. Nil skips every catalog check — "could not check" is not
// "refused" — but the shape rules (an id, no duplicate, one values form) need no catalog and always
// apply.
func validateAddons(at string, addons []Addon, catalog *api.AddonCatalogDocument, modes []string) Problems {
	var p Problems
	seen := map[string]int{}
	var versionRule *regexp.Regexp
	if catalog != nil && catalog.ChartVersion.Pattern != "" {
		// A pattern this build cannot compile is "could not check", for the same reason a missing
		// catalog is: the server still decides.
		versionRule, _ = regexp.Compile(catalog.ChartVersion.Pattern)
	}
	for i, a := range addons {
		where := fmt.Sprintf("%s.addons[%d]", at, i)
		if a.ID == "" {
			p = append(p, where+": `id` is required — the add-on's catalog id")
			continue
		}
		where = fmt.Sprintf("%s.addons[%s]", at, a.ID)
		if prev, dup := seen[a.ID]; dup {
			p = append(p, fmt.Sprintf("%s: %s is also addons[%d] — declare each add-on once per environment", where, a.ID, prev))
		}
		seen[a.ID] = i
		if (a.Values != nil || a.ValuesCleared) && a.ValuesFile != nil {
			p = append(p, where+": set `values` or `values_file`, not both — each replaces the whole Advanced override")
		}
		if a.Mode != "" && len(modes) > 0 && !oneOf(a.Mode, modes) {
			p = append(p, fmt.Sprintf("%s: mode %q is not one of %s", where, a.Mode, oneOfText(modes)))
		}
		if catalog == nil {
			continue
		}
		entry, ok := catalog.Addon(a.ID)
		if !ok {
			p = append(p, fmt.Sprintf("%s: %q is not a catalog add-on (have: %s)", where, a.ID, strings.Join(catalog.IDs(), ", ")))
			continue
		}
		if a.Version != nil && *a.Version != "" {
			v := *a.Version
			switch {
			case catalog.ChartVersion.MaxLength > 0 && len(v) > catalog.ChartVersion.MaxLength:
				p = append(p, fmt.Sprintf("%s: version %q — a chart version is at most %d characters", where, v, catalog.ChartVersion.MaxLength))
			case versionRule != nil && !versionRule.MatchString(v):
				p = append(p, fmt.Sprintf("%s: version %q — %s", where, v, catalog.ChartVersion.Refusal))
			}
		}
		if entry.Settings != nil {
			var unknown []string
			for k := range a.Settings {
				if !oneOf(k, entry.Settings) {
					unknown = append(unknown, k)
				}
			}
			if len(unknown) > 0 {
				sort.Strings(unknown)
				p = append(p, fmt.Sprintf("%s: %s does not take the setting %s (it takes: %s)",
					where, a.ID, strings.Join(unknown, ", "), strings.Join(entry.Settings, ", ")))
			}
		}
		if secret := SecretSettings(a.Settings, entry.SecretKeys); len(secret) > 0 {
			p = append(p, fmt.Sprintf(
				"%s: %s is a secret setting, and alethia.yaml is committed to git — set it with "+
					"`alethia addon enable %s --set %s=…` or in the console; apply keeps a stored secret as it is",
				where, strings.Join(secret, ", "), a.ID, secret[0]))
		}
	}
	return p
}

// SecretSettings returns the settings keys that are secret, sorted. Shared by Validate, which refuses
// them, and the plan, which must never print one.
func SecretSettings(settings map[string]any, secretKeys []string) []string {
	var out []string
	for k := range settings {
		if oneOf(k, secretKeys) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// ValidateAddons checks a list of add-ons on its own, by the rules Validate applies to an
// environment's — for a command that builds the list from flags (`alethia init --addon`) before
// there is a file to validate.
func ValidateAddons(at string, addons []Addon, catalog *api.AddonCatalogDocument, modes []string) error {
	if p := validateAddons(at, addons, catalog, modes); len(p) > 0 {
		return p
	}
	return nil
}
