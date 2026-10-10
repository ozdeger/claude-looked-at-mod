export type LookedTab = 'images' | 'files'

export type LookedImage = {
  id: string
  at: number | null
  tool: string
  detail: string
  agent: string | null
  mediaType: string
  bytes: number
  width: number | null
  height: number | null
  file: string | null
  thumb: string | null
  preview: string | null
  thumbSize: number | null
  previewSize: number | null
  isError: boolean
}

export type LookedFileOp = 'read' | 'write' | 'edit'

export type LookedFile = {
  id: string
  at: number | null
  tool: string
  op: LookedFileOp
  path: string
  detail: string
  agent: string | null
  isError: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'looked-at': {
      images: LookedImage[]
      files: LookedFile[]
      tab: LookedTab
      limit: number
      imageLimit: number
      isUnique: boolean
      isPaneOpen: boolean
      viewing: string | null
      isBackfilled: boolean
    }
  }
}
