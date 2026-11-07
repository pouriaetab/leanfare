// The leanfare-level mod's values in the session (0.15.4): the Leanfare row above the message box.
export type Row = {
  level: 'knob' | 'off' | '2' | '3' | '4' | '5' // the knob in Leanfare, off in this chat, or a level for this chat
  speed: 'app' | 'fastest' | 'balanced' | 'cheapest' // as Leanfare's Settings say, or a speed for this chat
  quality: 'standard' | 'high' // high: each part one effort step up, so a stronger model takes it
  only: 'any' | 'claude' // claude: every part on Claude's own models, nothing to outside models
}

declare module 'claude-code' {
  interface PluginState {
    'leanfare-level': { row: Row }
  }
}
