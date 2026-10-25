/**
 * Meeting Apps Configuration
 * 
 * Ignored-app approach: detect any microphone usage, filter out known false positives.
 * This is more robust than allowlisting - new meeting apps work automatically.
 */

/**
 * Apps that should NOT trigger mic-triggered meeting detection (false positive filters).
 * These are apps that use the microphone but are not conferencing/meeting apps.
 */
export const IGNORED_MIC_APPS: string[] = [
    // Our app
    'electron',
    'notto',

    // Audio Editors / DAWs
    'audacity',
    'garageband',
    'logic pro',
    'logicpro',
    'adobe audition',
    'audition',
    'ableton',
    'fl studio',
    'flstudio',
    'pro tools',
    'protools',
    'reaper',
    'cubase',
    'studio one',

    // Voice Recorders
    'voice memos',
    'voicememos',
    'quicktime player',
    'quicktime',
    'sound recorder',
    'voice recorder',

    // Audio Utilities
    'soundsource',
    'audio midi setup',
    'audiomidisetup',
    'boom 3d',
    'boom3d',
    'blackhole',
    'loopback',
    'krisp',  // Noise cancellation (runs alongside, not a meeting itself)

    // Screen Recorders (without video call)
    'screenflow',
    'camtasia',
    'snagit',

    // Music/Media Players (rare mic use but possible)
    'spotify',
    'apple music',
    'music',

    // Voice Assistants (brief mic access)
    'siri',
    'cortana',

    // Speech Recognition / Dictation (other than meetings)
    'dictation',
    'dragon',
    'talon',  // Voice coding

    // Games with voice chat (not meetings)
    'csgo',
    'cs2',
    'counter-strike',
    'counterstrike',
    'valorant',
    'fortnite',
    'fortniteclient',
    'call of duty',
    'cod',
    'modernwarfare',
    'warzone',
    'blackops',
    'rust',
    'rustclient',
    'ark',
    'shootergame',  // ARK's process name
    'apex legends',
    'apex',
    'r5apex',
    'pubg',
    'tslgame',  // PUBG's process name
    'overwatch',
    'overwatch 2',
    'league of legends',
    'leagueclient',
    'dota2',
    'dota',
    'minecraft',
    'javaw',  // Minecraft Java
    'roblox',
    'robloxplayer',
    'gta',
    'gtav',
    'gta5',
    'battlefield',
    'bf2042',
    'rainbow six',
    'rainbowsix',
    'r6',
    'destiny',
    'destiny2',
    'halo',
    'haloinfinite',
    'sea of thieves',
    'seaofthieves',
    'dead by daylight',
    'deadbydaylight',
    'hunt showdown',
    'huntshowdown',
    'tarkov',
    'escapefromtarkov',
    'world of warcraft',
    'wow',
    'wowclassic',
    'steam',
    'steamwebhelper',
    'epicgameslauncher',
    'origin',
    'battlenet',
    'arc raiders',
    'arcraiders',

    // System processes (already in SYSTEM_PROCESSES_TO_IGNORE but good to list)
    'coreaudiod',
    'audiodg',
];

/**
 * Legacy alias retained for compatibility with existing callers.
 */
export const NON_MEETING_APPS = IGNORED_MIC_APPS;

/**
 * System processes that should always be ignored (OS-level, not user apps)
 */
export const SYSTEM_PROCESSES_TO_IGNORE = [
    // Our app
    'electron',
    'notto',

    // Windows system
    'rundll32',
    'dllhost',
    'svchost',
    'audiodg',
    'systemsettings',
    'applicationframehost',
    'powerd',
    'searchhost',
    'runtimebroker',

    // macOS system  
    'coreaudiod',
    'securityagent',
    'tccd',
    'systemuiserver',
    'loginwindow',

    // Linux system
    'pulseaudio',
    'pipewire',
    'pipewire-pulse',
];

/**
 * Default meeting apps - kept for UI display and user reference.
 * NOT used for detection (we use ignored-app filtering instead).
 */
export const DEFAULT_MEETING_APPS: Record<string, string[]> = {
    // Video Conferencing - Primary
    zoom: ['zoom.us', 'zoom', 'zoomus', 'caphost', 'cpthost', 'zoomit', 'zoom_videosdk'],
    teams: ['microsoft teams', 'teams', 'msteams'],
    slack: ['slack', 'slackhelper', 'slack call'],
    googleMeet: ['meet.google.com'], // Detected via browser
    webex: ['webex', 'cisco webex', 'webexmeetingsapp', 'webexteams', 'ciscowebexstart'],

    // Video Conferencing - Other
    goToMeeting: ['gotomeeting', 'gotowebinar', 'g2mstart'],
    skype: ['skype', 'skype for business', 'lync', 'skypeforlinux'],
    facetime: ['facetime'],
    discord: ['discord'],
    whereby: ['whereby'],
    around: ['around'],
    loom: ['loom'],
    tuple: ['tuple'],
    pop: ['pop'],
    gather: ['gather'],
    livestorm: ['livestorm'],
    hopin: ['hopin'],
    streamyard: ['streamyard'],
    mmhmm: ['mmhmm'],

    // VOIP/Business Calling
    bluejeans: ['bluejeans', 'bluejeanshelper'],
    ringcentral: ['ringcentral', 'ringcentral app', 'glip'],
    vonage: ['vonage'],
    dialpad: ['dialpad'],
    talkdesk: ['talkdesk'],
    '8x8': ['8x8', '8x8 work'],
    aircall: ['aircall'],
    grasshopper: ['grasshopper'],

    // Screen Recording/Streaming (often involve meetings)
    obs: ['obs64', 'obs32', 'obs-studio'],

    // Browsers (for web-based meetings like Google Meet)
    chrome: ['google chrome', 'chrome', 'chromium'],
    safari: ['safari', 'webkit'],
    firefox: ['firefox', 'mozilla'],
    edge: ['microsoft edge', 'msedge', 'edge'],
    brave: ['brave browser', 'brave'],
    arc: ['arc'],
    opera: ['opera']
};

/**
 * Get all meeting app patterns as a flat array (for UI/reference)
 */
export function getAllMeetingAppPatterns(): string[] {
    return Object.values(DEFAULT_MEETING_APPS).flat();
}

/**
 * Get a display-friendly list of meeting app names (category names)
 */
export function getMeetingAppCategories(): string[] {
    return Object.keys(DEFAULT_MEETING_APPS);
}

/**
 * Check if a process should be excluded from mic-triggered meeting detection.
 * Returns true if the process is a known ignored app / false positive.
 */
export function isIgnoredMicApp(processName: string, ignoredApps: string[] = []): boolean {
    const lower = processName.toLowerCase();
    const allIgnoredApps = [...IGNORED_MIC_APPS, ...ignoredApps.map(a => a.toLowerCase())];
    return allIgnoredApps.some(pattern => lower.includes(pattern));
}

/**
 * Legacy alias retained for compatibility with existing callers.
 */
export function isNonMeetingApp(processName: string, customBlacklist: string[] = []): boolean {
    return isIgnoredMicApp(processName, customBlacklist);
}

/**
 * Check if a process is a system process that should be ignored
 */
export function isSystemProcess(processName: string): boolean {
    const lower = processName.toLowerCase();
    return SYSTEM_PROCESSES_TO_IGNORE.some(sys => lower === sys || lower.includes(sys));
}

/**
 * Check if a process is a browser (for special handling of web-based meetings)
 */
export function isBrowser(processName: string): boolean {
    const browserPatterns = [
        ...DEFAULT_MEETING_APPS.chrome,
        ...DEFAULT_MEETING_APPS.safari,
        ...DEFAULT_MEETING_APPS.firefox,
        ...DEFAULT_MEETING_APPS.edge,
        ...DEFAULT_MEETING_APPS.brave,
        ...DEFAULT_MEETING_APPS.arc,
        ...DEFAULT_MEETING_APPS.opera
    ];
    const lower = processName.toLowerCase();
    return browserPatterns.some(pattern => lower.includes(pattern));
}

// Legacy function kept for compatibility - now uses ignored-app filtering.
export function isMeetingApp(processName: string, customApps: string[] = []): boolean {
    const lower = processName.toLowerCase();
    const allPatterns = [...getAllMeetingAppPatterns(), ...customApps.map(a => a.toLowerCase())];
    return allPatterns.some(pattern => lower.includes(pattern));
}
