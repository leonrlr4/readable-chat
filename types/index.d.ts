// One reply in the reading panel: id is used for pinning and switching, title is the name shown in the list.
export type ReaderDoc = { id: string; title: string; text: string }

// The three /format levels: more uses more headings and bullets, less uses less formatting, off injects no rules.
export type FormatLevel = 'more' | 'less' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'readable-chat': {
      isFoldOn: boolean
      isExpanded: StateFamily<boolean>
      // IDs of replies already on screen when a new prompt is sent; only these get folded, and the newest one stays fully shown.
      settled: string[]
      history: ReaderDoc[]
      pinned: ReaderDoc[]
      selected: string | null
      formatLevel: FormatLevel
      // Tool output folding (hooks/tools.tsx).
      isToolCollapseOn: boolean
      isToolOpen: StateFamily<boolean>
    }
  }
}
