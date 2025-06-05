import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import fetch from 'node-fetch';

dotenv.config();

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const connections = new Map();

fastify.get('/media-stream', { websocket: true }, (connection, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const streamSid = url.searchParams.get('streamSid');

  console.log(`[Twilio] WebSocket connection received. Stream SID: ${streamSid}`);
  if (!streamSid) return;

  connections.set(streamSid, connection.socket);

  connection.socket.on('close', () => {
    console.log(`[Twilio] WebSocket closed: ${streamSid}`);
    connections.delete(streamSid);
  });
});

fastify.post('/elevenlabs-stream', async (req, res) => {
  const { streamSid, audioBase64 } = req.body;

  const twilioSocket = connections.get(streamSid);
  if (!twilioSocket) {
    console.error(`[Error] No Twilio WebSocket found for streamSid: ${streamSid}`);
    return res.status(400).send({ error: 'Missing WebSocket connection' });
  }

  if (twilioSocket.readyState !== WebSocket.OPEN) {
    console.error(`[Error] Twilio socket not open for streamSid: ${streamSid}`);
    return res.status(400).send({ error: 'WebSocket not open' });
  }

  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    twilioSocket.send(audioBuffer);
    res.send({ success: true });
  } catch (err) {
    console.error(`[Error] Failed to send audio to Twilio:`, err);
    res.status(500).send({ error: 'Failed to stream audio' });
  }
});

fastify.get('/twiml', async (req, res) => {
  const { name, company } = req.query;

  const streamSid = 'dynamic_sid_placeholder'; // You may override this in media-stream message
  const streamUrl = `wss://${req.hostname}/media-stream?name=${name}&company=${company}&streamSid=${streamSid}`;

  const twiml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="${streamUrl}" />
      </Connect>
    </Response>
  `;

  res.header('Content-Type', 'text/xml');
  res.send(twiml.trim());
});

const port = process.env.PORT || 3000;
fastify.listen({ port, host: '0.0.0.0' }, err => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Relay server live on port ${port}`);
});
