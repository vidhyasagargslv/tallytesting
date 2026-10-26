<#
  Posts every windows/requests/*.xml to TallyPrime and saves responses to windows/output/.
  Run on the Windows PC where TallyPrime is running with the DEMO company open:

    powershell -ExecutionPolicy Bypass -File windows\tally-test.ps1 -Company "Demo Sync Co"
    # only some files:
    powershell -ExecutionPolicy Bypass -File windows\tally-test.ps1 -Company "Demo Sync Co" -Filter "0*"

  NEVER run the create/alter requests (01-07) against a real/live company.
#>
param(
  [string]$TallyUrl = "http://localhost:9000",
  [Parameter(Mandatory = $true)][string]$Company,
  [string]$Date = (Get-Date -Format "yyyyMMdd"),
  [string]$FromDate = "20260401",
  [string]$ToDate = "20270331",
  [string]$Filter = "*"
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$reqDir = Join-Path $root "requests"
$outDir = Join-Path $root "output"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$companyXml = [System.Security.SecurityElement]::Escape($Company)

Get-ChildItem -Path $reqDir -Filter "$Filter.xml" | Sort-Object Name | ForEach-Object {
  $xml = Get-Content $_.FullName -Raw -Encoding UTF8
  $xml = $xml.Replace("__COMPANY__", $companyXml).Replace("__DATE__", $Date).Replace("__FROM__", $FromDate).Replace("__TO__", $ToDate)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($xml)
  $outFile = Join-Path $outDir $_.Name
  try {
    $resp = Invoke-WebRequest -Uri $TallyUrl -Method Post -Body $bytes -ContentType "text/xml; charset=utf-8" -UseBasicParsing -TimeoutSec 120
    $raw = $resp.RawContentStream.ToArray()
    # Tally may answer UTF-16LE (BOM FF FE or zero bytes) or UTF-8
    if (($raw.Length -ge 2 -and $raw[0] -eq 0xFF -and $raw[1] -eq 0xFE) -or ($raw.Length -ge 4 -and $raw[1] -eq 0 -and $raw[3] -eq 0)) {
      $text = [System.Text.Encoding]::Unicode.GetString($raw)
    } else { $text = [System.Text.Encoding]::UTF8.GetString($raw) }
    [System.IO.File]::WriteAllText($outFile, $text, [System.Text.Encoding]::UTF8)
    $summary = ""
    foreach ($tag in "CREATED","ALTERED","ERRORS","EXCEPTIONS","LASTVCHID","LASTMID") {
      if ($text -match "<$tag>([^<]*)</$tag>") { $summary += "$tag=$($Matches[1]) " }
    }
    $errs = [regex]::Matches($text, "<LINEERROR>([\s\S]*?)</LINEERROR>") | ForEach-Object { $_.Groups[1].Value }
    $objects = ([regex]::Matches($text, "<(LEDGER|GROUP|STOCKITEM|UNIT|GODOWN|STOCKGROUP|VOUCHERTYPE|VOUCHER|COMPANY) ")).Count
    Write-Host ("{0,-50} {1,8} bytes  objects={2}  {3}" -f $_.Name, $text.Length, $objects, $summary)
    foreach ($e in $errs) { Write-Host "    LINEERROR: $e" -ForegroundColor Red }
  } catch {
    Write-Host ("{0,-50} FAILED: {1}" -f $_.Name, $_.Exception.Message) -ForegroundColor Red
  }
}
Write-Host "`nResponses saved in $outDir - zip that folder and share it so the mocks/parsers can be checked against real output."
