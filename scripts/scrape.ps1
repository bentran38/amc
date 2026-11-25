# Runs the showtimes scraper once (today's page per tracked theatre) and appends the output to scraper\scrape.log.
# Windows Task Scheduler runs this a few times a day; see README "Scraper". Needs scraper\.env with
# SUPABASE_URL and AMC_INGEST_TOKEN, and Google Chrome installed. A Chrome window opens for a few seconds.
$ErrorActionPreference = 'Continue'
$dir = Join-Path $PSScriptRoot '..\scraper'
Set-Location $dir
$log = Join-Path $dir 'scrape.log'
"=== $(Get-Date -Format s)" | Out-File -FilePath $log -Append -Encoding utf8
& node --env-file=.env scrape.js *>&1 | Out-File -FilePath $log -Append -Encoding utf8
# keep the log short
$lines = Get-Content $log -Tail 2000
$lines | Set-Content $log -Encoding utf8
