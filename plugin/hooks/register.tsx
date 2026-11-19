import type { EngineInterface, Register } from 'claude-code'

// A pane that shows what candord has recorded, beside the session. The mod holds no
// source of truth. It reads the state file candord publishes and draws it.

const PANE = 'candor'
const TABS = ['Run map', 'Ledger', 'Receipt'] as const
type Tab = (typeof TABS)[number]

type RunState = {
  run: string
  paused: boolean
  entries: number
  last_event: string | null
  last_event_ts: string | null
  sessions: string[]
  stage_reports: string[]
}

let tab: Tab = 'Run map'
let state: RunState | null = null
let problem: string | null = 'Not read yet.'

async function load($: EngineInterface): Promise<void> {
  try {
    const home = (await $.env.get('CANDOR_HOME')) ?? `${(await $.env.get('HOME')) ?? ''}/.candor`
    const text = await $.fs.read(`${home}/state.json`)
    state = JSON.parse(text) as RunState
    problem = null
  } catch {
    state = null
    problem = 'candord has published no state. Start it with: candor daemon'
  }
}

function summary(): string {
  if (state === null) return `No run to show. ${problem ?? ''}`.trim()
  const reports = state.stage_reports.length > 0 ? state.stage_reports.join(', ') : 'none'
  return [
    `Run ${state.run}: ${state.paused ? 'PAUSED' : 'running'}`,
    `Entries recorded: ${state.entries}`,
    `Last event: ${state.last_event ?? 'none'}`,
    `Stage reports: ${reports}`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await load($)
    $.clock.every(2000, async () => {
      await load($)
      $.ui.invalidate('ui.render')
    })
    try {
      await $.command.register({
        name: 'candor',
        description: 'Show the Candor run: status in text, or the pane',
        argumentHint: '[status]',
        immediate: true,
      })
    } catch {
      // Another plugin holds the name. The pane still draws.
    }

    return next(e)
  })

  on('command.run', { command: 'candor' }, async ($, e) => {
    await load($)
    if (e.args.trim() === 'status') return { text: summary() }
    const opened = await $.ui.open({ id: PANE, title: 'Candor' })

    // Where nothing draws, such as a headless run, answer in text.
    return opened.isPlaced ? {} : { text: summary() }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          {TABS.map(name => (
            <Button
              key={`tab-${name}`}
              label={tab === name ? `[${name}]` : name}
              plain
              dimColor={tab !== name}
              onPress={() => {
                tab = name
                $.ui.invalidate('ui.render')
              }}
            />
          ))}
        </Box>
        {state === null && (
          <Box flexDirection="column">
            <Text>No run to show yet.</Text>
            <Text dimColor>{problem ?? ''}</Text>
            <Text dimColor>Checkpoints, drift and the ledger appear here once a run starts.</Text>
          </Box>
        )}
        {state !== null && tab === 'Run map' && (
          <Box flexDirection="column">
            <Text>
              Run {state.run}: {state.paused ? 'PAUSED' : 'running'}
            </Text>
            <Text>Stage reports: {state.stage_reports.length > 0 ? state.stage_reports.join(', ') : 'none'}</Text>
            <Text dimColor>The run map with checkpoints and drift is in the Candor Console.</Text>
          </Box>
        )}
        {state !== null && tab === 'Ledger' && (
          <Box flexDirection="column">
            <Text>Entries recorded: {String(state.entries)}</Text>
            <Text>Last event: {state.last_event ?? 'none'}</Text>
            <Text dimColor>{state.last_event_ts ?? ''}</Text>
          </Box>
        )}
        {state !== null && tab === 'Receipt' && <Text dimColor>The receipt is written by candor receipt. Open receipt.html, or the Candor Console.</Text>}
      </Box>
    )
  })
}
