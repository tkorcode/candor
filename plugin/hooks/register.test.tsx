import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'candor',
  component: 'Pane',
  requestId: 'candor',
  props: {
    title: 'Candor',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const STATE = JSON.stringify({
  run: 'r_demo',
  paused: true,
  entries: 7,
  last_event: 'PreToolUse',
  last_event_ts: '2026-11-18T00:00:00.000Z',
  sessions: ['s1'],
  stage_reports: ['profile'],
})

test('the pane shows what candord published, in the terminal and in Desktop', async ($, on) => {
  on('command.register', () => ({ value: { command: 'candor' } }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/op' : undefined }))
  on('fs.read', (_, e) => {
    expect(e.path).toBe('/home/op/.candor/state.json')

    return { value: STATE }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Run r_demo/ }))?.text).toBe('Run r_demo: PAUSED')
    expect((await ui.find({ type: 'Text', text: /Stage reports/ }))?.text).toBe('Stage reports: profile')
    await ui.unmount()
  }
})

test('with no state the pane says what will appear and how to start', async ($, on) => {
  on('command.register', () => ({ value: { command: 'candor' } }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('fs.read', () => {
    throw new Error('missing')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No run/ }))?.text).toBe('No run to show yet.')
  expect((await ui.find({ type: 'Text', text: /candor daemon/ }))?.text).toMatch(/Start it with: candor daemon/)
  await ui.unmount()
})

test('/candor status answers in text where nothing draws', async ($, on) => {
  on('command.register', () => ({ value: { command: 'candor' } }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'CANDOR_HOME' ? '/tmp/ch' : undefined }))
  on('fs.read', () => ({ value: STATE }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  // The test kit asks for the origin and presentation that the engine would stamp. This test does not read them.
  const answer = await $.command.run({ command: 'candor', args: 'status' } as unknown as Parameters<typeof $.command.run>[0])
  expect(JSON.stringify(answer)).toMatch(/Run r_demo: PAUSED/)
  expect(JSON.stringify(answer)).toMatch(/Entries recorded: 7/)
})
