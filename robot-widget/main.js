const { app, BrowserWindow, screen, protocol, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const { generateSpeech } = require('./tts.js');
const { askGemini } = require('./gemini.js');
const { transcribeAudio } = require('./stt.js');
const { startLiveSession, sendAudioChunk, sendTextChunk, endLiveSession } = require('./live.js');

// Terminate Chromium's Autoplay sandbox. We are a desktop app, not a website!
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
    { scheme: 'appassets', privileges: { standard: true, supportFetchAPI: true, secure: true, bypassCSP: true } }
]);

const WINDOW_WIDTH = 250;
const WINDOW_HEIGHT = 350;

let mainWindow = null;

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        x: width - WINDOW_WIDTH,
        y: height - WINDOW_HEIGHT,
        show: false,

        // Appearance
        transparent: true,
        frame: false,
        hasShadow: false,
        backgroundColor: '#00000000',

        // Behaviour
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,

        // On Linux (KDE/X11/Wayland) we set type to 'toolbar' so the compositor
        // renders it above the desktop without stealing focus.
        ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),

        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false   // needed to load local file:// model assets
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Keep it on top even when other windows are fullscreen (macOS / Windows)
    mainWindow.setAlwaysOnTop(true, 'screen-saver');

    // Allow click-through on the transparent parts
    // We enable mouse events initially so Three.js can receive them if needed
    mainWindow.setIgnoreMouseEvents(false);

    // On Linux with Wayland transparency sometimes needs a compositor hint
    if (process.platform === 'linux') {
        mainWindow.setBackgroundColor('#00000000');
    }
}

let dragOffset = null;

ipcMain.on('drag-start', (event, { x, y }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const bounds = win.getBounds();
    dragOffset = { x: x - bounds.x, y: y - bounds.y };
});

ipcMain.on('drag-move', (event, { x, y }) => {
    if (!dragOffset) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    win.setBounds({
        x: Math.round(x - dragOffset.x),
        y: Math.round(y - dragOffset.y),
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT
    });
});

let chatWin = null;
function createChatWindow() {
    if (chatWin) {
        if (chatWin.isMinimized()) chatWin.restore();
        chatWin.focus();
        return;
    }

    chatWin = new BrowserWindow({
        width: 400,
        height: 500,
        title: 'Comms Channel',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    chatWin.loadFile(path.join(__dirname, 'chat.html'));

    chatWin.on('closed', () => {
        chatWin = null;
    });
}

let browserWin = null;
function openBrowser(data) {
    console.log('🌍 Opening Browser Agent...');
    if (!browserWin) {
        createBrowserWindow();
    }

    const navigate = () => {
        if (!data) return;
        let url;
        if (typeof data === 'string') {
            url = data.startsWith('www.') ? `https://${data}` : data;
        } else if (data.platform === 'youtube') {
            url = `https://www.youtube.com/results?search_query=${encodeURIComponent(data.query)}`;
        } else if (data.platform === 'google') {
            url = `https://www.google.com/search?q=${encodeURIComponent(data.query)}`;
        }

        if (url) {
            console.log('📡 Browser: Navigating to', url);
            browserWin.webContents.send('navigate', url);
        }
    };

    if (browserWin.isVisible()) {
        navigate();
    } else {
        browserWin.once('ready-to-show', navigate);
        browserWin.show();
    }
}

function scrollBrowser(direction) {
    if (browserWin) browserWin.webContents.send('scroll', direction);
}

function closeBrowser() {
    if (browserWin) {
        browserWin.close();
        browserWin = null;
    }
}

function getDomMap() {
    if (browserWin) {
        browserWin.webContents.send('get-dom-map');
    } else {
        ipcMain.emit('dom-map-available', []);
    }
}

function clickBrowserId(id) {
    if (browserWin) browserWin.webContents.send('click-id', id);
}

function smartClickBrowser(text) {
    if (browserWin) browserWin.webContents.send('click-text', text);
}

const Automation = {
    openBrowser,
    scrollBrowser,
    closeBrowser,
    getDomMap,
    clickBrowserId,
    smartClickBrowser,
    executeCommand: async (cmd) => {
        return await executeAutomationInternal(cmd);
    },
    focusApp: async (appName) => {
        return await focusAppInternal(appName);
    }
};

function createBrowserWindow() {
    if (browserWin) {
        if (browserWin.isMinimized()) browserWin.restore();
        browserWin.focus();
        return;
    }

    browserWin = new BrowserWindow({
        width: 1024,
        height: 768,
        title: 'Nova Browser Agent',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true // CRITICAL: Enables <webview> in the browser.html
        }
    });

    browserWin.loadFile(path.join(__dirname, 'browser.html'));

    browserWin.on('closed', () => {
        browserWin = null;
    });
}

ipcMain.on('open-chat', () => {
    createChatWindow();
});

ipcMain.handle('ask-grok', async (event, text) => {
    return await askGemini(text);
});

ipcMain.handle('transcribe-audio', async (event, buffer) => {
    try {
        return await transcribeAudio(buffer);
    } catch (e) {
        console.error('❌ Transcription error in main:', e);
        return '';
    }
});

// Real-time IPC Hooks
ipcMain.on('live-start', (event) => {
    startLiveSession(mainWindow, Automation);
});

ipcMain.on('live-audio-chunk', (event, base64Data) => {
    sendAudioChunk(base64Data);
});

ipcMain.on('live-text-chunk', (event, text) => {
    sendTextChunk(text);
});

ipcMain.on('live-end', (event) => {
    endLiveSession();
});

ipcMain.handle('browser-open', async (event, data) => {
    openBrowser(data);
    return true;
});

ipcMain.on('browser-scroll', (event, direction) => {
    scrollBrowser(direction);
});

ipcMain.on('browser-close', () => {
    closeBrowser();
});

ipcMain.on('browser-get-map', (event) => {
    getDomMap();
});

ipcMain.on('dom-map-results', (event, map) => {
    console.log(`🧠 Bridge: Received DOM Map (${map?.length || 0} elements) from Browser.`);
    if (mainWindow) mainWindow.webContents.send('browser-dom-map', map);
    // Also emit to ipcMain for live.js to pick up
    ipcMain.emit('dom-map-available', map);
});

ipcMain.on('browser-click-id', (event, id) => {
    clickBrowserId(id);
});

ipcMain.on('browser-click', (event, target) => {
    smartClickBrowser(target);
});

// Helper for cross-platform keyboard emulation
async function emulatePlaySequence(window) {
    if (window) window.webContents.send('automation-log', "🎹 Starting YouTube Play Automation...");
    console.log("🎹 Starting YouTube Play Automation...");

    // Give the browser time to open and load the YouTube page
    await new Promise(r => setTimeout(r, 5000));

    const runCmd = (cmd) => new Promise((resolve) => {
        exec(cmd, (err, stdout) => {
            if (err) console.error("🎹 Cmd failed:", err.message);
            resolve(stdout ? stdout.trim() : '');
        });
    });
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    // Get screen dimensions via Electron's screen module for accurate click coords
    const displayBounds = screen.getPrimaryDisplay().bounds;
    const screenW = displayBounds.width;
    const screenH = displayBounds.height;
    console.log(`🎹 Screen: ${screenW}x${screenH}`);

    // Helper: resolve browser window ID (X11 only)
    const getBrowserWinId = async () => {
        let winId = await runCmd(`xdotool search --name "YouTube" 2>/dev/null | head -1`);
        if (!winId) {
            winId = await runCmd(
                `xdotool search --onlyvisible --class "brave|Brave-browser|firefox|Firefox|chromium|Chromium|chrome|Google-chrome" 2>/dev/null | head -1`
            );
        }
        return winId;
    };

    const isWayland = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');

    try {
        // ── Focus browser ────────────────────────────────────────────────────
        let winId = null;
        if (process.platform === 'darwin') {
            const browsers = ['Google Chrome', 'Brave Browser', 'Firefox', 'Safari'];
            for (const b of browsers) {
                const r = await runCmd(`osascript -e 'tell application "${b}" to activate' 2>/dev/null && echo ok`);
                if (r.includes('ok')) break;
            }
            await delay(500);
        } else if (process.platform === 'win32') {
            await runCmd(`powershell -command "$p=(Get-Process | Where-Object {$_.MainWindowTitle -match 'YouTube'} | Select-Object -First 1); if($p){Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W32{[DllImport(\\"user32.dll\\")]public static extern bool SetForegroundWindow(IntPtr h);}';[W32]::SetForegroundWindow($p.MainWindowHandle)}"`);
            await delay(300);
        } else if (!isWayland) {
            // X11: get browser window by ID and focus it
            winId = await getBrowserWinId();
            if (winId) {
                if (window) window.webContents.send('automation-log', `🎹 Focusing browser (ID: ${winId})...`);
                await runCmd(`xdotool windowactivate --sync ${winId}`);
                await delay(400);
            }
        }
        // Wayland: wmctrl focus attempt (may fail, ydotool sends globally)
        if (isWayland) {
            await runCmd(`wmctrl -a "YouTube" 2>/dev/null; wmctrl -a "brave" 2>/dev/null; wmctrl -a "firefox" 2>/dev/null; true`);
            await delay(400);
        }

        // ── Press 'k' to play ────────────────────────────────────────────────
        if (window) window.webContents.send('automation-log', "▶️ Pressing play...");
        if (process.platform === 'darwin') {
            await runCmd(`osascript -e 'tell application "System Events" to keystroke "k"'`);
        } else if (process.platform === 'win32') {
            await runCmd(`powershell -command "$s=New-Object -ComObject WScript.Shell; $s.SendKeys('k')"`);
        } else if (isWayland) {
            await runCmd(`ydotool key 37:1 37:0`); // k = play/pause
        } else if (winId) {
            await runCmd(`xdotool key --window ${winId} k`);
        } else {
            await runCmd(`xdotool key k`);
        }


        if (window) window.webContents.send('automation-log', "✅ Playback sequence complete!");
        console.log("🎹 Keyboard Emulation Success");
    } catch (e) {
        console.error("🎹 Keyboard Emulation Error:", e);
        if (window) window.webContents.send('automation-log', "❌ Playback automation failed.");
    }
}



ipcMain.handle('browser-search', async (event, { platform, query }) => {
    if (platform === 'youtube') {
        try {
            console.log(`🔍 Attempting Super-Lucky async search for: ${query}`);
            // Use promise-wrapped exec to find the ID without hanging main thread
            const videoId = await new Promise((resolve, reject) => {
                exec(`yt-dlp --get-id "ytsearch1:${query}"`, (err, stdout) => {
                    if (err) reject(err);
                    else resolve(stdout.trim());
                });
            });

            if (videoId && videoId.length < 20) {
                console.log(`✅ Super-Lucky success: ${videoId}`);
                const url = `https://www.youtube.com/watch?v=${videoId}`;
                createBrowserWindow();
                setTimeout(() => {
                    if (browserWin) browserWin.webContents.send('navigate', url);
                }, 500);
                return true;
            }
        } catch (e) {
            console.error("Super-Lucky failed, falling back to results page:", e);
        }
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        createBrowserWindow();
        setTimeout(() => {
            if (browserWin) browserWin.webContents.send('navigate', searchUrl);
        }, 500);
        emulatePlaySequence(mainWindow); // Trigger automation
    } else {
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        createBrowserWindow();
        setTimeout(() => {
            if (browserWin) browserWin.webContents.send('navigate', url);
        }, 500);
    }
    return true;
});

// Internal helper for spawning processes
function executeCommand(command, description) {
    console.log(`🌐 Executing: ${description}`);
    console.log(`🔧 Command: ${command}`);

    return new Promise((resolve, reject) => {
        const isSilent = command.includes('playerctl');
        const process = spawn(command, { shell: true, stdio: isSilent ? 'ignore' : 'pipe' });

        process.stdout.on('data', (data) => {
            console.log(`✅ Command output: ${data.toString().trim()}`);
        });

        process.stderr.on('data', (data) => {
            console.error(`❌ Command error: ${data.toString().trim()}`);
        });

        process.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ Automation action executed successfully!`);
                resolve(true);
            } else {
                console.error(`❌ Command failed with code: ${code}`);
                resolve(false);
            }
        });
    });
}

async function executeAutomationInternal(command) {
    const cmd = command.toLowerCase().trim();
    console.log('🔧 Processing automation command:', cmd);

    // 0. Hotkey: Play/Pause (k or space)
    if (cmd === 'press-k' || cmd === 'stop-media' || cmd === 'pause' || cmd === 'play') {
        const platform = process.platform;
        if (platform === 'linux') {
            const windowSearch = `(xdotool search --onlyvisible --name "Nova Browser Agent" 2>/dev/null || xdotool search --onlyvisible --name "YouTube" 2>/dev/null || xdotool search --onlyvisible --class "zen" 2>/dev/null) | head -1`;
            const action = `WID=$(${windowSearch}); if [ ! -z "$WID" ]; then xdotool windowactivate --sync $WID && xdotool windowfocus --sync $WID && xdotool key --clearmodifiers k || xdotool key --clearmodifiers space; else xdotool key k || xdotool key space; fi`;
            exec(action);
        } else if (platform === 'darwin') {
            const action = `osascript -e 'tell application "System Events" to tell process "Electron" to set frontmost to true' -e 'tell application "System Events" to key code 40'`; // 40 = k
            exec(action);
        } else if (platform === 'win32') {
            const action = `powershell -Command "$obj = New-Object -ComObject WScript.Shell; if ($obj.AppActivate('Nova Browser Agent')) { $obj.SendKeys('k') } else { $obj.SendKeys('k') }"`;
            exec(action);
        }
        return 'Toggled playback hotkey.';
    }

    // 1. System Volume Control (Smooth 5% steps)
    if (cmd === 'increase-volume') {
        const platform = process.platform;
        if (platform === 'linux') exec('pactl set-sink-volume @DEFAULT_SINK@ +5%');
        else if (platform === 'darwin') exec('osascript -e "set volume output volume ((output volume of (get volume settings)) + 5)"');
        else if (platform === 'win32') exec('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]175)"');
        return 'Increased volume.';
    }
    if (cmd === 'decrease-volume') {
        const platform = process.platform;
        if (platform === 'linux') exec('pactl set-sink-volume @DEFAULT_SINK@ -5%');
        else if (platform === 'darwin') exec('osascript -e "set volume output volume ((output volume of (get volume settings)) - 5)"');
        else if (platform === 'win32') exec('powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]174)"');
        return 'Decreased volume.';
    }

    // 2. PRIORITY: Application Closing (Catch this before "Opening" logic matches keywords like 'code')
    if (cmd.includes('close ') || cmd.includes('terminate ') || cmd.startsWith('close-')) {
        const appName = cmd.replace(/close |terminate |close-/g, '').trim();
        const platform = process.platform;

        const closeAppMap = {
            'vscode': 'code',
            'visual studio code': 'code',
            'browser': platform === 'linux' ? 'zen' : platform === 'darwin' ? 'Safari' : 'msedge',
            'chrome': platform === 'linux' ? 'google-chrome' : 'Google Chrome',
            'firefox': platform === 'linux' ? 'firefox' : 'Firefox'
        };
        const target = closeAppMap[appName] || appName;

        console.log(`📡 Terminating app: ${target} (parsed from: ${appName})`);

        if (platform === 'win32') {
            exec(`taskkill /IM ${target}.exe /F /T`);
        } else {
            exec(`pkill -i -f "${target}"`);
        }
        return `Closing ${target}.`;
    }

    // 3. Specific Website/URL Opening
    if (cmd.includes('http') || cmd.includes('www.') || cmd.includes('open website')) {
        let url = command.split(' ').find(word => word.includes('http') || word.includes('www.'));
        if (!url && cmd.includes('open website')) {
            url = cmd.replace(/open website/i, '').trim();
        }
        if (url) {
            console.log('🌐 Rerouting specific URL to Internal Browser Agent:', url);
            openBrowser(url);
            return `Opening requested link: ${url}`;
        }
    }

    // 4. Folder commands
    if (cmd.includes('folder') || cmd.includes('directory') || cmd.includes('dir')) {
        const homeDir = app.getPath('home');
        let targetPath = homeDir;
        let folderName = 'Home';

        if (cmd.includes('documents')) {
            targetPath = app.getPath('documents');
            folderName = 'Documents';
        } else if (cmd.includes('downloads')) {
            targetPath = app.getPath('downloads');
            folderName = 'Downloads';
        } else if (cmd.includes('desktop')) {
            targetPath = app.getPath('desktop');
            folderName = 'Desktop';
        }

        console.log(`📂 Opening path: ${targetPath}`);
        shell.openPath(targetPath);
        return `${folderName} folder opened.`;
    }

    // 5. UNIFIED INTERNAL BROWSER ROUTING
    if (cmd.match(/\b(youtube|you tube|play song|play|video)\b/i)) {
        let searchTerm = cmd.replace(/search|play song|play|youtube|you tube|video/gi, '').trim();
        openBrowser({ platform: 'youtube', query: searchTerm || 'youtube' });
        return `Opening ${searchTerm || 'YouTube'} in Internal Browser.`;
    }

    if (cmd.match(/\b(google|search|browser|web)\b/i)) {
        let searchTerm = cmd.replace(/search|google|browser|web|open browser/gi, '').trim();
        openBrowser({ platform: 'google', query: searchTerm || 'google' });
        return `Opening ${searchTerm || 'Google'} in Internal Browser.`;
    }

    // 6. Generic Application Management (Catch-all for opening/focusing)
    if (cmd.includes('open ') || cmd.includes('launch ') || cmd.includes('focus ')) {
        const appName = cmd.replace(/open |launch |focus /g, '').trim();
        return await focusAppInternal(appName);
    }

    // Fallback for direct app keywords (if AI didn't prepend "open")
    const commonApps = ['vscode', 'code', 'terminal', 'zoom', 'files', 'chrome', 'firefox'];
    if (commonApps.includes(cmd)) {
        return await focusAppInternal(cmd);
    }

    return "I processed your command, but it was not a recognized system utility.";
}

// Redundant helpers removed to consolidate logic above.

ipcMain.handle('stop-media', async () => {
    try {
        let stopCmd = 'playerctl pause';
        if (process.platform === 'darwin') {
            stopCmd = 'osascript -e "tell application \\"System Events\\" to key code 49"'; // Simulate Space
        } else if (process.platform === 'win32') {
            stopCmd = 'powershell -command "(New-Object -ComObject Shell.Application).PlayPause()"'; // Fallback
        }
        await executeCommand(stopCmd, 'Stopping all music/media');
        return true;
    } catch (e) {
        return false;
    }
});

ipcMain.handle('play-media', async () => {
    try {
        let playCmd = 'playerctl play';
        if (process.platform === 'darwin') {
            playCmd = 'osascript -e "tell application \\"System Events\\" to key code 49"'; // Simulate Space
        } else if (process.platform === 'win32') {
            playCmd = 'powershell -command "(New-Object -ComObject Shell.Application).PlayPause()"'; // Fallback
        }
        await executeCommand(playCmd, 'Playing music/media');
        return true;
    } catch (e) {
        return false;
    }
});

ipcMain.handle('switch-window', async () => {
    try {
        console.log('🔄 Switching to next window (Alt+Tab simulation)...');
        let cmd = '';
        if (process.platform === 'darwin') {
            // macOS: Cmd+Tab
            cmd = `osascript -e 'tell application "System Events" to key code 48 using {command down}'`;
        } else if (process.platform === 'win32') {
            // Windows: Alt+Tab via WScript.Shell
            cmd = `powershell -command "$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys('%{TAB}')"`;
        } else {
            // Linux: try xdotool first (X11), fall back to ydotool (Wayland)
            const isWayland = process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland';
            if (isWayland) {
                // ydotool: hold Alt (56), press and release Tab (15), release Alt
                cmd = `ydotool key 56:1 15:1 15:0 56:0`;
            } else {
                cmd = `xdotool key alt+Tab`;
            }
        }
        await new Promise((resolve) => {
            exec(cmd, (err) => {
                if (err) console.error('🔄 switch-window error:', err);
                resolve();
            });
        });
        return true;
    } catch (e) {
        console.error('🔄 switch-window exception:', e);
        return false;
    }
});

// ── App focus / launch map ─────────────────────────────────────────────────
// Keys are lowercase aliases the user might say.
// `classes`  = regex matched against WM_CLASS / window title  (xdotool/wmctrl)
// `launch`   = shell command to start the app if no window found
// `macosApp` = macOS app name for `open -a`
// `winExe`   = Windows executable / Start-Process target
const APP_FOCUS_MAP = {
    // ── Browsers ──────────────────────────────────────────────────────────
    browser: { classes: 'firefox|chromium|brave|chrome|Brave-browser|opera|vivaldi', launch: 'xdg-open https://www.google.com', macosApp: 'Safari', winExe: 'start microsoft-edge:' },
    firefox: { classes: 'firefox|Firefox', launch: 'firefox', macosApp: 'Firefox', winExe: 'firefox' },
    chrome: { classes: 'google-chrome|chromium|Chromium|brave|Brave-browser', launch: 'google-chrome || chromium || brave', macosApp: 'Google Chrome', winExe: 'chrome' },
    chromium: { classes: 'chromium|Chromium', launch: 'chromium', macosApp: 'Chromium', winExe: 'chromium' },
    brave: { classes: 'brave|Brave-browser', launch: 'brave || brave-browser', macosApp: 'Brave Browser', winExe: 'brave' },
    // ── Code editors / IDEs ───────────────────────────────────────────────
    vscode: { classes: 'code|Code|vscode', launch: 'code', macosApp: 'Visual Studio Code', winExe: 'code' },
    cursor: { classes: 'cursor|Cursor', launch: 'cursor', macosApp: 'Cursor', winExe: 'cursor' },
    intellij: { classes: 'jetbrains-idea|idea|IntelliJ', launch: 'idea || intellij-idea-ultimate', macosApp: 'IntelliJ IDEA', winExe: 'idea64' },
    idea: { classes: 'jetbrains-idea|idea|IntelliJ', launch: 'idea || intellij-idea-ultimate', macosApp: 'IntelliJ IDEA', winExe: 'idea64' },
    pycharm: { classes: 'pycharm|PyCharm', launch: 'pycharm || pycharm-professional', macosApp: 'PyCharm', winExe: 'pycharm64' },
    webstorm: { classes: 'webstorm|WebStorm', launch: 'webstorm', macosApp: 'WebStorm', winExe: 'webstorm64' },
    // ── Terminals ─────────────────────────────────────────────────────────
    terminal: { classes: 'konsole|gnome-terminal|xterm|kitty|alacritty|terminator|tilix|urxvt|st-', launch: 'konsole || gnome-terminal || xterm', macosApp: 'Terminal', winExe: 'cmd' },
    konsole: { classes: 'konsole|Konsole', launch: 'konsole', macosApp: 'Terminal', winExe: 'cmd' },
    // ── Office / productivity ─────────────────────────────────────────────
    excel: { classes: 'libreoffice|soffice|scalc', launch: 'libreoffice --calc', macosApp: 'Microsoft Excel', winExe: 'excel' },
    spreadsheet: { classes: 'libreoffice|soffice|scalc', launch: 'libreoffice --calc', macosApp: 'Microsoft Excel', winExe: 'excel' },
    calc: { classes: 'libreoffice|soffice|scalc', launch: 'libreoffice --calc', macosApp: 'Microsoft Excel', winExe: 'excel' },
    word: { classes: 'libreoffice|soffice|swriter', launch: 'libreoffice --writer', macosApp: 'Microsoft Word', winExe: 'winword' },
    writer: { classes: 'libreoffice|soffice|swriter', launch: 'libreoffice --writer', macosApp: 'Microsoft Word', winExe: 'winword' },
    powerpoint: { classes: 'libreoffice|soffice|simpress', launch: 'libreoffice --impress', macosApp: 'Microsoft PowerPoint', winExe: 'powerpnt' },
    impress: { classes: 'libreoffice|soffice|simpress', launch: 'libreoffice --impress', macosApp: 'Microsoft PowerPoint', winExe: 'powerpnt' },
    libreoffice: { classes: 'libreoffice|soffice', launch: 'libreoffice', macosApp: 'LibreOffice', winExe: 'soffice' },
    // ── File managers ─────────────────────────────────────────────────────
    files: { classes: 'dolphin|nautilus|thunar|nemo|pcmanfm|ranger', launch: 'dolphin || nautilus || thunar', macosApp: 'Finder', winExe: 'explorer' },
    dolphin: { classes: 'dolphin|Dolphin', launch: 'dolphin', macosApp: 'Finder', winExe: 'explorer' },
    nautilus: { classes: 'nautilus|Nautilus|org.gnome.Nautilus', launch: 'nautilus', macosApp: 'Finder', winExe: 'explorer' },
    // ── Communication ─────────────────────────────────────────────────────
    discord: { classes: 'discord|Discord', launch: 'discord', macosApp: 'Discord', winExe: 'discord' },
    slack: { classes: 'slack|Slack', launch: 'slack', macosApp: 'Slack', winExe: 'slack' },
    telegram: { classes: 'telegram|Telegram', launch: 'telegram-desktop', macosApp: 'Telegram', winExe: 'telegram' },
    // ── Media ─────────────────────────────────────────────────────────────
    spotify: { classes: 'spotify|Spotify', launch: 'spotify', macosApp: 'Spotify', winExe: 'spotify' },
    vlc: { classes: 'vlc|VLC', launch: 'vlc', macosApp: 'VLC', winExe: 'vlc' },
    // ── Other ─────────────────────────────────────────────────────────────
    obsidian: { classes: 'obsidian|Obsidian', launch: 'obsidian', macosApp: 'Obsidian', winExe: 'Obsidian' },
    gimp: { classes: 'gimp|Gimp', launch: 'gimp', macosApp: 'GIMP', winExe: 'gimp' },
    blender: { classes: 'blender|Blender', launch: 'blender', macosApp: 'Blender', winExe: 'blender' },
    zoom: { classes: 'zoom|Zoom', launch: 'zoom', macosApp: 'zoom.us', winExe: 'zoom' },
};

async function focusAppInternal(appName) {
    // Normalize common speech variants → canonical APP_FOCUS_MAP key
    const ALIASES = {
        'code': 'vscode', 'vs code': 'vscode', 'visual studio code': 'vscode', 'visual studio': 'vscode',
        'vs-code': 'vscode', 'vs_code': 'vscode',
        'idea': 'intellij', 'jet brains': 'intellij', 'jetbrains': 'intellij', 'android studio': 'intellij',
        'web storm': 'webstorm', 'py charm': 'pycharm',
        'konsole': 'terminal', 'gnome terminal': 'terminal', 'gnome-terminal': 'terminal',
        'xterm': 'terminal', 'kitty': 'terminal', 'alacritty': 'terminal',
        'libre office': 'libreoffice', 'libre-office': 'libreoffice', 'open office': 'libreoffice',
        'spreadsheet': 'excel', 'google sheets': 'excel', 'calc': 'excel',
        'libre office calc': 'excel', 'libreoffice calc': 'excel',
        'document': 'word', 'libre office writer': 'word', 'libreoffice writer': 'word',
        'presentation': 'powerpoint', 'slides': 'powerpoint',
        'libre office impress': 'powerpoint', 'libreoffice impress': 'powerpoint',
        'navigator': 'browser', 'web browser': 'browser', 'internet': 'browser',
        'google chrome': 'chrome', 'google': 'chrome',
        'file manager': 'files', 'file explorer': 'files', 'explorer': 'files',
        'finder': 'files', 'dolphin': 'dolphin', 'nautilus': 'files',
        'music': 'spotify', 'media player': 'spotify',
        'video editor': 'blender', 'photo editor': 'gimp',
        'chat': 'discord', 'messages': 'telegram',
        'meetings': 'zoom', 'video call': 'zoom',
    };

    let key = appName.toLowerCase().trim();
    // Apply alias table
    if (ALIASES[key]) key = ALIASES[key];
    // Strip leading/trailing noise GPT sometimes adds
    key = key.replace(/^(the |a |my |to |on )/, '').trim();

    const entry = APP_FOCUS_MAP[key];

    if (!entry) {
        // Unknown app — just try launching it directly by name
        console.log(`🔍 Unknown app "${appName}", attempting direct launch...`);
        exec(appName, (err) => {
            if (err) console.error(`❌ Direct launch of "${appName}" failed:`, err);
        });
        return `Trying to open ${appName} for you.`;
    }

    console.log(`🎯 Focusing app: "${appName}" (entry: ${JSON.stringify(entry)})`);

    if (process.platform === 'darwin') {
        const activateCmd = `osascript -e 'tell application "${entry.macosApp}" to activate'`;
        const openCmd = `open -a "${entry.macosApp}"`;
        exec(activateCmd, (err) => {
            if (err) exec(openCmd, () => { });
        });
        return `Switching to ${appName}.`;
    }

    if (process.platform === 'win32') {
        const psCmd = `powershell -command "
            $wnd = (Get-Process | Where-Object {$_.MainWindowTitle -match '${key}'} | Select-Object -First 1);
            if ($wnd) {
                Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32 { [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }';
                [Win32]::SetForegroundWindow($wnd.MainWindowHandle)
            } else { Start-Process '${entry.winExe}' }"`;
        exec(psCmd, () => { });
        return `Switching to ${appName}.`;
    }

    const isWayland = process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland';
    const classRegex = entry.classes;

    const tryRaiseWindow = () => new Promise((resolve) => {
        if (isWayland) {
            exec(`wmctrl -x -a "${key}" 2>/dev/null || wmctrl -a "${key}" 2>/dev/null`, (err) => {
                resolve(!err);
            });
        } else {
            // X11: Use --regexp for multi-class patterns like 'zoom|Zoom'
            const searchBase = `xdotool search --regexp`;
            exec(
                `${searchBase} --onlyvisible --classname "${classRegex}" windowactivate --sync 2>/dev/null ` +
                `|| ${searchBase} --onlyvisible --class "${classRegex}" windowactivate --sync 2>/dev/null ` +
                `|| ${searchBase} --name "${classRegex}" windowactivate --sync 2>/dev/null`,
                (err, stdout) => {
                    resolve(!err && stdout.trim().length > 0);
                }
            );
        }
    });

    const raised = await tryRaiseWindow();
    if (raised) {
        console.log(`✅ Raised existing window for "${appName}"`);
        return `Switched to ${appName}.`;
    }

    console.log(`🚀 No open window found for "${appName}", launching...`);
    // Use detached spawn for more reliable GUI launch that outlives the command
    const [bin, ...args] = entry.launch.split(' ');
    const child = spawn(bin, args, {
        detached: true,
        stdio: 'ignore',
        shell: true,
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' }
    });
    child.unref();

    return `${appName} wasn't open, so I'm launching it now.`;
}

ipcMain.handle('focus-app', async (event, appName) => {
    return await focusAppInternal(appName);
});

ipcMain.handle('capture-screen', async () => {
    const tmpPath = path.join(app.getPath('temp'), `nova_shot_${Date.now()}.png`);

    // Final Fallback using Electron's desktopCapturer
    const desktopShot = async () => {
        try {
            const { desktopCapturer } = require('electron');
            const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
            const primarySource = sources[0];
            if (primarySource) {
                console.log("📸 Fallback: Captured screen via desktopCapturer");
                return primarySource.thumbnail.toDataURL();
            }
        } catch (e) {
            console.error("Capture Fallback Error:", e);
        }
        return null;
    };

    // Silent Screenshot Triggers (Wayland/X11/macOS)
    let cmd = "";
    if (process.platform === 'darwin') {
        cmd = `screencapture -x "${tmpPath}"`;
    } else if (process.platform === 'linux') {
        if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
            cmd = `spectacle --background --nonotify --output "${tmpPath}" || grim "${tmpPath}"`;
        } else {
            cmd = `import -window root "${tmpPath}"`;
        }
    }

    console.log(`📸 Attempting screenshot with: ${cmd}`);

    try {
        if (cmd) {
            await new Promise((resolve, reject) => {
                exec(cmd, { env: process.env }, (error) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        }

        // Polling loop: Wait for file to exist AND have content (ensures write is complete)
        let found = false;
        for (let i = 0; i < 10; i++) {
            if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1000) {
                found = true;
                break;
            }
            await new Promise(r => setTimeout(r, 100)); // 100ms intervals
        }

        if (found) {
            const data = fs.readFileSync(tmpPath).toString('base64');
            const dataUrl = `data:image/png;base64,${data}`;
            fs.unlinkSync(tmpPath); // Cleanup
            console.log(`📸 Successfully captured via CLI tool`);
            return dataUrl;
        } else {
            console.log("⚠️ CLI tool completed but file is missing or empty.");
        }
    } catch (e) {
        console.error(`Capture Tool Error: ${e.message}`);
    }

    return await desktopShot();
});

ipcMain.handle('generate-speech', async (event, text) => {
    try {
        const outPath = await generateSpeech(text, 'assets/tts_output.wav');
        return outPath;
    } catch (e) {
        console.error("TTS Handle Error:", e);
        return null;
    }
});

app.whenReady().then(() => {
    const { session } = require('electron');
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(true));

    protocol.handle('appassets', (request) => {
        const url = request.url.replace(/^appassets:\/\//, '');
        let decodedUrl = '';
        try { decodedUrl = decodeURI(url); } catch (e) { decodedUrl = url; }

        // Remove query string or trailing slashes (Vosk engine appends trailing slashes)
        decodedUrl = decodedUrl.split('?')[0].split('#')[0].replace(/\/+$/, '');
        const absolutePath = path.join(__dirname, decodedUrl);

        try {
            const fs = require('fs');
            console.log('[Protocol] Fetching:', absolutePath);
            const data = fs.readFileSync(absolutePath);
            let contentType = 'application/octet-stream';
            if (absolutePath.endsWith('.gltf')) contentType = 'application/json';
            else if (absolutePath.endsWith('.wav')) contentType = 'audio/wav';
            else if (absolutePath.endsWith('.mp3')) contentType = 'audio/mpeg';
            else if (absolutePath.endsWith('.jpeg') || absolutePath.endsWith('.jpg')) contentType = 'image/jpeg';
            else if (absolutePath.endsWith('.png')) contentType = 'image/png';

            return new Response(data, { headers: { 'Content-Type': contentType } });
        } catch (err) {
            console.error('AppAssets error reading:', absolutePath, err);
            return new Response('Not Found', { status: 404 });
        }
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
