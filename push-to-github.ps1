# WhaleMind MCP - Push to GitHub
# Run this script in PowerShell from the project root (where this file lives).
# Requires: Git installed and in PATH.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "1. Initializing Git..." -ForegroundColor Cyan
git init

Write-Host "`n2. Staging files (respecting .gitignore)..." -ForegroundColor Cyan
git add .
git status

Write-Host "`n3. Verifying .env is NOT staged..." -ForegroundColor Cyan
$staged = git diff --cached --name-only
if ($staged -match "\.env$") {
    Write-Host "ERROR: .env is staged! Remove it: git reset .env" -ForegroundColor Red
    exit 1
}
Write-Host "OK: .env is not staged" -ForegroundColor Green

Write-Host "`n4. Creating initial commit..." -ForegroundColor Cyan
git commit -m "Initial commit – WhaleMind MCP backend"

Write-Host "`n5-7. GitHub setup (run manually after creating repo):" -ForegroundColor Yellow
Write-Host "   - Create repo at https://github.com/new named: whalemind-mcp-backend (no README)"
Write-Host "   - Then run:"
Write-Host '   git remote add origin https://github.com/YOUR_USERNAME/whalemind-mcp-backend.git'
Write-Host "   git branch -M main"
Write-Host "   git push -u origin main"
