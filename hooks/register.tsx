import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LookedFile, LookedImage, LookedTab } from '../types'
import { resultsOf, toolLabel, toolUsesOf } from './capture'
import type { FileHit, ImageJob, ToolUse } from './capture'
import { extensionOf, fileIcon, folderOf, ICON_SIZE, nameOf } from './icons'
import { INLINE_LIMIT, joinPath, launchCommand, offsetOf, separatorOf, thumbnailCommand, zoneCommand } from './platform'
import type { Platform } from './platform'

const PANE = 'looked-at'
const TITLE = 'Looked at'
const VIEWER = 'looked-at-view'
const VIEWER_TITLE = 'Image'
const VIEWER_COLUMNS = 400
const EYE = '\u{1F441}\uFE0E'
const OPEN = '\u2197'
const REVEAL = '\u{1F4C2}'
const ZOOM = '\u2922'
const PREVIOUS = '\u2039'
const NEXT = '\u203A'
const CLOSE = '\u2715'
const PAGE = 20
const IMAGE_PAGE = 10
const PICTURE_BUDGET = 120000
const ECHO_MS = 400
const MAX_IMAGES = 400
const MAX_FILES = 2000
const THUMB_WIDTH = 120
const ROW_SPACING = 0.15

const images = atom({ plugin: 'looked-at', key: 'images' } as const, [])
const files = atom({ plugin: 'looked-at', key: 'files' } as const, [])
const tab = atom({ plugin: 'looked-at', key: 'tab' } as const, 'images')
const limit = atom({ plugin: 'looked-at', key: 'limit' } as const, PAGE)
const imageLimit = atom({ plugin: 'looked-at', key: 'imageLimit' } as const, IMAGE_PAGE)
const isUnique = atom({ plugin: 'looked-at', key: 'isUnique' } as const, false)
const isPaneOpen = atom({ plugin: 'looked-at', key: 'isPaneOpen' } as const, false)
const viewing = atom({ plugin: 'looked-at', key: 'viewing' } as const, null)
const isBackfilled = atom({ plugin: 'looked-at', key: 'isBackfilled' } as const, false)

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const uses = new Map<string, ToolUse>()
const pictures = new Map<string, string>()
const agents = new Map<string, string>()
let folder: string | undefined
let host: { platform: Platform; systemRoot: string } | undefined
let offsetMinutes: number | undefined
let queue: Promise<unknown> = Promise.resolve()
type Action =
  | { kind: 'tab'; tab: LookedTab }
  | { kind: 'unique' }
  | { kind: 'clear'; tab: LookedTab }
  | { kind: 'more'; tab: LookedTab }
  | { kind: 'launch'; path: string; isRevealed: boolean }
  | { kind: 'view'; id: string }
  | { kind: 'step'; delta: number }
  | { kind: 'close-viewer' }

const actions = new Map<string, Map<string, Action>>()
const keyed = new Map<string, boolean>()
let focusPress: { element: string; at: number } | undefined

const enqueue = (work: () => Promise<unknown>) => {
  queue = queue.then(work).catch(() => undefined)
}

const hostOf = async ($: EngineInterface) => {
  if (host !== undefined) return host
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const systemRoot = (await $.env.get('SystemRoot')) ?? 'C:\\Windows'
  host = { platform: isWindows ? 'windows' : 'mac', systemRoot }
  return host
}

const storage = async ($: EngineInterface) => {
  if (folder !== undefined) return folder
  const { platform } = await hostOf($)
  const temp =
    platform === 'windows'
      ? ((await $.env.get('TEMP')) ?? (await $.env.get('TMP')) ?? 'C:\\Windows\\Temp')
      : ((await $.env.get('TMPDIR')) ?? '/tmp')
  folder = joinPath(platform, joinPath(platform, temp, 'claude-looked-at'), await $.session.id())
  return folder
}

const agentLabel = async ($: EngineInterface, agentId: string | undefined) => {
  if (agentId === undefined) return null
  if (!agents.has(agentId)) {
    const found = (await $.agent.list().catch(() => [])).find(agent => agent.id === agentId)
    if (found !== undefined) agents.set(agentId, `${found.type}: ${found.description}`)
  }
  return agents.get(agentId) ?? `agent ${agentId.slice(0, 8)}`
}

const addFiles = async ($: EngineInterface, hits: FileHit[], at: number | null, agent: string | null) => {
  if (hits.length === 0) return
  const fresh: LookedFile[] = hits.map(hit => ({ ...hit, at, agent }))
  await update($, files, list => {
    const known = new Set(list.map(one => one.id))
    return [...list, ...fresh.filter(one => !known.has(one.id))].slice(-MAX_FILES)
  })
}

const thumbnail = async ($: EngineInterface, job: ImageJob, at: number | null, agent: string | null) => {
  const { platform, systemRoot } = await hostOf($)
  const stem = joinPath(platform, await storage($), job.id.replace(/[^A-Za-z0-9_-]/g, '_'))
  const paths = {
    encoded: `${stem}.b64`,
    file: `${stem}.${EXTENSIONS[job.mediaType] ?? 'img'}`,
    thumb: `${stem}.thumb.jpg`,
    preview: `${stem}.preview.jpg`,
  }
  const placeholder: LookedImage = {
    id: job.id,
    at,
    tool: job.tool,
    detail: job.detail,
    agent,
    mediaType: job.mediaType,
    bytes: Math.floor((job.data.length * 3) / 4),
    width: null,
    height: null,
    file: null,
    thumb: null,
    preview: null,
    thumbSize: null,
    previewSize: null,
    isError: job.isError,
  }
  await update($, images, list => (list.some(one => one.id === job.id) ? list : [...list, placeholder].slice(-MAX_IMAGES)))

  const isWritten = await $.fs.write(paths.encoded, job.data).then(
    () => true,
    () => false,
  )
  if (!isWritten) return
  const made = await $.process.run(thumbnailCommand(platform, systemRoot, paths), { timeoutMs: 60000 }).catch(() => undefined)
  if (made === undefined || made.exitCode === 3) return

  const [width, height, thumbSize, previewSize] = made.stdout.trim().split(/\s+/).map(Number)
  const isMade = made.exitCode === 0 && [width, height, thumbSize, previewSize].every(n => n !== undefined && Number.isFinite(n) && n > 0)
  const patch: Partial<LookedImage> = isMade
    ? { file: paths.file, thumb: paths.thumb, preview: paths.preview, width, height, thumbSize, previewSize }
    : { file: paths.file }
  await update($, images, list => list.map(one => (one.id === job.id ? { ...one, ...patch } : one)))
}

const observe = async ($: EngineInterface, content: unknown, rowId: string, tool: string, agentId: string | undefined, at: number | null) => {
  const seen = resultsOf(content, rowId, tool, id => uses.get(id))
  if (seen.images.length === 0 && seen.files.length === 0) return
  const agent = await agentLabel($, agentId)
  await addFiles($, seen.files, at, agent)
  const known = new Set((await read($, images)).map(one => one.id))
  for (const job of seen.images) {
    if (!known.has(job.id)) enqueue(() => thumbnail($, job, at, agent))
  }
}

const backfill = async ($: EngineInterface) => {
  const messages = await $.session.messages({ as: 'api' })
  for (const message of messages) {
    if (message.role === 'assistant') for (const use of toolUsesOf(message.content)) uses.set(use.id, use)
  }
  let index = 0
  for (const message of messages) {
    if (message.role === 'user') await observe($, message.content, `earlier-${index++}`, 'unknown', undefined, null)
  }
}

const readZone = async ($: EngineInterface) => {
  const { platform, systemRoot } = await hostOf($)
  const zone = await $.process.run(zoneCommand(platform, systemRoot)).catch(() => undefined)
  offsetMinutes = zone === undefined ? undefined : offsetOf(zone.stdout)
}

const openPane = async ($: EngineInterface) => {
  await $.ui.open({ id: PANE, title: TITLE, focus: true })
  await update($, isPaneOpen, () => true)
}

const perform = async ($: EngineInterface, action: Action) => {
  if (action.kind === 'tab') await update($, tab, () => action.tab)
  else if (action.kind === 'unique') await update($, isUnique, was => !was)
  else if (action.kind === 'more' && action.tab === 'images') await update($, imageLimit, n => n + IMAGE_PAGE)
  else if (action.kind === 'more') await update($, limit, n => n + PAGE)
  else if (action.kind === 'clear') {
    if (action.tab === 'images') await update($, images, () => [])
    else await update($, files, () => [])
  } else if (action.kind === 'launch') {
    const { platform, systemRoot } = await hostOf($)
    await $.process.run(launchCommand(platform, systemRoot, action.path, action.isRevealed)).catch(() => undefined)
  } else if (action.kind === 'view') {
    await update($, viewing, () => action.id)
    await $.ui.open({ id: VIEWER, title: VIEWER_TITLE, focus: true, closeOnEscape: true, columns: VIEWER_COLUMNS })
  } else if (action.kind === 'step') {
    const list = await read($, images)
    const current = await read($, viewing)
    const index = list.findIndex(one => one.id === current)
    const target = list[Math.min(list.length - 1, Math.max(0, index + action.delta))]
    if (target !== undefined) await update($, viewing, () => target.id)
  } else {
    await $.ui.close({ id: VIEWER })
  }
}

const togglePane = async ($: EngineInterface) => {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isUp) return openPane($)
  await $.ui.close({ id: PANE })
  await update($, isPaneOpen, () => false)
}

const picture = async ($: EngineInterface, path: string) => {
  const cached = pictures.get(path)
  if (cached !== undefined) return cached
  const loaded = await $.fs.read(path, { as: 'bytes' }).catch(() => undefined)
  if (loaded === undefined) return undefined
  pictures.set(path, loaded.base64)
  return loaded.base64
}

const svgOf = (mediaType: string, base64: string, width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
  `<image href="data:${mediaType};base64,${base64}" width="${width}" height="${height}"/></svg>`

const scaled = (image: LookedImage, edge: number) => {
  const width = image.width ?? edge
  const height = image.height ?? edge
  const factor = Math.min(1, edge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) }
}

const pictureOf = async ($: EngineInterface, image: LookedImage, isPreview: boolean) => {
  const path = isPreview ? image.preview : image.thumb
  if (path !== null) {
    const base64 = await picture($, path)
    if (base64 === undefined) return undefined
    const size = scaled(image, isPreview ? (image.previewSize ?? 1200) : (image.thumbSize ?? 240))
    return svgOf('image/jpeg', base64, size.width, size.height)
  }
  if (image.file === null || image.bytes > INLINE_LIMIT || image.width === null) return undefined
  const base64 = await picture($, image.file)
  return base64 === undefined ? undefined : svgOf(image.mediaType, base64, image.width, image.height ?? image.width)
}

const shortener = async ($: EngineInterface) => {
  const { platform } = await hostOf($)
  const cwd = await $.session.cwd()
  const home = platform === 'windows' ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
  const spelled = (path: string) => (platform === 'windows' ? path.replace(/\//g, '\\').toLowerCase() : path)
  const under = (path: string, root: string | undefined) => {
    if (root === undefined || root === '') return undefined
    const base = spelled(root).replace(/[\\/]+$/, '')
    return spelled(path).startsWith(`${base}${separatorOf(platform)}`) ? path.slice(base.length + 1) : undefined
  }
  return (path: string) => {
    const inProject = under(path, cwd)
    if (inProject !== undefined) return inProject
    const inHome = under(path, home)
    return inHome === undefined ? path : `~${separatorOf(platform)}${inHome}`
  }
}

const keyOf = (prefix: string, id: string) => `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`

const breakable = (text: string) => text.replace(/([\\/?&=._-])/g, '$1\u200B')

const timeOf = (at: number | null) => {
  if (at === null) return 'earlier'
  const local = new Date(at - (offsetMinutes ?? new Date(at).getTimezoneOffset()) * 60000)
  return [local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

const sizeOf = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await readZone($)
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    await update($, isPaneOpen, () => isOpen)
    const isEmpty = (await read($, images)).length === 0 && (await read($, files)).length === 0
    if (isEmpty && !(await read($, isBackfilled))) void backfill($).catch(() => undefined)
    await update($, isBackfilled, () => true)
    return started
  })

  on('session.append', { door: 'response' }, ($, e, next) => {
    for (const use of toolUsesOf(e.message.content)) uses.set(use.id, use)
    return next(e)
  })

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const stored = await next(e)
    const at = await $.clock.now()
    const tool = e.origin.kind === 'tool' ? e.origin.tool : 'unknown'
    void observe($, e.message.content, e.uuid, tool, e.agentId, at).catch(() => undefined)
    return stored
  })

  on('session.append', { door: 'tool-message' }, async ($, e, next) => {
    const stored = await next(e)
    const at = await $.clock.now()
    const tool = e.origin.kind === 'tool' ? e.origin.tool : 'unknown'
    void observe($, e.message.content, e.uuid, tool, e.agentId, at).catch(() => undefined)
    return stored
  })

  on('ui.focus', { component: 'Pane' }, async ($, e, next) => {
    const wasIdle = keyed.get(e.requestId) === false
    const moved = await next(e)
    const action = e.element === undefined ? undefined : actions.get(e.requestId)?.get(e.element)
    const isClickedIn = wasIdle && e.origin.kind === 'person' && moved.deny === undefined
    if (isClickedIn && action !== undefined && e.element !== undefined) {
      focusPress = { element: e.element, at: await $.clock.now() }
      await perform($, action).catch(() => undefined)
    }
    return moved
  }).catch(($, e, next) => next(e))

  on('ui.press', { plugin: 'looked-at' }, async ($, e, next) => {
    const isEcho = focusPress?.element === e.element && (await $.clock.now()) - focusPress.at < ECHO_MS
    focusPress = undefined
    return isEcho ? { element: e.element } : next(e)
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isPaneOpen, () => false)
    return closed
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const below = await next(e)
    if (e.surface !== 'desktop') return below

    const { Box, Button } = $.ui.resolve(e)
    const isOpen = await read($, isPaneOpen)

    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Button key="eye" label={EYE} plain dimColor={!isOpen} onPress={() => togglePane($)} />
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    keyed.set(PANE, e.props.isFocused)
    const fullOnHover = (key: string, shown: string, full: string) => (
      <Box key={key} flexDirection="column" minWidth={0}>
        <Text dimColor wrap="truncate-middle">
          {shown}
        </Text>
        <Box display="none" hover={{ display: 'flex' }} minWidth={0}>
          <Text wrap="wrap">{breakable(full)}</Text>
        </Box>
      </Box>
    )
    const drawn = new Map<string, Action>()
    const act = (key: string, action: Action) => {
      drawn.set(key, action)
      return () => perform($, action)
    }
    const seenImages = await read($, images)
    const seenFiles = await read($, files)
    const shownTab = await read($, tab)
    const count = await read($, limit)
    const imageCount = await read($, imageLimit)
    const unique = await read($, isUnique)
    const short = await shortener($)

    const header = (
      <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
        <Button
          key="tab-images"
          label={`Images ${seenImages.length}`}
          variant={shownTab === 'images' ? 'primary' : 'secondary'}
          onPress={act('tab-images', { kind: 'tab', tab: 'images' })}
        />
        <Button
          key="tab-files"
          label={`Files ${seenFiles.length}`}
          variant={shownTab === 'files' ? 'primary' : 'secondary'}
          onPress={act('tab-files', { kind: 'tab', tab: 'files' })}
        />
        {shownTab === 'files' && (
          <Button key="unique" label={unique ? 'Show history' : 'Group by file'} dimColor onPress={act('unique', { kind: 'unique' })} />
        )}
        <Button
          key="clear"
          label="Clear"
          dimColor
          onPress={act('clear', { kind: 'clear', tab: shownTab })}
        />
      </Box>
    )

    const more = (total: number, page: number, step: number, moreTab: LookedTab) =>
      total > page && (
        <Button key="more" label={`Show ${Math.min(step, total - page)} more of ${total - page}`} dimColor onPress={act('more', { kind: 'more', tab: moreTab })} />
      )

    if (shownTab === 'images') {
      const shown = seenImages.slice(-imageCount).reverse()
      const thumbs: Array<string | undefined> = []
      let budget = PICTURE_BUDGET
      for (const image of shown) {
        const thumb = Svg === undefined ? undefined : await pictureOf($, image, false)
        const fits = thumb !== undefined && thumb.length <= budget
        if (fits) budget -= thumb.length
        thumbs.push(fits ? thumb : undefined)
      }
      const rows = shown.map((image, index) => {
        const thumb = thumbs[index]
        const label = toolLabel(image.tool)
        const facts = [
          timeOf(image.at),
          image.width === null ? image.mediaType.replace('image/', '') : `${image.width}×${image.height}`,
          sizeOf(image.bytes),
          image.agent,
          image.isError ? 'error result' : null,
        ].filter(Boolean)
        const placeholder = image.thumb === null && image.file === null ? '[processing]' : image.thumb === null ? '[no preview]' : `[${ZOOM} to view]`
        return (
          <Box key={keyOf('image', image.id)} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Box flexDirection="row" gap={1} minWidth={0}>
              <Box flexShrink={0}>
                {thumb !== undefined && Svg !== undefined ? (
                  <Svg source={thumb} alt={`${label} ${image.detail}`} width={THUMB_WIDTH} />
                ) : (
                  <Text dimColor>{placeholder}</Text>
                )}
              </Box>
              <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                <Text bold wrap="truncate-end">
                  {label}
                </Text>
                {image.detail !== '' && fullOnHover(keyOf('detail', image.id), short(image.detail), image.detail)}
                <Text dimColor wrap="truncate-end">
                  {facts.join(' · ')}
                </Text>
                <Box flexDirection="row" gap={1}>
                  {image.preview !== null && (
                    <Button key={keyOf('zoom', image.id)} label={ZOOM} plain dimColor onPress={act(keyOf('zoom', image.id), { kind: 'view', id: image.id })} />
                  )}
                  {image.file !== null && <Button key={keyOf('open', image.id)} label={OPEN} plain dimColor onPress={act(keyOf('open', image.id), { kind: 'launch', path: image.file, isRevealed: false })} />}
                  {image.file !== null && <Button key={keyOf('reveal', image.id)} label={REVEAL} plain dimColor onPress={act(keyOf('reveal', image.id), { kind: 'launch', path: image.file, isRevealed: true })} />}
                </Box>
              </Box>
            </Box>
          </Box>
        )
      })
      actions.set(PANE, drawn)
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {seenImages.length === 0 && <Text dimColor>No images seen yet. Screenshots, renders and image reads show up here.</Text>}
          {rows}
          {more(seenImages.length, imageCount, IMAGE_PAGE, 'images')}
        </Box>
      )
    }

    const groups = new Map<string, { last: LookedFile; ops: Set<string>; count: number }>()
    if (unique) {
      for (const hit of seenFiles) {
        const group = groups.get(hit.path)
        groups.set(hit.path, { last: hit, ops: new Set([...(group?.ops ?? []), hit.op]), count: (group?.count ?? 0) + 1 })
      }
    }
    const list = unique
      ? [...groups.values()].sort((a, b) => (a.last.at ?? 0) - (b.last.at ?? 0))
      : seenFiles.map(last => ({ last, ops: new Set<string>([last.op]), count: 1 }))
    const shown = list.slice(-count).reverse()

    actions.set(PANE, drawn)
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {seenFiles.length === 0 && <Text dimColor>No files read or written yet.</Text>}
        <Box flexDirection="column">
          {shown.map(({ last, ops, count: times }, index) => {
            const path = short(last.path)
            const facts = [
              [...ops].join('+'),
              timeOf(last.at),
              last.detail,
              times > 1 ? `${times}×` : '',
              last.tool === 'Read' || last.tool === 'Write' || last.tool === 'Edit' ? '' : toolLabel(last.tool),
              last.agent ?? '',
              last.isError ? 'error result' : '',
            ].filter(fact => fact !== '')
            return (
              <Box key={keyOf('file', last.id)} marginTop={index === 0 ? 0 : ROW_SPACING} flexDirection="row" gap={1} alignItems="center" borderStyle="round" borderColor="subtle" paddingX={1}>
                {Svg !== undefined && <Svg source={fileIcon(last.path, ops)} alt={`${extensionOf(last.path) || 'file'} file`} width={ICON_SIZE} />}
                <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                  <Box flexDirection="row" gap={1} alignItems="center">
                    <Box flexShrink={1} minWidth={0}>
                      <Text bold wrap="truncate-end">
                        {nameOf(path)}
                      </Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={2} minWidth={0}>
                      <Text dimColor wrap="truncate-end">
                        {facts.join(' · ')}
                      </Text>
                    </Box>
                    <Box flexDirection="row" gap={1} flexShrink={0}>
                      <Button key={keyOf('open', last.id)} label={OPEN} plain dimColor onPress={act(keyOf('open', last.id), { kind: 'launch', path: last.path, isRevealed: false })} />
                      <Button key={keyOf('reveal', last.id)} label={REVEAL} plain dimColor onPress={act(keyOf('reveal', last.id), { kind: 'launch', path: last.path, isRevealed: true })} />
                    </Box>
                  </Box>
                  {fullOnHover(keyOf('path', last.id), folderOf(path), last.path)}
                </Box>
              </Box>
            )
          })}
        </Box>
        {more(list.length, count, PAGE, 'files')}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: VIEWER }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    keyed.set(VIEWER, e.props.isFocused)
    const drawn = new Map<string, Action>()
    const act = (key: string, action: Action) => {
      drawn.set(key, action)
      return () => perform($, action)
    }

    const list = await read($, images)
    const current = await read($, viewing)
    const index = list.findIndex(one => one.id === current)
    const image = list[index]
    const close = <Button key="close" label={CLOSE} plain dimColor role="dismiss" onPress={act('close', { kind: 'close-viewer' })} />
    if (image === undefined) {
      actions.set(VIEWER, drawn)
      return (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexGrow={1}>
            <Text dimColor>That image is no longer in the list.</Text>
          </Box>
          {close}
        </Box>
      )
    }

    const short = await shortener($)
    const label = toolLabel(image.tool)
    const picture = Svg === undefined ? undefined : await pictureOf($, image, true)
    const facts = [
      timeOf(image.at),
      image.width === null ? image.mediaType.replace('image/', '') : `${image.width}×${image.height}`,
      sizeOf(image.bytes),
      image.agent,
      image.detail === '' ? null : short(image.detail),
    ].filter(Boolean)
    actions.set(VIEWER, drawn)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            <Button key="previous" label={PREVIOUS} plain dimColor onPress={act('previous', { kind: 'step', delta: -1 })} />
            <Text dimColor>
              {index + 1} of {list.length}
            </Text>
            <Button key="next" label={NEXT} plain dimColor onPress={act('next', { kind: 'step', delta: 1 })} />
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text bold wrap="truncate-end">
              {label}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {image.file !== null && <Button key="open" label={OPEN} plain dimColor onPress={act('open', { kind: 'launch', path: image.file, isRevealed: false })} />}
            {image.file !== null && <Button key="reveal" label={REVEAL} plain dimColor onPress={act('reveal', { kind: 'launch', path: image.file, isRevealed: true })} />}
            {close}
          </Box>
        </Box>
        <Text dimColor wrap="truncate-middle">
          {facts.join(' · ')}
        </Text>
        {picture !== undefined && Svg !== undefined ? (
          <Svg source={picture} alt={`${label} ${image.detail}`} />
        ) : (
          <Text dimColor>No preview for this image.</Text>
        )}
      </Box>
    )
  })
}
