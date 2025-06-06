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

// Helper function to create a conversation and get signed URL from ElevenLabs
async function createConversationAndGetSignedUrl() {
  try {
    // First, create a conversation
    const conversationResponse = await axios.post(
      'https://api.elevenlabs.io/v1/convai/conversations',
      {
        agent_id: ELEVENLABS_AGENT_ID
      },
      {
        headers: { 
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
      }
    );
    
    const conversationId = conversationResponse.data.conversation_id;
    
    // Then get the signed URL with the conversation ID
    const signedUrlResponse = await axios.get(
      'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url',
      {
        params: { agent_id: ELEVENLABS_AGENT_ID },
        headers: { 
          'xi-api-key': ELEVENLABS_API_KEY,
          'X-Conversation-ID': conversationId
        },
      }
    );
    
    return {
      conversationId,
      signedUrl: signedUrlResponse.data.signed_url
    };
  } catch (error) {
    console.error('Error creating conversation or getting signed URL from ElevenLabs:', error.response?.data || error.message);
    throw new Error('Failed to create ElevenLabs conversation or get signed URL');
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

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream?reqId=${reqId}" />
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
    let conversationId = null;
    let elevenLabsWs = null;
    let reconnectAttempts = 0;
    let closed = false;
    let audioBuffer = []; // Buffer audio until ElevenLabs is ready

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
      if (audioBuffer.length > 0 && elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN && conversationActive) {
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

    // Helper: connect to ElevenLabs with conversation creation and reconnection
    async function connectElevenLabs() {
      try {
        // Create conversation and get signed URL
        const { conversationId: newConversationId, signedUrl } = await createConversationAndGetSignedUrl();
        conversationId = newConversationId;
        
        fastify.log.info({ reqId, callSid, conversationId }, "[ElevenLabs] Created conversation and obtained signed URL, connecting...");
        
        elevenLabsWs = new WebSocket(signedUrl, {
          headers: { 
            "User-Agent": "Twilio-ElevenLabs-Integration/1.0",
            "X-Conversation-ID": conversationId
          }
        });

        elevenLabsWs.on("open", () => {
          conversationActive = true;
          reconnectAttempts = 0;
          metrics.reconnects++;
          fastify.log.info({ reqId, callSid, conversationId }, "[ElevenLabs] Connected to Conversational AI");

          // Send initial context/script/persona if provided
          if (script || persona || agentContext) {
            const initMessage = {
              type: "conversation_initiation_client_data",
              conversation_initiation_client_data: {}
            };
            
            if (script) initMessage.conversation_initiation_client_data.script = script;
            if (persona) initMessage.conversation_initiation_client_data.persona = persona;
            if (agentContext) initMessage.conversation_initiation_client_data.context = agentContext;
            
            elevenLabsWs.send(JSON.stringify(initMessage));
            fastify.log.info({ reqId, conversationId }, "[ElevenLabs] Sent initialization data");
          }

          // Process any buffered audio
          processBufferedAudio();
        });

        elevenLabsWs.on("message", (data) => {
          try {
            const message = JSON.parse(data);
            handleElevenLabsMessage(message, connection);
          } catch (error) {
            fastify.log.error({ reqId, error: error.message }, "[ElevenLabs] Error parsing message");
          }
        });

        elevenLabsWs.on("error", (error) => {
          fastify.log.error({ reqId, conversationId, error: error.message }, "[ElevenLabs] WebSocket error");
          conversationActive = false;
        });

        elevenLabsWs.on("close", (code, reason) => {
          fastify.log.warn({ reqId, conversationId, code, reason: reason?.toString() }, "[ElevenLabs] Disconnected");
          conversationActive = false;
          if (!closed && reconnectAttempts < MAX_ELEVENLABS_RETRIES) {
            reconnectAttempts++;
            fastify.log.info({ reqId, attempt: reconnectAttempts }, "[ElevenLabs] Attempting reconnection...");
            setTimeout(connectElevenLabs, 1000 * Math.pow(2, reconnectAttempts - 1)); // Exponential backoff
          } else if (!closed) {
            fastify.log.error({ reqId }, "[ElevenLabs] Max reconnect attempts reached, closing Twilio stream");
            try {
              connection.close();
            } catch {}
          }
        });

      } catch (error) {
        fastify.log.error({ reqId, error: error.message }, "[ElevenLabs] Failed to create conversation or connect");
        conversationActive = false;
        
        // Retry if we haven't exceeded max attempts
        if (!closed && reconnectAttempts < MAX_ELEVENLABS_RETRIES) {
          reconnectAttempts++;
          fastify.log.info({ reqId, attempt: reconnectAttempts }, "[ElevenLabs] Retrying connection...");
          setTimeout(connectElevenLabs, 1000 * Math.pow(2, reconnectAttempts - 1));
        } else if (!closed) {
          fastify.log.error({ reqId }, "[ElevenLabs] Max reconnect attempts reached, closing Twilio stream");
          try {
            connection.close();
          } catch {}
        }
      }
    }

    // Handle messages from ElevenLabs
    function handleElevenLabsMessage(message, connection) {
      if (!streamSid) {
        fastify.log.warn({ reqId }, "[ElevenLabs] Received message but streamSid is not set");
        return;
      }
      
      switch (message.type) {
        case "conversation_initiation_metadata":
          fastify.log.info({ reqId, conversationId }, "[ElevenLabs] Received conversation initiation metadata");
          break;
        case "audio":
          if (message.audio_event?.audio_base_64) {
            const audioData = {
              event: "media",
              streamSid,
              media: { payload: message.audio_event.audio_base_64 },
            };
            try {
              connection.send(JSON.stringify(audioData));
            } catch (error) {
              fastify.log.error({ reqId, error: error.message }, "[ElevenLabs] Error sending audio to Twilio");
            }
          }
          break;
        case "interruption":
          try {
            connection.send(JSON.stringify({ event: "clear", streamSid }));
            fastify.log.info({ reqId }, "[ElevenLabs] Sent clear command to Twilio");
          } catch (error) {
            fastify.log.error({ reqId, error: error.message }, "[ElevenLabs] Error sending clear command");
          }
          break;
        case "ping":
          if (message.ping_event?.event_id) {
            const pongResponse = { type: "pong", event_id: message.ping_event.event_id };
            try {
              elevenLabsWs.send(JSON.stringify(pongResponse));
            } catch (error) {
              fastify.log.error({ reqId, error: error.message }, "[ElevenLabs] Error sending pong response");
            }
          }
          break;
        case "user_transcript":
          addTranscript("user", message.user_transcript?.text);
          fastify.log.info({ reqId, text: message.user_transcript?.text }, "[ElevenLabs] User said");
          break;
        case "agent_response":
          addTranscript("agent", message.agent_response?.text);
          fastify.log.info({ reqId, text: message.agent_response?.text }, "[ElevenLabs] Agent said");
          break;
        default:
          fastify.log.info({ reqId, type: message.type }, "[ElevenLabs] Received unhandled message type");
      }
    }

    // Start ElevenLabs connection
    connectElevenLabs();

    // Handle messages from Twilio
    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            fastify.log.info({ reqId, streamSid }, "[Twilio] Stream started");
            break;
          case "media":
            const audioData = Buffer.from(data.media.payload, "base64").toString("base64");
            
            if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN && conversationActive) {
              try {
                elevenLabsWs.send(JSON.stringify({
                  user_audio_chunk: audioData,
                }));
              } catch (error) {
                fastify.log.error({ reqId, error: error.message }, "[Twilio] Error sending audio to ElevenLabs");
              }
            } else if (!conversationActive) {
              // Buffer audio until ElevenLabs is ready
              audioBuffer.push(audioData);
              if (audioBuffer.length % 50 === 0) { // Log every 50 buffered chunks to avoid spam
                fastify.log.warn({ reqId, bufferedCount: audioBuffer.length }, "[Twilio] Buffering audio - ElevenLabs conversation not active");
              }
            }
            break;
          case "stop":
            fastify.log.info({ reqId }, "[Twilio] Stream stopped, closing ElevenLabs connection");
            closed = true;
            if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
            break;
          default:
            fastify.log.info({ reqId, event: data.event }, "[Twilio] Received unhandled event");
        }
      } catch (error) {
        fastify.log.error({ reqId, error: error.message }, "[Twilio] Error processing message");
      }
    });

    // Handle close event from Twilio
    connection.on("close", () => {
      fastify.log.info({ reqId }, "[Twilio] Client disconnected");
      closed = true;
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });

    // Handle errors from Twilio WebSocket
    connection.on("error", (error) => {
      fastify.log.error({ reqId, error: error.message }, "[Twilio] WebSocket error");
      closed = true;
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });

    // Cleanup on connection timeout
    const connectionTimeout = setTimeout(() => {
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        fastify.log.info({ reqId }, "[Server] Connection timeout, closing ElevenLabs connection");
        elevenLabsWs.close();
      }
    }, MEDIA_STREAM_TIMEOUT_MS);

    connection.on("close", () => clearTimeout(connectionTimeout));
  });
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  fastify.log.info(`[Server] Received ${signal}, shutting down gracefully...`);
  fastify.close(() => {
    fastify.log.info("[Server] HTTP server closed.");
    process.exit(0);
  });
  setTimeout(() => {
    fastify.log.error("[Server] Could not close connections in time, forcefully shutting down");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  fastify.log.error({ error: error.message }, "[Server] Uncaught Exception");
  process.exit(1);
});
process.on("unhandledRejection", (reason, promise) => {
  fastify.log.error({ reason }, "[Server] Unhandled Rejection");
  process.exit(1);
});

// Start the server
const start = async () => {
  try {
    fastify.log.info(`[Server] Starting server on port ${PORT}...`);
    fastify.log.info(`[Server] Environment: ${process.env.NODE_ENV || "development"}`);
    fastify.log.info(`[Server] Agent ID: ${ELEVENLABS_AGENT_ID ? "configured" : "missing"}`);
    fastify.log.info(`[Server] Twilio Account SID: ${TWILIO_ACCOUNT_SID ? "configured" : "missing"}`);
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    fastify.log.info(`[Server] Server successfully started on port ${PORT}`);
    fastify.log.info(`[Server] Health check available at: http://0.0.0.0:${PORT}/health`);
  } catch (err) {
    fastify.log.error({ error: err.message }, "[Server] Error starting server");
    process.exit(1);
  }
};

start();
