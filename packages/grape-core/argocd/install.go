package argocd

import (
	"fmt"
	"io"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/utils"
)

func ApplyApplications(renderedDir string, stdout, stderr io.Writer) error {
	cmd := fmt.Sprintf("kubectl apply -f %s", renderedDir)
	fmt.Fprintln(stdout, "Applying ArgoCD infrastructure applications...")
	if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("kubectl apply failed: %w", err)
	}
	fmt.Fprintln(stdout, "ArgoCD infrastructure applications applied.")
	return nil
}
