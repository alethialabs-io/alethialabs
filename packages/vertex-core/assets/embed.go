// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package assets

import (
	"embed"
)

//go:embed all:terraform/seed
//go:embed all:helm/tendril
var Assets embed.FS

// GetTerraformSeed returns the embedded filesystem for the seed terraform
func GetTerraformSeed() embed.FS {
	return Assets
}

// GetTendrilChart returns the embedded filesystem for the tendril helm chart
func GetTendrilChart() embed.FS {
	return Assets
}
