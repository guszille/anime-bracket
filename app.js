/* ============================================================
   Anime Bracket — vanilla JS tournament manager
   State lives in `state`, persists to localStorage.
   Data from Jikan v4 (unofficial MyAnimeList API, no key).
   ============================================================ */

const STORAGE_KEY = "anime-bracket-v1";
const JIKAN = "https://api.jikan.moe/v4";

/* ---------- State ---------- */
const state = {
  view: "setup",
  roster: [],        // [{ id, name, img, synopsis, year, type }]
  rounds: [],        // [[match, ...], ...]  -> bracket engine output
  activeMatch: null, // {round, index} currently being voted
};

function defaultMatch(id, round, index) {
  return { id, round, index, a: null, b: null, votes: [0, 0], winner: null };
}

/* ---------- Persistence ---------- */
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    roster: state.roster,
    rounds: state.rounds,
    activeMatch: state.activeMatch,
  }));
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    state.roster = d.roster || [];
    state.rounds = d.rounds || [];
    state.activeMatch = d.activeMatch || null;
  } catch (e) { /* ignore corrupt save */ }
}

/* ============================================================
   Jikan API — throttled search with a tiny in-memory cache
   ============================================================ */
const searchCache = new Map();
let lastFetch = 0;
const MIN_GAP = 600; // ms between requests (Jikan ~3 req/s, stay safe)

async function throttle() {
  const wait = MIN_GAP - (Date.now() - lastFetch);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastFetch = Date.now();
}

/* ---------- API availability ----------
   "online"  = Jikan returned usable results.
   "offline" = Jikan can't serve results right now, for any reason: no network,
               a server error (5xx), or rate limiting (429). In every one of
               those cases the user is blocked, so we offer manual entry. */
let apiStatus = "unknown";
let apiReason = "";   // "network" | "server" | "rate" — drives the banner wording
let manualMode = false;

function markApiDown(reason) {
  apiStatus = "offline";
  apiReason = reason;
  renderApiBanner();
}

// Translate a failed search/health request into a reason code.
function reasonFor(err) {
  if (err instanceof TypeError) return "network";      // never reached Jikan
  if (err && err.status === 429) return "rate";
  return "server";
}

async function checkApiHealth() {
  if (navigator.onLine === false) { markApiDown("network"); return apiStatus; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${JIKAN}/anime?q=one&limit=1`, { signal: ctrl.signal });
    if (!res.ok) { markApiDown(res.status === 429 ? "rate" : "server"); return apiStatus; }
    apiStatus = "online";
    apiReason = "";
    renderApiBanner();
  } catch (err) {
    markApiDown(err.name === "AbortError" ? "server" : reasonFor(err));
  } finally {
    clearTimeout(timer);
  }
  return apiStatus;
}

async function searchAnime(query) {
  const key = query.toLowerCase().trim();
  if (searchCache.has(key)) return searchCache.get(key);
  await throttle();
  const url = `${JIKAN}/anime?q=${encodeURIComponent(query)}&limit=12&sfw=true&order_by=members&sort=desc`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`Jikan ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const items = (json.data || []).map(a => ({
    id: a.mal_id,
    name: a.title_english || a.title,
    img: a.images?.jpg?.image_url || "",
    synopsis: a.synopsis || "No synopsis available.",
    year: a.year || a.aired?.prop?.from?.year || "",
    type: a.type || "",
    episodes: a.episodes || null,
  }));
  searchCache.set(key, items);
  return items;
}

/* ============================================================
   Bracket engine — single elimination with seeded byes
   ============================================================ */

// Standard seed positions for a bracket of `size` (power of 2).
// Returns 1-based seed order, e.g. size 4 -> [1,4,3,2].
function seedOrder(size) {
  let seeds = [1, 2];
  while (seeds.length < size) {
    const len = seeds.length * 2 + 1;
    const next = [];
    for (const s of seeds) { next.push(s); next.push(len - s); }
    seeds = next;
  }
  return seeds;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Build all rounds. Round 0 is seeded from roster; later rounds start empty
// and get filled as winners are decided. Byes auto-advance immediately.
function buildBracket() {
  const n = state.roster.length;
  const size = nextPow2(n);
  const order = seedOrder(size);
  const totalRounds = Math.log2(size);

  const rounds = [];
  for (let r = 0; r < totalRounds; r++) {
    const matchCount = size / Math.pow(2, r + 1);
    rounds.push(Array.from({ length: matchCount }, (_, i) => defaultMatch(`r${r}m${i}`, r, i)));
  }

  // Seed round 0: pair up the seed order two at a time.
  rounds[0].forEach((m, i) => {
    const seedA = order[i * 2];
    const seedB = order[i * 2 + 1];
    m.a = seedA <= n ? state.roster[seedA - 1].id : null; // null = bye slot
    m.b = seedB <= n ? state.roster[seedB - 1].id : null;
  });

  state.rounds = rounds;

  // Auto-resolve byes (a match where exactly one slot is empty).
  rounds[0].forEach(m => {
    if (m.a && !m.b) resolveWinner(m, m.a);
    else if (!m.a && m.b) resolveWinner(m, m.b);
  });

  state.activeMatch = firstLiveMatch();
}

function getMatch(round, index) {
  return state.rounds[round]?.[index] || null;
}

// A match is "live" (votable) once both competitors are present and no winner yet.
function isLive(m) { return m && m.a && m.b && !m.winner; }

function firstLiveMatch() {
  for (let r = 0; r < state.rounds.length; r++) {
    for (let i = 0; i < state.rounds[r].length; i++) {
      if (isLive(state.rounds[r][i])) return { round: r, index: i };
    }
  }
  return null;
}

// Set a winner and propagate them into the parent match slot.
function resolveWinner(match, winnerId) {
  match.winner = winnerId;
  const parentRound = match.round + 1;
  if (parentRound < state.rounds.length) {
    const parentIndex = Math.floor(match.index / 2);
    const slot = match.index % 2 === 0 ? "a" : "b";
    const parent = state.rounds[parentRound][parentIndex];
    parent[slot] = winnerId;
  }
}

function tournamentChampion() {
  const final = state.rounds[state.rounds.length - 1]?.[0];
  return final?.winner || null;
}

/* ---------- Roster helpers ---------- */
function byId(id) { return state.roster.find(c => c.id === id); }

function addToRoster(item) {
  if (state.roster.some(c => c.id === item.id)) return;
  state.roster.push(item);
  save();
  renderRoster();
  renderResults(lastResults);
}
function removeFromRoster(id) {
  state.roster = state.roster.filter(c => c.id !== id);
  save();
  renderRoster();
  renderResults(lastResults);
}

/* ============================================================
   Rendering
   ============================================================ */
const $ = sel => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function imgTag(src, cls) {
  return src
    ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'${cls} placeholder-img',textContent:'no image'}))" />`
    : `<div class="${cls} placeholder-img">no image</div>`;
}

/* ---- View switching ---- */
function setView(view) {
  if (view === "vote" && !state.activeMatch) view = tournamentChampion() ? "champion" : "bracket";
  state.view = view;
  document.querySelectorAll(".view").forEach(s => { s.hidden = s.dataset.view !== view; });
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
  if (view === "setup") { renderRoster(); renderResults(lastResults); }
  if (view === "bracket") renderBracket();
  if (view === "vote") renderVote();
  if (view === "champion") renderChampion();
  updateNav();
}

function updateNav() {
  const hasBracket = state.rounds.length > 0;
  $("#nav").querySelector('[data-view="bracket"]').disabled = !hasBracket;
  $("#nav").querySelector('[data-view="vote"]').disabled = !hasBracket;
}

/* ---- Setup: API status banner ---- */
function renderApiBanner() {
  const banner = $("#apiBanner");
  if (apiStatus !== "offline") { banner.hidden = true; return; }
  banner.hidden = false;
  banner.classList.toggle("compact", manualMode);
  const headline = {
    network: "Can't reach MyAnimeList.",
    rate: "MyAnimeList is rate-limiting requests.",
    server: "MyAnimeList is having server problems.",
  }[apiReason] || "MyAnimeList search is unavailable.";
  $("#apiMsg").innerHTML = manualMode
    ? `<strong>Manual mode.</strong> Search is unavailable — competitors are added by name.`
    : `<strong>${headline}</strong> Proceed without it and add competitors by name?`;
  $("#apiManualBtn").hidden = manualMode;
}

function enterManualMode() {
  manualMode = true;
  $("#manualImgUrl").hidden = false;
  $("#searchInput").placeholder = "Type a competitor name, then press Enter";
  $("#searchInput").value = "";
  $("#searchHint").textContent = "Press Enter to add each competitor. Image URL is optional.";
  renderResults([]);
  renderApiBanner();
  $("#searchInput").focus();
}

function exitManualMode() {
  manualMode = false;
  $("#manualImgUrl").hidden = true;
  $("#manualImgUrl").value = "";
  $("#searchInput").placeholder = "Search an anime title…";
  $("#searchHint").textContent = "Type at least 2 characters. Results come from MyAnimeList via Jikan.";
  renderApiBanner();
}

// Build a competitor from typed input; same shape as a Jikan result so the
// bracket, voting and champion views treat it identically.
function addManualCompetitor() {
  const name = $("#searchInput").value.trim();
  if (!name) return;
  if (state.roster.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    $("#searchHint").textContent = `"${name}" is already in the roster.`;
    return;
  }
  addToRoster({
    id: `manual-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    name,
    img: $("#manualImgUrl").value.trim(),
    synopsis: "",
    year: "",
    type: "Manual",
    episodes: null,
    manual: true,
  });
  $("#searchInput").value = "";
  $("#manualImgUrl").value = "";
  $("#searchHint").textContent = "Added. Type the next competitor and press Enter.";
  $("#searchInput").focus();
}

/* ---- Setup: search results ---- */
// "12 eps" / "1 ep"; empty when episode count is unknown (ongoing/unreported).
function epsLabel(n) { return n ? `${n} ep${n > 1 ? "s" : ""}` : ""; }

let lastResults = [];
function renderResults(items) {
  lastResults = items;
  const box = $("#searchResults");
  box.innerHTML = "";
  if (!items.length) return;
  for (const it of items) {
    const added = state.roster.some(c => c.id === it.id);
    const card = el("div", `result-card${added ? " added" : ""}`);
    card.innerHTML = `
      ${imgTag(it.img, "")}
      <div class="meta">
        <div class="name">${esc(it.name)}</div>
        <div class="sub">${esc([it.type, it.year, epsLabel(it.episodes)].filter(Boolean).join(" · "))}</div>
      </div>`;
    card.addEventListener("click", () => addToRoster(it));
    box.appendChild(card);
  }
}

/* ---- Setup: roster ---- */
function renderRoster() {
  const list = $("#rosterList");
  list.innerHTML = "";
  if (!state.roster.length) {
    list.appendChild(el("div", "empty-note", "No competitors yet. Search and click to add."));
  } else {
    state.roster.forEach((c, i) => {
      const item = el("div", "roster-item");
      const eps = epsLabel(c.episodes);
      item.innerHTML = `
        ${imgTag(c.img, "")}
        <div class="r-info">
          <span class="name">${esc(c.name)}</span>
          ${eps ? `<span class="r-eps">📺 ${eps}</span>` : ""}
        </div>
        <span class="seed">#${i + 1}</span>
        <button class="remove-btn" title="Remove">✕</button>`;
      item.querySelector(".remove-btn").addEventListener("click", () => removeFromRoster(c.id));
      list.appendChild(item);
    });
  }
  $("#rosterCount").textContent = state.roster.length;
  $("#startBtn").disabled = state.roster.length < 2;
  $("#shuffleBtn").disabled = state.roster.length < 2;
}

// Fisher–Yates shuffle of the roster -> randomizes seeds (and therefore byes/matchups).
function shuffleRoster() {
  for (let i = state.roster.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.roster[i], state.roster[j]] = [state.roster[j], state.roster[i]];
  }
  save();
  renderRoster();
}

/* ---- Bracket tree ---- */
function roundLabel(r, total) {
  const fromEnd = total - r;
  if (fromEnd === 1) return "Final";
  if (fromEnd === 2) return "Semifinals";
  if (fromEnd === 3) return "Quarterfinals";
  return `Round ${r + 1}`;
}
// Japanese accent label for that shōnen-tournament flavor.
function roundLabelJP(r, total) {
  const fromEnd = total - r;
  if (fromEnd === 1) return "決勝";
  if (fromEnd === 2) return "準決勝";
  if (fromEnd === 3) return "準々決勝";
  return `第${r + 1}回戦`;
}

function slotHTML(id, isBye, isWinner, label) {
  if (!id) {
    const text = isBye ? "— bye —" : "TBD";
    return `<div class="bm-slot bye"><span class="nm">${text}</span></div>`;
  }
  const c = byId(id);
  if (!c) return `<div class="bm-slot bye"><span class="nm">?</span></div>`;
  return `<div class="bm-slot ${isWinner ? "win" : ""}">
      ${imgTag(c.img, "")}
      <span class="nm">${esc(c.name)}</span>
      <span class="v">${label != null ? label : ""}</span>
    </div>`;
}

function renderBracket() {
  const tree = $("#bracketTree");
  tree.innerHTML = "";
  const total = state.rounds.length;
  state.rounds.forEach((round, r) => {
    const col = el("div", "round-col");
    col.appendChild(el("div", "round-label", `${roundLabel(r, total)}<span class="round-label-jp">${roundLabelJP(r, total)}</span>`));
    round.forEach((m, i) => {
      const live = isLive(m);
      const done = !!m.winner;
      const bm = el("div", `bm ${live ? "live" : ""} ${done ? "done" : ""}`);
      const showVotes = m.winner || m.votes.some(v => v);
      const aLabel = showVotes ? m.votes[0] : null;
      const bLabel = showVotes ? m.votes[1] : null;
      bm.innerHTML =
        (live ? `<span class="bm-tag">VOTE</span>` : "") +
        slotHTML(m.a, r === 0 && m.a === null, m.winner === m.a, aLabel) +
        slotHTML(m.b, r === 0 && m.b === null, m.winner === m.b, bLabel);
      if (live) bm.addEventListener("click", () => { state.activeMatch = { round: r, index: i }; save(); setView("vote"); });
      col.appendChild(bm);
    });
    tree.appendChild(col);
  });

  const champ = tournamentChampion();
  const live = firstLiveMatch();
  const status = $("#bracketStatus");
  const goBtn = $("#goVoteBtn");
  if (champ) {
    status.textContent = `🏆 Champion: ${byId(champ).name}`;
    goBtn.textContent = "See champion 🎉";
    goBtn.onclick = () => setView("champion");
  } else if (live) {
    const remaining = countLive();
    status.textContent = `${remaining} match${remaining > 1 ? "es" : ""} awaiting votes`;
    goBtn.textContent = "Go to next match →";
    goBtn.onclick = () => { state.activeMatch = live; save(); setView("vote"); };
  } else {
    status.textContent = "Building…";
  }
  $("#bracketTitle").textContent = `Bracket · ${state.roster.length} competitors`;
}

function countLive() {
  let n = 0;
  state.rounds.forEach(round => round.forEach(m => { if (isLive(m)) n++; }));
  return n;
}

/* ---- Voting view ---- */
function renderVote() {
  const am = state.activeMatch;
  if (!am) { setView(tournamentChampion() ? "champion" : "bracket"); return; }
  const m = getMatch(am.round, am.index);
  if (!isLive(m)) { state.activeMatch = firstLiveMatch(); return renderVote(); }

  const total = state.rounds.length;
  $("#voteRound").innerHTML = `${roundLabel(am.round, total)}<span class="jp">${roundLabelJP(am.round, total)}</span>`;
  const idxLive = liveIndexInfo(am);
  $("#voteProgress").textContent = `Match ${idxLive.pos} of ${idxLive.total} this round`;

  const a = byId(m.a), b = byId(m.b);
  const lead = m.votes[0] === m.votes[1] ? -1 : (m.votes[0] > m.votes[1] ? 0 : 1);

  $("#matchup").innerHTML = `
    ${fighterHTML(a, m.votes[0], 0, lead === 0)}
    <div class="vs-badge"><span class="vs-text">VS</span><span class="vs-jp">対戦</span></div>
    ${fighterHTML(b, m.votes[1], 1, lead === 1)}`;

  $("#matchup").querySelectorAll("[data-step]").forEach(btn => {
    btn.addEventListener("click", () => {
      const side = +btn.dataset.side, delta = +btn.dataset.step;
      m.votes[side] = Math.max(0, m.votes[side] + delta);
      save();
      renderVote();
    });
  });

  $("#voteControls").innerHTML = `
    <button class="ghost-btn" id="backToBracket">← Bracket</button>
    <button class="primary-btn" id="advanceBtn">Advance winner →</button>`;
  $("#backToBracket").onclick = () => setView("bracket");
  $("#advanceBtn").onclick = () => decideMatch(m);
}

function fighterHTML(c, votes, side, leading) {
  return `<div class="fighter ${leading ? "leading" : ""}">
    ${imgTag(c.img, "fighter-img")}
    <div class="fighter-body">
      <h3>${esc(c.name)}</h3>
      <div class="fighter-syn">${esc(c.synopsis)}</div>
      <div class="tally">
        <button class="step-btn" data-step="-1" data-side="${side}">−</button>
        <span class="num">${votes}</span>
        <button class="step-btn plus" data-step="1" data-side="${side}">+</button>
      </div>
    </div>
  </div>`;
}

function liveIndexInfo(am) {
  const round = state.rounds[am.round];
  let total = 0, pos = 0;
  round.forEach((m, i) => {
    if (m.a && m.b) { total++; if (i === am.index) pos = total; }
  });
  return { pos, total };
}

function decideMatch(m) {
  if (m.votes[0] === m.votes[1]) {
    alert("It's a tie! Cast one more vote to break it. 🥊");
    return;
  }
  const winnerId = m.votes[0] > m.votes[1] ? m.a : m.b;
  resolveWinner(m, winnerId);
  save();
  const next = firstLiveMatch();
  state.activeMatch = next;
  save();
  if (next) setView("vote");
  else if (tournamentChampion()) setView("champion");
  else setView("bracket");
}

/* ---- Champion ---- */
function renderChampion() {
  const champId = tournamentChampion();
  if (!champId) { setView("bracket"); return; }
  const c = byId(champId);
  $("#championCard").innerHTML = `
    <div class="rays"></div>
    <div class="champ-inner">
      <div class="crown">👑</div>
      <div class="rank">SSR</div>
      <div class="label">Champion <span class="jp">優勝</span></div>
      <div class="champ-frame">${imgTag(c.img, "")}<span class="sparkle s1">✦</span><span class="sparkle s2">✧</span><span class="sparkle s3">✦</span></div>
      <h2>${esc(c.name)}</h2>
    </div>`;
  spawnConfetti();
}

function spawnConfetti() {
  const box = $("#confetti");
  box.innerHTML = "";
  const colors = ["#7c5cff", "#ff5c93", "#ffce54", "#4ad07e"];
  for (let i = 0; i < 40; i++) {
    const p = el("div");
    p.style.cssText = `position:absolute;top:-10px;left:${Math.random() * 100}%;width:8px;height:8px;
      background:${colors[i % 4]};opacity:.9;border-radius:2px;
      animation:fall ${1.8 + Math.random() * 1.6}s linear ${Math.random()}s forwards;`;
    box.appendChild(p);
  }
}
// confetti keyframes injected once
const kf = document.createElement("style");
kf.textContent = "@keyframes fall{to{transform:translateY(90vh) rotate(540deg);opacity:0}}";
document.head.appendChild(kf);

/* ============================================================
   Events
   ============================================================ */
let searchTimer = null;
$("#searchInput").addEventListener("input", e => {
  if (manualMode) return; // typed names are added on Enter, not searched
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 2) { renderResults([]); $("#searchHint").textContent = "Type at least 2 characters."; return; }
  searchTimer = setTimeout(async () => {
    $("#searchSpinner").hidden = false;
    $("#searchHint").textContent = "Searching MyAnimeList…";
    try {
      const items = await searchAnime(q);
      apiStatus = "online";
      apiReason = "";
      renderApiBanner();
      renderResults(items);
      $("#searchHint").textContent = items.length ? `${items.length} results — click to add.` : "No matches found.";
    } catch (err) {
      // Any failure means we can't give the user results, so offer manual entry.
      markApiDown(reasonFor(err));
      $("#searchHint").textContent = "Search unavailable — see the notice above.";
    } finally {
      $("#searchSpinner").hidden = true;
    }
  }, 450);
});

$("#searchInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && manualMode) { e.preventDefault(); addManualCompetitor(); }
});
$("#manualImgUrl").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); addManualCompetitor(); }
});

$("#apiManualBtn").addEventListener("click", enterManualMode);
$("#apiRetryBtn").addEventListener("click", async () => {
  $("#apiRetryBtn").disabled = true;
  const prev = $("#apiMsg").innerHTML;
  $("#apiMsg").textContent = "Checking connection…";
  const status = await checkApiHealth();
  $("#apiRetryBtn").disabled = false;
  if (status === "online") exitManualMode();
  else if ($("#apiMsg").textContent === "Checking connection…") $("#apiMsg").innerHTML = prev;
});

$("#shuffleBtn").addEventListener("click", shuffleRoster);

$("#startBtn").addEventListener("click", () => {
  if (state.roster.length < 2) return;
  buildBracket();
  save();
  setView(state.activeMatch ? "vote" : "bracket");
});

$("#nav").addEventListener("click", e => {
  const tab = e.target.closest(".tab");
  if (tab && !tab.disabled) setView(tab.dataset.view);
});

$("#resetBtn").addEventListener("click", () => {
  if (!confirm("Reset everything — roster and bracket?")) return;
  state.roster = []; state.rounds = []; state.activeMatch = null;
  localStorage.removeItem(STORAGE_KEY);
  setView("setup");
});

$("#newTournamentBtn").addEventListener("click", () => {
  state.rounds = []; state.activeMatch = null;
  save();
  setView("setup");
});

/* ---------- Boot ---------- */
load();
updateNav();
if (tournamentChampion()) setView("champion");
else if (state.rounds.length) setView("bracket");
else setView("setup");
checkApiHealth();
