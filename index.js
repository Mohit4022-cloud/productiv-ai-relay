import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import fetch from 'node-fetch';

dotenv.config();

const fastify = Fastify();
fastify.register(fastifyWebsocket);

const ELEVENLABS_WS_URL = 'wss://api.elevenlabs.io/v1/speech/streaming';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

fastify.get('/twilio-stream', { websocket: true }, (connection, req) => {
  let elevenLabsWs = null;
  let streamSid = null;
  let customParameters = {};

  console.log('[🔌] New Twilio WebSocket connection established.');

  connection.socket.on('message', async (message) => {
    const msg = JSON.parse(message);

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      customParameters = msg.start.customParameters || {};
      console.log(`[🎙️] Call started. SID: ${streamSid}`);
      setupElevenLabsConnection();
    }

    if (msg.event === 'media' && elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
      elevenLabsWs.send(JSON.stringify({
        audio: {
          user_audio_chunk: msg.media.payload
        }
      }));
    }

    if (msg.event === 'stop') {
      console.log('[⛔] Twilio stream stopped.');
      if (elevenLabsWs) elevenLabsWs.close();
    }
  });

  function setupElevenLabsConnection() {
    elevenLabsWs = new WebSocket(`${ELEVENLABS_WS_URL}/${ELEVENLABS_VOICE_ID}/stream`, {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
      }
    });

    elevenLabsWs.on('open', () => {
      console.log('[🧠] Connected to ElevenLabs');
      elevenLabsWs.send(JSON.stringify({
        text: "Hi Mohit, this is Harper from Productiv. Can I quickly share why I'm calling?",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.4
        }
      }));
    });

    elevenLabsWs.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.audio_event?.audio_base_64) {
        console.log('[✅ AUDIO] Sending audio back to Twilio');
        connection.socket.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: {
            payload: msg.audio_event.audio_base_64
          }
        }));
      }

      if (msg.agent_response_event?.agent_response) {
        console.log(`[🗣️ AGENT]: ${msg.agent_response_event.agent_response}`);
      }
    });

    elevenLabsWs.on('close', () => {
      console.log('[🔒] ElevenLabs WebSocket closed');
    });

    elevenLabsWs.on('error', (error) => {
      console.error('[❌ ElevenLabs Error]', error);
    });
  }
});

fastify.listen({ port: 3000 }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log('[🚀] Fastify server listening on http://localhost:3000');
});
