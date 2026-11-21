// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package manifest is the CLI's name for `packages/core/designfile`, the one reader and writer of
// `alethia.yaml`.
//
// The implementation moved to `packages/core` so the CLI and the runner read the file through the
// same code. The types and the reading functions here are ALIASES, never copies: a
// `manifest.Manifest` IS a `designfile.Manifest`, so a value built by one package is accepted by
// the other and there is no second schema to drift. New code should import `designfile` directly;
// this package exists so the commands that already say `manifest.` keep compiling unchanged.
//
// Write is the one function that is the CLI's own: a file a command authors opens with the line
// that names its JSON Schema.
package manifest

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/packages/core/designfile"
)

// SchemaComment is the first line of a file the CLI writes: the comment that tells an editor's YAML
// language server which JSON Schema the file follows.
const SchemaComment = designfile.SchemaComment

// FileName is the manifest's name in a project's working directory.
const FileName = designfile.FileName

// The file's types, as designfile declares them.
type (
	// Manifest is one project as a person declares it.
	Manifest = designfile.Manifest
	// Cloud names the account and region a project provisions into.
	Cloud = designfile.Cloud
	// IaC carries the infrastructure-as-code settings.
	IaC = designfile.IaC
	// Environment is one deployment target and how it is placed onto a Fabric.
	Environment = designfile.Environment
	// Components are an environment's resources in file order, keyed by kind.
	Components = designfile.Components
	// KindEntries are every component of one kind in one environment.
	KindEntries = designfile.KindEntries
	// Component is one resource: its name and its settable fields.
	Component = designfile.Component
	// Addon is one catalog add-on an environment declares.
	Addon = designfile.Addon
	// Rules are the vocabularies Validate checks against.
	Rules = designfile.Rules
	// Problems is every reason a manifest cannot be applied, at once.
	Problems = designfile.Problems
)

// The file's functions, as designfile declares them. Variables rather than wrappers so that each
// is the same function value, not a second call path with its own behaviour to keep in step.
var (
	// Parse decodes a manifest, refusing unknown keys.
	Parse = designfile.Parse
	// Load reads and decodes the manifest at a path.
	Load = designfile.Load
	// Find reports the manifest in a directory, if there is one.
	Find = designfile.Find
	// Exists reports whether a path is a manifest file that is already there.
	Exists = designfile.Exists
	// Render writes the manifest as YAML.
	Render = designfile.Render
	// ScalarKeys is every dotted key Lookup answers, sorted.
	ScalarKeys = designfile.ScalarKeys
	// SecretSettings returns the settings keys that are secret, sorted.
	SecretSettings = designfile.SecretSettings
	// ValidateAddons checks a list of add-ons on its own.
	ValidateAddons = designfile.ValidateAddons
	// FromEnvironmentSpecs turns the wire shape of an environment matrix into the file's.
	FromEnvironmentSpecs = designfile.FromEnvironmentSpecs
)

// Write renders the manifest to path under SchemaComment, refusing to overwrite an existing file
// unless overwrite is set. It is what `alethia init` and `alethia up` author a file with, so a file
// the CLI wrote is checked and completed by an editor from its first line, as an exported one is.
//
// The comment is not part of the document: every reader of the file ignores it, and
// designfile.Render — the bytes a comparison or a pull request is made from — does not write it.
func Write(path string, m *Manifest, overwrite bool) error {
	if !overwrite {
		if _, err := os.Stat(path); err == nil {
			return fmt.Errorf("%s already exists — edit it, or pass --force to replace it", path)
		}
	}
	data, err := Render(m)
	if err != nil {
		return err
	}
	return os.WriteFile(path, append([]byte(SchemaComment+"\n"), data...), 0o644)
}
