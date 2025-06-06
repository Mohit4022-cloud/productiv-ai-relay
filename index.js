import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import twilio from 'twilio';

const fastify = Fastify({ logger: true });

// Environment variables
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  PORT = 10000
} = process.env;

// Validate required environment variables
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error('Missing required Twilio environment variables');
  process.exit(1);
}

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('Missing required ElevenLabs environment variables');
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Store active connections
const activeConnections = new Map();

// ElevenLabs API functions
async function getElevenLabsSignedUrl() {
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/convai/conversation/get_signed_url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        agent_id: ELEVENLABS_AGENT_ID
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
    }

    const data = await response.json();
    console.log('[ElevenLabs] Signed URL obtained successfully');
    return data.signed_url;
  } catch (error) {
    console.error('[ElevenLabs] Failed to get signed URL:', error.message);
    throw error;
  }
}

// CORS headers
fastify.addHook('preHandler', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (request.method === 'OPTIONS') {
    reply.code(200).send();
    return;
  }
});

// Health check endpoint
fastify.get('/', async (request, reply) => {
  return { 
    status: 'healthy', 
    service: 'productiv-ai-relay',
    timestamp: new Date().toISOString()
  };
});

// Initiate outbound call
fastify.post('/twilio/outbound_call', async (request, reply) => {
  try {
    const { to } = request.body;
    
    if (!to) {
      return reply.code(400).send({ 
        error: 'Missing required parameter: to',
        success: false 
      });
    }

    // Validate phone number format
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    if (!phoneRegex.test(to)) {
      return reply.code(400).send({ 
        error: 'Invalid phone number format',
        success: false 
      });
    }

    console.log(`[Twilio] Initiating call to ${to}`);

    const call = await twilioClient.calls.create({
      url: `${request.protocol}://${request.headers.host}/twilio/outbound_twiml`,
      to: to,
      from: TWILIO_PHONE_NUMBER,
      statusCallback: `${request.protocol}://${request.headers.host}/twilio/call_status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });

    console.log(`[Twilio] Call initiated with SID: ${call.sid}`);
    
    return reply.send({ 
      success: true, 
      callSid: call.sid,
      message: 'Call initiated successfully'
    });

  } catch (error) {
    console.error('[Twilio] Error initiating call:', error);
    return reply.code(500).send({ 
      error: 'Failed to initiate outbound call',
      details: error.message,
      success: false
    });
  }
});

// TwiML for outbound calls
fastify.post('/twilio/outbound_twiml', async (request, reply) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
    </Connect>
</Response>`;

  reply.type('text/xml').send(twiml);
});

// Call status webhook
fastify.post('/twilio/call_status', async (request, reply) => {
  const { CallSid, CallStatus, From, To, CallDuration } = request.body;
  
  console.log(`[Twilio] Call ${CallSid} status: ${CallStatus}, From: ${From}, To: ${To}, Duration: ${CallDuration || '?'}s`);
  
  // Clean up connection when call ends
  if (CallStatus === 'completed' || CallStatus === 'failed' || CallStatus === 'canceled') {
    const connection = activeConnections.get(CallSid);
    if (connection) {
      console.log(`[Cleanup] Removing connection for call ${CallSid}`);
      if (connection.elevenLabsWs && connection.elevenLabsWs.readyState === WebSocket.OPEN) {
        connection.elevenLabsWs.close();
      }
      if (connection.twilioWs && connection.twilioWs.readyState === WebSocket.OPEN) {
        connection.twilioWs.close();
      }
      activeConnections.delete(CallSid);
    }
  }
  
  reply.send('OK');
});

// Media stream WebSocket handler
fastify.register(async function (fastify) {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('[Media] Twilio WebSocket connected');
    
    let callSid = null;
    let elevenLabsWs = null;
    let streamSid = null;
    let isCallActive = true;

    // Initialize ElevenLabs connection
    async function initializeElevenLabs() {
      try {
        const signedUrl = await getElevenLabsSignedUrl();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on('open', () => {
          console.log('[ElevenLabs] WebSocket connected successfully');
        });

        elevenLabsWs.on('message', (data) => {
          try {
            const message = JSON.parse(data);
            
            if (message.type === 'audio' && message.audio_event) {
              const audioData = message.audio_event.audio_base_64;
              if (audioData && connection.readyState === WebSocket.OPEN) {
                // Send audio back to Twilio
                const mediaMessage = {
                  event: 'media',
                  streamSid: streamSid,
                  media: {
                    payload: audioData
                  }
                };
                connection.send(JSON.stringify(mediaMessage));
              }
            }
          } catch (error) {
            console.error('[ElevenLabs] Error processing message:', error);
          }
        });

        elevenLabsWs.on('error', (error) => {
          console.error('[ElevenLabs] WebSocket error:', error);
        });

        elevenLabsWs.on('close', () => {
          console.log('[ElevenLabs] WebSocket closed');
        });

      } catch (error) {
        console.error('[ElevenLabs] Failed to initialize connection:', error);
      }
    }

    // Handle Twilio WebSocket messages
    connection.on('message', async (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'connected':
            console.log('[Media] Twilio media stream connected');
            break;

          case 'start':
            streamSid = data.start.streamSid;
            callSid = data.start.callSid;
            console.log(`[Media] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
            
            // Store connection for cleanup
            activeConnections.set(callSid, {
              twilioWs: connection,
              elevenLabsWs: null // Will be set after initialization
            });

            // Initialize ElevenLabs connection
            await initializeElevenLabs();
            
            // Update stored connection
            if (activeConnections.has(callSid)) {
              activeConnections.get(callSid).elevenLabsWs = elevenLabsWs;
            }
            break;

          case 'media':
            if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN && isCallActive) {
              // Forward audio to ElevenLabs
              const audioMessage = {
                user_audio_chunk: Buffer.from(data.media.payload, 'base64')
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;

          case 'stop':
            console.log('[Media] Stream stopped');
            isCallActive = false;
            break;
        }
      } catch (error) {
        console.error('[Media] Error processing Twilio message:', error);
      }
    });

    // Handle Twilio WebSocket close
    connection.on('close', () => {
      console.log('[Media] Twilio WebSocket closed');
      isCallActive = false;
      
      // Clean up ElevenLabs connection
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
      
      // Clean up stored connection
      if (callSid && activeConnections.has(callSid)) {
        activeConnections.delete(callSid);
      }
    });

    // Handle Twilio WebSocket error
    connection.on('error', (error) => {
      console.error('[Media] Twilio WebSocket error:', error);
      isCallActive = false;
    });
  });
});

// Error handler
fastify.setErrorHandler((error, request, reply) => {
  console.error('Server error:', error);
  reply.code(500).send({ 
    error: 'Internal server error',
    message: error.message 
  });
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ 
      port: PORT, 
      host: '0.0.0.0' 
    });
    console.log(`Server running on port ${PORT}`);
  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
};

start();
