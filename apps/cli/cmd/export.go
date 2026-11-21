// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/designfile"
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
// The file is built by `packages/core/designfile` (export.go) — the round-trip contract and the
// allow-list that keeps the file free of secrets are stated there, and the runner's design-file job
// goes through the same code. This file is the command: its flags, the environment picker, and the
// write to disk that never goes through a symlink or leaves half a file.

// manifestSchemaComment is the first line of every file `export` writes: the comment that tells an
// editor which JSON Schema the file follows.
const manifestSchemaComment = designfile.SchemaComment

// exportAllEnvironments is the picker's "every environment" answer. An environment name is a slug, so
// it can never be this.
const exportAllEnvironments = designfile.ExportAllEnvironments

type (
	// exportClient is the slice of the API the export reads. Read routes only: an export never writes.
	exportClient = designfile.ExportReader
	// envPicker asks which environment to export when the project has several and no flag said. It
	// returns an environment name, or exportAllEnvironments.
	envPicker = designfile.EnvPicker
	// exported is a manifest and the notes saying what was left out of it.
	exported = designfile.Exported
)

// The export's helpers, under the names this package's tests know them by.
var (
	holdsCredential        = designfile.HoldsCredential
	matchExportProject     = designfile.MatchExportProject
	isCredentialKeyName    = designfile.IsCredentialKeyName
	schemaProperty         = designfile.SchemaProperty
	normalizeKeyName       = designfile.NormalizeKeyName
	stringHoldsCredential  = designfile.StringHoldsCredential
	propertyIsSecret       = designfile.PropertyIsSecret
	orderEnvironments      = designfile.OrderEnvironments
	isSecretSetting        = designfile.IsSecretSetting
	isScalar               = designfile.IsScalar
	isPlain                = designfile.IsPlain
	isNestedCredentialName = designfile.IsNestedCredentialName
	exportAccount          = designfile.ExportAccount
	oneOfString            = designfile.OneOfString
)

// exportSelection is the part of the flags that says what to export, as designfile takes it.
func (o exportOptions) exportSelection() designfile.ExportOptions {
	return designfile.ExportOptions{Project: o.project, Env: o.env, All: o.all, KnobAllowed: providerConfigKeyAllowed}
}

// chooseEnvironments is --env, --all, the only environment, or the picker — in that order.
func chooseEnvironments(project string, envs []api.Environment, o exportOptions, pick envPicker) ([]api.Environment, error) {
	return designfile.ChooseEnvironments(project, envs, o.exportSelection(), pick)
}

// buildExport reads the project and assembles its manifest, with the generated provider_config
// allow-list this command embeds.
func buildExport(c exportClient, o exportOptions, pick envPicker) (*exported, error) {
	return designfile.BuildExport(c, designfile.ExportOptions{
		Project:     o.project,
		Env:         o.env,
		All:         o.all,
		KnobAllowed: providerConfigKeyAllowed,
	}, pick)
}

// The documents `export` can write.
const (
	// exportFormatYAML is alethia.yaml, the file `alethia plan` and `alethia apply` read.
	exportFormatYAML = "yaml"
	// exportFormatConsoleJSON is the console's own design document for one environment, the file
	// `alethia project design apply` reads.
	exportFormatConsoleJSON = "console-json"
)

// exportFormats is every value --format takes, in the order the help lists them.
var exportFormats = []string{exportFormatYAML, exportFormatConsoleJSON}

var exportCmd = &cobra.Command{
	Use:   "export [project]",
	Short: "Write a project, or one environment of it, as alethia.yaml",
	Long: `Read a project from the control plane and write it as alethia.yaml: the cloud account (by
its label), the region, each environment's stage, placement and namespace, its components and its
add-ons. "alethia plan" on the file shows nothing to change.

Use it to put a project that was built in the console under a file, or to start a new project
from an existing one. Without a project name you are asked which one on a terminal.

--env exports one environment. A project with several environments needs --env or --all (on a
terminal you are asked instead). The file goes to stdout unless --out names one; an existing file is
replaced only with --force. The first line of the file names its JSON Schema, so an editor checks
and completes the file as you type.

export never writes a value Alethia stores as a secret, a credential setting, or an add-on's
Advanced values override. It writes only component fields the component schema declares and does
not mark secret, provider_config keys that are settable template knobs on the component's cloud,
and single-value add-on settings the catalog declares and does not name secret. What it leaves out
is named in a comment at the top of the file and on stderr; omitted means "keep what is stored".

A credential typed into an ordinary setting (a user name, a parameter list) is written as typed.
Review the file before you commit it.

--format console-json writes a different document: the console's own design document for one
environment, as JSON, which "alethia project design apply" reads. It takes --env and not --all.
With --output json it is wrapped in an object that also carries its file name and format.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		env, _ := cmd.Flags().GetString("env")
		all, _ := cmd.Flags().GetBool("all")
		out, _ := cmd.Flags().GetString("out")
		force, _ := cmd.Flags().GetBool("force")
		format, _ := cmd.Flags().GetString("format")
		o := exportOptions{env: env, all: all, out: out, force: force, format: format}
		// Refused before any network call: a run that would end in "already exists" should not first
		// spend a dozen round trips building the file it cannot write.
		if err := o.check(); err != nil {
			fail(err)
			return
		}
		token, err := getAuthToken()
		if err != nil {
			fail(err)
			return
		}
		if o.project, err = exportProject(token, args); err != nil {
			fail(err)
			return
		}
		client := api.NewClient(token)
		if o.format == exportFormatConsoleJSON {
			err = runConsoleExport(client, printerFor(cmd), consoleExport{
				project: o.project, env: o.env, out: o.out, force: o.force, contentFormat: "json",
			})
		} else {
			err = runExport(client, printer.Out, printer.Err, o, promptExportEnvironment)
		}
		if err != nil {
			fail(err)
		}
	},
}

// exportProject returns the project an export reads: the argument, or the picker's answer on a
// terminal. With nobody to ask it refuses, naming the argument.
func exportProject(token string, args []string) (string, error) {
	if len(args) > 0 {
		return args[0], nil
	}
	project, err := selectProject(token)
	return project, flagRequired(err, "a project name (alethia export NAME)", "alethia project list")
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
	// format is the document to write: one of exportFormats. Empty is alethia.yaml.
	format string
}

// errExportIsSymlink and errExportExists are the two refusals to write a file. They are stated
// once because the file is checked twice: before anything is read, and again when it is written.
func errExportIsSymlink(path string) error {
	return refusal(clierr.CodeConflict, "",
		"%s is a symbolic link — export does not write through one; pass the real path", path)
}

// errExportExists refuses to replace a file nobody asked to replace.
func errExportExists(path string) error {
	return refusal(clierr.CodeAlreadyExists, "pass --force to replace it, or name another file with --out",
		"%s already exists — pass --force to replace it", path)
}

// check refuses the flag combinations that cannot be honoured, before anything is read.
func (o exportOptions) check() error {
	if o.format != "" && !slices.Contains(exportFormats, o.format) {
		return refusal(clierr.CodeInvalidFlag, "",
			"invalid --format %q (want %s)", o.format, strings.Join(exportFormats, " or "))
	}
	if o.env != "" && o.all {
		return refusal(clierr.CodeInvalidUsage, "",
			"pass --env to export one environment or --all to export every one, not both")
	}
	if o.all && o.format == exportFormatConsoleJSON {
		return refusal(clierr.CodeInvalidUsage, "",
			"--format %s writes one environment's design document: pass --env, not --all", exportFormatConsoleJSON)
	}
	if o.out == "" {
		return nil
	}
	// Lstat, not Stat: a symlink — dangling or not — is refused outright, so the export never writes
	// through one to wherever it points. A file that exists is refused without --force. Both are
	// checked again at write time (writeExportFile), since the reads in between take a while.
	info, err := os.Lstat(o.out)
	switch {
	case err != nil:
		return nil
	case info.Mode()&os.ModeSymlink != 0:
		return errExportIsSymlink(o.out)
	case !o.force:
		return errExportExists(o.out)
	}
	return nil
}

// writeExportFile writes the file at path, never partly and never through a symlink.
//
// The bytes go to a temporary file in the same directory first. Without force that file is then
// hard-linked to path — link(2) fails when anything, a dangling symlink included, already has the
// name, which is O_EXCL's guarantee for a file that appeared after check() — and the temporary name is
// removed. With force it is renamed over path, which replaces the directory entry itself, so a symlink
// swapped in after the Lstat is replaced, never followed; the replaced file's mode is kept. Either way
// a write that fails leaves no partial alethia.yaml behind.
func writeExportFile(path string, data []byte, force bool) error {
	mode := os.FileMode(0o644)
	if info, err := os.Lstat(path); err == nil {
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			return errExportIsSymlink(path)
		case !force:
			return errExportExists(path)
		}
		mode = info.Mode().Perm()
	}
	tmp, err := writeExportTemp(path, data, mode)
	if err != nil {
		return err
	}
	// After a link the temporary name is a second name for the file; after a rename it is gone.
	defer func() { _ = os.Remove(tmp) }()
	if force {
		return os.Rename(tmp, path)
	}
	if err := exportLink(tmp, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return errExportExists(path)
		}
		return fmt.Errorf("%w (write to stdout instead if this filesystem has no hard links)", err)
	}
	return nil
}

// exportChmod and exportLink are os.Chmod and os.Link, as variables so a test can make them fail.
var (
	exportChmod = os.Chmod
	exportLink  = os.Link
)

// writeExportTemp writes data to a new temporary file beside path, with the given mode, and returns
// its name. On any failure the temporary file is removed.
func writeExportTemp(path string, data []byte, mode os.FileMode) (string, error) {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return "", err
	}
	_, werr := f.Write(data)
	if err := errors.Join(werr, f.Close(), exportChmod(f.Name(), mode)); err != nil {
		_ = os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// runExport builds the manifest and writes it — to o.out, or to stdout — and lists what it left out
// on stderr, so a redirect into a file carries only the file.
func runExport(c exportClient, stdout, stderr io.Writer, o exportOptions, pick envPicker) error {
	if err := o.check(); err != nil {
		return err
	}
	ex, err := buildExport(c, o, pick)
	if err != nil {
		return exportNotFound(err)
	}
	data, err := ex.Render()
	if err != nil {
		return err
	}
	if o.out == "" {
		if _, err := stdout.Write(data); err != nil {
			return err
		}
	} else {
		if err := writeExportFile(o.out, data, o.force); err != nil {
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

// exportNotFound gives a project or an environment the export could not find the not-found class
// and the command that lists what exists. Any other error is returned as it is.
func exportNotFound(err error) error {
	var missing *designfile.NotFoundError
	if !errors.As(err, &missing) {
		return err
	}
	e := refusal(clierr.CodeNotFound, "alethia project list", "%s", err.Error())
	e.Cause = err
	return e
}

// ── the console's design document ─────────────────────────────────────────────────────────

// consoleExporter is the one read `export --format console-json` makes.
type consoleExporter interface {
	ExportConfiguration(projectName, format, env string) (*api.ConfigurationExport, error)
}

// consoleExport is one export of the console's design document.
type consoleExport struct {
	project string
	// env is the environment to export, by id, name or stage; empty is the project's default one.
	env string
	// out is the file to write; empty writes to stdout.
	out string
	// force replaces an existing out.
	force bool
	// contentFormat is the format the control plane is asked for.
	contentFormat string
}

// runConsoleExport reads one environment's design document and writes it: to o.out, or as the
// export envelope under `--output json`, or as the document itself on stdout. It is the whole of
// `alethia export --format console-json`, and of `alethia config export`, its old name.
func runConsoleExport(c consoleExporter, p *Printer, o consoleExport) error {
	export, err := c.ExportConfiguration(o.project, o.contentFormat, o.env)
	if err != nil {
		e := *clierr.From(fmt.Errorf("export %s: %w", o.project, err))
		if e.Class == clierr.ClassNotFound && e.Hint == "" {
			e.Hint = "alethia project list"
		}
		return &e
	}
	if o.out != "" {
		if err := writeExportFile(o.out, []byte(export.Content), o.force); err != nil {
			return fmt.Errorf("write %s: %w", o.out, err)
		}
		fmt.Fprintf(p.Err, "Wrote %s (%s)\n", o.out, export.Format)
		return nil
	}
	if p.Format == ui.FormatJSON {
		return ui.RenderJSON(p.Out, export)
	}
	content := export.Content
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	_, err = io.WriteString(p.Out, content)
	return err
}

// promptExportEnvironment is the terminal's answer to "which environment": a picker over the project's
// environments plus "every environment". Without a terminal it refuses, naming both flags.
func promptExportEnvironment(project string, envNames []string) (string, error) {
	if err := requireInteractiveForm(); err != nil {
		e := refusal(clierr.CodeInputRequired, "alethia export "+project+" --all",
			"%s has %d environments (%s) — pass --env <name> to export one, or --all to export every one",
			project, len(envNames), strings.Join(envNames, ", "))
		e.Cause = err
		return "", e
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

//go:embed provider_config_keys.json
var providerConfigKeysJSON []byte

// providerConfigKeys is provider_config_keys.json parsed: cloud → kind → the settable keys. A variable
// so a test can hand the export an allow-list the generated file would never contain.
var providerConfigKeys = sync.OnceValue(func() map[string]map[string][]string {
	return parseProviderConfigKeys(providerConfigKeysJSON)
})

// parseProviderConfigKeys reads the allow-list file. A file that does not parse allows nothing — the
// export then leaves every key out, which apply keeps.
func parseProviderConfigKeys(raw []byte) map[string]map[string][]string {
	var doc struct {
		Keys map[string]map[string][]string `json:"keys"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	return doc.Keys
}

// providerConfigKeyAllowed reports whether key is a settable template knob of kind on cloud — the
// console's `settableProviderConfigKnobs`, as generated into provider_config_keys.json.
func providerConfigKeyAllowed(cloud, kind, key string) bool {
	return slices.Contains(providerConfigKeys()[cloud][kind], key)
}

func init() {
	exportCmd.Flags().String("env", "", "Environment to export, by name or id (required when the project has several, unless --all)")
	exportCmd.Flags().Bool("all", false, "Export every environment of the project")
	exportCmd.Flags().String("out", "", "Write the file here instead of stdout")
	exportCmd.Flags().Bool("force", false, "Replace --out if it already exists")
	exportCmd.Flags().String("format", exportFormatYAML,
		"Document to write: "+exportFormatYAML+" (alethia.yaml) or "+exportFormatConsoleJSON+" (the console's design document for one environment)")
	rootCmd.AddCommand(exportCmd)
}
