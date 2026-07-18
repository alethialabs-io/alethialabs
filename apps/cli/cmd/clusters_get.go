// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// The ArgoCD admin password is never stored by Alethia (it would be plaintext in the
// control-plane DB); it is retrieved on demand from the cluster's initial-admin secret.
// The console surfaces this same command — the CLI mirrors it so access is keyless from
// either surface.
const argocdAdminPasswordCmd = "kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"

var clusterGetCmd = &cobra.Command{
	Use:   "get <project>",
	Short: "Get a project's cluster, including ArgoCD access",
	Long: `Show a single project's cluster: status, node sizing, region, cost, and its
ArgoCD (cluster-side GitOps) endpoint plus the command to retrieve the admin password.
Matches by project name, cluster name, or id.`,
	Args: cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		query := args[0]

		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		var clusters []api.ClusterSummary
		ui.RunSpinner("Fetching cluster...", func() {
			clusters, err = apiClient.GetClusters()
		})
		if err != nil {
			failf("Failed to fetch clusters: %v", err)
		}

		c := findCluster(clusters, query)
		if c == nil {
			ui.Muted(fmt.Sprintf("No cluster found for project: %s", query))
			return
		}

		if err := renderCluster(os.Stdout, outputFormat(cmd), c); err != nil {
			fail(err)
		}
	},
}

// findCluster matches a cluster by project name, cluster name, or id (case-insensitive),
// preferring an exact match and falling back to a project-name substring.
func findCluster(clusters []api.ClusterSummary, query string) *api.ClusterSummary {
	q := strings.ToLower(strings.TrimSpace(query))
	for i := range clusters {
		if strings.ToLower(clusters[i].ProjectName) == q ||
			strings.ToLower(clusters[i].ClusterName) == q ||
			strings.ToLower(clusters[i].ID) == q {
			return &clusters[i]
		}
	}
	for i := range clusters {
		if q != "" && strings.Contains(strings.ToLower(clusters[i].ProjectName), q) {
			return &clusters[i]
		}
	}
	return nil
}

// renderCluster writes a single cluster to out: a bordered KV card for table format,
// the typed object for json, Field/Value rows for csv.
func renderCluster(out io.Writer, format string, c *api.ClusterSummary) error {
	title := c.ProjectName
	if c.Environment != "" {
		title += " (" + c.Environment + ")"
	}
	return ui.RenderCard(out, format, title, clusterFieldRows(c), c)
}

// clusterFieldRows returns the present-only key/value fields of a cluster, ending with
// the ArgoCD access block when the cluster is provisioned.
func clusterFieldRows(c *api.ClusterSummary) [][]string {
	rows := [][]string{
		{"Status", fmt.Sprintf("%s %s", ui.PlainStatusDot(c.Status), strings.ToLower(c.Status))},
	}
	if c.StatusMessage != "" {
		rows = append(rows, []string{"Message", c.StatusMessage})
	}
	if c.ClusterName != "" {
		rows = append(rows, []string{"Cluster", c.ClusterName})
	}
	if c.ClusterVersion != "" {
		rows = append(rows, []string{"Version", "K8s " + c.ClusterVersion})
	}
	if c.Region != "" {
		rows = append(rows, []string{"Region", c.Region})
	}
	rows = append(rows, []string{"Nodes", fmt.Sprintf("%d / %d / %d  (min/desired/max)", c.NodeMinSize, c.NodeDesiredSize, c.NodeMaxSize)})
	if c.EstimatedMonthlyCost != nil {
		rows = append(rows, []string{"Est. cost", fmt.Sprintf("$%.0f/mo", *c.EstimatedMonthlyCost)})
	}

	// ArgoCD — the cluster-side GitOps CD, installed on every provisioned cluster. The URL
	// only materialises where a managed ingress exists (AWS ALB+ACM today); elsewhere access
	// is via port-forward. The admin password is retrieved on demand (never stored).
	if c.ClusterName != "" {
		if c.ArgocdURL != "" {
			rows = append(rows, []string{"ArgoCD", c.ArgocdURL})
		} else {
			rows = append(rows, []string{"ArgoCD", "installed — port-forward (no managed ingress on this cloud yet)"})
		}
		rows = append(rows, []string{"ArgoCD admin", argocdAdminPasswordCmd})
	}
	return rows
}

func init() {
	clusterCmd.AddCommand(clusterGetCmd)
}
