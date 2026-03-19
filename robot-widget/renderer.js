/**
 * renderer.js — Three.js scene for the sci-fi robot desktop widget
 * Uses ES module imports (Electron renderer supports native ESM).
 */

import * as THREE from 'three';
import { GLTFLoader }  from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Electron Native Modules
const { ipcRenderer } = window.require('electron');
const fs = window.require('fs');
const path = window.require('path');

let isDragging = false;

// Search & Automation Global State (Attached to window for absolute scoping in module context)
window.novaState = {
    pendingChoices: [],
    pendingTopic: null,
    isAwaitingPlatform: false,
    isProcessingCommand: false,
    isSpeaking: false,
    currentPlatform: null,
    isAwake: false,
    isInConversation: false,
    isSilenced: false,
    lastDirectCommandTime: 0,
    lastDirectCommandText: ''
};

window.novaVoice = {
    wakeUp: null,
    endConversation: null,
    startRecording: null,
    stopRecording: null
};

window.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    isDragging = true;
    ipcRenderer.send('drag-start', { x: e.screenX, y: e.screenY });
  }
});

window.addEventListener('mousemove', (e) => {
  if (isDragging) {
    ipcRenderer.send('drag-move', { x: e.screenX, y: e.screenY });
  }
});

window.addEventListener('mouseup', () => {
  isDragging = false;
});

// Raycaster for precise 3D model clicking
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

window.addEventListener('dblclick', (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  if (typeof robotGroup !== 'undefined' && robotGroup) {
    const intersects = raycaster.intersectObject(robotGroup, true);
    // Ensure we only trigger if we hit a VISIBLE part of the robot (ignoring the hidden wall/ground)
    const validIntersects = intersects.filter(hit => hit.object && hit.object.visible);
    
    if (validIntersects.length > 0) {
      ipcRenderer.send('open-chat');
    }
  }
});

// ── Canvas & Renderer ──────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha:     true,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.toneMapping       = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();

// ── Scene ──────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

// ── Camera ─────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(0, 0.5, 3.5);
camera.lookAt(0, 0, 0);

// ── Lighting ───────────────────────────────────────────────────────────────
// Soft ambient fill
const ambient = new THREE.AmbientLight(0xffffff, 2.0);
scene.add(ambient);

// Main key light (warm white)
const keyLight = new THREE.DirectionalLight(0xfff0e0, 2.8);
keyLight.position.set(3, 6, 4);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far  = 30;
scene.add(keyLight);

// Fill light (cool blue)
const fillLight = new THREE.DirectionalLight(0x8ab4f8, 1.2);
fillLight.position.set(-4, 3, -2);
scene.add(fillLight);

// Rim / back light (orange glow for sci-fi feel)
const rimLight = new THREE.DirectionalLight(0xff6030, 0.8);
rimLight.position.set(0, 2, -5);
scene.add(rimLight);

// ── Debug Cube ─────────────────────────────────────────────────────────────
const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
const material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
const cube = new THREE.Mesh(geometry, material);
cube.position.set(1.5, 0.5, 0);
scene.add(cube);

window.onerror = function(msg, url, line, col, error) {
  console.error("Window Error: ", msg, url, line, col, error);
};

window.addEventListener('unhandledrejection', function(event) {
  console.error('Unhandled Rejection: ', event.reason);
});

// ── GLTF Loader ────────────────────────────────────────────────────────────
// In Electron file:// context, relative paths from index.html resolve correctly.
// We navigate up one level from robot-widget/ to reach sci_fi_worker_robot_gltf/
const MODEL_URL = 'appassets://sci_fi_worker_robot_gltf/scene.gltf';

// ── Loaders ────────────────────────────────────────────────────────────────
let robotGroup;

// Procedural Animation Targets
let headNode;
let bodyNode;
let armRNode;
let armLNode;

// Initial Transforms
let headInitRot;
let bodyInitPos;
let bodyInitRot;
let armRInitRot;
let armLInitRot;

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

loader.load(
  MODEL_URL,
  (gltf) => {
    const model = gltf.scene;

    // Reset any wild transforms
    model.position.set(0, 0, 0);
    model.scale.set(1, 1, 1);

    // Hide unwanted diorama meshes and update materials
    model.traverse((child) => {
      if (child.isMesh) {
        const nodeName = child.name.toLowerCase();
        const matName = child.material ? child.material.name.toLowerCase() : '';

        // Remove wall / ground meshes by node name OR material name
        if (nodeName.includes("wall") || nodeName.includes("ground") || nodeName.includes("background") ||
            matName.includes("wall") || matName.includes("ground") || matName.includes("background")) {
          child.visible = false;
        } else {
          child.castShadow = false;
          child.receiveShadow = false;
        }

        // Make sure textures render correctly
        if (child.material) {
          child.material.needsUpdate = true;
          child.material.envMapIntensity = 1.0;
          if (child.material.metalness !== undefined) {
             child.material.metalness = 0.5;
          }
        }
      }
    });

    // Compute bounding box ONLY for visible meshes
    const box = new THREE.Box3();
    model.traverse((child) => {
      if (child.isMesh && child.visible) {
        box.expandByObject(child);
      }
    });

    let size = new THREE.Vector3();
    let center = new THREE.Vector3();
    
    // Fallback if no meshes are visible
    if (box.isEmpty()) {
       size.set(2, 2, 2);
       center.set(0, 0, 0);
    } else {
       box.getSize(size);
       box.getCenter(center);
    }

    // Auto-frame camera mathematically
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    // Increase padding from 1.5 to 2.2 to make the robot appear smaller within the window
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 2.2; 

    console.log("✅ Bounding Box Computed:", { size, center, maxDim, cameraZ });

    // Shift model so its true center is (0,0,0) BEFORE putting it in a group
    model.position.sub(center);

    // Place camera relative to the newly centered origin
    camera.position.set(0, (size.y * 0.2), cameraZ);
    camera.lookAt(0, 0, 0);
    
    // Adjust lights to encompass the visible model at origin
    keyLight.position.set(maxDim, maxDim, maxDim);
    keyLight.castShadow = false;
    rimLight.position.set(-maxDim, maxDim, -maxDim);

    robotGroup = new THREE.Group();
    robotGroup.add(model);
    
    // Rotate the robot a bit to the left (facing left side of screen)
    robotGroup.rotation.y = -0.5; // ~ -30 degrees
    
    scene.add(robotGroup);

    // Save references to specific robot parts for procedural idle animation
    headNode = model.getObjectByName('Head_13') || model.getObjectByName('Head Rotate_14');
    bodyNode = model.getObjectByName('Robot_Main_Controller_40') || model.getObjectByName('Body_25') || model;
    armRNode = model.getObjectByName('Arm_1_Right_26') || model.getObjectByName('Arm 1 Right_26');
    armLNode = model.getObjectByName('Arm_1_Left_35') || model.getObjectByName('Arm 1 Left_35');

    // Store their resting poses so we don't snap them into the sky or fold them backward!
    if (headNode) headInitRot = headNode.rotation.clone();
    if (bodyNode) {
      bodyInitPos = bodyNode.position.clone();
      bodyInitRot = bodyNode.rotation.clone();
    }
    if (armRNode) armRInitRot = armRNode.rotation.clone();
    if (armLNode) armLInitRot = armLNode.rotation.clone();

    console.log('✅ Robot model loaded natively with procedural targets');
  },
  (progress) => {
    if (progress.total > 0) {
      console.log(`Loading… ${Math.round((progress.loaded / progress.total) * 100)}%`);
    }
  },
  (err) => console.error('❌ Error loading model:', err)
);

// ── Render size ────────────────────────────────────────────────────────────
function updateSize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
updateSize();
window.addEventListener('resize', updateSize);

// ── Animation loop ─────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const time = clock.getElapsedTime();

  // Procedural idle animations using sine waves!
  if (headNode && headInitRot) {
    // Gentle head turning, ADDED to initial rotation
    headNode.rotation.y = headInitRot.y + Math.sin(time * 0.7) * 0.15;
    headNode.rotation.z = headInitRot.z + Math.sin(time * 0.4) * 0.05;
  }
  
  if (bodyNode && bodyInitPos) {
    // Gentle body sway/breathing
    bodyNode.rotation.y = bodyInitRot.y + Math.sin(time * 0.5) * 0.05;
    bodyNode.position.y = bodyInitPos.y + Math.sin(time * 1.5) * 0.02;
  }
  
  if (armRNode && armRInitRot) {
    // Subtle arm floating
    armRNode.rotation.z = armRInitRot.z + Math.sin(time * 0.8) * 0.1;
  }
  
  if (armLNode && armLInitRot) {
    // Subtle arm floating (offset from right arm)
    armLNode.rotation.z = armLInitRot.z + Math.sin(time * 0.8 + 1) * 0.1;
  }

  renderer.render(scene, camera);
}

animate();

// ── TTS & Offline Voice Recognition (VOSK) ─────────────────────────────────
let currentAudio = null;
let recognizer = null;
const API_KEY = window.require('dotenv').config().parsed.GROK_API_KEY;

// Base64 PCM16 continuous playback
let grokAudioContext = new window.AudioContext({ sampleRate: 24000 });
let nextPlayTime = 0;
let activeGrokSources = []; // Registry to track and cancel overlapping Grok audio

function stopAllPlayback() {
    // Stop Piper/Local TTS
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = ""; // Clear src to stop loading
        currentAudio = null;
    }
    if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
    }
    
    // Stop Grok Realtime Audio
    activeGrokSources.forEach(source => {
        try { 
            source.onended = null;
            source.stop(); 
        } catch(e) {}
    });
    activeGrokSources = [];
    nextPlayTime = grokAudioContext.currentTime;
    
    window.novaState.isSpeaking = false;
}

function playAudioChunk(base64Audio) {
    if (grokAudioContext.state === 'suspended') grokAudioContext.resume();
    window.novaState.isSpeaking = true;
    listeningSymbol.innerHTML = '🔊 Nova is speaking...';
    listeningSymbol.style.display = 'block';
    
    const binaryString = window.atob(base64Audio);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768.0;
    }

    const audioBuffer = grokAudioContext.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    const source = grokAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(grokAudioContext.destination);

    if (nextPlayTime < grokAudioContext.currentTime) {
        nextPlayTime = grokAudioContext.currentTime;
    }
    source.onended = () => {
        activeGrokSources = activeGrokSources.filter(s => s !== source);
        if (activeGrokSources.length === 0) {
            window.novaState.isSpeaking = false;
        }
    };
    source.start(nextPlayTime);
    activeGrokSources.push(source);
    nextPlayTime += audioBuffer.duration;
}

// Websocket Realtime Connection
let grokSocket = null;

async function initGrokSocket() {
    try {
        const response = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
            method: 'POST',
            headers: {
                "Authorization": `Bearer ${API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ "expires_after": { "seconds": 3600 } })
        });
        const data = await response.json();
        const token = data.value;
        
        grokSocket = new WebSocket("wss://api.x.ai/v1/realtime", [`xai-client-secret.${token}`]);
        
        grokSocket.onopen = () => {
            console.log("🟢 Grok Realtime Connected!");
            grokSocket.send(JSON.stringify({
                type: "session.update",
                session: {
                    voice: "Rex",
                    instructions: "You are Nova, an advanced, highly intelligent sci-fi desktop worker robot. Embody this persona fully. Keep your answers extremely concise and direct. NEVER introduce yourself. Talk naturally.",
                    turn_detection: null, // We handle turns via Vosk (client side VAD)
                    audio: {
                        output: { format: { type: "audio/pcm", rate: 24000 } }
                    }
                }
            }));
        };

        grokSocket.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === "response.output_audio.delta") {
                playAudioChunk(msg.delta);
            } else if (msg.type === "response.output_audio_transcript.done") {
                console.log("🤖 Grok:", msg.transcript);
            } else if (msg.type === "response.done") {
                console.log("✅ Grok Finished Response (WebSocket).");
                // Note: We don't set isSpeaking = false here anymore; 
                // the source.onended handlers for the buffered audio chunks will handle it.
                
                // Wait for audio to actually finish before resuming recording
                const checkFinished = setInterval(() => {
                    if (activeGrokSources.length === 0) {
                        clearInterval(checkFinished);
                        window.novaState.isSpeaking = false;
                        listeningSymbol.style.display = 'none';
                        if (window.novaState.isAwake) {
                            setTimeout(() => {
                                if (window.novaVoice.startRecording) window.novaVoice.startRecording();
                            }, 1000);
                        }
                    }
                }, 200);
            }
        };

        grokSocket.onclose = () => {
            console.log("🔴 Grok Realtime Disconnected. Reconnecting in 3s...");
            setTimeout(initGrokSocket, 3000);
        };
    } catch(e) {
        console.error("Grok Socket Init Error:", e);
    }
}

// Start Grok WS connection
initGrokSocket();

function askGrokRealtime(text) {
    if (window.novaState.isProcessingCommand || window.novaState.isAwaitingPlatform || window.novaState.pendingChoices.length > 0) {
        console.log("🤫 Silencing Grok because an action is in progress.");
        return;
    }
    if (!grokSocket || grokSocket.readyState !== WebSocket.OPEN) {
        console.error("Grok Socket not ready!");
        return;
    }
    // Stop any currently overlapping audio
    stopAllPlayback();
    window.novaState.isSpeaking = true;
    listeningSymbol.innerHTML = '🤖 Thinking...';
    listeningSymbol.style.display = 'block';
    console.log(`📡 Sending to Grok: "${text}"`);
    
    // Create the message
    grokSocket.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: text }]
        }
    }));
    // Request Nova to respond with audio
    grokSocket.send(JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio", "text"] }
    }));
}

// Speak function for automation responses
// Speak function for automation responses
async function speak(text) {
    if (!text) return;
    
    // Stop any current speech/audio across all engines
    stopAllPlayback();
    
    // Safety: Reset speaking state
    window.novaState.isSpeaking = false;
    listeningSymbol.style.opacity = '1';

    let hasStartedAnySpeech = false;

    const useWebSpeech = (txt) => {
        if (hasStartedAnySpeech) return;
        hasStartedAnySpeech = true;
        if (!('speechSynthesis' in window)) return;
        window.novaState.isSpeaking = true;
        const utterance = new SpeechSynthesisUtterance(txt);
        utterance.rate = 0.9;
        utterance.onend = () => {
            window.novaState.isSpeaking = false;
            listeningSymbol.style.opacity = '1';
            listeningSymbol.style.display = 'none';
            if (window.novaState.isAwake && window.novaVoice.startRecording) {
                setTimeout(() => window.novaVoice.startRecording(), 1000);
            }
        };
        utterance.onerror = () => {
            window.novaState.isSpeaking = false;
            listeningSymbol.style.opacity = '1';
        };
        speechSynthesis.speak(utterance);
        uiLog(`🔊 Voice (Web Speech): "${txt}"`);
    };

    try {
        console.log('🔊 Generating Piper speech for:', text);
        const audioPath = await ipcRenderer.invoke('generate-speech', text);
        
        if (audioPath) {
            console.log('🔊 Audio generated at:', audioPath);
            const audio = new Audio();
            currentAudio = audio; // Track this so we can cancel it
            
            audio.addEventListener('error', (e) => {
                console.error('🔊 Audio error, falling back to Web Speech:', e);
                useWebSpeech(text);
            });
            
            audio.addEventListener('loadeddata', () => {
                if (hasStartedAnySpeech) {
                    audio.pause();
                    audio.src = "";
                    return;
                }
                hasStartedAnySpeech = true;
                window.novaState.isSpeaking = true;
                listeningSymbol.innerHTML = '🔊 Speaking...';
                listeningSymbol.style.color = '#fff';
                listeningSymbol.style.opacity = '0.5';
                
                audio.play().then(() => {
                    uiLog(`🔊 Voice (Piper): "${text}"`);
                }).catch(err => {
                    console.error('🔊 Audio play error, falling back to Web Speech:', err);
                    useWebSpeech(text);
                });
            });
            
            audio.addEventListener('ended', () => {
                if (currentAudio === audio) currentAudio = null;
                window.novaState.isSpeaking = false;
                listeningSymbol.style.opacity = '1';
                listeningSymbol.style.display = 'none';
                if (window.novaState.isAwake && window.novaVoice.startRecording) {
                    setTimeout(() => window.novaVoice.startRecording(), 1000);
                }
            });

            // Safety timeout: Reset isSpeaking after 15s max if it gets stuck
            setTimeout(() => {
                if (window.novaState.isSpeaking && currentAudio === audio) {
                    window.novaState.isSpeaking = false;
                    listeningSymbol.style.opacity = '1';
                }
            }, 15000);
            
            // Add small delay to avoid race condition with file system and retry if needed
            let retryCount = 0;
            const loadAudio = () => {
                audio.src = `appassets:///${audioPath}`;
                currentAudio = audio;
                audio.load();
            };

            setTimeout(loadAudio, 150);
        } else {
            // Fallback if no audio path returned
            useWebSpeech(text);
        }
    } catch (error) {
        console.error('🔊 Speech system error, falling back to Web Speech:', error);
        useWebSpeech(text);
    }
}

let listeningSymbol = document.createElement('div');
listeningSymbol.innerHTML = '🎤 Listening...';
listeningSymbol.style.position = 'absolute';
listeningSymbol.style.top = '20px';
listeningSymbol.style.right = '20px';
listeningSymbol.style.color = '#0ff';
listeningSymbol.style.fontFamily = 'monospace';
listeningSymbol.style.fontSize = '16px';
listeningSymbol.style.display = 'none';
listeningSymbol.style.textShadow = '0 0 5px #0ff';
document.body.appendChild(listeningSymbol);

let subtitleElement = document.createElement('div');
subtitleElement.id = 'subtitle';
subtitleElement.style.position = 'absolute';
subtitleElement.style.bottom = '80px';
subtitleElement.style.left = '50%';
subtitleElement.style.transform = 'translateX(-50%)';
subtitleElement.style.padding = '12px 24px';
subtitleElement.style.background = 'rgba(0, 0, 0, 0.5)';
subtitleElement.style.backdropFilter = 'blur(12px)';
subtitleElement.style.webkitBackdropFilter = 'blur(12px)';
subtitleElement.style.borderRadius = '24px';
subtitleElement.style.border = '1px solid rgba(0, 255, 255, 0.3)';
subtitleElement.style.boxShadow = '0 8px 32px 0 rgba(0, 0, 0, 0.6), inset 0 0 10px rgba(0, 255, 255, 0.1)';
subtitleElement.style.color = '#fff';
subtitleElement.style.fontFamily = '"Segoe UI", Roboto, Helvetica, Arial, sans-serif';
subtitleElement.style.fontSize = '20px';
subtitleElement.style.fontWeight = '500';
subtitleElement.style.textShadow = '0 0 8px rgba(0, 255, 255, 0.5)';
subtitleElement.style.textAlign = 'center';
subtitleElement.style.pointerEvents = 'none';
subtitleElement.style.width = 'fit-content';
subtitleElement.style.maxWidth = '85%';
subtitleElement.style.transition = 'all 0.3s ease';
subtitleElement.style.display = 'none';
subtitleElement.style.zIndex = '9999';
document.body.appendChild(subtitleElement);

let uiLogElement = null;
function uiLog(msg) {
    if (!uiLogElement) {
        uiLogElement = document.createElement('div');
        uiLogElement.id = 'ui-log';
        uiLogElement.style.position = 'absolute';
        uiLogElement.style.bottom = '10px';
        uiLogElement.style.left = '10px';
        uiLogElement.style.color = '#0f0';
        uiLogElement.style.fontFamily = 'monospace';
        uiLogElement.style.fontSize = '12px';
        uiLogElement.style.whiteSpace = 'pre';
        uiLogElement.style.pointerEvents = 'none';
        document.body.appendChild(uiLogElement);
    }
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    uiLogElement.innerText = `[${timestamp}] ${msg}`;
    console.log(`[UI LOG] ${msg}`);
}

ipcRenderer.on('automation-log', (event, msg) => {
    uiLog(msg);
});

let choicesOverlay = null;
function showChoices(choices) {
    if (!choicesOverlay) {
        choicesOverlay = document.createElement('div');
        choicesOverlay.id = 'choices-overlay';
        choicesOverlay.style.position = 'absolute';
        choicesOverlay.style.top = '50%';
        choicesOverlay.style.left = '50%';
        choicesOverlay.style.transform = 'translate(-50%, -50%)';
        choicesOverlay.style.width = '200px';
        choicesOverlay.style.backgroundColor = 'rgba(0, 20, 40, 0.9)';
        choicesOverlay.style.border = '2px solid #0ff';
        choicesOverlay.style.borderRadius = '10px';
        choicesOverlay.style.padding = '10px';
        choicesOverlay.style.zIndex = '1000';
        choicesOverlay.style.boxShadow = '0 0 15px #0ff';
        choicesOverlay.style.color = '#fff';
        choicesOverlay.style.fontFamily = 'sans-serif';
        document.body.appendChild(choicesOverlay);
    }
    
    choicesOverlay.innerHTML = '<div style="font-weight: bold; border-bottom: 1px solid #0ff; margin-bottom: 10px; text-align: center; font-size: 14px;">Select match:</div>';
    choicesOverlay.style.display = 'block';
    
    choices.forEach((choice, index) => {
        const btn = document.createElement('div');
        btn.innerText = `${index + 1}. ${choice.title}`;
        btn.style.cursor = 'pointer';
        btn.style.padding = '8px';
        btn.style.margin = '5px 0';
        btn.style.border = '1px solid rgba(0, 255, 255, 0.2)';
        btn.style.borderRadius = '5px';
        btn.style.fontSize = '12px';
        btn.style.transition = 'all 0.2s';
        
        btn.onmouseover = () => {
            btn.style.backgroundColor = 'rgba(0, 255, 255, 0.2)';
            btn.style.borderColor = '#0ff';
        };
        btn.onmouseout = () => {
            btn.style.backgroundColor = 'transparent';
            btn.style.borderColor = 'rgba(0, 255, 255, 0.2)';
        };
        
        btn.onclick = () => {
            window.novaState.pendingTopic = choice.title;
            window.novaState.isAwaitingPlatform = true;
            showPlatformChoices();
            speak(`Great choice: ${window.novaState.pendingTopic}. Would you like to search for this on Google or YouTube?`);
            uiLog(`📌 Selected topic: ${window.novaState.pendingTopic}. Awaiting platform choice...`);
        };
        choicesOverlay.appendChild(btn);
    });
}

function showPlatformChoices() {
    if (!choicesOverlay) return;
    choicesOverlay.innerHTML = `
        <div style="font-weight: bold; border-bottom: 1px solid #0ff; margin-bottom: 10px; text-align: center; font-size: 14px;">
            Topic: ${window.novaState.pendingTopic}
        </div>
        <div style="text-align: center; margin-bottom: 10px; font-size: 12px;">Search on:</div>
    `;
    
    const platforms = [
        { name: '🌐 Google Search', value: 'google' },
        { name: '🎬 YouTube Video', value: 'youtube' }
    ];
    
    platforms.forEach(p => {
        const btn = document.createElement('div');
        btn.innerText = p.name;
        btn.style.cursor = 'pointer';
        btn.style.padding = '10px';
        btn.style.margin = '8px 0';
        btn.style.border = '1px solid #0ff';
        btn.style.borderRadius = '5px';
        btn.style.textAlign = 'center';
        btn.style.backgroundColor = 'rgba(0, 255, 255, 0.1)';
        btn.style.fontSize = '13px';
        btn.style.transition = 'all 0.2s';
        
        btn.onmouseover = () => {
            btn.style.backgroundColor = 'rgba(0, 255, 255, 0.3)';
            btn.style.transform = 'scale(1.05)';
        };
        btn.onmouseout = () => {
            btn.style.backgroundColor = 'rgba(0, 255, 255, 0.1)';
            btn.style.transform = 'scale(1)';
        };
        
        btn.onclick = () => {
            const platform = p.value;
            const query = window.novaState.pendingTopic;
            uiLog(`🌐 Opening ${platform} for: ${query}`);
            speak(`Searching ${platform} for ${query}`);
            ipcRenderer.invoke('browser-open', { platform, query });
            window.novaState.isAwaitingPlatform = false;
            window.novaState.pendingTopic = null;
            hideChoices();
        };
        choicesOverlay.appendChild(btn);
    });
}

function hideChoices() {
    if (choicesOverlay) {
        choicesOverlay.style.display = 'none';
        choicesOverlay.innerHTML = '';
    }
    window.novaState.pendingChoices = []; // CRITICAL: Clear choices state
}

async function analyzeScreen(userText) {
    try {
        uiLog("📸 Capturing screen for vision analysis...");
        const screenshot = await ipcRenderer.invoke('capture-screen');
        if (!screenshot) {
            uiLog("❌ Screen capture failed.");
            return null;
        }

        const visionPrompt = `The user is looking at this screen and said: "${userText}".
        Identify if there is a video player on screen (like YouTube) or a play button.
        If the user wants to "play it", look for a video player or an active video thumbnail.

        Return ONLY a JSON object: { "found": true, "title": "...", "url": "...", "platform": "youtube", "is_video_player": true|false }
        
        CRITICAL:
        1. If "is_video_player" is true, the user is likely on a video page.
        2. If you can see or infer the direct URL, provide it. 
        3. If it is a YouTube video and you can't get the exact URL, provide the title.
        4. "Play it" implies the user wants to play what's currently on screen or selected.`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: visionPrompt },
                            { type: 'image_url', image_url: { url: screenshot } }
                        ]
                    }
                ],
                max_tokens: 300
            })
        });

        const data = await response.json();
        const content = data.choices[0].message.content.trim();
        // Extract JSON if AI adds markdown
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        const result = JSON.parse(jsonMatch ? jsonMatch[0] : content);
        
        console.log('👁️ Vision result:', result);
        return result;
    } catch (e) {
        console.error("👁️ Vision error:", e);
        return null;
    }
}

async function initOfflineVoice() {
    try {
        uiLog("1/3 Requesting Microphone...");
        const mediaStream = await navigator.mediaDevices.getUserMedia({
            video: false, 
            audio: { 
                echoCancellation: true, 
                noiseSuppression: true, 
                autoGainControl: true,
                channelCount: 1, 
                sampleRate: 16000 
            }
        });
        
        uiLog("2/3 Loading AI Voice Model (40MB)...");
        const modelUrl = 'appassets://model.tar.gz';
        const model = await window.Vosk.createModel(modelUrl);
        uiLog("3/3 AI Engine Ready!");
        
        recognizer = new model.KaldiRecognizer(16000); // Restore full vocabulary for better wake-word coverage
        recognizer.setWords(true);
        
        let accumulatedSpeech = "";
        let sleepTimer;
        let speechTimer = null;
        let lastUserCommand = ""; // Track last command for context awareness
        let mediaRecorder = null;
        let audioChunks = [];
        let silenceThreshold = 0.01; // Volume threshold for silence
        let silenceDuration = 2500; // MS of silence to trigger Whisper
        let lastAudioTime = Date.now();

        const startRecording = async () => {
            try {
                if (window.novaState.isSpeaking) {
                    console.log("🤫 Nova is speaking, delaying microphone start...");
                    return;
                }
                if (mediaRecorder && mediaRecorder.state === 'recording') {
                    console.log("⚠️ MediaRecorder already recording, skipping start.");
                    return;
                }
                
                audioChunks = [];
                const stream = mediaStream;
                // Use opus for better stability and quality
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
                
                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) audioChunks.push(event.data);
                };
                
                mediaRecorder.onstop = async () => {
                    console.log("🏁 MediaRecorder stopped. Chunk count:", audioChunks.length);
                    if (audioChunks.length === 0) {
                        console.log("⚠️ No audio data available.");
                        if (window.novaState.isAwake && !window.novaState.isSpeaking) startRecording();
                        return;
                    }

                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
                    const arrayBuffer = await audioBlob.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    
                    if (buffer.length < 100) {
                        console.log("⚠️ Audio buffer too small, ignoring transcription.");
                    } else {
                        uiLog("🎙️ Transcribing with Whisper...");
                        const transcription = await ipcRenderer.invoke('transcribe-audio', buffer);
                        
                        // GARBAGE FILTERING: Ignore noise, common hallucinations, or extremely short transients
                        const rawT = (transcription || "").trim();
                        const cleanT = rawT.toLowerCase().replace(/[.,?!]/g, '').replace(/-/g, ' ').trim();
                        
                        // Hallucination shield: suppress known Whisper artifacts and common background chatter
                        const hallucinationWords = ["you", "thank you", "bye", "bye bye", "goodbye", "i", "the", "a",
                            "thanks", "okay", "ok", "um", "uh", "hmm", "oh", "ah", "yes", "no", "watching", "video",
                            "please", "sorry", "excuse me", "right", "so", "well", "hey", "have fun", "enjoy",
                            "thank you for watching", "thanks for watching", "subscribe", "notification bell", "next video"];
                        
                        // Detect repeated-phrase hallucinations or background noise patterns
                        const sentences = rawT.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
                        const isRepeatedHallucination = sentences.length >= 2 && 
                            sentences.every(s => hallucinationWords.some(h => s.includes(h) || s.length < 4));
                        
                        // Background noise regex: phrases that sound like conversation but have no command intent
                        const backgroundNoiseRegex = /^(can you|if it doesn't|if you guys|just run|show up|don't know|i think|maybe|actually)/i;
                        const isBackgroundTalk = backgroundNoiseRegex.test(cleanT) && cleanT.split(' ').length > 3 && !cleanT.match(/\b(play|search|youtube|google|focus|switch|open)\b/i);

                        const commandWhitelist = /\b(hey|nova|search|find|look up|show me|play|weather|silence|stop|shut up|pause|unpause|switch|focus|open|close|click|press|select|scroll|select|pick)\b/i;
                        const isCommand = commandWhitelist.test(cleanT);

                        // VOSK OVERRIDE: If local ears saw a tactical command, bypass hallucination shield
                        const voskSawTactical = window.novaState.lastVoskText && (window.novaState.lastVoskText.toLowerCase().match(/\b(click|select|scroll|pause|stop|resume|volume|higher|lower|search|find|open|close|hey|nova)\b/i));

                        const isHallucination = !isCommand && !voskSawTactical && (
                            cleanT.length < 2 
                            || hallucinationWords.includes(cleanT)
                            || isRepeatedHallucination
                            || isBackgroundTalk
                        );

                        
                        if (cleanT && !isHallucination) {
                            // ── PHONETIC CORRECTIONS ──────────────────────────────────────────
                            // Fix common Whisper mishearings before NLU sees them
                            const PHONETIC_FIXES = {
                                // Song/artist names
                                '\\bjello\\b': 'yellow',
                                '\\bjell-o\\b': 'yellow',
                                '\\byellow\\b': 'yellow', // keep correct too
                                '\\bcold play\\b': 'coldplay',
                                '\\bcold-play\\b': 'coldplay',
                                '\\bspot if i\\b': 'spotify',
                                '\\bspot-if-i\\b': 'spotify',
                                '\\byou tube\\b': 'youtube',
                                '\\byou-tube\\b': 'youtube',
                                // Click mishearings
                                '\\balick\\b': 'click',
                                '\\bclique\\b': 'click',
                                '\\bcleek\\b': 'click',
                                '\\bpick\\b': 'click',
                                // Commands
                                '\\bswitch two\\b': 'switch to',
                                '\\bno va\\b': 'nova',
                                '\\bhey know\\b': 'hey nova',
                                '\\bhey nova\\b': 'hey nova',
                                '\\bopen up\\b': 'open',
                                '\\bvs code\\b': 'vscode',
                                '\\bv s code\\b': 'vscode',
                                '\\bnoiva\\b': 'nova',
                                '\\bhey noiva\\b': 'hey nova',
                                '\\bno eva\\b': 'nova',
                            };
                            let correctedT = rawT;
                            for (const [pattern, replacement] of Object.entries(PHONETIC_FIXES)) {
                                correctedT = correctedT.replace(new RegExp(pattern, 'gi'), replacement);
                            }
                            if (correctedT !== rawT) {
                                console.log(`🔤 Phonetic correction: "${rawT}" → "${correctedT}"`);
                                uiLog(`🔤 Corrected: "${correctedT}"`);
                            }
                            await processCommand(correctedT);

                        } else {
                            console.log(`🔇 Ignoring noise/hallucination: "${rawT}"`);
                            if (cleanT.length > 0) {
                                uiLog(`🔇 Noise Ignored: "${cleanT}"`);
                                listeningSymbol.innerHTML = '🎤 Noise ignored...';
                                setTimeout(() => {
                                    if (!window.novaState.isSpeaking) {
                                        listeningSymbol.innerHTML = window.novaState.isInConversation ? '🎤 Continuing...' : '🎤 Listening...';
                                    }
                                }, 1500);
                            }
                        }
                    }

                    // CONTINUOUS LISTENING: If still awake, start a new recording session
                    if (window.novaState.isAwake) {
                        console.log("🔄 Restarting recording for next command segment...");
                        startRecording();
                    }
                };
                
                mediaRecorder.start();
                lastAudioTime = Date.now(); // Reset silence timer when recording actually starts
                console.log("🎙️ Whisper Recording Session Started.");
            } catch (err) {
                console.error("❌ Failed to start MediaRecorder:", err);
                uiLog("Voice Error: Failed to start recorder");
            }
        };

        const stopRecording = () => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
                console.log("🎙️ Recording stopped.");
            }
        };

        const wakeUp = () => {
            stopAllPlayback();
            window.novaState.isAwake = true;
            window.novaState.isInConversation = true;
            
            // User requested: Stop songs/media when a COMMAND is recognized (moved to handlers)
            // ipcRenderer.invoke('stop-media');
            
            clearTimeout(sleepTimer);
            sleepTimer = setTimeout(() => {
                window.novaState.isAwake = false;
                window.novaState.isInConversation = false;
                uiLog("💤 Entered Sleep Mode");
            }, 30000); // Longer timeout for conversations
        };

        const endConversation = () => {
            window.novaState.isAwake = false;
            window.novaState.isInConversation = false;
            accumulatedSpeech = "";
            clearTimeout(sleepTimer);
            stopRecording(); // Stop any active command recording immediately
            uiLog("👋 Conversation ended. Say 'Hey Nova' to start again.");
        };

        // Expose to global scope via window.novaVoice
        window.novaVoice.startRecording = startRecording;
        window.novaVoice.stopRecording = stopRecording;
        window.novaVoice.wakeUp = wakeUp;
        window.novaVoice.endConversation = endConversation;

        // Listen dynamically as the user speaks words
        recognizer.on("partialresult", (message) => {
            const text = message.result.partial.toLowerCase();
            if(!text) return;

            // Start recording as soon as we hear a potential wake word or direct control
            if(!window.novaState.isAwake && text.match(/\b(hey|hay|hi|play|look|see|volume|lower|higher|quieter|louder|stop|pause)\b/i)) {
                window.novaVoice.wakeUp();
                window.novaVoice.startRecording();
            }

            // INSTANT WAKE: Unsilence immediately if wake word is heard in partials
            const wakeRegex = /\b(hey|hay|hi|ey|hello)\b.*?\b(nova|noiva|noah|noa|know|no|know a)\b/i;
            if (window.novaState.isSilenced && text.match(wakeRegex)) {
                window.novaState.isSilenced = false;
                uiLog("🔔 Instant Wake detected in Partial (Unsilencing)");
            }

            if(window.novaState.isAwake) {
                listeningSymbol.innerHTML = window.novaState.isInConversation ? '🎤 Continuing conversation...' : '🎤 Listening...';
                listeningSymbol.style.color = '#0ff';
                listeningSymbol.style.display = 'block';
                
                // Hide [unk] from the subtitle to avoid confusion
                const cleanText = text.replace(/\[unk\]/g, '').trim();
                if (cleanText) {
                    // SILENCE VISIBILITY: Hide transcripts if silenced
                    if (!window.novaState.isSilenced) {
                        subtitleElement.innerText = cleanText;
                    } else {
                        subtitleElement.innerText = "";
                    }
                    uiLog(`Partial (Vosk): "${cleanText}"`);
                }

                clearTimeout(sleepTimer);
                clearTimeout(speechTimer);
            }
        });
        
        // Triggered when user finishes sentence and falls silent
        recognizer.on("result", (message) => {
            let text = message.result.text.toLowerCase().trim();
            
            // Filter [unk] from final result
            text = text.replace(/\[unk\]/g, '').trim();
            if(!text) return;

            // WAKE WORD DETECTION (Instant Wake)
            const wakeRegex = /\b(hey|hay|hi|ey|hello)\b.*?\b(nova|noiva|noah|noa|know|no|know a)\b/i;
            if (text.match(wakeRegex)) {
                if (window.novaState.isSilenced) {
                    console.log("🔔 Instant Wake detected in Vosk (Unsilencing)");
                    window.novaState.isSilenced = false;
                    uiLog("🔔 Nova is back!");
                }
            }

            // SILENCE MODE: Ignore everything except the wake word if silenced
            if (text) window.novaState.lastVoskText = text;

            if (window.novaState.isSilenced && !text.match(wakeRegex)) {
                console.log("🤫 Vosk Ignored (Silenced Mode):", text);
                subtitleElement.innerText = ""; // Ensure UI is clean
                return;
            }

            // INSTANT SILENCE: Catch "silence" immediately from the fast engine
            if (text.match(/\b(silence|stop listening|shut up)\b/i)) {
                console.log("⚡ Instant Silence detected in Vosk:", text);
                window.novaState.isSilenced = true;
                uiLog("🔇 Silence mode activated (Instant).");
                subtitleElement.innerText = ""; 
                speak("Okay, I'll be quiet now.");
                return;
            }
            
            const interruptKeywords = ['stop', 'play it', 'see', 'look', 'wait', 'quiet', 'hey', 'nova', 'click', 'select', 'pick'];
            const isInterrupt = interruptKeywords.some(kw => text.includes(kw));

            // IGNORE INPUT WHILE NOVA IS SPEAKING unless it's an interruption
            if (window.novaState.isSpeaking && !isInterrupt) {
                console.log("🤫 Ignoring STT input because Nova is speaking.");
                return;
            } else if (window.novaState.isSpeaking && isInterrupt) {
                console.log("🛑 Interruption detected! Stopping speech...");
                // Stop any audio being played by Piper or Fallback
                const audioPlayer = document.querySelector('audio');
                if (audioPlayer) {
                    audioPlayer.pause();
                    audioPlayer.currentTime = 0;
                }
                window.speechSynthesis.cancel();
                window.novaState.isSpeaking = false;
            }

            // WAKE UP: If asleep, wake up on greeting or direct command
            const isSelection = window.novaState.pendingChoices.length > 0 && text.match(/\b(one|first|two|second|three|third|four|fourth|1|2|3|4)\b/i);
            
            if (!window.novaState.isAwake && (text.match(/\b(hey|hay|hi|volume|lower|higher|stop|pause|scroll|noiva)\b/i) || isSelection)) {
                window.novaVoice.wakeUp();
                // DIRECT TACTICAL COMMANDS ONLY (Volume, Pause, Scroll)
                if (text.match(/\b(pause|stop|resume|volume|lower|higher|quieter|louder|increase|decrease|scroll|hey|nova)\b/i)) {
                    console.log("⚡ Tactical Direct Command detected in Vosk (Waking up):", text);
                    window.novaState.lastDirectCommandTime = Date.now();
                    window.novaState.lastDirectCommandText = text;
                    processCommand(text);
                } else {
                    window.novaVoice.startRecording();
                }
                return;
            }

            if (window.novaState.isAwake && text.match(/\b(pause|stop|resume|volume|lower|higher|quieter|louder|increase|decrease|scroll|close)\b/i)) {
                 console.log("⚡ Tactical Direct Command detected in Vosk (Active):", text);
                 window.novaState.lastDirectCommandTime = Date.now();
                 window.novaState.lastDirectCommandText = text;
                 stopRecording(); 
                 processCommand(text);
                 return;
            }

            if (window.novaState.isAwake && window.novaState.pendingChoices.length > 0) {
                const selectionPattern = /\b(one|first|two|second|three|third|four|fourth|1|2|3|4)\b/i;
                if (selectionPattern.test(text)) {
                    console.log("⚡ Immediate Selection detected in Vosk:", text);
                    uiLog(`⚡ Selection: "${text}"`);
                    stopRecording(); 
                    processCommand(text);
                    return;
                }
            }

            // IMMEDIATE PLATFORM HANDLING: If we are awaiting choice between Google vs YouTube,
            // process it instantly to avoid the Whisper silencer delay.
            if (window.novaState.isAwake && window.novaState.isAwaitingPlatform) {
                const platformPattern = /\b(google|youtube|video|search|browser)\b/i;
                if (platformPattern.test(text)) {
                    console.log("⚡ Immediate Platform selection detected in Vosk:", text);
                    uiLog(`⚡ Platform: "${text}"`);
                    stopRecording(); 
                    processCommand(text);
                    return;
                }
            }

            if (window.novaState.isAwake) {
                // We no longer stop recording here; the volume-based silencer handles it!
                // This prevents "hey nova" from cutting off the actual command.
                console.log("👂 Vosk segment ended, but keeping Whisper recording active...");
            }
        });
        
        const audioContext = new window.AudioContext({ sampleRate: 16000 });
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 2.5; // Significant boost for distant voice / low-signal mics
        
        const micSource = audioContext.createMediaStreamSource(mediaStream);
        micSource.connect(gainNode);

        // Chromium Autoplay Policies strictly suspend AudioContexts if they are created without a user gesture.
        // Because Electron auto-grants microphone permissions, this script runs 0ms after boot, 
        // completely starving the AI Vosk engine of an active ticking microphone array unless we resume!
        if (audioContext.state === 'suspended') {
            uiLog("⚠️ Click the Robot once to activate Voice AI");
            const resumeAudio = () => {
                if (audioContext.state === 'suspended') {
                    audioContext.resume().then(() => {
                        uiLog("🎙️ Engine Unlocked! Say 'Hey'");
                    }).catch(err => console.error("Resume failed:", err));
                }
                window.removeEventListener('pointerdown', resumeAudio);
            };
            window.addEventListener('pointerdown', resumeAudio);
        } else {
            uiLog("🎙️ Engine Active! Say 'Hey'");
        }
        const recognizerNode = audioContext.createScriptProcessor(4096, 1, 1);
        gainNode.connect(recognizerNode);
        let meterThrottle = 0;
        recognizerNode.onaudioprocess = (event) => {
            try { 
                if (recognizer) recognizer.acceptWaveform(event.inputBuffer); 
                
                const data = event.inputBuffer.getChannelData(0);
                let maxVol = 0;
                for (let i = 0; i < data.length; i++) {
                    if (Math.abs(data[i]) > maxVol) maxVol = Math.abs(data[i]);
                }

                // Volume-based silence detection for Whisper trigger
                if (window.novaState.isAwake && mediaRecorder && mediaRecorder.state === 'recording') {
                    if (maxVol > silenceThreshold) {
                        lastAudioTime = Date.now();
                    } else {
                        if (Date.now() - lastAudioTime > silenceDuration) {
                            console.log("🤫 Silence detected via volume filter. Triggering Whisper...");
                            stopRecording();
                            subtitleElement.style.color = '#fb0';
                            listeningSymbol.innerHTML = '⚙️ Processing...';
                            listeningSymbol.style.color = '#fb0';
                        }
                    }
                }

                if (meterThrottle++ % 10 === 0) {
                    const bars = '|'.repeat(Math.min(20, Math.floor(maxVol * 100)));
                    uiLog(`🎙️ Engine Active!\nVol: [${bars.padEnd(20, ' ')}]`);
                }
            } catch (error) { console.error('acceptWaveform error:', error); }
        };
        gainNode.connect(recognizerNode);
        
        // Prevent Chromium from garbage collecting the graph by connecting it to the destination speaker.

        const silentNode = audioContext.createGain();
        silentNode.gain.value = 0;
        recognizerNode.connect(silentNode);
        silentNode.connect(audioContext.destination);
        
    } catch(e) {
        uiLog("Voice Error: " + (e.message || e));
    }
}

// Start watching microphone after a short delay to ensure UI renders
setTimeout(() => {
    initOfflineVoice();
}, 2000);

// Helper to detect music intent
function isMusicIntent(query) {
    const musicKeywords = /\b(song|music|band|album|artist|singer|lyrics|concert|performance|live|track|playlist|official video|music video|coldplay|queen|beatles|adele|drake|bts|radiohead|nirvana|metallica)\b/i;
    return musicKeywords.test(query);
}

// Helper to fetch search suggestions from GPT
async function getSearchSuggestions(searchTerm, hasMusicVideo) {
    const needsMusicFocus = hasMusicVideo && isMusicIntent(searchTerm);
    const searchContext = needsMusicFocus ? 'music video' : 'video';
    uiLog(`🔍 Searching for: "${searchTerm}"${needsMusicFocus ? ' [music video]' : ''}...`);

    try {
        const shoppingKeywords = ['pixel', 'phone', 'android', 'iphone', 'ps4', 'ps5', 'buy', 'price', 'amazon', 'ebay', 'shopping', 'product', 'laptop', 'device', 'console', 'android phone'];
        const isShopping = shoppingKeywords.some(kw => searchTerm.toLowerCase().includes(kw));

        if (isShopping) {
            uiLog(`🛒 Product intent detected. Opening Search...`);
            speak(`Searching for ${searchTerm} to help you find it.`);
            ipcRenderer.invoke('browser-open', { platform: 'google', query: searchTerm });
            window.novaState.isProcessingCommand = false;
            return;
        }

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: `Suggest 2-3 precise SEARCH TOPICS for: "${searchTerm}"${searchContext ? ` (context: ${searchContext})` : ''}. ${needsMusicFocus ? 'Focus on official music videos and live performances.' : ''} Respond ONLY with a JSON array of [{"title": "...", "url": "#"}].` }],
                max_tokens: 300,
                temperature: 0.1
            })
        });
        const d = await res.json();
        const results = JSON.parse(d.choices[0].message.content.trim().replace(/```json|```/g, ''));
        window.novaState.pendingChoices = results;
        window.novaState.isProcessingCommand = false;
        showChoices(results);
        await speak(`I found a few things about ${searchTerm}. Which one did you mean?`);
    } catch (e) {
        console.error("Search suggestion error:", e);
        // Fallback to direct search if GPT fails
        window.novaState.pendingTopic = searchTerm;
        window.novaState.isAwaitingPlatform = true;
        window.novaState.isProcessingCommand = false;
        showPlatformChoices();
        await speak(`I couldn't get suggestions, but I can search for ${searchTerm}. Google or YouTube?`);
    }
}

const processSelection = async (choice) => {
    if (!choice) return;
    window.novaState.pendingTopic = choice.title;
    window.novaState.isAwaitingPlatform = true;
    window.novaState.pendingChoices = [];
    showPlatformChoices();
    await speak(`Great choice: ${window.novaState.pendingTopic}. Would you like to search for this on Google or YouTube?`);
    window.novaState.isProcessingCommand = false;
};

// The high-accuracy Whisper transcription comes here
async function processCommand(cmd) {
    if (!cmd || cmd.trim().length === 0) {
        if (!isInConversation) {
            askGrokRealtime("Hello, Nova.");
        } else {
            askGrokRealtime("I'm listening. What can I help you with?");
        }
        subtitleElement.innerText = "";
        listeningSymbol.style.display = 'none';
        subtitleElement.style.color = '#fff';
        return;
    }

    console.log('🎯 Processing Whisper command:', cmd);
    uiLog(`🎯 Whisper: "${cmd}"`);
    
    let normalized = cmd.toLowerCase().trim();
    const now = Date.now();

    // 🩹 VOSK HEALING: Repair clipped transcriptions
    if (window.novaState.lastVoskText) {
        const vosk = window.novaState.lastVoskText.toLowerCase();
        const whisper = normalized;
        const tacticalVerbs = ['click', 'press', 'select', 'search', 'buy', 'find', 'open', 'close', 'scroll', 'go', 'move'];
        const vVerb = tacticalVerbs.find(v => vosk.match(new RegExp('\\b' + v + '\\b', 'i')));
        const wVerb = tacticalVerbs.some(v => whisper.match(new RegExp('\\b' + v + '\\b', 'i')));

        // TACTICAL DOMINANCE: If local ears saw a verb and Whisper didn't, heal it!
        const noiseKeywords = ["thank you", "watching", "video", "have fun", "enjoy", "subscribe", "you you", "thanks"];
        const whisperIsNoise = noiseKeywords.some(n => whisper.includes(n)) || whisper.length < 3;
        
        if (vVerb && !wVerb) {
            if (whisperIsNoise) {
                console.log(`🩹 Tactical Override: Whisper is noise ("${whisper}"). Using Vosk: "${vosk}"`);
                normalized = vosk;
            } else {
                console.log(`🩹 Tactical Healing: Prepending "${vVerb}" to "${whisper}" based on Vosk: "${vosk}"`);
                normalized = vVerb + " " + whisper;
            }
            uiLog("🩹 Hearing repaired...");
            // Stop talking immediately if we're healing a command
            if (window.novaState.isSpeaking) window.speechSynthesis.cancel();
        }
    }

    // ── HIGH PRIORITY FAST INTERCEPTS (Scroll, Pause, Volume) ────────────────
    // These bypass AI and deduplication to ensure instant tactical response
    if (normalized.match(/\b(scroll|go|move)\b.*?\b(down|up|bottom|top)\b/i)) {
        const direction = normalized.includes('up') || normalized.includes('top') ? 'up' : 'down';
        uiLog(`🌐 Scrolling ${direction}...`);
        ipcRenderer.send('browser-scroll', direction);
        window.novaState.lastDirectCommandTime = now;
        window.novaState.isProcessingCommand = false;
        return; 
    }
    
    if (normalized.match(/\b(pause|stop|resume|play the video)\b/i) && !normalized.includes('play ')) {
         uiLog("⏯️ Media control...");
         ipcRenderer.invoke('execute-automation', 'press-k');
         window.novaState.lastDirectCommandTime = now;
         window.novaState.isProcessingCommand = false;
         return;
    }

    // 📁 DIRECT FOLDER OPENING (Bypass AI)
    if (normalized.match(/\b(open|show|go to)\b.*?\b(folder|directory|dir|documents|downloads|desktop|project)\b/i)) {
        uiLog(`📁 Opening ${normalized}...`);
        ipcRenderer.invoke('execute-automation', normalized);
        window.novaState.isProcessingCommand = false;
        return;
    }

    // 🛒 SHOPPING & SEARCH SHORTCUT (Direct Bypass)
    // Matches "buy X", "search for X", "help me buy X", "find X"
    const shoppingMatch = normalized.match(/\b(help me (search|find|buy)|search for buying|search for|buy|find)\b\s+(.+)/i);
    if (shoppingMatch && !normalized.includes('how to')) {
        const query = shoppingMatch[3].trim();
        const isVideo = query.includes('video') || query.includes('music');
        const platform = isVideo ? 'youtube' : 'google';
        uiLog(`🛒 Direct Shopping: "${query}"...`);
        speak(`Searching for ${query} on ${platform}.`);
        ipcRenderer.invoke('browser-open', { platform, query: query });
        window.novaState.lastDirectCommandTime = now;
        window.novaState.isProcessingCommand = false;
        return;
    }

    // SILENCE VISIBILITY: Hide transcripts if silenced
    if (!window.novaState.isSilenced) {
        subtitleElement.innerText = cmd;
        subtitleElement.style.color = '#fb0';
    } else {
        subtitleElement.innerText = "";
    }

    // ── CRITICAL INTERCEPTS (Silence & Hotkeys) ─────────────────────────
    // Deduplication: prevent Vosk and Whisper from double-firing direct commands
    const isDirectDedupe = (now - (window.novaState.lastDirectCommandTime || 0) < 2500);

    // 1. Volume Control
    if (normalized.match(/\b(higher the volume|volume up|increase volume|louder|increase)\b/i)) {
        uiLog("🔊 Increasing system volume...");
        ipcRenderer.invoke('execute-automation', 'increase-volume');
        window.novaState.lastDirectCommandTime = now;
        window.novaState.isProcessingCommand = false;
        return;
    }
    if (normalized.match(/\b(lower the volume|volume down|decrease volume|quieter|decrease)\b/i)) {
        uiLog("🔉 Decreasing system volume...");
        ipcRenderer.invoke('execute-automation', 'decrease-volume');
        window.novaState.lastDirectCommandTime = now;
        window.novaState.isProcessingCommand = false;
        return;
    }

    // 2. Browser Window Management (Close)
    if (normalized.match(/\b(close|exit|terminate|hide)\b.*?\b(browser|window|nova browser)\b/i)) {
        uiLog("🌐 Closing Nova Browser...");
        ipcRenderer.send('browser-close');
        window.novaState.isProcessingCommand = false;
        return;
    }

    // 3. Silence Mode (Quiet Mode)
    if (normalized.match(/\b(silence|stop listening|shut up|be quiet|go to sleep|sleep mode|deactivate|quiet mode|go quiet|ignore me|don't listen)\b/i)) {
        if (!window.novaState.isSilenced) {
            window.novaState.lastDirectCommandTime = now;
            window.novaState.isSilenced = true;
            uiLog("🔇 Silence mode activated. Say 'Hey' to wake me.");
            speak("Okay, I'll be quiet now. Just say 'Hey Nova' when you need me again.");
        }
        return;
    }

    // 6. Waking from Silence
    if (window.novaState.isSilenced) {
        // Stricter wake word for silence: require a greeting and the name
        const wakeMatch = normalized.match(/\b(hey|hay|hi|ey|hello)\b.*?\b(nova|noah|noa|know|no|know a)\b/i);
        if (wakeMatch) {
            window.novaState.isSilenced = false;
            uiLog("🔔 Nova is back!");
            // Strip everything BEFORE the wake word (it was said during silence)
            const wakeIdx = normalized.indexOf(wakeMatch[0]);
            if (wakeIdx >= 0) {
                cmd = cmd.substring(wakeIdx).trim();
                normalized = cmd.toLowerCase();
                console.log("✂️ Stripped prep-talk precisely. New cmd:", cmd);
            }
            // Fall through to process the rest of the command!
        } else {
            console.log("🤫 Whisper Ignored (Silenced Mode):", cmd);
            window.novaState.isProcessingCommand = false; // Reset if ignored
            return;
        }
    }
    


    // ── LOCAL SELECTION INTERCEPT (ZERO LATENCY) ────────────────────────────
    if (window.novaState.pendingChoices.length > 0) {
        const selMatch = normalized.match(/\b(one|first|1|two|second|2|three|third|3|four|fourth|4)\b/i);
        if (selMatch) {
            const word = selMatch[0].toLowerCase();
            let index = -1;
            if (word.match(/\b(one|first|1)\b/)) index = 0;
            else if (word.match(/\b(two|second|2)\b/)) index = 1;
            else if (word.match(/\b(three|third|3)\b/)) index = 2;
            else if (word.match(/\b(four|fourth|4)\b/)) index = 3;
            
            if (index >= 0 && index < window.novaState.pendingChoices.length) {
                const choice = window.novaState.pendingChoices[index];
                uiLog(`✅ Local Selection: ${choice.title}`);
                processSelection(choice); // Use the correct internal name or refactor
                return;
            }
        }
    }

    // Refresh sleep timer since user is active
    if (window.novaState.isAwake) window.novaVoice.wakeUp();

    // Clean wake words if they were caught in the recording (with optional punctuation)
    cmd = cmd.replace(/^(hey|hay|hi|ey|hello)\b[.,:]*\s+(nova|noah|noa|know|no|know a)\b[.,:]*/i, '').trim();
    
    // Check for context reset
    if (cmd.match(/\b(hey|hay|hi)\s+nova\b/)) {
        window.novaState.currentPlatform = null;
        window.novaState.pendingTopic = null;
        window.novaState.isAwaitingPlatform = false;
        hideChoices();
        uiLog("🔄 Context reset by 'Hey Nova'");
    }

    // Check for conversation end commands (ignore if we have pending choices to avoid noise-driven sleep)
    if ((cmd.includes('bye') || cmd.includes('goodbye') || cmd.includes('see you')) && window.novaState.pendingChoices.length === 0) {
        ipcRenderer.invoke('stop-media'); // Pause if talking
        speak("Goodbye! Have a great day!");
        window.novaVoice.endConversation();
        subtitleElement.innerText = "";
        listeningSymbol.style.display = 'none';
        subtitleElement.style.color = '#fff';
        return;
    }

    // ── BROWSER AGENT COMMANDS ──────────────────────────────────────────────
    const clickMatch = normalized.match(/\b(click|press|select)\s+(on\s+)?(.+)/i);
    if (clickMatch && !normalized.includes('select one') && !normalized.includes('select 1')) {
        let target = clickMatch[3].trim().replace(/[.,?!]+$/, ''); // STRIP PUNCTUATION
        if (window.novaState.isSpeaking) window.speechSynthesis.cancel();
        if (target.length > 0) {
            uiLog(`🖱️ Scanning for: "${target}"...`);
            ipcRenderer.send('browser-get-map');
            
            // Timeout for map request
            let mapTimeout = setTimeout(() => {
                console.error("🕒 AI Click Error: DOM Map request timed out (5s).");
                uiLog("🕒 Nova is taking too long to see the page. Trying fallback...");
                ipcRenderer.send('browser-click', target); 
            }, 5000);

            // Listen for DOM map results
            ipcRenderer.once('browser-dom-map', async (event, elements) => {
                clearTimeout(mapTimeout);
                console.log(`🧠 AI Click: Received DOM map with ${elements?.length || 0} elements.`);
                if (!elements || elements.length === 0) {
                    uiLog("⚠️ No interactive elements found.");
                    ipcRenderer.send('browser-click', target); // Fallback
                    return;
                }
                
                // FAST MATCH: Exact text or title match
                const exactMatch = elements.find(el => 
                    (el.text && el.text.toLowerCase().trim() === target.toLowerCase().trim()) ||
                    (el.title && el.title.toLowerCase().trim() === target.toLowerCase().trim()) ||
                    (el.ariaLabel && el.ariaLabel.toLowerCase().trim() === target.toLowerCase().trim())
                );
                
                if (exactMatch) {
                    uiLog(`🖱️ Exact Match: "${target}" -> ID ${exactMatch.id}`);
                    ipcRenderer.send('browser-click-id', exactMatch.id);
                    return;
                }
                
                const prompt = `Which element ID (number) best matches the user's intent to click on "${target}"?\nInteractive Elements:\n${JSON.stringify(elements)}\nReturn ONLY the ID number. If no match, return -1.`;
                console.log("🧠 Sending resolution prompt to Grok...");
                const result = await ipcRenderer.invoke('ask-grok', prompt);
                console.log("🧠 Grok resolution result:", result);
                const elementId = parseInt(result.replace(/[^0-9-9]/g, ''));
                
                if (elementId !== -1 && !isNaN(elementId)) {
                    ipcRenderer.send('browser-click-id', elementId);
                    uiLog(`🖱️ AI Clicked element ID ${elementId}`);
                } else {
                    uiLog(`⚠️ AI couldn't resolve "${target}". Trying literal...`);
                    ipcRenderer.send('browser-click', target); // Fallback
                }
            });
            window.novaState.isProcessingCommand = false;
            return;
        }
    }

    // Directly handle "search for X" or "find X" to prevent GPT from misrouting
    // it to "switch window" or other intents. Allow for leading non-word characters.
    const searchMatch = cmd.match(/^\W*(search for|find|look up|show me)\s+(.+)/i);
    if (searchMatch) {
        const query = searchMatch[2].trim();
        if (query.length > 2) {
            console.log("⚡ Search Intercept Triggered:", query);
            uiLog(`⚡ Search: "${query}"`);
            ipcRenderer.invoke('stop-media'); 
            const hasMusic = isMusicIntent(query);
            await getSearchSuggestions(query, hasMusic); 
            return;
        }
    }

    if (window.novaState.isProcessingCommand) {
        // HANDSHAKE: If this is a Whisper/Vosk race, allow the incoming command to "upgrade" the previous fast one
        const now = Date.now();
        const isDeduplication = (now - window.novaState.lastDirectCommandTime < 2500);
        if (isDeduplication) {
            console.log("🔄 Whisper Upgraded command:", cmd);
            uiLog(`🔄 Upgrading: "${cmd}"`);
            // Force reset processing flag to allow this upgrade to go through
            window.novaState.isProcessingCommand = false;
        } else {
            console.log('⏳ Already processing a command, ignoring...');
            uiLog('⏳ Still thinking, please wait...');
            return;
        }
    }

    // Prefix Cleanup: Strip misheard Nova/Nobody/Body
    let cleanedCmd = cmd.replace(/^(nova|nobody|body|hey nova|hey nobody|hey body)\s+/i, '').trim();

    // ── PRE-GPT SELECTION INTERCEPT ─────────────────────────────────────────
    // When choices are displayed, resolve number-selection locally so GPT can't
    // misroute "number two", "option 2", "select 3", etc. to other commands.
    if (window.novaState.pendingChoices.length > 0) {
        const t = cleanedCmd.toLowerCase().replace(/[.,?!-]/g, ' ').replace(/\s+/g, ' ').trim();
        let selIndex = -1;
        // digit match: "2", "select 2", "option 2", "number 2"
        const digitMatch = t.match(/\b([1-9])\b/);
        if (digitMatch) {
            selIndex = parseInt(digitMatch[1]) - 1;
        } else if (/\b(one|first|number one|option one|select one)\b/.test(t)) {
            selIndex = 0;
        } else if (/\b(two|second|number two|option two|select two)\b/.test(t)) {
            selIndex = 1;
        } else if (/\b(three|third|number three|option three|select three)\b/.test(t)) {
            selIndex = 2;
        } else if (/\b(four|fourth)\b/.test(t)) {
            selIndex = 3;
        }

        // Guard: if the user said goodbye/bye while choices are showing,
        // treat it as noise and reprompt instead of ending the conversation.
        const goodbyePattern = /\b(bye|goodbye|good bye|bye bye|see you|exit|quit|stop|cancel)\b/;
        if (selIndex < 0 && goodbyePattern.test(t)) {
            window.novaState.isProcessingCommand = false;
            await speak('Please choose one of the options — say a number like "one", "two", or "three".');
            return;
        }

        if (selIndex >= 0 && selIndex < window.novaState.pendingChoices.length) {
            const choice = window.novaState.pendingChoices[selIndex];
            window.novaState.pendingTopic = choice.title;
            window.novaState.isAwaitingPlatform = true;
            window.novaState.pendingChoices = [];
            window.novaState.isProcessingCommand = false;
            showPlatformChoices();
            uiLog(`📌 Selected: "${choice.title}". Awaiting platform...`);
            await speak(`Great choice: ${choice.title}. Would you like to search on Google or YouTube?`);
            return;
        }
    }

    // FIRST, send to ChatGPT/Grok to interpret command
    const interpretationPrompt = `Interpret this user command: "${cleanedCmd}"
    
    Context: 
    - Available Choices: ${window.novaState.pendingChoices.length}
    - Awaiting Platform: ${window.novaState.isAwaitingPlatform ? 'YES' : 'NO'} (Topic: "${window.novaState.pendingTopic}")
    - Active Platform Context: ${window.novaState.currentPlatform || 'Desktop'}

    Rules:

    - FIRST PRIORITY: If user says "switch to <app>", "go to <app>", "focus <app>", "bring up <app>", "open <app>" where <app> is a specific application name (examples: browser, firefox, chrome, brave, vscode, code, cursor, intellij, idea, pycharm, terminal, konsole, excel, spreadsheet, calc, libreoffice, word, writer, powerpoint, impress, files, dolphin, discord, slack, telegram, spotify, vlc, gimp, blender, obsidian, zoom), respond with: "focus <app>" where <app> is just the lowercase application name (e.g. "focus browser", "focus vscode", "focus excel", "focus intellij")
    - SECOND PRIORITY: If user says "switch window", "switch app", "next app", "next window", "alt tab", "change app", "change window", or "switch to another" WITHOUT naming a specific application, respond with exactly: "switch window"
    - If user asks a general question (e.g. "what's the weather", "tell me a joke", "who is", "how are you"), or if the sentence sounds like background talk (e.g. "if it doesn't show up"), respond with: "chat [original_text]"

    - If Awaiting Platform is YES and user says "google", "youtube" or "video", respond with just the platform name.
    - If user is selecting an option (e.g. "one", "first", "second", "2") AND Choices > 0, respond with: "select [number]"
    - If user says playing intent like "play X", "play song X", "play music video of X", "show me the video of X", "music video X", respond with: "play [full query including 'music video' if mentioned]" e.g. "play coldplay music video" or "play yellow by coldplay music video"
    - If user says "play the video", "resume the video", "pause the video" or just "play" or "pause", respond with: "play" 
    *   IF the intent is to SEARCH for a product, buy something, or find information (e.g. "iPhone 15", "stock prices", "how to buy X"), return: search <query>
    - If user says searching intent (e.g. "search for X", "find X", "buy X", "help me search for X"), respond with: "search [query]"
    - If user says "close browser", "exit browser", "close window", respond with: "close browser"
    - If user says "stop", "pause", "wait", "hold on", "quiet", "shut up", respond with "stop". 
    - NOTE: Do NOT return "stop" for polite greetings or goodbyes (e.g. "bye", "see you", "all right"). For those, just respond with the original text or "chat [text]".
    - Otherwise, respond with the action: ${cleanedCmd}
    Respond with ONLY the final command string. Do not use square brackets unless it's literally part of the command text.`;
    
    window.novaState.isProcessingCommand = true;
    uiLog('🤖 Thinking...');
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: `You are a command interpreter. AVAILABLE ACTIONS: - "see [original text]" (visual intent) - "select [number]" (ONLY if options > 0) - "search [video/link] [query]" - "play [song name]" - "focus [app name]" (switch to/open a specific app) - "switch window" (cycle to next window, NO specific app). Respond with ONLY the command.` },
                    { role: 'user', content: interpretationPrompt }
                ],
                max_tokens: 50,
                temperature: 0.1
            })
        });
        const data = await response.json();
        let interpretedCommand = data.choices[0].message.content.trim().toLowerCase();
        
        // Handle explicit "CHAT" intent
        if (interpretedCommand.startsWith('chat ')) {
            window.novaState.isProcessingCommand = false;
            await askGrokRealtime(interpretedCommand.replace('chat ', ''));
            return;
        }

        console.log('🤖 Interpreted command:', interpretedCommand);
        uiLog(`🤖 Interpreted: "${interpretedCommand}"`);
         // Command type detection
         const automationKeywords = ['open', 'search', 'youtube', 'browser', 'folder', 'vscode', 'cursor', 'antigravity', 'terminal', 'files', 'chrome', 'firefox', 'google', 'twitter', 'instagram', 'facebook', 'github', 'linkedin', 'click', 'video', 'link', 'directory', 'dir', 'play', 'song', 'switch', 'alt tab', 'focus', 'volume'];
         const selectionKeywords = ['select', 'first', 'second', 'third', 'one', 'two', 'three', 'choice', 'option', '1', '2', '3'];
        
        let isAutomationCommand = automationKeywords.some(keyword => interpretedCommand.includes(keyword));
        
        // Selection handling
        if (window.novaState.pendingChoices.length > 0 && selectionKeywords.some(kw => interpretedCommand.includes(kw))) {
            isAutomationCommand = true;
        }
        
        // Platform handling
        if (window.novaState.isAwaitingPlatform) {
            if (interpretedCommand.includes('google') || interpretedCommand.includes('youtube') || interpretedCommand.includes('search')) {
                isAutomationCommand = true;
            }
        }
        
        // Check if it's a question or conversation
        const questionWords = ['what', 'how', 'why', 'when', 'where', 'who', 'can you', 'could you', 'would you', 'should i', 'recommend', 'suggest', 'tell me', 'explain', 'do you', 'are there'];
        const isQuestion = questionWords.some(word => interpretedCommand.includes(word));
        
        if (isQuestion && !isAutomationCommand) {
            window.novaState.isProcessingCommand = false;
            await askGrokRealtime(cmd);
            return;
        }
        
        const normalizedCmd = interpretedCommand
            .replace(/you tube|youtube|you toob|utube/gi, 'youtube')
            .replace(/google search|google/gi, 'google');
        
        if (isAutomationCommand) {
            // Selection Logic
            if (window.novaState.pendingChoices.length > 0 && selectionKeywords.some(kw => normalizedCmd.includes(kw))) {
                let index = -1;
                
                // Try digit extraction first (select 1, option 2)
                const digitMatch = normalizedCmd.match(/\d+/);
                if (digitMatch) {
                    index = parseInt(digitMatch[0]) - 1;
                } else {
                    // Fallback to word matching
                    if (normalizedCmd.includes('first') || normalizedCmd.includes('one')) index = 0;
                    else if (normalizedCmd.includes('second') || normalizedCmd.includes('two')) index = 1;
                    else if (normalizedCmd.includes('third') || normalizedCmd.includes('three')) index = 2;
                }
                
                if (index >= 0 && index < window.novaState.pendingChoices.length) {
                    processSelection(window.novaState.pendingChoices[index]);
                    return;
                }
            }



            // Platform Choice
            if (window.novaState.isAwaitingPlatform && (normalizedCmd.includes('google') || normalizedCmd.includes('youtube') || normalizedCmd.includes('video'))) {
                const platform = (normalizedCmd.includes('youtube') || normalizedCmd.includes('video')) ? 'youtube' : 'google';
                await ipcRenderer.invoke('browser-search', { platform, query: window.novaState.pendingTopic });
                window.novaState.isAwaitingPlatform = false;
                window.novaState.isProcessingCommand = false;
                hideChoices();

                // Auto-play YouTube
                if (platform === 'youtube') {
                    console.log("📺 Auto-playing YouTube video...");
                    setTimeout(async () => {
                        await ipcRenderer.invoke('execute-automation', 'press-k');
                    }, 5000); 
                }
                return;
            }

            // Search/Play
            if (normalizedCmd.includes('search') || normalizedCmd.includes('play')) {
                ipcRenderer.invoke('stop-media'); // confirmed automation intent, stop current media
                // Preserve 'music video' as a unit before stripping other words
                const hasMusicVideo = /music video/i.test(normalizedCmd);
                let searchTerm = normalizedCmd
                    .replace(/\b(search|play|link|the|this|that|it)\b/gi, '') // keep 'video','music'
                    .trim();
                // If user didn't say 'music video' but only said 'video', strip it
                if (!hasMusicVideo) {
                    searchTerm = searchTerm.replace(/\bvideo\b/gi, '').trim();
                }
                if (!searchTerm && normalizedCmd.includes('play')) {
                    await ipcRenderer.invoke('play-media');
                    await speak("Resuming playback.");
                    window.novaState.isProcessingCommand = false;
                    return;
                }
                
                // If the only word left is "the" or similar, it's a resume/vision failure fallback
                if (!searchTerm || searchTerm.length < 2) {
                    await ipcRenderer.invoke('play-media');
                    await speak("Resuming playback.");
                    window.novaState.isProcessingCommand = false;
                    return;
                }
                
                const isVideo = hasMusicVideo || (normalizedCmd.includes('play') && isMusicIntent(searchTerm)) || normalizedCmd.includes('video') || normalizedCmd.includes('music');
                
                // UNIFIED BROWSER ROUTING: Always use the internal agent
                const platform = isVideo ? 'youtube' : 'google';
                uiLog(`🌐 Browser Agent: ${platform} for "${searchTerm}"...`);
                speak(`Opening ${platform} for ${searchTerm}.`);
                ipcRenderer.invoke('browser-open', { platform, query: searchTerm });
                
                window.novaState.isProcessingCommand = false;
                return;
            }

            // App-Specific Focus / Launch ("switch to browser", "switch to vscode", etc.)
            if (normalizedCmd.startsWith('focus ')) {
                const appName = normalizedCmd.replace(/^focus\s+/, '').trim();
                const resultMsg = await ipcRenderer.invoke('focus-app', appName);
                window.novaState.isProcessingCommand = false;
                await speak(resultMsg);
                return;
            }

            // Window Switching (Alt+Tab)
            if (normalizedCmd.includes('switch') || normalizedCmd.includes('alt tab')) {
                await ipcRenderer.invoke('switch-window');
                window.novaState.isProcessingCommand = false;
                await speak('Switching to the next window.');
                return;
            }

            // Direct Automation
            ipcRenderer.invoke('stop-media'); // Stop media for direct commands
            const resp = await ipcRenderer.invoke('execute-automation', normalizedCmd);
            window.novaState.isProcessingCommand = false;
            await speak(resp);
        } else {
            window.novaState.isProcessingCommand = false;
            await askGrokRealtime(cmd);
        }
    } catch (error) {
        window.novaState.isProcessingCommand = false;
        console.error('interpretation error:', error);
        // If it was a search/play, don't fallback to chat, just reset
        if (!cmd.match(/\b(search|play)\b/i)) {
            await askGrokRealtime(cmd);
        }
    }
    
    subtitleElement.innerText = "";
    subtitleElement.style.color = '#fff';
    listeningSymbol.style.display = 'none';
    if (window.novaVoice.wakeUp) window.novaVoice.wakeUp();
}
