const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Platform paths
const piperExe = os.platform() === 'win32' ? 'piper.exe' : 'piper';
const piperPath = path.join(__dirname, 'piper', piperExe);
const modelPath = path.join(__dirname, 'piper', 'model.onnx');

function generateSpeech(text, relativeOutputPath) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(piperPath)) {
            return reject(new Error("Piper binary not found. Run: node scripts/download-piper.js"));
        }

        const absoluteOutputPath = path.join(__dirname, relativeOutputPath);
        
        // Ensure the directory exists
        const dir = path.dirname(absoluteOutputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const piperProcess = spawn(piperPath, [
            '--model', modelPath,
            '--output_file', absoluteOutputPath
        ]);

        piperProcess.on('close', (code) => {
            if (code === 0) {
                resolve(relativeOutputPath); // Return relative path for UI fetch
            } else {
                reject(new Error(`Piper exited with code ${code}`));
            }
        });
        
        piperProcess.on('error', reject);

        // Send the input text cleanly through stdin to bypass character-escaping bugs
        piperProcess.stdin.write(text + "\n");
        piperProcess.stdin.end();
    });
}

module.exports = { generateSpeech };
