// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package manifest is the CLI's name for `packages/core/designfile`, the one reader and writer of
// `alethia.yaml`.
//
// The implementation moved to `packages/core` so the CLI and the runner read the file through the
// same code. Everything here is an ALIAS, never a copy: a `manifest.Manifest` IS a
// `designfile.Manifest`, so a value built by one package is accepted by the other and there is no
// second schema to drift. New code should import `designfile` directly; this package exists so the
// commands that already say `manifest.` keep compiling unchanged.
package manifest

import "github.com/alethialabs-io/alethialabs/packages/core/designfile"

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
	// Write renders the manifest to a path, refusing to overwrite unless asked.
	Write = designfile.Write
	// ScalarKeys is every dotted key Lookup answers, sorted.
	ScalarKeys = designfile.ScalarKeys
	// SecretSettings returns the settings keys that are secret, sorted.
	SecretSettings = designfile.SecretSettings
	// ValidateAddons checks a list of add-ons on its own.
	ValidateAddons = designfile.ValidateAddons
	// FromEnvironmentSpecs turns the wire shape of an environment matrix into the file's.
	FromEnvironmentSpecs = designfile.FromEnvironmentSpecs
)
