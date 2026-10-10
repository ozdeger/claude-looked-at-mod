export const ICON_SIZE = 30

const FILLS: Record<string, string> = {
  cs: '#7B3FA0',
  ts: '#3178C6',
  tsx: '#3178C6',
  js: '#E8C547',
  jsx: '#E8C547',
  mjs: '#E8C547',
  json: '#B7791F',
  md: '#4B5563',
  txt: '#6B7280',
  log: '#6B7280',
  py: '#3776AB',
  sh: '#3F8F29',
  zsh: '#3F8F29',
  yaml: '#C2410C',
  yml: '#C2410C',
  xml: '#C2410C',
  html: '#E34F26',
  css: '#264DE4',
  png: '#0F8B8D',
  jpg: '#0F8B8D',
  jpeg: '#0F8B8D',
  gif: '#0F8B8D',
  webp: '#0F8B8D',
  svg: '#0F8B8D',
  psd: '#0F5E9C',
  prefab: '#2A3A4A',
  unity: '#2A3A4A',
  asset: '#2A3A4A',
  mat: '#2A3A4A',
  meta: '#3B4654',
  anim: '#2A3A4A',
  controller: '#2A3A4A',
  spriteatlas: '#2A3A4A',
  shader: '#2A3A4A',
  asmdef: '#2A3A4A',
  xlsx: '#1D6F42',
  csv: '#1D6F42',
  pdf: '#B91C1C',
}

const DARK_INK = new Set(['js', 'jsx', 'mjs'])

const LABELS: Record<string, string> = {
  prefab: 'PFB',
  unity: 'SCN',
  asset: 'AST',
  controller: 'CTRL',
  spriteatlas: 'ATL',
  shader: 'SHD',
  asmdef: 'ASM',
  jpeg: 'JPG',
  yaml: 'YML',
}

const OP_BADGES: Record<string, string> = { write: '#22C55E', edit: '#F59E0B' }

const lastSeparator = (path: string) => Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

export const nameOf = (path: string) => path.slice(lastSeparator(path) + 1)

export const folderOf = (path: string) => {
  const cut = lastSeparator(path)
  return cut < 0 ? '.' : path.slice(0, cut + 1)
}

export const extensionOf = (path: string) => {
  const name = nameOf(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const hueOf = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7)

export const fileIcon = (path: string, ops: ReadonlySet<string>) => {
  const extension = extensionOf(path)
  const label = (LABELS[extension] ?? (extension || 'file')).replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || 'FILE'
  const fill = FILLS[extension] ?? (extension === '' ? '#6B7280' : `hsl(${hueOf(extension)}, 45%, 40%)`)
  const ink = DARK_INK.has(extension) ? '#1F2937' : '#FFFFFF'
  const fontSize = label.length <= 2 ? 13 : label.length === 3 ? 11 : 9
  const badge = ops.has('write') ? OP_BADGES.write : ops.has('edit') ? OP_BADGES.edit : undefined
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 32 32">` +
    `<rect x="1" y="1" width="30" height="30" rx="6" fill="${fill}"/>` +
    `<text x="16" y="16.5" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif" font-size="${fontSize}" ` +
    `font-weight="700" letter-spacing="0.3" fill="${ink}">${label}</text>` +
    (badge === undefined ? '' : `<circle cx="27" cy="5" r="4" fill="${badge}" stroke="#FFFFFF" stroke-width="1.5"/>`) +
    `</svg>`
  )
}
