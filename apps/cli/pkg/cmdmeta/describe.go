// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmdmeta

import (
	"sort"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// Schema names the shape of the document Describe returns. A change that removes or renames a
// field, or changes what a field means, takes a new version; adding a field does not.
const Schema = "alethia.commands/v1"

// Document is the machine-readable description of the CLI: every listed command with its flags
// and its metadata. Every key is always present and no list is ever null.
type Document struct {
	// Schema is the constant Schema.
	Schema string `json:"schema"`
	// Name is the program's name.
	Name string `json:"name"`
	// Version is the root command's version.
	Version string `json:"version"`
	// Groups are the root's help groups in help order.
	Groups []Group `json:"groups"`
	// GlobalFlags are the flags every command accepts.
	GlobalFlags []FlagDoc `json:"global_flags"`
	// Commands are the listed commands, sorted by path. The root itself is not one of them.
	Commands []CommandDoc `json:"commands"`
}

// FlagDoc describes one flag.
type FlagDoc struct {
	// Name is the long name, without the dashes.
	Name string `json:"name"`
	// Shorthand is the one-letter form, or empty.
	Shorthand string `json:"shorthand"`
	// Type is the value's type as the flag library names it: string, bool, int, stringArray.
	Type string `json:"type"`
	// Default is the default value as a string.
	Default string `json:"default"`
	// Usage is the flag's help text.
	Usage string `json:"usage"`
}

// CommandDoc describes one command.
type CommandDoc struct {
	// Path is the full command path, starting with the program name.
	Path string `json:"path"`
	// Use is the usage line: the path followed by the arguments the command takes.
	Use string `json:"use"`
	// Short is the one-line description.
	Short string `json:"short"`
	// Long is the full description, or empty.
	Long string `json:"long"`
	// Aliases are the other names the command answers to.
	Aliases []string `json:"aliases"`
	// Group is the help group of the command's top-level ancestor.
	Group string `json:"group"`
	// Runnable reports that the command does something itself, rather than only holding
	// subcommands.
	Runnable bool `json:"runnable"`
	// Flags are the flags the command accepts beyond the global ones, sorted by name.
	Flags []FlagDoc `json:"flags"`
	// Examples are the entry's examples.
	Examples []Example `json:"examples"`
	// Mutates, Destructive, LongRunning and Idempotent are the entry's facts; see Meta.
	Mutates     bool `json:"mutates"`
	Destructive bool `json:"destructive"`
	LongRunning bool `json:"long_running"`
	Idempotent  bool `json:"idempotent"`
	// DryRun is the dry-run level: none, client or server.
	DryRun DryRun `json:"dry_run"`
	// Output is the kind of thing written on stdout. It is none for a command that only holds
	// subcommands.
	Output Output `json:"output"`
	// Clouds are the clouds the command is specific to. Empty means every cloud.
	Clouds []string `json:"clouds"`
	// Capability is the switch the command, or the nearest command above it, sits behind.
	Capability string `json:"capability"`
}

// Describe returns the description of the command tree under root.
//
// It describes the tree as it stands, so call it after Apply: a command Apply hid is left out
// together with everything below it, and so is a command cobra marks as deprecated. A command with
// no entry is described with the zero entry.
func (r *Registry) Describe(root *cobra.Command) Document {
	global := map[string]bool{}
	root.PersistentFlags().VisitAll(func(f *pflag.Flag) { global[f.Name] = true })

	doc := Document{
		Schema:      Schema,
		Name:        root.Name(),
		Version:     root.Version,
		Groups:      append([]Group{}, r.groups...),
		GlobalFlags: flagDocs(nil, root.PersistentFlags()),
		Commands:    []CommandDoc{},
	}

	var visit func(cmd *cobra.Command, group, capability string)
	visit = func(cmd *cobra.Command, group, capability string) {
		for _, child := range cmd.Commands() {
			if child.Hidden || child.Deprecated != "" {
				continue
			}
			m := r.metas[child.CommandPath()]
			childGroup, childCapability := group, capability
			if cmd == root {
				childGroup = m.Group
			}
			if m.Capability != "" {
				childCapability = m.Capability
			}
			doc.Commands = append(doc.Commands, describeCommand(child, m, childGroup, childCapability, global))
			visit(child, childGroup, childCapability)
		}
	}
	visit(root, "", "")

	sort.Slice(doc.Commands, func(i, j int) bool { return doc.Commands[i].Path < doc.Commands[j].Path })
	return doc
}

// describeCommand builds the description of one command from the command and its entry.
func describeCommand(cmd *cobra.Command, m Meta, group, capability string, global map[string]bool) CommandDoc {
	output := m.Output
	if output == "" {
		output = OutputNone
	}
	return CommandDoc{
		Path:        cmd.CommandPath(),
		Use:         cmd.UseLine(),
		Short:       cmd.Short,
		Long:        cmd.Long,
		Aliases:     append([]string{}, cmd.Aliases...),
		Group:       group,
		Runnable:    cmd.Runnable(),
		Flags:       flagDocs(global, cmd.LocalFlags(), cmd.InheritedFlags()),
		Examples:    append([]Example{}, m.Examples...),
		Mutates:     m.Mutates,
		Destructive: m.Destructive,
		LongRunning: m.LongRunning,
		Idempotent:  m.Idempotent,
		DryRun:      dryRunLevel(m),
		Output:      output,
		Clouds:      append([]string{}, m.Clouds...),
		Capability:  capability,
	}
}
