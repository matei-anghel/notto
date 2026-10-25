declare module 'uiohook-napi' {
  export interface UiohookKeyboardEvent {
    type: 'keydown' | 'keyup' | string
    keycode?: number
    rawcode?: number
    altKey?: boolean
    shiftKey?: boolean
    ctrlKey?: boolean
    metaKey?: boolean
  }

  export const uIOhook: {
    start: () => void
    stop: () => void
    on: (event: 'keydown' | 'keyup', handler: (ev: UiohookKeyboardEvent) => void) => void
    removeAllListeners: () => void
  }
}


