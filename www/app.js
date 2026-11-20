const STORAGE_KEY = "medpath_de_vault";
const API_KEY_STORAGE = "medpath_de_gemini_key";
const GEMINI_MODEL = "gemini-2.5-flash";

const MODES = [
  { name: "Holiday Sprint", capHours: 8, cls: "" },
  { name: "Standard Rotation", capHours: 5, cls: "rotation" },
  { name: "Survival Mode", capHours: 2.5, cls: "survival" }
];

const DEFAULT_STATE = {
  schemaVersion: 3,
  mode: "Holiday Sprint",
  profile: {
    mbchbPhase: "Post-4th Year Holiday (Preparing for 5th Year)",
    germanLevel: "A1"
  },
  tasks: [],
  events: [],
  documents: [],
  threads: [
    {
      id: "default",
      title: "General PA & Pathway",
      messages: [
        {
          role: "model",
          text: "Welcome to MedPath DE Coach. Paste your Gemini API key in the Vault tab to unlock timetable analysis, Drive PDF reading, viva exams, and 1-tap schedule building."
        }
      ]
    }
  ],
  activeThreadId: "default",
  lastUpdated: new Date().toISOString()
};

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    const parsed = JSON.parse(raw);
    return {
      ...JSON.parse(JSON.stringify(DEFAULT_STATE)),
      ...parsed,
      profile: { ...DEFAULT_STATE.profile, ...(parsed.profile || {}) },
      tasks: parsed.tasks || [],
      events: parsed.events || [],
      documents: parsed.documents || [],
      threads: parsed.threads && parsed.threads.length ? parsed.threads : JSON.parse(JSON.stringify(DEFAULT_STATE.threads)),
      schemaVersion: 3
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function saveState() {
  appState.lastUpdated = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || "";
}

let appState = loadState();
let currentFilter = "all";
let pendingOverride = false;
let pendingAttachment = null; // { name, mimeType, base64 }

// ================= GEMINI AI ENGINE =================
function buildSystemContext() {
  const today = getTodayStr();
  const upcomingEvents = appState.events.map((e) => `${e.title} on ${e.date}`).join("; ") || "None";
  const activeTasks = appState.tasks
    .slice(0, 15)
    .map((t) => `[${t.track}] ${t.title} (${t.date || "unscheduled"} ${t.startTime || ""}) - ${t.verified ? "VERIFIED" : t.done ? "Done" : "Pending"}`)
    .join("\n") || "None";

  return `You are MedPath DE, an expert Personal Assistant, Medical Tutor, and German Coach for an MBChB medical student aiming to finish 5th/6th year + Internship + German A1-C1 (FSP/KP) -> Residency in Germany -> EU Citizenship -> Switzerland (MEBEKO).
Today: ${today}
Current Mode: ${appState.mode}
MBChB Phase: ${appState.profile.mbchbPhase}
German Level: ${appState.profile.germanLevel}
Upcoming Important Events: ${upcomingEvents}
Recent/Scheduled Tasks:\n${activeTasks}

RULES:
1. Be direct, practical, and structured. Avoid fluff.
2. Respect the 5-to-15 minute atomic step rule for all study plans.
3. Avoid double-booking any scheduled tasks listed above.
4. Whenever you propose a concrete schedule or study plan the user can add to their app, append a fenced JSON block labeled \`\`\`plan containing an array of tasks in this exact schema:
\`\`\`plan
[
  {
    "title": "Topic or Event Name",
    "track": "clinical|german|licensing|general",
    "date": "YYYY-MM-DD",
    "startTime": "HH:MM",
    "duration": 30,
    "steps": [
      { "text": "Specific 5-15m subtopic", "mins": 10 }
    ]
  }
]
\`\`\``;
}

async function callGemini(contents, customSystem = null) {
  const key = getApiKey();
  if (!key) throw new Error("No Gemini API key set. Go to the Vault tab to paste your key.");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: customSystem || buildSystemContext() }] },
        contents
      })
    }
  );

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Gemini API error");
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response received.";
}

// ================= CONFLICT DETECTION =================
function timeToMins(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function findConflicts(date, startTime, duration) {
  if (!date || !startTime) return [];
  const startA = timeToMins(startTime);
  const endA = startA + Number(duration || 30);
  return appState.tasks.filter((task) => {
    if (task.date !== date || !task.startTime) return false;
    const startB = timeToMins(task.startTime);
    const endB = startB + Number(task.duration || 30);
    return startA < endB && startB < endA;
  });
}

// ================= MICRO-TIMER =================
let timerInterval = null;
let timerSeconds = 0;
let timerPaused = false;

function startTimer(label, mins) {
  clearInterval(timerInterval);
  timerSeconds = mins * 60;
  timerPaused = false;
  document.getElementById("timer-label").textContent = label;
  document.getElementById("timer-toggle").textContent = "Pause";
  document.getElementById("timer-bar").classList.remove("hidden");
  updateTimerDisplay();

  timerInterval = setInterval(() => {
    if (timerPaused) return;
    timerSeconds--;
    updateTimerDisplay();
    if (timerSeconds <= 0) {
      clearInterval(timerInterval);
      document.getElementById("timer-display").textContent = "DONE!";
    }
  }, 1000);
}

function updateTimerDisplay() {
  const m = String(Math.floor(timerSeconds / 60)).padStart(2, "0");
  const s = String(timerSeconds % 60).padStart(2, "0");
  document.getElementById("timer-display").textContent = `${m}:${s}`;
}

document.getElementById("timer-toggle").addEventListener("click", () => {
  timerPaused = !timerPaused;
  document.getElementById("timer-toggle").textContent = timerPaused ? "Resume" : "Pause";
});

document.getElementById("timer-stop").addEventListener("click", () => {
  clearInterval(timerInterval);
  document.getElementById("timer-bar").classList.add("hidden");
});

// ================= MODE SWITCHER =================
document.getElementById("mode-badge").addEventListener("click", () => {
  const idx = MODES.findIndex((m) => m.name === appState.mode);
  appState.mode = MODES[(idx + 1) % MODES.length].name;
  saveState();
  renderAll();
});

// ================= IMPORTANT EVENTS =================
document.getElementById("toggle-event-form-btn").addEventListener("click", () => {
  document.getElementById("new-event-form").classList.toggle("hidden");
  document.getElementById("event-date").value = getTodayStr();
});

document.getElementById("save-event-btn").addEventListener("click", () => {
  const title = document.getElementById("event-title").value.trim();
  const date = document.getElementById("event-date").value;
  if (!title || !date) return;
  appState.events.push({ id: Date.now().toString(), title, date });
  appState.events.sort((a, b) => a.date.localeCompare(b.date));
  document.getElementById("event-title").value = "";
  document.getElementById("new-event-form").classList.add("hidden");
  saveState();
  renderAll();
});

window.deleteEvent = function (id) {
  appState.events = appState.events.filter((e) => e.id !== id);
  saveState();
  renderAll();
};

window.planEventWithCoach = function (eventId) {
  const ev = appState.events.find((e) => e.id === eventId);
  if (!ev) return;
  const newId = "evt-" + Date.now();
  appState.threads.unshift({
    id: newId,
    title: `Plan: ${ev.title}`,
    messages: [
      {
        role: "model",
        text: `Ready to plan for "${ev.title}" (${ev.date}). Tell me your key subtopics—or attach a timetable/PDF from Drive—and I'll build a conflict-free 5–15 min study schedule you can add in one tap.`
      }
    ]
  });
  appState.activeThreadId = newId;
  saveState();
  switchTab("view-coach");
  renderAll();
};

// ================= TASKS & ATOMIC SLICER =================
const formEl = document.getElementById("new-task-form");
const conflictEl = document.getElementById("conflict-warning");

document.getElementById("toggle-form-btn").addEventListener("click", () => {
  formEl.classList.toggle("hidden");
  document.getElementById("task-date").value = getTodayStr();
  conflictEl.classList.add("hidden");
  pendingOverride = false;
});

document.getElementById("cancel-task-btn").addEventListener("click", () => {
  formEl.classList.add("hidden");
  pendingOverride = false;
});

document.getElementById("add-task-btn").addEventListener("click", () => {
  const title = document.getElementById("task-title").value.trim();
  const track = document.getElementById("task-track").value;
  const date = document.getElementById("task-date").value;
  const startTime = document.getElementById("task-time").value;
  const duration = Number(document.getElementById("task-duration").value) || 30;
  if (!title) return;

  const conflicts = findConflicts(date, startTime, duration);
  if (conflicts.length > 0 && !pendingOverride) {
    conflictEl.innerHTML = `<strong>Schedule Conflict:</strong> Overlaps with "${escapeHtml(conflicts[0].title)}" at ${conflicts[0].startTime}. Tap <strong>Save Task</strong> again to override.`;
    conflictEl.classList.remove("hidden");
    pendingOverride = true;
    return;
  }

  appState.tasks.unshift({
    id: Date.now().toString(),
    title,
    track,
    date,
    startTime,
    duration,
    done: false,
    verified: false,
    evidence: "",
    steps: []
  });

  saveState();
  document.getElementById("task-title").value = "";
  document.getElementById("task-time").value = "";
  conflictEl.classList.add("hidden");
  formEl.classList.add("hidden");
  pendingOverride = false;
  renderAll();
});

window.addAtomicStep = function (taskId) {
  const textInput = document.getElementById(`step-input-${taskId}`);
  const durSelect = document.getElementById(`step-dur-${taskId}`);
  const text = textInput.value.trim();
  if (!text) return;
  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.steps.push({ id: Date.now().toString(), text, mins: Number(durSelect.value), done: false });
  saveState();
  renderAll();
};

window.autoSliceTask = async function (taskId) {
  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const btn = document.getElementById(`slice-btn-${taskId}`);
  if (btn) btn.textContent = "Slicing...";

  try {
    const prompt = `Break the topic "${task.title}" (track: ${task.track}, MBChB: ${appState.profile.mbchbPhase}, German: ${appState.profile.germanLevel}) into 4 to 6 concrete atomic study steps. Each step MUST take 5, 10, or 15 minutes. Reply ONLY with a raw JSON array: [{"text":"...","mins":10}]`;
    const reply = await callGemini([{ role: "user", parts: [{ text: prompt }] }], "Return ONLY a valid JSON array with no markdown or extra text.");
    const cleaned = reply.replace(/```json|```/g, "").trim();
    const steps = JSON.parse(cleaned);
    steps.forEach((s, idx) => {
      task.steps.push({
        id: `${Date.now()}-${idx}`,
        text: s.text,
        mins: [5, 10, 15].includes(Number(s.mins)) ? Number(s.mins) : 10,
        done: false
      });
    });
    saveState();
    renderAll();
  } catch (err) {
    alert("Auto-Slice failed: " + err.message);
    if (btn) btn.textContent = "✨ Auto-Slice";
  }
};

window.toggleStep = function (taskId, stepId) {
  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const step = task.steps.find((s) => s.id === stepId);
  if (step) step.done = !step.done;
  saveState();
  renderAll();
};

window.toggleGeneralTask = function (taskId) {
  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.done = !task.done;
  saveState();
  renderAll();
};

window.deleteTask = function (taskId) {
  appState.tasks = appState.tasks.filter((t) => t.id !== taskId);
  saveState();
  renderAll();
};

window.runStepTimer = function (label, mins) {
  startTimer(label, mins);
};

// ================= PROOF OF DONE GATE =================
let activeVerifyTaskId = null;
let currentExamQuestions = "";

document.getElementById("close-verify-btn").addEventListener("click", () => {
  document.getElementById("verify-modal").classList.add("hidden");
});

window.openVerifyGate = async function (taskId) {
  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task) return;
  activeVerifyTaskId = taskId;
  const modal = document.getElementById("verify-modal");
  const body = document.getElementById("verify-body");
  document.getElementById("verify-title").textContent = `Verify: ${task.title}`;
  modal.classList.remove("hidden");

  const hasKey = !!getApiKey() && navigator.onLine;
  if (!hasKey) {
    renderOfflineTeachBack(task, body);
    return;
  }

  body.innerHTML = `<p class="muted">Generating 3 viva/exam questions for "${escapeHtml(task.title)}"...</p>`;
  try {
    const stepSummary = task.steps.map((s) => s.text).join(", ") || task.title;
    const prompt = `Create 3 concise, high-yield verification questions for "${task.title}" (track: ${task.track}, subtopics: ${stepSummary}, German level: ${appState.profile.germanLevel}). Do NOT include answers yet.`;
    currentExamQuestions = await callGemini([{ role: "user", parts: [{ text: prompt }] }]);

    body.innerHTML = `
      <div class="msg model" style="max-width:100%; margin-bottom:10px;">${escapeHtml(currentExamQuestions)}</div>
      <textarea id="verify-answers" rows="4" placeholder="Type your answers to Q1, Q2, Q3..."></textarea>
      <div class="btn-row">
        <button class="btn primary" id="grade-verify-btn">Grade My Answers</button>
        <button class="btn secondary" id="switch-offline-btn">Offline Audit</button>
      </div>`;

    document.getElementById("grade-verify-btn").addEventListener("click", () => gradeVerifyAnswers(task));
    document.getElementById("switch-offline-btn").addEventListener("click", () => renderOfflineTeachBack(task, body));
  } catch (err) {
    renderOfflineTeachBack(task, body, "AI unavailable (" + err.message + "). Switched to Offline Teach-Back:");
  }
};

async function gradeVerifyAnswers(task) {
  const answers = document.getElementById("verify-answers").value.trim();
  if (!answers) return;
  const body = document.getElementById("verify-body");
  body.innerHTML = `<p class="muted">Grading your answers...</p>`;

  try {
    const prompt = `Questions asked:\n${currentExamQuestions}\n\nStudent's answers:\n${answers}\n\nGrade concisely (Pass/Needs Review), correct any red flags or grammar mistakes, and if this is a clinical topic, include 2 relevant Medical German C1 phrases (Anamnese/Fachbegriffe) as a bonus drip-feed.`;
    const feedback = await callGemini([{ role: "user", parts: [{ text: prompt }] }]);

    body.innerHTML = `
      <div class="msg model" style="max-width:100%; margin-bottom:10px;">${escapeHtml(feedback)}</div>
      <button class="btn success" id="confirm-verified-btn">Mark Verified Done ✓</button>`;

    document.getElementById("confirm-verified-btn").addEventListener("click", () => {
      task.done = true;
      task.verified = true;
      task.evidence = answers;
      saveState();
      document.getElementById("verify-modal").classList.add("hidden");
      renderAll();
    });
  } catch (err) {
    renderOfflineTeachBack(task, body, "Grading failed: " + err.message);
  }
}

function renderOfflineTeachBack(task, container, note = "Offline Mode: Prove mastery before closing this topic.") {
  container.innerHTML = `
    <p class="muted">${escapeHtml(note)}</p>
    <textarea id="offline-evidence" rows="4" placeholder="Write 3 key takeaways + 1 clinical red flag (or 3 German sentences you mastered)..."></textarea>
    <button class="btn success" id="save-offline-verify">Save Evidence & Mark Verified ✓</button>`;

  document.getElementById("save-offline-verify").addEventListener("click", () => {
    const text = document.getElementById("offline-evidence").value.trim();
    if (text.length < 15) {
      alert("Write at least a brief summary to prove completion.");
      return;
    }
    task.done = true;
    task.verified = true;
    task.evidence = text;
    saveState();
    document.getElementById("verify-modal").classList.add("hidden");
    renderAll();
  });
}

// ================= COACH MULTI-THREAD CHAT =================
function getActiveThread() {
  let t = appState.threads.find((th) => th.id === appState.activeThreadId);
  if (!t) {
    t = appState.threads[0];
    appState.activeThreadId = t.id;
  }
  return t;
}

document.getElementById("thread-select").addEventListener("change", (e) => {
  appState.activeThreadId = e.target.value;
  saveState();
  renderCoach();
});

document.getElementById("new-thread-btn").addEventListener("click", () => {
  const title = prompt("Discussion title (e.g., Surgery Notes, German B1):");
  if (!title || !title.trim()) return;
  const id = "th-" + Date.now();
  appState.threads.unshift({ id, title: title.trim(), messages: [] });
  appState.activeThreadId = id;
  saveState();
  renderCoach();
});

document.getElementById("del-thread-btn").addEventListener("click", () => {
  if (appState.threads.length <= 1) return alert("Keep at least one chat thread.");
  appState.threads = appState.threads.filter((t) => t.id !== appState.activeThreadId);
  appState.activeThreadId = appState.threads[0].id;
  saveState();
  renderCoach();
});

document.getElementById("chat-file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) {
    alert("File too large. Please keep PDFs/images under 12 MB.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(",")[1];
    pendingAttachment = { name: file.name, mimeType: file.type || "application/pdf", base64 };
    document.getElementById("file-chip-name").textContent = "📎 " + file.name;
    document.getElementById("file-chip").classList.remove("hidden");
  };
  reader.readAsDataURL(file);
});

document.getElementById("clear-file-btn").addEventListener("click", () => {
  pendingAttachment = null;
  document.getElementById("chat-file-input").value = "";
  document.getElementById("file-chip").classList.add("hidden");
});

async function sendCoachMessage(overrideText = null) {
  const input = document.getElementById("chat-input");
  const text = (overrideText !== null ? overrideText : input.value).trim();
  if (!text && !pendingAttachment) return;

  const thread = getActiveThread();
  const userMsg = {
    role: "user",
    text: text || "Analyze this attached file and advise me.",
    attachmentName: pendingAttachment ? pendingAttachment.name : null
  };
  thread.messages.push(userMsg);

  const currentFile = pendingAttachment;
  pendingAttachment = null;
  input.value = "";
  document.getElementById("chat-file-input").value = "";
  document.getElementById("file-chip").classList.add("hidden");
  saveState();
  renderCoach();

  // Build Gemini contents from last 10 messages
  const history = thread.messages.slice(-10).map((m, idx, arr) => {
    const parts = [{ text: m.text }];
    if (idx === arr.length - 1 && currentFile) {
      parts.push({ inline_data: { mime_type: currentFile.mimeType, data: currentFile.base64 } });
    }
    return { role: m.role, parts };
  });

  const chatBox = document.getElementById("chat-messages");
  const thinkingEl = document.createElement("div");
  thinkingEl.className = "msg model";
  thinkingEl.textContent = "Thinking...";
  chatBox.appendChild(thinkingEl);
  chatBox.scrollTop = chatBox.scrollHeight;

  try {
    const reply = await callGemini(history);
    thread.messages.push({ role: "model", text: reply });
    saveState();
    renderCoach();
  } catch (err) {
    thinkingEl.textContent = "Error: " + err.message;
  }
}

document.getElementById("chat-send-btn").addEventListener("click", () => sendCoachMessage());
document.querySelectorAll("#coach-quick-actions .pill").forEach((pill) => {
  pill.addEventListener("click", () => sendCoachMessage(pill.dataset.prompt));
});

window.injectPlanFromChat = function (encodedJson, btnEl) {
  try {
    const items = JSON.parse(decodeURIComponent(encodedJson));
    let added = 0;
    let conflicts = 0;
    items.forEach((item, idx) => {
      if (findConflicts(item.date, item.startTime, item.duration).length > 0) conflicts++;
      appState.tasks.unshift({
        id: `${Date.now()}-${idx}`,
        title: item.title || "Planned Task",
        track: ["clinical", "german", "licensing", "general"].includes(item.track) ? item.track : "clinical",
        date: item.date || getTodayStr(),
        startTime: item.startTime || "",
        duration: Number(item.duration) || 30,
        done: false,
        verified: false,
        evidence: "",
        steps: (item.steps || []).map((s, sIdx) => ({
          id: `${Date.now()}-${idx}-${sIdx}`,
          text: s.text,
          mins: Number(s.mins) || 10,
          done: false
        }))
      });
      added++;
    });
    saveState();
    renderAll();
    btnEl.textContent = conflicts > 0 ? `Added ${added} (${conflicts} overlap!)` : `✓ Added ${added} to Plan`;
    btnEl.disabled = true;
  } catch (err) {
    alert("Could not parse plan block: " + err.message);
  }
};

// ================= DOCUMENT EXPIRY TRACKER =================
document.getElementById("add-doc-btn").addEventListener("click", () => {
  const name = document.getElementById("doc-name").value.trim();
  const issueDate = document.getElementById("doc-date").value;
  if (!name || !issueDate) return;
  appState.documents.push({ id: Date.now().toString(), name, issueDate });
  document.getElementById("doc-name").value = "";
  saveState();
  renderRoadmap();
});

window.deleteDoc = function (id) {
  appState.documents = appState.documents.filter((d) => d.id !== id);
  saveState();
  renderRoadmap();
};

// ================= PROFILE & API KEY =================
document.getElementById("save-profile-btn").addEventListener("click", () => {
  appState.profile.mbchbPhase = document.getElementById("profile-mbchb").value.trim() || DEFAULT_STATE.profile.mbchbPhase;
  appState.profile.germanLevel = document.getElementById("profile-german").value;
  saveState();
  document.getElementById("profile-status").textContent = "Profile saved. Coach is synced.";
});

document.getElementById("save-api-key-btn").addEventListener("click", () => {
  const key = document.getElementById("api-key-input").value.trim();
  localStorage.setItem(API_KEY_STORAGE, key);
  document.getElementById("api-key-status").textContent = key ? "API Key saved locally on device." : "API Key cleared.";
});

// ================= RENDERERS =================
function renderHeader() {
  const modeObj = MODES.find((m) => m.name === appState.mode) || MODES[0];
  const badge = document.getElementById("mode-badge");
  badge.textContent = modeObj.name;
  badge.className = `badge clickable ${modeObj.cls}`;
}

function renderBriefing() {
  const today = getTodayStr();
  document.getElementById("briefing-date").textContent = new Date().toDateString();

  const todayTasks = appState.tasks.filter((t) => t.date === today);
  const totalMins = todayTasks.reduce((sum, t) => {
    const stepMins = t.steps.reduce((s, st) => s + st.mins, 0);
    return sum + (stepMins > 0 ? stepMins : Number(t.duration || 30));
  }, 0);

  const modeObj = MODES.find((m) => m.name === appState.mode) || MODES[0];
  const hrs = (totalMins / 60).toFixed(1);
  const pct = Math.min(100, (totalMins / (modeObj.capHours * 60)) * 100);

  document.getElementById("load-text").textContent = `${hrs} / ${modeObj.capHours} hrs`;
  const bar = document.getElementById("load-bar");
  bar.style.width = `${pct}%`;
  bar.className = `progress-fill ${pct > 100 ? "over" : pct > 80 ? "warn" : ""}`;

  document.getElementById("pa-message").textContent =
    pct >= 100
      ? `Heads up: You've hit your ${modeObj.name} daily cap.`
      : `${appState.profile.germanLevel} German • ${todayTasks.length} item(s) scheduled today.`;

  // Important Events
  const eventsEl = document.getElementById("events-list");
  if (appState.events.length === 0) {
    eventsEl.innerHTML = `<p class="muted" style="margin:0;">No upcoming events. Tap + Event to add CATs, exams, or trips.</p>`;
  } else {
    const nowMs = new Date(today).getTime();
    eventsEl.innerHTML = appState.events
      .map((ev) => {
        const diffDays = Math.ceil((new Date(ev.date).getTime() - nowMs) / 86400000);
        const label = diffDays < 0 ? "Passed" : diffDays === 0 ? "Today!" : `${diffDays}d left`;
        return `
        <div class="event-item">
          <div style="flex:1;">
            <strong>${escapeHtml(ev.title)}</strong>
            <div class="muted" style="margin:0; font-size:0.75rem;">${ev.date}</div>
          </div>
          <span class="countdown-pill ${diffDays <= 7 ? "urgent" : ""}">${label}</span>
          <button class="btn-mini secondary" onclick="planEventWithCoach('${ev.id}')">💬 Plan</button>
          <button class="del-btn" onclick="deleteEvent('${ev.id}')">✕</button>
        </div>`;
      })
      .join("");
  }

  // Next Atomic Step
  let nextStep = null;
  let parentTitle = "";
  for (const t of appState.tasks) {
    const found = t.steps.find((s) => !s.done);
    if (found) {
      nextStep = found;
      parentTitle = t.title;
      break;
    }
  }
  const nextBox = document.getElementById("next-action-content");
  if (nextStep) {
    nextBox.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
        <div>
          <div style="color:var(--text); font-weight:600;">${escapeHtml(nextStep.text)}</div>
          <div class="muted" style="margin:0; font-size:0.78rem;">From: ${escapeHtml(parentTitle)} (${nextStep.mins}m)</div>
        </div>
        <button class="play-btn" onclick="runStepTimer('${escapeHtml(nextStep.text).replace(/'/g, "\\'")}', ${nextStep.mins})">▶ ${nextStep.mins}m</button>
      </div>`;
  } else {
    nextBox.textContent = "No pending atomic steps. Slice a topic in Plan!";
  }

  // Timeline
  const timelineEl = document.getElementById("today-timeline");
  const sorted = [...todayTasks].sort((a, b) => (a.startTime || "99:99").localeCompare(b.startTime || "99:99"));
  timelineEl.innerHTML =
    sorted.length === 0
      ? `<p class="muted" style="margin:0;">Nothing scheduled for today yet.</p>`
      : sorted
          .map(
            (t) => `
          <div class="timeline-item">
            <span class="time-tag">${t.startTime || "Anytime"}</span>
            <span style="flex:1; padding:0 8px; ${t.done ? "text-decoration:line-through;color:var(--muted)" : ""}">${escapeHtml(t.title)}</span>
            <span class="step-dur">${t.track}</span>
          </div>`
          )
          .join("");
}

function renderPlan() {
  const listEl = document.getElementById("task-list");
  const filtered = currentFilter === "all" ? appState.tasks : appState.tasks.filter((t) => t.track === currentFilter);

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="card muted">No tasks in this track yet. Tap "+ New Task" above.</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map((t) => {
      const isGeneral = t.track === "general";
      const stepsDone = t.steps.filter((s) => s.done).length;
      const stepsHtml = t.steps
        .map(
          (s) => `
        <div class="step-item">
          <div class="step-left">
            <input type="checkbox" ${s.done ? "checked" : ""} onchange="toggleStep('${t.id}', '${s.id}')" />
            <span class="step-text ${s.done ? "done" : ""}">${escapeHtml(s.text)}</span>
          </div>
          <span class="step-dur">${s.mins}m</span>
          <button class="play-btn" onclick="runStepTimer('${escapeHtml(s.text).replace(/'/g, "\\'")}', ${s.mins})">▶</button>
        </div>`
        )
        .join("");

      return `
      <div class="task-card track-${t.track}">
        <div class="task-header">
          <div style="display:flex; align-items:center; gap:8px;">
            ${isGeneral ? `<input type="checkbox" style="width:18px;height:18px;margin:0;" ${t.done ? "checked" : ""} onchange="toggleGeneralTask('${t.id}')" />` : ""}
            <div>
              <div class="task-title ${t.done ? "done" : ""}">${escapeHtml(t.title)}</div>
              <div class="task-meta">
                <span>${t.track.toUpperCase()}</span>
                ${t.date ? `<span>📅 ${t.date}</span>` : ""}
                ${t.startTime ? `<span>⏰ ${t.startTime} (${t.duration}m)</span>` : ""}
                ${!isGeneral ? `<span>🧩 ${stepsDone}/${t.steps.length}</span>` : ""}
                ${t.verified ? `<span class="verified-tag">✓ VERIFIED</span>` : ""}
              </div>
            </div>
          </div>
          <button class="del-btn" onclick="deleteTask('${t.id}')">✕</button>
        </div>

        ${
          !isGeneral
            ? `<div class="task-actions-row">
                <button class="ai-btn" id="slice-btn-${t.id}" onclick="autoSliceTask('${t.id}')">✨ Auto-Slice</button>
                ${!t.verified ? `<button class="verify-btn" onclick="openVerifyGate('${t.id}')">✓ Verify & Complete</button>` : ""}
              </div>
              <div class="steps-list">
                ${stepsHtml}
                <div class="add-step-row">
                  <input type="text" id="step-input-${t.id}" placeholder="Add 5–15m atomic step..." />
                  <select id="step-dur-${t.id}">
                    <option value="5">5m</option>
                    <option value="10" selected>10m</option>
                    <option value="15">15m</option>
                  </select>
                  <button onclick="addAtomicStep('${t.id}')">+</button>
                </div>
              </div>`
            : ""
        }
      </div>`;
    })
    .join("");
}

function renderCoach() {
  const select = document.getElementById("thread-select");
  select.innerHTML = appState.threads
    .map((th) => `<option value="${th.id}" ${th.id === appState.activeThreadId ? "selected" : ""}>${escapeHtml(th.title)}</option>`)
    .join("");

  const thread = getActiveThread();
  const chatBox = document.getElementById("chat-messages");
  chatBox.innerHTML = thread.messages
    .map((m) => {
      let displayText = m.text;
      let planBtnHtml = "";

      const planMatch = m.text.match(/```plan\s*([\s\S]*?)```/);
      if (planMatch) {
        displayText = m.text.replace(planMatch[0], "").trim();
        const encoded = encodeURIComponent(planMatch[1].trim());
        planBtnHtml = `
          <div class="plan-inject-box">
            <div style="font-size:0.78rem; color:var(--clinical); font-weight:600;">📋 Structured Plan Ready</div>
            <button class="btn success" onclick="injectPlanFromChat('${encoded}', this)">➕ Add Plan to Schedule</button>
          </div>`;
      }

      return `
      <div class="msg ${m.role}">
        ${m.attachmentName ? `<div class="msg-attach">📎 ${escapeHtml(m.attachmentName)}</div>` : ""}
        <div>${escapeHtml(displayText)}</div>
        ${planBtnHtml}
      </div>`;
    })
    .join("");
  chatBox.scrollTop = chatBox.scrollHeight;
}

function renderRoadmap() {
  const counts = { clinical: 0, german: 0, licensing: 0, general: 0 };
  appState.tasks.forEach((t) => {
    if (counts[t.track] !== undefined) counts[t.track]++;
  });
  document.getElementById("roadmap-stats").innerHTML = Object.entries(counts)
    .map(([k, v]) => `<div class="stat-box"><span class="muted" style="text-transform:capitalize;">${k}</span><strong>${v} tasks</strong></div>`)
    .join("");

  const docList = document.getElementById("doc-list");
  if (appState.documents.length === 0) {
    docList.innerHTML = `<p class="muted" style="margin:0;">No documents tracked yet.</p>`;
  } else {
    const nowMs = new Date(getTodayStr()).getTime();
    docList.innerHTML = appState.documents
      .map((d) => {
        const ageDays = Math.floor((nowMs - new Date(d.issueDate).getTime()) / 86400000);
        const left = 90 - ageDays;
        return `
        <div class="doc-item">
          <div>
            <strong>${escapeHtml(d.name)}</strong>
            <div class="muted" style="margin:0; font-size:0.75rem;">Issued: ${d.issueDate}</div>
          </div>
          <span class="countdown-pill ${left <= 15 ? "urgent" : ""}">${left > 0 ? left + "d valid" : "EXPIRED"}</span>
          <button class="del-btn" onclick="deleteDoc('${d.id}')">✕</button>
        </div>`;
      })
      .join("");
  }
}

function renderVault() {
  document.getElementById("schema-ver").textContent = "v" + appState.schemaVersion;
  document.getElementById("profile-mbchb").value = appState.profile.mbchbPhase;
  document.getElementById("profile-german").value = appState.profile.germanLevel;
  const key = getApiKey();
  document.getElementById("api-key-input").value = key;
  document.getElementById("api-key-status").textContent = key ? "API Key active (local only)." : "No API Key set yet.";
}

function renderAll() {
  renderHeader();
  renderBriefing();
  renderPlan();
  renderCoach();
  renderRoadmap();
  renderVault();
}

// ================= NAVIGATION & VAULT IO =================
function switchTab(targetId) {
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.target === targetId));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === targetId));
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.target));
});

document.querySelectorAll("#track-filters .pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll("#track-filters .pill").forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");
    currentFilter = pill.dataset.track;
    renderPlan();
  });
});

document.getElementById("export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(appState, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `medpath-vault-${getTodayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById("vault-status").textContent = "Vault exported (API key excluded for security).";
});

document.getElementById("import-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const imported = JSON.parse(event.target.result);
      if (!imported.schemaVersion) throw new Error("Invalid vault file");
      appState = { ...JSON.parse(JSON.stringify(DEFAULT_STATE)), ...imported, schemaVersion: 3 };
      saveState();
      renderAll();
      document.getElementById("vault-status").textContent = "Vault restored successfully!";
    } catch (err) {
      document.getElementById("vault-status").textContent = "Error: Invalid JSON vault file.";
    }
  };
  reader.readAsText(file);
});

renderAll();
