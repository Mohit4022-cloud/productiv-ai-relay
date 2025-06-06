import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";

// Load environment variables from .env file
dotenv.config();

const { 
  ELEVENLABS_AGENT_ID, 
  TWILIO_ACCOUNT_SID, 
  TWILIO_AUTH_TOKEN, 
  TWILIO_PHONE_NUMBER 
} = process.env;

// Check for required environment variables
if (!ELEVENLABS_AGENT_ID) {
  console.error("Missing ELEVENLABS_AGENT_ID in environment variables");
  process.exit(1);
}

// Modified to handle missing Twilio credentials more gracefully in production
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing Twilio credentials in environment variables");
  if (process.env.NODE_ENV === 'production') {
    console.error("Twilio credentials are required for production deployment");
  }
  process.exit(1);
}

// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Fastify server
const fastify = Fastify({
  logger: process.env.NODE_ENV === 'production' ? {
    level: 'info'
  } : {
    level: 'debug'
  }
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Use PORT environment variable (Render provides this)
const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ 
    message: "Twilio-ElevenLabs Integration Server",
    status: "running",
    timestamp: new Date().toISOString(),
    port: PORT,
    env: process.env.NODE_ENV || 'development'
  });
});

// Health check route (common for cloud deployments)
fastify.get("/health", async (_, reply) => {
  reply.send({ 
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Route to initiate outbound calls
fastify.post("/twilio/outbound_call", async (request, reply) => {
  try {
    const { to, from } = request.body;
    
    // Validate required parameters
    if (!to) {
      return reply.status(400).send({ error: "Missing 'to' phone number" });
    }
    
    // Validate phone number format (basic validation)
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    if (!phoneRegex.test(to)) {
      return reply.status(400).send({ error: "Invalid phone number format" });
    }
    
    const fromNumber = from || TWILIO_PHONE_NUMBER;
    
    // Create the call
    const call = await twilioClient.calls.create({
      to: to,
      from: fromNumber,
      url: `https://${request.headers.host}/twilio/outbound_twiml`,
      method: 'POST',
      statusCallback: `https://${request.headers.host}/twilio/call_status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed', 'busy', 'no-answer', 'failed'],
      statusCallbackMethod: 'POST',
      timeout: 30, // 30 second timeout
      record: false // Don't record calls by default
    });

    console.log(`[Twilio] Outbound call initiated: ${call.sid} to ${to}`);
    
    reply.send({
      success: true,
      callSid: call.sid,
      to: to,
      from: fromNumber,
      status: call.status,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("[Twilio] Error initiating outbound call:", error);
    reply.status(500).send({ 
      error: "Failed to initiate outbound call",
      details: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message
    });
  }
});

// TwiML response for outbound calls (custom server for outbound only)
fastify.post("/twilio/outbound_twiml", async (request, reply) => {
  console.log("[Twilio] Outbound call answered, connecting to stream");
  
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// Route to handle call status updates
fastify.post("/twilio/call_status", async (request, reply) => {
  const { CallSid, CallStatus, From, To, Direction, Duration } = request.body;
  
  console.log(`[Twilio] Call status update - SID: ${CallSid}, Status: ${CallStatus}, From: ${From}, To: ${To}, Direction: ${Direction}, Duration: ${Duration}s`);
  
  // Enhanced status handling with more detailed logging
  switch (CallStatus) {
    case 'initiated':
      console.log(`[Twilio] Call ${CallSid} initiated`);
      break;
    case 'ringing':
      console.log(`[Twilio] Call ${CallSid} is ringing`);
      break;
    case 'answered':
      console.log(`[Twilio] Call ${CallSid} was answered`);
      break;
    case 'completed':
      console.log(`[Twilio] Call ${CallSid} completed after ${Duration}s`);
      break;
    case 'busy':
      console.log(`[Twilio] Call ${CallSid} was busy`);
      break;
    case 'no-answer':
      console.log(`[Twilio] Call ${CallSid} was not answered`);
      break;
    case 'failed':
      console.log(`[Twilio] Call ${CallSid} failed`);
      break;
    case 'canceled':
      console.log(`[Twilio] Call ${CallSid} was canceled`);
      break;
  }
  
  reply.send({ status: 'received', timestamp: new Date().toISOString() });
});

// WebSocket route for handling media streams from Twilio
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
    console.info("[Server] Twilio connected to media stream.");

    let streamSid = null;
    let conversationActive = false;

    // Connect to ElevenLabs Conversational AI WebSocket
    const elevenLabsWs = new WebSocket(
      `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        headers: {
          'User-Agent': 'Twilio-ElevenLabs-Integration/1.0'
        }
      }
    );

    // Handle open event for ElevenLabs WebSocket
    elevenLabsWs.on("open", () => {
      console.log("[ElevenLabs] Connected to Conversational AI.");
      conversationActive = true;
    });

    // Handle messages from ElevenLabs
    elevenLabsWs.on("message", (data) => {
      try {
        const message = JSON.parse(data);
        handleElevenLabsMessage(message, connection);
      } catch (error) {
        console.error("[ElevenLabs] Error parsing message:", error);
      }
    });

    // Handle errors from ElevenLabs WebSocket
    elevenLabsWs.on("error", (error) => {
      console.error("[ElevenLabs] WebSocket error:", error);
      conversationActive = false;
    });

    // Handle close event for ElevenLabs WebSocket
    elevenLabsWs.on("close", (code, reason) => {
      console.log(`[ElevenLabs] Disconnected. Code: ${code}, Reason: ${reason}`);
      conversationActive = false;
    });

    // Function to handle messages from ElevenLabs
    const handleElevenLabsMessage = (message, connection) => {
      if (!streamSid) {
        console.warn("[ElevenLabs] Received message but streamSid is not set");
        return;
      }

      switch (message.type) {
        case "conversation_initiation_metadata":
          console.info("[ElevenLabs] Received conversation initiation metadata.");
          break;
        case "audio":
          if (message.audio_event?.audio_base_64) {
            // Send audio data to Twilio
            const audioData = {
              event: "media",
              streamSid,
              media: {
                payload: message.audio_event.audio_base_64,
              },
            };
            
            try {
              connection.send(JSON.stringify(audioData));
            } catch (error) {
              console.error("[ElevenLabs] Error sending audio to Twilio:", error);
            }
          }
          break;
        case "interruption":
          // Clear Twilio's audio queue
          try {
            connection.send(JSON.stringify({ event: "clear", streamSid }));
            console.log("[ElevenLabs] Sent clear command to Twilio");
          } catch (error) {
            console.error("[ElevenLabs] Error sending clear command:", error);
          }
          break;
        case "ping":
          // Respond to ping events from ElevenLabs
          if (message.ping_event?.event_id) {
            const pongResponse = {
              type: "pong",
              event_id: message.ping_event.event_id,
            };
            try {
              elevenLabsWs.send(JSON.stringify(pongResponse));
            } catch (error) {
              console.error("[ElevenLabs] Error sending pong response:", error);
            }
          }
          break;
        case "user_transcript":
          console.log(`[ElevenLabs] User said: ${message.user_transcript?.text || 'N/A'}`);
          break;
        case "agent_response":
          console.log(`[ElevenLabs] Agent said: ${message.agent_response?.text || 'N/A'}`);
          break;
        default:
          console.log(`[ElevenLabs] Received unhandled message type: ${message.type}`);
      }
    };

    // Handle messages from Twilio
    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case "start":
            // Store Stream SID when stream starts
            streamSid = data.start.streamSid;
            console.log(`[Twilio] Stream started with ID: ${streamSid}`);
            break;
          case "media":
            // Route audio from Twilio to ElevenLabs
            if (elevenLabsWs.readyState === WebSocket.OPEN && conversationActive) {
              try {
                // data.media.payload is base64 encoded μ-law audio
                const audioMessage = {
                  user_audio_chunk: Buffer.from(
                    data.media.payload,
                    "base64"
                  ).toString("base64"),
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              } catch (error) {
                console.error("[Twilio] Error sending audio to ElevenLabs:", error);
              }
            } else if (!conversationActive) {
              console.warn("[Twilio] Received audio but ElevenLabs conversation is not active");
            }
            break;
          case "stop":
            // Close ElevenLabs WebSocket when Twilio stream stops
            console.log("[Twilio] Stream stopped, closing ElevenLabs connection");
            if (elevenLabsWs.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
            break;
          default:
            console.log(`[Twilio] Received unhandled event: ${data.event}`);
        }
      } catch (error) {
        console.error("[Twilio] Error processing message:", error);
      }
    });

    // Handle close event from Twilio
    connection.on("close", () => {
      console.log("[Twilio] Client disconnected");
      conversationActive = false;
      if (elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });

    // Handle errors from Twilio WebSocket
    connection.on("error", (error) => {
      console.error("[Twilio] WebSocket error:", error);
      conversationActive = false;
      if (elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });

    // Cleanup on connection timeout
    const connectionTimeout = setTimeout(() => {
      if (elevenLabsWs.readyState === WebSocket.OPEN) {
        console.log("[Server] Connection timeout, closing ElevenLabs connection");
        elevenLabsWs.close();
      }
    }, 300000); // 5 minutes timeout

    // Clear timeout when connection closes
    connection.on("close", () => {
      clearTimeout(connectionTimeout);
    });
  });
});

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  console.log(`[Server] Received ${signal}, shutting down gracefully...`);
  
  fastify.close(() => {
    console.log("[Server] HTTP server closed.");
    process.exit(0);
  });
  
  // Force close server after 10 seconds
  setTimeout(() => {
    console.error("[Server] Could not close connections in time, forcefully shutting down");
    process.exit(1);
  }, 10000);
};

// Listen for termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[Server] Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the Fastify server with proper error handling
const start = async () => {
  try {
    console.log(`[Server] Starting server on port ${PORT}...`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[Server] Agent ID: ${ELEVENLABS_AGENT_ID ? 'configured' : 'missing'}`);
    console.log(`[Server] Twilio Account SID: ${TWILIO_ACCOUNT_SID ? 'configured' : 'missing'}`);
    
    await fastify.listen({ 
      port: PORT, 
      host: '0.0.0.0' 
    });
    
    console.log(`[Server] Server successfully started on port ${PORT}`);
    console.log(`[Server] Health check available at: http://0.0.0.0:${PORT}/health`);
    
  } catch (err) {
    console.error("[Server] Error starting server:", err);
    process.exit(1);
  }
};

// Start the server
start();
