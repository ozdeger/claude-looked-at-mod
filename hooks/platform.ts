export type Platform = 'mac' | 'windows'

export type ImagePaths = { encoded: string; file: string; thumb: string; preview: string }

export const INLINE_LIMIT = 95000

export const THUMB_LIMIT = 9000

const THUMB_STEPS = [
  [200, 65],
  [160, 60],
  [128, 55],
  [96, 50],
]

const PREVIEW_STEPS = [
  [1200, 70],
  [1000, 65],
  [800, 60],
  [640, 55],
  [480, 50],
  [320, 45],
]

const MAC_THUMBNAILER = `
encoded="$1"; src="$2"; thumb="$3"; preview="$4"
/usr/bin/base64 -d -i "$encoded" -o "$src" || exit 3
/bin/rm -f "$encoded"
w=$(/usr/bin/sips -g pixelWidth "$src" 2>/dev/null | /usr/bin/awk '/pixelWidth/ {print $2}')
h=$(/usr/bin/sips -g pixelHeight "$src" 2>/dev/null | /usr/bin/awk '/pixelHeight/ {print $2}')
[ -n "$w" ] && [ -n "$h" ] || exit 4
max=$w; [ "$h" -gt "$max" ] && max=$h
for spec in ${THUMB_STEPS.map(([edge, quality]) => `"${edge} ${quality}"`).join(' ')}; do
  set -- $spec
  t=$1; [ "$t" -gt "$max" ] && t=$max
  /usr/bin/sips -Z "$t" -s format jpeg -s formatOptions "$2" "$src" --out "$thumb" >/dev/null 2>&1 || exit 5
  [ "$(/usr/bin/stat -f%z "$thumb")" -le ${THUMB_LIMIT} ] && break
done
for spec in ${PREVIEW_STEPS.map(([edge, quality]) => `"${edge} ${quality}"`).join(' ')}; do
  set -- $spec
  z=$1; [ "$z" -gt "$max" ] && z=$max
  /usr/bin/sips -Z "$z" -s format jpeg -s formatOptions "$2" "$src" --out "$preview" >/dev/null 2>&1 || exit 6
  [ "$(/usr/bin/stat -f%z "$preview")" -le ${INLINE_LIMIT} ] && break
done
echo "$w $h $t $z"
`

const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`

const windowsThumbnailer = (paths: ImagePaths) => `
$ErrorActionPreference = 'Stop'
$encoded = ${quoted(paths.encoded)}; $src = ${quoted(paths.file)}; $thumb = ${quoted(paths.thumb)}; $preview = ${quoted(paths.preview)}
try {
  [IO.File]::WriteAllBytes($src, [Convert]::FromBase64String([IO.File]::ReadAllText($encoded)))
  Remove-Item -LiteralPath $encoded -Force
} catch { exit 3 }
try {
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile($src)
} catch { exit 4 }
$w = $img.Width; $h = $img.Height; $max = [Math]::Max($w, $h)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
function Save-Jpeg([int]$edge, [long]$quality, [string]$out) {
  $edge = [Math]::Min($edge, $max)
  $scale = $edge / $max
  $tw = [Math]::Max(1, [int][Math]::Round($w * $scale))
  $th = [Math]::Max(1, [int][Math]::Round($h * $scale))
  $bmp = New-Object System.Drawing.Bitmap($tw, $th)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Black)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $tw, $th)
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $quality)
  $bmp.Save($out, $codec, $params)
  $g.Dispose(); $bmp.Dispose()
  return $edge
}
$t = 0
try {
  foreach ($spec in @(${THUMB_STEPS.map(([edge, quality]) => `@(${edge}, ${quality})`).join(', ')})) {
    $t = Save-Jpeg $spec[0] $spec[1] $thumb
    if ((Get-Item -LiteralPath $thumb).Length -le ${THUMB_LIMIT}) { break }
  }
} catch { exit 5 }
$z = 0
try {
  foreach ($spec in @(${PREVIEW_STEPS.map(([edge, quality]) => `@(${edge}, ${quality})`).join(', ')})) {
    $z = Save-Jpeg $spec[0] $spec[1] $preview
    if ((Get-Item -LiteralPath $preview).Length -le ${INLINE_LIMIT}) { break }
  }
} catch { exit 6 }
$img.Dispose()
Write-Output "$w $h $t $z"
exit 0
`

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const base64Of = (bytes: number[]) => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? BASE64[n & 63]! : '='
  }
  return out
}

export const encodedCommand = (script: string) => {
  const bytes: number[] = []
  for (let i = 0; i < script.length; i++) {
    const unit = script.charCodeAt(i)
    bytes.push(unit & 255, unit >> 8)
  }
  return base64Of(bytes)
}

const windowsDir = (systemRoot: string) => systemRoot.replace(/[\\/]+$/, '')

const powershell = (systemRoot: string, script: string) => [
  `${windowsDir(systemRoot)}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  encodedCommand(script),
]

export const separatorOf = (platform: Platform) => (platform === 'windows' ? '\\' : '/')

export const joinPath = (platform: Platform, folder: string, name: string) =>
  `${folder.replace(/[\\/]+$/, '')}${separatorOf(platform)}${name}`

export const thumbnailCommand = (platform: Platform, systemRoot: string, paths: ImagePaths) =>
  platform === 'windows'
    ? powershell(systemRoot, windowsThumbnailer(paths))
    : ['/bin/sh', '-c', MAC_THUMBNAILER, 'looked-at', paths.encoded, paths.file, paths.thumb, paths.preview]

export const launchCommand = (platform: Platform, systemRoot: string, path: string, isRevealed: boolean) => {
  if (platform === 'mac') return isRevealed ? ['/usr/bin/open', '-R', path] : ['/usr/bin/open', path]
  return isRevealed
    ? [`${windowsDir(systemRoot)}\\explorer.exe`, '/select,', path]
    : powershell(systemRoot, `Invoke-Item -LiteralPath ${quoted(path)}`)
}

export const zoneCommand = (platform: Platform, systemRoot: string) =>
  platform === 'windows' ? powershell(systemRoot, "(Get-Date).ToString('zzz')") : ['/bin/date', '+%z']

export const offsetOf = (text: string) => {
  const match = text.trim().match(/^([+-])(\d\d):?(\d\d)$/)
  if (!match) return undefined
  return (match[1] === '-' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3]))
}
