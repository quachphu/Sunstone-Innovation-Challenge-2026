require('dotenv').config();
const API_KEY = process.env.GROK_API_KEY;

let messages = [
  { role: "system", content: "You are Nova, an advanced, highly intelligent sci-fi desktop assistant robot. You exist as a 3D hologram on the user's desktop. Keep your answers concise, helpful, and speak strictly in character. Do not use asterisks or markdown, just talk naturally." }
];

async function askGrok(userText) {
    messages.push({ role: "user", content: userText });

    try {
        const response = await fetch('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                messages: messages,
                model: 'grok-4-latest',
                stream: false,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`X.AI HTTP ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const botReply = data.choices[0].message.content;
        
        messages.push({ role: "assistant", content: botReply });
        
        // Trim memory to keep context window small
        if (messages.length > 20) {
            messages = [messages[0], ...messages.slice(-19)];
        }
        
        return botReply;
    } catch (e) {
        console.error("Grok Engine Offline:", e);
        return "My neural network is currently unreachable. Please check the api connection.";
    }
}

module.exports = { askGrok };
