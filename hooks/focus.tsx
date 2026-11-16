import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

// Focus mode: replies from earlier turns draw dim (register.tsx), the turn-closing line and Skill rows are hidden (tools.tsx),
// and each prompt the person typed gets a rule above it, so the current turn stands out from the rest of the transcript.
const isFocusOn = atom({ plugin: 'readable-chat', key: 'isFocusOn' } as const, true)

export function registerFocus(on: On): void {
  on('command.run', { command: 'focus-mode' }, async $ => {
    const isOn = await update($, isFocusOn, isOn => !isOn)

    return { text: isOn ? '專注模式：開' : '專注模式：關' }
  })

  // Only prompts typed at the composer get the rule; task notifications and messages from other sessions keep the engine's row.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.origin.kind !== 'composer' || !(await read($, isFocusOn))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 80
    const row = await next(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>{'─'.repeat(Math.max(columns - 1, 1))}</Text>
        {row}
      </Box>
    )
  })

  // `Worked for 23s · done 1:15 PM` carries nothing to read; ctrl+o still shows it, and so does the line while it waits on background agents.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded || e.props.waitingFor || !(await read($, isFocusOn))) return next(e)

    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}
