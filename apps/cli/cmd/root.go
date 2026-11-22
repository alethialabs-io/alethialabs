// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/update"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

const (
	websiteURL                 = "https://alethialabs.io"
	docsURL                    = "https://alethialabs.io/docs"
	skipUpdateNoticeAnnotation = "alethia.io/skip-update-notice"
)

func init() {
	rootCmd.Version = version.Version
	// Every request the API client sends names this build, in its User-Agent and in
	// X-Alethia-CLI-Version, so the control plane can tell which CLI is asking.
	api.SetCLIVersion(version.Version)
	// The four flags every command in the tree inherits, registered from the ONE place they are
	// described. Their usage strings, their defaults and the rows the docs tables carry for them
	// all come from shellFields — see shell_fields.go for why a global is the value most likely to
	// drift, and hyg_cli_shellform_test.go for what holds the renderings together.
	registerShellGlobalFlags(rootCmd)
	// A flag cobra cannot parse is a usage error with its own code. Set on the root, inherited by
	// every subcommand.
	rootCmd.SetFlagErrorFunc(flagError)
}

var rootCmd = &cobra.Command{
	Use:   "alethia",
	Short: "alethia — multi-cloud Kubernetes control plane, from the terminal",
	Long:  rootLong(),
	// Resolves the input mode (--no-input / non-TTY stdin), the API client's request log (--debug)
	// and the org scope (--org) before any subcommand runs, so the interactive selectors know
	// whether prompting is allowed and every request the command makes names the same organization.
	//
	// This is the ONLY PersistentPreRun in the tree, and that is load-bearing rather than
	// incidental: cobra runs the nearest one and no others, so a subcommand growing its own would
	// silently stop resolving both. hyg_cli_orgscope_test.go asserts it.
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		errorFormat = rootOutputFormat(cmd)
		resolveInputMode(cmd)
		applyDebugOutput(printer)
		applyOrgScope()
	},
	// Runs after any subcommand that doesn't override it — surfaces the upgrade
	// notice once per day without ever blocking the command.
	PersistentPostRun: func(cmd *cobra.Command, args []string) {
		if cmd.Annotations != nil && cmd.Annotations[skipUpdateNoticeAnnotation] == "true" {
			return
		}
		// The notice is a sentence for a person, so agent mode does not print it.
		if printer.Mode.Agent {
			return
		}
		checkForUpdate(version.Version, WebOrigin())
	},
	// The fatal path prints every error once, on stderr, in the form the caller asked for. Left
	// unset, cobra prints the same error a second time itself and follows it with the whole usage
	// text.
	SilenceErrors: true,
	SilenceUsage:  true,
	Run: func(cmd *cobra.Command, args []string) {
		printBanner()
		fmt.Println()
		cmd.Help()
	},
}

// checkForUpdate prints the once-a-day upgrade notice. It is a variable so a test can see whether
// the root's post-run hook reached it.
var checkForUpdate = update.CheckAndNotify

// rootLong is the root command's long description. The clouds it names are the ones this build
// offers (capabilities.go), so the sentence cannot fall behind the list.
func rootLong() string {
	return "alethia is the command-line interface to the Alethia control plane.\n" +
		"Configure infrastructure visually, then plan, deploy, and tear it down across\n" +
		enabledCloudList() + " from the terminal."
}

// printBanner renders the grayscale Alethia lockup shown for a bare `alethia`.
func printBanner() {
	ver := version.Version

	fmt.Println()
	fmt.Printf("  %s %s   %s\n",
		ui.RenderMark(),
		ui.StrongStyle.Render("alethia"),
		ui.Eyebrow("control plane"),
	)
	fmt.Printf("  %s\n", ui.SecondaryStyle.Render("Configure infrastructure visually. Deploy from the terminal."))
	fmt.Println()

	row := func(label, value string) {
		fmt.Printf("  %s  %s\n", ui.MutedStyle.Render(fmt.Sprintf("%-9s", label)), value)
	}
	row("version", ui.TextStyle.Render(ver))
	row("website", ui.LinkStyle.Render(websiteURL))
	row("docs", ui.LinkStyle.Render(docsURL))
}

// WebOrigin returns the Alethia control-plane URL, resolved as
// ALETHIA_WEB_ORIGIN env > persisted config > the hosted default. Prod needs no
// setup; self-host/dev override it via `alethia config set web-origin` or the env.
func WebOrigin() string {
	origin, _ := types.ResolveWebOrigin()
	return origin
}

// rootOutputFormat returns the value of the root's persistent --output flag as cmd sees it. A
// subcommand that declares its own --output shadows the name, and the root's flag then keeps its
// default.
func rootOutputFormat(cmd *cobra.Command) string {
	return cmd.Root().PersistentFlags().Lookup(mustShellField("alethia", shellKeyOutput).Flag).Value.String()
}

// commandLine returns the arguments the process was started with, without the program name. It is
// a variable so a test that points the tree at its own arguments points this at the same ones.
var commandLine = func() []string { return os.Args[1:] }

// refusalFormat returns the --output value a refusal from cobra is rendered in. The fatal path
// writes an envelope for json and the form a person reads for anything else.
//
// A refusal — an unknown command, a flag cobra cannot parse — ends parsing where it happens. An
// unknown command is refused before any flag is read, and a rejected flag hides every flag after
// it. So what cobra parsed is not the whole answer, and the command line is read a second time
// here, for the flags that decide who is reading: --output, --agent and the two other flags
// resolveMode looks at. A flag this scan does not know is skipped, not refused, which is what lets
// it read past the one cobra stopped at.
//
// The order is the one a command that runs follows (output.go): a valid --output wins, wherever it
// stands on the line; with none, an agent reads json; otherwise the answer is for a person.
func refusalFormat(args []string) string {
	scan := &cobra.Command{Use: rootCmd.Name()}
	flags := scan.Flags()
	flags.ParseErrorsAllowlist.UnknownFlags = true
	flags.SetOutput(io.Discard)

	out := mustShellField("alethia", shellKeyOutput)
	flags.StringP(out.Flag, out.Shorthand, out.Default, "")
	flags.String(shellFlagAgent, agentAuto, "")
	flags.Bool(shellKeyNoInput, false, "")
	flags.Bool(shellFlagDebug, false, "")
	// The error is the scan's own refusal of a value it could not read. Whatever it read before
	// that still counts, and the refusal being reported is cobra's.
	_ = flags.Parse(args)

	// What cobra itself parsed before it refused is the stronger reading of the same line.
	for _, name := range []string{out.Flag, shellFlagAgent} {
		if parsed := rootCmd.PersistentFlags().Lookup(name); parsed.Changed {
			_ = flags.Set(name, parsed.Value.String())
		}
	}

	if given := flags.Lookup(out.Flag); given.Changed && ui.ValidFormat(given.Value.String()) {
		return given.Value.String()
	}
	if mode, err := resolveMode(scan, lookupEnv); err == nil && mode.Agent {
		return ui.FormatJSON
	}
	return ui.FormatTable
}

// Execute applies the command registry to the tree, runs it, and reports an error cobra returned on
// the fatal path.
func Execute() {
	applyCommandMeta()
	if err := rootCmd.Execute(); err != nil {
		// A refusal from cobra never reaches PersistentPreRun, so the format is read here.
		errorFormat = refusalFormat(commandLine())
		fail(usageError(err))
	}
}
