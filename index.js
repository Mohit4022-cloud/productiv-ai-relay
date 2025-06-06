import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";

dotenv.config();

const {
  ELEVENLABS_AGENT_ID,
  ELEVENLABS_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PORT
} = process.env;

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Health check
fastify.get("/", (_, reply) => {
  reply.send({ status: "OK", ts: new Date().toISOString() });
});
fastify.get("/health", (_, reply) => {
  reply.send({ status: "healthy", uptime: process.uptime() });
});

// Twilio outbound call
fastify.post("/twilio/outbound_call", async (request, reply) => {
  const { to, from } = request.body;
  if (!to) return reply.status(400).send({ error: "Missing 'to' phone number" });
  const fromNumber = from || TWILIO_PHONE_NUMBER;
  try {
    const call = await twilioClient.calls.create({
      to,
      from: fromNumber,
      url: `https://${request.headers.host}/twilio/outbound_twiml`,
      method: 'POST',
      statusCallback: `https://${request.headers.host}/twilio/call_status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed', 'busy', 'no-answer', 'failed'],
      statusCallbackMethod: 'POST',
      timeout: 30
    });
    reply.send({ callSid: call.sid, to, from: fromNumber, status: call.status });
  } catch (err) {
    reply.status(500).send({ error: "Failed to place call", details: err.message });
  }
});

// Twilio TwiML (media stream)
fastify.post("/twilio/outbound_twiml", (request, reply) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;
  reply.type("text/xml").send(twiml);
});

// Twilio call status updates
fastify.post("/twilio/call_status", (request, reply) => {
  const { CallSid, CallStatus, From, To, Duration } = request.body;
  fastify.log.info(`[Twilio] Call ${CallSid} status: ${CallStatus}, From: ${From}, To: ${To}, Duration: ${Duration || "?"}s`);
  reply.send({ status: "received" });
});

// Media relay: Twilio <-> ElevenLabs
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, async (connection, req) => {
    fastify.log.info("[Media] Twilio WebSocket connected");
    let streamSid = null;
    let elevenLabsReady = false;
    let audioBuffer = [];

    // Step 1: Generate a fresh session & signed URL for ElevenLabs
    const session_id = uuidv4();
    let signedUrl;
    try {
      const headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      };
      const postRes = await axios.post(
        "https://api.elevenlabs.io/v1/convai/conversation/get_signed_url",
        { agent_id: ELEVENLABS_AGENT_ID, session_id },
        { headers }
      );
      signedUrl = postRes.data.url || postRes.data.signed_url;
      fastify.log.info("[ElevenLabs] Fetched signed URL for session");
    } catch (err) {
      fastify.log.error("[ElevenLabs] Failed to get signed URL:", err.message);
      connection.socket.close();
      return;
    }

    // Step 2: Connect to ElevenLabs WebSocket with signed URL
    const elevenLabsWs = new WebSocket(signedUrl);

    elevenLabsWs.on("open", () => {
      fastify.log.info("[ElevenLabs] WS open (session established)");
    });

    elevenLabsWs.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      // When ready, flush audio buffer
      if (msg.type === "conversation_initiation_metadata") {
        elevenLabsReady = true;
        for (const chunk of audioBuffer) {
          elevenLabsWs.send(JSON.stringify(chunk));
        }
        audioBuffer = [];
        fastify.log.info("[Bridge] ElevenLabs ready, flushed Twilio audio");
      }
      // Forward ElevenLabs audio to Twilio
      if (msg.type === "audio" && msg.audio_event?.audio_base_64) {
        connection.socket.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.audio_event.audio_base_64 }
        }));
      }
      // Handle interruption
      if (msg.type === "interruption") {
        connection.socket.send(JSON.stringify({ event: "clear", streamSid }));
      }
      // Respond to ping
      if (msg.type === "ping" && msg.ping_event?.event_id) {
        elevenLabsWs.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id }));
      }
    });

    elevenLabsWs.on("error", (err) => {
      fastify.log.error("[ElevenLabs] WS error:", err.message);
    });
    elevenLabsWs.on("close", () => {
      fastify.log.info("[ElevenLabs] WS closed");
    });

    // Step 3: Relay Twilio events to ElevenLabs (buffer until ready)
    connection.socket.on("message", (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.event === "start") {
          streamSid = msg.start.streamSid;
        } else if (msg.event === "media") {
          const userChunk = {
            user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
          };
          if (elevenLabsReady && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify(userChunk));
          } else {
            audioBuffer.push(userChunk);
            fastify.log.info("[Twilio] Buffering audio until ElevenLabs ready");
          }
        } else if (msg.event === "stop") {
          fastify.log.info("[Twilio] Stream stopped, closing ElevenLabs WS");
          if (elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.close();
          }
        }
      } catch (err) {
        fastify.log.error("[Media] Bad WS message from Twilio:", err.message);
      }
    });

    connection.socket.on("close", () => {
      fastify.log.info("[Twilio] Media WebSocket closed");
      if (elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });
  });
});

// Start server
fastify.listen({ port: PORT || 8000, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Server listening at ${address}`);
});
