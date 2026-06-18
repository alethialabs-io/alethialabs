// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package assets

import (
	"embed"
)

//go:embed all:terraform/seed
//go:embed all:helm/runner
var Assets embed.FS

// GetTerraformSeed returns the embedded filesystem for the seed terraform
func GetTerraformSeed() embed.FS {
	return Assets
}

// GetRunnerChart returns the embedded filesystem for the runner helm chart
func GetRunnerChart() embed.FS {
	return Assets
}
