
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

if (!ELEVENLABS_AGENT_ID || !ELEVENLABS_API_KEY) {
  console.error("Missing ElevenLabs credentials in environment variables");
  process.exit(1);
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing Twilio credentials in environment variables");
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const metrics = {
  calls: 0,
  errors: 0,
  activeCalls: 0,
  reconnects: 0,
};
const transcripts = {};
const genId = () => crypto.randomBytes(8).toString("hex");

async function getSignedUrl() {
  try {
    const response = await axios.get(
      'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url',
      {
        params: { agent_id: ELEVENLABS_AGENT_ID },
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      }
    );
    return response.data.signed_url;
  } catch (error) {
    console.error('Error getting signed URL from ElevenLabs:', error.response?.data || error.message);
    throw new Error('Failed to get ElevenLabs signed URL');
  }
}

const fastify = Fastify({
  logger: {
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
  },
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Additional code continues... [truncated for brevity]
