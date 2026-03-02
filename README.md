# Nova - 3D Voice Assistant Robot Widget

Nova is a fully offline, privacy-first 3D robotic desktop assistant built with Electron, Three.js, and Vosk Voice Recognition. Nova floats natively over your desktop window, listens for her wake word, and responds dynamically using the **X.AI Grok Neural Engine**.

## 🚀 Key Features
- **Generative AI Responses (Grok):** Integrated natively with X.AI to provide intelligent, contextual, and deeply dynamic conversations.
- **100% Offline Voice Recognition:** Uses a local 40MB Kaldi acoustic model (Vosk) for zero-latency Wake Word and Command detection. 
- **Piper TTS Synthesis:** Speaks to you using a fully localized, high-quality offline text-to-speech C++ engine.
- **Transparent Desktop Overlay:** Renders directly over your wallpaper and apps seamlessly.
- **Real-Time Lip Sync:** Dynamically interprets volume waveforms to procedurally articulate the 3D model's jaw.

---

## 💻 System Requirements
Before running the application, ensure you have the following installed on your system:
- **[Node.js](https://nodejs.org/)** (v18.0 or higher natively comes with `npm` and `fetch`)
- **Git** (Required for cloning the repo)
- **Linux Users Only:** Ensure `alsa-utils` or equivalent OS-level audio packages are installed for Piper TTS to output physical sound.

---

## 🛠️ Installation & Setup (All Operating Systems)

1. **Clone the repository:**
   ```bash
   git clone <your_repository_url>
   cd Sunstone-Innovation-Challenge-2026/robot-widget
   ```

2. **Setup your API Keys:**
   Create a file named `.env` inside the `robot-widget` directory and add your Grok API Key. (Ensure your X.AI developer account has prepaid billing credits loaded).
   ```env
   GROK_API_KEY=your_xai_api_key_here
   ```

3. **Install all Node dependencies & Download Piper:**
   This command will compile the Electron binary, install Vosk/Three.js, and automatically download the 140MB Piper TTS engine models locally via our postinstall script.
   ```bash
   npm install
   ```

---

## ▶️ How to Run
Navigate to the `robot-widget` directory in your terminal and launch the desktop widget:
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
6. Clearly say **"Hey Nova"** followed by your command (e.g., "Hey Nova, what is quantum mechanics?").
7. Wait a few seconds for the `Processing...` API generation, and the robot will respond to you out loud!
