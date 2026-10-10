import type { LookedFile, LookedFileOp } from '../types'

export type Block = { readonly type: string; readonly [field: string]: unknown }

export type ToolUse = { id: string; name: string; input: Record<string, unknown> }

export type ImageJob = {
  id: string
  tool: string
  detail: string
  mediaType: string
  data: string
  isError: boolean
}

export type FileHit = Omit<LookedFile, 'at' | 'agent'>

export type Seen = { images: ImageJob[]; files: FileHit[] }

const FILE_OPS: Record<string, LookedFileOp> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
}

const DETAIL_KEYS = ['action', 'file_path', 'path', 'url', 'name', 'query', 'command', 'description']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const blocksOf = (content: unknown): Block[] =>
  Array.isArray(content) ? content.filter((b): b is Block => isRecord(b) && typeof b.type === 'string') : []

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const toolLabel = (tool: string) => {
  const parts = tool.split('__')
  return parts[0] === 'mcp' && parts.length >= 3 ? `${parts[1]} · ${parts.slice(2).join('__')}` : tool
}

export const describeCall = (input: Record<string, unknown>) => {
  const parts: string[] = []
  for (const key of DETAIL_KEYS) {
    const value = text(input[key])
    if (value !== '') parts.push(value)
    if (parts.length === 2) break
  }
  return parts.join(' · ').replace(/\s+/g, ' ').slice(0, 200)
}

const pathOf = (input: Record<string, unknown>) => text(input.file_path) || text(input.notebook_path)

const fileDetail = (op: LookedFileOp, input: Record<string, unknown>) => {
  if (op !== 'read') return ''
  if (text(input.pages) !== '') return `pages ${text(input.pages)}`
  const offset = typeof input.offset === 'number' ? input.offset : undefined
  const limit = typeof input.limit === 'number' ? input.limit : undefined
  if (offset === undefined && limit === undefined) return ''
  const first = offset ?? 1
  return limit === undefined ? `from line ${first}` : `lines ${first}–${first + limit - 1}`
}

const imageOf = (block: Block) => {
  if (block.type !== 'image' || !isRecord(block.source)) return undefined
  const { type, media_type, data } = block.source
  if (type !== 'base64' || typeof data !== 'string' || data === '') return undefined
  return { mediaType: typeof media_type === 'string' ? media_type : 'image/png', data }
}

export const toolUsesOf = (content: unknown): ToolUse[] =>
  blocksOf(content)
    .filter(b => b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
    .map(b => ({ id: b.id as string, name: b.name as string, input: isRecord(b.input) ? b.input : {} }))

export const resultsOf = (
  content: unknown,
  rowId: string,
  fallbackTool: string,
  useOf: (id: string) => ToolUse | undefined,
): Seen => {
  const seen: Seen = { images: [], files: [] }
  let lastUse: ToolUse | undefined
  let loose = 0

  for (const block of blocksOf(content)) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const id = block.tool_use_id
      const use = useOf(id)
      lastUse = use
      const tool = use?.name ?? fallbackTool
      const input = use?.input ?? {}
      const isError = block.is_error === true
      const op = FILE_OPS[tool]
      const path = pathOf(input)
      if (op !== undefined && path !== '') {
        seen.files.push({ id, tool, op, path, detail: fileDetail(op, input), isError })
      }
      const detail = tool === 'Read' ? path : describeCall(input)
      blocksOf(block.content).forEach((inner, index) => {
        const image = imageOf(inner)
        if (image !== undefined) seen.images.push({ id: `${id}#${index}`, tool, detail, isError, ...image })
      })
      continue
    }
    const image = imageOf(block)
    if (image === undefined) continue
    const tool = lastUse?.name ?? fallbackTool
    const detail = lastUse === undefined ? '' : describeCall(lastUse.input)
    seen.images.push({ id: `${rowId}~${loose++}`, tool, detail, isError: false, ...image })
  }

  return seen
}
