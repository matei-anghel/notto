(function () {
    try {
        const params = new URLSearchParams(location.search)
        let kind = params.get('k') || 'start'
        let audio = params.get('a') === '1'
        let vol = Math.max(0, Math.min(1, Number(params.get('v') || '0.4')))
        let vis = params.get('vis') === '1'
        let mode = params.get('mode') || 'dictation'
        let liveText = params.get('text') || ''
        const label = document.querySelector('.label')
        const soundwave = document.querySelector('.soundwave') as HTMLElement | null
        const hud = document.querySelector('.hud') as HTMLElement | null
        let audioCtx: AudioContext | null = null
        let audioWarmed = false

        // Listen for IPC updates from main process
        if ((window as any).electronAPI && (window as any).electronAPI.onHudUpdate) {
            (window as any).electronAPI.onHudUpdate((update: any) => {
                try {
                    // Update parameters from IPC message
                    if (update.kind !== undefined) kind = update.kind
                    if (update.audio !== undefined) audio = update.audio
                    if (update.vis !== undefined) vis = update.vis
                    if (update.mode !== undefined) mode = update.mode
                    if (update.vol !== undefined) vol = Math.max(0, Math.min(1, update.vol))
                    if (update.text !== undefined) liveText = String(update.text || '').trim()

                    // Handle reactive audio levels for soundwave bars
                    if (update.audioLevels && Array.isArray(update.audioLevels) && soundwave) {
                        const bars = soundwave.querySelectorAll('.bar')
                        bars.forEach((bar: Element, i: number) => {
                            const el = bar as HTMLElement
                            if (el && el.style && update.audioLevels[i] !== undefined) {
                                // Disable CSS animation and use direct height from audio levels
                                el.style.animation = 'none'
                                // Scale from 4px (silent) to 20px (loud) based on level (0-1)
                                const level = Math.max(0, Math.min(1, update.audioLevels[i]))
                                const height = 4 + level * 16
                                el.style.height = `${height}px`
                                el.style.opacity = `${0.35 + level * 0.65}`
                            }
                        })
                        // When receiving audio levels, skip applyState which would reset bars
                        return
                    }

                    // Apply updates
                    applyState()

                    // Play sound if audio is enabled
                    if (audio) {
                        playBeep()
                    }
                } catch (e) {
                    console.error('HUD update error:', e)
                }
            })
        }

        function applyState() {
            // Apply Agentic Dictation styling if needed
            if (mode === 'ai' && hud) {
                hud.classList.add('ai-mode')
            } else if (hud) {
                hud.classList.remove('ai-mode')
            }

            // Notice mode (setup hints): hide soundwave, extra width
            if (kind === 'notice' && hud) {
                hud.classList.add('notice-mode')
                // Increase max-width to accommodate longer text
                hud.style.maxWidth = '450px'
            } else if (hud) {
                hud.classList.remove('notice-mode')
                hud.style.maxWidth = ''
            }

            // Update label text based on mode and state
            // Only show text for live transcription or error states, not for "Dictating..." or "Processing..."
            if (label) {
                let showLabel = false
                if (liveText) {
                    label.textContent = truncateText(liveText, 60) // Increased truncation limit
                    showLabel = true
                } else if (kind === 'notice') {
                    // Use the provided text or default
                    label.textContent = liveText || ''
                    showLabel = true
                } else if (kind === 'no-mic') {
                    label.textContent = 'No microphone detected'
                    showLabel = true
                } else if (kind === 'too-short') {
                    label.textContent = 'Dictation too short'
                    showLabel = true
                } else {
                    // For normal dictation (start/stop), just show the soundwave, no text
                    label.textContent = ''
                }

                // Toggle visibility via CSS class
                if (showLabel) {
                    label.classList.add('has-content')
                } else {
                    label.classList.remove('has-content')
                }
            }

            // Flatline soundwave for stop, too-short, no-mic states
            if (soundwave && (kind === 'stop' || kind === 'too-short' || kind === 'no-mic')) {
                // Remove animation and set minimal height for all bars
                soundwave.style.display = ''
                soundwave.querySelectorAll('.bar').forEach((bar) => {
                    const el = bar as HTMLElement
                    if (el && el.style) {
                        el.style.animation = 'none'
                        el.style.height = '4px'
                        el.style.opacity = '0.35'
                    }
                })
            } else if (soundwave && kind === 'notice') {
                // Completely hide soundwave for notices
                soundwave.style.display = 'none'
            } else if (soundwave) {
                // Restore animation for start state
                soundwave.style.display = ''
                soundwave.querySelectorAll('.bar').forEach((bar) => {
                    const el = bar as HTMLElement
                    if (el && el.style) {
                        el.style.animation = ''
                        el.style.height = ''
                        el.style.opacity = ''
                    }
                })
            }

            if (!vis && hud) hud.style.display = 'none'
            else if (hud) hud.style.display = ''
        }

        function getAudioContext(): AudioContext {
            const AC = window.AudioContext || (window as any).webkitAudioContext
            if (!AC) throw new Error('No AudioContext')
            if (!audioCtx) audioCtx = new AC()
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => { })
            }
            return audioCtx
        }

        function warmAudioContext() {
            if (audioWarmed) return
            try {
                const ctx = getAudioContext()
                const buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
                const source = ctx.createBufferSource()
                const gain = ctx.createGain()
                gain.gain.value = 0.00001
                source.buffer = buffer
                source.connect(gain).connect(ctx.destination)
                const now = ctx.currentTime
                source.start(now)
                source.stop(now + 0.02)
                audioWarmed = true
            } catch { }
        }

        function playBeep() {
            const beepWebAudio = () => {
                const ctx = getAudioContext()
                const now = ctx.currentTime

                // Main body oscillator and filters
                const osc = ctx.createOscillator()
                const hp = ctx.createBiquadFilter()
                const lp = ctx.createBiquadFilter()
                const gain = ctx.createGain()

                // Subtle tactile transient (short bandpassed noise)
                const noise = ctx.createBufferSource()
                const nb = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.04), ctx.sampleRate)
                const ch = nb.getChannelData(0)
                for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.9
                noise.buffer = nb
                const bpf = ctx.createBiquadFilter()
                const nGain = ctx.createGain()

                const baseAmp = Math.max(0.005, Math.min(0.12, vol * 0.5))

                // Tone shaping
                try { osc.type = 'sine' } catch { }
                try { hp.type = 'highpass'; hp.frequency.value = 60; hp.Q.value = 0.707 } catch { }
                try { lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.707 } catch { }
                try { bpf.type = 'bandpass'; bpf.frequency.value = 1200; bpf.Q.value = 2.0 } catch { }

                // Routing
                osc.connect(hp).connect(lp).connect(gain).connect(ctx.destination)
                noise.connect(bpf).connect(nGain).connect(ctx.destination)

                // Initial levels
                gain.gain.setValueAtTime(0.0001, now)
                nGain.gain.setValueAtTime(0.0001, now)

                if (kind === 'start') {
                    // Start: low–high two-tone chirp (440 Hz, gap, 660 Hz)
                    const t1 = 0.11, gap = 0.06, t2 = 0.15
                    osc.frequency.setValueAtTime(440, now)
                    gain.gain.exponentialRampToValueAtTime(baseAmp, now + 0.010)
                    gain.gain.exponentialRampToValueAtTime(0.0001, now + t1)

                    osc.frequency.setValueAtTime(660, now + t1 + gap)
                    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, baseAmp * 0.9), now + t1 + gap + 0.010)
                    gain.gain.exponentialRampToValueAtTime(0.0001, now + t1 + gap + t2)

                    // Subtle tick at onset
                    nGain.gain.exponentialRampToValueAtTime(Math.min(0.16, baseAmp * 1.6), now + 0.006)
                    nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05)

                    osc.start(now)
                    noise.start(now)
                    osc.stop(now + t1 + gap + t2 + 0.05)
                    noise.stop(now + 0.06)
                } else {
                    // Stop: high–low two-tone chirp (700 Hz -> 440 Hz)
                    const t1 = 0.09, gap = 0.04, t2 = 0.12
                    osc.frequency.setValueAtTime(700, now)
                    gain.gain.exponentialRampToValueAtTime(baseAmp * 0.9, now + 0.010)
                    gain.gain.exponentialRampToValueAtTime(0.0001, now + t1)

                    osc.frequency.setValueAtTime(440, now + t1 + gap)
                    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, baseAmp * 0.8), now + t1 + gap + 0.010)
                    gain.gain.exponentialRampToValueAtTime(0.0001, now + t1 + gap + t2)

                    // Softer tick
                    nGain.gain.exponentialRampToValueAtTime(Math.min(0.12, baseAmp * 1.2), now + 0.006)
                    nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04)

                    osc.start(now)
                    noise.start(now)
                    osc.stop(now + t1 + gap + t2 + 0.05)
                    noise.stop(now + 0.05)
                }
            }
            try {
                beepWebAudio()
            } catch {
                const tone = document.getElementById('tone') as HTMLAudioElement
                const up = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABYAAAABAACAgICA//8AAP//AA=='
                const down = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABYAAAABAAD///8A////AIAAAACAAQ=='
                tone.volume = vol
                if (kind === 'start') {
                    tone.src = up
                    tone.play().catch(() => { })
                    setTimeout(() => { try { tone.src = up; tone.play().catch(() => { }) } catch { } }, 170)
                } else {
                    tone.src = down
                    tone.play().catch(() => { })
                }
            }
        }

        function truncateText(value: string, maxLen: number) {
            if (!value || value.length <= maxLen) return value
            return value.slice(0, Math.max(0, maxLen - 3)) + '...'
        }

        // Pre-warm audio so first beep is instant
        warmAudioContext()

        // Initial setup - apply state immediately from URL params
        applyState()

        // Play audio with a small delay to ensure AudioContext is ready
        if (audio) {
            // Use requestAnimationFrame + setTimeout for reliable audio playback
            requestAnimationFrame(() => {
                setTimeout(() => playBeep(), 30)
            })
        }
    } catch { }
})()
