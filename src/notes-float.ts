// Personal Notes Floating Window
// Syncs with the main window's personal notes textarea

// Zoom Prevention
document.addEventListener('keydown', (e) => {
  const isMac = navigator.platform.toLowerCase().includes('mac')
  const isPrimaryMod = e.ctrlKey || (isMac && e.metaKey)
  const key = (e.key || '').toLowerCase()
  if (isPrimaryMod && (key === '+' || key === '=' || key === '-' || key === '_' || key === '0')) {
    e.preventDefault(); e.stopPropagation(); return false
  }
}, { capture: true })

document.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault(); e.stopPropagation(); return false
  }
}, { passive: false, capture: true })

document.addEventListener('gesturestart', (e) => { e.preventDefault() }, { passive: false, capture: true })
document.addEventListener('gesturechange', (e) => { e.preventDefault() }, { passive: false, capture: true })
document.addEventListener('gestureend', (e) => { e.preventDefault() }, { passive: false, capture: true })

window.addEventListener('DOMContentLoaded', () => {
  type NotesAPI = {
    onTransparencyUpdate: (handler: (opacity: number) => void) => () => void
    onStealthModeUpdate: (handler: (enabled: boolean, darkTheme: boolean) => void) => () => void
    onContentUpdated: (handler: (content: string) => void) => () => void
    onRecordingStatusUpdate: (handler: (isRecording: boolean) => void) => () => void
    updateContent: (content: string) => Promise<{ ok: boolean }>
    getContent: () => Promise<{ ok: boolean; content?: string }>
    requestSettings: () => Promise<{ ok: boolean }>
    stopRecording: () => Promise<{ ok: boolean }>
  }

  const notesAPI = (window as any).notes as NotesAPI | undefined
  const textarea = document.getElementById('personal-notes-textarea') as HTMLTextAreaElement
  const recordingControls = document.getElementById('recording-controls') as HTMLDivElement
  const aiStatus = document.getElementById('ai-status') as HTMLDivElement
  const aiPauseBtn = document.getElementById('ai-pause-btn') as HTMLButtonElement
  const aiStopBtn = document.getElementById('ai-stop-btn') as HTMLButtonElement
  let isPaused = false

  if (!textarea) {
    console.error('Personal notes textarea not found')
    return
  }

  // Listen for IPC messages from main process to sync notes
  let pendingRemoteContent: string | null = null
  let isDirty = false
  const flushContent = async (force = false) => {
    if (!force && !isDirty) return
    isDirty = false
    try {
      await notesAPI?.updateContent(textarea.value)
    } catch { }
  }
  ;(window as any).lifecycle?.onFlushRequest(() => flushContent())
  if (notesAPI?.onContentUpdated) {
    notesAPI.onContentUpdated((text: string) => {
      if (document.activeElement === textarea) {
        pendingRemoteContent = text
        return
      }
      if (textarea.value !== text) {
        textarea.value = text
      }
      pendingRemoteContent = null
    })
  }

  // Send updates back to main process when text changes
  textarea.addEventListener('input', () => {
    isDirty = true
  })
  textarea.addEventListener('blur', () => {
    if (pendingRemoteContent !== null && textarea.value !== pendingRemoteContent) {
      textarea.value = pendingRemoteContent
    }
    pendingRemoteContent = null
    void flushContent()
  })
  window.addEventListener('beforeunload', () => {
    void flushContent(true)
  })

  // Request initial notes content
  if (notesAPI?.getContent) {
    notesAPI.getContent().then((result) => {
      if (result.ok && result.content) {
        textarea.value = result.content
      }
    })
  }

  // Apply transparency settings from main window
  if (notesAPI?.onTransparencyUpdate) {
    notesAPI.onTransparencyUpdate((value: number) => {
      document.documentElement.style.setProperty('--bg-opacity', (1 - (value / 100)).toString())
    })
  }

  // Apply stealth mode settings
  if (notesAPI?.onStealthModeUpdate) {
    notesAPI.onStealthModeUpdate((enabled: boolean, darkTheme: boolean) => {
      if (enabled && darkTheme) {
        document.body.classList.add('stealth-mode')
      } else {
        document.body.classList.remove('stealth-mode')
      }
    })
  }

  // Listen for recording status updates
  const newNoteBtn = document.getElementById('new-note-btn') as HTMLButtonElement
  const startMeetingBtn = document.getElementById('start-meeting-btn') as HTMLButtonElement

  if (notesAPI?.onRecordingStatusUpdate) {
    notesAPI.onRecordingStatusUpdate((isRecording: boolean) => {
      if (isRecording) {
        document.body.classList.add('meeting-active')
        recordingControls?.classList.add('active')
        aiStatus?.classList.add('active')
        isPaused = false
        if (aiPauseBtn) {
          const pauseIcon = aiPauseBtn.querySelector('.pause-icon') as HTMLElement
          const resumeIcon = aiPauseBtn.querySelector('.resume-icon') as HTMLElement
          if (pauseIcon) pauseIcon.style.display = 'block'
          if (resumeIcon) resumeIcon.style.display = 'none'
          aiPauseBtn.classList.remove('paused')
        }
      } else {
        document.body.classList.remove('meeting-active')
        recordingControls?.classList.remove('active')
        aiStatus?.classList.remove('active')
        isPaused = false
        if (aiPauseBtn) {
          const pauseIcon = aiPauseBtn.querySelector('.pause-icon') as HTMLElement
          const resumeIcon = aiPauseBtn.querySelector('.resume-icon') as HTMLElement
          if (pauseIcon) pauseIcon.style.display = 'block'
          if (resumeIcon) resumeIcon.style.display = 'none'
          aiPauseBtn.classList.remove('paused')
        }
      }
    })
  }

  // Handle new note button click (saves current note if has content, then starts fresh)
  if (newNoteBtn) {
    newNoteBtn.addEventListener('click', async () => {
      const electron = (window as any).electron
      if (electron?.invoke) {
        try {
          // Tell main process to finalize current note and start fresh
          await flushContent(true)
          await electron.invoke('notes:newNote')
        } catch (e) {
          console.error('Failed to create new note:', e)
        }
      }
      // Clear the textarea for fresh input
      textarea.value = ''
    })
  }

  // Handle start meeting button click
  if (startMeetingBtn) {
    startMeetingBtn.addEventListener('click', async () => {
      const electron = (window as any).electron
      if (electron?.invoke) {
        try {
          await flushContent(true)
          // Trigger the recording flow from the main window
          await electron.invoke('meeting:startFromNotes')
        } catch (e) {
          console.error('Failed to start meeting:', e)
        }
      }
    })
  }

  // Handle pause button click
  if (aiPauseBtn) {
    aiPauseBtn.addEventListener('click', async () => {
      const electron = (window as any).electron
      if (electron?.invoke) {
        try {
          if (isPaused) {
            // Resume recording
            const result = await electron.invoke('meeting:resume')
            if (result?.ok) {
              isPaused = false
              const pauseIcon = aiPauseBtn.querySelector('.pause-icon') as HTMLElement
              const resumeIcon = aiPauseBtn.querySelector('.resume-icon') as HTMLElement
              if (pauseIcon) pauseIcon.style.display = 'block'
              if (resumeIcon) resumeIcon.style.display = 'none'
              aiPauseBtn.classList.remove('paused')
              const statusText = aiStatus?.querySelector('span')
              if (statusText) statusText.textContent = 'Recording'
            }
          } else {
            // Pause recording
            const result = await electron.invoke('meeting:pause')
            if (result?.ok) {
              isPaused = true
              const pauseIcon = aiPauseBtn.querySelector('.pause-icon') as HTMLElement
              const resumeIcon = aiPauseBtn.querySelector('.resume-icon') as HTMLElement
              if (pauseIcon) pauseIcon.style.display = 'none'
              if (resumeIcon) resumeIcon.style.display = 'block'
              aiPauseBtn.classList.add('paused')
              const statusText = aiStatus?.querySelector('span')
              if (statusText) statusText.textContent = 'Paused'
            }
          }
        } catch (e) {
          console.error('Failed to pause/resume:', e)
        }
      }
    })
  }

  // Handle stop button click
  if (aiStopBtn && notesAPI?.stopRecording) {
    aiStopBtn.addEventListener('click', async () => {
      // Immediately hide the status for instant feedback
      recordingControls?.classList.remove('active')
      await flushContent(true)
      // Send the stop command
      notesAPI.stopRecording().catch(() => { })
      // Hide the notes window immediately
      const electron = (window as any).electron
      if (electron?.invoke) {
        try {
          await electron.invoke('notes:hideWindow')
        } catch { }
      }
    })
  }

  // Request initial settings
  if (notesAPI?.requestSettings) {
    notesAPI.requestSettings()
  }

  // Initial focus
  setTimeout(() => {
    if (textarea) textarea.focus()
  }, 100)
})
