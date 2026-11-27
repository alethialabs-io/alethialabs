// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package mcp is the stdio MCP server behind `alethia mcp` (agent surface §4.7, L11).
//
// It is a thin client of the API the CLI already speaks. Every tool is one CLI command, and a call
// runs that command as a child process of this same binary, in agent mode, with the credential the
// CLI already holds. So a tool can do exactly what the command can do and nothing else: the control
// plane checks the same permission verbs and asks for the same approvals as it does for the command
// typed in a shell, because it is the same request.
//
// THE TOOL LIST IS GENERATED, NOT WRITTEN. It is derived from the CLI's command registry
// (pkg/cmdmeta): the commands, their flags, and the registry's facts about each one (mutates,
// destructive, idempotent, output kind). A command added to the registry becomes a tool by the rule
// in Select, with no list here to update.
//
// Why not the remote server's tools (apps/console/lib/ai/mcp/surface.ts)? The remote route accepts
// only OAuth access tokens a person granted to one MCP client; the CLI's device-login or service
// token is not one, and cannot become one. The handlers behind those names run inside the console.
// Re-implementing them here would be a second tool list with a second set of handlers, which is
// what this package exists not to be.
//
// NO TOOL APPROVES. A command whose last word is "approve" is never a tool, at any tool set.
package mcp

import (
	"fmt"
	"slices"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
)

// ToolSet is how much of the CLI the server offers.
type ToolSet string

// The tool sets, narrowest first.
const (
	// ToolSetReadOnly offers only commands that change nothing.
	ToolSetReadOnly ToolSet = "read-only"
	// ToolSetStandard adds the deploy and inspect commands that change something without removing
	// anything: create a project, plan, apply, scan, attach.
	ToolSetStandard ToolSet = "standard"
	// ToolSetDestructive adds the deploy and inspect commands that remove a record or tear
	// infrastructure down.
	ToolSetDestructive ToolSet = "destructive"
)

// ToolSets are the tool sets in the order a person is offered them.
var ToolSets = []ToolSet{ToolSetReadOnly, ToolSetStandard, ToolSetDestructive}

// ParseToolSet reads a tool set's name.
func ParseToolSet(s string) (ToolSet, bool) {
	for _, t := range ToolSets {
		if string(t) == s {
			return t, true
		}
	}
	return "", false
}

// The help groups (cmd/meta_registry.go) whose commands may become tools. "start" (sign in, init,
// the guided first run) and "settings" (the CLI's own configuration, credentials and updates) are
// the CLI itself, not the control plane, and are never tools: an agent that could run `config set
// web-origin` could send the stored credential to a host of its choosing.
var toolGroups = []string{"deploy", "inspect", "organization"}

// writeGroups are the groups whose MUTATING commands may become tools. Organization commands that
// change something decide who may do what (members, grants, roles, tokens, alert channels); those
// stay a person's, so the organization group offers reads only.
var writeGroups = []string{"deploy", "inspect"}

// readOnlyFamilies are top-level commands inside writeGroups whose changes are still a person's,
// so they too are offered for reading only:
//
//   - connector: which cloud accounts the organization trusts. Registering or removing one is a
//     credential write, which the agent surface leaves out of every agent tool (§2, non-goals).
//   - fleet: how many runners are kept warm and how far they scale, which is what the account pays.
var readOnlyFamilies = []string{"connector", "fleet"}

// hiddenFlags are flags a tool never offers, whatever the command.
//
//   - output, agent, no-input: the server decides who is reading. Every call runs in agent mode,
//     which means json and no prompts.
//   - token: a credential passed as a tool argument would sit in the agent's transcript. The child
//     uses the credential the CLI already holds.
//   - debug: request diagnostics are for a person at a terminal, not for a tool result.
//   - web-origin, insecure-storage: where the CLI sends its credential and how it stores it.
//   - follow: it streams until the job ends; a tool call returns one result.
//   - out: it writes the result to a file of the caller's choosing, which would let a client
//     sandboxed away from the file system write anywhere this user can. The result is returned
//     instead.
//   - open: it opens a browser on the machine, which nobody may be looking at.
//   - detailed-exitcode: it reports "there are changes" as exit 2, which a tool result would read as
//     a failure.
//   - help: cobra's own.
var hiddenFlags = []string{
	"output", "agent", "no-input", "token", "debug", "web-origin", "insecure-storage",
	"follow", "out", "open", "detailed-exitcode", "help",
}

// globalFlagsOffered are the root's persistent flags a tool does offer: the organization a call acts
// in. Every other global flag is in hiddenFlags.
var globalFlagsOffered = []string{"org"}

// argsProperty is the input property that carries a command's positional arguments.
const argsProperty = "args"

// Tool is one CLI command offered as an MCP tool.
type Tool struct {
	// Name is the MCP tool name: the command path without the program name, words joined by "_".
	Name string
	// Command is the command path without the program name, as words: ["project", "list"].
	Command []string
	// Title is the command path as a person types it.
	Title string
	// Description is what the model reads to decide when to call the tool.
	Description string
	// Annotations are the four MCP tool annotations, from the registry's facts.
	Annotations Annotations
	// Flags are the flags the tool accepts, by name.
	Flags map[string]cmdmeta.FlagDoc
	// TakesArgs reports that the command takes positional arguments.
	TakesArgs bool
	// ArgsUsage is the usage line's argument part, such as "<project> [env]".
	ArgsUsage string
}

// Annotations are the MCP tool annotations. All four are stated: the protocol defaults for an absent
// one (destructive, open world) are wrong for most commands.
type Annotations struct {
	ReadOnlyHint    bool `json:"readOnlyHint"`
	DestructiveHint bool `json:"destructiveHint"`
	IdempotentHint  bool `json:"idempotentHint"`
	OpenWorldHint   bool `json:"openWorldHint"`
}

// Excluded reports why a command is never a tool, at any tool set, or "" when it may be one.
func Excluded(c cmdmeta.CommandDoc) string {
	words := commandWords(c.Path)
	switch {
	case !c.Runnable:
		return "it only holds subcommands"
	case len(words) == 0:
		return "it is the program itself"
	case words[len(words)-1] == "approve":
		return "no tool approves: a person decides an approval in the console"
	case !slices.Contains(toolGroups, c.Group):
		return fmt.Sprintf("its help group %q is the CLI itself, not the control plane", c.Group)
	case c.Output == cmdmeta.OutputSecret:
		return "it prints a credential, which would land in the agent's transcript"
	case c.Output != cmdmeta.OutputTable && c.Output != cmdmeta.OutputDocument:
		return "it prints no result a tool could return"
	}
	for _, f := range c.Flags {
		if strings.HasSuffix(f.Name, "-stdin") {
			return fmt.Sprintf("it takes a secret (--%s), and writing credentials is not an agent's job", f.Name)
		}
	}
	return ""
}

// allowed reports whether a command that is not Excluded is offered at tool set set.
func allowed(c cmdmeta.CommandDoc, set ToolSet) bool {
	if !c.Mutates {
		return true
	}
	if !slices.Contains(writeGroups, c.Group) {
		return false
	}
	if words := commandWords(c.Path); len(words) > 0 && slices.Contains(readOnlyFamilies, words[0]) {
		return false
	}
	switch set {
	case ToolSetStandard:
		return !c.Destructive
	case ToolSetDestructive:
		return true
	}
	return false
}

// Select returns the tools set offers, generated from doc, in the document's order (sorted by
// command path).
func Select(doc cmdmeta.Document, set ToolSet) []Tool {
	tools := []Tool{}
	for _, c := range doc.Commands {
		if Excluded(c) != "" || !allowed(c, set) {
			continue
		}
		tools = append(tools, toolFor(doc, c))
	}
	return tools
}

// toolFor builds the tool for one command.
func toolFor(doc cmdmeta.Document, c cmdmeta.CommandDoc) Tool {
	words := commandWords(c.Path)
	flags := map[string]cmdmeta.FlagDoc{}
	for _, f := range c.Flags {
		if !slices.Contains(hiddenFlags, f.Name) {
			flags[f.Name] = f
		}
	}
	for _, f := range doc.GlobalFlags {
		if slices.Contains(globalFlagsOffered, f.Name) {
			flags[f.Name] = f
		}
	}
	argsUsage := usageArgs(c.Use, c.Path)
	return Tool{
		Name:        strings.Join(words, "_"),
		Command:     words,
		Title:       c.Path,
		Description: describe(c, argsUsage),
		Annotations: Annotations{
			ReadOnlyHint:    !c.Mutates,
			DestructiveHint: c.Destructive,
			IdempotentHint:  c.Idempotent,
			// Every command reaches the control plane, and through it a cloud account.
			OpenWorldHint: true,
		},
		Flags:     flags,
		TakesArgs: argsUsage != "",
		ArgsUsage: argsUsage,
	}
}

// commandWords returns a command path without the program name.
func commandWords(path string) []string {
	words := strings.Fields(path)
	if len(words) == 0 {
		return nil
	}
	return words[1:]
}

// usageArgs returns the argument part of a usage line: what follows the command path, minus cobra's
// "[flags]".
func usageArgs(use, path string) string {
	rest := strings.TrimSpace(strings.TrimPrefix(use, path))
	rest = strings.TrimSpace(strings.ReplaceAll(rest, "[flags]", ""))
	return rest
}

// describe builds a tool's description from the command's own help.
func describe(c cmdmeta.CommandDoc, argsUsage string) string {
	var b strings.Builder
	b.WriteString(c.Short)
	if long := strings.TrimSpace(c.Long); long != "" && long != c.Short {
		b.WriteString("\n\n")
		b.WriteString(long)
	}
	b.WriteString("\n\nRuns `")
	b.WriteString(c.Path)
	if argsUsage != "" {
		b.WriteString(" ")
		b.WriteString(argsUsage)
	}
	b.WriteString("` in agent mode and returns what it prints.")
	if c.Mutates && c.LongRunning {
		b.WriteString(" A deploy or a destroy needs a person's approval: when the result says so, give the user the approval link and wait.")
	}
	return b.String()
}

// InputSchema returns the tool's JSON Schema: one property per flag, typed from the flag's type,
// and `args` for the positional arguments.
func (t Tool) InputSchema() map[string]any {
	props := map[string]any{}
	for name, f := range t.Flags {
		props[name] = flagSchema(f)
	}
	if t.TakesArgs {
		props[argsProperty] = map[string]any{
			"type":        "array",
			"items":       map[string]any{"type": "string"},
			"description": "Positional arguments, in order: " + t.ArgsUsage,
		}
	}
	return map[string]any{
		"type":                 "object",
		"properties":           props,
		"additionalProperties": false,
	}
}

// flagSchema returns the JSON Schema of one flag's value.
func flagSchema(f cmdmeta.FlagDoc) map[string]any {
	s := map[string]any{"description": f.Usage}
	switch flagKind(f.Type) {
	case kindBool:
		s["type"] = "boolean"
	case kindInt:
		s["type"] = "integer"
	case kindNumber:
		s["type"] = "number"
	case kindList:
		s["type"] = "array"
		s["items"] = map[string]any{"type": "string"}
	default:
		s["type"] = "string"
	}
	return s
}

// valueKind is how a flag's value is written in JSON.
type valueKind int

// The value kinds.
const (
	kindString valueKind = iota
	kindBool
	kindInt
	kindNumber
	kindList
)

// flagKind maps a pflag type name to the JSON kind of its value. A type not named here (a duration,
// an IP, a custom value) is written as a string, which is how pflag parses every value anyway.
func flagKind(pflagType string) valueKind {
	switch pflagType {
	case "bool":
		return kindBool
	case "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "count":
		return kindInt
	case "float32", "float64":
		return kindNumber
	case "stringArray", "stringSlice", "intSlice", "int32Slice", "int64Slice", "uintSlice",
		"float32Slice", "float64Slice", "boolSlice", "durationSlice":
		return kindList
	}
	return kindString
}
