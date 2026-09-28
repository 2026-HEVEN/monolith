$ErrorActionPreference = "Stop"

Write-Host "----------------------------------------"
Write-Host "Select device type:"
Write-Host "1) Monolith (Original)"
Write-Host "2) Monolith Mini"
Write-Host "----------------------------------------"

$choice = Read-Host "Input selection (1 or 2)"
$target = ""

if ($choice -eq "1") {
    $target = "monolith"
    Write-Host "Monolith (Original) selected."
}
elseif ($choice -eq "2") {
    $target = "monolith-mini"
    Write-Host "Monolith Mini selected."
}
else {
    Write-Host "Wrong input. Exiting."
    exit 1
}

Set-Location -Path "firmware/$target"

Write-Host "Installing esptool..."
python -m pip install esptool

Write-Host "Flashing firmware..."
& esptool --chip esp32s3 -b 460800 --before default-reset --after hard-reset write-flash "@flash_args"

Write-Host "Done."
