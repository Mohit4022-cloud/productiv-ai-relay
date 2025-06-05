// index.js
import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";

dotenv.config();

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const {
  ELEVENLABS_AGENT_ID,
  ELEVENLABS_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_NUMBER
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "AI SDR Relay is live" });
});

// Serve TwiML
fastify.route({
  method: ['GET', 'POST'],
  url: '/twiml',
  handler: async (request, reply) => {
    try {
      const streamParams = new URLSearchParams(request.query || {}).toString();
      const rawUrl = `wss://${request.hostname}/media-stream?${streamParams}`;
      const streamUrl = rawUrl.replace(/&/g, "&amp;");

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

      console.log("[TwiML XML]:\n", twiml);
      reply.type("text/xml").send(twiml);
    } catch (err) {
      console.error("[TwiML] Error:", err);
      reply.status(500).send("Internal Server Error");
    }
  }
});

// Trigger outbound call
fastify.post("/dial", async (request, reply) => {
  try {
    const { to, name, company } = request.body;
    const streamParams = new URLSearchParams({ name, company }).toString();
    const callUrl = `https://${request.hostname}/twiml?${streamParams}`;

    console.log("[Dial] Placing call to:", to);
    console.log("[Dial] Using TwiML URL:", callUrl);

    const call = await twilioClient.calls.create({
      url: callUrl,
      to,
      from: TWILIO_CALLER_NUMBER,
    });

    reply.send({ status: "call placed", to, sid: call.sid });
  } catch (error) {
    console.error("[Dial] Failed to place call:", error.message);
    reply.status(500).send({ error: "Failed to place call", details: error.message });
  }
});

// Handle WebSocket audio stream
fastify.register(async function (fastify) {
  fastify.get("/media-stream", { websocket: true }, async (connection, req) => {
    let streamSid = null;

    // STEP 1: Fetch signed ElevenLabs WebSocket URL using POST
    let signedUrl;
    try {
      const session_id = uuidv4();
      const signedRes = await axios.post(
        "https://api.elevenlabs.io/v1/convai/conversation/get_signed_url",
        {
          agent_id: ELEVENLABS_AGENT_ID,
          session_id
        },
        {
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json"
          }
        }
      );
      signedUrl = signedRes.data.url;
      console.log("[ElevenLabs] Signed URL fetched successfully");
    } catch (err) {
      console.error("[ElevenLabs] Failed to fetch signed URL:", err.message);
      connection.close();
      return;
    }

    const elevenLabsWs = new WebSocket(signedUrl);

    elevenLabsWs.on("open", () => {
      console.log("[ElevenLabs] Connected");
    });

    elevenLabsWs.on("message", (data) => {
      const msg = JSON.parse(data);
      console.log("[ElevenLabs → Twilio] Received:", msg);

      if (msg.type === "audio" && msg.audio_event?.audio_base_64) {
        connection.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.audio_event.audio_base_64 }
        }));
      }
      if (msg.type === "interruption") {
        connection.send(JSON.stringify({ event: "clear", streamSid }));
      }
      if (msg.type === "ping") {
        elevenLabsWs.send(JSON.stringify({
          type: "pong",
          event_id: msg.ping_event.event_id
        }));
      }
    });

    connection.socket.on("open", () => {
      console.log("[Twilio] WebSocket opened");
    });

    connection.socket.on("close", () => {
      console.log("[Twilio] WebSocket closed");
    });

    connection.on("message", (message) => {
      const msg = JSON.parse(message);
      console.log("[Twilio → Server] Incoming:", msg);

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;

        const query = new URLSearchParams(req.url.split("?")[1]);
        const custom = {};
        for (const [key, val] of query.entries()) custom[key] = val;

        const payload = {
          type: "custom_parameters",
          customParameters: custom
        };
        console.log("[Server → ElevenLabs] Sending:", payload);
        elevenLabsWs.send(JSON.stringify(payload));
      } else if (msg.event === "media") {
        const userChunk = {
          user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64"),
        };
        console.log("[Server → ElevenLabs] Sending audio chunk");
        if (elevenLabsWs.readyState === WebSocket.OPEN) {
          elevenLabsWs.send(JSON.stringify(userChunk));
        }
      } else if (msg.event === "stop") {
        elevenLabsWs.close();
      }
    });

    connection.on("close", () => {
      elevenLabsWs.close();
      console.log("[Twilio] WebSocket connection closed");
    });
  });
});

// Start the server
fastify.listen({ port: 3000, host: "0.0.0.0" }, () => {
  console.log("Relay server live on port 3000");
});
