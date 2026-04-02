require('dotenv').config();
const { GoogleGenAI, Modality } = require('@google/genai');
const { ipcMain } = require('electron');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let activeSession = null;
let mainWindowRef = null;
let automationRef = null;

async function startLiveSession(mainWindow, automation) {
    mainWindowRef = mainWindow;
    automationRef = automation;
    if (activeSession) {
        console.log('Live Session already active.');
        return;
    }

    try {
        console.log('🔄 Connecting to Gemini Live API with Visual DOM Mapping...');

        const model = 'gemini-3.1-flash-live-preview';
        activeSession = await ai.live.connect({
            model: model,
            config: {
                tools: [
                    { googleSearch: {} },
                    {
                        functionDeclarations: [
                            {
                                name: "get_browser_state",
                                description: "Retrieves the current state of the browser window, including the current URL and a list of all interactive elements (buttons, links, search bars) with their IDs and text. Use this before clicking to ensure you have the correct element ID.",
                                parameters: { type: "OBJECT", properties: {} }
                            },
                            {
                                name: "control_browser",
                                description: "Controls the internal Nova Browser window. Use this to open websites, search for products/videos/news, scroll the page, or click elements by ID.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        action: {
                                            type: "STRING",
                                            enum: ["open", "scroll", "click_id", "smart_click", "search_youtube", "close"],
                                            description: "The type of browser action to perform."
                                        },
                                        query: {
                                            type: "STRING",
                                            description: "The search query or URL (used with 'open' or 'search_youtube')."
                                        },
                                        direction: {
                                            type: "STRING",
                                            enum: ["up", "down", "top", "bottom"],
                                            description: "The scroll direction (used with 'scroll')."
                                        },
                                        element_id: {
                                            type: "INTEGER",
                                            description: "The ID of the element to click (obtained from get_browser_state)."
                                        },
                                        target_text: {
                                            type: "STRING",
                                            description: "The text to fuzzy-search and click (used with 'smart_click' if ID is unknown)."
                                        }
                                    },
                                    required: ["action"]
                                }
                            },
                            {
                                name: "execute_system_command",
                                description: "Executes a system-level command on the desktop such as opening local apps (VS Code, Terminal), controlling volume, or opening local folders.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        command: {
                                            type: "STRING",
                                            description: "The tactical command, e.g. 'open vscode', 'open terminal', 'increase volume', 'open documents folder'."
                                        }
                                    },
                                    required: ["command"]
                                }
                            }
                        ]
                    }
                ],
                responseModalities: [Modality.AUDIO],
                systemInstruction: "You are Nova, an advanced multilingual AI assistant. \n\nVISION & BROWSING:\nYou have a Browser tool. \n1. To see what is on the screen, ALWAYS call 'get_browser_state' first. This gives you a list of elements with their unique IDs.\n2. Once you have the elements, use 'control_browser' with action='click_id' and the specific element_id. This is much more accurate than smart_click.\n3. Be proactive: if the user wants to buy something, suggest options, open the browser, and then use 'get_browser_state' to help them find the right item.\n4. Always speak in the user's language."
            },
            callbacks: {
                onopen: () => {
                    console.log('✅ Connected to Gemini Live API (Visual Mapping Enabled)');
                    mainWindow.webContents.send('live-session-event', { event: 'opened' });
                },
                onmessage: (message) => {
                    if (message.serverContent && message.serverContent.interrupted) {
                        mainWindow.webContents.send('live-session-event', { event: 'interrupted' });
                    }
                    if (message.serverContent && message.serverContent.modelTurn && message.serverContent.modelTurn.parts) {
                        for (const part of message.serverContent.modelTurn.parts) {
                            if (part.inlineData && part.inlineData.data) {
                                mainWindow.webContents.send('live-audio-chunk', part.inlineData.data);
                            }
                            if (part.text) {
                                mainWindow.webContents.send('live-text-chunk', part.text);
                            }
                        }
                    }

                    // HANDLE TOOL CALLS
                    if (message.toolCall) {
                        for (const call of message.toolCall.functionCalls) {
                            if (call.name === 'get_browser_state') {
                                console.log('📁 [Tool] Requesting Browser State...');
                                if (automationRef) automationRef.getDomMap();

                                // Capture the one-time response (emitted from main.js)
                                ipcMain.once('dom-map-available', (map) => {
                                    console.log(`👁️ [Tool] Returning Browser State (${map?.length || 0} elements)`);
                                    activeSession.sendRealtimeInput({
                                        functionResponses: [{
                                            id: call.id,
                                            response: {
                                                elements: (map || []).slice(0, 50),
                                                url: "Active Page"
                                            }
                                        }]
                                    });
                                });
                            } else if (call.name === 'control_browser') {
                                const { action, query, direction, element_id, target_text } = call.args;
                                console.log(`🌍 [Browser Tool] Action: ${action}`);

                                if (automationRef) {
                                    if (action === 'open') {
                                        automationRef.openBrowser(query || 'google');
                                    } else if (action === 'search_youtube') {
                                        automationRef.openBrowser({ platform: 'youtube', query });
                                    } else if (action === 'scroll') {
                                        automationRef.scrollBrowser(direction);
                                    } else if (action === 'click_id') {
                                        automationRef.clickBrowserId(element_id);
                                    } else if (action === 'smart_click') {
                                        automationRef.smartClickBrowser(target_text);
                                    } else if (action === 'close') {
                                        automationRef.closeBrowser();
                                    }
                                }

                                activeSession.sendRealtimeInput({
                                    functionResponses: [{
                                        id: call.id,
                                        response: { output: `Success: Browser ${action} executed` }
                                    }]
                                });
                            } else if (call.name === 'execute_system_command') {
                                const command = call.args.command;
                                console.log('💻 [System Tool] Command:', command);

                                if (automationRef) {
                                    automationRef.executeCommand(command);
                                }

                                activeSession.sendRealtimeInput({
                                    functionResponses: [{
                                        id: call.id,
                                        response: { output: `Success: System command executed` }
                                    }]
                                });
                            }
                        }
                    }
                },
                onerror: (e) => {
                    console.error('❌ Gemini Live WebSocket Error:', e.message);
                    mainWindow.webContents.send('live-session-event', { event: 'error', message: e.message });
                },
                onclose: (e) => {
                    console.log('🏁 Gemini Live Session Closed.');
                    activeSession = null;
                    mainWindow.webContents.send('live-session-event', { event: 'closed' });
                },
            },
        });

    } catch (err) {
        console.error('❌ Failed to start live session:', err);
        activeSession = null;
    }
}

function sendAudioChunk(base64Data) {
    if (activeSession) {
        try {
            activeSession.sendRealtimeInput({
                audio: { data: base64Data, mimeType: "audio/pcm;rate=16000" }
            });
        } catch (e) {
            console.error("❌ Failed to send audio input:", e);
        }
    }
}

function sendTextChunk(text) {
    if (activeSession) {
        try {
            activeSession.sendRealtimeInput({ text: text });
        } catch (e) {
            console.error("❌ Failed to send text input:", e);
        }
    }
}

function endLiveSession() {
    if (activeSession) {
        console.log('🛑 Terminating Live Session...');
        activeSession = null;
    }
}

module.exports = {
    startLiveSession,
    sendAudioChunk,
    sendTextChunk,
    endLiveSession
};
