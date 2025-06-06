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

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing Twilio credentials in environment variables");
  process.exit(1);
}

// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Route to initiate outbound calls
fastify.post("/twilio/outbound_call", async (request, reply) => {
  try {
    const { to, from } = request.body;
    
    // Validate required parameters
    if (!to) {
      return reply.status(400).send({ error: "Missing 'to' phone number" });
    }
    
    const fromNumber = from || TWILIO_PHONE_NUMBER;
    
    // Create the call
    const call = await twilioClient.calls.create({
      to: to,
      from: fromNumber,
      url: `https://${request.headers.host}/twilio/outbound_twiml`,
      method: 'POST',
      statusCallback: `https://${request.headers.host}/twilio/call_status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });

    console.log(`[Twilio] Outbound call initiated: ${call.sid}`);
    
    reply.send({
      success: true,
      callSid: call.sid,
      to: to,
      from: fromNumber,
      status: call.status
    });
    
  } catch (error) {
    console.error("[Twilio] Error initiating outbound call:", error);
    reply.status(500).send({ 
      error: "Failed to initiate outbound call",
      details: error.message 
    });
  }
});

// TwiML response for outbound calls
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

// Route to handle incoming calls from Twilio
fastify.all("/twilio/inbound_call", async (request, reply) => {
  console.log("[Twilio] Inbound call received, connecting to stream");
  
  // Generate TwiML response to connect the call to a WebSocket stream
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
  const { CallSid, CallStatus, From, To } = request.body;
  
  console.log(`[Twilio] Call status update - SID: ${CallSid}, Status: ${CallStatus}, From: ${From}, To: ${To}`);
  
  // You can add custom logic here based on call status
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
      console.log(`[Twilio] Call ${CallSid} completed`);
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
  }
  
  reply.send({ status: 'received' });
});

// WebSocket route for handling media streams from Twilio
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
    console.info("[Server] Twilio connected to media stream.");

    let streamSid = null;

    // Connect to ElevenLabs Conversational AI WebSocket
    const elevenLabsWs = new WebSocket(
      `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`
    );

    // Handle open event for ElevenLabs WebSocket
    elevenLabsWs.on("open", () => {
      console.log("[ElevenLabs] Connected to Conversational AI.");
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
    });

    // Handle close event for ElevenLabs WebSocket
    elevenLabsWs.on("close", () => {
      console.log("[ElevenLabs] Disconnected.");
    });

    // Function to handle messages from ElevenLabs
    const handleElevenLabsMessage = (message, connection) => {
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
            connection.send(JSON.stringify(audioData));
          }
          break;
        case "interruption":
          // Clear Twilio's audio queue
          connection.send(JSON.stringify({ event: "clear", streamSid }));
          break;
        case "ping":
          // Respond to ping events from ElevenLabs
          if (message.ping_event?.event_id) {
            const pongResponse = {
              type: "pong",
              event_id: message.ping_event.event_id,
            };
            elevenLabsWs.send(JSON.stringify(pongResponse));
          }
          break;
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
            if (elevenLabsWs.readyState === WebSocket.OPEN) {
              // data.media.payload is base64 encoded
              const audioMessage = {
                user_audio_chunk: Buffer.from(
                  data.media.payload,
                  "base64"
                ).toString("base64"),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;
          case "stop":
            // Close ElevenLabs WebSocket when Twilio stream stops
            elevenLabsWs.close();
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
      elevenLabsWs.close();
      console.log("[Twilio] Client disconnected");
    });

    // Handle errors from Twilio WebSocket
    connection.on("error", (error) => {
      console.error("[Twilio] WebSocket error:", error);
      elevenLabsWs.close();
    });
  });
});

// Start the Fastify server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
