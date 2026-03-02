const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const platform = os.platform();
const arch = os.arch();

let piperUrl = '';
if (platform === 'win32') {
    piperUrl = `https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_${arch === 'x64' ? 'amd64' : 'x86'}.zip`;
} else if (platform === 'darwin') {
    piperUrl = `https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_macos_${arch === 'arm64' ? 'aarch64' : 'x64'}.tar.gz`;
} else {
    piperUrl = `https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_${arch === 'x64' ? 'x86_64' : 'aarch64'}.tar.gz`;
}

console.log(`Downloading Piper TTS for ${platform} ${arch}...`);

try {
    // Windows 10/11 natively includes curl and tar!
    execSync(`curl -L -o piper_archived ${piperUrl}`, { stdio: 'inherit' });
    
    console.log("Extracting Piper executable...");
    if (platform === 'win32') {
        execSync(`tar -xf piper_archived`, { stdio: 'inherit' });
    } else {
        execSync(`tar -xzf piper_archived`, { stdio: 'inherit' });
    }
    
    console.log("Downloading Lessac-High Masculine Voice Model...");
    execSync(`curl -L -o piper/model.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/high/en_US-lessac-high.onnx"`, { stdio: 'inherit' });
    execSync(`curl -L -o piper/model.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/high/en_US-lessac-high.onnx.json"`, { stdio: 'inherit' });

    // Cleanup archive
    if (fs.existsSync('piper_archived')) fs.unlinkSync('piper_archived');
    
    console.log("Piper Voice Engine deployed successfully at ./piper/");
} catch (e) {
    console.error("Piper TTS Installation Failed:", e.message);
    process.exit(1);
}
