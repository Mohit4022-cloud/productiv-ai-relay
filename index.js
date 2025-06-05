// index.js
import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";

dotenv.config();

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const {
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_NUMBER
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "AI SDR Relay is live" });
});

// Serve TwiML with dynamic WebSocket stream URL
fastify.get("/twiml", async (request, reply) => {
  const streamParams = new URLSearchParams(request.query).toString();
  const streamUrl = `wss://${request.hostname}/media-stream?${streamParams}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Connect>
      <Stream url="${streamUrl}" />
    </Connect>
  </Response>`;

  reply.type("text/xml").send(twiml);
});

// Trigger outbound call via Twilio
fastify.post("/dial", async (request, reply) => {
  const { to, name, company } = request.body;
  const streamParams = new URLSearchParams({ name, company }).toString();

  const call = await twilioClient.calls.create({
    url: `https://${request.hostname}/twiml?${streamParams}`,
    to,
    from: TWILIO_CALLER_NUMBER,
  });

  reply.send({ status: "call placed", to, sid: call.sid });
});

// Handle WebSocket audio stream between Twilio and ElevenLabs
fastify.register(async function (fastify) {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    let streamSid = null;

    const elevenLabsWs = new WebSocket(
      `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`
    );

    elevenLabsWs.on("open", () => {
      console.log("[ElevenLabs] Connected");
    });

    elevenLabsWs.on("message", (data) => {
      const msg = JSON.parse(data);
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

    connection.on("message", (message) => {
      const msg = JSON.parse(message);
      if (msg.event === "start") {
        streamSid = msg.start.streamSid;

        const query = new URLSearchParams(req.url.split("?")[1]);
        const custom = {};
        for (const [key, val] of query.entries()) custom[key] = val;

        elevenLabsWs.send(JSON.stringify({
          type: "custom_parameters",
          customParameters: custom
        }));
      } else if (msg.event === "media") {
        const userChunk = {
          user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64"),
        };
        if (elevenLabsWs.readyState === WebSocket.OPEN) {
          elevenLabsWs.send(JSON.stringify(userChunk));
        }
      } else if (msg.event === "stop") {
        elevenLabsWs.close();
      }
    });

    connection.on("close", () => {
      elevenLabsWs.close();
      console.log("[Twilio] WebSocket closed");
    });
  });
});

// Start the server — this is the key fix
fastify.listen({ port: 3000, host: "0.0.0.0" }, () => {
  console.log("Relay server live on port 3000");
});
