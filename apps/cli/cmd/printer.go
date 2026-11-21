// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// The output seam of the CLI: who is reading (Mode), and where each kind of output goes (Printer).
//
// The rule the two of them hold is one sentence: STDOUT IS THE COMMAND'S DOCUMENT AND STDERR IS
// EVERYTHING SAID ABOUT IT. A result goes to Printer.Out, in the format the caller asked for; a
// note, a warning, a progress line or a queued-job notice goes to Printer.Err. A command that
// follows it can be piped into a parser in every format without the parser meeting a sentence.

// --- Mode ---

// Mode is who the invocation is talking to, resolved once before any command runs.
type Mode struct {
	// Agent reports that the caller is a program driving the CLI on a person's behalf. It implies
	// NoInput, turns Color off, and makes json the default output format.
	Agent bool
	// NoInput reports that nothing may prompt: --no-input, a stdin that is not a terminal, or
	// agent mode.
	NoInput bool
	// Color reports whether styled output is allowed. It is off under NO_COLOR, TERM=dumb and
	// agent mode; when it is on, the terminal library still decides per stream.
	Color bool
	// Debug reports that request diagnostics were asked for, with --debug or ALETHIA_DEBUG.
	Debug bool
}

// The environment variables that set a mode.
const (
	// AgentEnv forces agent mode on or off: yes, no or auto.
	AgentEnv = "ALETHIA_AGENT"
	// DebugEnv turns request diagnostics on when it names the "api" topic. It is the API client's
	// own switch, so the CLI and the client cannot disagree about its name.
	DebugEnv = api.DebugEnv
)

// agentMarkers are the environment variables an agent harness sets in the shells it spawns. Under
// the default `--agent auto`, any one of them set to a non-empty value selects agent mode.
//
// This is the whole list, and it lives nowhere else: TestAgentMarkers_EachOneSelectsAgentMode
// ranges over it, so an entry added here is detected and tested by being written.
var agentMarkers = []string{
	"AGENT",
	"AI_AGENT",
	"CLAUDECODE",
	"CODEX_SANDBOX",
	"CURSOR_AGENT",
}

// The values --agent and ALETHIA_AGENT accept.
const (
	agentYes  = "yes"
	agentNo   = "no"
	agentAuto = "auto"
)

// parseAgentSetting reads one spelling of the agent switch. Booleans are accepted beside the three
// words because an environment variable is most often written as 1 or true.
func parseAgentSetting(raw string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case agentYes, "true", "1", "on":
		return agentYes, true
	case agentNo, "false", "0", "off":
		return agentNo, true
	case agentAuto, "":
		return agentAuto, true
	}
	return "", false
}

// agentDetected reports whether the environment carries one of agentMarkers.
func agentDetected(lookup func(string) (string, bool)) bool {
	for _, name := range agentMarkers {
		if v, ok := lookup(name); ok && v != "" {
			return true
		}
	}
	return false
}

// resolveMode computes the Mode of one invocation from its flags and its environment.
//
// The agent switch is read in precedence order — the --agent flag, then ALETHIA_AGENT, then
// detection — and a value that is none of yes, no or auto is a usage error rather than a guess:
// the two wrong guesses are a person being handed json and an agent being handed a prompt.
func resolveMode(cmd *cobra.Command, lookup func(string) (string, bool)) (Mode, error) {
	setting := agentAuto
	if env, ok := lookup(AgentEnv); ok {
		parsed, valid := parseAgentSetting(env)
		if !valid {
			return Mode{}, clierr.New(clierr.CodeInvalidUsage,
				fmt.Sprintf("invalid %s %q (want yes, no, or auto)", AgentEnv, env))
		}
		setting = parsed
	}
	if flag := cmd.Flags().Lookup(shellFlagAgent); flag != nil && flag.Changed {
		parsed, valid := parseAgentSetting(flag.Value.String())
		if !valid {
			return Mode{}, clierr.New(clierr.CodeInvalidFlag,
				fmt.Sprintf("invalid --%s %q (want yes, no, or auto)", shellFlagAgent, flag.Value.String()))
		}
		setting = parsed
	}

	agent := setting == agentYes || (setting == agentAuto && agentDetected(lookup))
	noInput, _ := cmd.Flags().GetBool(shellKeyNoInput)
	debug, _ := cmd.Flags().GetBool(shellFlagDebug)
	debugEnv, _ := lookup(DebugEnv)

	return Mode{
		Agent:   agent,
		NoInput: agent || noInput || !stdinIsTTY(),
		Color:   !agent && !ui.ColorDisabledByEnv(lookup),
		Debug:   debug || api.DebugRequested(debugEnv),
	}, nil
}

// --- Printer ---

// Printer is the one writer a command reports through.
//
// Out carries the result and nothing else. Err carries what is said about the run. Format is the
// resolved --output value and Mode is who is reading. A Printer holds no other state, so a test or
// a tool handler builds one over its own buffers and gets every byte the command would have
// printed.
type Printer struct {
	Out    io.Writer
	Err    io.Writer
	Format string
	Mode   Mode
}

// stdoutStream and stderrStream write to whatever os.Stdout and os.Stderr are AT THE TIME OF THE
// WRITE. The process-wide Printer is built once, and holding the *os.File it saw then would pin it
// to a stream a later redirection has replaced.
type (
	stdoutStream struct{}
	stderrStream struct{}
)

// Write writes b to the current standard output.
func (stdoutStream) Write(b []byte) (int, error) { return os.Stdout.Write(b) }

// Write writes b to the current standard error.
func (stderrStream) Write(b []byte) (int, error) { return os.Stderr.Write(b) }

// newPrinter builds the process Printer for a resolved format and mode.
func newPrinter(format string, mode Mode) *Printer {
	return &Printer{Out: stdoutStream{}, Err: stderrStream{}, Format: format, Mode: mode}
}

// printer is the Printer of the running invocation. resolveInputMode rebuilds it in the root
// PersistentPreRun; the value below is what a command reached without that hook sees — the table
// format, colour on, and a mode nobody has narrowed.
var printer = newPrinter(ui.FormatTable, Mode{Color: true})

// errNoCSVForm is the answer to `--output csv` on a result that has no rows to offer.
var errNoCSVForm = clierr.New(clierr.CodeInvalidFlag,
	"this command has no csv form (want --output table or json)")

// Result writes a command's result on Out: v as json, v's rows as csv, or — for a person — whatever
// human writes. human may be nil for a result with nothing to say in a sentence.
//
// The three never mix: under json and csv human is not called at all, so a success sentence cannot
// land in a document.
func (p *Printer) Result(v any, human func(io.Writer)) error {
	switch p.Format {
	case ui.FormatJSON:
		return ui.RenderJSON(p.Out, v)
	case ui.FormatCSV:
		rows, ok := v.(ui.Tabular)
		if !ok {
			return errNoCSVForm
		}
		return ui.Render(p.Out, ui.FormatCSV, rows.Table(), v)
	}
	if human != nil {
		human(p.Out)
	}
	return nil
}

// Table writes a result set on Out in the Printer's format: the static table, the records as json,
// or the rows as csv.
func (p *Printer) Table(spec ui.TableSpec, records any) error {
	return ui.Render(p.Out, p.Format, spec, records)
}

// Note writes one muted line on Err: context a person may want and a parser must never meet.
func (p *Printer) Note(msg string) { ui.MutedTo(p.Err, msg) }

// Warn writes a warning on Err.
func (p *Printer) Warn(msg string) { ui.WarningTo(p.Err, msg) }

// Progress writes one line of progress on Err. For an agent it is the bare sentence; for a person
// it leads with the pointer glyph.
func (p *Printer) Progress(msg string) {
	if p.Mode.Agent {
		fmt.Fprintln(p.Err, msg)
		return
	}
	ui.MutedTo(p.Err, ui.SymbolPoint+" "+msg)
}

// JobQueued writes the queued-job notice on Err. The job id it names is also in the result.
func (p *Printer) JobQueued(jobType, jobID string) { ui.JobQueuedTo(p.Err, jobType, jobID) }

// Debugf writes one diagnostic line on Err when the invocation asked for them, and nothing
// otherwise.
func (p *Printer) Debugf(format string, args ...any) {
	if !p.Mode.Debug {
		return
	}
	fmt.Fprintf(p.Err, "debug: "+format+"\n", args...)
}

// applyDebugOutput points the API client's request log at the Printer's diagnostic stream when the
// invocation asked for diagnostics, and switches it off when it did not. The log goes to Err and
// never to Out, so a parser reading the result never meets it; the client itself withholds every
// header and query value that could carry a credential, and never writes a body.
//
// It is set on every invocation rather than once, so a run without --debug does not inherit the log
// of the run before it.
func applyDebugOutput(p *Printer) {
	if p.Mode.Debug {
		api.SetDebugOutput(p.Err)
		return
	}
	api.SetDebugOutput(nil)
}

// --- The mutation result ---

// ResultAction is what a mutating command did to its subject.
type ResultAction string

// The actions a mutation result can report.
const (
	ResultCreated   ResultAction = "created"
	ResultUpdated   ResultAction = "updated"
	ResultDeleted   ResultAction = "deleted"
	ResultQueued    ResultAction = "queued"
	ResultUnchanged ResultAction = "unchanged"
)

// JobRef names the job a mutation queued. It is clierr.Op, so the job in a result and the operation
// in an error are one shape.
type JobRef = clierr.Op

// MutationResult is the one shape every mutating command returns.
//
// Every key is always present: Job is null when nothing was queued, and Object is null when the
// command has no record to show. Documents and secrets — an exported manifest, a kubeconfig, a
// token — are not mutation results and keep their own stdout contract.
type MutationResult struct {
	// ID identifies the subject of the mutation.
	ID string `json:"id"`
	// Kind is the subject's type in the singular, for example "project".
	Kind string `json:"kind"`
	// Action is what happened to it.
	Action ResultAction `json:"action"`
	// Job is the job the command queued, or nil.
	Job *JobRef `json:"job"`
	// DryRun reports that nothing was changed.
	DryRun bool `json:"dry_run"`
	// Object is the subject as the control plane returned it, or nil.
	Object any `json:"object"`
}

// mutationResultColumns are the csv columns of a MutationResult. Object has no column: a nested
// record does not fit a cell, and json carries it whole.
var mutationResultColumns = []string{"id", "kind", "action", "job_id", "job_type", "dry_run"}

// Table returns the result as one csv row, with empty job cells when nothing was queued.
func (r MutationResult) Table() ui.TableSpec {
	jobID, jobType := "", ""
	if r.Job != nil {
		jobID, jobType = r.Job.ID, r.Job.Type
	}
	return ui.TableSpec{
		Columns: mutationResultColumns,
		Rows: [][]string{{
			r.ID, r.Kind, string(r.Action), jobID, jobType, strconv.FormatBool(r.DryRun),
		}},
	}
}
