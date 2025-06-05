 console.log("[ElevenLabs] Signed URL fetched via POST");
    } catch (postErr) {
      if ([400, 405].includes(postErr?.response?.status)) {
        console.warn(`[ElevenLabs] POST failed (${postErr.response.status}), falling back to GET`);
        const getRes = await axios.get(
          `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}&session_id=${session_id}`,
          { headers: { "xi-api-key": ELEVENLABS_API_KEY } }
        );
        signedUrl = getRes.data.signed_url;
        console.log("[ElevenLabs] Signed URL fetched via GET");
      } else {
        throw postErr;
      }
    }

    const elevenLabsWs = new WebSocket(signedUrl);

    elevenLabsWs.on("open", () => {
      console.log("[ElevenLabs] Connected");
      elevenLabsWs.send(JSON.stringify({
        type: "user_utterance",
        user_utterance: "Hi, this is Mohit from Productiv."
      }));
    });

    elevenLabsWs.on("error", (err) => {
      console.error("[ElevenLabs WebSocket Error]", err);
    });

    elevenLabsWs.on("message", (data) => {
      const msg = JSON.parse(data);
      console.log("[ElevenLabs → Twilio] Response:", msg);

      if (msg.type === "audio" && msg.audio_event?.audio_base_64) {
        socket.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.audio_event.audio_base_64 }
        }));
      }

      if (msg.type === "interruption") {
        socket.send(JSON.stringify({ event: "clear", streamSid }));
      }

      if (msg.type === "ping") {
        elevenLabsWs.send(JSON.stringify({
          type: "pong",
          event_id: msg.ping_event.event_id
        }));
      }
    });

    socket.on("open", () => console.log("[Twilio] WebSocket opened"));
    socket.on("close", () => {
      console.log("[Twilio] WebSocket closed");
      elevenLabsWs.close();
      if (elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });

    socket.on("message", (message) => {
      const msg = JSON.parse(message);
      console.log("[Twilio → Server] Incoming:", msg);

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
          user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
        };
        if (elevenLabsWs.readyState === WebSocket.OPEN) {
          elevenLabsWs.send(JSON.stringify(userChunk));
        }
      } else if (msg.event === "stop") {
        elevenLabsWs.close();
        if (elevenLabsWs.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      }
    });

  } catch (err) {
    console.error("[WebSocket Error]", err);
    connection.socket.close();
  }
});

// Start server
fastify.listen({ port: 3000, host: "0.0.0.0" }, () => {
  console.log("Relay server live on port 3000");
});
