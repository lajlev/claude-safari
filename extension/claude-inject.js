/* Send to Claude — content script for https://claude.ai/*
 * Gets page context from the background in two ways:
 *  - "insert" message (Add to current chat): delivered straight to an
 *    already-loaded tab, inserted into the open conversation's composer.
 *  - "claim" hand-off (New chat): after the background navigates this tab to
 *    claude.ai/new, the script claims the pending text once on load.
 * Text is appended to any existing draft and never sent. Each send carries a
 * unique id, so a send that arrives by both routes is inserted only once.
 */
(() => {
  "use strict";
  if (window.__sendToClaudeLoaded) return;
  window.__sendToClaudeLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const COMPOSER_TIMEOUT_MS = 20000; // fresh /new page: wait for it to mount
  const ADD_COMPOSER_TIMEOUT_MS = 3000; // loaded tab: the composer is there or not
  let busy = false;
  const seen = new Set(); // send ids already inserted in this page

  const COMPOSER_SELECTORS = [
    'fieldset div.ProseMirror[contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
    '[data-testid="chat-input"][contenteditable="true"]',
    '[data-testid="chat-input"] [contenteditable="true"]',
    'fieldset [contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]'
  ];

  function findComposer() {
    for (const sel of COMPOSER_SELECTORS) {
      const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null || e.getClientRects().length);
      if (el) return el;
    }
    return null;
  }

  function waitForComposer(timeoutMs) {
    return new Promise((resolve) => {
      const found = findComposer();
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const el = findComposer();
        if (el) {
          obs.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(findComposer());
      }, timeoutMs);
    });
  }

  function caretToEnd(el) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const normalize = (s) => s.replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function looksInserted(el, text, before) {
    const probe = normalize(text).slice(0, 60);
    const now = normalize(el.textContent || "");
    return now.includes(probe) || now.length > before.length + 20;
  }

  async function tryPaste(el, text) {
    let dt;
    try {
      dt = new DataTransfer();
      dt.setData("text/plain", text);
    } catch {
      return false;
    }
    let ev;
    try {
      ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    } catch {
      return false;
    }
    if (!ev.clipboardData) return false; // engine ignored clipboardData init
    const before = normalize(el.textContent || "");
    el.dispatchEvent(ev);
    // ProseMirror calls preventDefault() when it handles a paste. claude.ai may
    // turn very long pastes into an attachment instead of inline text.
    await sleep(150);
    return ev.defaultPrevented || looksInserted(el, text, before);
  }

  async function tryInsertText(el, text) {
    const before = normalize(el.textContent || "");
    caretToEnd(el);
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch {
      ok = false;
    }
    await sleep(150);
    return ok && looksInserted(el, text, before);
  }

  function toast(message, actionLabel, onAction) {
    const old = document.getElementById("send-to-claude-toast");
    if (old) old.remove();
    const box = document.createElement("div");
    box.id = "send-to-claude-toast";
    box.setAttribute("role", "status");
    Object.assign(box.style, {
      position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647",
      background: "#1f1e1d", color: "#fff", padding: "10px 14px", borderRadius: "10px",
      font: "13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif",
      boxShadow: "0 4px 16px rgba(0,0,0,.25)", display: "flex", gap: "10px", alignItems: "center"
    });
    const span = document.createElement("span");
    span.textContent = message;
    box.appendChild(span);
    if (actionLabel) {
      const btn = document.createElement("button");
      btn.textContent = actionLabel;
      Object.assign(btn.style, {
        background: "#d97757", color: "#fff", border: "0", borderRadius: "6px",
        padding: "4px 10px", cursor: "pointer", font: "inherit"
      });
      btn.addEventListener("click", onAction);
      box.appendChild(btn);
    }
    document.documentElement.appendChild(box);
    if (!actionLabel) setTimeout(() => box.remove(), 6000);
    return box;
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch {}
      ta.remove();
      return ok;
    }
  }

  async function fallback(text) {
    if (await copyToClipboard(text)) {
      toast("Page context copied — press ⌘V");
      return;
    }
    // Clipboard writes need a user gesture in Safari: offer a button.
    const box = toast("Couldn't insert page context.", "Copy it", async () => {
      const ok = await copyToClipboard(text);
      box.remove();
      toast(ok ? "Page context copied — press ⌘V" : "Copy failed — try the toolbar button again.");
    });
  }

  async function inject(text, el) {
    if (!el) el = await waitForComposer(COMPOSER_TIMEOUT_MS);
    if (!el) return fallback(text);
    await sleep(300); // let React/ProseMirror finish mounting
    caretToEnd(el);
    // Keep whatever the user already typed; separate with a blank line.
    const toInsert = (el.textContent || "").trim() ? "\n\n" + text : text;
    let ok = await tryPaste(el, toInsert);
    if (!ok) ok = await tryInsertText(el, toInsert);
    if (!ok) return fallback(text);
    // Leave the caret at the end so the user can type their question.
    caretToEnd(el);
  }

  async function claim() {
    if (busy) return;
    busy = true;
    try {
      const res = await api.runtime.sendMessage({ type: "claim" });
      if (res && res.text && !(res.id && seen.has(res.id))) {
        if (res.id) seen.add(res.id);
        await inject(res.text);
      }
    } catch (e) {
      console.warn("[send-to-claude] claim failed:", e);
    } finally {
      busy = false;
    }
  }

  // "Add to current chat": insert into the composer that's already open.
  // Replies { ok: true } once handled (inserted, or clipboard fallback shown),
  // or { ok: false, reason: "no-composer" } so the background opens /new.
  async function handleInsert(msg) {
    if (!msg.text) return { ok: false, reason: "empty" };
    if (msg.id && seen.has(msg.id)) return { ok: true, duplicate: true };
    const el = await waitForComposer(ADD_COMPOSER_TIMEOUT_MS);
    if (!el) return { ok: false, reason: "no-composer" };
    if (msg.id && seen.has(msg.id)) return { ok: true, duplicate: true };
    if (msg.id) seen.add(msg.id);
    await inject(msg.text, el);
    return { ok: true };
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "pending-available") claim();
    if (msg.type === "insert") {
      handleInsert(msg).then(sendResponse, (e) => {
        console.warn("[send-to-claude] insert failed:", e);
        sendResponse({ ok: true, error: String(e) }); // don't fall through to /new
      });
      return true; // async response
    }
  });

  claim();
})();
