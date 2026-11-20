const STORAGE_KEY = "medpath_de_vault";

const MODES = [
  { name: "Holiday Sprint", capHours: 8, cls: "" },
  { name: "Standard Rotation", capHours: 5, cls: "rotation" },
  { name: "Survival Mode", capHours: 2.5, cls: "survival" }
];

const DEFAULT_STATE = {
  schemaVersion: 2,
  mode: "Holiday Sprint",
  tasks: [],
  lastUpdated: new Date().toISOString()
};

function getTodayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    // Safe migration from v1 to v2
    if (!parsed.tasks) parsed.tasks = [];
    parsed.schemaVersion = 2;
    return { ...DEFAULT_STATE, ...parsed };
  } catch (e) {
    return { ...DEFAULT_STATE };
  }
}

function saveState() {
  appState.lastUpdated = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

let appState = loadState();
let currentFilter = "all";
let pendingOverride = false;

// --- Conflict Detection ---
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

// --- Micro-Timer ---
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
      playBeep();
      document.getElementById("timer-display").textContent = "DONE!";
    }
  }, 1000);
}

function updateTimerDisplay() {
  const m = String(Math.floor(timerSeconds / 60)).padStart(2, "0");
  const s = String(timerSeconds % 60).padStart(2, "0");
  document.getElementById("timer-display").textContent = `${m}:${s}`;
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (e) {}
}

document.getElementById("timer-toggle").addEventListener("click", () => {
  timerPaused = !timerPaused;
  document.getElementById("timer-toggle").textContent = timerPaused ? "Resume" : "Pause";
});

document.getElementById("timer-stop").addEventListener("click", () => {
  clearInterval(timerInterval);
  document.getElementById("timer-bar").classList.add("hidden");
});

// --- Mode Switcher ---
document.getElementById("mode-badge").addEventListener("click", () => {
  const idx = MODES.findIndex((m) => m.name === appState.mode);
  const next = MODES[(idx + 1) % MODES.length];
  appState.mode = next.name;
  saveState();
  renderAll();
});

// --- Add Task & Conflict Guard ---
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
    conflictEl.innerHTML = `<strong>Schedule Conflict:</strong> Overlaps with "${conflicts[0].title}" at ${conflicts[0].startTime}. Tap <strong>Save Task</strong> again to override.`;
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

// --- Task & Atomic Step Actions ---
window.addAtomicStep = function (taskId) {
  const textInput = document.getElementById(`step-input-${taskId}`);
  const durSelect = document.getElementById(`step-dur-${taskId}`);
  const text = textInput.value.trim();
  if (!text) return;

  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task) return;

  task.steps.push({
    id: Date.now().toString(),
    text,
    mins: Number(durSelect.value),
    done: false
  });
  saveState();
  renderAll();
};

window.toggleStep = function (taskId, stepId) {
  const task = appState.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const step = task.steps.find((s) => s.id === stepId);
  if (step) step.done = !step.done;
  if (task.steps.length > 0) {
    task.done = task.steps.every((s) => s.done);
  }
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

// --- Renderers ---
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
      ? `Heads up: You've hit your ${modeObj.name} daily cap. Avoid adding more blocks today.`
      : `You have ${todayTasks.length} item(s) scheduled today. Tap any 5–15 min step to start.`;

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
          <div style="color:var(--text); font-weight:600;">${nextStep.text}</div>
          <div class="muted" style="margin:0; font-size:0.78rem;">From: ${parentTitle} (${nextStep.mins}m)</div>
        </div>
        <button class="play-btn" onclick="runStepTimer('${nextStep.text.replace(/'/g, "\\'")}', ${nextStep.mins})">▶ ${nextStep.mins}m</button>
      </div>`;
  } else {
    nextBox.textContent = "No pending atomic steps. Slice a topic in the Plan tab!";
  }

  // Timeline
  const timelineEl = document.getElementById("today-timeline");
  const sorted = [...todayTasks].sort((a, b) => (a.startTime || "99:99").localeCompare(b.startTime || "99:99"));
  if (sorted.length === 0) {
    timelineEl.innerHTML = `<p class="muted" style="margin:0;">Nothing scheduled for today yet.</p>`;
  } else {
    timelineEl.innerHTML = sorted
      .map(
        (t) => `
      <div class="timeline-item">
        <span class="time-tag">${t.startTime || "Anytime"}</span>
        <span style="flex:1; padding:0 8px; ${t.done ? "text-decoration:line-through;color:var(--muted)" : ""}">${t.title}</span>
        <span class="step-dur">${t.track}</span>
      </div>`
      )
      .join("");
  }
}

function renderPlan() {
  const listEl = document.getElementById("task-list");
  const filtered =
    currentFilter === "all"
      ? appState.tasks
      : appState.tasks.filter((t) => t.track === currentFilter);

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
            <span class="step-text ${s.done ? "done" : ""}">${s.text}</span>
          </div>
          <span class="step-dur">${s.mins}m</span>
          <button class="play-btn" onclick="runStepTimer('${s.text.replace(/'/g, "\\'")}', ${s.mins})">▶</button>
        </div>`
        )
        .join("");

      return `
      <div class="task-card track-${t.track}">
        <div class="task-header">
          <div style="display:flex; align-items:center; gap:8px;">
            ${isGeneral ? `<input type="checkbox" style="width:18px;height:18px;margin:0;" ${t.done ? "checked" : ""} onchange="toggleGeneralTask('${t.id}')" />` : ""}
            <div>
              <div class="task-title ${t.done ? "done" : ""}">${t.title}</div>
              <div class="task-meta">
                <span>${t.track.toUpperCase()}</span>
                ${t.date ? `<span>📅 ${t.date}</span>` : ""}
                ${t.startTime ? `<span>⏰ ${t.startTime} (${t.duration}m)</span>` : ""}
                ${!isGeneral ? `<span>🧩 ${stepsDone}/${t.steps.length} steps</span>` : ""}
              </div>
            </div>
          </div>
          <button class="del-btn" onclick="deleteTask('${t.id}')">✕</button>
        </div>

        ${
          !isGeneral
            ? `<div class="steps-list">
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

function renderRoadmap() {
  const counts = { clinical: 0, german: 0, licensing: 0, general: 0 };
  appState.tasks.forEach((t) => {
    if (counts[t.track] !== undefined) counts[t.track]++;
  });
  document.getElementById("roadmap-stats").innerHTML = Object.entries(counts)
    .map(
      ([k, v]) => `
    <div class="stat-box">
      <span class="muted" style="text-transform:capitalize;">${k}</span>
      <strong>${v} tasks</strong>
    </div>`
    )
    .join("");
}

function renderAll() {
  renderHeader();
  renderBriefing();
  renderPlan();
  renderRoadmap();
  document.getElementById("schema-ver").textContent = "v" + appState.schemaVersion;
}

// --- Navigation & Filters ---
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.target).classList.add("active");
  });
});

document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");
    currentFilter = pill.dataset.track;
    renderPlan();
  });
});

// --- Vault Export / Import ---
document.getElementById("export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(appState, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `medpath-vault-${getTodayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById("vault-status").textContent = "Vault exported successfully.";
});

document.getElementById("import-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const imported = JSON.parse(event.target.result);
      if (!imported.schemaVersion) throw new Error("Invalid vault file");
      appState = { ...DEFAULT_STATE, ...imported, schemaVersion: 2 };
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
