// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package infracost

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

var (
	httpGet        = http.Get
	executeCommand = utils.ExecuteCommand
)

// InfracostCLI represents the Infracost CLI wrapper.
type InfracostCLI struct {
	Version    string
	binaryPath string
	apiKey     string
}

// NewInfracostCLI creates a new Infracost CLI wrapper.
func NewInfracostCLI(version string, apiKey string) *InfracostCLI {
	return &InfracostCLI{
		Version: version,
		apiKey:  apiKey,
	}
}

// CheckToken verifies if the Infracost API token is set.
func (i *InfracostCLI) CheckToken() bool {
	if i.apiKey == "" {
		fmt.Println("Warning: Infracost token not provided. Skipping cost estimation.")
		fmt.Println("To include Infracost, set the INFRACOST_API_KEY environment variable.")
		return false
	}
	return true
}

// ensureBinary checks if the Infracost binary exists and downloads it if not.
func (i *InfracostCLI) ensureBinary() error {
	binDir := "bin"
	absBinDir, err := filepath.Abs(binDir)
	if err != nil {
		return fmt.Errorf("failed to get absolute path for bin directory: %w", err)
	}

	i.binaryPath = filepath.Join(absBinDir, fmt.Sprintf("infracost_%s", i.Version))
	if _, err := os.Stat(i.binaryPath); err == nil {
		fmt.Printf("Infracost %s is already available.\n", i.Version)
		return nil
	}

	// Create bin directory if it doesn't exist
	if err := os.MkdirAll(absBinDir, 0755); err != nil {
		return fmt.Errorf("failed to create bin directory: %w", err)
	}

	return i.download(absBinDir)
}

func (i *InfracostCLI) download(binDir string) error {
	arch := runtime.GOARCH
	goos := runtime.GOOS

	downloadURL := fmt.Sprintf("https://github.com/infracost/infracost/releases/download/%s/infracost-%s-%s.tar.gz", i.Version, goos, arch)
	fmt.Printf("Downloading Infracost %s for %s-%s...\n", i.Version, goos, arch)

	resp, err := httpGet(downloadURL)
	if err != nil {
		return fmt.Errorf("failed to download infracost: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to download infracost: status code %d", resp.StatusCode)
	}

	tarFile := filepath.Join(binDir, fmt.Sprintf("infracost_%s.tar.gz", i.Version))
	out, err := os.Create(tarFile)
	if err != nil {
		return fmt.Errorf("failed to create tar file: %w", err)
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	if err != nil {
		return fmt.Errorf("failed to write tar file: %w", err)
	}

	// Extract the tar.gz file
	f, err := os.Open(tarFile)
	if err != nil {
		return fmt.Errorf("failed to open tar file: %w", err)
	}
	defer f.Close()

	gzReader, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("failed to create gzip reader: %w", err)
	}
	defer gzReader.Close()

	tarReader := tar.NewReader(gzReader)

	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break // End of archive
		}
		if err != nil {
			return fmt.Errorf("failed to read tar header: %w", err)
		}

		if header.Typeflag == tar.TypeReg && strings.Contains(header.Name, "infracost") {
			outPath := filepath.Join(binDir, "infracost")
			outFile, err := os.Create(outPath)
			if err != nil {
				return fmt.Errorf("failed to create infracost binary: %w", err)
			}
			defer outFile.Close()

			_, err = io.Copy(outFile, tarReader)
			if err != nil {
				return fmt.Errorf("failed to write infracost binary: %w", err)
			}

			i.binaryPath = outPath // Update binaryPath to the extracted path
			break
		}
	}

	// Make executable
	if err := os.Chmod(i.binaryPath, 0755); err != nil {
		return fmt.Errorf("failed to make infracost binary executable: %w", err)
	}

	// Clean up tar.gz file
	if err := os.Remove(tarFile); err != nil {
		fmt.Printf("Warning: failed to remove tar.gz file %s: %v\n", tarFile, err)
	}

	fmt.Println("Infracost downloaded and extracted successfully.")
	return nil
}

// RunInfracost executes infracost breakdown and returns structured cost data.
// Also writes the JSON and table files to temp/ for backward compatibility.
func (i *InfracostCLI) RunInfracost(planFile string, env []string) (*CostBreakdown, error) {
	if !i.CheckToken() {
		return nil, nil
	}

	fmt.Println("Running Infracost cost estimation...")

	if err := i.ensureBinary(); err != nil {
		return nil, fmt.Errorf("failed to ensure infracost binary: %w", err)
	}

	tempDir := "temp"
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create temp directory: %w", err)
	}
	breakdownJSONPath := filepath.Join(tempDir, "infracost_breakdown.json")

	breakdownCmd := fmt.Sprintf("%s breakdown --path %s --format json --out-file %s", i.binaryPath, planFile, breakdownJSONPath)
	if err := executeCommand(breakdownCmd, ".", env, nil, nil); err != nil {
		return nil, fmt.Errorf("infracost breakdown failed: %w", err)
	}

	data, err := os.ReadFile(breakdownJSONPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read infracost output: %w", err)
	}

	breakdown, err := ParseCostBreakdown(data)
	if err != nil {
		return nil, err
	}

	if breakdown.Summary != nil {
		fmt.Printf("Cost Summary — Monthly: $%.2f, Diff: $%.2f (%d resources with cost, %d free)\n",
			breakdown.Summary.TotalMonthly,
			breakdown.Summary.DiffMonthly,
			breakdown.Summary.ResourcesWithCost,
			breakdown.Summary.ResourcesFree,
		)
	}

	return breakdown, nil
}
