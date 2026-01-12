// PokerLab (Offline) — UI glue + worker orchestration
// v1: multiway EV via Monte Carlo + exploit-flavored response models.
// This is an offline trainer/analyzer (NOT a poker-site bot).

const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const SUITS = ["c","d","h","s"];

const $ = (id) => document.getElementById(id);

const playersEl = $("players");
const playersValEl = $("playersVal");
const seatsEl = $("seats");

const exploitEl = $("exploit");
const exploitValEl = $("exploitVal");

const evFoldEl = $("evFold");
const evCallEl = $("evCall");
const evR33El = $("evR33");
const evR75El = $("evR75");
const evR125El = $("evR125");
const evRCustomEl = $("evRC");

const statusEl = $("status");
const barEl = $("bar");
const bestBox = $("bestBox");

let activeRaiseRatio = 0.75;
let worker = null;
let running = false;

// ---------- Card dropdowns ----------
function buildCardOptions(selectEl) {
  selectEl.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "—";
  selectEl.appendChild(opt0);

  for (const r of RANKS) {
    for (const s of SUITS) {
      const o = document.createElement("option");
      o.value = r + s;
      o.textContent = r + s;
      selectEl.appendChild(o);
    }
  }
}

function initCardsUI() {
  buildCardOptions($("h1"));
  buildCardOptions($("h2"));
  ["b1","b2","b3","b4","b5"].forEach(id => buildCardOptions($(id)));

  // sensible defaults
  $("h1").value = "As";
  $("h2").value = "Kh";
  $("b1").value = "Qd";
  $("b2").value = "";
  $("b3").value = "";
  $("b4").value = "";
  $("b5").value = "";
}

// ---------- Seats UI ----------
const VILLAIN_TYPES = ["Unknown","Reg","Nit","Station","Maniac","Trappy"];

function seatTemplate(i, label) {
  const div = document.createElement("div");
  div.className = "seat";
  div.dataset.seat = String(i);
  div.innerHTML = `
    <div class="seatTop">
      <div><strong>${label}</strong></div>
      <div class="badge">Seat ${i}</div>
    </div>

    <div class="row">
      <label>In hand</label>
      <select class="inhand">
        <option value="on" selected>On</option>
        <option value="off">Off</option>
      </select>
      <div></div>
    </div>

    <div class="row">
      <label>Stack</label>
      <input class="stack" type="number" value="400" min="1" step="1"/>
      <div></div>
    </div>

    <div class="row">
      <label>Tightness</label>
      <input class="tight" type="range" min="5" max="60" value="22"/>
      <div class="pill"><span class="tightVal">22</span>%</div>
    </div>

    <div class="row">
      <label>Villain</label>
      <select class="villain">
        ${VILLAIN_TYPES.map(v => `<option value="${v}">${v}</option>`).join("")}
      </select>
      <div></div>
    </div>
  `;
  return div;
}

function positionLabels(n) {
  // 9-max style labels, trimmed for smaller tables.
  const base = ["UTG","MP1","MP2","HJ","CO","BTN","SB","BB"];
  if (n === 2) return ["BTN","BB"];
  if (n === 3) return ["BTN","SB","BB"];
  if (n === 4) return ["UTG","BTN","SB","BB"];
  if (n === 5) return ["UTG","CO","BTN","SB","BB"];
  if (n === 6) return ["UTG","MP","CO","BTN","SB","BB"];
  if (n === 7) return ["UTG","MP1","MP2","CO","BTN","SB","BB"];
  if (n === 8) return ["UTG","MP1","MP2","HJ","CO","BTN","SB","BB"];
  return ["UTG","MP1","MP2","HJ","CO","BTN","SB","BB","(extra)"];
}

function rebuildSeats() {
  const n = Number(playersEl.value);
  playersValEl.textContent = String(n);

  seatsEl.innerHTML = "";

  // Seat 0 = Hero (implicit). Opponents seats 1..n-1
  const labels = positionLabels(n);
  for (let i = 1; i < n; i++) {
    const label = labels[i] ? labels[i] : `Seat ${i}`;
    seatsEl.appendChild(seatTemplate(i, label));
  }
}

function readSeats() {
  const n = Number(playersEl.value);
  const seats = [];
  const kids = Array.from(seatsEl.querySelectorAll(".seat"));
  for (const k of kids) {
    const id = Number(k.dataset.seat);
    const inhand = k.querySelector(".inhand").value === "on";
    const stack = Number(k.querySelector(".stack").value || 0);
    const tight = Number(k.querySelector(".tight").value || 22);
    const villain = k.querySelector(".villain").value;
    seats.push({ id, inhand, stack, tight, villain });
  }
  // Ensure we return exactly opponents length n-1
  return seats.slice(0, Math.max(0, n - 1));
}

function wireSeatLiveLabels() {
  seatsEl.addEventListener("input", (e) => {
    const t = e.target;
    if (t && t.classList.contains("tight")) {
      const seat = t.closest(".seat");
      if (!seat) return;
      seat.querySelector(".tightVal").textContent = String(t.value);
    }
  });
}

// ---------- Raise chips ----------
function setActiveChip(ratio) {
  activeRaiseRatio = ratio;
  document.querySelectorAll(".chip").forEach(btn => {
    btn.classList.toggle("active", Number(btn.dataset.r) === ratio);
  });
}
function wireChips() {
  document.querySelectorAll(".chip").forEach(btn => {
    btn.addEventListener("click", () => setActiveChip(Number(btn.dataset.r)));
  });
  setActiveChip(activeRaiseRatio);
}

// ---------- Exploit blend ----------
function wireExploit() {
  exploitValEl.textContent = String(exploitEl.value);
  exploitEl.addEventListener("input", () => {
    exploitValEl.textContent = String(exploitEl.value);
  });
}

// ---------- Validation ----------
function uniqNonEmpty(arr) {
  const s = new Set();
  for (const x of arr) {
    if (!x) continue;
    if (s.has(x)) return false;
    s.add(x);
  }
  return true;
}

function getHeroAndBoard() {
  const hero = [$("h1").value, $("h2").value].filter(Boolean);
  const board = ["b1","b2","b3","b4","b5"].map(id => $(id).value).filter(Boolean);
  return { hero, board };
}

function validateInputs() {
  const { hero, board } = getHeroAndBoard();
  if (hero.length !== 2) return { ok:false, msg:"Pick two hero cards." };
  if (!uniqNonEmpty([...hero, ...board])) return { ok:false, msg:"Duplicate card detected (hero/board)." };

  const street = $("street").value;
  if (street === "flop" && board.length !== 3) return { ok:false, msg:"Flop requires exactly 3 board cards." };
  if (street === "turn" && board.length !== 4) return { ok:false, msg:"Turn requires exactly 4 board cards." };
  if (street === "river" && board.length !== 5) return { ok:false, msg:"River requires exactly 5 board cards." };
  if (street === "pre" && board.length !== 0) return { ok:false, msg:"Preflop requires 0 board cards." };

  return { ok:true, msg:"OK" };
}

// ---------- Worker orchestration ----------
function ensureWorker() {
  if (worker) return;
  worker = new Worker("worker.js");
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (!m) return;

    if (m.type === "progress") {
      barEl.style.width = `${Math.max(0, Math.min(100, m.pct))}%`;
      statusEl.textContent = m.status || "Running…";
      return;
    }

    if (m.type === "result") {
      running = false;
      barEl.style.width = "100%";
      statusEl.textContent = "Done.";

      const fmt = (x) => (typeof x === "number" ? x.toFixed(2) : "—");
      evCallEl.textContent = fmt(m.ev.call);
      evR33El.textContent = fmt(m.ev.r33);
      evR75El.textContent = fmt(m.ev.r75);
      evR125El.textContent = fmt(m.ev.r125);
      evRCustomEl.textContent = fmt(m.ev.rcustom);

      showBest(m.ev);
      return;
    }

    if (m.type === "stopped") {
      running = false;
      barEl.style.width = "0%";
      statusEl.textContent = "Stopped.";
      return;
    }

    if (m.type === "error") {
      running = false;
      statusEl.textContent = "Error: " + (m.message || "Unknown");
      barEl.style.width = "0%";
      return;
    }
  };
}

function showBest(ev) {
  // Fold is 0 by definition in this prototype
  const items = [
    ["Fold", 0],
    ["Call", ev.call],
    ["Raise 33%", ev.r33],
    ["Raise 75%", ev.r75],
    ["Raise 125%", ev.r125],
    ["Raise Custom", ev.rcustom],
  ].filter(x => typeof x[1] === "number");

  items.sort((a,b) => b[1] - a[1]);
  const [bestName, bestEV] = items[0];

  bestBox.style.display = "block";
  bestBox.textContent = `Best (by EV): ${bestName}  —  EV ${bestEV.toFixed(2)} chips`;
}

// ---------- Run ----------
function buildPayload() {
  const n = Number(playersEl.value);
  const { hero, board } = getHeroAndBoard();
  const seats = readSeats().filter(s => s && s.inhand);


  const pot = Number($("pot").value || 0);
  const toCall = Number($("toCall").value || 0);
  const heroStack = Number($("heroStack").value || 1);

  const iters = Number($("iters").value || 5000);
  const exploit = Number(exploitEl.value || 0) / 100;
  const reraises = $("reraises").value === "on";

  const raise33 = Math.max(1, Math.round(pot * 0.33));
  const raise75 = Math.max(1, Math.round(pot * 0.75));
  const raise125 = Math.max(1, Math.round(pot * 1.25));
  const customRaise = Math.max(1, Number($("customRaise").value || raise75));

  return {
    nPlayers: n,
    street: $("street").value,
    hero,
    board,
    pot,
    toCall,
    heroStack,
    iters,
    exploit,
    reraises,
    raiseSizes: { r33: raise33, r75: raise75, r125: raise125, rcustom: customRaise },
    opponents: seats
  };
}

function runEV() {
  if (running) return;

  const v = validateInputs();
  if (!v.ok) {
    statusEl.textContent = v.msg;
    return;
  }

  ensureWorker();
  const payload = buildPayload();

  // reset UI
  bestBox.style.display = "none";
  barEl.style.width = "0%";
  statusEl.textContent = "Starting…";
  evCallEl.textContent = "—";
  evR33El.textContent = "—";
  evR75El.textContent = "—";
  evR125El.textContent = "—";
  evRCustomEl.textContent = "—";

  running = true;
  worker.postMessage({ type:"run", payload });
}

function stopEV() {
  if (!worker || !running) return;
  worker.postMessage({ type:"stop" });
}

function wireUI() {
  playersEl.addEventListener("input", () => {
    playersValEl.textContent = String(playersEl.value);
    rebuildSeats();
  });

  $("btnRun").addEventListener("click", runEV);
  $("btnStop").addEventListener("click", stopEV);

  wireSeatLiveLabels();
  wireChips();
  wireExploit();
}

// init
initCardsUI();
rebuildSeats();
wireUI();
