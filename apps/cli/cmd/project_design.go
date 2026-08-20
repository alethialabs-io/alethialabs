// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	designApplyFile   string
	designApplyDryRun bool
	designApplyStage  bool
)

var projectDesignCmd = &cobra.Command{
	Use:   "design",
	Short: "Apply a whole environment design document",
	Long: `The declarative counterpart to "project component add".

The imperative commands are what you narrate one step at a time; a design document is what a
repository commits and CI replays. Both write the same tables.

  alethia config export -p shop > shop.json      # the document, as it is now
  alethia project design apply -f shop.json --dry-run
  alethia project design apply -f shop.json`,
}

var projectDesignApplyCmd = &cobra.Command{
	Use:   "apply",
	Short: "Apply a design document to an environment",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := currentProject(cmd)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		doc, err := readDesignDocument(designApplyFile, os.Stdin)
		if err != nil {
			fail(err)
		}
		if designApplyDryRun && designApplyStage {
			failf("--dry-run and --stage are mutually exclusive: one writes nothing, the other writes to the review tray")
		}
		if err := runDesignApply(api.NewClient(token), os.Stdout, api.ApplyDesignParams{
			Project: project, Env: env, Document: doc,
			DryRun: designApplyDryRun, Stage: designApplyStage,
		}); err != nil {
			failf("Failed to apply the design: %v", err)
		}
	},
}

// readDesignDocument reads the document from a file, or from stdin when the path is "-". It checks the
// bytes are JSON but does NOT validate the SHAPE: the server validates that with the console form's own
// schema, and a second opinion here could disagree with the one that decides.
func readDesignDocument(path string, stdin io.Reader) (json.RawMessage, error) {
	if path == "" {
		return nil, fmt.Errorf("-f is required (a path, or - for stdin)")
	}
	var raw []byte
	var err error
	if path == "-" {
		raw, err = io.ReadAll(stdin)
	} else {
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, fmt.Errorf("read the design document: %w", err)
	}
	if !json.Valid(raw) {
		return nil, fmt.Errorf("%s is not valid JSON — `alethia config export` emits the shape this expects", path)
	}
	return json.RawMessage(raw), nil
}

// runDesignApply applies the document and reports what happened. On a dry run it prints the plan, which
// is the whole point of the mode: nothing was written, so the rows ARE the output.
func runDesignApply(c apiClient, out io.Writer, p api.ApplyDesignParams) error {
	if len(p.Document) == 0 {
		return fmt.Errorf("the design document is empty")
	}
	res, err := c.ApplyDesign(p)
	if err != nil {
		return err
	}
	if res == nil {
		return fmt.Errorf("the server returned no result")
	}

	switch res.Mode {
	case "dry-run":
		if len(res.Changes) == 0 {
			fmt.Fprintln(out, ui.FormatSuccess("No changes — the environment already matches this document"))
			return nil
		}
		fmt.Fprintf(out, "%d change(s) would be made%s:\n", len(res.Changes), envSuffix(p.Env))
		for _, ch := range res.Changes {
			name := ""
			if ch.Name != nil && *ch.Name != "" {
				name = " " + *ch.Name
			}
			fmt.Fprintf(out, "  %-7s %s%s\n", ch.Action, ch.Kind, name)
		}
		fmt.Fprintln(out, ui.MutedStyle.Render("Nothing was written. Re-run without --dry-run to apply."))
	case "staged":
		fmt.Fprintln(out, ui.FormatSuccess("Staged the design"+envSuffix(p.Env)))
		fmt.Fprintln(out, ui.MutedStyle.Render("Review and apply it from the staged-changes tray."))
	default:
		fmt.Fprintln(out, ui.FormatSuccess("Applied the design"+envSuffix(p.Env)))
		fmt.Fprintln(out, ui.MutedStyle.Render("It reaches the cloud on the next plan + apply."))
	}
	return nil
}

func init() {
	projectDesignApplyCmd.Flags().StringVarP(&designApplyFile, "file", "f", "", "Design document path, or - for stdin (required)")
	projectDesignApplyCmd.Flags().BoolVar(&designApplyDryRun, "dry-run", false, "Print the changes that would be made and write nothing")
	projectDesignApplyCmd.Flags().BoolVar(&designApplyStage, "stage", false, "Stage the change for review instead of applying it")
	projectDesignCmd.PersistentFlags().StringP("project", "p", "", "Project name or id")
	projectDesignCmd.PersistentFlags().StringP("env", "e", "", "Environment name, stage, or id (default: the project's default environment)")
	projectDesignCmd.AddCommand(projectDesignApplyCmd)
	projectCmd.AddCommand(projectDesignCmd)
}
