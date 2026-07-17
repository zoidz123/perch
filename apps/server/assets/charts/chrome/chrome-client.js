/* global WebSocket, document, location, window, fetch, sessionStorage */

// Desktop chart-review chrome.
// Adapted from lavish-axi v0.1.37 src/chrome-client.js (MIT, (c) 2026 Kun
// Chen; see ../../../src/charts/vendor/LICENSE). The `lavish:` postMessage
// names are the injected SDK's wire contract and are kept as-is.
//
// What changed against lavish:
// - Feedback is SEND-ONLY: POST /charts/:id/feedback replaces the prompt
//   mailbox; the agent's reply is the chart itself (live refresh below).
//   There is no agent-reply channel and no DOM-snapshot round trip.
// - Presence inference is replaced by the owning session's REAL status from
//   the fleet WebSocket, which also delivers the `chart` events that reload
//   the iframe when the agent edits the file.
// - Dropped: share/export/publish, the more menu, session-end etiquette, and
//   the layout-gate curtain (audit findings still report and still banner).

const sessionData = JSON.parse(document.getElementById("perch-chart-session")?.textContent || "{}");
const chartId = String(sessionData.id || "");
const sessionId = String(sessionData.sessionId || "");
const reviewNonce = String(sessionData.reviewNonce || "");
const token = new URLSearchParams(location.search).get("token") || "";
const queueStorageKey = "perch-chart:queued:" + chartId;
const internalQueueKeyField = "_lavishQueueKey";
const MODE_TOGGLE_HOTKEY_KEY = "e";

const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("chart"));
const panelScroll = /** @type {HTMLDivElement} */ (document.getElementById("panelScroll"));
const annotationPills = /** @type {HTMLDivElement} */ (document.getElementById("annotationPills"));
const chatLog = /** @type {HTMLDivElement} */ (document.getElementById("chatLog"));
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chatInput"));
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const sendHint = /** @type {HTMLSpanElement} */ (document.getElementById("sendHint"));
const annotationSwitch = /** @type {HTMLButtonElement} */ (document.getElementById("annotation"));
const sessionChip = /** @type {HTMLSpanElement} */ (document.getElementById("sessionChip"));
const sessionChipText = /** @type {HTMLSpanElement} */ (document.getElementById("sessionChipText"));
const layoutIssueBanner = /** @type {HTMLDivElement} */ (document.getElementById("layoutIssueBanner"));
const chartSrc = frame.dataset.chartSrc || "";

const queued = loadQueuedPrompts();
let annotation = true;
let sending = false;
let lastScroll = { x: 0, y: 0 };
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendHintTimer;

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function apiHeaders() {
  const headers = { "content-type": "application/json" };
  if (reviewNonce) headers["x-perch-chart-review"] = reviewNonce;
  return headers;
}

function loadQueuedPrompts() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(queueStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter((prompt) => prompt && typeof prompt === "object") : [];
  } catch {
    return [];
  }
}

function persistQueuedPrompts() {
  try {
    if (queued.length) {
      sessionStorage.setItem(queueStorageKey, JSON.stringify(queued));
    } else {
      sessionStorage.removeItem(queueStorageKey);
    }
  } catch {
    // The in-memory queue still works if browser storage is unavailable.
  }
}

function render() {
  annotationPills.innerHTML = queued
    .map(
      (prompt, index) =>
        '<div class="pill-wrap"><div class="pill"><span class="pill-preview">' +
        escapeHtml(prompt.prompt) +
        '</span><button class="pill-close" type="button" aria-label="Remove queued note" data-index="' +
        index +
        '"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><div class="pill-tooltip">' +
        (prompt.selector
          ? '<div class="tooltip-label">Target</div><div class="pill-tooltip-target">' +
            escapeHtml(prompt.selector) +
            "</div>"
          : "") +
        '<div class="tooltip-label">Note</div><div class="pill-tooltip-prompt">' +
        escapeHtml(prompt.prompt) +
        "</div></div></div>",
    )
    .join("");

  for (const button of annotationPills.querySelectorAll(".pill-close")) {
    const closeButton = /** @type {HTMLButtonElement} */ (button);
    closeButton.addEventListener("click", (event) => removeQueuedPrompt(Number(closeButton.dataset.index), event));
  }
  scrollPanelToBottom();
}

function showSendHint() {
  sendHint.hidden = false;
  clearTimeout(sendHintTimer);
  sendHintTimer = setTimeout(() => {
    sendHint.hidden = true;
  }, 2600);
  chatInput.focus();
}

function hideSendHint() {
  clearTimeout(sendHintTimer);
  sendHint.hidden = true;
}

function addChat(role, text) {
  if (!text) return;
  const el = document.createElement("div");
  el.className = "bubble " + role;
  const label = role === "user" ? "<small>You</small>" : "";
  el.innerHTML = label + "<div>" + escapeHtml(text) + "</div>";
  chatLog.appendChild(el);
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  return el;
}

function addSystemNote(text, isError = false) {
  return addChat(isError ? "system error" : "system", text);
}

function scrollPanelToBottom() {
  panelScroll.scrollTop = panelScroll.scrollHeight;
}

function removeQueuedPrompt(index, event) {
  if (event) event.stopPropagation();
  queued.splice(index, 1);
  persistQueuedPrompts();
  render();
}

function promptQueueKey(prompt) {
  return prompt && typeof prompt[internalQueueKeyField] === "string" ? prompt[internalQueueKeyField].trim() : "";
}

function enqueuePrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return;

  const queueKey = promptQueueKey(prompt);
  if (queueKey) {
    const index = queued.findIndex((item) => promptQueueKey(item) === queueKey);
    if (index !== -1) {
      queued[index] = prompt;
    } else {
      queued.push(prompt);
    }
  } else {
    queued.push(prompt);
  }

  persistQueuedPrompts();
  render();
}

// The feedback API's ChartAnnotation shape: prompt/selector/tag/text/target.
// uid and the queue-dedupe key are chrome-internal.
function toAnnotation(prompt) {
  const clean = { ...prompt };
  delete clean[internalQueueKeyField];
  delete clean.uid;
  return clean;
}

function postToFrame(message) {
  if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
}

async function sendFeedback() {
  if (sending) return;

  const message = chatInput.value.trim();
  if (!message && !queued.length) {
    showSendHint();
    return;
  }
  hideSendHint();

  const annotations = queued.map(toAnnotation);
  sending = true;
  sendButton.disabled = true;
  try {
    const response = await fetch("/charts/" + chartId + "/feedback", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ message, annotations }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      addSystemNote(data.error || "Sending feedback failed (" + response.status + ").", true);
      return;
    }
    if (message) addChat("user", message);
    queued.length = 0;
    persistQueuedPrompts();
    chatInput.value = "";
    render();
    const count = annotations.length + (message ? 1 : 0);
    addSystemNote(
      count +
        (count === 1 ? " note" : " notes") +
        " sent to the agent" +
        (data.queued ? " - queued behind an open permission prompt, lands when it resolves" : "") +
        ".",
    );
  } catch {
    addSystemNote("Sending feedback failed - is the perch server still running?", true);
  } finally {
    sending = false;
    sendButton.disabled = false;
  }
}

async function submitLayoutWarnings(layoutWarnings) {
  const warnings = Array.isArray(layoutWarnings) ? layoutWarnings.filter((item) => item && typeof item === "object") : [];
  const hasErrors = warnings.some((warning) => String(warning?.severity || "").toLowerCase() === "error");
  layoutIssueBanner.hidden = !hasErrors;
  try {
    // The server dedupes repeats and routes findings to the drawing agent as
    // machine feedback; the boss just sees the banner.
    await fetch("/charts/" + chartId + "/layout-warnings", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ layout_warnings: warnings }),
    });
  } catch {
    // Audit reporting is best-effort; review is never blocked on it.
  }
}

function toggleAnnotationMode() {
  annotation = !annotation;
  annotationSwitch.setAttribute("aria-pressed", String(annotation));
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation });
}

function resetFrame() {
  // The iframe is sandboxed, so reload by resetting the iframe URL from chrome.
  frame.src = chartSrc;
}

// --- Session status + live refresh over the fleet WebSocket ---------------

const STATUS_LABELS = {
  running: "Working",
  idle: "Idle",
  waiting: "Waiting",
  needs_approval: "Needs approval",
};

function setSessionStatus(status, label) {
  sessionChip.dataset.status = status;
  sessionChipText.textContent = label;
}

function applyFleet(sessions) {
  const owner = (sessions || []).find((session) => session && session.id === sessionId);
  if (!owner || owner.status === "done" || owner.status === "error") {
    setSessionStatus("gone", "Agent gone");
    return;
  }
  setSessionStatus(owner.status, STATUS_LABELS[owner.status] || owner.status);
}

let reconnectDelayMs = 1000;

function connect() {
  if (!token) {
    setSessionStatus("unknown", "Local review");
    return;
  }
  const wsUrl =
    (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host +
    "/?token=" +
    encodeURIComponent(token) +
    "&sessionId=" +
    encodeURIComponent(sessionId);
  const socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    reconnectDelayMs = 1000;
  };
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "fleet") applyFleet(msg.sessions);
    if (msg.type === "event" && msg.event?.type === "chart" && msg.event.chartId === chartId) {
      resetFrame();
    }
  };
  socket.onclose = () => {
    setSessionStatus("unknown", "Reconnecting…");
    setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
  };
}

// --- Wiring ----------------------------------------------------------------

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;

  const msg = event.data || {};
  if (msg.type === "lavish:queuePrompt") enqueuePrompt(msg.prompt);
  if (msg.type === "lavish:scroll") {
    lastScroll = { x: Number(msg.x) || 0, y: Number(msg.y) || 0 };
  }
  if (msg.type === "lavish:layoutWarnings") submitLayoutWarnings(msg.layout_warnings);
  if (msg.type === "lavish:sendQueuedPrompts") sendFeedback();
  if (msg.type === "lavish:toggleAnnotationMode") toggleAnnotationMode();
});

annotationSwitch.onclick = toggleAnnotationMode;
sendButton.onclick = sendFeedback;
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendFeedback();
  }
});
chatInput.addEventListener("input", hideSendHint);
// Capture phase so the mode hotkey fires no matter where focus is in the
// chrome - including mid-keystroke in chatInput or an annotation-card
// textarea - without disturbing normal typing.
document.addEventListener(
  "keydown",
  (event) => {
    if (event.shiftKey || event.altKey) return;
    if (!(event.metaKey || event.ctrlKey) || String(event.key || "").toLowerCase() !== MODE_TOGGLE_HOTKEY_KEY) return;
    event.preventDefault();
    toggleAnnotationMode();
  },
  true,
);
frame.addEventListener("load", () => {
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation });
  // Replay the pre-reload scroll position so live refreshes don't jump the
  // chart back to the top.
  postToFrame({ type: "lavish:restoreScroll", x: lastScroll.x, y: lastScroll.y });
});

resetFrame();
render();
connect();
