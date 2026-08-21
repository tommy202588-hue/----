param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [Parameter(Mandatory = $true)]
  [string]$PngOutputPath,

  [Parameter(Mandatory = $true)]
  [string]$IcoOutputPath
)

Add-Type -AssemblyName System.Drawing

function New-RoundedIconBitmap {
  param(
    [System.Drawing.Image]$Source,
    [int]$Size
  )

  $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

  $radius = [Math]::Max(2, [int][Math]::Round($Size * 0.18))
  $diameter = $radius * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
  $path.AddArc($Size - $diameter, 0, $diameter, $diameter, 270, 90)
  $path.AddArc($Size - $diameter, $Size - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc(0, $Size - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()

  $graphics.SetClip($path)
  $graphics.DrawImage($Source, 0, 0, $Size, $Size)
  $graphics.ResetClip()

  $path.Dispose()
  $graphics.Dispose()
  return $bitmap
}

$source = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $InputPath))
$pngDirectory = Split-Path -Parent $PngOutputPath
$icoDirectory = Split-Path -Parent $IcoOutputPath
New-Item -ItemType Directory -Force -Path $pngDirectory, $icoDirectory | Out-Null

try {
  $preview = New-RoundedIconBitmap -Source $source -Size 1024
  try {
    $preview.Save($PngOutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  finally {
    $preview.Dispose()
  }

  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $images = @()

  foreach ($size in $sizes) {
    $bitmap = New-RoundedIconBitmap -Source $source -Size $size
    $stream = New-Object System.IO.MemoryStream
    try {
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $images += ,([byte[]]$stream.ToArray())
    }
    finally {
      $stream.Dispose()
      $bitmap.Dispose()
    }
  }

  $fileStream = [System.IO.File]::Open($IcoOutputPath, [System.IO.FileMode]::Create)
  $writer = New-Object System.IO.BinaryWriter($fileStream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)

    $offset = 6 + (16 * $sizes.Count)
    for ($index = 0; $index -lt $sizes.Count; $index++) {
      $size = $sizes[$index]
      $dimension = if ($size -ge 256) { [byte]0 } else { [byte]$size }
      $writer.Write($dimension)
      $writer.Write($dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$images[$index].Length)
      $writer.Write([uint32]$offset)
      $offset += $images[$index].Length
    }

    foreach ($image in $images) {
      $writer.Write($image)
    }
  }
  finally {
    $writer.Dispose()
    $fileStream.Dispose()
  }
}
finally {
  $source.Dispose()
}
