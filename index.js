// index.js

import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";
import crypto from "crypto";
import axios from "axios";

// Load environment variables from .env file
dotenv.config();

const {
  ELEVENLABS_AGENT_ID,
  ELEVENLABS_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PORT = 8000,
  MEDIA_STREAM_TIMEOUT_MS = 300000, // 5 min default
  MAX_ELEVENLABS_RETRIES = 3,
} = process.env;

// Validate required env vars
if (!ELEVENLABS_AGENT_ID || !ELEVENLABS_API_KEY) {
  console.error("Missing ElevenLabs credentials in environment variables");
  process.exit(1);
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing Twilio credentials in environment variables");
  process.exit(1);
}

// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// In-memory stores for metrics and transcripts (swap for DB in prod)
const metrics = {
  calls: 0,
  errors: 0,
  activeCalls: 0,
  reconnects: 0,
};
const transcripts = {}; // { callSid: [{role, text, timestamp}] }

// Helper: Generate a request/call ID
const genId = () => crypto.randomBytes(8).toString("hex");

// Helper function to get signed URL from ElevenLabs
async function getSignedUrl() {
  try {
    const response = await axios.get(
      'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url',
      {
        params: { agent_id: ELEVENLABS_AGENT_ID },
        headers: { 
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
      }
    );
    
    return response.data.signed_url;
  } catch (error) {
    console.error('Error getting signed URL from ElevenLabs:', error.response?.data || error.message);
    throw new Error('Failed to get ElevenLabs signed URL');
  }
}

// Initialize Fastify server with pino logger
const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
  },
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Health check
fastify.get("/", async (_, reply) => {
  reply.send({
    message: "Twilio-ElevenLabs Integration Server",
    status: "running",
    timestamp: new Date().toISOString(),
    port: PORT,
    env: process.env.NODE_ENV || "development",
  });
});

fastify.get("/health", async (_, reply) => {
  reply.send({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Metrics endpoint (Prometheus format)
fastify.get("/metrics", async (_, reply) => {
  reply.type("text/plain").send(
    [
      `calls_total ${metrics.calls}`,
      `errors_total ${metrics.errors}`,
      `active_calls ${metrics.activeCalls}`,
      `reconnects_total ${metrics.reconnects}`,
    ].join("\n")
  );
});

// Transcript fetch endpoint
fastify.get("/transcripts/:callSid", async (req, reply) => {
  const { callSid } = req.params;
  reply.send({ callSid, transcript: transcripts[callSid] || [] });
});

// Outbound call endpoint with script/persona/context injection
fastify.post("/twilio/outbound_call", async (request, reply) => {
  const reqId = genId();
  try {
    const { to, from, script, persona, context } = request.body;

    // Validate phone number
    if (!to) return reply.status(400).send({ error: "Missing 'to' phone number" });
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    if (!phoneRegex.test(to)) return reply.status(400).send({ error: "Invalid phone number format" });

    const fromNumber = from || TWILIO_PHONE_NUMBER;

    // Store context for this callSid (will be set after call is created)
    let callSid = null;

    // Create the call
    const call = await twilioClient.calls.create({
      to,
      from: fromNumber,
      url: `https://${request.headers.host}/twilio/outbound_twiml?reqId=${reqId}`,
      method: "POST",
      statusCallback: `https://${request.headers.host}/twilio/call_status`,
      statusCallbackEvent: [
        "initiated",
        "ringing",
        "answered",
        "completed",
        "busy",
        "no-answer",
        "failed",
      ],
      statusCallbackMethod: "POST",
      timeout: 30,
      record: false,
    });

    callSid = call.sid;
    // Store context for this callSid for use in /media-stream
    callContextMap[reqId] = { script, persona, context, callSid };

    metrics.calls++;
    metrics.activeCalls++;
    fastify.log.info({ reqId, callSid, to, from: fromNumber }, "[Twilio] Outbound call initiated");

    reply.send({
      success: true,
      callSid,
      to,
      from: fromNumber,
      status: call.status,
      reqId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    metrics.errors++;
    fastify.log.error({ reqId, error: error.message }, "[Twilio] Error initiating outbound call");
    reply.status(500).send({
      error: "Failed to initiate outbound call",
      details: process.env.NODE_ENV === "production" ? "Internal server error" : error.message,
    });
  }
});

// Map to store per-call context (script/persona/context) by reqId
const callContextMap = {};

// TwiML for outbound call, passes reqId for context
fastify.post("/twilio/outbound_twiml", async (request, reply) => {
  const reqId = request.query.reqId;
  fastify.log.info({ reqId }, "[Twilio] Outbound call answered, connecting to stream");

  // Ensure we use the proper protocol (wss for HTTPS, ws for HTTP)
  const protocol = request.headers.host.includes('localhost') || request.headers.host.includes('127.0.0.1') ? 'ws' : 'wss';
  const streamUrl = `${protocol}://${request.headers.host}/media-stream?reqId=${reqId}`;
  
  fastify.log.info({ reqId, streamUrl }, "[Twilio] Stream URL");

  // Add a brief message before connecting to ensure audio path works
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Connecting you to the AI assistant.</Say>
      <Connect>
        <Stream url="${streamUrl}" />
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// Call status updates
fastify.post("/twilio/call_status", async (request, reply) => {
  const { CallSid, CallStatus, From, To, Direction, Duration } = request.body;
  fastify.log.info(
    { CallSid, CallStatus, From, To, Direction, Duration },
    "[Twilio] Call status update"
  );
  if (["completed", "failed", "busy", "no-answer", "canceled"].includes(CallStatus)) {
    metrics.activeCalls = Math.max(0, metrics.activeCalls - 1);
  }
  reply.send({ status: "received", timestamp: new Date().toISOString() });
});

// WebSocket media relay
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
    const reqId = req.query.reqId;
    const context = callContextMap[reqId] || {};
    const { script, persona, context: agentContext, callSid } = context;
    let streamSid = null;
    let conversationActive = false;
    let elevenLabsWs = null;
    let reconnectAttempts = 0;
    let closed = false;
    let audioBuffer = []; // Buffer audio until ElevenLabs is ready
    let elevenLabsReady = false;
    let messageCount = 0;

    fastify.log.info({ reqId, callSid, headers: req.headers }, "[WebSocket] Twilio WebSocket connected");

    // Store transcript for this call
    if (callSid) transcripts[callSid] = [];

    // Helper: relay transcript
    const addTranscript = (role, text) => {
      if (callSid && text) {
        transcripts[callSid].push({ role, text, timestamp: new Date().toISOString() });
      }
    };

    // Helper: process buffered audio
    const processBufferedAudio = () => {
      if (audioBuffer.length > 0 && elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN && conversationActive && elevenLabsReady) {
        fastify.log.info({ reqId, bufferedCount: audioBuffer.length }, "[ElevenLabs] Processing buffered audio");
        audioBuffer.forEach(audioData => {
          try {
            elevenLabsWs.send(JSON.stringify({
              user_audio_chunk: audioData,
            }));
          } catch (error) {
            fastify.log.error({ reqId, error: error.message }, "[ElevenLabs] Error sending buffered audio");
          }
        });
        audioBuffer = [];
      }
    };

    // Helper: connect to ElevenLabs with signed URL
    async function connectElevenLabs() {
      try {
        // Get signed URL from ElevenLabs
        const signedUrl = await getSignedUrl();
        
        fastify.log.info({ reqId, callSid }, "[ElevenLabs] Obtained signed URL, connecting...");
        
        elevenLabsWs = new WebSocket(signedUrl, {
          headers: { 
            "User-Agent": "Twilio-ElevenLabs-Integration/1.0"
          }
        });

        elevenLabsWs.on("open
::contentReference[oaicite:4]{index=4}
 
