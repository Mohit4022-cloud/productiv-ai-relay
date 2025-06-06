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

// Helper function to get signed URL from ElevenLabs with session isolation
async function getSignedUrl(conversationId = null) {
  try {
    const params = { agent_id: ELEVENLABS_AGENT_ID };
    // Add conversation ID for session isolation if provided
    if (conversationId) {
      params.conversation_id = conversationId;
    }
    
    const response = await axios.get(
      'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url',
      {
        params,
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
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

    // Generate unique conversation ID for this call
    const conversationId = `conv_${reqId}_${Date.now()}`;

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

    const callSid = call.sid;
    // Store context for this callSid for use in /media-stream
    callContextMap[reqId] = { 
      script, 
      persona, 
      context, 
      callSid, 
      conversationId,
      timestamp: Date.now()
    };

    metrics.calls++;
    metrics.activeCalls++;
    fastify.log.info({ reqId, callSid, to, from: fromNumber, conversationId }, "[Twilio] Outbound call initiated");

    reply.send({
      success: true,
      callSid,
      to,
      from: fromNumber,
      status: call.status,
      reqId,
      conversationId,
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

// Cleanup old contexts (prevent memory leaks)
setInterval(() => {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
  Object.keys(callContextMap).forEach(reqId => {
    if (callContextMap[reqId]?.timestamp < cutoff) {
      delete callContextMap[reqId];
    }
  });
}, 60 * 60 * 1000); // Run cleanup every hour

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
    
    // Clean up context map when call ends
    Object.keys(callContextMap).forEach(reqId => {
      if (callContextMap[reqId]?.callSid === CallSid) {
        delete callContextMap[reqId];
      }
    });
  }
  reply.send({ status: "received", timestamp: new Date().toISOString() });
});

// WebSocket media relay
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
    const reqId = req.query.reqId;
    const context = callContextMap[reqId] || {};
    const { script, persona, context: agentContext, callSid, conversationId } = context;
    let streamSid = null;
    let conversationActive = false;
    let elevenLabsWs = null;
    let reconnectAttempts = 0;
    let closed = false;
    let firstConnection = true;

    // Store transcript for this call
    if (callSid) transcripts[callSid] = [];

    fastify.log.info({ reqId, callSid, conversationId }, "[WebSocket] New media stream connection");

    // Helper: relay transcript
    const addTranscript = (role, text) => {
      if (callSid && text) {
        transcripts[callSid].push({ role, text, timestamp: new Date().toISOString() });
      }
    };

    // Helper: connect to ElevenLabs with signed URL and reconnection
    async function connectElevenLabs() {
      try {
        // Get a fresh signed URL for this connection with conversation ID
        const signedUrl = await getSignedUrl(conversationId);
        fastify.log.info({ reqId, callSid, conversationId }, "[ElevenLabs] Obtained signed URL, connecting...");
        
        elevenLabsWs = new WebSocket(signedUrl, {
          headers: { 
            "User-Agent": "Twilio-ElevenLabs-Integration/1.0",
            "X-Conversation-ID": conversationId || reqId
          }
        });

        elevenLabsWs.on("open", () => {
          conversationActive = true;
          reconnectAttempts = 0;
          if (firstConnection) {
            metrics.reconnects++;
            firstConnection = false;
          }
          fastify.log.info({ reqId, callSid, conversationId }, "[ElevenLabs] Connected to Conversational AI");

          // Send conversation reset/initialization message
          const initMessage = {
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              agent: {
                prompt: {
                  prompt: script ? `${script}\n\nRemember to introduce yourself naturally and avoid repeating the same greeting multiple times.` : undefined
                }
              }
            }
          };

          // Send initial context/script/persona if provided
          if (script || persona || agentContext) {
            const contextMessage = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: {
                    prompt: script || "You are Harper, an AI assistant from Productive X10. Have a natural conversation and avoid repeating your introduction.",
                    ...(persona && { persona })
                  }
                }
              },
              ...(agentContext && { context: agentContext })
            };
            
            try {
              elevenLabsWs.send(JSON.stringify(contextMessage));
              fastify.log.info({ reqId, callSid }, "[ElevenLabs] Sent conversation initialization");
            } catch (error) {
              fastify.log.error({ reqId, error: error.message }, "[ElevenLabs] Error sending initialization");
            }
          }
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
          fastify.log.error({ reqId, error: error.message }, "[ElevenLabs] WebSocket error");
          conversationActive = false;
        });

        elevenLabsWs.on("close", (code, reason) => {
          fastify.log.warn({ reqId, code, reason: reason?.toString() }, "[ElevenLabs] Disconnected");
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
        fastify.log.error({ reqId, error: error.message }, "[ElevenLabs] Failed to get signed URL or connect");
        conversationActive = false;
        
        // Retry getting signed URL if we haven't exceeded max attempts
        if (!closed && reconnectAttempts < MAX_ELEVENLABS_RETRIES) {
          reconnectAttempts++;
          fastify.log.info({ reqId, attempt: reconnectAttempts }, "[ElevenLabs] Retrying signed URL request...");
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
        fastify.log.debug({ reqId, type: message.type }, "[ElevenLabs] Received message but streamSid is not set, queuing...");
        // Queue the message if streamSid isn't set yet
        setTimeout(() => handleElevenLabsMessage(message, connection), 100);
        return;
      }
      
      switch (message.type) {
        case "conversation_initiation_metadata":
          fastify.log.info({ reqId, metadata: message }, "[ElevenLabs] Received conversation initiation metadata");
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
          fastify.log.debug({ reqId, type: message.type }, "[ElevenLabs] Received unhandled message type");
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
            fastify.log.info({ reqId, streamSid, callSid }, "[Twilio] Stream started");
            break;
          case "media":
            if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN && conversationActive) {
              try {
                elevenLabsWs.send(
                  JSON.stringify({
                    user_audio_chunk: Buffer.from(data.media.payload, "base64").toString("base64"),
                  })
                );
              } catch (error) {
                fastify.log.error({ reqId, error: error.message }, "[Twilio] Error sending audio to ElevenLabs");
              }
            } else if (!conversationActive && elevenLabsWs?.readyState !== WebSocket.CONNECTING) {
              fastify.log.warn({ reqId }, "[Twilio] Received audio but ElevenLabs conversation is not active");
            }
            break;
          case "stop":
            fastify.log.info({ reqId }, "[Twilio] Stream stopped, closing ElevenLabs connection");
            closed = true;
            if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
              try {
                // Send conversation end signal
                elevenLabsWs.send(JSON.stringify({ type: "conversation_end" }));
                elevenLabsWs.close();
              } catch (error) {
                fastify.log.error({ reqId, error: error.message }, "[ElevenLabs] Error closing connection gracefully");
              }
            }
            break;
          default:
            fastify.log.debug({ reqId, event: data.event }, "[Twilio] Received unhandled event");
        }
      } catch (error) {
        fastify.log.error({ reqId, error: error.message }, "[Twilio] Error processing message");
      }
    });

    // Handle close event from Twilio
    connection.on("close", () => {
      fastify.log.info({ reqId, callSid }, "[Twilio] Client disconnected");
      closed = true;
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        try {
          elevenLabsWs.send(JSON.stringify({ type: "conversation_end" }));
          elevenLabsWs.close();
        } catch (error) {
          fastify.log.error({ reqId, error: error.message }, "[Twilio] Error closing ElevenLabs connection");
        }
      }
    });

    // Handle errors from Twilio WebSocket
    connection.on("error", (error) => {
      fastify.log.error({ reqId, error: error.message }, "[Twilio] WebSocket error");
      closed = true;
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        try {
          elevenLabsWs.close();
        } catch {}
      }
    });

    // Cleanup on connection timeout
    const connectionTimeout = setTimeout(() => {
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        fastify.log.info({ reqId }, "[Server] Connection timeout, closing ElevenLabs connection");
        closed = true;
        try {
          elevenLabsWs.send(JSON.stringify({ type: "conversation_end" }));
          elevenLabsWs.close();
        } catch {}
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
