// One reply in the reading panel: id is used for pinning and switching, title is the name shown in the list.
export type ReaderDoc = { id: string; title: string; text: string }

// The three /format levels: more uses more headings and bullets, less uses less formatting, off injects no rules.
export type FormatLevel = 'more' | 'less' | 'off'

// One picture a reply points at. src is an absolute path for local, an https URL for remote, the diagram or TeX source for mermaid and math.
export type ImageRef = { kind: 'local' | 'remote' | 'mermaid' | 'math'; src: string; alt: string }

// Where the reader pane returns to after a jump: which reply, and the heading it was on (null for the top).
export type PaneSpot = { docId: string; heading: number | null }

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
      // Focus mode (hooks/focus.tsx): dim earlier turns, hide the turn-duration line and Skill rows, rule above each prompt.
      isFocusOn: boolean
      // Images (hooks/images.ts): fetch https images in replies; off shows their alt text and a link.
      isRemoteImagesOn: boolean
      // Keys (`${requestId}:${index}`) of pictures currently showing their source instead of the picture.
      shownSource: string[]
      // Reader pane (hooks/pane.tsx): the filter typed into its search box, empty for none.
      paneQuery: string
      // Whether the pane shows a keyboard label beside each link and path.
      isHinting: boolean
      // Spots to return to, most recent last.
      paneBack: PaneSpot[]
    }
  }
}
