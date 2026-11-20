const STORAGE_KEY = "medpath_de_vault";

const DEFAULT_STATE = {
  schemaVersion: 1,
  mode: "Holiday Sprint",
  testNote: "",
  tracks: {
    clinical: [],
    german: [],
    licensing: [],
    general: []
  },
  lastUpdated: new Date().toISOString()
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch (e) {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let appState = loadState();

// Render UI
function render() {
  document.getElementById("briefing-date").textContent = new Date().toDateString();
  document.getElementById("mode-badge").textContent = appState.mode;
  document.getElementById("schema-ver").textContent = "v" + appState.schemaVersion;
  document.getElementById("saved-note-display").textContent = appState.testNote
    ? "Saved in Vault: " + appState.testNote
    : "No test note saved yet.";
}

// Navigation
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.target).classList.add("active");
  });
});

// Smoke Test Note
document.getElementById("save-note-btn").addEventListener("click", () => {
  const input = document.getElementById("test-note-input");
  if (!input.value.trim()) return;
  appState.testNote = input.value.trim();
  saveState(appState);
  input.value = "";
  render();
});

// Export Vault JSON
document.getElementById("export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(appState, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `medpath-vault-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById("vault-status").textContent = "Vault exported successfully.";
});

// Import Vault JSON
document.getElementById("import-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const imported = JSON.parse(event.target.result);
      if (!imported.schemaVersion) throw new Error("Invalid vault file");
      appState = { ...DEFAULT_STATE, ...imported };
      saveState(appState);
      render();
      document.getElementById("vault-status").textContent = "Vault restored successfully!";
    } catch (err) {
      document.getElementById("vault-status").textContent = "Error: Invalid JSON vault file.";
    }
  };
  reader.readAsText(file);
});

render();
