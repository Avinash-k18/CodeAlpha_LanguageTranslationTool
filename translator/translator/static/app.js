(() => {
  const $ = id => document.getElementById(id);
  const el = {src: $("src"), tgt: $("tgt"), input: $("input"), output: $("output"), go: $("go"),
    count: $("count"), banner: $("banner"), detected: $("detected"), note: $("note"),
    copy: $("copy"), speak: $("speak"), swap: $("swap"), clear: $("clear"),
    hw: $("history-wrap"), hist: $("history"), clearHist: $("clear-hist")};
  const MAX = 5000, PLACEHOLDER = "Your translation will appear here.";
  let langs = {}, controller = null, lastTranslation = "", lastTarget = "en";

  const showBanner = (msg, info = false) => { el.banner.textContent = msg; el.banner.className = info ? "info" : ""; el.banner.hidden = false; };
  const hideBanner = () => { el.banner.hidden = true; };
  const store = {
    get() { try { return JSON.parse(localStorage.getItem("bridge-history")) || []; } catch { return []; } },
    set(v) { try { localStorage.setItem("bridge-history", JSON.stringify(v)); } catch {} }
  };

  async function init() {
    try {
      const r = await fetch("/api/languages");
      if (!r.ok) throw 0;
      (await r.json()).languages.forEach(l => langs[l.code] = l.name);
    } catch { showBanner("Could not load languages. Check that the server is running and reload."); el.go.disabled = true; return; }
    el.src.add(new Option("Detect language", "auto"));
    Object.entries(langs).forEach(([c, n]) => { el.src.add(new Option(n, c)); el.tgt.add(new Option(n, c)); });
    el.tgt.value = "hi";
    if (!("speechSynthesis" in window)) el.speak.hidden = true;
    resetOutput(); updateUI(); renderHistory();
  }

  function resetOutput() { el.output.textContent = PLACEHOLDER; el.output.className = "empty"; lastTranslation = ""; el.note.textContent = ""; }
  function updateUI() {
    const n = el.input.value.length;
    el.count.textContent = `${n} / ${MAX}`;
    el.go.disabled = !el.input.value.trim();
    el.swap.disabled = el.src.value === "auto";
    el.copy.disabled = el.speak.disabled = !lastTranslation;
    el.clear.disabled = n === 0;
  }

  async function translate() {
    hideBanner();
    const text = el.input.value.trim();
    if (!text) return showBanner("Enter some text to translate.");
    if (text.length > MAX) return showBanner(`Text is too long. Limit is ${MAX} characters.`);
    if (!navigator.onLine) return showBanner("You are offline. Reconnect and try again.");
    if (controller) controller.abort();
    controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), 25000);
    el.go.disabled = true; el.go.textContent = "Translating…";
    el.output.className = "loading"; el.detected.textContent = ""; el.note.textContent = "";
    try {
      const res = await fetch("/api/translate", {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({text, source: el.src.value, target: el.tgt.value}), signal: controller.signal});
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok) throw new Error(data.error || `Server error (${res.status}). Please try again.`);
      lastTranslation = data.translation; lastTarget = el.tgt.value;
      el.output.textContent = data.translation; el.output.className = "";
      if (data.detected && el.src.value === "auto") el.detected.textContent = `Detected: ${langs[data.detected]}`;
      if (data.note) el.note.textContent = data.note;
      saveHistory(text, data.translation);
    } catch (e) {
      if (e.name === "AbortError" && controller.signal.reason !== "timeout") return; // replaced by newer request
      resetOutput();
      showBanner(e.name === "AbortError" ? "The request took too long. Please try again."
        : e instanceof TypeError ? "Cannot reach the server. Check your connection." : e.message);
    } finally {
      clearTimeout(timer); el.go.textContent = "Translate"; updateUI();
      if (el.output.className === "loading") el.output.className = "";
    }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(lastTranslation); }
    catch { const t = document.createElement("textarea"); t.value = lastTranslation; document.body.append(t); t.select();
      try { document.execCommand("copy"); } catch { return showBanner("Copy failed. Select the text and copy it manually."); } t.remove(); }
    el.copy.textContent = "Copied"; setTimeout(() => el.copy.textContent = "Copy translation", 1500);
  }

  function speak() {
    const s = window.speechSynthesis;
    if (s.speaking) { s.cancel(); el.speak.textContent = "Listen"; return; }
    const u = new SpeechSynthesisUtterance(lastTranslation);
    u.lang = lastTarget;
    const hasVoice = s.getVoices().some(v => v.lang.toLowerCase().startsWith(lastTarget));
    if (s.getVoices().length && !hasVoice) showBanner(`Your device has no ${langs[lastTarget]} voice installed. Audio may not play.`, true);
    u.onend = u.onerror = () => el.speak.textContent = "Listen";
    el.speak.textContent = "Stop"; s.speak(u);
  }

  function swap() {
    if (el.src.value === "auto") return;
    [el.src.value, el.tgt.value] = [el.tgt.value, el.src.value];
    if (lastTranslation) { el.input.value = lastTranslation; resetOutput(); }
    updateUI(); if (el.input.value.trim()) translate();
  }

  function saveHistory(from, to) {
    const h = store.get().filter(i => i.from !== from || i.tgt !== el.tgt.value);
    h.unshift({from, to, src: el.src.value, tgt: el.tgt.value});
    store.set(h.slice(0, 5)); renderHistory();
  }
  function renderHistory() {
    const h = store.get(); el.hw.hidden = !h.length; el.hist.replaceChildren();
    h.forEach(i => {
      const li = document.createElement("li"), b = document.createElement("button"), a = document.createElement("span"), s = document.createElement("small");
      b.type = "button"; a.textContent = i.from; s.textContent = `${i.to} · ${langs[i.src] || "Detect language"} to ${langs[i.tgt] || i.tgt}`;
      b.append(a, s); b.onclick = () => { el.input.value = i.from; el.src.value = i.src in langs || i.src === "auto" ? i.src : "auto"; el.tgt.value = i.tgt; updateUI(); translate(); };
      li.append(b); el.hist.append(li);
    });
  }

  el.input.addEventListener("input", () => { updateUI(); });
  el.input.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (!el.go.disabled) translate(); } });
  el.input.addEventListener("paste", () => setTimeout(() => {   // pasted text longer than limit
    if (el.input.value.length > MAX) { el.input.value = el.input.value.slice(0, MAX); showBanner(`Pasted text was cut to ${MAX} characters.`, true); updateUI(); } }));
  el.go.onclick = translate; el.copy.onclick = copy; el.speak.onclick = speak; el.swap.onclick = swap;
  el.clear.onclick = () => { el.input.value = ""; resetOutput(); hideBanner(); el.detected.textContent = ""; updateUI(); el.input.focus(); };
  el.clearHist.onclick = () => { store.set([]); renderHistory(); };
  el.src.onchange = el.tgt.onchange = () => { updateUI(); if (el.input.value.trim() && lastTranslation) translate(); };
  window.addEventListener("offline", () => showBanner("You are offline. Translation needs an internet connection."));
  window.addEventListener("online", hideBanner);
  init();
})();
