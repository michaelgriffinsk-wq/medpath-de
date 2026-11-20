// ================= GEMINI LIVE VOICE ENGINE (v0.5) =================
const LIVE_MODELS = ["models/gemini-3.8-live", "models/gemini-3.1-flash-live-preview"];

let liveWs = null;
let liveMicStream = null;
let liveCaptureCtx = null;
let livePlayCtx = null;
let liveProcessor = null;
let liveNextPlayTime = 0;
let liveAiSpeakingUntil = 0;
let liveActiveSources = [];
let liveEarphoneMode = false;
let liveSessionLog = [];
let liveCurrentUserText = "";
let liveCurrentModelText = "";
let liveModelIndex = 0;

function setLiveUI(state, text) {
  const orb = document.getElementById("live-orb");
  const status = document.getElementById("live-status");
  if (orb) orb.className = `live-orb ${state}`;
  if (status) status.textContent = text;
}

function appendLiveTranscript(speaker, text) {
  const box = document.getElementById("live-transcript");
  if (!box || !text.trim()) return;
  const line = document.createElement("div");
  line.style.marginBottom = "6px";
  line.innerHTML = `<strong style="color:${speaker === "You" ? "var(--accent)" : "var(--clinical)"}">${speaker}:</strong> ${escapeHtml(text)}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function floatTo16BitPCM(float32Arr) {
  const out = new Int16Array(float32Arr.length);
  for (let i = 0; i < float32Arr.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Arr[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsampleTo16k(buffer, inputRate) {
  if (inputRate === 16000) return buffer;
  const ratio = inputRate / 16000;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    result[i] = buffer[Math.min(buffer.length - 1, Math.round(i * ratio))];
  }
  return result;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function stopAiAudioPlayback() {
  liveActiveSources.forEach((src) => {
    try { src.stop(); } catch (e) {}
  });
  liveActiveSources = [];
  liveNextPlayTime = 0;
  liveAiSpeakingUntil = 0;
  setLiveUI("listening", "Listening... (Speak now)");
}

function playPcm24kBase64(base64) {
  if (!livePlayCtx) livePlayCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (livePlayCtx.state === "suspended") livePlayCtx.resume();

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

  const audioBuf = livePlayCtx.createBuffer(1, float32.length, 24000);
  audioBuf.copyToChannel(float32, 0);

  const src = livePlayCtx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(livePlayCtx.destination);

  const now = livePlayCtx.currentTime;
  if (liveNextPlayTime < now) liveNextPlayTime = now + 0.04;
  src.start(liveNextPlayTime);
  liveNextPlayTime += audioBuf.duration;
  liveAiSpeakingUntil = liveNextPlayTime;

  liveActiveSources.push(src);
  setLiveUI("speaking", liveEarphoneMode ? "Coach speaking (Earphone barge-in ON)" : "Coach speaking (Mic auto-muted)");

  src.onended = () => {
    liveActiveSources = liveActiveSources.filter((s) => s !== src);
    if (liveActiveSources.length === 0) {
      setTimeout(() => {
        if (liveActiveSources.length === 0 && liveWs && liveWs.readyState === WebSocket.OPEN) {
          setLiveUI("listening", "Listening... (Speak now)");
        }
      }, 300);
    }
  };
}

async function startLiveMic() {
  // Layer 1 Echo Fix: Request system-wide echo cancellation with safe fallback
  try {
    liveMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: "all", noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    liveMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  }

  liveCaptureCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = liveCaptureCtx.createMediaStreamSource(liveMicStream);
  liveProcessor = liveCaptureCtx.createScriptProcessor(4096, 1, 1);

  liveProcessor.onaudioprocess = (e) => {
    if (!liveWs || liveWs.readyState !== WebSocket.OPEN) return;

    // Layer 2 Echo Fix: Auto-mute mic while AI is speaking (+300ms room reverb buffer) in Speaker Mode
    if (!liveEarphoneMode && livePlayCtx && livePlayCtx.currentTime < liveAiSpeakingUntil + 0.3) {
      return;
    }

    const input = e.inputBuffer.getChannelData(0);
    const downsampled = downsampleTo16k(input, liveCaptureCtx.sampleRate);
    const pcm16 = floatTo16BitPCM(downsampled);
    const b64 = arrayBufferToBase64(pcm16.buffer);

    liveWs.send(JSON.stringify({
      realtimeInput: {
        audio: { mimeType: "audio/pcm;rate=16000", data: b64 }
      }
    }));
  };

  source.connect(liveProcessor);
  liveProcessor.connect(liveCaptureCtx.destination);
}

function connectLiveSocket() {
  const key = getApiKey();
  if (!key) {
    alert("Paste your Gemini API key in the Vault tab first.");
    closeLiveSession(false);
    return;
  }

  const modelName = LIVE_MODELS[liveModelIndex] || LIVE_MODELS[0];
  setLiveUI("", `Connecting to ${modelName.replace("models/", "")}...`);

  const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`;
  liveWs = new WebSocket(wsUrl);

  liveWs.onopen = () => {
    const setupMsg = {
      setup: {
        model: modelName,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }
          }
        },
        systemInstruction: {
          parts: [{ text: buildSystemContext() + "\n\nLIVE VOICE MODE: Keep spoken answers concise, conversational, and natural. Switch smoothly between English and German when practicing." }]
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    };
    liveWs.send(JSON.stringify(setupMsg));
  };

  liveWs.onmessage = async (event) => {
    let raw = event.data;
    if (raw instanceof Blob) raw = await raw.text();
    const msg = JSON.parse(raw);

    if (msg.setupComplete) {
      setLiveUI("listening", "Connected! Listening...");
      startLiveMic().catch((err) => {
        setLiveUI("", "Mic error: " + err.message);
      });
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      stopAiAudioPlayback();
    }

    if (sc.inputTranscription?.text) {
      liveCurrentUserText += sc.inputTranscription.text;
    }
    if (sc.outputTranscription?.text) {
      liveCurrentModelText += sc.outputTranscription.text;
    }

    const parts = sc.modelTurn?.parts || [];
    for (const p of parts) {
      if (p.inlineData?.data) {
        playPcm24kBase64(p.inlineData.data);
      }
    }

    if (sc.turnComplete) {
      if (liveCurrentUserText.trim()) {
        appendLiveTranscript("You", liveCurrentUserText.trim());
        liveSessionLog.push(`You: ${liveCurrentUserText.trim()}`);
        liveCurrentUserText = "";
      }
      if (liveCurrentModelText.trim()) {
        appendLiveTranscript("Coach", liveCurrentModelText.trim());
        liveSessionLog.push(`Coach: ${liveCurrentModelText.trim()}`);
        liveCurrentModelText = "";
      }
    }
  };

  liveWs.onerror = () => {
    if (liveModelIndex < LIVE_MODELS.length - 1) {
      liveModelIndex++;
      connectLiveSocket();
    } else {
      setLiveUI("", "Connection failed. Check internet or API key.");
    }
  };

  liveWs.onclose = (ev) => {
    if (ev.code !== 1000 && liveModelIndex < LIVE_MODELS.length - 1 && !liveMicStream) {
      liveModelIndex++;
      connectLiveSocket();
    }
  };
}

function openLiveSession() {
  liveSessionLog = [];
  liveCurrentUserText = "";
  liveCurrentModelText = "";
  liveModelIndex = 0;
  document.getElementById("live-transcript").innerHTML = "";
  document.getElementById("live-modal").classList.remove("hidden");
  connectLiveSocket();
}

function closeLiveSession(saveToChat = true) {
  stopAiAudioPlayback();
  if (liveProcessor) { liveProcessor.disconnect(); liveProcessor = null; }
  if (liveCaptureCtx) { liveCaptureCtx.close(); liveCaptureCtx = null; }
  if (liveMicStream) { liveMicStream.getTracks().forEach((t) => t.stop()); liveMicStream = null; }
  if (liveWs) { liveWs.close(1000); liveWs = null; }

  document.getElementById("live-modal").classList.add("hidden");

  if (saveToChat && liveSessionLog.length > 0) {
    const thread = getActiveThread();
    thread.messages.push({
      role: "model",
      text: `🎙️ Live Voice Session Transcript:\n\n${liveSessionLog.join("\n\n")}`
    });
    saveState();
    renderCoach();
  }
}

// Button Bindings
document.getElementById("open-live-btn")?.addEventListener("click", openLiveSession);
document.getElementById("live-end-btn")?.addEventListener("click", () => closeLiveSession(true));
document.getElementById("live-interrupt-btn")?.addEventListener("click", () => {
  stopAiAudioPlayback();
});
document.getElementById("live-earphone-btn")?.addEventListener("click", (e) => {
  liveEarphoneMode = !liveEarphoneMode;
  e.target.textContent = liveEarphoneMode ? "🎧 Earphones (Barge-In)" : "🔊 Speaker (Safe)";
});
