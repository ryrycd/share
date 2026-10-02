/* TranScribe shared recording viewer.
 * Link format: …/#<shareId>.<base64url key>[&t=<seconds>]
 * The key never leaves the browser (URL fragments aren't sent to servers). Files in s/<id>/ are AES-256-GCM
 * encrypted: d.bin = deflate-raw JSON (transcript, notes…), a.bin = audio.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SPEAKER_COLORS = ["#3b82f6", "#f97316", "#22c55e", "#ec4899", "#a855f7", "#14b8a6", "#eab308", "#ef4444", "#10b981", "#6366f1"];

  const state = {
    doc: null,
    audioURL: null,
    audioBlob: null,
    words: [],        // { el, start, end } in time order
    current: -1,
    follow: true,
    hits: [],         // [[wordIndexStart, wordIndexEnd]]
    hitIndex: -1,
    shareURL: location.href.split("#")[0],
    fragment: "",
  };

  // ---------- Utilities ----------

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
  }
  function srtTime(sec) {
    const ms = Math.round(sec * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  }
  function parseStamp(text) {
    const p = text.split(":").map(Number);
    return p.some(isNaN) ? null : p.reduce((a, b) => a * 60 + b, 0);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function b64urlToBytes(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 2200);
  }
  async function copy(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(msg);
    } catch {
      prompt("Copy this link:", text);
    }
  }
  function saveFile(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  function safeName(s) {
    return (s || "Recording").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120);
  }
  function fail(title, text) {
    $("loading").hidden = true;
    $("app").hidden = true;
    $("error").hidden = false;
    $("error-title").textContent = title;
    $("error-text").textContent = text;
  }

  // ---------- Crypto ----------

  async function importKey(raw) {
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  }
  async function decrypt(key, buf) {
    const bytes = new Uint8Array(buf);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  }
  async function inflate(buf) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).text();
  }
  async function fetchBytes(url, onProgress) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const total = Number(res.headers.get("content-length")) || 0;
    if (!res.body || !onProgress) return res.arrayBuffer();
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(got, total);
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out.buffer;
  }

  // ---------- Boot ----------

  async function boot() {
    const frag = decodeURIComponent(location.hash.slice(1));
    const [main, ...params] = frag.split("&");
    const dot = main.indexOf(".");
    const id = main.slice(0, dot), keyText = main.slice(dot + 1);
    if (!frag || dot < 1 || !/^[A-Za-z0-9_-]{6,40}$/.test(id) || keyText.length < 40) {
      return fail("This link is incomplete", "Shared links end with a long code after “#”. Make sure you copied the whole link.");
    }
    state.fragment = main;
    const query = Object.fromEntries(params.map((p) => p.split("=")));

    let key;
    try {
      key = await importKey(b64urlToBytes(keyText));
    } catch {
      return fail("This link is incomplete", "The code at the end of the link is damaged. Ask for the link again.");
    }

    let doc;
    try {
      const enc = await fetchBytes(`s/${id}/d.bin`);
      doc = JSON.parse(await inflate(await decrypt(key, enc)));
    } catch (e) {
      if (e.status === 404) {
        return fail("Recording not found", "This share was removed, or it was created moments ago — new links go live within about a minute. Try again shortly.");
      }
      if (e.name === "OperationError") return fail("This link doesn't match", "The link's key can't unlock this recording. Ask for the link again.");
      return fail("Couldn't open this recording", "Check your connection and reload. If it keeps happening, this browser may be too old.");
    }
    state.doc = doc;
    render(doc);
    $("loading").hidden = true;
    $("app").hidden = false;
    if (query.t) seek(Number(query.t), false);

    if (doc.audio) loadAudio(id, key, doc.audio, query.t ? Number(query.t) : 0);
    else document.body.classList.add("no-audio");
    setUpAsk(doc);
  }

  async function loadAudio(id, key, info, startAt) {
    const status = $("audio-status");
    $("play").disabled = true;
    status.textContent = "Loading audio…";
    try {
      const enc = await fetchBytes(`s/${id}/a.bin`, (got, total) => {
        status.textContent = total ? `Loading audio… ${Math.round((got / total) * 100)}%` : `Loading audio… ${(got / 1048576).toFixed(1)} MB`;
        drawWave();
      });
      const plain = await decrypt(key, enc);
      state.audioBlob = new Blob([plain], { type: info.type || "audio/mp4" });
      state.audioURL = URL.createObjectURL(state.audioBlob);
      const audio = $("audio");
      audio.src = state.audioURL;
      audio.addEventListener("loadedmetadata", () => {
        $("duration").textContent = fmt(audio.duration || state.doc.duration);
        if (startAt) audio.currentTime = startAt;
      }, { once: true });
      status.textContent = "";
      $("play").disabled = false;
      $("dl-audio").disabled = false;
    } catch {
      status.textContent = "Audio couldn't be loaded";
    }
  }

  // ---------- Rendering ----------

  function render(doc) {
    document.title = `${doc.title} · TranScribe`;
    $("title").textContent = doc.title;
    const meta = [];
    if (doc.created) meta.push(new Date(doc.created).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }));
    if (doc.duration) meta.push(fmt(doc.duration));
    const spk = Object.keys(doc.speakers || {}).length;
    if (spk > 1) meta.push(`${spk} speakers`);
    $("meta").innerHTML = meta.map(esc).map((m) => `<span>${m}</span>`).join("") +
      (doc.course ? `<span class="chip">${esc(doc.course)}${doc.lesson ? ` · ${esc(doc.lessonLabel || "Lesson")} ${esc(doc.lesson)}` : ""}</span>` : "") +
      (doc.tags || []).map((t) => `<span class="chip">#${esc(t)}</span>`).join("");
    $("duration").textContent = fmt(doc.duration);
    $("dl-audio").disabled = true;
    if (!doc.audio) $("dl-audio").hidden = true;

    if (doc.summaryLine) {
      $("summary").hidden = false;
      $("summary").innerHTML = `<strong>Summary</strong>${esc(doc.summaryLine)}`;
    }
    renderTranscript(doc);
    renderSide(doc);
    drawWave();
  }

  function initials(name) {
    const parts = name.split(/\s+/);
    if (parts[0] === "Speaker" && parts[1]) return parts[1];
    return parts.slice(0, 2).map((p) => p[0] || "").join("").toUpperCase();
  }

  function renderTranscript(doc) {
    const root = $("transcript");
    const frag = document.createDocumentFragment();
    const speakers = doc.speakers || {};
    const showSpeakers = Object.keys(speakers).length > 0;
    state.words = [];

    // Merge consecutive segments by the same speaker into paragraphs.
    const paras = [];
    for (const seg of doc.segments) {
      const last = paras[paras.length - 1];
      if (last && last.sp === seg.sp && seg.s - last.e < 30 && last.segs.length < 8) {
        last.segs.push(seg);
        last.e = seg.e;
      } else {
        paras.push({ sp: seg.sp, s: seg.s, e: seg.e, segs: [seg] });
      }
    }

    for (const p of paras) {
      const div = document.createElement("div");
      div.className = "para" + (showSpeakers && p.sp ? "" : " no-speaker");
      const who = speakers[p.sp];
      if (who) {
        const color = SPEAKER_COLORS[Math.abs(who.color || 0) % SPEAKER_COLORS.length];
        div.innerHTML = `<div class="para-head"><span class="avatar" style="background:${color}">${esc(initials(who.name))}</span>` +
          `<span class="speaker" style="color:${color}">${esc(who.name)}</span></div>`;
      }
      const stamp = document.createElement("button");
      stamp.className = "stamp";
      stamp.textContent = fmt(p.s);
      stamp.dataset.t = p.s;
      div.appendChild(stamp);

      const text = document.createElement("div");
      text.className = "text";
      for (const seg of p.segs) {
        const words = seg.w && seg.w.length ? seg.w : [[seg.t, seg.s, seg.e]];
        for (const [t, s, e] of words) {
          const span = document.createElement("span");
          span.className = "w";
          span.textContent = t.trim();
          span.dataset.i = state.words.length;
          state.words.push({ el: span, start: s, end: e, text: t.trim() });
          text.appendChild(span);
          text.appendChild(document.createTextNode(" "));
        }
      }
      div.appendChild(text);
      frag.appendChild(div);
    }
    if (!paras.length) root.innerHTML = `<p class="empty">This recording has no transcript.</p>`;
    root.appendChild(frag);
  }

  // ---------- Side panel (notes, Q&A, Ask) ----------

  function noteTabs(doc) {
    const tabs = [];
    const order = ["class-notes", "summary"];
    const notes = (doc.notes || []).slice().sort((a, b) => {
      const ia = order.indexOf(a.recipe), ib = order.indexOf(b.recipe);
      return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib);
    });
    for (const n of notes) tabs.push({ id: "n" + tabs.length, title: n.title, render: (el) => (el.innerHTML = `<div class="md">${markdown(n.content)}</div>`) });
    tabs.push({ id: "qa", title: "Q&A", render: renderQA, isQA: true });
    return tabs;
  }

  function renderSide(doc) {
    const tabs = noteTabs(doc);
    state.tabs = tabs;
    const bar = $("side-tabs");
    bar.innerHTML = "";
    tabs.forEach((t, i) => {
      const b = document.createElement("button");
      b.className = "tab";
      b.role = "tab";
      b.textContent = t.title;
      b.setAttribute("aria-selected", i === 0 ? "true" : "false");
      b.onclick = () => selectTab(i);
      bar.appendChild(b);
    });
    $("mobile-side-tab").textContent = (doc.notes || []).length ? "Notes" : "Q&A";
    selectTab(0);
  }

  function selectTab(i) {
    state.tab = i;
    [...$("side-tabs").children].forEach((b, j) => b.setAttribute("aria-selected", j === i ? "true" : "false"));
    const el = $("side-content");
    el.innerHTML = "";
    state.tabs[i].render(el);
  }

  function renderQA(el) {
    const doc = state.doc;
    let html = "";
    if (state.ask) {
      html += `<form class="ask-box" id="ask-form"><input id="ask-input" placeholder="Ask about this recording…" autocomplete="off"><button class="btn primary">Ask</button></form>` +
        `<p class="ask-note">Answered by AI built into your browser, privately on this device. It can make mistakes.</p><div id="ask-thread"></div>`;
    }
    const qa = doc.qa || [];
    if (qa.length) html += qa.map((x) => `<div class="qa"><div class="q">${esc(x.q)}</div><div class="md">${markdown(x.a)}</div></div>`).join("");
    if (!qa.length && !state.ask) html += `<p class="empty">No questions were shared with this recording.</p>`;
    el.innerHTML = html;
    if (state.ask) {
      $("ask-form").onsubmit = (e) => { e.preventDefault(); ask($("ask-input").value); };
      const thread = $("ask-thread");
      for (const item of state.askThread) thread.appendChild(item);
    }
  }

  // Inline + block Markdown (headings, lists, tasks, quotes, bold/italic/code, links) with clickable [mm:ss].
  function inline(s) {
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out = out.replace(/\[?\b(\d{1,2}:\d{2}(?::\d{2})?)\b\]?/g, (m, ts) => {
      const t = parseStamp(ts);
      return t == null ? m : `<a class="ts" data-t="${t}">${ts}</a>`;
    });
    return out;
  }
  function markdown(src) {
    const lines = String(src || "").replace(/\r/g, "").split("\n");
    let html = "", list = null, para = [];
    const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(" "))}</p>`; para = []; } };
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("```")) { flushPara(); closeList(); continue; }
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); closeList(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; continue; }
      if (/^(---|\*\*\*)$/.test(line)) { flushPara(); closeList(); html += "<hr>"; continue; }
      if ((m = line.match(/^[-*•]\s+\[([ xX])\]\s+(.*)$/))) {
        flushPara(); if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
        html += `<li class="task"><span>${m[1] === " " ? "☐" : "☑"}</span><span>${inline(m[2])}</span></li>`; continue;
      }
      if ((m = line.match(/^[-*•]\s+(.*)$/))) { flushPara(); if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; continue; }
      if ((m = line.match(/^\d+[.)]\s+(.*)$/))) { flushPara(); if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; continue; }
      if (line.startsWith(">")) { flushPara(); closeList(); html += `<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`; continue; }
      closeList();
      para.push(line);
    }
    flushPara(); closeList();
    return html;
  }

  // ---------- Browser AI (Chrome/Edge built-in model), if available ----------

  state.askThread = [];
  async function setUpAsk(doc) {
    try {
      if (!("LanguageModel" in self)) return;
      const availability = await self.LanguageModel.availability();
      if (availability === "unavailable") return;
      state.ask = true;
      if (state.tabs && state.tabs[state.tab]?.isQA) selectTab(state.tab);
    } catch { /* not supported */ }
  }

  function chunks() {
    if (state.chunkCache) return state.chunkCache;
    const out = [];
    const speakers = state.doc.speakers || {};
    let cur = null;
    for (const seg of state.doc.segments) {
      const name = speakers[seg.sp]?.name;
      const line = `[${fmt(seg.s)}] ${name ? name + ": " : ""}${seg.t}`;
      if (!cur || cur.words > 140) { cur = { text: "", words: 0, start: seg.s }; out.push(cur); }
      cur.text += line + "\n";
      cur.words += seg.t.split(/\s+/).length;
    }
    return (state.chunkCache = out);
  }

  function retrieve(question, budgetWords) {
    const terms = question.toLowerCase().match(/[a-z0-9']{3,}/g) || [];
    const all = chunks();
    const df = {};
    for (const c of all) {
      const seen = new Set(c.text.toLowerCase().match(/[a-z0-9']{3,}/g) || []);
      for (const t of seen) df[t] = (df[t] || 0) + 1;
    }
    const scored = all.map((c, i) => {
      const words = c.text.toLowerCase().match(/[a-z0-9']{3,}/g) || [];
      let score = 0;
      for (const t of terms) {
        const tf = words.filter((w) => w === t || w.startsWith(t)).length;
        if (tf) score += (1 + Math.log(tf)) * Math.log(1 + all.length / (df[t] || 1));
      }
      return { i, score };
    }).sort((a, b) => b.score - a.score);
    const picked = [];
    let used = 0;
    for (const s of scored) {
      if (used + all[s.i].words > budgetWords) continue;
      picked.push(s.i);
      used += all[s.i].words;
    }
    return picked.sort((a, b) => a - b).map((i) => all[i].text).join("…\n");
  }

  async function ask(question) {
    question = (question || "").trim();
    if (!question) return;
    $("ask-input").value = "";
    const wrap = document.createElement("div");
    wrap.className = "qa";
    wrap.innerHTML = `<div class="q">${esc(question)}</div><div class="md answer streaming"></div>`;
    state.askThread.unshift(wrap);
    $("ask-thread").prepend(wrap);
    const out = wrap.querySelector(".answer");
    try {
      const doc = state.doc;
      const notes = (doc.notes || []).find((n) => n.recipe === "class-notes" || n.recipe === "summary");
      if (!state.session) {
        out.textContent = "Starting your browser's AI…";
        state.session = await self.LanguageModel.create({
          initialPrompts: [{ role: "system", content:
            "You answer questions about one recording using only the transcript excerpts and notes provided. " +
            "Be concise. Cite moments with timestamps like [12:34]. If the excerpts don't contain the answer, say so." }],
          monitor(m) {
            m.addEventListener("downloadprogress", (e) => {
              out.textContent = `Downloading your browser's AI model (one time)… ${Math.round((e.loaded || 0) * 100)}%`;
            });
          },
        });
      }
      const session = state.session;
      // Fit the prompt to this browser's context window (it varies by model and device).
      const windowSize = session.contextWindow ?? session.inputQuota ?? 4000;
      const used = session.contextUsage ?? session.inputUsage ?? 0;
      const measure = async (p) => {
        const fn = session.measureContextUsage || session.measureInputUsage;
        return fn ? fn.call(session, p) : p.length / 4;
      };
      const full = chunks().reduce((a, c) => a + c.words, 0);
      const build = (budget) => {
        const context = full <= budget ? chunks().map((c) => c.text).join("") : retrieve(question, budget);
        const noteText = notes ? notes.content.slice(0, Math.max(0, budget * 2)) : "";
        return `Recording: "${doc.title}"\n${noteText ? "Notes:\n" + noteText + "\n\n" : ""}Transcript excerpts:\n${context}\n\nQuestion: ${question}`;
      };
      let budget = Math.min(1500, Math.floor(windowSize * 0.45));
      let prompt = build(budget);
      while (budget > 60 && (await measure(prompt)) > windowSize - used - 300) {
        budget = Math.floor(budget * 0.6);
        prompt = build(budget);
      }
      if ((await measure(prompt)) > windowSize - used - 100) {
        throw new Error("your browser's built-in AI has too little memory for this question");
      }
      let text = "";
      const stream = session.promptStreaming(prompt);
      for await (const chunk of stream) {
        text = chunk.startsWith(text) ? chunk : text + chunk;
        out.innerHTML = markdown(text);
      }
      out.classList.remove("streaming");
      // Fresh context for the next question (each answer re-reads the relevant excerpts).
      state.session.destroy?.();
      state.session = null;
    } catch (e) {
      state.session?.destroy?.();
      state.session = null;
      out.classList.remove("streaming");
      out.innerHTML = `<p class="empty">Couldn't answer: ${esc(e.message || "the browser's AI isn't ready yet")}.</p>`;
    }
  }

  // ---------- Playback ----------

  const audio = $("audio");

  function seek(t, play = true) {
    if (!isFinite(t)) return;
    if (audio.src) {
      audio.currentTime = Math.max(0, t);
      if (play) audio.play().catch(() => {});
    }
    state.follow = true;
    $("follow").hidden = true;
    highlightAt(t, true);
  }

  function indexAt(t) {
    const w = state.words;
    let lo = 0, hi = w.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (w[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function highlightAt(t, forceScroll) {
    const i = indexAt(t + 0.05);
    if (i !== state.current) {
      if (state.current >= 0) state.words[state.current]?.el.classList.remove("now");
      state.current = i;
      if (i >= 0) {
        const el = state.words[i].el;
        el.classList.add("now");
        if (state.follow || forceScroll) scrollIntoViewIfNeeded(el, forceScroll);
      }
    }
    $("time").textContent = fmt(t);
    drawWave();
  }

  let programmaticScroll = false;
  function scrollIntoViewIfNeeded(el, center) {
    const pane = $("pane-transcript");
    const r = el.getBoundingClientRect(), pr = pane.getBoundingClientRect();
    if (center || r.top < pr.top + 80 || r.bottom > pr.bottom - 60) {
      programmaticScroll = true;
      el.scrollIntoView({ block: "center", behavior: center ? "auto" : "smooth" });
      setTimeout(() => (programmaticScroll = false), 600);
    }
  }

  function tick() {
    if (!audio.paused) highlightAt(audio.currentTime);
    requestAnimationFrame(tick);
  }

  // ---------- Waveform ----------

  function drawWave() {
    const c = $("wave");
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const peaks = state.doc?.peaks || [];
    const dur = audio.duration || state.doc?.duration || 1;
    const progress = (audio.src ? audio.currentTime : (state.current >= 0 ? state.words[state.current].start : 0)) / dur;
    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue("--accent").trim();
    const dim = styles.getPropertyValue("--line").trim();
    const bars = Math.max(20, Math.floor(w / 3));
    for (let i = 0; i < bars; i++) {
      const p = peaks.length ? peaks[Math.floor((i / bars) * peaks.length)] / 255 : 0.3;
      const bh = Math.max(2, p * (h - 6));
      ctx.fillStyle = i / bars <= progress ? accent : dim;
      ctx.fillRect(i * 3, (h - bh) / 2, 2, bh);
    }
  }

  function seekFromPointer(e) {
    const c = $("wave");
    const r = c.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    seek(frac * (audio.duration || state.doc.duration), !audio.paused);
  }

  // ---------- Search ----------

  function runSearch(q) {
    for (const [a, b] of state.hits) for (let i = a; i <= b; i++) state.words[i].el.classList.remove("hit", "hit-current");
    state.hits = [];
    state.hitIndex = -1;
    q = q.trim().toLowerCase();
    if (!q) { $("search-count").textContent = ""; return; }
    // Build a normalized string of all words with offsets → word index.
    if (!state.searchIndex) {
      let text = "";
      const starts = [];
      state.words.forEach((w, i) => { starts.push(text.length); text += w.text.toLowerCase() + " "; });
      state.searchIndex = { text, starts };
    }
    const { text, starts } = state.searchIndex;
    const wordAt = (pos) => {
      let lo = 0, hi = starts.length - 1, ans = 0;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      return ans;
    };
    let pos = text.indexOf(q);
    while (pos !== -1 && state.hits.length < 2000) {
      state.hits.push([wordAt(pos), wordAt(pos + q.length - 1)]);
      pos = text.indexOf(q, pos + q.length);
    }
    for (const [a, b] of state.hits) for (let i = a; i <= b; i++) state.words[i].el.classList.add("hit");
    if (state.hits.length) {
      // Start at the first match after the playhead.
      const now = audio.currentTime || 0;
      const next = state.hits.findIndex(([a]) => state.words[a].start >= now);
      gotoHit(next >= 0 ? next : 0);
    } else {
      $("search-count").textContent = "No matches";
    }
  }

  function gotoHit(i) {
    if (!state.hits.length) return;
    if (state.hitIndex >= 0) { const [a, b] = state.hits[state.hitIndex]; for (let k = a; k <= b; k++) state.words[k].el.classList.remove("hit-current"); }
    state.hitIndex = (i + state.hits.length) % state.hits.length;
    const [a, b] = state.hits[state.hitIndex];
    for (let k = a; k <= b; k++) state.words[k].el.classList.add("hit-current");
    state.follow = false;
    programmaticScroll = true;
    state.words[a].el.scrollIntoView({ block: "center" });
    setTimeout(() => (programmaticScroll = false), 300);
    $("search-count").textContent = `${state.hitIndex + 1} of ${state.hits.length}`;
    if (!audio.paused) $("follow").hidden = false;
  }

  // ---------- Downloads ----------

  function transcriptLines(withTimes) {
    const speakers = state.doc.speakers || {};
    return state.doc.segments.map((s) => `${withTimes ? `[${fmt(s.s)}] ` : ""}${speakers[s.sp] ? speakers[s.sp].name + ": " : ""}${s.t}`);
  }
  function download(kind) {
    const doc = state.doc, name = safeName(doc.title);
    if (kind === "audio" && state.audioBlob) {
      const ext = (doc.audio?.type || "").includes("mp4") ? "m4a" : "audio";
      return saveFile(state.audioBlob, `${name}.${ext}`);
    }
    if (kind === "txt") return saveFile(new Blob([`${doc.title}\n\n${transcriptLines(true).join("\n")}\n`], { type: "text/plain" }), `${name}.txt`);
    if (kind === "srt") {
      const speakers = doc.speakers || {};
      const body = doc.segments.map((s, i) => `${i + 1}\n${srtTime(s.s)} --> ${srtTime(s.e)}\n${speakers[s.sp] ? speakers[s.sp].name + ": " : ""}${s.t}\n`).join("\n");
      return saveFile(new Blob([body], { type: "application/x-subrip" }), `${name}.srt`);
    }
    if (kind === "md") {
      let md = `# ${doc.title}\n\n`;
      if (doc.summaryLine) md += `> ${doc.summaryLine}\n\n`;
      for (const n of doc.notes || []) md += `## ${n.title}\n\n${n.content.trim()}\n\n`;
      md += `## Transcript\n\n${transcriptLines(true).join("\n\n")}\n`;
      return saveFile(new Blob([md], { type: "text/markdown" }), `${name}.md`);
    }
    if (kind === "print") window.print();
  }

  // Print every note, not just the open tab.
  window.addEventListener("beforeprint", () => {
    if (!state.doc) return;
    $("side-content").innerHTML = (state.doc.notes || []).map((n) => `<h2>${esc(n.title)}</h2><div class="md">${markdown(n.content)}</div>`).join("");
  });
  window.addEventListener("afterprint", () => state.tabs && selectTab(state.tab || 0));

  // ---------- Events ----------

  function wire() {
    $("transcript").addEventListener("click", (e) => {
      const w = e.target.closest(".w");
      if (w && !window.getSelection().toString()) seek(state.words[+w.dataset.i].start);
    });
    document.addEventListener("click", (e) => {
      const st = e.target.closest(".stamp, a.ts");
      if (st) { e.preventDefault(); seek(Number(st.dataset.t)); if (window.innerWidth <= 860) showPane("transcript"); }
      const menu = $("download-menu");
      if (!e.target.closest(".menu-wrap") && !menu.hidden) { menu.hidden = true; $("download-btn").setAttribute("aria-expanded", "false"); }
    });

    $("play").onclick = () => (audio.paused ? audio.play() : audio.pause());
    $("back").onclick = () => seek(audio.currentTime - 15, !audio.paused);
    $("fwd").onclick = () => seek(audio.currentTime + 15, !audio.paused);
    $("speed").onchange = (e) => (audio.playbackRate = Number(e.target.value));
    audio.addEventListener("play", () => { $("icon-play").hidden = true; $("icon-pause").hidden = false; $("play").setAttribute("aria-label", "Pause"); });
    audio.addEventListener("pause", () => { $("icon-play").hidden = false; $("icon-pause").hidden = true; $("play").setAttribute("aria-label", "Play"); highlightAt(audio.currentTime); });
    audio.addEventListener("seeked", () => highlightAt(audio.currentTime));

    const wave = $("wave");
    let dragging = false;
    wave.addEventListener("pointerdown", (e) => { if (!audio.src) return; dragging = true; wave.setPointerCapture(e.pointerId); seekFromPointer(e); });
    wave.addEventListener("pointermove", (e) => dragging && seekFromPointer(e));
    wave.addEventListener("pointerup", () => (dragging = false));
    wave.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { seek(audio.currentTime - 5, !audio.paused); e.preventDefault(); }
      if (e.key === "ArrowRight") { seek(audio.currentTime + 5, !audio.paused); e.preventDefault(); }
    });
    window.addEventListener("resize", drawWave);

    const pane = $("pane-transcript");
    pane.addEventListener("scroll", () => {
      if (programmaticScroll || audio.paused) return;
      state.follow = false;
      $("follow").hidden = false;
    }, { passive: true });
    $("follow").onclick = () => {
      state.follow = true;
      $("follow").hidden = true;
      if (state.current >= 0) scrollIntoViewIfNeeded(state.words[state.current].el, true);
    };

    let searchTimer;
    $("search").addEventListener("input", (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(e.target.value), 120); });
    $("search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); gotoHit(state.hitIndex + (e.shiftKey ? -1 : 1)); }
      if (e.key === "Escape") { e.target.value = ""; runSearch(""); e.target.blur(); }
    });
    $("search-next").onclick = () => gotoHit(state.hitIndex + 1);
    $("search-prev").onclick = () => gotoHit(state.hitIndex - 1);

    $("download-btn").onclick = () => {
      const m = $("download-menu");
      m.hidden = !m.hidden;
      $("download-btn").setAttribute("aria-expanded", String(!m.hidden));
    };
    $("download-menu").addEventListener("click", (e) => {
      const b = e.target.closest("[data-dl]");
      if (!b || b.disabled) return;
      $("download-menu").hidden = true;
      download(b.dataset.dl);
    });
    $("copy-link").onclick = () => copy(`${state.shareURL}#${state.fragment}`, "Link copied");
    $("copy-time").onclick = () => {
      const t = Math.floor(audio.currentTime || 0);
      copy(`${state.shareURL}#${state.fragment}&t=${t}`, `Link to ${fmt(t)} copied`);
    };

    document.querySelectorAll(".mobile-tabs button").forEach((b) => (b.onclick = () => showPane(b.dataset.pane)));

    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); showPane("transcript"); $("search").focus(); $("search").select(); return; }
      if (typing) return;
      if (e.key === " " && audio.src) { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
      else if (e.key === "/") { e.preventDefault(); $("search").focus(); }
      else if (e.key === "ArrowLeft" && audio.src) { seek(audio.currentTime - 5, !audio.paused); }
      else if (e.key === "ArrowRight" && audio.src) { seek(audio.currentTime + 5, !audio.paused); }
    });
    window.addEventListener("hashchange", () => location.reload());
  }

  function showPane(which) {
    document.querySelectorAll(".mobile-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.pane === which)));
    $("pane-transcript").classList.toggle("active", which === "transcript");
    $("pane-side").classList.toggle("active", which === "side");
  }

  if (!window.crypto?.subtle || typeof DecompressionStream === "undefined") {
    fail("Please update your browser", "This page needs a recent version of Safari, Chrome, Edge or Firefox.");
    return;
  }
  wire();
  requestAnimationFrame(tick);
  boot();
})();
