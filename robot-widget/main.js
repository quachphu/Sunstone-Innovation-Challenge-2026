const { app, BrowserWindow, screen, protocol, ipcMain } = require('electron');
const path = require('path');
const { generateSpeech } = require('./tts.js');
const { askGrok } = require('./grok.js');

// Terminate Chromium's Autoplay sandbox. We are a desktop app, not a website!
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  { scheme: 'appassets', privileges: { standard: true, supportFetchAPI: true, secure: true, bypassCSP: true } }
]);

const WINDOW_WIDTH  = 250;
const WINDOW_HEIGHT = 350;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width:  WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: width  - WINDOW_WIDTH,
    y: height - WINDOW_HEIGHT,
    show: false,

    // Appearance
    transparent:   true,
    frame:         false,
    hasShadow:     false,
    backgroundColor: '#00000000',

    // Behaviour
    alwaysOnTop:   true,
    skipTaskbar:   true,
    resizable:     false,

    // On Linux (KDE/X11/Wayland) we set type to 'toolbar' so the compositor
    // renders it above the desktop without stealing focus.
    ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),

    webPreferences: {
      nodeIntegration:  true,
      contextIsolation: false,
      webSecurity:      false   // needed to load local file:// model assets
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
  });

  // Keep it on top even when other windows are fullscreen (macOS / Windows)
  win.setAlwaysOnTop(true, 'screen-saver');

  // Allow click-through on the transparent parts
  // We enable mouse events initially so Three.js can receive them if needed
  win.setIgnoreMouseEvents(false);

  // On Linux with Wayland transparency sometimes needs a compositor hint
  if (process.platform === 'linux') {
    win.setBackgroundColor('#00000000');
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

ipcMain.on('open-chat', () => {
  createChatWindow();
});

ipcMain.handle('ask-grok', async (event, text) => {
    return await askGrok(text);
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
    try { decodedUrl = decodeURI(url); } catch(e) { decodedUrl = url; }
    
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
