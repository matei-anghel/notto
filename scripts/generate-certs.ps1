# Self-Signed Windows Certificate Generator
# Run this on Windows to create a PFX certificate for code signing

param(
    [string]$CertName = "Notto Code Signing",
    [string]$OutputPath = "build\certs",
    [string]$Password = "notto-dev-cert"
)

# Create output directory
if (-not (Test-Path $OutputPath)) {
    New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
    Write-Host "Created directory: $OutputPath" -ForegroundColor Green
}

$CertPath = Join-Path $OutputPath "windows-self-signed.pfx"

# Check if certificate already exists
if (Test-Path $CertPath) {
    $overwrite = Read-Host "Certificate already exists. Overwrite? (y/N)"
    if ($overwrite -ne "y" -and $overwrite -ne "Y") {
        Write-Host "Aborted." -ForegroundColor Yellow
        exit
    }
}

Write-Host "`nGenerating self-signed certificate..." -ForegroundColor Cyan

# Create the certificate
$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=$CertName" `
    -KeyExportPolicy Exportable `
    -KeySpec Signature `
    -KeyLength 2048 `
    -KeyAlgorithm RSA `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(5) `
    -CertStoreLocation "Cert:\CurrentUser\My"

Write-Host "Certificate created with thumbprint: $($cert.Thumbprint)" -ForegroundColor Green

# Export to PFX
$securePassword = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $CertPath -Password $securePassword | Out-Null

Write-Host "Certificate exported to: $CertPath" -ForegroundColor Green

# Generate Base64 for GitHub Secrets
$base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($CertPath))

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "GITHUB SECRETS SETUP" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "`nAdd these secrets to your GitHub repository:" -ForegroundColor Yellow
Write-Host "(Settings > Secrets and variables > Actions > New repository secret)`n"

Write-Host "1. Secret Name: WIN_CERT_PFX_BASE64" -ForegroundColor White
Write-Host "   Value: (see base64.txt file)`n"

Write-Host "2. Secret Name: WIN_CERT_PASSWORD" -ForegroundColor White
Write-Host "   Value: $Password`n"

# Save base64 to file (easier to copy)
$base64Path = Join-Path $OutputPath "base64.txt"
$base64 | Out-File -FilePath $base64Path -NoNewline
Write-Host "Base64 certificate saved to: $base64Path" -ForegroundColor Green
Write-Host "(Copy the contents of this file to WIN_CERT_PFX_BASE64 secret)`n"

# Cleanup: Remove from cert store (optional, keeps it cleaner)
$cleanup = Read-Host "Remove certificate from Windows certificate store? (Y/n)"
if ($cleanup -ne "n" -and $cleanup -ne "N") {
    Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey
    Write-Host "Certificate removed from store (PFX file retained)." -ForegroundColor Green
}

Write-Host "`nDone! Your certificate is ready for use." -ForegroundColor Green
Write-Host "Remember to add the GitHub secrets before pushing a release tag." -ForegroundColor Yellow
