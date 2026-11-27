// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
)

// The blocks a page can ask for. Each is rendered from a registry and from nothing else:
//
//	commands               every listed runnable command, a table per help group (cmdmeta)
//	examples <path>        the registry's examples of one command, as a bash fence (cmdmeta)
//	flags <path>           the flags of one command beyond the global ones, as a table (cobra)
//	exit-codes             the exit table (clierr.Classes)
//	error-codes            every error code the CLI assigns (clierr.Codes)
//
// A block naming a command the default build does not list is refused, so a page cannot go on
// describing a command that was hidden or removed.

// source is what the blocks are rendered from.
type source struct {
	doc      cmdmeta.Document
	byPath   map[string]cmdmeta.CommandDoc
	classes  []clierr.ClassDef
	codes    []clierr.CodeDef
	exitOfCl map[clierr.Class]int
}

// newSource indexes a command description and the error registry for rendering.
func newSource(doc cmdmeta.Document) source {
	src := source{
		doc:      doc,
		byPath:   map[string]cmdmeta.CommandDoc{},
		classes:  clierr.Classes(),
		codes:    clierr.Codes(),
		exitOfCl: map[clierr.Class]int{},
	}
	kept := doc.Commands[:0:0]
	for _, c := range doc.Commands {
		if groupHelp(doc, c) {
			continue
		}
		kept = append(kept, c)
		src.byPath[c.Path] = c
	}
	src.doc.Commands = kept
	for _, c := range src.classes {
		src.exitOfCl[c.Class] = c.Exit
	}
	return src
}

// groupHelp reports a `help` command below a group. cobra adds one under every group while it
// writes the man pages (doc.GenManTree initialises each command's help), so a description taken in
// the same process afterwards would list a dozen copies of `help`. Only the root's is a command a
// person runs, and only it has a registry entry.
func groupHelp(doc cmdmeta.Document, c cmdmeta.CommandDoc) bool {
	return strings.HasSuffix(c.Path, " help") && c.Path != doc.Name+" help"
}

// render returns the body of one block, named by the text of its opening marker.
func render(spec string, src source) (string, error) {
	name, arg, _ := strings.Cut(spec, " ")
	arg = strings.TrimSpace(arg)
	switch name {
	case "commands", "exit-codes", "error-codes":
		if arg != "" {
			return "", fmt.Errorf("block %q takes no argument, got %q", name, arg)
		}
	case "examples", "flags":
		if arg == "" {
			return "", fmt.Errorf("block %q needs a command path, such as `%s alethia mcp`", name, name)
		}
	}
	switch name {
	case "commands":
		return renderCommands(src)
	case "examples":
		c, err := src.command(arg)
		if err != nil {
			return "", err
		}
		return renderExamples(c)
	case "flags":
		c, err := src.command(arg)
		if err != nil {
			return "", err
		}
		return renderFlags(c), nil
	case "exit-codes":
		return renderExitCodes(src), nil
	case "error-codes":
		return renderErrorCodes(src), nil
	}
	return "", fmt.Errorf("no block is called %q (want commands, examples, flags, exit-codes or error-codes)", name)
}

// command looks up a listed command by its full path.
func (s source) command(path string) (cmdmeta.CommandDoc, error) {
	c, ok := s.byPath[path]
	if !ok {
		return c, fmt.Errorf("%q is not a command a default build lists", path)
	}
	return c, nil
}

// renderCommands writes one table per help group, in help order, of the group's runnable commands.
func renderCommands(src source) (string, error) {
	var b strings.Builder
	for i, g := range src.doc.Groups {
		var rows [][]string
		for _, c := range src.doc.Commands {
			if c.Group != g.ID || !c.Runnable {
				continue
			}
			rows = append(rows, []string{"`" + c.Path + "`", cell(c.Short), effect(c)})
		}
		if len(rows) == 0 {
			return "", fmt.Errorf("help group %q lists no runnable command", g.ID)
		}
		if i > 0 {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "### %s\n\n", strings.TrimSuffix(g.Title, ":"))
		writeTable(&b, []string{"Command", "What it does", "Effect"}, rows)
	}
	return b.String(), nil
}

// effect says in a few words what running a command does to anything outside the CLI.
func effect(c cmdmeta.CommandDoc) string {
	var parts []string
	switch {
	case c.Destructive:
		parts = append(parts, "Removes")
	case c.Mutates:
		parts = append(parts, "Changes")
	default:
		parts = append(parts, "Reads only")
	}
	if c.LongRunning {
		parts = append(parts, "queues a job")
	}
	if c.DryRun != cmdmeta.DryRunNone && c.DryRun != "" {
		parts = append(parts, "`--dry-run`")
	}
	return strings.Join(parts, ", ")
}

// renderExamples writes a command's examples as a bash fence, each under a comment carrying its
// note. A command with no example is refused: an empty fence documents nothing.
func renderExamples(c cmdmeta.CommandDoc) (string, error) {
	if len(c.Examples) == 0 {
		return "", fmt.Errorf("%q has no example in the registry to show", c.Path)
	}
	var b strings.Builder
	b.WriteString("```bash\n")
	for i, ex := range c.Examples {
		if i > 0 {
			b.WriteString("\n")
		}
		if ex.Note != "" {
			b.WriteString("# " + ex.Note + "\n")
		}
		b.WriteString(ex.Cmd + "\n")
	}
	b.WriteString("```\n")
	return b.String(), nil
}

// renderFlags writes a command's own and inherited flags, beyond the global ones, as a table.
func renderFlags(c cmdmeta.CommandDoc) string {
	if len(c.Flags) == 0 {
		return "This command takes no flags beyond the global ones.\n"
	}
	rows := make([][]string, 0, len(c.Flags))
	for _, f := range c.Flags {
		name := "`--" + f.Name + "`"
		if f.Shorthand != "" {
			name = "`-" + f.Shorthand + "`, " + name
		}
		def := "—"
		if f.Default != "" && f.Default != "false" && f.Default != "[]" {
			def = "`" + f.Default + "`"
		}
		rows = append(rows, []string{name, def, cell(f.Usage)})
	}
	var b strings.Builder
	writeTable(&b, []string{"Flag", "Default", "What it does"}, rows)
	return b.String()
}

// renderExitCodes writes the exit table.
func renderExitCodes(src source) string {
	rows := make([][]string, 0, len(src.classes))
	for _, c := range src.classes {
		retry := "No"
		if c.Retry != "" {
			retry = cell(upperFirst(c.Retry))
		}
		rows = append(rows, []string{"`" + strconv.Itoa(c.Exit) + "`", "`" + string(c.Class) + "`", cell(c.Summary), retry})
	}
	var b strings.Builder
	writeTable(&b, []string{"Exit code", "Class", "Meaning", "Retry"}, rows)
	return b.String()
}

// renderErrorCodes writes every registered error code with the exit code its class gives.
func renderErrorCodes(src source) string {
	rows := make([][]string, 0, len(src.codes))
	for _, c := range src.codes {
		rows = append(rows, []string{"`" + c.Code + "`", "`" + strconv.Itoa(src.exitOfCl[c.Class]) + "`", cell(c.Summary)})
	}
	var b strings.Builder
	writeTable(&b, []string{"Code", "Exit code", "Meaning"}, rows)
	return b.String()
}

// writeTable writes a GFM table.
func writeTable(b *strings.Builder, header []string, rows [][]string) {
	b.WriteString("| " + strings.Join(header, " | ") + " |\n")
	b.WriteString("|" + strings.Repeat(" --- |", len(header)) + "\n")
	for _, r := range rows {
		b.WriteString("| " + strings.Join(r, " | ") + " |\n")
	}
}

// cell makes a sentence safe inside an MDX table cell. Outside a code span, a pipe would end the
// cell, and `<` or `{` would open JSX or an expression; inside one they are literal and are left
// alone. A newline becomes a space, since a cell is one line.
func cell(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	var b strings.Builder
	inCode := false
	for _, r := range text {
		switch {
		case r == '`':
			inCode = !inCode
			b.WriteRune(r)
		case r == '|':
			b.WriteString(`\|`)
		case inCode:
			b.WriteRune(r)
		case r == '<':
			b.WriteString("&lt;")
		case r == '>':
			b.WriteString("&gt;")
		case r == '{':
			b.WriteString(`\{`)
		case r == '}':
			b.WriteString(`\}`)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// upperFirst capitalises the first letter of a phrase, leaving a phrase that starts with code as it
// is.
func upperFirst(s string) string {
	if s == "" || s[0] < 'a' || s[0] > 'z' {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
