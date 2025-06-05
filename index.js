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
  TWILIO_AUTH_TOKEN
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
      from: '+14422663218', // ✅ Your verified Twilio number
      method: 'POST',
      timeout: 55,
      machineDetection: 'Enable',
      trim: 'trim-silence'
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
    try {
      console.log("[Twilio] WebSocket connection received");

      let streamSid = null;

      let signedUrl;
      const session_id = uuidv4();
      const headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      };
      try {
        const postRes = await axios.post(
          "https://api.elevenlabs.io/v1/convai/conversation/get_signed_url",
          { agent_id: ELEVENLABS_AGENT_ID, session_id },
          { headers }
        );
        signedUrl = postRes.data.url;
        console.log("[ElevenLabs] Signed URL fetched successfully with POST:", signedUrl);
      } catch (postErr) {
        if ([400, 405].includes(postErr?.response?.status)) {
          console.warn(`[ElevenLabs] POST failed with ${postErr.response.status}, retrying with GET...`);
          const getRes = await axios.get(
            `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}&session_id=${session_id}`,
            { headers: { "xi-api-key": ELEVENLABS_API_KEY } }
          );
          signedUrl = getRes.data.signed_url;
          console.log("[ElevenLabs] Signed URL fetched successfully with GET:", signedUrl);
        } else {
          throw postErr;
        }
      }

      const elevenLabsWs = new WebSocket(signedUrl);

      elevenLabsWs.on("open", () => {
        console.log("[ElevenLabs] Connected");
        elevenLabsWs.send(JSON.stringify({
          type: "user_utterance",
          user_utterance: "Hi, this is Mohit calling from Productiv."
        }));
      });

      elevenLabsWs.on("message", (data) => {
        const msg = JSON.parse(data);
        console.log("[ElevenLabs → Twilio] Received:", msg);

        if (msg.type === "audio" && msg.audio_event?.audio_base_64) {
          console.log("[✅ AUDIO] Sending audio back to Twilio");
          connection.socket.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.audio_event.audio_base_64 }
          }));
        }

        if (msg.type === "interruption") {
          connection.socket.send(JSON.stringify({ event: "clear", streamSid }));
        }

        if (msg.type === "ping") {
          elevenLabsWs.send(JSON.stringify({
            type: "pong",
            event_id: msg.ping_event.event_id
          }));
        }
      });

      connection.socket.on("open", () => console.log("[Twilio] WebSocket opened"));
      connection.socket.on("close", () => console.log("[Twilio] WebSocket closed"));

      connection.on("message", (message) => {
        const msg = JSON.parse(message);
        console.log("[Twilio → Server] Incoming:", msg);

        if (msg.event === "start") {
          streamSid = msg.start.streamSid;

          const query = new URLSearchParams(req.url.split("?")[1]);
          const custom = {};
          for (const [key, val] of query.entries()) custom[key] = val;

          console.log("[Custom Params → ElevenLabs]:", custom);
          elevenLabsWs.send(JSON.stringify({
            type: "custom_parameters",
            customParameters: custom
          }));
        } else if (msg.event === "media") {
          console.log("[🎤 AUDIO INCOMING]:", msg.media?.payload?.slice?.(0, 10));
          const userChunk = {
            user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64"),
          };
          console.log("[User Audio Chunk → ElevenLabs]:", userChunk);
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

    } catch (err) {
      console.error("[WebSocket Handler Error]", err);
      connection.socket.close();
    }
  });
});

// Start the server
fastify.listen({ port: 3000, host: "0.0.0.0" }, () => {
  console.log("Relay server live on port 3000");
});
