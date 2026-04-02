require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_PROMPT =
  "You are Nova, an advanced, highly intelligent sci-fi desktop assistant robot. " +
  "You exist as a 3D hologram on the user's desktop. " +
  "Keep your answers extremely concise and direct. " +
  "NEVER introduce yourself (e.g. do not say 'Hi I am Nova'). " +
  "Do not use asterisks or markdown, just talk naturally.";

// Conversation history (user/model turns only — system prompt is passed separately)
let history = [];

async function askGemini(userText) {
  history.push({ role: 'user', parts: [{ text: userText }] });

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: history,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.7,
      },
    });

    const botReply = response.text;
    history.push({ role: 'model', parts: [{ text: botReply }] });

    // Keep context window small (system prompt + last 19 exchanges)
    if (history.length > 38) {
      history = history.slice(-38);
    }

    return botReply;
  } catch (e) {
    console.error('Gemini Engine Offline:', e);
    return 'My neural network is currently unreachable. Please check the API connection.';
  }
}

module.exports = { askGemini };
