// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package cmdmeta is the command metadata registry of the alethia CLI.
//
// A cobra command says how to run itself and how to print its help. It does not say whether it
// changes anything, whether it deletes, whether its work outlives the request, or what kind of
// thing it prints. Those facts are what help groups, examples, the docs reference, man pages and
// the machine-readable description of the CLI are built from, and they are written down once here:
// one Meta per command, keyed by the command's path.
//
// The registry does three things with them. Apply writes them onto the command tree (the help
// group, the examples, the annotations, and whether the command is listed). Describe returns the
// tree and the metadata as one versioned document. Check reports every way the two disagree, so a
// command added without an entry fails a test rather than shipping undescribed.
//
// The package imports cobra and nothing from the CLI, so a generator can use it against the tree
// without pulling in the commands' own dependencies.
package cmdmeta

import (
	"fmt"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// DryRun is how far a command can go without changing anything.
type DryRun string

// The dry-run levels.
const (
	// DryRunNone is a command with no dry run. It is also what the zero value means.
	DryRunNone DryRun = "none"
	// DryRunClient resolves and validates every input in the CLI, then reports the request it would
	// send. Nothing is sent.
	DryRunClient DryRun = "client"
	// DryRunServer sends the request to a route that validates it without writing.
	DryRunServer DryRun = "server"
)

// Output is the kind of thing a command writes on stdout.
type Output string

// The output kinds.
const (
	// OutputTable is a result the --output flag formats: a table for a person, json or csv for a
	// program.
	OutputTable Output = "table"
	// OutputDocument is a document with its own format, such as an exported manifest or a log.
	OutputDocument Output = "document"
	// OutputSecret is a credential. It is written once and never repeated in a diagnostic.
	OutputSecret Output = "secret"
	// OutputNone is a command that writes nothing on stdout.
	OutputNone Output = "none"
)

// Example is one invocation worth showing, with an optional sentence saying what it does.
type Example struct {
	// Cmd is the command line, starting with the program name.
	Cmd string `json:"cmd"`
	// Note says what the invocation does. It may be empty.
	Note string `json:"note,omitempty"`
}

// Meta is what the registry records about one command.
type Meta struct {
	// Path is the command's full path, starting with the root's name: "alethia project list".
	Path string
	// Group is the help group a top-level command is listed under. Only a command directly under
	// the root has one; every command below it belongs to its top-level ancestor's group.
	Group string
	// Examples are shown in the command's help and in its reference page.
	Examples []Example
	// Mutates reports that the command changes state that outlives it: in the control plane, in a
	// cloud account, or in the CLI's own stored configuration and credentials. A file the command
	// is asked to write is its output, not a mutation.
	Mutates bool
	// Destructive reports that the command removes a record or a resource, or tears infrastructure
	// down.
	Destructive bool
	// LongRunning reports that the command queues a job, so the work continues after the request
	// that started it has returned.
	LongRunning bool
	// Idempotent reports that the command is safe to repeat: a second run with the same input
	// changes nothing further and queues nothing more. It may still report that the subject is
	// already gone or already there.
	Idempotent bool
	// DryRun is the command's dry-run level. The zero value is DryRunNone.
	DryRun DryRun
	// Clouds names the clouds the command is specific to, by slug. Empty means every cloud.
	Clouds []string
	// Capability names the switch the command sits behind. A command whose capability is off is
	// not listed, and neither is anything below it. Empty means no switch.
	Capability string
	// Hidden reports that the command is never listed. It still runs when it is named.
	Hidden bool
	// Output is the kind of thing the command writes on stdout. A runnable command states one.
	Output Output
}

// Group is one heading in the root's help.
type Group struct {
	// ID is what a Meta names in its Group field.
	ID string `json:"id"`
	// Title is the heading as the help prints it.
	Title string `json:"title"`
}

// Registry holds the help groups and one Meta per command path.
type Registry struct {
	groups []Group
	metas  map[string]Meta
	// duplicates are paths that were added more than once. They are reported by Check; the first
	// entry is the one kept.
	duplicates []string
}

// NewRegistry builds a registry from the help groups, in the order the help lists them, and any
// number of entry lists.
func NewRegistry(groups []Group, families ...[]Meta) *Registry {
	r := &Registry{groups: groups, metas: map[string]Meta{}}
	for _, family := range families {
		for _, m := range family {
			if _, ok := r.metas[m.Path]; ok {
				r.duplicates = append(r.duplicates, m.Path)
				continue
			}
			r.metas[m.Path] = m
		}
	}
	return r
}

// Groups returns the help groups in help order.
func (r *Registry) Groups() []Group {
	return append([]Group(nil), r.groups...)
}

// Lookup returns the entry for a command path.
func (r *Registry) Lookup(path string) (Meta, bool) {
	m, ok := r.metas[path]
	return m, ok
}

// Paths returns every path the registry has an entry for, sorted.
func (r *Registry) Paths() []string {
	out := make([]string, 0, len(r.metas))
	for path := range r.metas {
		out = append(out, path)
	}
	sort.Strings(out)
	return out
}

// hasGroup reports whether id names one of the registry's help groups.
func (r *Registry) hasGroup(id string) bool {
	for _, g := range r.groups {
		if g.ID == id {
			return true
		}
	}
	return false
}

// Options are the two questions the registry cannot answer from the tree: which capabilities are
// on, and which clouds are offered. A nil function answers yes to everything.
type Options struct {
	// Enabled reports whether a capability is on.
	Enabled func(capability string) bool
	// CloudEnabled reports whether a cloud is offered, by slug.
	CloudEnabled func(slug string) bool
}

// enabled answers the capability question, treating the empty capability as always on.
func (o Options) enabled(capability string) bool {
	if capability == "" || o.Enabled == nil {
		return true
	}
	return o.Enabled(capability)
}

// anyCloud reports whether a cloud-specific command has at least one of its clouds offered. A
// command that names no cloud is not cloud-specific.
func (o Options) anyCloud(clouds []string) bool {
	if len(clouds) == 0 || o.CloudEnabled == nil {
		return true
	}
	for _, slug := range clouds {
		if o.CloudEnabled(slug) {
			return true
		}
	}
	return false
}

// listed reports whether a command with this entry appears in help.
func (o Options) listed(m Meta) bool {
	return !m.Hidden && o.enabled(m.Capability) && o.anyCloud(m.Clouds)
}

// The annotation keys Apply writes on a command. A value is the field's own spelling: "true" for a
// boolean that is set, the level for a dry run, the kind for an output, a comma-separated list for
// the clouds. A boolean that is not set has no annotation.
const (
	AnnotationMutates     = "alethia.io/mutates"
	AnnotationDestructive = "alethia.io/destructive"
	AnnotationLongRunning = "alethia.io/long-running"
	AnnotationIdempotent  = "alethia.io/idempotent"
	AnnotationDryRun      = "alethia.io/dry-run"
	AnnotationOutput      = "alethia.io/output"
	AnnotationClouds      = "alethia.io/clouds"
	AnnotationCapability  = "alethia.io/capability"
)

// managedAnnotations are the keys Apply owns. It clears each of them before writing, so applying
// twice gives the same command as applying once.
var managedAnnotations = []string{
	AnnotationMutates, AnnotationDestructive, AnnotationLongRunning, AnnotationIdempotent,
	AnnotationDryRun, AnnotationOutput, AnnotationClouds, AnnotationCapability,
}

// DryRunFlag is the flag Apply registers on a command whose entry declares a dry-run level.
const DryRunFlag = "dry-run"

// dryRunUsage is the help text of the flag Apply registers.
const dryRunUsage = "Validate the request and show what would change, without changing anything"

// Apply writes the registry onto the command tree under root.
//
// It first creates cobra's own help and completion commands, which cobra otherwise adds only when
// the tree is executed, so they are grouped like every other command. It then registers the help
// groups on the root and, for each command that has an entry, sets its help group, its examples,
// its annotations, whether it is listed, and the --dry-run flag when the entry declares a level
// and the command does not already define the flag.
//
// Whether a command is listed is decided here and nowhere else: a command with an entry is hidden
// exactly when its entry says so, its capability is off, or it is specific to clouds none of which
// is offered. Applying again with different options moves it accordingly.
//
// Apply does not validate. A command with no entry is left as it is; Check reports it.
func (r *Registry) Apply(root *cobra.Command, opts Options) {
	root.InitDefaultHelpCmd()
	root.InitDefaultCompletionCmd()

	for _, g := range r.groups {
		if !root.ContainsGroup(g.ID) {
			root.AddGroup(&cobra.Group{ID: g.ID, Title: g.Title})
		}
	}

	walk(root, func(cmd *cobra.Command) {
		m, ok := r.metas[cmd.CommandPath()]
		if !ok {
			return
		}
		if cmd.Parent() == root && r.hasGroup(m.Group) {
			cmd.GroupID = m.Group
		}
		cmd.Example = renderExamples(m.Examples)
		cmd.Hidden = !opts.listed(m)
		annotate(cmd, m)
		if dryRunLevel(m) != DryRunNone && cmd.Flags().Lookup(DryRunFlag) == nil {
			cmd.Flags().Bool(DryRunFlag, false, dryRunUsage)
		}
	})
}

// dryRunLevel returns an entry's dry-run level with the zero value read as none.
func dryRunLevel(m Meta) DryRun {
	if m.DryRun == "" {
		return DryRunNone
	}
	return m.DryRun
}

// annotate writes an entry's facts as annotations on its command, replacing the ones a previous
// Apply wrote and leaving every other annotation alone.
func annotate(cmd *cobra.Command, m Meta) {
	if cmd.Annotations == nil {
		cmd.Annotations = map[string]string{}
	}
	for _, key := range managedAnnotations {
		delete(cmd.Annotations, key)
	}
	set := func(key string, on bool) {
		if on {
			cmd.Annotations[key] = "true"
		}
	}
	set(AnnotationMutates, m.Mutates)
	set(AnnotationDestructive, m.Destructive)
	set(AnnotationLongRunning, m.LongRunning)
	set(AnnotationIdempotent, m.Idempotent)
	if level := dryRunLevel(m); level != DryRunNone {
		cmd.Annotations[AnnotationDryRun] = string(level)
	}
	if m.Output != "" {
		cmd.Annotations[AnnotationOutput] = string(m.Output)
	}
	if len(m.Clouds) > 0 {
		cmd.Annotations[AnnotationClouds] = strings.Join(m.Clouds, ",")
	}
	if m.Capability != "" {
		cmd.Annotations[AnnotationCapability] = m.Capability
	}
}

// renderExamples formats examples the way cobra prints its Example field: each command indented
// two spaces, under a comment line carrying its note when it has one.
func renderExamples(examples []Example) string {
	var lines []string
	for _, ex := range examples {
		if ex.Note != "" {
			lines = append(lines, "  # "+ex.Note)
		}
		lines = append(lines, "  "+ex.Cmd)
	}
	return strings.Join(lines, "\n")
}

// walk calls visit for root and every command below it, parents first.
func walk(root *cobra.Command, visit func(*cobra.Command)) {
	visit(root)
	for _, child := range root.Commands() {
		walk(child, visit)
	}
}

// validDryRun and validOutput are the values Check accepts.
var (
	validDryRun = map[DryRun]bool{"": true, DryRunNone: true, DryRunClient: true, DryRunServer: true}
	validOutput = map[Output]bool{OutputTable: true, OutputDocument: true, OutputSecret: true, OutputNone: true}
)

// Check reports every disagreement between the registry and the command tree under root, as one
// sentence each, sorted. An empty result means the two agree.
//
// It reports: a path entered twice; an entry for a command that does not exist; a runnable command
// with no entry; a runnable command whose entry states no output kind, or an unknown one; an
// unknown dry-run level; a command directly under the root with no help group, or one that is not
// registered; a help group on a command that is not directly under the root; and a destructive or
// long-running command that is not marked as mutating.
//
// Run it on a tree Apply has been called on, so cobra's own help and completion commands are
// present and held to the same rule as the rest.
func (r *Registry) Check(root *cobra.Command) []string {
	var problems []string
	say := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}

	for _, path := range r.duplicates {
		say("%q has more than one entry", path)
	}

	seen := map[string]bool{}
	walk(root, func(cmd *cobra.Command) {
		path := cmd.CommandPath()
		seen[path] = true
		m, ok := r.metas[path]
		topLevel := cmd.Parent() == root

		if !ok {
			if cmd.Runnable() {
				say("%q is runnable and has no entry", path)
			} else if topLevel {
				say("%q is listed in the root's help and has no entry to give it a help group", path)
			}
			return
		}
		if cmd.Runnable() && !validOutput[m.Output] {
			say("%q states output kind %q (want table, document, secret or none)", path, m.Output)
		}
		if !validDryRun[m.DryRun] {
			say("%q states dry-run level %q (want none, client or server)", path, m.DryRun)
		}
		switch {
		case topLevel && m.Group == "":
			say("%q is directly under the root and names no help group", path)
		case topLevel && !r.hasGroup(m.Group):
			say("%q names help group %q, which is not registered", path, m.Group)
		case !topLevel && m.Group != "":
			say("%q names a help group but is not directly under the root", path)
		}
		if (m.Destructive || m.LongRunning) && !m.Mutates {
			say("%q is destructive or long-running but is not marked as mutating", path)
		}
	})

	for path := range r.metas {
		if !seen[path] {
			say("%q has an entry but no such command exists", path)
		}
	}
	sort.Strings(problems)
	return problems
}

// DryRunRequested reports whether the --dry-run flag Apply registers was given to cmd.
func DryRunRequested(cmd *cobra.Command) bool {
	flag := cmd.Flags().Lookup(DryRunFlag)
	return flag != nil && flag.Value.String() == "true"
}

// helpFlag is the flag cobra adds to every command when the tree is executed. It is left out of a
// description so the document does not depend on whether the tree has run.
const helpFlag = "help"

// flagDocs describes the flags of the given flag sets as one list sorted by name, leaving out
// hidden flags, cobra's own --help, any name in skip, and a name an earlier set already gave.
func flagDocs(skip map[string]bool, sets ...*pflag.FlagSet) []FlagDoc {
	out := []FlagDoc{}
	seen := map[string]bool{}
	for _, flags := range sets {
		flags.VisitAll(func(f *pflag.Flag) {
			if f.Hidden || f.Name == helpFlag || skip[f.Name] || seen[f.Name] {
				return
			}
			seen[f.Name] = true
			out = append(out, FlagDoc{
				Name:      f.Name,
				Shorthand: f.Shorthand,
				Type:      f.Value.Type(),
				Default:   f.DefValue,
				Usage:     f.Usage,
			})
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
