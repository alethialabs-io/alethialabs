// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package designfile

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"
	"unicode"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"golang.org/x/text/unicode/norm"
)

// The export (#5531): a project built on the console canvas, written as the `alethia.yaml` that a
// plan reads back as "nothing to change".
//
//	$ alethia export shop --env prod > alethia.yaml
//	$ alethia plan
//	  prod  dedicated  = environment  = cluster  = databases/orders
//	  0 projects to create · 0 environments · 0 components
//
// # The contract is the round trip
//
// The file is built from the same reads `plan` compares against — the project's settings, its
// environments, each environment's components and add-ons — and holds only what `plan` would find
// EQUAL on the server. That is the whole acceptance test (`TestExport_RoundTripPlansNoChanges`): a
// value written here that `plan` read differently would show as a standing change on the first plan
// a person ran, which is the moment they decide whether to trust the file.
//
// # What is written: an allow-list
//
// alethia.yaml is committed to git and read in CI logs, so the export writes a stored value only when
// something PUBLISHED says it is a plain, non-secret setting — never because nothing said it was a
// secret:
//
//   - a component field is written only if the published component schema declares it, the schema
//     does not mark it `writeOnly` (or `format: password`), its name carries no credential word, and
//     its value is a scalar, or a list or map of them. Server-managed columns (status, endpoints,
//     outputs) are not in the schema, so they never are; a component's own `cloud_identity_id` is a
//     credential reference and is never written (the project's account is, once, by its LABEL);
//   - a `provider_config` key is written only if it is a settable template knob for that kind on the
//     component's cloud — provider_config_keys.json, generated from the console's one definition
//     (`settableProviderConfigKnobs`: offerable, not a credential knob, not `alethia_*`);
//   - an add-on setting is written only if the catalog declares it and does not name it secret —
//     neither the catalog's `secret_keys` nor the row's, compared case-insensitively. An add-on's
//     Advanced values override is free-form Helm values and is never written: moving it to a values
//     file next to alethia.yaml would commit it just the same.
//
// On top of the allow-list the old heuristics still run, as defence in depth: a key NAMED like a
// credential (`IsCredentialKeyName`, the console's rule) and a value SHAPED like one
// (`HoldsCredential`: user-info in any URL of a list, a token in a query string, a bearer token, a
// DSN with a password) are left out even where the allow-list would admit them.
//
// Everything left out is safe to leave out because an OMITTED field means "keep what is stored" in
// every part of the manifest — `plan` compares only what the file declares, and provider_config and
// add-on settings merge key by key. So the file round-trips, and what it leaves out is named at its
// top rather than lost silently.

// SchemaURL is where the JSON Schema of `alethia.yaml` is published. The schema is generated from
// this package's types (apps/cli/tools/genschema) and served by the docs site.
const SchemaURL = "https://alethialabs.io/docs/schemas/alethia-yaml/v1.json"

// SchemaComment is the line that tells an editor's YAML language server which schema the file
// follows. A file that carries it as its first line is checked and completed as it is typed. It
// is a comment, so every reader of the file ignores it.
const SchemaComment = "# yaml-language-server: $schema=" + SchemaURL

// NotFoundError is a reference the export could not resolve: a project, or an environment of it.
// It is a type so a caller can tell "you named something that is not there" from a failed read.
type NotFoundError struct {
	// Message is the whole sentence, naming what was asked for and what exists.
	Message string
}

// Error returns the sentence.
func (e *NotFoundError) Error() string { return e.Message }

// notFoundf builds a NotFoundError from a format.
func notFoundf(format string, args ...any) error {
	return &NotFoundError{Message: fmt.Sprintf(format, args...)}
}

// ExportAllEnvironments is the picker's "every environment" answer. An environment name is a slug, so
// it can never be this.
const ExportAllEnvironments = "*"

// ExportOptions is one export: which project, and which of its environments.
type ExportOptions struct {
	// Project is the project's name or id.
	Project string
	// Env is the one environment to export, by name or id; empty with All false asks or refuses.
	Env string
	// All exports every environment.
	All bool
	// KnobAllowed reports whether `key` is a settable `provider_config` template knob of `kind` on
	// `cloud`. It is the caller's because the list is generated from the console's one definition
	// into the caller's tree. Nil allows nothing: every key is then left out, which apply keeps.
	KnobAllowed func(cloud, kind, key string) bool
}

// The reasons a value is left out, as the header says them. One note per component and reason, the
// fields listed, so a component with five left-out keys is one line, not five.
const (
	leftOutSecretField  = "the published component schema marks it secret"
	leftOutNotDeclared  = "the published component schema does not describe it"
	leftOutCredential   = "named like a credential"
	leftOutLooksSecret  = "the value looks like a credential (user-info in a URL, a token in a query string, a bearer token, a DSN with a password)"
	leftOutNotPlain     = "not a plain value (a scalar, or a list or map of them)"
	leftOutNoCloud      = "the component's cloud is not known, so no key can be checked against its template knobs"
	leftOutNotAKnobTmpl = "not a settable template knob of %s on %s"
)

// ExportReader is the slice of the API the export reads. Read routes only: an export never writes.
type ExportReader interface {
	GetConfigurations() ([]types.ConfigurationSummary, error)
	GetProjectSettings(project string) (*api.ProjectSettings, error)
	GetCloudIdentities() ([]api.CloudIdentity, error)
	GetComponentSchema() (*api.ComponentSchemaDocument, error)
	ListEnvironments(project string) ([]api.Environment, error)
	ListComponents(project, kind, env string) ([]api.Component, error)
	GetAddonCatalog() (*api.AddonCatalogDocument, error)
	GetProjectAddons(project, env string) (*api.ProjectAddons, error)
	GetProjectByoCharts(project, env string) (*api.ProjectByoCharts, error)
	GetProjectIacSource(project, env string) (*api.IacSource, error)
}

// EnvPicker asks which environment to export when the project has several and no flag said. It
// returns an environment name, or ExportAllEnvironments.
type EnvPicker func(project string, envNames []string) (string, error)

// Exported is a manifest and the notes saying what was left out of it.
type Exported struct {
	Manifest *Manifest
	// Notes are one line each, in a stable order: what the file does not carry and why.
	Notes []string
}

// Render writes the manifest under a header listing what was left out. The first line is
// SchemaComment. That the result reads back through `plan` is the round-trip test's to prove, not a
// check at run time.
func (ex *Exported) Render() ([]byte, error) {
	body, err := Render(ex.Manifest)
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	b.WriteString(SchemaComment + "\n")
	fmt.Fprintf(&b, "# %s for project %s, written by `alethia export`.\n", FileName, ex.Manifest.Project)
	b.WriteString("# `alethia plan` on this file shows nothing to change for the environments it lists.\n")
	b.WriteString("# No value Alethia stores as a secret is in it, but a credential typed into an ordinary setting\n")
	b.WriteString("# is written as typed: review this file before you commit it.\n")
	if ex.Manifest.IaC.Version != "" {
		// The CLI cannot tell the server's default from a version someone chose, so the stored one is
		// written — and said to be a pin, so nobody reads it as a choice they made.
		fmt.Fprintf(&b, "# iac.version pins the OpenTofu version the project uses now (%s); delete it to take the server's default.\n", ex.Manifest.IaC.Version)
	}
	if len(ex.Notes) > 0 {
		b.WriteString("#\n# Not in this file (omitted means apply keeps what is stored):\n")
		for _, n := range ex.Notes {
			fmt.Fprintf(&b, "#   - %s\n", n)
		}
	}
	b.WriteString("\n")
	b.Write(body)
	return b.Bytes(), nil
}

// BuildExport reads the project and assembles its
func BuildExport(c ExportReader, o ExportOptions, pick EnvPicker) (*Exported, error) {
	configs, err := c.GetConfigurations()
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	project, err := MatchExportProject(configs, o.Project)
	if err != nil {
		return nil, err
	}
	settings, err := c.GetProjectSettings(project.ProjectName)
	if err != nil {
		return nil, err
	}
	ex := &Exported{Manifest: &Manifest{
		Project: project.ProjectName,
		Cloud:   Cloud{Region: settings.Region},
		IaC:     IaC{Version: settings.IacVersion},
	}}
	r := &exporter{c: c, project: project.ID, knob: o.KnobAllowed}
	if settings.CloudProvider != nil {
		r.cloud = *settings.CloudProvider
	}
	if settings.CloudIdentityID != nil && *settings.CloudIdentityID != "" {
		identities, err := r.identities()
		if err != nil {
			return nil, err
		}
		account, note := ExportAccount(identities, *settings.CloudIdentityID)
		ex.Manifest.Cloud.Account = account
		ex.note(note)
		if r.cloud == "" {
			r.cloud = identityProvider(identities, *settings.CloudIdentityID)
		}
	}

	envs, err := c.ListEnvironments(project.ID)
	if err != nil {
		return nil, fmt.Errorf("list environments of %s: %w", project.ProjectName, err)
	}
	envs = OrderEnvironments(envs)
	chosen, err := ChooseEnvironments(project.ProjectName, envs, o, pick)
	if err != nil {
		return nil, err
	}
	if len(chosen) < len(envs) {
		var others []string
		for _, e := range envs {
			if !containsEnv(chosen, e.ID) {
				others = append(others, e.Name)
			}
		}
		ex.note(fmt.Sprintf("environments %s — not exported; plan lists them as unmanaged and leaves them alone", strings.Join(others, ", ")))
	}

	for _, e := range chosen {
		env, err := r.environment(e, ex)
		if err != nil {
			return nil, err
		}
		ex.Manifest.Environments = append(ex.Manifest.Environments, env)
	}
	return ex, nil
}

// note records one thing the file leaves out. Empty is nothing to say.
func (ex *Exported) note(n string) {
	if n != "" {
		ex.Notes = append(ex.Notes, oneLine(n))
	}
}

// oneLine replaces every control character and line or paragraph separator with a space. A note
// carries server-held text (a chart's ref, a path) and is written into a `#` comment and to a terminal:
// a `\r` or `\n` in it would end the comment and start a YAML line, and an escape would reach the
// terminal.
func oneLine(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.In(r, unicode.Zl, unicode.Zp) {
			return ' '
		}
		return r
	}, s)
}

// MatchExportProject finds the project by id, or by name case-insensitively — the server's uniqueness
// rule, so `Shop` and `shop` are one project here as there.
func MatchExportProject(configs []types.ConfigurationSummary, ref string) (types.ConfigurationSummary, error) {
	var matches []types.ConfigurationSummary
	for _, c := range configs {
		if c.ID == ref {
			return c, nil
		}
		if strings.EqualFold(c.ProjectName, ref) {
			matches = append(matches, c)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		have := make([]string, len(configs))
		for i, c := range configs {
			have[i] = c.ProjectName
		}
		sort.Strings(have)
		if len(have) == 0 {
			return types.ConfigurationSummary{}, notFoundf("project %q not found — this organization has no projects", ref)
		}
		return types.ConfigurationSummary{}, notFoundf("project %q not found (have: %s)", ref, strings.Join(have, ", "))
	}
	return types.ConfigurationSummary{}, fmt.Errorf("project name %q matches %d projects — pass the project's id", ref, len(matches))
}

// ExportAccount names the project's cloud account the way the file should: by its label, which `plan`
// resolves back to this id. A label another account shares would resolve to neither, so the id is
// written instead, with a note; an account this organization cannot list is left out, with a note.
func ExportAccount(identities []api.CloudIdentity, id string) (string, string) {
	var self *api.CloudIdentity
	sharing := 0
	for i := range identities {
		if identities[i].ID == id {
			self = &identities[i]
		}
	}
	if self == nil {
		return "", "cloud.account — the project's cloud account is not in this organization's account list, so none is written"
	}
	if self.Label == "" {
		return self.ID, ""
	}
	for _, other := range identities {
		if other.Label == self.Label {
			sharing++
		}
	}
	if sharing > 1 {
		return self.ID, fmt.Sprintf("cloud.account is written as an id — %d accounts share the label %q", sharing, self.Label)
	}
	return self.Label, ""
}

// OrderEnvironments puts the default environment first — the manifest's first environment is the
// one that owns the Fabric — and the rest by name, so a re-export is byte-identical whatever order the
// server listed them in.
func OrderEnvironments(envs []api.Environment) []api.Environment {
	out := append([]api.Environment(nil), envs...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IsDefault != out[j].IsDefault {
			return out[i].IsDefault
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// ChooseEnvironments is --env, --all, the only environment, or the picker — in that order. Without a
// terminal, a project with several environments and neither flag is refused naming them all, because
// exporting one of them silently is what `config export` did before --env existed.
func ChooseEnvironments(project string, envs []api.Environment, o ExportOptions, pick EnvPicker) ([]api.Environment, error) {
	if len(envs) == 0 {
		return nil, fmt.Errorf("project %s has no environments to export", project)
	}
	envNames := make([]string, len(envs))
	for i, e := range envs {
		envNames[i] = e.Name
	}
	want := o.Env
	switch {
	case o.All:
		return envs, nil
	case want != "":
	case len(envs) == 1:
		return envs, nil
	default:
		choice, err := pick(project, envNames)
		if err != nil {
			return nil, err
		}
		if choice == ExportAllEnvironments {
			return envs, nil
		}
		want = choice
	}
	key := names.NormalizeEnvironmentName(want)
	for _, e := range envs {
		if e.ID == want || names.NormalizeEnvironmentName(e.Name) == key {
			return []api.Environment{e}, nil
		}
	}
	return nil, notFoundf("environment %q not found in %s (have: %s)", want, project, strings.Join(envNames, ", "))
}

// containsEnv reports whether the list holds the environment with this id.
func containsEnv(envs []api.Environment, id string) bool {
	for _, e := range envs {
		if e.ID == id {
			return true
		}
	}
	return false
}

// exporter reads one project's environments into manifest form. The schema and the catalog are
// fetched once, and only when an environment has something that needs them.
type exporter struct {
	c       ExportReader
	project string
	// cloud is the project's cloud ("aws", "gcp", …), "" when no account is linked. A component with
	// its own account is checked against that account's cloud instead.
	cloud   string
	schema  *api.ComponentSchemaDocument
	catalog *api.AddonCatalogDocument
	// ids is the organization's cloud accounts, read once and only when something needs them.
	ids     []api.CloudIdentity
	idsRead bool
	// knob is ExportOptions.KnobAllowed; nil allows no provider_config key.
	knob func(cloud, kind, key string) bool
}

// identities reads the organization's cloud accounts, once.
func (r *exporter) identities() ([]api.CloudIdentity, error) {
	if !r.idsRead {
		ids, err := r.c.GetCloudIdentities()
		if err != nil {
			return nil, fmt.Errorf("list cloud accounts: %w", err)
		}
		r.ids, r.idsRead = ids, true
	}
	return r.ids, nil
}

// identityProvider is the cloud of the account with this id, or "" when the list does not hold it.
func identityProvider(ids []api.CloudIdentity, id string) string {
	for _, i := range ids {
		if i.ID == id {
			return i.Provider
		}
	}
	return ""
}

// componentCloud is the cloud a component's provider_config keys are checked against: its own
// account's when it has one, else the project's — the order the server's write path uses
// (`componentProvider`, apps/console/lib/cli/project-components.ts).
func (r *exporter) componentCloud(c api.Component) (string, error) {
	if c.CloudIdentityID == nil || *c.CloudIdentityID == "" {
		return r.cloud, nil
	}
	ids, err := r.identities()
	if err != nil {
		return "", err
	}
	return identityProvider(ids, *c.CloudIdentityID), nil
}

// environment reads one environment: its placement, components, add-ons, and a note for anything
// attached there that the manifest has no section for.
func (r *exporter) environment(e api.Environment, ex *Exported) (Environment, error) {
	env := Environment{Name: e.Name, Stage: e.Stage, Placement: e.PlacementMode}
	// Written only on a shared placement: Normalize drops a namespace from a dedicated environment,
	// so writing one there would be a line with no effect.
	if e.Namespace != nil && *e.Namespace != "" && e.PlacementMode != string(types.PlacementModeDedicated) {
		env.Namespace = *e.Namespace
	}
	// Written only when it is not the default, so an export of a persistent environment is the same
	// file it was before the read carried a lifecycle.
	if e.Lifecycle != "" && e.Lifecycle != DefaultLifecycle {
		env.Lifecycle = e.Lifecycle
	}
	// Every per-environment read names the environment by its ID. The server resolves a NAME as id,
	// name or stage. Since #5583 an exact name beats a stage there, but a server from before it ranked
	// the default environment first, so `staging` read the default's rows whenever that one's stage
	// was `staging`. A value that names no environment still resolves by stage. An id has one meaning
	// on every server.
	comps, err := r.c.ListComponents(r.project, "", e.ID)
	if err != nil {
		return env, fmt.Errorf("list components of %s: %w", e.Name, err)
	}
	if env.Components, err = r.components(e.Name, comps, ex); err != nil {
		return env, err
	}
	rows, err := r.c.GetProjectAddons(r.project, e.ID)
	if err != nil {
		return env, fmt.Errorf("list add-ons of %s: %w", e.Name, err)
	}
	if rows != nil {
		if env.Addons, err = r.addons(e.Name, rows.Addons, ex); err != nil {
			return env, err
		}
	}
	r.byo(e, ex)
	return env, nil
}

// componentGone are the statuses of a component that is being, or has been, torn down. Exporting one
// would declare it, and apply on a new environment would create it again.
var componentGone = map[string]bool{"DESTROYING": true, "DESTROYED": true}

// components turns an environment's components into the manifest's, in schema kind order with named
// entries sorted, keeping only what the published schema says a file may set.
func (r *exporter) components(env string, comps []api.Component, ex *Exported) (Components, error) {
	if len(comps) == 0 {
		return nil, nil
	}
	if r.schema == nil {
		schema, err := r.c.GetComponentSchema()
		if err != nil {
			return nil, err
		}
		r.schema = schema
	}
	byKind := map[string][]api.Component{}
	for _, c := range comps {
		if componentGone[c.Status] {
			ex.note(fmt.Sprintf("%s %s — %s on the server, so it is not declared", env, componentRef(c), strings.ToLower(c.Status)))
			continue
		}
		if _, ok := r.schema.Kind(c.Kind); !ok {
			ex.note(fmt.Sprintf("%s %s — the published component schema has no kind %q", env, componentRef(c), c.Kind))
			continue
		}
		byKind[c.Kind] = append(byKind[c.Kind], c)
	}
	var out Components
	for _, def := range r.schema.Kinds {
		rows := byKind[def.Kind]
		if len(rows) == 0 {
			continue
		}
		sort.SliceStable(rows, func(i, j int) bool { return rows[i].Name < rows[j].Name })
		if def.Singleton && len(rows) > 1 {
			// One per environment by the server's own rule; two rows is not something a file can say.
			ex.note(fmt.Sprintf("%s %s — the server holds %d of this one-per-environment kind; only the first is declared", env, def.Kind, len(rows)))
			rows = rows[:1]
		}
		kind := KindEntries{Kind: def.Kind, List: !def.Singleton}
		for _, c := range rows {
			fields, err := r.exportFields(env, def, c, ex)
			if err != nil {
				return nil, err
			}
			entry := Component{Fields: fields}
			if !def.Singleton {
				entry.Name = c.Name
			}
			kind.Entries = append(kind.Entries, entry)
		}
		out = append(out, kind)
	}
	return out, nil
}

// componentRef is `kind` or `kind/name`, for a note.
func componentRef(c api.Component) string {
	if c.Name == "" || c.Name == c.Kind {
		return c.Kind
	}
	return c.Kind + "/" + c.Name
}

// leftOut collects what one component leaves out, by reason, in the order first seen.
type leftOut struct {
	reasons []string
	fields  map[string][]string
}

// add records one left-out field under a reason.
func (l *leftOut) add(reason, field string) {
	if l.fields == nil {
		l.fields = map[string][]string{}
	}
	if _, ok := l.fields[reason]; !ok {
		l.reasons = append(l.reasons, reason)
	}
	l.fields[reason] = append(l.fields[reason], field)
}

// notes writes one note per reason: `prod databases/orders — left out provider_config.a, …: <reason>`.
func (l *leftOut) notes(ref string, ex *Exported) {
	reasons := append([]string(nil), l.reasons...)
	sort.Strings(reasons)
	for _, reason := range reasons {
		fields := append([]string(nil), l.fields[reason]...)
		sort.Strings(fields)
		ex.note(fmt.Sprintf("%s — left out %s: %s", ref, strings.Join(fields, ", "), reason))
	}
}

// exportFields is one component's values, through the allow-list: a field is written only when the
// published schema declares it as a non-secret property and its value is plain; provider_config is
// filtered key by key against the settable knobs of the component's cloud.
func (r *exporter) exportFields(env string, def api.ComponentSchemaKind, c api.Component, ex *Exported) (map[string]any, error) {
	out := map[string]any{}
	ref := env + " " + componentRef(c)
	var lo leftOut
	for _, f := range def.Fields {
		if f == "cloud_identity_id" {
			if c.CloudIdentityID != nil && *c.CloudIdentityID != "" {
				ex.note(ref + " — uses its own cloud account; cloud_identity_id is a credential reference and is not written")
			}
			continue
		}
		v, ok := c.Config[f]
		if !ok || v == nil {
			continue
		}
		prop, declared := SchemaProperty(def, f)
		switch {
		case !declared:
			lo.add(leftOutNotDeclared, f)
		case PropertyIsSecret(prop):
			lo.add(leftOutSecretField, f)
		case IsCredentialKeyName(f):
			lo.add(leftOutCredential, f)
		case f == "provider_config":
			cloud, err := r.componentCloud(c)
			if err != nil {
				return nil, err
			}
			if pc := exportProviderConfig(ref, cloud, def.Kind, v, r.knob, &lo, ex); len(pc) > 0 {
				out[f] = pc
			}
		case !IsPlain(v):
			lo.add(leftOutNotPlain, f)
		case HoldsCredential(v):
			lo.add(leftOutLooksSecret, f)
		default:
			out[f] = plainValue(v)
		}
	}
	lo.notes(ref, ex)
	return out, nil
}

// exportProviderConfig keeps the provider_config keys that are settable template knobs of this kind
// on this cloud (`allowed`, the caller's generated list) and hold a plain value with nothing credential-shaped in it.
// Every other non-null key is left out and recorded in lo.
func exportProviderConfig(ref, cloud, kind string, v any, allowed func(cloud, kind, key string) bool, lo *leftOut, ex *Exported) map[string]any {
	in, ok := StringKeyed(v)
	if !ok {
		ex.note(ref + " — provider_config is not a mapping on the server, so it is not written")
		return nil
	}
	out := map[string]any{}
	notAKnob := fmt.Sprintf(leftOutNotAKnobTmpl, kind, cloud)
	for k, val := range in {
		if val == nil {
			continue
		}
		field := "provider_config." + k
		switch {
		case cloud == "":
			lo.add(leftOutNoCloud, field)
		case allowed == nil || !allowed(cloud, kind, k):
			lo.add(notAKnob, field)
		case IsCredentialKeyName(k) || (kind == "secrets" && NormalizeKeyName(k) == "value"):
			lo.add(leftOutCredential, field)
		case !IsPlain(val):
			lo.add(leftOutNotPlain, field)
		case HoldsCredential(val):
			lo.add(leftOutLooksSecret, field)
		default:
			out[k] = plainValue(val)
		}
	}
	return out
}

// IsPlain reports whether a decoded value is plain data: a string, number or bool, or a list or
// mapping whose every element is plain (or null).
func IsPlain(v any) bool {
	switch t := v.(type) {
	case nil, string, bool, float64, int, int64, json.Number:
		return true
	case []any:
		for _, item := range t {
			if !IsPlain(item) {
				return false
			}
		}
		return true
	}
	m, ok := StringKeyed(v)
	if !ok {
		return false
	}
	for _, val := range m {
		if !IsPlain(val) {
			return false
		}
	}
	return true
}

// IsScalar reports whether a decoded value is a single string, number or boolean.
func IsScalar(v any) bool {
	switch v.(type) {
	case string, bool, float64, int, int64, json.Number:
		return true
	}
	return false
}

// HoldsCredential reports whether a value carries something that reads as a credential: a mapping key
// at any depth named like one (IsNestedCredentialName), a name/value pair whose NAME is one
// (`{name: master_password, value: …}`), or a string shaped like one (StringHoldsCredential). It
// over-matches on purpose: what it drops, apply keeps.
func HoldsCredential(v any) bool {
	switch t := v.(type) {
	case string:
		return StringHoldsCredential(t)
	case []any:
		for _, item := range t {
			if HoldsCredential(item) {
				return true
			}
		}
	default:
		if m, ok := StringKeyed(v); ok {
			for k, val := range m {
				if IsNestedCredentialName(k) || HoldsCredential(val) {
					return true
				}
				// A parameter list spells the credential as a VALUE: `{name: master_password, value: …}`.
				if name, ok := val.(string); ok && OneOfString(NormalizeKeyName(k), pairNameKeys) && IsNestedCredentialName(name) {
					return true
				}
			}
		}
	}
	return false
}

// pairNameKeys are the keys under which a name/value pair names its setting.
var pairNameKeys = []string{"name", "key", "parameter", "param", "parameter_name", "id"}

// nestedCredentialWords are the words a key INSIDE a value — a map under a knob or a setting — is
// checked for. Broader than credentialWords, which holds the console's rule for a top-level name: a
// nested key is free-form, so the words are matched ANYWHERE in the name once it is normalized and its
// separators removed. `password`, `passwd` and `passphrase` are all caught by `pass`; `api_key` and
// `private-key` read as `apikey` and `privatekey`.
var nestedCredentialWords = []string{"secret", "pass", "pwd", "auth", "apikey", "token", "credential", "privatekey", "accesskey"}

// IsNestedCredentialName reports whether a key inside a value is named like a credential: one of
// nestedCredentialWords appears in its normalized name (NormalizeKeyName: NFKC, Cyrillic and Greek
// look-alikes folded) with `_` removed. It over-matches on purpose — `bypass` and `author` match — for
// the reason every rule here does: what it drops, apply keeps.
func IsNestedCredentialName(name string) bool {
	joined := strings.ReplaceAll(NormalizeKeyName(name), "_", "")
	for _, w := range nestedCredentialWords {
		if strings.Contains(joined, w) {
			return true
		}
	}
	return false
}

// credentialQueryParams are query-string parameters that carry a credential (`?token=…`,
// `?access_token=…`, a pre-signed URL's signature), matched after NormalizeKeyName.
var credentialQueryParams = []string{"token", "access_token", "auth", "key", "apikey", "api_key", "password", "secret", "sig", "signature", "x_amz_signature", "x_amz_credential", "code"}

// StringHoldsCredential reads a string as one or more values split on commas, semicolons and
// whitespace, and reports whether any of them is shaped like a credential:
//
//   - `Bearer …` / `Basic …` — an Authorization header value;
//   - a URL with user-info (`https://x-access-token:ghp_…@github.com/…`), or with a credential in its
//     query string (`?token=…`), or one that does not parse — "cannot be shown clean";
//   - a DSN with a password and no scheme (`user:pw@tcp(db)/x`): a `:` before an `@`, with no `/`
//     before it.
//
// Every element is checked, so `https://ok,https://u:pw@evil` is caught by its second URL.
func StringHoldsCredential(s string) bool {
	lower := strings.ToLower(strings.TrimSpace(s))
	if strings.HasPrefix(lower, "bearer ") || strings.HasPrefix(lower, "basic ") {
		return true
	}
	parts := strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' || unicode.IsSpace(r) })
	for i, p := range parts {
		lp := strings.ToLower(p)
		if (lp == "bearer" || lp == "basic") && i+1 < len(parts) {
			return true
		}
		if strings.Contains(p, "://") {
			u, err := url.Parse(p)
			if err != nil || u.User != nil {
				return true
			}
			for k := range u.Query() {
				if OneOfString(NormalizeKeyName(k), credentialQueryParams) || IsCredentialKeyName(k) {
					return true
				}
			}
			continue
		}
		if at := strings.Index(p, "@"); at > 0 {
			before := p[:at]
			if strings.Contains(before, ":") && !strings.Contains(before, "/") {
				return true
			}
		}
	}
	return false
}

// SchemaProperty returns the published schema's property for a field, when it is described by a
// schema object — the allow-list's "the schema declares it".
func SchemaProperty(def api.ComponentSchemaKind, field string) (map[string]any, bool) {
	props, ok := StringKeyed(def.Schema["properties"])
	if !ok {
		return nil, false
	}
	return StringKeyed(props[field])
}

// PropertyIsSecret reports whether a schema property describes a secret: `writeOnly` — a value the
// server accepts and never hands back as itself — or `format: password`.
func PropertyIsSecret(prop map[string]any) bool {
	if wo, _ := prop["writeOnly"].(bool); wo {
		return true
	}
	format, _ := prop["format"].(string)
	return format == "password"
}

// plainValue rewrites a decoded JSON value for the file: a whole-number float64 becomes an int, so
// `node_min_size: 2` is written rather than `2.0` or `2e+00`. `plan` compares numbers by value, so the
// rewrite cannot make a change appear.
func plainValue(v any) any {
	switch t := v.(type) {
	case float64:
		if t == math.Trunc(t) && math.Abs(t) < 1<<53 {
			return int64(t)
		}
		return t
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = plainValue(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = plainValue(val)
		}
		return out
	}
	return v
}

// addons turns an environment's enabled add-ons into the manifest's, sorted by id, carrying the pin,
// the mode and the non-secret settings the catalog declares. The Advanced override is never written.
func (r *exporter) addons(env string, rows []api.Addon, ex *Exported) ([]Addon, error) {
	if len(rows) == 0 {
		return nil, nil
	}
	if r.catalog == nil {
		catalog, err := r.c.GetAddonCatalog()
		if err != nil {
			return nil, err
		}
		r.catalog = catalog
	}
	rows = append([]api.Addon(nil), rows...)
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].AddonID < rows[j].AddonID })
	modes := addonModes()
	var out []Addon
	for _, row := range rows {
		ref := env + " add-on " + row.AddonID
		if !row.Enabled {
			ex.note(ref + " — disabled on the server, so it is not declared")
			continue
		}
		entry, ok := r.catalog.Addon(row.AddonID)
		if !ok {
			ex.note(ref + " — not in the published add-on catalog, so it cannot be declared")
			continue
		}
		a := Addon{ID: row.AddonID}
		if row.VersionPinned && row.Version != nil && *row.Version != "" {
			v := *row.Version
			a.Version = &v
		}
		if OneOfString(row.Mode, modes) {
			a.Mode = row.Mode
		}
		secret := append(append([]string(nil), entry.SecretKeys...), row.SecretKeys...)
		settings := map[string]any{}
		var unknown, credentialLike, unchecked, notScalar []string
		for k, v := range row.Settings {
			switch {
			case v == nil, IsSecretSetting(k, secret):
				// A secret is never written. The server removes them from this read; this is the same
				// rule against both lists, case-insensitively, so a key only one of them names — in
				// any spelling — still cannot reach the file.
			case entry.Settings == nil:
				// The catalog could not list this add-on's settings, so none can be shown to be one it
				// declares — the allow-list admits nothing.
				unchecked = append(unchecked, k)
			case !OneOfString(k, entry.Settings):
				unknown = append(unknown, k)
			case !IsScalar(v):
				// A map or a list can carry anything, nested credential keys included; an add-on
				// setting the file writes is a single value.
				notScalar = append(notScalar, k)
			case IsCredentialKeyName(k) || HoldsCredential(v):
				credentialLike = append(credentialLike, k)
			default:
				settings[k] = plainValue(v)
			}
		}
		if len(settings) > 0 {
			a.Settings = settings
		}
		if len(secret) > 0 {
			ex.note(fmt.Sprintf("%s — secret settings (%s) are never written; apply keeps the stored values", ref, strings.Join(sortedUnique(secret), ", ")))
		}
		if len(credentialLike) > 0 {
			sort.Strings(credentialLike)
			ex.note(fmt.Sprintf("%s — settings %s look like credentials and are not written; apply keeps the stored values", ref, strings.Join(credentialLike, ", ")))
		}
		if len(unknown) > 0 {
			sort.Strings(unknown)
			ex.note(fmt.Sprintf("%s — stored settings %s are not ones the catalog declares, so they are not written", ref, strings.Join(unknown, ", ")))
		}
		if len(notScalar) > 0 {
			sort.Strings(notScalar)
			ex.note(fmt.Sprintf("%s — settings %s are not written: only single values (a string, number or boolean) are exported, and these hold a list or a map; apply keeps the stored values", ref, strings.Join(notScalar, ", ")))
		}
		if len(unchecked) > 0 {
			sort.Strings(unchecked)
			ex.note(fmt.Sprintf("%s — settings %s are not written: the catalog did not publish this add-on's settings, so none can be checked; apply keeps the stored values", ref, strings.Join(unchecked, ", ")))
		}
		if row.ValuesYAML != nil && strings.TrimSpace(*row.ValuesYAML) != "" {
			ex.note(fmt.Sprintf("%s — its Advanced values override is not written: it may hold secrets. "+
				"apply keeps it as stored; to manage it from git, put it in a file next to %s and name it with `values_file:`",
				ref, FileName))
		}
		out = append(out, a)
	}
	return out, nil
}

// byo notes the BYO charts and BYO IaC attached to an environment — the manifest has no section for
// either yet. A read that fails is said as such: "could not check" must not read as "none".
func (r *exporter) byo(e api.Environment, ex *Exported) {
	env := e.Name
	charts, err := r.c.GetProjectByoCharts(r.project, e.ID)
	switch {
	case err != nil:
		ex.note(fmt.Sprintf("%s BYO charts — could not be read (%v); anything attached there is not in this file", env, err))
	case charts != nil:
		for _, ch := range charts.Charts {
			// The chart's path and ref, never its repository URL: a URL can carry credentials in its
			// user-info, and this line is written into a file people commit.
			ex.note(fmt.Sprintf("%s BYO chart %s@%s — BYO charts are not exported yet", env, ch.ChartPath, ch.Ref))
		}
	}
	src, err := r.c.GetProjectIacSource(r.project, e.ID)
	switch {
	case err != nil:
		ex.note(fmt.Sprintf("%s BYO IaC — could not be read (%v); a source attached there is not in this file", env, err))
	case src != nil:
		ex.note(fmt.Sprintf("%s BYO IaC %s (%s) — BYO IaC is not exported yet", env, src.Name, src.Path))
	}
}

// OneOfString reports whether v is in the list.
func OneOfString(v string, list []string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// IsSecretSetting reports whether an add-on setting is named secret by the catalog or the row,
// compared case-insensitively: `APITOKEN` stored against `secret_keys: [apiToken]` is the same
// secret in a different spelling, and the allow-list must not read it as a different setting.
func IsSecretSetting(key string, secret []string) bool {
	for _, s := range secret {
		if strings.EqualFold(s, key) {
			return true
		}
	}
	return false
}

// sortedUnique returns the distinct values, sorted.
func sortedUnique(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// credentialWords are the credential words a key NAME is checked for, as whole `_`-separated segments
// — the CREDENTIAL_NAME rule in apps/console/lib/cloud-providers/template-knobs.ts. Two-segment
// words are matched as adjacent segments.
var credentialWords = []string{
	"password", "passwd", "passphrase", "credential", "credentials", "token",
	"secret_key", "access_key", "private_key", "api_key", "client_secret",
}

// IsCredentialKeyName reports whether a key's NAME carries a credential word (`hcloud_token`,
// `dbPassword`, `APIKey`). It over-matches on purpose, as the console's rule does: a false positive
// leaves a value out of the file, which apply then keeps; a false negative commits a secret.
func IsCredentialKeyName(name string) bool {
	segments := strings.Split(NormalizeKeyName(name), "_")
	for i, s := range segments {
		if OneOfString(s, credentialWords) {
			return true
		}
		if i+1 < len(segments) && OneOfString(s+"_"+segments[i+1], credentialWords) {
			return true
		}
	}
	return false
}

// confusables folds the Cyrillic and Greek letters that look like Latin ones onto those Latin letters,
// so `раssword` (Cyrillic `р`, `а`) reads as `password`. NFKC (applied first) already folds
// full-width and compatibility forms; it leaves these alone because they are different letters.
var confusables = strings.NewReplacer(
	// Cyrillic, lower then upper.
	"а", "a", "в", "b", "е", "e", "ё", "e", "з", "3", "і", "i", "ї", "i", "ј", "j", "к", "k", "м", "m",
	"н", "h", "о", "o", "р", "p", "с", "c", "т", "t", "у", "y", "х", "x", "ѕ", "s", "ԁ", "d", "ӏ", "l",
	"А", "A", "В", "B", "Е", "E", "З", "3", "І", "I", "Ј", "J", "К", "K", "М", "M", "Н", "H", "О", "O",
	"Р", "P", "С", "C", "Т", "T", "У", "Y", "Х", "X", "Ѕ", "S",
	// Greek, lower then upper.
	"α", "a", "β", "b", "ε", "e", "ι", "i", "κ", "k", "ν", "v", "ο", "o", "ρ", "p", "τ", "t", "υ", "u",
	"χ", "x", "ω", "w", "Α", "A", "Β", "B", "Ε", "E", "Ζ", "Z", "Η", "H", "Ι", "I", "Κ", "K", "Μ", "M",
	"Ν", "N", "Ο", "O", "Ρ", "P", "Τ", "T", "Υ", "Y", "Χ", "X",
)

// NormalizeKeyName spells a name the one way the credential rules read it: NFKC-normalized, Cyrillic
// and Greek look-alikes folded onto Latin letters (confusables), camelCase split into snake_case
// (acronyms too — `DBPassword` → `db_password`, `APIKey` → `api_key`), dots, dashes and spaces as `_`,
// lower-cased. The console's NormalizeKeyName, without a regular expression, plus the folding.
func NormalizeKeyName(name string) string {
	rs := []rune(confusables.Replace(norm.NFKC.String(strings.TrimSpace(name))))
	var b strings.Builder
	for i, r := range rs {
		switch {
		case r == '.' || r == '-' || unicode.IsSpace(r):
			if b.Len() > 0 && !strings.HasSuffix(b.String(), "_") {
				b.WriteRune('_')
			}
			continue
		case unicode.IsUpper(r) && i > 0:
			prev := rs[i-1]
			nextLower := i+1 < len(rs) && unicode.IsLower(rs[i+1])
			// `dbPassword` (lower or digit → upper) and `APIKey` (the last upper of a run, before a lower).
			if unicode.IsLower(prev) || unicode.IsDigit(prev) || (unicode.IsUpper(prev) && nextLower) {
				if !strings.HasSuffix(b.String(), "_") {
					b.WriteRune('_')
				}
			}
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

// addonModes is the generated `addon_mode` enum as plain strings.
func addonModes() []string {
	out := make([]string, len(types.AllAddonModes))
	for i, m := range types.AllAddonModes {
		out[i] = string(m)
	}
	return out
}
