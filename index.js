require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(express.json());

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Gmail Auth
const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// Memory queues to hold tasks and prevent double-processing
let triageQueue = [];
let processedMessageIds = new Set();

// The AI Prompt
const systemInstruction = `You are an executive assistant. Read this email. Categorize it as 'Urgent Action', 'Read Later', or 'Junk'. Extract any actionable tasks. 
You must reply ONLY with a valid JSON object matching this schema:
{ "category": "String", "summary": "Short 1 sentence summary", "tasks": ["Task 1", "Task 2"] }`;

async function scanInbox() {
    try {
        console.log("Checking for new unread emails...");
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread',
            maxResults: 5 // Keep it small for testing
        });

        const messages = res.data.messages || [];
        
        for (const msg of messages) {
            if (processedMessageIds.has(msg.id)) continue;

            // Fetch the full email content
            const emailData = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id,
                format: 'metadata',
                metadataHeaders: ['Subject', 'From']
            });

            const headers = emailData.data.payload.headers;
            const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
            const from = headers.find(h => h.name === 'From')?.value || 'Unknown Sender';
            const snippet = emailData.data.snippet; // The plain-text preview of the email

            console.log(`Processing: ${subject}`);

            // Send to Gemini 3 Flash for high-speed routing
            const response = await ai.models.generateContent({
                model: 'gemini-3-flash',
                contents: `${systemInstruction}\n\nFrom: ${from}\nSubject: ${subject}\nBody: ${snippet}`,
                config: { responseMimeType: "application/json" }
            });

            const aiResult = JSON.parse(response.text());
            
            // Add it to your dashboard queue
            triageQueue.push({
                id: msg.id,
                from,
                subject,
                category: aiResult.category,
                summary: aiResult.summary,
                tasks: aiResult.tasks
            });

            // Mark as processed in memory so we don't scan it again next loop
            processedMessageIds.add(msg.id);
        }
    } catch (error) {
        console.error("Error scanning inbox:", error.message);
    }
}

// API Endpoint for your dashboard to fetch the queue
app.get('/api/queue', (req, res) => {
    res.json(triageQueue);
});

// Start the server and the background polling
app.listen(PORT, () => {
    console.log(`🚀 AI Triage Dashboard running on port ${PORT}`);
    // Run the scanner immediately, then every 5 minutes (300000 ms)
    scanInbox();
    setInterval(scanInbox, 300000);
});
