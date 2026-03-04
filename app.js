(function() {
  "use strict";

  // ── GitHub Settings ──
  const SETTINGS_KEY = "clanton_gantt_settings";
  let ghSettings = loadGHSettings();
  let currentSHA = null;
  let pollTimer = null;
  let isSaving = false;
  const expandedWeeks = new Set();
  const expandedResources = new Set(); // track which project rows show resources in day view
  let draggedTaskId = null;
  let isDragging = false;

  function loadGHSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return JSON.parse(raw);
    } catch(e) {}
    return { owner: '', repo: '', branch: 'main', token: '' };
  }

  function saveGHSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(ghSettings));
  }

  function isGHConfigured() {
    return !!(ghSettings.owner && ghSettings.repo && ghSettings.token);
  }

  // ── Sync Indicator ──
  const syncIndicator = document.getElementById("syncIndicator");
  const syncDot = document.getElementById("syncDot");
  const syncLabel = document.getElementById("syncLabel");

  function setSyncStatus(status, msg) {
    syncIndicator.style.display = isGHConfigured() ? '' : 'none';
    syncDot.className = 'sync-dot ' + status;
    syncLabel.textContent = msg || status;
  }

  // ── GitHub API ──
  function ghApiUrl(path) {
    return `https://api.github.com/repos/${ghSettings.owner}/${ghSettings.repo}/contents/${path}?ref=${ghSettings.branch}`;
  }

  function ghHeaders() {
    const h = {
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };
    if (ghSettings.token) h['Authorization'] = 'Bearer ' + ghSettings.token;
    return h;
  }

  async function loadFromGitHub() {
    if (!isGHConfigured()) return null;
    setSyncStatus('saving', 'Loading...');
    try {
      const resp = await fetch(ghApiUrl('data.json'), { headers: ghHeaders() });
      if (resp.status === 404) {
        setSyncStatus('synced', 'Synced (no data.json yet)');
        currentSHA = null;
        return null;
      }
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${resp.status}`);
      }
      const json = await resp.json();
      currentSHA = json.sha;
      const content = atob(json.content.replace(/\n/g, ''));
      const data = JSON.parse(content);
      setSyncStatus('synced', 'Synced');
      return data;
    } catch(e) {
      console.error('GitHub load error:', e);
      setSyncStatus('error', 'Load error');
      return null;
    }
  }

  async function saveToGitHub(data) {
    if (!isGHConfigured() || isSaving) return false;
    isSaving = true;
    setSyncStatus('saving', 'Saving...');
    try {
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
      const body = {
        message: 'Update data.json via Clanton Gantt Board',
        content: content,
        branch: ghSettings.branch
      };
      if (currentSHA) body.sha = currentSHA;

      const resp = await fetch(ghApiUrl('data.json'), {
        method: 'PUT',
        headers: ghHeaders(),
        body: JSON.stringify(body)
      });

      if (resp.status === 409) {
        setSyncStatus('error', 'Conflict');
        isSaving = false;
        if (confirm('Data was updated by someone else. Reload latest data?')) {
          await loadAndApplyFromGitHub();
        }
        return false;
      }

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${resp.status}`);
      }

      const json = await resp.json();
      currentSHA = json.content.sha;
      setSyncStatus('synced', 'Synced');
      isSaving = false;
      return true;
    } catch(e) {
      console.error('GitHub save error:', e);
      setSyncStatus('error', 'Save error');
      isSaving = false;
      return false;
    }
  }

  async function checkForUpdates() {
    if (!isGHConfigured() || isSaving) return;
    try {
      const resp = await fetch(ghApiUrl('data.json'), { headers: ghHeaders() });
      if (!resp.ok) return;
      const json = await resp.json();
      if (json.sha && json.sha !== currentSHA) {
        const content = atob(json.content.replace(/\n/g, ''));
        const data = JSON.parse(content);
        currentSHA = json.sha;
        state = data;
        migrateState();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        setSyncStatus('synced', 'Synced');
        render();
      }
    } catch(e) {
      // Silently fail on poll
    }
  }

  function startPolling() {
    stopPolling();
    if (isGHConfigured()) {
      pollTimer = setInterval(checkForUpdates, 30000);
    }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function loadAndApplyFromGitHub() {
    const data = await loadFromGitHub();
    if (data && data.projects && data.tasks) {
      state = data;
      migrateState();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      render();
    }
  }

  // ── Settings Modal ──
  const settingsModal = document.getElementById("settingsModal");
  document.getElementById("btnSettings").addEventListener('click', () => {
    document.getElementById("ghOwner").value = ghSettings.owner;
    document.getElementById("ghRepo").value = ghSettings.repo;
    document.getElementById("ghBranch").value = ghSettings.branch || 'main';
    document.getElementById("ghToken").value = ghSettings.token;
    document.getElementById("connResult").className = 'conn-result';
    document.getElementById("connResult").textContent = '';
    settingsModal.classList.add("active");
  });

  document.getElementById("settingsCancel").addEventListener('click', () => {
    settingsModal.classList.remove("active");
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) settingsModal.classList.remove("active");
  });

  document.getElementById("settingsSave").addEventListener('click', async () => {
    ghSettings.owner = document.getElementById("ghOwner").value.trim();
    ghSettings.repo = document.getElementById("ghRepo").value.trim();
    ghSettings.branch = document.getElementById("ghBranch").value.trim() || 'main';
    ghSettings.token = document.getElementById("ghToken").value.trim();
    saveGHSettings();
    settingsModal.classList.remove("active");

    if (isGHConfigured()) {
      setSyncStatus('saving', 'Connecting...');
      await loadAndApplyFromGitHub();
      startPolling();
    } else {
      setSyncStatus('offline', 'Not configured');
      stopPolling();
    }
  });

  document.getElementById("settingsDisconnect").addEventListener('click', () => {
    if (confirm('Disconnect from GitHub? Local data will be kept.')) {
      ghSettings = { owner: '', repo: '', branch: 'main', token: '' };
      saveGHSettings();
      currentSHA = null;
      stopPolling();
      syncIndicator.style.display = 'none';
      settingsModal.classList.remove("active");
    }
  });

  document.getElementById("btnTestConn").addEventListener('click', async () => {
    const owner = document.getElementById("ghOwner").value.trim();
    const repo = document.getElementById("ghRepo").value.trim();
    const token = document.getElementById("ghToken").value.trim();
    const resultEl = document.getElementById("connResult");

    if (!owner || !repo || !token) {
      resultEl.className = 'conn-result fail';
      resultEl.textContent = 'Owner, repo, and token are required.';
      return;
    }

    resultEl.className = 'conn-result';
    resultEl.style.display = 'block';
    resultEl.textContent = 'Testing...';

    try {
      const resp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}`,
        { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github.v3+json' } }
      );
      if (resp.ok) {
        const data = await resp.json();
        resultEl.className = 'conn-result success';
        resultEl.textContent = `Connected to ${data.full_name} (${data.private ? 'private' : 'public'})`;
      } else {
        const err = await resp.json().catch(() => ({}));
        resultEl.className = 'conn-result fail';
        resultEl.textContent = `Failed: ${err.message || 'HTTP ' + resp.status}`;
      }
    } catch(e) {
      resultEl.className = 'conn-result fail';
      resultEl.textContent = 'Network error: ' + e.message;
    }
  });

  // ── State ──
  const STORAGE_KEY = "clanton_gantt_data";
  let state = loadState();

  // ── Data Migration ──
  function migrateState() {
    if (!state.nextId) state.nextId = 1;
    state.tasks.forEach(t => {
      if (!t.dependencies) t.dependencies = [];
      if (!t.subtasks) t.subtasks = [];
    });
  }

  function defaultState() {
    function w(n) {
      const base = new Date(2026, 2, 2);
      base.setDate(base.getDate() + (n - 1) * 7);
      const y = base.getFullYear();
      const m = String(base.getMonth()+1).padStart(2,'0');
      const d = String(base.getDate()).padStart(2,'0');
      return y+'-'+m+'-'+d;
    }
    function wf(n) {
      const base = new Date(2026, 2, 6);
      base.setDate(base.getDate() + (n - 1) * 7);
      const y = base.getFullYear();
      const m = String(base.getMonth()+1).padStart(2,'0');
      const d = String(base.getDate()).padStart(2,'0');
      return y+'-'+m+'-'+d;
    }

    return {
      projects: [
        { id: 1, name: "South Salt Lake", teamMembers: ["JS", "SS", "KP", "AC"], order: 0 },
        { id: 2, name: "SLC", teamMembers: ["DS", "SS", "KM", "AC"], order: 1 },
        { id: 3, name: "Norfolk", teamMembers: ["JS", "CE", "SS", "HJ", "DiCRU", "SKM"], order: 2 },
        { id: 4, name: "Alhambra", teamMembers: ["KP", "DSC", "SS"], order: 3 },
        { id: 5, name: "Casper", teamMembers: ["KP", "KM"], order: 4 },
        { id: 6, name: "Albuquerque", teamMembers: ["KP"], order: 5 },
        { id: 7, name: "Estes Park", teamMembers: ["JS", "KM", "EM"], order: 6 },
        { id: 8, name: "Austin", teamMembers: ["AC", "KM", "SS", "KP"], order: 7 },
        { id: 9, name: "UFC", teamMembers: ["AC", "HJ"], order: 8 },
        { id: 10, name: "Santa Ana", teamMembers: ["AC", "KM"], order: 9 },
        { id: 11, name: "Stockton", teamMembers: [], order: 10 },
      ],
      tasks: [
        { id: 101, projectId: 1, title: "Field Data Collection", type: "draft-sr", startDate: w(1), endDate: wf(1), status: "none", dependencies: [], subtasks: [] },
        { id: 102, projectId: 1, title: "Draft SR", type: "draft-sr", startDate: w(2), endDate: wf(3), status: "none", dependencies: [], subtasks: [] },
        { id: 103, projectId: 1, title: "QC Review", type: "qc", startDate: w(4), endDate: wf(4), status: "none", dependencies: [], subtasks: [] },
        { id: 104, projectId: 1, title: "QC Due", type: "qc-due", startDate: w(5), endDate: wf(5), status: "none", dependencies: [], subtasks: [] },
        { id: 105, projectId: 1, title: "Revisions", type: "deliverable", startDate: w(6), endDate: wf(6), status: "none", dependencies: [], subtasks: [] },
        { id: 106, projectId: 1, title: "Client Review", type: "deliverable", startDate: w(7), endDate: wf(7), status: "none", dependencies: [], subtasks: [] },
        { id: 107, projectId: 1, title: "Final Deliverable", type: "deliverable", startDate: w(9), endDate: wf(9), status: "on-track", dependencies: [], subtasks: [] },
        { id: 108, projectId: 1, title: "Meeting", type: "meeting", startDate: w(1), endDate: wf(1), status: "none", dependencies: [], subtasks: [] },
        { id: 109, projectId: 1, title: "Deliverable Due", type: "deliverable", startDate: w(11), endDate: wf(11), status: "none", dependencies: [], subtasks: [] },
        { id: 110, projectId: 1, title: "Draft SR Update", type: "draft-sr", startDate: w(13), endDate: wf(14), status: "none", dependencies: [], subtasks: [] },
        { id: 111, projectId: 1, title: "QC", type: "qc", startDate: w(15), endDate: wf(15), status: "none", dependencies: [], subtasks: [] },
        { id: 112, projectId: 1, title: "QC Due", type: "qc-due", startDate: w(16), endDate: wf(16), status: "none", dependencies: [], subtasks: [] },
        { id: 113, projectId: 1, title: "Final Report", type: "deliverable", startDate: w(18), endDate: wf(18), status: "none", dependencies: [], subtasks: [] },
        { id: 114, projectId: 1, title: "Draft SR", type: "draft-sr", startDate: w(20), endDate: wf(21), status: "none", dependencies: [], subtasks: [] },
        { id: 115, projectId: 1, title: "QC Due", type: "qc-due", startDate: w(22), endDate: wf(22), status: "none", dependencies: [], subtasks: [] },

        { id: 201, projectId: 2, title: "Draft SR", type: "draft-sr", startDate: w(3), endDate: wf(4), status: "none", dependencies: [], subtasks: [] },
        { id: 202, projectId: 2, title: "QC Review", type: "qc", startDate: w(5), endDate: wf(5), status: "none", dependencies: [], subtasks: [] },
        { id: 203, projectId: 2, title: "QC Due", type: "qc-due", startDate: w(6), endDate: wf(6), status: "none", dependencies: [], subtasks: [] },
        { id: 204, projectId: 2, title: "Revisions", type: "deliverable", startDate: w(7), endDate: wf(7), status: "on-track", dependencies: [], subtasks: [] },
        { id: 205, projectId: 2, title: "Deliverable", type: "deliverable", startDate: w(8), endDate: wf(8), status: "none", dependencies: [], subtasks: [] },
        { id: 206, projectId: 2, title: "Client Meeting", type: "meeting", startDate: w(9), endDate: wf(9), status: "none", dependencies: [], subtasks: [] },

        { id: 301, projectId: 3, title: "Stakeholder Mtg", type: "meeting", startDate: w(2), endDate: wf(2), status: "none", dependencies: [], subtasks: [] },
        { id: 302, projectId: 3, title: "Field Work", type: "deliverable", startDate: w(4), endDate: wf(4), status: "none", dependencies: [], subtasks: [] },
        { id: 303, projectId: 3, title: "Draft SR", type: "draft-sr", startDate: w(5), endDate: wf(6), status: "none", dependencies: [], subtasks: [] },
        { id: 304, projectId: 3, title: "Internal Review", type: "deliverable", startDate: w(7), endDate: wf(7), status: "none", dependencies: [], subtasks: [] },
        { id: 305, projectId: 3, title: "QC Review", type: "qc", startDate: w(8), endDate: wf(8), status: "none", dependencies: [], subtasks: [] },
        { id: 306, projectId: 3, title: "QC Due", type: "qc-due", startDate: w(9), endDate: wf(9), status: "none", dependencies: [], subtasks: [] },
        { id: 307, projectId: 3, title: "Deliverable", type: "deliverable", startDate: w(10), endDate: wf(10), status: "on-track", dependencies: [], subtasks: [] },
        { id: 308, projectId: 3, title: "Final Report", type: "deliverable", startDate: w(12), endDate: wf(12), status: "none", dependencies: [], subtasks: [] },

        { id: 401, projectId: 4, title: "Mtg w/ Client", type: "meeting", startDate: w(2), endDate: wf(2), status: "none", dependencies: [], subtasks: [] },
        { id: 402, projectId: 4, title: "Data Collection", type: "deliverable", startDate: w(4), endDate: wf(5), status: "on-track", dependencies: [], subtasks: [] },
        { id: 403, projectId: 4, title: "Draft SR", type: "draft-sr", startDate: w(6), endDate: wf(7), status: "none", dependencies: [], subtasks: [] },
        { id: 404, projectId: 4, title: "QC", type: "qc", startDate: w(8), endDate: wf(8), status: "none", dependencies: [], subtasks: [] },
        { id: 405, projectId: 4, title: "QC Due", type: "qc-due", startDate: w(9), endDate: wf(9), status: "none", dependencies: [], subtasks: [] },
        { id: 406, projectId: 4, title: "Deliverable", type: "deliverable", startDate: w(11), endDate: wf(11), status: "none", dependencies: [], subtasks: [] },

        { id: 501, projectId: 5, title: "Kickoff Meeting", type: "meeting", startDate: w(3), endDate: wf(3), status: "none", dependencies: [], subtasks: [] },
        { id: 502, projectId: 5, title: "Field Survey", type: "deliverable", startDate: w(4), endDate: wf(4), status: "on-track", dependencies: [], subtasks: [] },
        { id: 503, projectId: 5, title: "Draft SR", type: "draft-sr", startDate: w(6), endDate: wf(7), status: "none", dependencies: [], subtasks: [] },
        { id: 504, projectId: 5, title: "QC Review", type: "qc", startDate: w(8), endDate: wf(8), status: "none", dependencies: [], subtasks: [] },
        { id: 505, projectId: 5, title: "Revisions", type: "deliverable", startDate: w(9), endDate: wf(9), status: "none", dependencies: [], subtasks: [] },
        { id: 506, projectId: 5, title: "QC Due", type: "qc-due", startDate: w(10), endDate: wf(10), status: "none", dependencies: [], subtasks: [] },
        { id: 507, projectId: 5, title: "Client Review", type: "deliverable", startDate: w(11), endDate: wf(11), status: "none", dependencies: [], subtasks: [] },
        { id: 508, projectId: 5, title: "Final Plan", type: "deliverable", startDate: w(13), endDate: wf(13), status: "none", dependencies: [], subtasks: [] },
        { id: 509, projectId: 5, title: "Draft SR Ph2", type: "draft-sr", startDate: w(15), endDate: wf(15), status: "none", dependencies: [], subtasks: [] },
        { id: 510, projectId: 5, title: "QC", type: "qc", startDate: w(16), endDate: wf(16), status: "none", dependencies: [], subtasks: [] },
        { id: 511, projectId: 5, title: "Deliverable", type: "deliverable", startDate: w(17), endDate: wf(17), status: "none", dependencies: [], subtasks: [] },
        { id: 512, projectId: 5, title: "Long Range Plans", type: "qc-due", startDate: w(19), endDate: wf(19), status: "none", dependencies: [], subtasks: [] },

        { id: 601, projectId: 6, title: "Site Analysis", type: "deliverable", startDate: w(7), endDate: wf(7), status: "on-track", dependencies: [], subtasks: [] },
        { id: 602, projectId: 6, title: "Draft SR", type: "draft-sr", startDate: w(8), endDate: wf(9), status: "none", dependencies: [], subtasks: [] },
        { id: 603, projectId: 6, title: "QC", type: "qc", startDate: w(10), endDate: wf(10), status: "none", dependencies: [], subtasks: [] },
        { id: 604, projectId: 6, title: "Deliverable", type: "deliverable", startDate: w(11), endDate: wf(11), status: "none", dependencies: [], subtasks: [] },
        { id: 605, projectId: 6, title: "Transmittal", type: "deliverable", startDate: w(13), endDate: wf(13), status: "none", dependencies: [], subtasks: [] },

        { id: 701, projectId: 7, title: "Estes Bluff", type: "qc-due", startDate: w(2), endDate: wf(2), status: "at-risk", dependencies: [], subtasks: [] },
        { id: 702, projectId: 7, title: "Field Data", type: "deliverable", startDate: w(3), endDate: wf(3), status: "none", dependencies: [], subtasks: [] },

        { id: 801, projectId: 8, title: "Meeting", type: "meeting", startDate: w(2), endDate: wf(2), status: "none", dependencies: [], subtasks: [] },
        { id: 802, projectId: 8, title: "Draft SR", type: "draft-sr", startDate: w(3), endDate: wf(3), status: "none", dependencies: [], subtasks: [] },
        { id: 803, projectId: 8, title: "Field Survey", type: "deliverable", startDate: w(4), endDate: wf(4), status: "on-track", dependencies: [], subtasks: [] },
        { id: 804, projectId: 8, title: "Data Processing", type: "deliverable", startDate: w(5), endDate: wf(5), status: "on-track", dependencies: [], subtasks: [] },
        { id: 805, projectId: 8, title: "QC Review", type: "qc", startDate: w(6), endDate: wf(6), status: "none", dependencies: [], subtasks: [] },
        { id: 806, projectId: 8, title: "Draft Report", type: "deliverable", startDate: w(7), endDate: wf(7), status: "on-track", dependencies: [], subtasks: [] },
        { id: 807, projectId: 8, title: "Revisions", type: "deliverable", startDate: w(8), endDate: wf(8), status: "none", dependencies: [], subtasks: [] },
        { id: 808, projectId: 8, title: "QC Due", type: "qc-due", startDate: w(9), endDate: wf(9), status: "none", dependencies: [], subtasks: [] },
        { id: 809, projectId: 8, title: "Client Review", type: "deliverable", startDate: w(10), endDate: wf(10), status: "on-track", dependencies: [], subtasks: [] },
        { id: 810, projectId: 8, title: "Transmittal", type: "deliverable", startDate: w(11), endDate: wf(11), status: "none", dependencies: [], subtasks: [] },
        { id: 811, projectId: 8, title: "Final Report", type: "deliverable", startDate: w(13), endDate: wf(13), status: "none", dependencies: [], subtasks: [] },
        { id: 812, projectId: 8, title: "Ph2 Draft SR", type: "draft-sr", startDate: w(15), endDate: wf(16), status: "none", dependencies: [], subtasks: [] },
        { id: 813, projectId: 8, title: "QC", type: "qc", startDate: w(17), endDate: wf(17), status: "none", dependencies: [], subtasks: [] },
        { id: 814, projectId: 8, title: "QC Due", type: "qc-due", startDate: w(18), endDate: wf(18), status: "none", dependencies: [], subtasks: [] },

        { id: 901, projectId: 9, title: "Scope Review", type: "deliverable", startDate: w(10), endDate: wf(10), status: "none", dependencies: [], subtasks: [] },
        { id: 902, projectId: 9, title: "Draft SR", type: "draft-sr", startDate: w(12), endDate: wf(13), status: "none", dependencies: [], subtasks: [] },
        { id: 903, projectId: 9, title: "QC", type: "qc", startDate: w(14), endDate: wf(14), status: "none", dependencies: [], subtasks: [] },
        { id: 904, projectId: 9, title: "QC Due", type: "qc-due", startDate: w(15), endDate: wf(15), status: "none", dependencies: [], subtasks: [] },
        { id: 905, projectId: 9, title: "Deliverable", type: "deliverable", startDate: w(16), endDate: wf(16), status: "none", dependencies: [], subtasks: [] },
        { id: 906, projectId: 9, title: "Blog", type: "deliverable", startDate: w(24), endDate: wf(24), status: "none", dependencies: [], subtasks: [] },

        { id: 1001, projectId: 10, title: "ETAC Analysis", type: "deliverable", startDate: w(13), endDate: wf(13), status: "none", dependencies: [], subtasks: [] },
        { id: 1002, projectId: 10, title: "Proposal & Analysis", type: "deliverable", startDate: w(15), endDate: wf(15), status: "none", dependencies: [], subtasks: [] },
      ],
      nextId: 2000
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return s;
      }
    } catch(e) { /* ignore */ }
    return defaultState();
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (isGHConfigured()) {
      saveToGitHub(state);
    }
  }

  function genId() { return state.nextId++; }

  // ── Date helpers ──
  function mondayOf(d) {
    const dt = new Date(d);
    const day = dt.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    dt.setDate(dt.getDate() + diff);
    dt.setHours(0,0,0,0);
    return dt;
  }

  function addDays(d, n) {
    const dt = new Date(d);
    dt.setDate(dt.getDate() + n);
    return dt;
  }

  function fmtDate(d) {
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return `${m}/${day}`;
  }

  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }

  function parseDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // ── Resource Hours helpers ──
  function getWorkingDays(startDate, endDate) {
    const days = [];
    const start = typeof startDate === 'string' ? parseDate(startDate) : new Date(startDate);
    const end = typeof endDate === 'string' ? parseDate(endDate) : new Date(endDate);
    const cur = new Date(start);
    while (cur <= end) {
      const dow = cur.getDay();
      if (dow >= 1 && dow <= 5) { // Mon-Fri
        days.push(isoDate(cur));
      }
      cur.setDate(cur.getDate() + 1);
    }
    return days;
  }

  function getSubtaskDailyHours(subtask, task) {
    const hours = subtask.hours || 0;
    if (hours === 0) return {};
    const dailyOverrides = subtask.dailyHours || {};
    const workDays = getWorkingDays(task.startDate, task.endDate);
    if (workDays.length === 0) return {};

    // If there are manual overrides, use them
    const hasOverrides = Object.keys(dailyOverrides).length > 0;
    if (hasOverrides) {
      const result = {};
      workDays.forEach(d => {
        if (dailyOverrides[d] !== undefined) result[d] = dailyOverrides[d];
      });
      return result;
    }

    // Distribute evenly
    const perDay = hours / workDays.length;
    const result = {};
    workDays.forEach(d => { result[d] = Math.round(perDay * 100) / 100; });
    return result;
  }

  function getTaskTotalHours(task) {
    if (!task.subtasks || task.subtasks.length === 0) return 0;
    return task.subtasks.reduce((sum, st) => sum + (st.hours || 0), 0);
  }

  function getSubtaskProgress(task) {
    if (!task.subtasks || task.subtasks.length === 0) return -1; // no subtasks
    const total = task.subtasks.length;
    const done = task.subtasks.filter(st => st.completed).length;
    return done / total;
  }

  // Build a map: member -> date -> total hours across all tasks/subtasks
  function buildMemberDailyHours() {
    const map = {}; // { member: { date: hours } }
    state.tasks.forEach(task => {
      if (!task.subtasks) return;
      task.subtasks.forEach(st => {
        if (!st.assignee) return;
        const daily = getSubtaskDailyHours(st, task);
        Object.entries(daily).forEach(([date, hrs]) => {
          if (!map[st.assignee]) map[st.assignee] = {};
          map[st.assignee][date] = (map[st.assignee][date] || 0) + hrs;
        });
      });
    });
    return map;
  }

  // Build member hours for a specific project on a specific day
  function getProjectMemberDailyHours(projectId, dateStr) {
    const result = {}; // { member: hours }
    state.tasks.forEach(task => {
      if (task.projectId !== projectId || !task.subtasks) return;
      task.subtasks.forEach(st => {
        if (!st.assignee) return;
        const daily = getSubtaskDailyHours(st, task);
        if (daily[dateStr]) {
          result[st.assignee] = (result[st.assignee] || 0) + daily[dateStr];
        }
      });
    });
    return result;
  }

  // ── Dependency helpers ──
  function getDependencies(task) {
    if (!task.dependencies) return [];
    return task.dependencies.map(dep => {
      const predecessor = state.tasks.find(t => t.id === dep.taskId);
      return { ...dep, predecessor };
    }).filter(d => d.predecessor);
  }

  function isDependencyViolated(task) {
    const deps = getDependencies(task);
    for (const dep of deps) {
      const pred = dep.predecessor;
      if (!pred) continue;
      const predStart = parseDate(pred.startDate).getTime();
      const predEnd = parseDate(pred.endDate).getTime();
      const taskStart = parseDate(task.startDate).getTime();
      const taskEnd = parseDate(task.endDate).getTime();

      switch (dep.type) {
        case 'FS': if (taskStart < predEnd + 86400000) return true; break; // task must start after pred ends
        case 'SS': if (taskStart < predStart) return true; break;
        case 'FF': if (taskEnd < predEnd) return true; break;
        case 'SF': if (taskEnd < predStart) return true; break;
      }
    }
    return false;
  }

  function hasCircularDep(taskId, targetId, visited) {
    if (!visited) visited = new Set();
    if (visited.has(taskId)) return false;
    visited.add(taskId);
    if (taskId === targetId) return true;
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || !task.dependencies) return false;
    for (const dep of task.dependencies) {
      if (hasCircularDep(dep.taskId, targetId, visited)) return true;
    }
    return false;
  }

  function cascadeDependencies(movedTaskId, dayDelta) {
    // Find all tasks that depend on the moved task and shift them
    const visited = new Set([movedTaskId]);
    const queue = [movedTaskId];
    while (queue.length > 0) {
      const currentId = queue.shift();
      // Find tasks that list currentId as a dependency
      state.tasks.forEach(t => {
        if (visited.has(t.id)) return;
        if (!t.dependencies) return;
        const hasDep = t.dependencies.some(d => d.taskId === currentId);
        if (hasDep) {
          const start = parseDate(t.startDate);
          const end = parseDate(t.endDate);
          t.startDate = isoDate(addDays(start, dayDelta));
          t.endDate = isoDate(addDays(end, dayDelta));
          visited.add(t.id);
          queue.push(t.id);
        }
      });
    }
  }

  // ── Timeline range ──
  const WEEKS_BEFORE = 2;
  const WEEKS_AFTER = 24;

  function getWeeks() {
    const today = mondayOf(new Date());
    const start = addDays(today, -WEEKS_BEFORE * 7);
    const weeks = [];
    for (let i = 0; i < WEEKS_BEFORE + WEEKS_AFTER; i++) {
      const mon = addDays(start, i * 7);
      const fri = addDays(mon, 4);
      weeks.push({ start: mon, end: addDays(mon, 6), label: `${fmtDate(mon)} - ${fmtDate(fri)}` });
    }
    return weeks;
  }

  // ── Rendering ──
  const headerRow = document.getElementById("headerRow");
  const tableBody = document.getElementById("tableBody");
  const ganttTable = document.getElementById("ganttTable");
  const emptyState = document.getElementById("emptyState");

  function render() {
    const weeks = getWeeks();
    const today = new Date();
    today.setHours(0,0,0,0);

    if (state.projects.length === 0) {
      ganttTable.style.display = "none";
      emptyState.style.display = "";
      return;
    }
    ganttTable.style.display = "";
    emptyState.style.display = "none";

    // Header
    headerRow.innerHTML = '<th>Project</th>';
    weeks.forEach((w, wi) => {
      const th = document.createElement("th");
      th.className = "week-header";
      const icon = expandedWeeks.has(wi) ? '\u25BC' : '\u25B6';
      th.innerHTML = `<span class="expand-icon">${icon}</span>${esc(w.label)}`;
      th.addEventListener('click', () => {
        if (expandedWeeks.has(wi)) expandedWeeks.delete(wi);
        else expandedWeeks.add(wi);
        render();
      });
      headerRow.appendChild(th);
    });

    // Rows
    tableBody.innerHTML = '';
    const sortedProjects = [...state.projects].sort((a, b) => (a.order || 0) - (b.order || 0));

    sortedProjects.forEach(proj => {
      const tr = document.createElement("tr");

      // Project cell
      const projTd = document.createElement("td");
      projTd.className = "project-cell";
      projTd.innerHTML = `
        <div class="proj-name">${esc(proj.name)}</div>
        <div class="proj-team">${esc(proj.teamMembers.join(', '))}</div>
        <button class="proj-del" title="Delete project">&times;</button>
      `;
      projTd.querySelector('.proj-name').addEventListener('click', () => openProjectModal(proj));
      projTd.querySelector('.proj-team').addEventListener('click', () => openProjectModal(proj));
      projTd.querySelector('.proj-del').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete project "${proj.name}" and all its tasks?`)) {
          state.projects = state.projects.filter(p => p.id !== proj.id);
          state.tasks = state.tasks.filter(t => t.projectId !== proj.id);
          saveState(); render();
        }
      });
      tr.appendChild(projTd);

      // Week cells
      const DAY_NAMES = ['Mon','Tue','Wed','Thu','Fri'];

      weeks.forEach((week, wi) => {
        const td = document.createElement("td");
        const isExpanded = expandedWeeks.has(wi);
        td.className = "week-cell" + (isExpanded ? " expanded" : "");

        const weekStart = week.start.getTime();
        const weekEnd = week.end.getTime();

        const tasksInWeek = state.tasks.filter(t => {
          if (t.projectId !== proj.id) return false;
          const ts = parseDate(t.startDate).getTime();
          return ts >= weekStart && ts <= weekEnd;
        });

        if (isExpanded) {
          for (let d = 0; d < 5; d++) {
            const dayDate = addDays(week.start, d);
            const dayTime = dayDate.getTime();
            const isToday = dayTime === today.getTime();
            const dayIso = isoDate(dayDate);

            const slot = document.createElement("div");
            slot.className = "day-slot" + (isToday ? " today" : "");

            const label = document.createElement("div");
            label.className = "day-label";
            label.textContent = DAY_NAMES[d] + ' ' + fmtDate(dayDate);
            slot.appendChild(label);

            const taskArea = document.createElement("div");
            taskArea.className = "day-tasks";

            const dayTasks = tasksInWeek.filter(t => {
              return parseDate(t.startDate).getTime() === dayTime;
            });
            dayTasks.forEach(task => {
              const el = createPostIt(task, week, weeks);
              el.style.position = 'relative';
              el.style.top = '';
              el.style.left = '';
              el.style.width = '';
              taskArea.appendChild(el);
            });

            slot.appendChild(taskArea);

            // Resource rows for this day
            const resKey = `${proj.id}-${wi}`;
            const memberHours = getProjectMemberDailyHours(proj.id, dayIso);
            const members = Object.keys(memberHours);
            if (members.length > 0) {
              const toggle = document.createElement("div");
              toggle.className = "resource-toggle";
              const isResExpanded = expandedResources.has(resKey);
              toggle.textContent = (isResExpanded ? '\u25BC' : '\u25B6') + ' Resources';
              toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (expandedResources.has(resKey)) expandedResources.delete(resKey);
                else expandedResources.add(resKey);
                render();
              });
              slot.appendChild(toggle);

              if (isResExpanded) {
                const allMemberHours = buildMemberDailyHours();
                const resDiv = document.createElement("div");
                resDiv.className = "resource-rows";
                members.forEach(member => {
                  const row = document.createElement("div");
                  row.className = "resource-row";
                  const totalForDay = allMemberHours[member] ? (allMemberHours[member][dayIso] || 0) : 0;
                  if (totalForDay > 8) row.classList.add('overloaded');
                  row.innerHTML = `<span>${esc(member)}</span><span>${memberHours[member].toFixed(1)}h${totalForDay > 8 ? ' (' + totalForDay.toFixed(1) + 'h total)' : ''}</span>`;
                  resDiv.appendChild(row);
                });
                slot.appendChild(resDiv);
              }
            }

            // Drop zone
            slot.setAttribute('data-drop-date', dayIso);
            slot.setAttribute('data-project-id', proj.id);
            slot.addEventListener('dragover', handleDragOver);
            slot.addEventListener('dragleave', handleDragLeave);
            slot.addEventListener('drop', handleDrop);

            slot.addEventListener('click', (e) => {
              if (isDragging) return;
              if (e.target === slot || e.target === label || e.target === taskArea) {
                openTaskModal(null, proj.id, dayIso);
              }
            });

            td.appendChild(slot);
          }
        } else {
          // Collapsed: original rendering
          if (today >= week.start && today <= week.end) {
            const dayOffset = (today - week.start) / (week.end - week.start + 1);
            const marker = document.createElement("div");
            marker.className = "today-marker";
            marker.style.left = (dayOffset * 100) + '%';
            td.appendChild(marker);
          }

          tasksInWeek.forEach(task => {
            const el = createPostIt(task, week, weeks);
            td.appendChild(el);
          });

          td.setAttribute('data-drop-date', isoDate(week.start));
          td.setAttribute('data-project-id', proj.id);
          td.addEventListener('dragover', handleDragOver);
          td.addEventListener('dragleave', handleDragLeave);
          td.addEventListener('drop', handleDrop);

          td.addEventListener('click', (e) => {
            if (isDragging) return;
            if (e.target === td || e.target.className === 'today-marker') {
              openTaskModal(null, proj.id, isoDate(week.start));
            }
          });
        }

        tr.appendChild(td);
      });

      tableBody.appendChild(tr);
    });

    scrollToToday(weeks);
    renderWorkload(weeks);
  }

  function createPostIt(task, startWeek, weeks) {
    const taskStart = parseDate(task.startDate);
    const taskEnd = parseDate(task.endDate);

    const startWeekMon = mondayOf(taskStart);
    const endWeekMon = mondayOf(taskEnd);
    const spanWeeks = Math.max(1, Math.round((endWeekMon - startWeekMon) / (7 * 86400000)) + 1);

    const el = document.createElement("div");
    el.className = `postit type-${task.type}`;

    // Dependency indicators
    const deps = getDependencies(task);
    if (deps.length > 0) {
      if (isDependencyViolated(task)) {
        el.classList.add('dep-violated');
      } else {
        el.classList.add('has-deps');
      }
    }

    if (spanWeeks > 1) {
      el.style.position = 'absolute';
      el.style.top = '4px';
      el.style.left = '2px';
      el.style.width = `calc(${spanWeeks * 100}% - 4px)`;
      el.style.zIndex = '5';
    }

    const typeLabels = { 'draft-sr': 'Draft SR', 'qc': 'QC', 'qc-due': 'QC Due', 'deliverable': 'Deliverable', 'meeting': 'Meeting' };
    let html = `<span class="postit-title">${esc(task.title || typeLabels[task.type] || '')}</span>`;
    if (task.notes) {
      const preview = task.notes.length > 40 ? task.notes.substring(0, 40) + '...' : task.notes;
      html += `<span class="postit-notes">${esc(preview)}</span>`;
    }

    // Badges
    const totalHours = getTaskTotalHours(task);
    const progress = getSubtaskProgress(task);
    const depBadges = deps.map(d => `${esc(d.predecessor.title)} (${d.type})`);

    if (totalHours > 0 || depBadges.length > 0) {
      html += '<div class="postit-badges">';
      if (totalHours > 0) {
        html += `<span class="postit-badge hours-badge">${totalHours}h</span>`;
      }
      depBadges.forEach(b => {
        html += `<span class="postit-badge dep-badge">${b}</span>`;
      });
      html += '</div>';
    }

    // Progress bar
    if (progress >= 0) {
      html += `<div class="postit-progress"><div class="postit-progress-fill" style="width:${Math.round(progress * 100)}%"></div></div>`;
    }

    el.innerHTML = html;

    if (task.status && task.status !== 'none') {
      const dot = document.createElement("div");
      dot.className = `status-dot ${task.status}`;
      el.appendChild(dot);
    }

    el.setAttribute('draggable', 'true');
    el.setAttribute('data-task-id', task.id);

    el.addEventListener('dragstart', handleDragStart);
    el.addEventListener('dragend', handleDragEnd);

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isDragging) return;
      openTaskModal(task);
    });

    return el;
  }

  function handleDragStart(e) {
    draggedTaskId = this.getAttribute('data-task-id');
    isDragging = true;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedTaskId);
  }

  function handleDragEnd(e) {
    this.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    draggedTaskId = null;
    setTimeout(() => { isDragging = false; }, 0);
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.currentTarget;
    target.classList.add('drag-over');
  }

  function handleDragLeave(e) {
    const target = e.currentTarget;
    if (!target.contains(e.relatedTarget)) {
      target.classList.remove('drag-over');
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    target.classList.remove('drag-over');

    const taskId = parseInt(e.dataTransfer.getData('text/plain'), 10);
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;

    const dropDate = target.getAttribute('data-drop-date');
    const dropProjectId = parseInt(target.getAttribute('data-project-id'), 10);
    if (!dropDate || !dropProjectId) return;

    const oldStart = parseDate(task.startDate);
    const oldEnd = parseDate(task.endDate);
    const durationMs = oldEnd.getTime() - oldStart.getTime();

    const newStart = parseDate(dropDate);
    const newEnd = new Date(newStart.getTime() + durationMs);

    // Calculate day delta for dependency cascade
    const dayDelta = Math.round((newStart.getTime() - oldStart.getTime()) / 86400000);

    task.startDate = isoDate(newStart);
    task.endDate = isoDate(newEnd);
    task.projectId = dropProjectId;

    // Cascade dependencies
    if (dayDelta !== 0) {
      cascadeDependencies(task.id, dayDelta);
    }

    saveState();
    render();
  }

  let hasScrolled = false;
  function scrollToToday(weeks) {
    if (hasScrolled) return;
    const today = new Date();
    today.setHours(0,0,0,0);
    const idx = weeks.findIndex(w => today >= w.start && today <= w.end);
    if (idx > 0) {
      const wrapper = document.getElementById("boardWrapper");
      const scrollX = 200 + (idx - 2) * 110;
      wrapper.scrollLeft = Math.max(0, scrollX);
    }
    hasScrolled = true;
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Workload Panel ──
  let workloadVisible = false;
  const workloadPanel = document.getElementById("workloadPanel");
  const boardWrapper = document.getElementById("boardWrapper");

  document.getElementById("btnWorkload").addEventListener('click', () => {
    workloadVisible = !workloadVisible;
    workloadPanel.style.display = workloadVisible ? '' : 'none';
    boardWrapper.classList.toggle('with-workload', workloadVisible);
    document.getElementById("btnWorkload").classList.toggle('active', workloadVisible);
    if (workloadVisible) renderWorkload(getWeeks());
  });

  // Sync workload scroll with board scroll
  const workloadScroll = document.getElementById("workloadScroll");
  boardWrapper.addEventListener('scroll', () => {
    workloadScroll.scrollLeft = boardWrapper.scrollLeft;
  });
  workloadScroll.addEventListener('scroll', () => {
    boardWrapper.scrollLeft = workloadScroll.scrollLeft;
  });

  function renderWorkload(weeks) {
    if (!workloadVisible) return;
    const headerRow = document.getElementById("workloadHeaderRow");
    const body = document.getElementById("workloadBody");

    // Collect all unique team members
    const allMembers = new Set();
    state.projects.forEach(p => p.teamMembers.forEach(m => allMembers.add(m)));
    const members = [...allMembers].sort();

    const memberDailyHours = buildMemberDailyHours();

    // Header: Team Member | Week1 | Week2 | ...
    headerRow.innerHTML = '<th>Team Member</th>';
    weeks.forEach(w => {
      const th = document.createElement("th");
      th.textContent = w.label;
      th.style.minWidth = 'var(--cell-min-w)';
      headerRow.appendChild(th);
    });

    // Rows
    body.innerHTML = '';
    members.forEach(member => {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.textContent = member;
      tr.appendChild(nameTd);

      weeks.forEach(w => {
        const td = document.createElement("td");
        // Sum hours for this member in this week (Mon-Fri)
        let weekTotal = 0;
        for (let d = 0; d < 5; d++) {
          const dayStr = isoDate(addDays(w.start, d));
          if (memberDailyHours[member] && memberDailyHours[member][dayStr]) {
            weekTotal += memberDailyHours[member][dayStr];
          }
        }

        if (weekTotal > 0) {
          td.textContent = weekTotal.toFixed(1) + 'h';
          // Heat map coloring
          if (weekTotal > 40) {
            td.style.background = '#ef5350';
            td.style.color = '#fff';
            td.style.fontWeight = '700';
          } else if (weekTotal > 30) {
            td.style.background = '#66bb6a';
            td.style.color = '#fff';
          } else if (weekTotal > 20) {
            td.style.background = '#a5d6a7';
          } else if (weekTotal > 0) {
            td.style.background = '#e8f5e9';
          }
        }
        tr.appendChild(td);
      });

      body.appendChild(tr);
    });
  }

  // ── Project Modal ──
  let editingProject = null;

  function openProjectModal(proj) {
    editingProject = proj || null;
    document.getElementById("projectModalTitle").textContent = proj ? "Edit Project" : "Add Project";
    document.getElementById("projName").value = proj ? proj.name : '';
    document.getElementById("projTeam").value = proj ? proj.teamMembers.join(', ') : '';
    document.getElementById("projectModal").classList.add("active");
    document.getElementById("projName").focus();
  }

  function closeProjectModal() {
    document.getElementById("projectModal").classList.remove("active");
    editingProject = null;
  }

  document.getElementById("projSave").addEventListener('click', () => {
    const name = document.getElementById("projName").value.trim();
    const teamStr = document.getElementById("projTeam").value.trim();
    if (!name) { alert("Project name is required."); return; }
    const teamMembers = teamStr ? teamStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    if (editingProject) {
      editingProject.name = name;
      editingProject.teamMembers = teamMembers;
    } else {
      state.projects.push({
        id: genId(),
        name,
        teamMembers,
        order: state.projects.length
      });
    }
    saveState();
    closeProjectModal();
    render();
  });

  document.getElementById("projCancel").addEventListener('click', closeProjectModal);
  document.getElementById("btnAddProject").addEventListener('click', () => openProjectModal(null));

  // ── Task Modal ──
  let editingTask = null;
  let taskProjectId = null;
  let tempSubtasks = [];
  let tempDependencies = [];

  function openTaskModal(task, projectId, defaultDate) {
    editingTask = task || null;
    taskProjectId = projectId || (task ? task.projectId : null);

    document.getElementById("taskModalTitle").textContent = task ? "Edit Task" : "Add Task";
    document.getElementById("taskTitle").value = task ? task.title : '';
    document.getElementById("taskType").value = task ? task.type : 'draft-sr';
    document.getElementById("taskStart").value = task ? task.startDate : (defaultDate || '');
    document.getElementById("taskEnd").value = task ? task.endDate : (defaultDate || '');
    document.getElementById("taskStatus").value = task ? (task.status || 'none') : 'none';
    document.getElementById("taskNotes").value = task ? (task.notes || '') : '';
    document.getElementById("taskDelete").style.display = task ? '' : 'none';

    // Subtasks section (only when editing existing task)
    const subtasksSection = document.getElementById("taskSubtasksSection");
    const depsSection = document.getElementById("taskDepsSection");

    if (task) {
      subtasksSection.style.display = '';
      depsSection.style.display = '';
      tempSubtasks = JSON.parse(JSON.stringify(task.subtasks || []));
      tempDependencies = JSON.parse(JSON.stringify(task.dependencies || []));
      renderSubtasksList();
      renderDepsList();
      populateAssigneeDropdown();
      populateDepTaskDropdown();
    } else {
      subtasksSection.style.display = 'none';
      depsSection.style.display = 'none';
      tempSubtasks = [];
      tempDependencies = [];
    }

    document.getElementById("taskModal").classList.add("active");
    document.getElementById("taskTitle").focus();
  }

  function populateAssigneeDropdown() {
    const select = document.getElementById("subtaskNewAssignee");
    const proj = state.projects.find(p => p.id === taskProjectId);
    select.innerHTML = '<option value="">--</option>';
    if (proj) {
      proj.teamMembers.forEach(m => {
        select.innerHTML += `<option value="${esc(m)}">${esc(m)}</option>`;
      });
    }
  }

  function populateDepTaskDropdown() {
    const select = document.getElementById("taskDepTaskSelect");
    select.innerHTML = '';
    // Show all tasks except the current one
    state.tasks.forEach(t => {
      if (editingTask && t.id === editingTask.id) return;
      const proj = state.projects.find(p => p.id === t.projectId);
      const projName = proj ? proj.name : '?';
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${projName}: ${t.title || t.type}`;
      select.appendChild(opt);
    });
  }

  function renderSubtasksList() {
    const container = document.getElementById("taskSubtasksList");
    container.innerHTML = '';
    tempSubtasks.forEach((st, idx) => {
      const div = document.createElement("div");
      div.className = "subtask-item";
      div.innerHTML = `
        <input type="checkbox" ${st.completed ? 'checked' : ''} data-idx="${idx}">
        <span class="subtask-title ${st.completed ? 'completed' : ''}">${esc(st.title)}</span>
        <span class="subtask-assignee">${esc(st.assignee || '')}</span>
        <span class="subtask-hours">${st.hours ? st.hours + 'h' : ''}</span>
        <button class="subtask-daily-toggle" data-idx="${idx}" title="Edit daily hours">\u2630</button>
        <button class="subtask-del" data-idx="${idx}">&times;</button>
      `;
      container.appendChild(div);

      // Checkbox
      div.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
        tempSubtasks[idx].completed = e.target.checked;
        renderSubtasksList();
      });

      // Delete
      div.querySelector('.subtask-del').addEventListener('click', () => {
        tempSubtasks.splice(idx, 1);
        renderSubtasksList();
      });

      // Daily hours toggle
      div.querySelector('.subtask-daily-toggle').addEventListener('click', () => {
        const gridId = `daily-grid-${idx}`;
        const existing = container.querySelector(`#${gridId}`);
        if (existing) {
          existing.remove();
          return;
        }
        const task = editingTask;
        if (!task) return;
        const workDays = getWorkingDays(
          document.getElementById("taskStart").value || task.startDate,
          document.getElementById("taskEnd").value || task.endDate
        );
        const dailyHours = st.dailyHours || {};
        const totalHrs = st.hours || 0;
        const evenHrs = workDays.length > 0 ? totalHrs / workDays.length : 0;

        const grid = document.createElement("div");
        grid.className = "daily-hours-grid";
        grid.id = gridId;
        workDays.forEach(dayStr => {
          const lbl = document.createElement("label");
          const d = parseDate(dayStr);
          const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
          lbl.innerHTML = `${dayNames[d.getDay()]} ${fmtDate(d)}`;
          const inp = document.createElement("input");
          inp.type = "number";
          inp.min = "0";
          inp.step = "0.25";
          inp.value = dailyHours[dayStr] !== undefined ? dailyHours[dayStr] : evenHrs.toFixed(2);
          inp.addEventListener('change', () => {
            if (!tempSubtasks[idx].dailyHours) tempSubtasks[idx].dailyHours = {};
            tempSubtasks[idx].dailyHours[dayStr] = parseFloat(inp.value) || 0;
          });
          lbl.appendChild(inp);
          grid.appendChild(lbl);
        });
        div.after(grid);
      });
    });
  }

  function renderDepsList() {
    const container = document.getElementById("taskDepsList");
    container.innerHTML = '';
    tempDependencies.forEach((dep, idx) => {
      const pred = state.tasks.find(t => t.id === dep.taskId);
      if (!pred) return;
      const proj = state.projects.find(p => p.id === pred.projectId);
      const div = document.createElement("div");
      div.className = "dep-item";
      div.innerHTML = `
        <span class="dep-type">${dep.type}</span>
        <span class="dep-name">${esc(proj ? proj.name : '?')}: ${esc(pred.title || pred.type)}</span>
        <button class="dep-del" data-idx="${idx}">&times;</button>
      `;
      div.querySelector('.dep-del').addEventListener('click', () => {
        tempDependencies.splice(idx, 1);
        renderDepsList();
      });
      container.appendChild(div);
    });
  }

  // Add subtask
  document.getElementById("subtaskAdd").addEventListener('click', () => {
    const title = document.getElementById("subtaskNewTitle").value.trim();
    if (!title) return;
    const assignee = document.getElementById("subtaskNewAssignee").value;
    const hours = parseFloat(document.getElementById("subtaskNewHours").value) || 0;
    tempSubtasks.push({
      id: genId(),
      title,
      assignee,
      hours,
      completed: false,
      dailyHours: {}
    });
    document.getElementById("subtaskNewTitle").value = '';
    document.getElementById("subtaskNewHours").value = '';
    renderSubtasksList();
  });

  // Add dependency
  document.getElementById("taskDepAdd").addEventListener('click', () => {
    const taskSelect = document.getElementById("taskDepTaskSelect");
    const typeSelect = document.getElementById("taskDepTypeSelect");
    const targetId = parseInt(taskSelect.value, 10);
    if (!targetId) return;

    // Check for duplicates
    if (tempDependencies.some(d => d.taskId === targetId)) {
      alert('This dependency already exists.');
      return;
    }

    // Circular check
    if (editingTask && hasCircularDep(targetId, editingTask.id)) {
      alert('Cannot add dependency: would create a circular reference.');
      return;
    }

    tempDependencies.push({
      taskId: targetId,
      type: typeSelect.value
    });
    renderDepsList();
  });

  function closeTaskModal() {
    document.getElementById("taskModal").classList.remove("active");
    editingTask = null;
    taskProjectId = null;
    tempSubtasks = [];
    tempDependencies = [];
  }

  document.getElementById("taskSave").addEventListener('click', () => {
    const title = document.getElementById("taskTitle").value.trim();
    const type = document.getElementById("taskType").value;
    const startDate = document.getElementById("taskStart").value;
    const endDate = document.getElementById("taskEnd").value;
    const status = document.getElementById("taskStatus").value;
    const notes = document.getElementById("taskNotes").value;

    if (!startDate || !endDate) { alert("Start and end dates are required."); return; }
    if (endDate < startDate) { alert("End date must be on or after start date."); return; }

    if (editingTask) {
      editingTask.title = title;
      editingTask.type = type;
      editingTask.startDate = startDate;
      editingTask.endDate = endDate;
      editingTask.status = status;
      editingTask.notes = notes;
      editingTask.subtasks = tempSubtasks;
      editingTask.dependencies = tempDependencies;
    } else {
      state.tasks.push({
        id: genId(),
        projectId: taskProjectId,
        title,
        type,
        startDate,
        endDate,
        status,
        notes,
        subtasks: [],
        dependencies: []
      });
    }
    saveState();
    closeTaskModal();
    render();
  });

  document.getElementById("taskDelete").addEventListener('click', () => {
    if (editingTask && confirm("Delete this task?")) {
      const deletedId = editingTask.id;
      state.tasks = state.tasks.filter(t => t.id !== deletedId);
      // Remove references to this task from other tasks' dependencies
      state.tasks.forEach(t => {
        if (t.dependencies) {
          t.dependencies = t.dependencies.filter(d => d.taskId !== deletedId);
        }
      });
      saveState();
      closeTaskModal();
      render();
    }
  });

  document.getElementById("taskCancel").addEventListener('click', closeTaskModal);

  // Close modals on overlay click
  document.getElementById("projectModal").addEventListener('click', (e) => {
    if (e.target === document.getElementById("projectModal")) closeProjectModal();
  });
  document.getElementById("taskModal").addEventListener('click', (e) => {
    if (e.target === document.getElementById("taskModal")) closeTaskModal();
  });

  // Close modals on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeProjectModal();
      closeTaskModal();
      settingsModal.classList.remove("active");
    }
  });

  // ── Today button ──
  document.getElementById("btnToday").addEventListener('click', () => {
    hasScrolled = false;
    const weeks = getWeeks();
    scrollToToday(weeks);
    const today = new Date();
    today.setHours(0,0,0,0);
    const idx = weeks.findIndex(w => today >= w.start && today <= w.end);
    if (idx >= 0) {
      const wrapper = document.getElementById("boardWrapper");
      const scrollX = 200 + Math.max(0, idx - 2) * 110;
      wrapper.scrollLeft = Math.max(0, scrollX);
    }
  });

  // ── Export / Import ──
  document.getElementById("btnExport").addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'clanton-gantt-backup.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById("fileImport").addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (imported.projects && imported.tasks) {
          if (confirm("This will replace all current data. Continue?")) {
            state = imported;
            migrateState();
            saveState();
            render();
          }
        } else {
          alert("Invalid file format.");
        }
      } catch(err) {
        alert("Failed to parse JSON file.");
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // ── Reset to demo data ──
  document.getElementById("btnReset").addEventListener('click', () => {
    if (confirm("Reset all data to the demo board? This will erase your current data.")) {
      localStorage.removeItem(STORAGE_KEY);
      state = defaultState();
      saveState();
      hasScrolled = false;
      render();
    }
  });

  // ── Initial render + migration + GitHub load ──
  migrateState();
  render();

  if (isGHConfigured()) {
    setSyncStatus('saving', 'Loading...');
    loadAndApplyFromGitHub().then(() => startPolling());
  }
})();
