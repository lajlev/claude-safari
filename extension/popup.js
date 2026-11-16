/* Send to Claude — toolbar popup: "New chat" / "Add to current chat". */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

// Show the shortcuts the browser actually assigned, when it tells us.
async function showShortcuts() {
  try {
    const cmds = await api.commands.getAll();
    for (const c of cmds || []) {
      const kbd = c.name === "send-page" ? $("kbd-new") : c.name === "add-to-chat" ? $("kbd-add") : null;
      if (kbd && c.shortcut) kbd.textContent = c.shortcut;
    }
  } catch {
    // Keep the defaults written in popup.html.
  }
}

function setHint(id, text, warn) {
  const el = $(id);
  el.textContent = text;
  el.title = text;
  el.classList.toggle("warn", !!warn);
}

async function activeTab() {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

async function init() {
  showShortcuts();
  const tab = await activeTab();
  for (const btn of document.querySelectorAll(".action")) {
    btn.addEventListener("click", async () => {
      document.querySelectorAll(".action").forEach((b) => (b.disabled = true));
      try {
        await api.runtime.sendMessage({ type: "send", mode: btn.dataset.mode, tabId: tab ? tab.id : null });
      } catch (e) {
        console.warn("[send-to-claude] send failed:", e);
      }
      window.close();
    });
  }
  $("btn-new").focus();

  let state = null;
  try {
    state = await api.runtime.sendMessage({ type: "popup-state", tabId: tab ? tab.id : null });
  } catch (e) {
    console.warn("[send-to-claude] popup-state failed:", e);
  }

  if (state && state.onClaude) {
    $("btn-new").disabled = true;
    $("btn-add").disabled = true;
    const n = $("notice");
    n.textContent = "You're on claude.ai — switch to the page you want to send.";
    n.hidden = false;
  } else if (state) {
    const where = state.sameWindow ? "this window's" : "your";
    if (state.hasClaudeTab) {
      setHint("hint-new", `Reuses ${where} Claude tab`);
      setHint(
        "hint-add",
        state.conversation ? `Adds to: ${state.title || "open chat"}` : "No open chat — will start a new one",
        !state.conversation
      );
    } else {
      setHint("hint-new", "Opens Claude on the right");
      setHint("hint-add", "No open chat — will start a new one", true);
    }
  }
}

init();
