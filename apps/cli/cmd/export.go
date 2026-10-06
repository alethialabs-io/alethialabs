// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strings"
	"unicode"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// `alethia export` (#5531): a project built on the console canvas, written as the `alethia.yaml` that
// `alethia plan` reads back as "nothing to change".
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
// # What is never written, and why each is safe to leave out
//
// alethia.yaml is committed to git and read in CI logs, so the export never writes:
//
//   - a secret add-on setting (the server already removes them from the read; the catalog and the row
//     name them, and both lists are applied again here),
//   - an add-on's Advanced values override — it is free-form Helm values and may hold a password
//     the catalog cannot name. It is OMITTED with a comment rather than written to a values file: a
//     separate file next to alethia.yaml is committed just the same, so moving it there would move the
//     leak rather than prevent it,
//   - a component field the published schema marks `writeOnly`, or whose NAME carries a credential
//     word — the rule `isCredentialKeyName` holds in apps/console/lib/cloud-providers/template-knobs.ts,
//     applied to provider_config keys too, so a credential stored before #5571 refused them stays out,
//   - a component's own `cloud_identity_id` (a credential reference; the project's account is written
//     once, by its LABEL, as `cloud.account`).
//
// Each of those is safe to omit because an OMITTED field means "keep what is stored" in every part of
// the manifest — `plan` compares only what the file declares. So the file round-trips, and what it
// leaves out is listed at its top rather than lost silently.

// exportAllEnvironments is the picker's "every environment" answer. An environment name is a slug, so
// it can never be this.
const exportAllEnvironments = "*"

var exportCmd = &cobra.Command{
	Use:   "export [project]",
	Short: "Write a project, or one environment of it, as alethia.yaml",
	Long: `Read a project from the control plane and write it as alethia.yaml: the cloud account (by
its label), the region, each environment's stage, placement and namespace, its components and its
add-ons. "alethia plan" on the file shows nothing to change.

--env exports one environment. A project with several environments needs --env or --all (on a
terminal you are asked instead). The file goes to stdout unless --out names one; an existing file is
replaced only with --force.

Secrets are never written: secret add-on settings, an add-on's Advanced values override, credential
fields and credential references are left out, and each is listed in a comment at the top of the file.
Omitted means "keep what is stored", so apply never clears them.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		env, _ := cmd.Flags().GetString("env")
		all, _ := cmd.Flags().GetBool("all")
		out, _ := cmd.Flags().GetString("out")
		force, _ := cmd.Flags().GetBool("force")
		o := exportOptions{env: env, all: all, out: out, force: force}
		// Refused before any network call: a run that would end in "already exists" should not first
		// spend a dozen round trips building the file it cannot write.
		if err := o.check(); err != nil {
			fail(err)
		}
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if len(args) > 0 {
			o.project = args[0]
		} else if o.project, err = selectProject(token); err != nil {
			fail(err)
		}
		if err := runExport(api.NewClient(token), os.Stdout, os.Stderr, o, promptExportEnvironment); err != nil {
			fail(err)
		}
	},
}

// exportOptions is one export, as the flags describe it.
type exportOptions struct {
	// project is the project's name or id.
	project string
	// env is the one environment to export, by name or id; empty with all false asks or refuses.
	env string
	// all exports every environment.
	all bool
	// out is the file to write; empty writes to stdout.
	out string
	// force replaces an existing out.
	force bool
}

// check refuses the flag combinations that cannot be honoured, before anything is read.
func (o exportOptions) check() error {
	if o.env != "" && o.all {
		return errors.New("pass --env to export one environment or --all to export every one, not both")
	}
	if o.out != "" && !o.force && manifest.Exists(o.out) {
		return fmt.Errorf("%s already exists — pass --force to replace it", o.out)
	}
	return nil
}

// exportClient is the slice of the API the export reads. Read routes only: an export never writes.
type exportClient interface {
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

// envPicker asks which environment to export when the project has several and no flag said. It
// returns an environment name, or exportAllEnvironments.
type envPicker func(project string, envNames []string) (string, error)

// exported is a manifest and the notes saying what was left out of it.
type exported struct {
	Manifest *manifest.Manifest
	// Notes are one line each, in a stable order: what the file does not carry and why.
	Notes []string
}

// runExport builds the manifest and writes it — to o.out, or to stdout — and lists what it left out
// on stderr, so a redirect into a file carries only the file.
func runExport(c exportClient, stdout, stderr io.Writer, o exportOptions, pick envPicker) error {
	if err := o.check(); err != nil {
		return err
	}
	ex, err := buildExport(c, o, pick)
	if err != nil {
		return err
	}
	data, err := ex.render()
	if err != nil {
		return err
	}
	if o.out == "" {
		if _, err := stdout.Write(data); err != nil {
			return err
		}
	} else {
		if err := os.WriteFile(o.out, data, 0o644); err != nil {
			return fmt.Errorf("write %s: %w", o.out, err)
		}
		fmt.Fprintf(stderr, "Wrote %s (%s)\n", o.out, plural(len(ex.Manifest.Environments), "environment"))
	}
	if len(ex.Notes) > 0 {
		fmt.Fprintf(stderr, "Left out of %s (also listed at the top of the file):\n", manifest.FileName)
		for _, n := range ex.Notes {
			fmt.Fprintf(stderr, "  - %s\n", n)
		}
	}
	return nil
}

// render writes the manifest under a header listing what was left out. That the result reads back
// through `plan` is the round-trip test's to prove, not a check at run time.
func (ex *exported) render() ([]byte, error) {
	body, err := manifest.Render(ex.Manifest)
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, "# %s for project %s, written by `alethia export`.\n", manifest.FileName, ex.Manifest.Project)
	b.WriteString("# `alethia plan` on this file shows nothing to change for the environments it lists.\n")
	if len(ex.Notes) > 0 {
		b.WriteString("#\n# Not in this file (omitted means apply keeps what is stored):\n")
		for _, n := range ex.Notes {
			fmt.Fprintf(&b, "#   - %s\n", strings.ReplaceAll(n, "\n", " "))
		}
	}
	b.WriteString("\n")
	b.Write(body)
	return b.Bytes(), nil
}

// buildExport reads the project and assembles its manifest.
func buildExport(c exportClient, o exportOptions, pick envPicker) (*exported, error) {
	configs, err := c.GetConfigurations()
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	project, err := matchExportProject(configs, o.project)
	if err != nil {
		return nil, err
	}
	settings, err := c.GetProjectSettings(project.ProjectName)
	if err != nil {
		return nil, err
	}
	ex := &exported{Manifest: &manifest.Manifest{
		Project: project.ProjectName,
		Cloud:   manifest.Cloud{Region: settings.Region},
		IaC:     manifest.IaC{Version: settings.IacVersion},
	}}
	if settings.CloudIdentityID != nil && *settings.CloudIdentityID != "" {
		identities, err := c.GetCloudIdentities()
		if err != nil {
			return nil, fmt.Errorf("list cloud accounts: %w", err)
		}
		account, note := exportAccount(identities, *settings.CloudIdentityID)
		ex.Manifest.Cloud.Account = account
		ex.note(note)
	}

	envs, err := c.ListEnvironments(project.ID)
	if err != nil {
		return nil, fmt.Errorf("list environments of %s: %w", project.ProjectName, err)
	}
	envs = orderEnvironments(envs)
	chosen, err := chooseEnvironments(project.ProjectName, envs, o, pick)
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
	ex.note("lifecycle — the environment read does not carry it, so none is written (persistent is the default); add `lifecycle: ephemeral` by hand where it applies")

	r := &exportReader{c: c, project: project.ID}
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
func (ex *exported) note(n string) {
	if n != "" {
		ex.Notes = append(ex.Notes, n)
	}
}

// matchExportProject finds the project by id, or by name case-insensitively — the server's uniqueness
// rule, so `Shop` and `shop` are one project here as there.
func matchExportProject(configs []types.ConfigurationSummary, ref string) (types.ConfigurationSummary, error) {
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
			return types.ConfigurationSummary{}, fmt.Errorf("project %q not found — this organization has no projects", ref)
		}
		return types.ConfigurationSummary{}, fmt.Errorf("project %q not found (have: %s)", ref, strings.Join(have, ", "))
	}
	return types.ConfigurationSummary{}, fmt.Errorf("project name %q matches %d projects — pass the project's id", ref, len(matches))
}

// exportAccount names the project's cloud account the way the file should: by its label, which `plan`
// resolves back to this id. A label another account shares would resolve to neither, so the id is
// written instead, with a note; an account this organization cannot list is left out, with a note.
func exportAccount(identities []api.CloudIdentity, id string) (string, string) {
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

// orderEnvironments puts the default environment first — the manifest's first environment is the
// one that owns the Fabric — and the rest by name, so a re-export is byte-identical whatever order the
// server listed them in.
func orderEnvironments(envs []api.Environment) []api.Environment {
	out := append([]api.Environment(nil), envs...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IsDefault != out[j].IsDefault {
			return out[i].IsDefault
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// chooseEnvironments is --env, --all, the only environment, or the picker — in that order. Without a
// terminal, a project with several environments and neither flag is refused naming them all, because
// exporting one of them silently is what `config export` did before --env existed.
func chooseEnvironments(project string, envs []api.Environment, o exportOptions, pick envPicker) ([]api.Environment, error) {
	if len(envs) == 0 {
		return nil, fmt.Errorf("project %s has no environments to export", project)
	}
	envNames := make([]string, len(envs))
	for i, e := range envs {
		envNames[i] = e.Name
	}
	want := o.env
	switch {
	case o.all:
		return envs, nil
	case want != "":
	case len(envs) == 1:
		return envs, nil
	default:
		choice, err := pick(project, envNames)
		if err != nil {
			return nil, err
		}
		if choice == exportAllEnvironments {
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
	return nil, fmt.Errorf("environment %q not found in %s (have: %s)", want, project, strings.Join(envNames, ", "))
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

// promptExportEnvironment is the terminal's answer to "which environment": a picker over the project's
// environments plus "every environment". Without a terminal it refuses, naming both flags.
func promptExportEnvironment(project string, envNames []string) (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", fmt.Errorf("%s has %d environments (%s) — pass --env <name> to export one, or --all to export every one",
			project, len(envNames), strings.Join(envNames, ", "))
	}
	options := make([]huh.Option[string], 0, len(envNames)+1)
	for _, n := range envNames {
		options = append(options, huh.NewOption(n, n))
	}
	options = append(options, huh.NewOption("every environment", exportAllEnvironments))
	choice := envNames[0]
	err := runHuhForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Environment").
			Description(fmt.Sprintf("Which environment of %s to write to %s", project, manifest.FileName)).
			Options(options...).
			Value(&choice),
	))
	return choice, err
}

// exportReader reads one project's environments into manifest form. The schema and the catalog are
// fetched once, and only when an environment has something that needs them.
type exportReader struct {
	c       exportClient
	project string
	schema  *api.ComponentSchemaDocument
	catalog *api.AddonCatalogDocument
}

// environment reads one environment: its placement, components, add-ons, and a note for anything
// attached there that the manifest has no section for.
func (r *exportReader) environment(e api.Environment, ex *exported) (manifest.Environment, error) {
	env := manifest.Environment{Name: e.Name, Stage: e.Stage, Placement: e.PlacementMode}
	// Written only on a shared placement: Normalize drops a namespace from a dedicated environment,
	// so writing one there would be a line with no effect.
	if e.Namespace != nil && *e.Namespace != "" && e.PlacementMode != string(types.PlacementModeDedicated) {
		env.Namespace = *e.Namespace
	}
	comps, err := r.c.ListComponents(r.project, "", e.Name)
	if err != nil {
		return env, fmt.Errorf("list components of %s: %w", e.Name, err)
	}
	if env.Components, err = r.components(e.Name, comps, ex); err != nil {
		return env, err
	}
	rows, err := r.c.GetProjectAddons(r.project, e.Name)
	if err != nil {
		return env, fmt.Errorf("list add-ons of %s: %w", e.Name, err)
	}
	if rows != nil {
		if env.Addons, err = r.addons(e.Name, rows.Addons, ex); err != nil {
			return env, err
		}
	}
	r.byo(e.Name, ex)
	return env, nil
}

// componentGone are the statuses of a component that is being, or has been, torn down. Exporting one
// would declare it, and apply on a new environment would create it again.
var componentGone = map[string]bool{"DESTROYING": true, "DESTROYED": true}

// components turns an environment's components into the manifest's, in schema kind order with named
// entries sorted, keeping only what the published schema says a file may set.
func (r *exportReader) components(env string, comps []api.Component, ex *exported) (manifest.Components, error) {
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
	var out manifest.Components
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
		kind := manifest.KindEntries{Kind: def.Kind, List: !def.Singleton}
		for _, c := range rows {
			entry := manifest.Component{Fields: exportFields(env, def, c, ex)}
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

// exportFields is one component's settable values: the schema's fields, minus nulls, credential
// references and secret fields, with provider_config stripped of credential keys.
func exportFields(env string, def api.ComponentSchemaKind, c api.Component, ex *exported) map[string]any {
	out := map[string]any{}
	ref := env + " " + componentRef(c)
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
		if schemaMarksSecret(def, f) || isCredentialKeyName(f) {
			ex.note(fmt.Sprintf("%s — %s is a secret field and is not written", ref, f))
			continue
		}
		if f == "provider_config" {
			if pc := exportProviderConfig(ref, def.Kind, v, ex); len(pc) > 0 {
				out[f] = pc
			}
			continue
		}
		out[f] = plainValue(v)
	}
	return out
}

// exportProviderConfig keeps a provider_config's non-credential, non-null keys. A key named like a
// credential is dropped by NAME — the console's rule — because its value may be one that was stored
// before the console started refusing them.
func exportProviderConfig(ref, kind string, v any, ex *exported) map[string]any {
	in, ok := stringKeyed(v)
	if !ok {
		ex.note(ref + " — provider_config is not a mapping on the server, so it is not written")
		return nil
	}
	out := map[string]any{}
	var dropped []string
	for k, val := range in {
		if isCredentialKeyName(k) || (kind == "secrets" && normalizeKeyName(k) == "value") {
			dropped = append(dropped, k)
			continue
		}
		if val == nil {
			continue
		}
		out[k] = plainValue(val)
	}
	if len(dropped) > 0 {
		sort.Strings(dropped)
		ex.note(fmt.Sprintf("%s — provider_config %s: a credential, never written (store it as a secret)", ref, strings.Join(dropped, ", ")))
	}
	return out
}

// schemaMarksSecret reports whether the published schema marks a field `writeOnly` — a value the
// server accepts and never hands back as itself, which is what a secret field is.
func schemaMarksSecret(def api.ComponentSchemaKind, field string) bool {
	props, ok := stringKeyed(def.Schema["properties"])
	if !ok {
		return false
	}
	prop, ok := stringKeyed(props[field])
	if !ok {
		return false
	}
	wo, _ := prop["writeOnly"].(bool)
	return wo
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
func (r *exportReader) addons(env string, rows []api.Addon, ex *exported) ([]manifest.Addon, error) {
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
	modes := addonModeValues()
	var out []manifest.Addon
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
		a := manifest.Addon{ID: row.AddonID}
		if row.VersionPinned && row.Version != nil && *row.Version != "" {
			v := *row.Version
			a.Version = &v
		}
		if oneOfString(row.Mode, modes) {
			a.Mode = row.Mode
		}
		secret := append(append([]string(nil), entry.SecretKeys...), row.SecretKeys...)
		settings := map[string]any{}
		var unknown []string
		for k, v := range row.Settings {
			switch {
			case v == nil, oneOfString(k, secret):
				// A secret is never written. The server removes them from this read; this is the same
				// rule against both lists, so a key only one of them names still cannot reach the file.
			case entry.Settings != nil && !oneOfString(k, entry.Settings):
				unknown = append(unknown, k)
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
		if len(unknown) > 0 {
			sort.Strings(unknown)
			ex.note(fmt.Sprintf("%s — stored settings %s are not ones the catalog declares, so they are not written", ref, strings.Join(unknown, ", ")))
		}
		if row.ValuesYAML != nil && strings.TrimSpace(*row.ValuesYAML) != "" {
			ex.note(fmt.Sprintf("%s — its Advanced values override is not written: it may hold secrets. "+
				"apply keeps it as stored; to manage it from git, put it in a file next to %s and name it with `values_file:`",
				ref, manifest.FileName))
		}
		out = append(out, a)
	}
	return out, nil
}

// byo notes the BYO charts and BYO IaC attached to an environment — the manifest has no section for
// either yet. A read that fails is said as such: "could not check" must not read as "none".
func (r *exportReader) byo(env string, ex *exported) {
	charts, err := r.c.GetProjectByoCharts(r.project, env)
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
	src, err := r.c.GetProjectIacSource(r.project, env)
	switch {
	case err != nil:
		ex.note(fmt.Sprintf("%s BYO IaC — could not be read (%v); a source attached there is not in this file", env, err))
	case src != nil:
		ex.note(fmt.Sprintf("%s BYO IaC %s (%s) — BYO IaC is not exported yet", env, src.Name, src.Path))
	}
}

// oneOfString reports whether v is in the list.
func oneOfString(v string, list []string) bool {
	for _, s := range list {
		if s == v {
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

// isCredentialKeyName reports whether a key's NAME carries a credential word (`hcloud_token`,
// `dbPassword`, `APIKey`). It over-matches on purpose, as the console's rule does: a false positive
// leaves a value out of the file, which apply then keeps; a false negative commits a secret.
func isCredentialKeyName(name string) bool {
	segments := strings.Split(normalizeKeyName(name), "_")
	for i, s := range segments {
		if oneOfString(s, credentialWords) {
			return true
		}
		if i+1 < len(segments) && oneOfString(s+"_"+segments[i+1], credentialWords) {
			return true
		}
	}
	return false
}

// normalizeKeyName spells a name the one way the credential rule reads it: camelCase split into
// snake_case (acronyms too — `DBPassword` → `db_password`, `APIKey` → `api_key`), dots, dashes and
// spaces as `_`, lower-cased. The console's normalizeKeyName, without a regular expression.
func normalizeKeyName(name string) string {
	rs := []rune(strings.TrimSpace(name))
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

func init() {
	exportCmd.Flags().String("env", "", "Environment to export, by name or id (required when the project has several, unless --all)")
	exportCmd.Flags().Bool("all", false, "Export every environment of the project")
	exportCmd.Flags().String("out", "", "Write the file here instead of stdout")
	exportCmd.Flags().Bool("force", false, "Replace --out if it already exists")
	rootCmd.AddCommand(exportCmd)
}
