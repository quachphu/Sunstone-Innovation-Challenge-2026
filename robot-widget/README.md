# Nova - 3D Voice Assistant Robot Widget

Nova is a fully offline, privacy-first 3D robotic desktop assistant built with Electron, Three.js, and Vosk Voice Recognition. Nova floats natively over your desktop window, listens for her wake word, and responds dynamically.

## 🚀 Key Features
- **100% Offline AI Voice Recognition:** Uses a local 40MB Kaldi acoustic model (Vosk) for zero-latency Wake Word and Command detection. No API keys or cloud connections required.
- **Transparent Desktop Overlay:** Renders directly over your wallpaper and apps seamlessly.
- **Real-Time Lip Sync:** Dynamically interprets volume waveforms to procedurally articulate the 3D model's jaw.

---

## 💻 System Requirements
Before running the application, ensure you have the following installed on your system:
- **[Node.js](https://nodejs.org/)** (v16.0 or higher natively comes with `npm`)
- **Git** (Required for cloning the repo)

---

## 🛠️ Installation (All Operating Systems)

1. **Clone the repository:**
   ```bash
   git clone <your_repository_url>
   cd Sunstone-Innovation-Challenge-2026/robot-widget
   ```

2. **Install all Node dependencies:**
   This command will scan the package.json and download the required modules (like the massive Electron binary and Three.js math libraries) into a local untracked `node_modules` folder.
   ```bash
   npm install
   ```

---

## ▶️ How to Run

### 🪟 Windows
1. Open **Command Prompt** or **PowerShell**.
2. Navigate to the widget directory: `cd path\to\Sunstone-Innovation-Challenge-2026\robot-widget`
3. Launch the desktop widget:
   ```bash
   npm start
   ```

### 🍏 macOS
1. Open the native **Terminal** application.
2. Navigate to the widget directory: `cd path/to/Sunstone-Innovation-Challenge-2026/robot-widget`
3. Launch the desktop widget:
   ```bash
   npm start
   ```

### 🐧 Linux (Arch / Ubuntu / Fedora)
1. Open your terminal emulator.
2. Navigate to the widget directory: `cd path/to/Sunstone-Innovation-Challenge-2026/robot-widget`
3. Launch the desktop widget:
   ```bash
   npm start
   ```
   *(Note for Linux Developers: We strictly pass `--enable-transparent-visuals` in the start script, so as long as your X11/Wayland compositor is active, the robot background will render invisibly over your desktop wallpaper!)*

---

## 🎙️ Usage Instructions (Autoplay Bypass)
1. After running `npm start`, Chromium enforces a strict WebAudio "Autoplay Policy". 
2. Look at the top-left logs. It will say `"⚠️ Click the Robot once to activate Voice AI"`. 
3. **Click the 3D robot once** to structurally unlock the OS microphone APIs.
4. You will immediately see `"🎙️ Engine Active"` in the UI log!
5. Test your microphone volume by watching the live `"Vol: [||||  ]"` visualizer bars jump.
6. Clearly say **"Hey Nova"** or **"Hey Nova, how is the weather?"**.
7. Wait a split second, and the robot will respond to you out loud!
