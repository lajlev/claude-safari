/* Send to Claude — background (MV3, plain JS). */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;

const CLAUDE_URL = "https://claude.ai/new";
const MAX_CHARS = 50000;
const PENDING_TTL_MS = 2 * 60 * 1000;
const KEY_WINDOW = "claudeWindowId"; // window the extension opened
const KEY_TAB = "claudeTabId"; // claude.ai tab the extension last used
const MODE_NEW = "new"; // navigate the Claude tab to /new, then paste
const MODE_ADD = "add"; // paste into the conversation already open
const ADD_RETRIES = 3;
const pendingKey = (tabId) => `pending:${tabId}`;

// Libraries injected into the page before extraction (same tab, same frame,
// same isolated world). See README "Third-party code".
const VENDOR_FILES = [
  "vendor/Readability.js",
  "vendor/turndown.js",
  "vendor/turndown-plugin-gfm.js"
];

// ---------------------------------------------------------------------------
// Runs inside the source page (injected via scripting.executeScript).
// Must be self-contained: no references to outer scope.
// Probe: is there a selection, and are the Markdown libraries already loaded?
function probePage() {
  const sel = window.getSelection ? String(window.getSelection() || "") : "";
  return {
    hasSelection: !!sel.trim(),
    libsLoaded:
      typeof Readability === "function" &&
      typeof TurndownService === "function" &&
      typeof turndownPluginGfm === "object"
  };
}

// Runs inside the source page (injected via scripting.executeScript).
// Must be self-contained: no references to outer scope.
// Selection -> plain text. Full page -> Markdown (Readability + Turndown),
// falling back to plain text if the libraries are missing or anything fails.
function extractPageContext(maxChars) {
  const collapse = (s) =>
    s
      .replace(/ /g, " ")
      .replace(/[ \t\f\v\r]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const plainPageText = () => {
    const pickLargest = (nodes) =>
      [...nodes].sort((a, b) => (b.textContent || "").length - (a.textContent || "").length)[0];
    const root =
      pickLargest(document.querySelectorAll("article")) ||
      document.querySelector("main, [role='main']") ||
      document.body;
    if (!root) return "";
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll(
        "script, style, noscript, template, svg, canvas, iframe, object, embed, " +
          "nav, footer, aside, form, button, select, dialog, " +
          "[role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary'], " +
          "[aria-hidden='true'], [hidden]" +
          (root === document.body ? ", header" : "")
      )
      .forEach((el) => el.remove());
    // Add line breaks after block-level elements so textContent keeps structure.
    clone
      .querySelectorAll(
        "p, div, section, article, li, ul, ol, h1, h2, h3, h4, h5, h6, pre, blockquote, " +
          "tr, table, br, hr, dd, dt, figcaption, header"
      )
      .forEach((el) => el.after(document.createTextNode("\n")));
    return collapse(clone.textContent || "");
  };

  const pageMarkdown = () => {
    if (
      typeof Readability !== "function" ||
      typeof TurndownService !== "function" ||
      typeof turndownPluginGfm !== "object"
    ) {
      return null;
    }
    const base = document.baseURI || location.href;
    const abs = (u) => {
      try { return new URL(u, base).href; } catch { return u; }
    };

    // Work on a clone; never touch the live page.
    const doc = document.cloneNode(true);

    // Drop tracking pixels. The clone has the same element order as the live
    // page, so the live <img> at the same index tells us the rendered size.
    const liveImgs = document.images;
    [...doc.querySelectorAll("img")].forEach((img, i) => {
      const live = liveImgs[i];
      const w = parseInt(img.getAttribute("width"), 10);
      const h = parseInt(img.getAttribute("height"), 10);
      const tinyAttr = (w <= 1 && !isNaN(w)) || (h <= 1 && !isNaN(h));
      const tinyLive = live && live.complete && live.naturalWidth > 0 &&
        live.naturalWidth <= 1 && live.naturalHeight <= 1;
      if (tinyAttr || tinyLive) img.remove();
    });

    // Readability strips class names, so stash the code language first.
    const langOf = (el) => {
      const m = el && /(?:^|\s)(?:language|lang|highlight-source|highlight-text)-([\w+#.-]+)/i.exec(el.getAttribute("class") || "");
      return m ? m[1].toLowerCase() : "";
    };
    doc.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code");
      const lang = langOf(pre) || langOf(code) || langOf(pre.parentElement) ||
        langOf(pre.parentElement && pre.parentElement.parentElement) ||
        (pre.getAttribute("data-lang") || pre.getAttribute("data-language") || "");
      if (lang) pre.setAttribute("data-md-lang", lang);
    });

    const article = new Readability(doc).parse();
    if (!article || !article.content) return null;

    // Parse the article HTML in an inert document (no scripts, no image loads).
    const inert = document.implementation.createHTMLDocument("");
    const container = inert.createElement("div");
    container.innerHTML = article.content;

    // GFM tables need a header row; promote the first row when there is none.
    container.querySelectorAll("table").forEach((table) => {
      const first = table.rows && table.rows[0];
      if (!first || table.tHead || first.querySelector("th")) return;
      [...first.cells].forEach((td) => {
        const th = inert.createElement("th");
        while (td.firstChild) th.appendChild(td.firstChild);
        td.replaceWith(th);
      });
    });

    const td = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      fence: "```",
      emDelimiter: "_",
      strongDelimiter: "**",
      linkStyle: "inlined"
    });
    td.use([turndownPluginGfm.tables, turndownPluginGfm.strikethrough, turndownPluginGfm.taskListItems]);
    td.remove([
      "script", "style", "noscript", "iframe", "svg", "form", "button", "input",
      "select", "textarea", "canvas", "object", "embed", "template", "dialog"
    ]);

    // Rules added later win over the built-in ones.
    td.addRule("absLink", {
      filter: (node) => node.nodeName === "A" && node.getAttribute("href"),
      replacement: (content, node) => {
        const text = content.trim();
        if (!text) return ""; // empty link
        const href = node.getAttribute("href").trim();
        if (/^(javascript|tel|data):/i.test(href)) return content; // not a useful URL
        if (href.startsWith("#")) return content; // in-page anchor
        const title = node.getAttribute("title");
        const t = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
        return `[${text}](${abs(href).replace(/\)/g, "%29").replace(/ /g, "%20")}${t})`;
      }
    });
    td.addRule("absImage", {
      filter: "img",
      replacement: (content, node) => {
        const src = (node.getAttribute("src") || "").trim();
        if (!src || /^data:/i.test(src)) return ""; // placeholders and inline blobs
        const alt = (node.getAttribute("alt") || "").replace(/[\[\]\n]/g, " ").trim();
        return `![${alt}](${abs(src).replace(/\)/g, "%29").replace(/ /g, "%20")})`;
      }
    });
    td.addRule("fencedPre", {
      filter: "pre",
      replacement: (content, node) => {
        const code = (node.textContent || "").replace(/\n$/, "");
        const lang = node.getAttribute("data-md-lang") || langOf(node) || langOf(node.querySelector("code"));
        const longest = Math.max(2, ...((code.match(/`+/g) || []).map((m) => m.length)));
        const fence = "`".repeat(longest + 1);
        return `\n\n${fence}${lang}\n${code}\n${fence}\n\n`;
      }
    });
    td.addRule("tableCellOneLine", {
      filter: ["th", "td"],
      replacement: (content, node) => {
        const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
        const cell = content.replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|").trim();
        return (index === 0 ? "| " : " ") + cell + " |";
      }
    });
    // Like Turndown's listItem, but "- item" / "1. item" instead of "-   item".
    td.addRule("compactListItem", {
      filter: "li",
      replacement: (content, node, options) => {
        const parent = node.parentNode;
        let prefix = options.bulletListMarker + " ";
        if (parent.nodeName === "OL") {
          const start = parent.getAttribute("start");
          const index = Array.prototype.indexOf.call(parent.children, node);
          prefix = (start ? Number(start) + index : index + 1) + ". ";
        }
        const indent = " ".repeat(prefix.length);
        content = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n" + indent);
        return prefix + content + (node.nextSibling && !/\n$/.test(content) ? "\n" : "");
      }
    });

    let md = td
      .turndown(container)
      .replace(/(\S) $/gm, "$1") // stray single trailing spaces (keeps "  " hard breaks)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!md) return null;

    const meta = [];
    if (article.byline) meta.push(`By ${collapse(article.byline)}`);
    if (article.siteName) meta.push(collapse(article.siteName));
    if (article.publishedTime) meta.push(article.publishedTime);
    if (meta.length) md = `_${meta.join(" · ")}_\n\n${md}`;

    return { title: article.title || "", markdown: md };
  };

  let text = "";
  let source = "page";
  let format = "text";
  let title = document.title || "";
  const sel = window.getSelection ? String(window.getSelection() || "") : "";
  if (sel.trim()) {
    text = collapse(sel);
    source = "selection";
  } else {
    let md = null;
    try {
      md = pageMarkdown();
    } catch (e) {
      console.warn("[send-to-claude] markdown extraction failed, using plain text:", e);
      md = null;
    }
    if (md) {
      text = md.markdown;
      format = "markdown";
      if (md.title) title = md.title;
    } else {
      text = plainPageText();
    }
  }

  let truncated = false;
  if (text.length > maxChars) {
    let cut = text.slice(0, maxChars);
    // Prefer a paragraph boundary, then a line boundary, if it doesn't lose too much.
    const para = cut.lastIndexOf("\n\n");
    const line = cut.lastIndexOf("\n");
    if (para > maxChars * 0.8) cut = cut.slice(0, para);
    else if (line > maxChars * 0.8) cut = cut.slice(0, line);
    // Close a code fence left open by the cut.
    if (format === "markdown") {
      const fences = cut.match(/^`{3,}/gm) || [];
      if (fences.length % 2 === 1) cut = cut.trimEnd() + "\n" + fences[fences.length - 1];
    }
    text = cut.trimEnd();
    truncated = true;
  }

  return {
    title,
    url: location.href,
    text,
    source,
    format,
    truncated,
    screen: {
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      availLeft: typeof screen.availLeft === "number" ? screen.availLeft : 0,
      availTop: typeof screen.availTop === "number" ? screen.availTop : 0
    }
  };
}
// ---------------------------------------------------------------------------

function buildContext(ctx) {
  let body = ctx.text || "(no readable content found on this page)";
  if (ctx.truncated) body += `\n\n[Truncated to the first ${MAX_CHARS.toLocaleString("en-US")} characters.]`;
  const label = ctx.source === "selection" ? "Selected text from" : "Context from";
  return `${label}: ${ctx.title || ctx.url}\n${ctx.url}\n\n${body}\n\n---\n`;
}

// Inject Readability/Turndown unless there's a selection (plain text path) or
// they're already loaded. Failures are fine: extraction falls back to text.
async function ensureMarkdownLibs(tabId) {
  try {
    const [probe] = await api.scripting.executeScript({ target: { tabId }, func: probePage });
    const p = probe && probe.result;
    if (!p || p.hasSelection || p.libsLoaded) return;
    await api.scripting.executeScript({ target: { tabId }, files: VENDOR_FILES });
  } catch (e) {
    console.warn("[send-to-claude] could not inject markdown libraries:", e);
  }
}

async function getContext(tab) {
  try {
    await ensureMarkdownLibs(tab.id);
    const [res] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContext,
      args: [MAX_CHARS]
    });
    if (res && res.result) return res.result;
  } catch (e) {
    console.warn("[send-to-claude] extraction failed:", e);
  }
  return { title: tab.title || "", url: tab.url || "", text: "", source: "page", format: "text", truncated: false, screen: null };
}

// --- Tab selection (pure helpers, unit-testable) ----------------------------

function isClaudeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "claude.ai";
  } catch {
    return false;
  }
}

function isConversationUrl(url) {
  return isClaudeUrl(url) && /^\/chat\/[^/]+/.test(new URL(url).pathname);
}

// Order claude.ai tabs by preference: the tab the extension last used, then
// tabs in the window it opened (active one first), then any other claude.ai
// tab, most recently accessed first when `lastAccessed` exists, else in the
// order found. The source tab is never a candidate.
function rankClaudeTabs(tabs, { preferTabId, preferWindowId, excludeTabId } = {}) {
  const tier = (t) =>
    t.id === preferTabId ? 0 : t.windowId === preferWindowId ? (t.active ? 1 : 2) : 3;
  return (tabs || [])
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t && t.id != null && t.id !== excludeTabId && isClaudeUrl(t.url || ""))
    .sort(
      (a, b) =>
        tier(a.t) - tier(b.t) ||
        (b.t.lastAccessed || 0) - (a.t.lastAccessed || 0) ||
        a.i - b.i
    )
    .map(({ t }) => t);
}

// "noop": invoked from claude.ai itself. "new-window": no Claude tab exists.
// "same-window": just activate the tab. "separate": tile both windows.
function placement(sourceTab, claudeTab) {
  if (!sourceTab || isClaudeUrl(sourceTab.url || "")) return "noop";
  if (!claudeTab) return "new-window";
  return claudeTab.windowId === sourceTab.windowId ? "same-window" : "separate";
}

// --- Browser plumbing --------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newSendId() {
  try {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function resolveSourceTab(tab) {
  if (tab && tab.id != null) {
    // Command handlers may get a tab without url; refresh it.
    if (tab.url) return tab;
    try { return await api.tabs.get(tab.id); } catch { return tab; }
  }
  for (const q of [{ active: true, lastFocusedWindow: true }, { active: true, currentWindow: true }]) {
    try {
      const [t] = await api.tabs.query(q);
      if (t) return t;
    } catch {}
  }
  return null;
}

async function findClaudeTab(sourceTab) {
  const stored = await api.storage.local.get([KEY_TAB, KEY_WINDOW]);
  let tabs = [];
  try {
    tabs = await api.tabs.query({});
  } catch (e) {
    console.warn("[send-to-claude] could not list tabs:", e);
  }
  return (
    rankClaudeTabs(tabs, {
      preferTabId: stored[KEY_TAB],
      preferWindowId: stored[KEY_WINDOW],
      excludeTabId: sourceTab && sourceTab.id
    })[0] || null
  );
}

function computeLayout(screenInfo, srcWin) {
  // Prefer the real screen numbers from the page; fall back to the current window's frame.
  const s = screenInfo && screenInfo.availWidth
    ? screenInfo
    : { availLeft: srcWin.left ?? 0, availTop: srcWin.top ?? 0, availWidth: srcWin.width ?? 1440, availHeight: srcWin.height ?? 900 };
  const leftW = Math.round((s.availWidth * 2) / 3);
  return {
    left: { left: s.availLeft, top: s.availTop, width: leftW, height: s.availHeight },
    right: { left: s.availLeft + leftW, top: s.availTop, width: s.availWidth - leftW, height: s.availHeight }
  };
}

async function tileSourceLeft(sourceTab, ctx) {
  const srcWin = await api.windows.get(sourceTab.windowId);
  const layout = computeLayout(ctx.screen, srcWin);
  try {
    await api.windows.update(srcWin.id, { state: "normal", ...layout.left });
  } catch (e) {
    console.warn("[send-to-claude] could not tile source window:", e);
  }
  return layout;
}

// Bring the chosen Claude tab forward. Tile only when it lives in another window.
async function showClaudeTab(sourceTab, claudeTab, ctx, where) {
  try {
    await api.tabs.update(claudeTab.id, { active: true });
  } catch (e) {
    console.warn("[send-to-claude] could not activate Claude tab:", e);
  }
  if (where !== "separate") return;
  const layout = await tileSourceLeft(sourceTab, ctx);
  try {
    await api.windows.update(claudeTab.windowId, { state: "normal", ...layout.right, focused: true });
  } catch (e) {
    console.warn("[send-to-claude] could not tile Claude window:", e);
  }
}

async function setPending(tabId, payload) {
  await api.storage.local.set({ [pendingKey(tabId)]: { ...payload, createdAt: Date.now() } });
}

async function notifyTab(tabId) {
  // Nudge the claude.ai content script; it also claims on load, so failures are fine.
  for (let i = 0; i < 20; i++) {
    try {
      await api.tabs.sendMessage(tabId, { type: "pending-available" });
      return;
    } catch {
      await sleep(500);
    }
  }
}

// Resolves when the tab finishes loading (or after timeoutMs). The listener
// must be attached before the navigation starts.
function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      api.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    api.tabs.onUpdated.addListener(onUpdated);
  });
}

async function openClaudeWindow(sourceTab, ctx, payload) {
  const layout = await tileSourceLeft(sourceTab, ctx);
  const win = await api.windows.create({ url: CLAUDE_URL, type: "normal", focused: true, ...layout.right });
  let t = win.tabs && win.tabs[0];
  if (!t) [t] = await api.tabs.query({ windowId: win.id });
  await api.storage.local.set({ [KEY_WINDOW]: win.id, [KEY_TAB]: t.id });
  await setPending(t.id, payload);
  // Some browsers ignore geometry on create; apply it again.
  try { await api.windows.update(win.id, layout.right); } catch {}
  notifyTab(t.id);
}

// "New chat": load claude.ai/new in the tab; the content script claims the
// pending text on load. Wait for the load before nudging, so the old page
// (which is still running a content script) can't claim it and then unload.
async function newChatInTab(tabId, payload) {
  await setPending(tabId, payload);
  const loaded = waitForTabComplete(tabId);
  await api.tabs.update(tabId, { url: CLAUDE_URL, active: true });
  await loaded;
  notifyTab(tabId);
}

async function trySend(tabId, msg) {
  try {
    const res = await api.tabs.sendMessage(tabId, msg);
    return res === undefined ? null : res; // null = delivered, no useful answer
  } catch {
    return undefined; // no receiver
  }
}

// "Add to current chat": no navigation. Message the running content script.
// Returns false when the tab has no composer (caller then starts a new chat).
async function addToTab(tabId, payload) {
  const msg = { type: "insert", ...payload };
  let res = await trySend(tabId, msg);
  if (res === undefined) {
    // Content script missing (tab opened before the extension was enabled,
    // or Safari unloaded it). Inject it and retry.
    try {
      await api.scripting.executeScript({ target: { tabId }, files: ["claude-inject.js"] });
    } catch (e) {
      console.warn("[send-to-claude] could not inject content script:", e);
    }
    for (let i = 0; i < ADD_RETRIES && res === undefined; i++) {
      await sleep(300);
      res = await trySend(tabId, msg);
    }
  }
  if (res && res.reason === "no-composer") return false;
  if (res !== undefined) return true;
  // Last resort: storage hand-off, claimed when the content script next runs.
  await setPending(tabId, payload);
  notifyTab(tabId);
  return true;
}

// mode: MODE_NEW ("New chat") or MODE_ADD ("Add to current chat").
async function sendToClaude(tab, mode = MODE_NEW) {
  const sourceTab = await resolveSourceTab(tab);
  if (!sourceTab) return { status: "no-tab" };
  // Invoked from claude.ai itself: nothing to send.
  if (isClaudeUrl(sourceTab.url || "")) return { status: "on-claude" };

  const claudeTab = await findClaudeTab(sourceTab);
  const where = placement(sourceTab, claudeTab);
  const ctx = await getContext(sourceTab);
  const payload = { id: newSendId(), text: buildContext(ctx), mode };

  if (where === "new-window") {
    await openClaudeWindow(sourceTab, ctx, payload);
    return { status: "ok", where };
  }

  await showClaudeTab(sourceTab, claudeTab, ctx, where);
  await api.storage.local.set({ [KEY_TAB]: claudeTab.id });

  if (mode === MODE_ADD && (await addToTab(claudeTab.id, payload))) {
    return { status: "ok", where };
  }
  await newChatInTab(claudeTab.id, { ...payload, mode: MODE_NEW });
  return { status: "ok", where };
}

async function popupState(tabId) {
  let tab = null;
  try {
    tab = tabId != null ? await api.tabs.get(tabId) : await resolveSourceTab();
  } catch {}
  if (tab && isClaudeUrl(tab.url || "")) return { onClaude: true };
  const claudeTab = await findClaudeTab(tab);
  return {
    onClaude: false,
    hasClaudeTab: !!claudeTab,
    conversation: !!claudeTab && isConversationUrl(claudeTab.url || ""),
    sameWindow: !!claudeTab && !!tab && claudeTab.windowId === tab.windowId,
    title: claudeTab ? claudeTab.title || "" : ""
  };
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // The claude.ai content script asks for its pending context. Only the tab we
  // opened/reused (matched by sender.tab.id) gets it, and only once.
  if (msg.type === "claim" && sender.tab) {
    const key = pendingKey(sender.tab.id);
    api.storage.local.get(key).then(async (data) => {
      const p = data[key];
      if (!p) return sendResponse({ text: null });
      await api.storage.local.remove(key);
      if (Date.now() - p.createdAt > PENDING_TTL_MS) return sendResponse({ text: null });
      sendResponse({ text: p.text, id: p.id || null, mode: p.mode || MODE_NEW });
    });
    return true; // async response
  }

  // From the popup (an extension page, so no sender.tab).
  if (sender.tab) return;
  if (msg.type === "popup-state") {
    popupState(msg.tabId).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg.type === "send") {
    const mode = msg.mode === MODE_ADD ? MODE_ADD : MODE_NEW;
    // Acknowledge first: the popup closes itself right after.
    sendResponse({ accepted: true });
    (msg.tabId != null ? api.tabs.get(msg.tabId).catch(() => null) : Promise.resolve(null))
      .then((t) => sendToClaude(t, mode))
      .catch((e) => console.warn("[send-to-claude] send failed:", e));
  }
});

// With action.default_popup set, action.onClicked never fires; the toolbar
// button opens popup.html instead. Keyboard commands work independently.
api.commands.onCommand.addListener((command, tab) => {
  if (command === "send-page") sendToClaude(tab, MODE_NEW);
  else if (command === "add-to-chat") sendToClaude(tab, MODE_ADD);
});

api.windows.onRemoved.addListener(async (windowId) => {
  const { [KEY_WINDOW]: id } = await api.storage.local.get(KEY_WINDOW);
  if (id === windowId) await api.storage.local.remove(KEY_WINDOW);
});

api.tabs.onRemoved.addListener(async (tabId) => {
  api.storage.local.remove(pendingKey(tabId));
  const { [KEY_TAB]: id } = await api.storage.local.get(KEY_TAB);
  if (id === tabId) await api.storage.local.remove(KEY_TAB);
});
