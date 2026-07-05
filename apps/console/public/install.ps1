<#
  Alethia CLI installer (Windows / PowerShell).
  SPDX-License-Identifier: AGPL-3.0-only  ·  (c) 2026 Alethia Labs
  Source: https://github.com/alethialabs-io/alethialabs/blob/main/apps/console/public/install.ps1

  Usage:
    irm https://get.alethialabs.io/install.ps1 | iex
    $env:ALETHIA_VERSION="v0.2.0"; irm https://get.alethialabs.io/install.ps1 | iex   # pin

  Honors: ALETHIA_VERSION, ALETHIA_INSTALL_DIR, GITHUB_TOKEN/GH_TOKEN (private repo).
#>
$ErrorActionPreference = "Stop"

$Repo = "alethialabs-io/alethialabs"
$Bin  = "alethia"
$Gh   = "https://github.com/$Repo"
$Api  = "https://api.github.com/repos/$Repo"

$token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { $null }
$headers = @{ "User-Agent" = "alethia-installer" }
if ($token) { $headers["Authorization"] = "Bearer $token" }

# --- arch (match GoReleaser archive names) ---
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
	"AMD64" { "x86_64" }
	"ARM64" { "arm64" }
	default { throw "Unsupported architecture: $($env:PROCESSOR_ARCHITECTURE)" }
}
$asset = "${Bin}_Windows_${arch}.zip"

# --- resolve version (pinned env, else latest bare vX.Y.Z release) ---
if ($env:ALETHIA_VERSION) {
	$v = $env:ALETHIA_VERSION
	$tag = if ($v.StartsWith("cli-v")) { $v } elseif ($v.StartsWith("v")) { "cli-$v" } else { "cli-v$v" }
} else {
	Write-Host "Resolving latest alethia release..."
	$releases = Invoke-RestMethod -Headers $headers -Uri "$Api/releases?per_page=100"
	$latest = $releases.tag_name |
		Where-Object { $_ -match '^cli-v\d+\.\d+\.\d+$' } |
		ForEach-Object { [version]($_ -replace '^cli-v','') } |
		Sort-Object | Select-Object -Last 1
	if (-not $latest) { throw "Could not resolve the latest release (private repo? set GITHUB_TOKEN, or pin ALETHIA_VERSION)." }
	$tag = "cli-v$latest"
}

$base = "$Gh/releases/download/$tag"
$dir  = if ($env:ALETHIA_INSTALL_DIR) { $env:ALETHIA_INSTALL_DIR } else { "$env:LOCALAPPDATA\Alethia\bin" }
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ("alethia-" + [System.Guid]::NewGuid()))
try {
	Write-Host "Downloading $asset ($tag)..."
	Invoke-WebRequest -Headers $headers -Uri "$base/$asset"        -OutFile "$tmp\$asset"
	Invoke-WebRequest -Headers $headers -Uri "$base/checksums.txt" -OutFile "$tmp\checksums.txt"

	Write-Host "Verifying checksum..."
	$expected = (Get-Content "$tmp\checksums.txt" | Where-Object { $_ -match "\s$([regex]::Escape($asset))$" }) -split '\s+' | Select-Object -First 1
	if (-not $expected) { throw "No checksum entry for $asset" }
	$actual = (Get-FileHash -Algorithm SHA256 "$tmp\$asset").Hash
	if ($actual -ne $expected.ToUpper()) { throw "Checksum mismatch for $asset (expected $expected, got $actual)" }

	Expand-Archive -Force -Path "$tmp\$asset" -DestinationPath $tmp
	Copy-Item -Force -Path "$tmp\$Bin.exe" -Destination "$dir\$Bin.exe"
} finally {
	Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# --- add install dir to the user PATH if missing ---
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ';') -notcontains $dir) {
	[Environment]::SetEnvironmentVariable("Path", "$userPath;$dir", "User")
	$env:Path = "$env:Path;$dir"
	Write-Host "Added $dir to your user PATH (restart your shell to pick it up)."
}

Write-Host ""
Write-Host "OK Installed $Bin $tag to $dir\$Bin.exe"
Write-Host "Run: $Bin --version"
