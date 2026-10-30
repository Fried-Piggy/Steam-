param(
  [string]$FontPath = "$env:WINDIR\Fonts\impact.ttf"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $FontPath -PathType Leaf)) {
  throw "Impact font not found: $FontPath"
}

$root = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $root 'assets\rarity-glyphs'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$fontCollection = [System.Drawing.Text.PrivateFontCollection]::new()
$fontCollection.AddFontFile($FontPath)
$fontFamily = $fontCollection.Families[0]
$format = [System.Drawing.StringFormat]::GenericTypographic
$format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
$culture = [System.Globalization.CultureInfo]::InvariantCulture
$tiers = @('UR', 'SSR', 'SR', 'R', 'N', 'C', 'F')

function Format-Point([System.Drawing.PointF]$point) {
  return '{0},{1}' -f $point.X.ToString('0.###', $culture), $point.Y.ToString('0.###', $culture)
}

foreach ($tier in $tiers) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddString($tier, $fontFamily, 0, 240, [System.Drawing.PointF]::new(0, 0), $format)

  # Match the browser's synthetic italic Impact without shipping the font itself.
  $italic = [System.Drawing.Drawing2D.Matrix]::new(1, 0, -0.18, 1, 44, 0)
  $path.Transform($italic)
  $bounds = $path.GetBounds()
  $normalize = [System.Drawing.Drawing2D.Matrix]::new()
  $normalize.Translate(-$bounds.X + 4, -$bounds.Y + 4)
  $path.Transform($normalize)
  $bounds = $path.GetBounds()

  $points = $path.PathPoints
  $types = $path.PathTypes
  $commands = [System.Collections.Generic.List[string]]::new()
  for ($index = 0; $index -lt $points.Length; $index++) {
    $kind = $types[$index] -band 0x07
    $closed = ($types[$index] -band 0x80) -ne 0
    if ($kind -eq 0) {
      $commands.Add("M$(Format-Point $points[$index])")
    } elseif ($kind -eq 1) {
      $commands.Add("L$(Format-Point $points[$index])")
    } elseif ($kind -eq 3) {
      if ($index + 2 -ge $points.Length) { throw "Invalid Bezier data for $tier" }
      $commands.Add("C$(Format-Point $points[$index]) $(Format-Point $points[$index + 1]) $(Format-Point $points[$index + 2])")
      $index += 2
      $closed = ($types[$index] -band 0x80) -ne 0
    }
    if ($closed) { $commands.Add('Z') }
  }

  $width = [Math]::Ceiling($bounds.Width + 8)
  $height = [Math]::Ceiling($bounds.Height + 8)
  $pathData = $commands -join ' '
  $svg = "<svg xmlns=`"http://www.w3.org/2000/svg`" viewBox=`"0 0 $width $height`"><path fill=`"#fff`" d=`"$pathData`"/></svg>"
  $target = Join-Path $outputDirectory "$($tier.ToLowerInvariant()).svg"
  [System.IO.File]::WriteAllText($target, $svg, [System.Text.UTF8Encoding]::new($false))

  $path.Dispose()
  $italic.Dispose()
  $normalize.Dispose()
}

$format.Dispose()
$fontFamily.Dispose()
$fontCollection.Dispose()
Write-Output "Generated $($tiers.Count) Impact glyph masks in $outputDirectory"
