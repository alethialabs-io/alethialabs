// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The BYO (bring-your-own) WRITE commands: attach, detach and scan your own Helm charts and your own
// Terraform/OpenTofu source. Both surfaces were read-only from the CLI — you could see what was
// attached and never attach anything — so a repeatable or CI-driven flow had to stop at the console
// exactly where the customer's own code enters the picture.

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	chartAttachRepo       string
	chartAttachPath       string
	chartAttachRef        string
	chartAttachNamespace  string
	chartAttachValuesFile string
	chartAttachGitCred    string
	chartAttachSet        []string
	chartDetachYes        bool

	iacAttachRepo    string
	iacAttachRef     string
	iacAttachPath    string
	iacAttachGitCred string
	iacAttachVar     []string
	iacDetachYes     bool
)

// readChartValuesFile reads the raw Helm-values override, or returns "" when no file was named. The
// content is NOT parsed here: the server validates it as a YAML mapping through the same action the
// console uses, so a local pre-parse would be a second opinion that can disagree with the one that
// decides.
func readChartValuesFile(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read --values-file: %w", err)
	}
	return string(raw), nil
}

// --- charts ---

var chartAttachCmd = &cobra.Command{
	Use:   "attach <id>",
	Short: "Attach (or update) your own Helm chart in an environment",
	Args:  cobra.ExactArgs(1),
	Long: `Attaches a chart from your own repository — git or OCI — to one environment.

  git:  --repo https://github.com/acme/charts --chart-path charts/api
  OCI:  --repo oci://registry.example.com/acme/api

A git chart needs --chart-path; an OCI chart is named by the URL's last segment and does not.
The chart is not deployable until it has been scanned — run "alethia chart scan <id>" next.

Re-attaching the same id UPDATES it, so this is also how you move a chart to a new ref.`,
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
		values, err := parseSetValues(chartAttachSet)
		if err != nil {
			fail(err)
		}
		valuesYAML, err := readChartValuesFile(chartAttachValuesFile)
		if err != nil {
			fail(err)
		}
		if err := runChartAttach(api.NewClient(token), os.Stdout, api.AttachChartParams{
			Project: project, Env: env, ID: args[0],
			RepoURL: chartAttachRepo, ChartPath: chartAttachPath, Ref: chartAttachRef,
			Namespace: chartAttachNamespace, ValuesYAML: valuesYAML,
			GitCredID: chartAttachGitCred, Values: values,
		}); err != nil {
			failf("Failed to attach chart: %v", err)
		}
	},
}

// runChartAttach attaches the chart and confirms it, echoing the id the SERVER stored — it slugifies
// what you send, and the next command you run needs the stored one.
func runChartAttach(c apiClient, out io.Writer, p api.AttachChartParams) error {
	if p.ID == "" || p.RepoURL == "" {
		return fmt.Errorf("a chart id and --repo are both required")
	}
	res, err := c.AttachChart(p)
	if err != nil {
		return err
	}
	id := p.ID
	if res != nil && res.ID != "" {
		id = res.ID
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Attached chart %s%s", id, envSuffix(p.Env))))
	fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("Scan it before deploying: alethia chart scan %s", id)))
	return nil
}

var chartDetachCmd = &cobra.Command{
	Use:   "detach <id>",
	Short: "Detach your own Helm chart from an environment",
	Args:  cobra.ExactArgs(1),
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
		if !confirmDestructive(chartDetachYes, "Detach this chart?",
			"Its workloads are removed from the cluster on the next sync.") {
			return
		}
		if err := runChartDetach(api.NewClient(token), os.Stdout, project, env, args[0]); err != nil {
			failf("Failed to detach chart: %v", err)
		}
	},
}

// runChartDetach detaches the chart and confirms it.
func runChartDetach(c apiClient, out io.Writer, project, env, id string) error {
	if id == "" {
		return fmt.Errorf("a chart id is required")
	}
	if err := c.DetachChart(project, env, id); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Detached chart %s%s", id, envSuffix(env))))
	return nil
}

var chartScanCmd = &cobra.Command{
	Use:   "scan <id>",
	Short: "Scan an attached chart so it can be deployed",
	Args:  cobra.ExactArgs(1),
	Long: `Queues a scan of an attached chart. The scan renders it and records the verdict the
plan-time gate reads, so an unscanned chart is refused at deploy.

Re-scan whenever the chart's repository moves. The printed job id follows with
"alethia jobs logs <id> --follow".`,
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
		if err := runChartScan(api.NewClient(token), os.Stdout, project, env, args[0]); err != nil {
			failf("Failed to scan chart: %v", err)
		}
	},
}

// runChartScan queues the scan and prints the job to follow.
func runChartScan(c apiClient, out io.Writer, project, env, id string) error {
	if id == "" {
		return fmt.Errorf("a chart id is required")
	}
	res, err := c.ScanChart(project, env, id)
	if err != nil {
		return err
	}
	printScanQueued(out, "chart "+id, env, res)
	return nil
}

// --- IaC ---

var iacAttachCmd = &cobra.Command{
	Use:   "attach",
	Short: "Attach your own Terraform/OpenTofu source to an environment",
	Long: `Attaches a git repository holding your own Terraform/OpenTofu to one environment.

  alethia iac attach -p shop -e dev --repo https://github.com/acme/infra --path iac/drift/aws

An environment holds at most ONE source, so re-attaching replaces it. --var sets scalar tfvars
(string, number or bool only — never a secret; the server refuses anything nested).

The source is not deployable until scanned: run "alethia iac scan" next.`,
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
		vars, err := parseSetValues(iacAttachVar)
		if err != nil {
			fail(err)
		}
		if err := runIacAttach(api.NewClient(token), os.Stdout, api.AttachIacParams{
			Project: project, Env: env, RepoURL: iacAttachRepo, Ref: iacAttachRef,
			Path: iacAttachPath, GitCredID: iacAttachGitCred, VarValues: vars,
		}); err != nil {
			failf("Failed to attach IaC source: %v", err)
		}
	},
}

// runIacAttach attaches the source and confirms it.
func runIacAttach(c apiClient, out io.Writer, p api.AttachIacParams) error {
	if p.RepoURL == "" {
		return fmt.Errorf("--repo is required")
	}
	if _, err := c.AttachIac(p); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Attached IaC source %s%s", p.RepoURL, envSuffix(p.Env))))
	fmt.Fprintln(out, ui.MutedStyle.Render("Scan it before deploying: alethia iac scan"))
	return nil
}

var iacDetachCmd = &cobra.Command{
	Use:   "detach",
	Short: "Detach the environment's Terraform/OpenTofu source",
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
		if !confirmDestructive(iacDetachYes, "Detach this IaC source?",
			"Alethia stops managing what it created. Resources it applied are NOT destroyed — run a destroy first if that is what you want.") {
			return
		}
		if err := runIacDetach(api.NewClient(token), os.Stdout, project, env); err != nil {
			failf("Failed to detach IaC source: %v", err)
		}
	},
}

// runIacDetach detaches the source and confirms it.
func runIacDetach(c apiClient, out io.Writer, project, env string) error {
	if err := c.DetachIac(project, env); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Detached the IaC source"+envSuffix(env)))
	return nil
}

var iacScanCmd = &cobra.Command{
	Use:   "scan",
	Short: "Scan the environment's IaC source so it can be deployed",
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
		if err := runIacScan(api.NewClient(token), os.Stdout, project, env); err != nil {
			failf("Failed to scan IaC source: %v", err)
		}
	},
}

// runIacScan queues the scan and prints the job to follow.
func runIacScan(c apiClient, out io.Writer, project, env string) error {
	res, err := c.ScanIac(project, env)
	if err != nil {
		return err
	}
	printScanQueued(out, "IaC source", env, res)
	return nil
}

// printScanQueued reports a queued scan and the command that follows it. A scan is asynchronous, so
// the job id is the useful part of the output — without it a caller has to go looking.
func printScanQueued(out io.Writer, what, env string, res *api.ByoScanResult) {
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Queued a scan of the %s%s", what, envSuffix(env))))
	if res != nil && res.JobID != "" {
		fmt.Fprintf(out, "Job ID: %s\n", res.JobID)
		fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("Follow it: alethia jobs logs %s --follow", res.JobID)))
	}
}

func init() {
	chartAttachCmd.Flags().StringVar(&chartAttachRepo, "repo", "", "Chart repository URL — https://, git@… or oci://… (required)")
	chartAttachCmd.Flags().StringVar(&chartAttachPath, "chart-path", "", "Path to the chart within a git repo (required for git, ignored for OCI)")
	chartAttachCmd.Flags().StringVar(&chartAttachRef, "ref", "", "Git ref (branch, tag or SHA)")
	chartAttachCmd.Flags().StringVar(&chartAttachNamespace, "namespace", "", "Destination namespace")
	chartAttachCmd.Flags().StringVar(&chartAttachValuesFile, "values-file", "", "Path to a raw Helm values YAML override")
	chartAttachCmd.Flags().StringVar(&chartAttachGitCred, "git-credential-id", "", "Git credential for a private repository")
	chartAttachCmd.Flags().StringArrayVar(&chartAttachSet, "set", nil, "Chart value key=value (repeatable)")
	addYesFlag(chartDetachCmd, &chartDetachYes)
	chartCmd.AddCommand(chartAttachCmd, chartDetachCmd, chartScanCmd)

	iacAttachCmd.Flags().StringVar(&iacAttachRepo, "repo", "", "Git repository URL (required)")
	iacAttachCmd.Flags().StringVar(&iacAttachRef, "ref", "", "Git ref (branch, tag or SHA)")
	iacAttachCmd.Flags().StringVar(&iacAttachPath, "path", "", "Path to the module within the repo")
	iacAttachCmd.Flags().StringVar(&iacAttachGitCred, "git-credential-id", "", "Git credential for a private repository")
	iacAttachCmd.Flags().StringArrayVar(&iacAttachVar, "var", nil, "Scalar tfvar key=value (repeatable; never a secret)")
	addYesFlag(iacDetachCmd, &iacDetachYes)
	iacCmd.AddCommand(iacAttachCmd, iacDetachCmd, iacScanCmd)
}
