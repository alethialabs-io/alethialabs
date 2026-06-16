// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/template"
)

func RenderApplications(templatesDir string, facts *InfraFacts) (string, error) {
	outDir, err := os.MkdirTemp("", "argocd-apps-*")
	if err != nil {
		return "", fmt.Errorf("failed to create temp dir: %w", err)
	}

	entries, err := os.ReadDir(templatesDir)
	if err != nil {
		return "", fmt.Errorf("failed to read templates dir: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".yaml") {
			continue
		}

		srcPath := filepath.Join(templatesDir, entry.Name())
		content, err := os.ReadFile(srcPath)
		if err != nil {
			return "", fmt.Errorf("failed to read %s: %w", entry.Name(), err)
		}

		tmpl, err := template.New(entry.Name()).Parse(string(content))
		if err != nil {
			return "", fmt.Errorf("failed to parse template %s: %w", entry.Name(), err)
		}

		var buf bytes.Buffer
		if err := tmpl.Execute(&buf, facts); err != nil {
			return "", fmt.Errorf("failed to render %s: %w", entry.Name(), err)
		}

		rendered := strings.TrimSpace(buf.String())
		if rendered == "" {
			continue
		}

		dstPath := filepath.Join(outDir, entry.Name())
		if err := os.WriteFile(dstPath, []byte(rendered+"\n"), 0644); err != nil {
			return "", fmt.Errorf("failed to write %s: %w", entry.Name(), err)
		}
	}

	return outDir, nil
}
