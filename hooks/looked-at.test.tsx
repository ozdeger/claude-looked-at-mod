import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const FOOTER = { component: 'SessionMode', props: { modes: ['memory paused'] } } as const

const PANE = {
  component: 'Pane',
  requestId: 'looked-at',
  props: { title: 'Looked at', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }

const breakable = (text: string) => text.replace(/([\\/?&=._-])/g, '$1\u200B')

const MAC = { env: { TMPDIR: '/var/tmp/', HOME: '/Users/me' }, cwd: '/Users/me/repo' }

const WINDOWS = {
  env: { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp', USERPROFILE: 'C:\\Users\\me' },
  cwd: 'C:\\Users\\me\\repo',
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const scriptOf = (argv: readonly string[]) => {
  const encoded = argv[argv.indexOf('-EncodedCommand') + 1] ?? ''
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const letter of encoded.replace(/=+$/, '')) {
    value = (value << 6) | LETTERS.indexOf(letter)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 255)
      value &= (1 << bits) - 1
    }
  }
  let script = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) script += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8))
  return script
}

const host = (on: On, machine: { env: Record<string, string>; cwd: string } = MAC, picture = PNG) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 10, 9, 15, 30) })
  mock.env(on, machine.env)
  const runs: string[][] = []
  const writes: string[] = []
  const opened: string[] = []
  const closed: string[] = []
  const up = new Set<string>()
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: machine.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    up.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: [...up].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.close', ($, e) => {
    closed.push(e.id)
    up.delete(e.id)
    return { value: undefined }
  })
  on('fs.read', () => ({ value: { base64: picture } }))
  on('fs.write', ($, e) => {
    writes.push(e.path)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>memory paused</Text>
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const isZone = e.argv[0] === '/bin/date' || scriptOf(e.argv).includes("ToString('zzz')")
    const stdout = isZone ? '+03:00\n' : '1280 800 240 1200\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { clock, runs, writes, opened, closed, up }
}

describe('looked-at', () => {
  test('lists what tool results showed the agent, as images and files', async ($, on) => {
    const { clock, runs, writes } = host(on)

    await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'claude' },
      uuid: 'row-1',
      message: {
        type: 'assistant',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/Users/me/repo/shots/board.png' } },
          { type: 'tool_use', id: 'toolu_shot', name: 'mcp__Claude_Browser__computer', input: { action: 'screenshot' } },
          { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: '/Users/me/repo/src/a.cs' } },
        ],
      },
    })
    await $.session.append({
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'row-2',
      message: {
        type: 'user',
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_read', content: [image] },
          { type: 'tool_result', tool_use_id: 'toolu_shot', content: [{ type: 'text', text: 'done' }, image] },
          { type: 'tool_result', tool_use_id: 'toolu_edit', content: 'ok' },
        ],
      },
    })
    await clock.settle()

    expect(runs.filter(argv => argv[0] === '/bin/sh')).toHaveLength(2)
    expect(writes).toEqual(['/var/tmp/claude-looked-at/session-1/toolu_read_0.b64', '/var/tmp/claude-looked-at/session-1/toolu_shot_1.b64'])

    const footer = await $.ui.mount({ plugin: 'looked-at', surface: 'desktop', ...FOOTER })
    expect(await footer.find({ type: 'Button', key: 'eye' })).toBeDefined()
    await footer.press({ key: 'eye' })
    await footer.unmount()

    const pane = await $.ui.mount({ plugin: 'looked-at', surface: 'desktop', ...PANE })
    expect(await pane.findAll({ type: 'Svg' })).toHaveLength(2)
    expect(await pane.find({ type: 'Text', text: 'Claude_Browser · computer' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'shots/board.png' })).toBeDefined()

    expect(await pane.find({ type: 'Button', key: 'view-toolu_shot_1' })).toBeUndefined()
    expect(await pane.find({ type: 'Button', key: 'zoom-toolu_shot_1' })).toBeDefined()

    await pane.press({ key: 'tab-files' })
    const icons = await pane.findAll({ type: 'Svg' })
    expect(icons).toHaveLength(2)
    expect(await pane.find({ type: 'Text', text: /^a\.cs$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^src\/$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^edit · 12:15:30/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^board\.png$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^shots\/$/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'open-toolu_edit' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: breakable('/Users/me/repo/src/a.cs') })).toBeDefined()
    await pane.unmount()
  })

  test('the eye opens and closes the pane, on the desktop only', async ($, on) => {
    const { opened, closed } = host(on)

    const desktop = await $.ui.mount({ plugin: 'looked-at', surface: 'desktop', ...FOOTER })
    await desktop.press({ key: 'eye' })
    await desktop.press({ key: 'eye' })
    expect(opened).toEqual(['looked-at'])
    expect(closed).toEqual(['looked-at'])
    await desktop.unmount()

    const terminal = await $.ui.mount({ plugin: 'looked-at', surface: 'terminal', ...FOOTER })
    expect(await terminal.find({ type: 'Button', key: 'eye' })).toBeUndefined()
    await terminal.unmount()
  })

  test('the eye reopens a pane that was closed without the mod hearing of it', async ($, on) => {
    const { opened, up } = host(on)
    const footer = await $.ui.mount({ plugin: 'looked-at', surface: 'desktop', ...FOOTER })
    await footer.press({ key: 'eye' })
    up.clear()
    await footer.press({ key: 'eye' })
    expect(opened).toEqual(['looked-at', 'looked-at'])
    await footer.unmount()
  })

  test('the pane has no collapse button of its own', async ($, on) => {
    host(on)
    const pane = await $.ui.mount({ plugin: 'looked-at', surface: 'desktop', ...PANE })
    expect(await pane.find({ type: 'Button', key: 'collapse' })).toBeUndefined()
    expect(await pane.find({ type: 'Button', key: 'tab-images' })).toBeDefined()
    await pane.unmount()
  })

  test('runs on Windows with PowerShell, Explorer and backslash paths', async ($, on) => {
    const { clock, runs, writes } = host(on, WINDOWS)
    const temp = 'C:\\Users\\me\\AppData\\Local\\Temp\\claude-looked-at\\session-1'
    const cs = 'C:\\Users\\me\\repo\\src\\a.cs'

    await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'claude' },
      uuid: 'row-1',
      message: {
        type: 'assistant',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'C:\\Users\\me\\repo\\shots\\board.png' } },
          { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: cs } },
        ],
      },
    })
    await $.session.append({
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'row-2',
      message: {
        type: 'user',
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_read', content: [image] },
          { type: 'tool_result', tool_use_id: 'toolu_edit', content: 'ok' },
        ],
      },
    })
    await clock.settle()

    expect(writes).toHaveLength(1)
    expect(writes[0]?.endsWith(`${temp}\\toolu_read_0.b64`)).toBe(true)
    const thumbnailer = runs.find(argv => scriptOf(argv).includes('Save-Jpeg'))
    expect(thumbnailer?.[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(scriptOf(thumbnailer ?? [])).toContain(`$src = '${temp}\\toolu_read_0.png'`)

    const pane = await $.ui.mount({ plugin: 'looked-at', surface: 'desktop', ...PANE })
    expect(await pane.findAll({ type: 'Svg' })).toHaveLength(1)
    expect(await pane.find({ type: 'Text', text: /^shots\\board\.png$/ })).toBeDefined()
    await pane.press({ key: 'reveal-toolu_read_0' })
    expect(runs.at(-1)).toEqual(['C:\\Windows\\explorer.exe', '/select,', `${temp}\\toolu_read_0.png`])

    await pane.press({ key: 'tab-files' })
    expect(await pane.find({ type: 'Text', text: /^a\.cs$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^src\\$/ })).toBeDefined()
    await pane.press({ key: 'open-toolu_edit' })
    expect(scriptOf(runs.at(-1) ?? [])).toBe(`Invoke-Item -LiteralPath '${cs}'`)
    await pane.unmount()
  })

  test('the zoom button opens a viewer that steps through images and closes', async ($, on) => {
    const { clock, opened, closed } = host(on)
    await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'claude' },
      uuid: 'row-1',
      message: {
        type: 'assistant',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/Users/me/repo/a.png' } },
          { type: 'tool_use', id: 'toolu_b', name: 'mcp__Claude_Browser__computer', input: { action: 'screenshot' } },
        ],
      },
    })
    await $.session.append({
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'row-2',
      message: {
        type: 'user',
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_a', content: [image] },
          { type: 'tool_result', tool_use_id: 'toolu_b', content: [image] },
        ],
      },
    })
    await clock.settle()

    const list = await $.ui.mount({ plugin: 'looked-at', surface: 'desktop', ...PANE })
    await list.press({ key: 'zoom-toolu_b_0' })
    expect(opened).toContain('looked-at-view')
    await list.unmount()

    const viewer = await $.ui.mount({ plugin: 'looked-at', surface: 'desktop', ...PANE, requestId: 'looked-at-view' })
    expect(await viewer.findAll({ type: 'Svg' })).toHaveLength(1)
    expect(await viewer.find({ type: 'Text', text: /^2 of 2$/ })).toBeDefined()
    expect(await viewer.find({ type: 'Text', text: 'Claude_Browser · computer' })).toBeDefined()
    await viewer.press({ key: 'previous' })
    expect(await viewer.find({ type: 'Text', text: /^1 of 2$/ })).toBeDefined()
    expect(await viewer.find({ type: 'Text', text: /^Read$/ })).toBeDefined()
    await viewer.press({ key: 'previous' })
    expect(await viewer.find({ type: 'Text', text: /^1 of 2$/ })).toBeDefined()
    await viewer.press({ key: 'close' })
    expect(closed).toContain('looked-at-view')
    await viewer.unmount()
  })

  test('keeps the drawn pictures under a budget and pages images by ten', async ($, on) => {
    const { clock } = host(on, MAC, 'A'.repeat(50000))
    const ids = Array.from({ length: 12 }, (_, index) => `toolu_${index}`)
    await $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'claude' },
      uuid: 'row-1',
      message: {
        type: 'assistant',
        role: 'assistant',
        content: ids.map(id => ({ type: 'tool_use', id, name: 'mcp__Claude_Browser__computer', input: { action: 'screenshot' } })),
      },
    })
    await $.session.append({
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'mcp__Claude_Browser__computer' },
      uuid: 'row-2',
      message: { type: 'user', role: 'user', content: ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: [image] })) },
    })
    await clock.settle()

    const pane = await $.ui.mount({ plugin: 'looked-at', surface: 'desktop', ...PANE })
    expect(await pane.findAll({ type: 'Button', text: '\u2922' })).toHaveLength(10)
    expect(await pane.findAll({ type: 'Svg' })).toHaveLength(2)
    expect(await pane.findAll({ type: 'Text', text: '[\u2922 to view]' })).toHaveLength(8)
    expect(await pane.find({ type: 'Button', key: 'more' })).toBeDefined()
    await pane.press({ key: 'more' })
    expect(await pane.findAll({ type: 'Button', text: '\u2922' })).toHaveLength(12)
    await pane.unmount()
  })

  test('relays every row unchanged', async ($, on) => {
    host(on)
    const session = mock.session(on)
    const content = [{ type: 'tool_result', tool_use_id: 'toolu_y', content: [image] }]
    await $.session.append({
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Read' },
      uuid: 'row-4',
      message: { type: 'user', role: 'user', content },
    })
    expect(session.appended().at(-1)?.message.content).toEqual(content)
  })
})
