/*  index.js – Twilio × ElevenLabs relay (Fastify + WS)  */

import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
import crypto from 'crypto';
import axios from 'axios';

/* ───────────────────────── 1.  ENV / CONFIG ───────────────────────── */

dotenv.config();

const {
  ELEVENLABS_AGENT_ID,
  ELEVENLABS_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PORT = 8000,
  MEDIA_STREAM_TIMEOUT_MS = 300_000, // 5 min
  MAX_ELEVENLABS_RETRIES        = 3,
} = process.env;

if (!ELEVENLABS_AGENT_ID || !ELEVENLABS_API_KEY) {
  console.error('❌  ELEVENLABS_* env vars missing'); process.exit(1);
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error('❌  Twilio env vars missing'); process.exit(1);
}

/* ───────────────────────── 2.  GLOBAL STATE ───────────────────────── */

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const metrics = { calls:0, errors:0, active:0, reconnects:0 };
const transcripts = {};      // { callSid: [ { role,text,timestamp } ] }
const callContextMap = {};   // { reqId  : { script,persona,context,callSid } }

const genId = () => crypto.randomBytes(8).toString('hex');

/* ───────────────────────── 3.  SIGNED-URL HELPER ───────────────────── */

async function getSignedUrl () {
  try {
    const { data } = await axios.get(
      'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url',
      { params: { agent_id: ELEVENLABS_AGENT_ID },
        headers:{ 'xi-api-key':ELEVENLABS_API_KEY }}
    );
    return data.signed_url;
  } catch (err) {
    console.error('❌  ElevenLabs signed-URL error:', err?.response?.data || err);
    throw new Error('Failed to obtain ElevenLabs signed URL');
  }
}

/* ───────────────────────── 4.  FASTIFY SET-UP ─────────────────────── */

const fastify = Fastify({
  logger : {
    level     : process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport : process.env.NODE_ENV === 'production'
                  ? undefined
                  : { target:'pino-pretty' }
  }
});
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

/* ─ Health & metrics ─ */
fastify.get('/',       (_,r)=>r.send({ ok:true, ts:new Date().toISOString() }));
fastify.get('/health', (_,r)=>r.send({ status:'healthy', uptime:process.uptime() }));
fastify.get('/metrics',(_,r)=>{
  r.type('text/plain').send([
    `calls_total ${metrics.calls}`,
    `errors_total ${metrics.errors}`,
    `active_calls ${metrics.active}`,
    `reconnects_total ${metrics.reconnects}`
  ].join('\n'));
});

/* ─ Transcripts ─ */
fastify.get('/transcripts/:sid', (req,r)=>{
  r.send({ callSid:req.params.sid, transcript: transcripts[req.params.sid]||[] });
});

/* ───────────────────────── 5.  OUTBOUND CALL ───────────────────────── */

fastify.post('/twilio/outbound_call', async (req, reply)=>{
  const reqId = genId();
  try {
    const { to, from, script, persona, context } = req.body;

    if (!to) return reply.code(400).send({ error:'Missing "to" number' });
    if (!/^\+?[1-9]\d{1,14}$/.test(to))
      return reply.code(400).send({ error:'Invalid E.164 phone number' });

    const call = await twilioClient.calls.create({
      to,
      from      : from || TWILIO_PHONE_NUMBER,
      url       : `https://${req.headers.host}/twilio/outbound_twiml?reqId=${reqId}`,
      method    : 'POST',
      statusCallback: `https://${req.headers.host}/twilio/call_status`,
      statusCallbackEvent:['initiated','ringing','answered','completed','busy','no-answer','failed'],
      statusCallbackMethod: 'POST',
      timeout:30,
      record:false
    });

    callContextMap[reqId] = { script, persona, context, callSid:call.sid };

    metrics.calls++; metrics.active++;
    req.log.info({ reqId, callSid:call.sid },'Twilio call initiated');

    reply.send({ success:true, reqId, callSid:call.sid });
  } catch (e) {
    metrics.errors++;
    req.log.error(e,'Outbound call error');
    reply.code(500).send({ error:'Twilio call failed', details:e.message });
  }
});

/* ───────────────────────── 6.  TWIML ENDPOINT ─────────────────────── */

fastify.post('/twilio/outbound_twiml', (req, reply)=>{
  const reqId  = req.query.reqId;
  const proto  = (/localhost|127\.0\.0\.1/.test(req.headers.host)) ? 'ws':'wss';
  const stream = `${proto}://${req.headers.host}/media-stream?reqId=${reqId}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to the AI assistant.</Say>
  <Connect>
    <Stream url="${stream}" />
  </Connect>
</Response>`;
  reply.type('text/xml').send(twiml);
});

/* ───────────────────────── 7.  STATUS CALLBACK ────────────────────── */

fastify.post('/twilio/call_status', (req, reply)=>{
  const { CallSid, CallStatus, Duration } = req.body;
  if (['completed','failed','busy','no-answer','canceled'].includes(CallStatus))
    metrics.active = Math.max(0, metrics.active-1);
  req.log.info(req.body,'Call status');
  reply.send({ ok:true });
});

/* ───────────────────────── 8.  MEDIA-STREAM WS ────────────────────── */

fastify.register(async app=>{
  app.get('/media-stream', { websocket:true }, (conn, req)=>{
    const reqId = req.query.reqId;
    const ctx   = callContextMap[reqId] || {};
    const { script, persona, context:agentContext, callSid } = ctx;

    let streamSid=null, elevenWs=null, closed=false, retries=0;
    let elevenReady=false, buffer=[];

    /* helper */
    const flushBuffer = ()=> {
      if (!elevenReady || !elevenWs || elevenWs.readyState!==WebSocket.OPEN) return;
      buffer.forEach(b=> elevenWs.send(JSON.stringify({ user_audio_chunk:b })));
      buffer.length=0;
    };

    /* ─ connect to ElevenLabs ─ */
    const connectEleven = async ()=> {
      try {
        const url = await getSignedUrl();
        elevenWs  = new WebSocket(url,{ headers:{ 'User-Agent':'Relay/1.0' }});

        elevenWs.on('open', ()=>{
          retries=0; elevenReady=false;
          metrics.reconnects++;
          if (script||persona||agentContext){
            const init = { type:'conversation_initiation_client_data',
              conversation_initiation_client_data:{ script, persona, context:agentContext }};
            elevenWs.send(JSON.stringify(init));
          }
        });

        elevenWs.on('message', d=>{
          let msg;
          try{ msg = JSON.parse(d); }catch{}
          if (!msg) return;
          switch (msg.type){
            case 'conversation_initiation_metadata':
              elevenReady=true; flushBuffer(); break;

            case 'audio':
              if (streamSid && msg.audio_event?.audio_base_64){
                conn.socket.send(JSON.stringify({
                  event:'media', streamSid,
                  media:{ payload: msg.audio_event.audio_base_64 }
                }));
              }
              break;

            case 'user_transcript':   transcripts[callSid]?.push({ role:'user',  text:msg.user_transcript?.text,  timestamp:new Date().toISOString() }); break;
            case 'agent_response':    transcripts[callSid]?.push({ role:'agent', text:msg.agent_response?.text, timestamp:new Date().toISOString() }); break;
            case 'ping':
              if (msg.ping_event?.event_id)
                elevenWs.send(JSON.stringify({ type:'pong', event_id:msg.ping_event.event_id }));
              break;
            case 'interruption':
              if (streamSid) conn.socket.send(JSON.stringify({ event:'clear', streamSid }));
              break;
          }
        });

        elevenWs.on('close', ()=>{
          elevenReady=false;
          if (!closed && ++retries<=MAX_ELEVENLABS_RETRIES){
            setTimeout(connectEleven, 1000*retries);
          } else if (!closed) {
            conn.socket.close(); // give up
          }
        });

      } catch (e){
        conn.log.error(e,'ElevenLabs connect error');
      }
    };
    connectEleven();

    /* ─ WS from Twilio ─ */
    conn.socket.on('message', raw=>{
      let data; try{ data = JSON.parse(raw); }catch{return;}
      switch (data.event){
        case 'start':
          streamSid=data.start.streamSid;
          break;

        case 'media':
          const chunk = data.media?.payload;
          if (!chunk) return;
          if (elevenReady && elevenWs?.readyState===WebSocket.OPEN){
            elevenWs.send(JSON.stringify({ user_audio_chunk:chunk }));
          } else buffer.push(chunk);
          break;

        case 'stop':
          closed=true;
          elevenWs?.close(); break;
      }
    });

    conn.socket.on('close', ()=>{
      closed=true; elevenWs?.close();
    });

    /* idle timeout */
    setTimeout(()=> !closed && elevenWs?.close(), MEDIA_STREAM_TIMEOUT_MS);
  });
});

/* ───────────────────────── 9.  SHUTDOWN & START ───────────────────── */

const shutdown = sig=>{
  fastify.log.info(`Received ${sig}; shutting down.`);
  fastify.close().then(()=>process.exit(0));
};
['SIGINT','SIGTERM'].forEach(s=>process.on(s, ()=>shutdown(s)));

fastify.listen({ port:PORT, host:'0.0.0.0' })
  .then(addr=> fastify.log.info(`Server listening on ${addr}`))
  .catch(e   => { fastify.log.error(e); process.exit(1); });
