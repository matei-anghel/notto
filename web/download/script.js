// GitHub Releases Configuration
const GITHUB_OWNER = 'matei-anghel';
const GITHUB_REPO = 'notto';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

// Platform detection
function detectOS() {
    const platform = navigator.platform.toLowerCase();
    const userAgent = navigator.userAgent.toLowerCase();

    if (platform.includes('win') || userAgent.includes('windows')) {
        return 'windows';
    } else if (platform.includes('mac') || userAgent.includes('mac')) {
        // Try to detect version
        const versionMatch = userAgent.match(/mac os x (\d+)[._](\d+)/);
        if (versionMatch) {
            const major = parseInt(versionMatch[1]);
            // macOS 16+ is Tahoe+ style
            if (major >= 16) {
                return 'macos-tahoe';
            }
        }
        return 'macos';
    } else if (platform.includes('linux') || userAgent.includes('linux')) {
        return 'linux';
    }
    return 'unknown';
}

// Get asset URL by platform
function getAssetForPlatform(assets, platform) {
    const patterns = {
        windows: /\.exe$/i,
        macos: /\.dmg$/i,
        linux: /\.AppImage$/i
    };

    const assetPlatform = platform.startsWith('macos') ? 'macos' : platform;
    const pattern = patterns[assetPlatform];
    if (!pattern) return null;

    const asset = assets.find(a => pattern.test(a.name));
    return asset ? asset.browser_download_url : null;
}

// Format date
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric'
    });
}

// Show the installation guide for the given platform
function showGuideForPlatform(platform) {
    // Hide all guides first
    const guides = ['windowsGuide', 'macTahoeGuide', 'macLegacyGuide', 'linuxGuide'];
    guides.forEach(id => {
        const guide = document.getElementById(id);
        if (guide) {
            guide.classList.remove('visible');
        }
    });

    // Show the appropriate guide
    const guideMap = {
        windows: 'windowsGuide',
        macos: 'macTahoeGuide', // Default mac to Tahoe
        'macos-tahoe': 'macTahoeGuide',
        'macos-legacy': 'macLegacyGuide',
        linux: 'linuxGuide'
    };

    const guideId = guideMap[platform];
    if (guideId) {
        const guide = document.getElementById(guideId);
        if (guide) {
            guide.classList.add('visible');
            // Scroll to the guide
            setTimeout(() => {
                guide.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        }
    }
}


// Setup copy buttons for command blocks
function setupCopyButtons() {
    const copyButtons = document.querySelectorAll('.copy-btn');

    copyButtons.forEach(button => {
        button.addEventListener('click', () => {
            const container = button.closest('.code-block-container');
            const code = container.querySelector('code');
            const textToCopy = code.textContent;

            navigator.clipboard.writeText(textToCopy).then(() => {
                const span = button.querySelector('span');
                const originalText = span.textContent;
                const originalSvg = button.querySelector('svg').outerHTML;

                button.classList.add('copied');
                span.textContent = 'Copied!';

                // Show checkmark icon
                button.querySelector('svg').outerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

                setTimeout(() => {
                    button.classList.remove('copied');
                    span.textContent = originalText;
                    button.querySelector('svg').outerHTML = originalSvg;
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy text: ', err);
            });
        });
    });
}

// Initialize the page
async function init() {
    const os = detectOS();
    const downloadBtn = document.getElementById('downloadBtn');
    const downloadBtnText = document.getElementById('downloadBtnText');
    const versionInfo = document.getElementById('versionInfo');
    const winLink = document.getElementById('winLink');
    const macLink = document.getElementById('macLink');
    const linuxLink = document.getElementById('linuxLink');

    const heroTitle = document.querySelector('.hero h1');
    const heroTagline = document.querySelector('.tagline');

    // Fetch latest release
    try {
        const response = await fetch(RELEASES_API);
        if (!response.ok) throw new Error('Failed to fetch release');

        const release = await response.json();
        const version = release.tag_name || release.name;
        const publishedDate = formatDate(release.published_at);

        // Update version info
        if (versionInfo) {
            versionInfo.textContent = `Version ${version} • Released ${publishedDate}`;
        }

        // Auto-download logic
        const mainAssetUrl = getAssetForPlatform(release.assets, os);

        if (mainAssetUrl) {
            // Update UI to "Thank you" state
            if (heroTitle) heroTitle.textContent = "Thank you for downloading Notto!";
            if (heroTagline) heroTagline.innerHTML = "Your download is starting...<br>If it doesn't start automatically, click the button below.";

            downloadBtn.href = mainAssetUrl;
            if (downloadBtnText) downloadBtnText.textContent = "Restart Download";

            // Show the guide immediately
            showGuideForPlatform(os);

            // Trigger download after a requested delay
            setTimeout(() => {
                window.location.href = mainAssetUrl;
            }, 1500);

        } else {
            // Fallback
            if (downloadBtnText) downloadBtnText.textContent = 'Download';
        }

        // Set platform links
        const platforms = {
            windows: winLink,
            macos: macLink,
            linux: linuxLink
        };

        for (const [platform, link] of Object.entries(platforms)) {
            if (link) {
                const url = getAssetForPlatform(release.assets, platform);
                if (url) {
                    link.href = url;
                    link.addEventListener('click', () => {
                        showGuideForPlatform(platform);
                    });
                } else {
                    link.style.opacity = '0.5';
                    link.style.pointerEvents = 'none';
                    link.title = 'Not available';
                }
            }
        }

        // Initialize copy buttons
        setupCopyButtons();

    } catch (error) {
        console.error('Failed to fetch release info:', error);
        if (versionInfo) {
            versionInfo.textContent = 'Unable to load version info';
        }

        // Fallback: link to releases page
        downloadBtn.href = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
        if (downloadBtnText) downloadBtnText.textContent = 'View Downloads';
    }
}

// Run on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
