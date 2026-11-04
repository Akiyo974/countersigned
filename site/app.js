// countersigned website. No framework, no tracking, nothing leaves your browser.
// Every hash on this page is a real SHA-256 computed locally with WebCrypto.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
const enc = new TextEncoder();

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

const short = (h) => `${h.slice(0, 8)}…${h.slice(-4)}`;
const GENESIS = "0".repeat(64);

/* ------------------------------------------------------------------ visit ledger */

const visit = (() => {
  const entries = [];
  const list = $("[data-tape-list]");
  const head = $("[data-head]");
  let chain = Promise.resolve();

  function render(e, hot) {
    if (!list) return;
    const li = document.createElement("li");
    if (hot) li.className = "hot";
    li.innerHTML = `<span class="t"></span><span class="hh"></span>`;
    li.querySelector(".t").textContent = `#${e.seq} ${e.type}`;
    li.querySelector(".hh").textContent = short(e.hash);
    list.append(li);
    while (list.children.length > 40) list.firstElementChild.remove();
    if (head) head.textContent = `${e.seq}:${short(e.hash)}`;
  }

  function append(type, data = {}, hot = false) {
    chain = chain.then(async () => {
      const prev = entries.at(-1);
      const body = { seq: entries.length + 1, at: new Date().toISOString(), type, data, prevHash: prev ? prev.hash : GENESIS };
      const e = { ...body, hash: await sha256(canonical(body)) };
      entries.push(e);
      render(e, hot);
      return e;
    });
    return chain;
  }
  return { append, entries };
})();

visit.append("visit.opened", { page: location.pathname });

/* ------------------------------------------------------------------ printed headings */

function setupPrint(el) {
  let i = 0;
  const lines = [[]];
  for (const node of [...el.childNodes]) {
    if (node.nodeName === "BR") lines.push([]);
    else lines.at(-1).push(node);
  }
  const frag = document.createDocumentFragment();
  for (const nodes of lines) {
    const mask = document.createElement("span");
    mask.className = "ln-mask";
    for (const node of nodes) {
      const text = node.textContent;
      const host = node.nodeType === 1 ? node.cloneNode(false) : document.createDocumentFragment();
      for (const [w, word] of text.split(" ").entries()) {
        if (w > 0) host.append(" ");
        if (!word) continue;
        const ws = document.createElement("span");
        ws.style.whiteSpace = "nowrap";
        for (const ch of word) {
          const c = document.createElement("span");
          c.className = "ch";
          c.style.setProperty("--i", i++);
          c.textContent = ch;
          ws.append(c);
        }
        host.append(ws);
      }
      mask.append(host);
    }
    frag.append(mask);
  }
  el.setAttribute("aria-label", el.textContent.replace(/\s+/g, " ").trim());
  el.replaceChildren(frag);
  for (const m of el.querySelectorAll(".ln-mask")) m.setAttribute("aria-hidden", "true");
}

const io = new IntersectionObserver(
  (items) => {
    for (const it of items) {
      if (!it.isIntersecting) continue;
      it.target.classList.add("in");
      io.unobserve(it.target);
    }
  },
  { threshold: 0.2, rootMargin: "0px 0px -8% 0px" },
);
for (const h of $$("[data-print]")) {
  setupPrint(h);
  io.observe(h);
}
$$("[data-reveal]").forEach((el, k) => {
  el.style.transitionDelay = `${(k % 5) * 70}ms`;
  io.observe(el);
});

const seen = new Set();
const sectionIo = new IntersectionObserver(
  (items) => {
    for (const it of items) {
      if (!it.isIntersecting || seen.has(it.target.id)) continue;
      seen.add(it.target.id);
      const label = it.target.querySelector(".sec")?.textContent.split("·")[0].trim() ?? it.target.id;
      visit.append("section.read", { section: label });
    }
  },
  { threshold: 0.45 },
);
$$("main > section").forEach((s) => sectionIo.observe(s));

/* ------------------------------------------------------------------ the plan + signature */

const planEl = $(".plan");
const plan = {
  id: "pl_mw2h8e0e8c5a",
  intent: "Absorb the ACME delay without breaking customer promises",
  requestedBy: "agent",
  steps: [
    { action: "reschedule_order", input: { orderNo: "SO-1001", shipmentDate: "2026-11-14" } },
    { action: "set_reorder_point", input: { sku: "FRIDGE-300", reorderPoint: 6 } },
    { action: "email_supplier", input: { to: "po@acme.co", subject: "PO 4471 delay" } },
  ],
};
let planHash = "";
sha256(canonical(plan)).then((h) => {
  planHash = h;
  $("[data-plan-hash]").textContent = h;
  visit.append("plan.created", { plan: plan.id, hash: short(h) });
});

const pad = $("[data-pad]");
const canvas = $("[data-canvas]");
const ctx = canvas.getContext("2d");
const stamp = $("[data-stamp]");
const applyBtn = $("[data-apply]");
const hint = $("[data-sign-hint]");
const report = $("[data-report]");
const status = $("[data-status]");

let strokes = [];
let current = null;
let signed = false;
let applied = false;
let finalizeTimer = 0;
let autoSigning = false;

function sizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}

function inkSegment(a, b, c) {
  // Quadratic through midpoints, width from speed: slow = heavy, fast = thin, like a fountain pen.
  const v = Math.hypot(c.x - b.x, c.y - b.y) / Math.max(1, c.t - b.t);
  const w = Math.max(0.9, Math.min(3.4, 3.4 - v * 1.6));
  b.w = b.w ?? w;
  c.w = b.w * 0.7 + w * 0.3;
  const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const m2 = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
  ctx.lineWidth = c.w;
  ctx.beginPath();
  ctx.moveTo(m1.x, m1.y);
  ctx.quadraticCurveTo(b.x, b.y, m2.x, m2.y);
  ctx.stroke();
}

function redraw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.strokeStyle = "rgba(20,20,18,0.94)";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    for (let k = 2; k < s.length; k++) inkSegment(s[k - 2], s[k - 1], s[k]);
  }
}

function point(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
}

function addPoint(p) {
  current.push(p);
  const n = current.length;
  ctx.strokeStyle = "rgba(20,20,18,0.94)";
  ctx.lineCap = "round";
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(20,20,18,0.9)";
    ctx.fill();
  } else if (n >= 3) inkSegment(current[n - 3], current[n - 2], current[n - 1]);
}

canvas.addEventListener("pointerdown", (e) => {
  if (signed || autoSigning) return;
  canvas.setPointerCapture(e.pointerId);
  clearTimeout(finalizeTimer);
  current = [];
  strokes.push(current);
  addPoint(point(e));
});
canvas.addEventListener("pointermove", (e) => {
  if (!current) return;
  for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) addPoint(point(ev));
});
const endStroke = () => {
  if (!current || autoSigning) return;
  current = null;
  clearTimeout(finalizeTimer);
  finalizeTimer = setTimeout(maybeFinalize, 850);
};
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

function inkLength() {
  let L = 0;
  for (const s of strokes) for (let k = 1; k < s.length; k++) L += Math.hypot(s[k].x - s[k - 1].x, s[k].y - s[k - 1].y);
  return L;
}

async function maybeFinalize() {
  if (signed) return;
  if (inkLength() < 110) {
    hint.textContent = "A little more ink. A real signature, please.";
    return;
  }
  signed = true;
  const pts = strokes.map((s) => s.map((p) => [Math.round(p.x), Math.round(p.y)]));
  const sig = await sha256(canonical({ plan: planHash, strokes: pts }));
  $("[data-stamp-hash]").textContent = `SHA256 ${sig.slice(0, 16).toUpperCase()}`;
  hint.textContent = `Signed. Your strokes hash to ${short(sig)}.`;
  stamp.classList.remove("on");
  void stamp.offsetWidth;
  stamp.classList.add("on");
  setTimeout(() => {
    pad.classList.remove("thump");
    void pad.offsetWidth;
    pad.classList.add("thump");
  }, reduced ? 0 : 230);
  status.textContent = "Approved";
  planEl.dataset.state = "approved";
  applyBtn.disabled = false;
  await visit.append("signature.captured", { strokes: pts.length, points: pts.flat().length, sig: short(sig) });
  await visit.append("plan.approved", { by: "you", planHash: short(planHash) }, true);
}

// A hand-designed signature (normalized 0..1), replayed through the same ink engine as a real hand.
const SIGNATURE = [
  [[0.14, 0.3], [0.08, 0.36], [0.06, 0.55], [0.1, 0.72], [0.18, 0.7], [0.22, 0.56], [0.21, 0.48], [0.19, 0.6], [0.24, 0.7],
   [0.27, 0.55], [0.29, 0.66], [0.32, 0.22], [0.33, 0.18], [0.31, 0.5], [0.33, 0.7], [0.37, 0.56], [0.4, 0.68],
   [0.43, 0.54], [0.45, 0.7], [0.49, 0.5], [0.5, 0.62], [0.47, 0.66], [0.51, 0.7], [0.55, 0.26], [0.56, 0.22],
   [0.54, 0.55], [0.57, 0.7], [0.61, 0.56], [0.64, 0.68], [0.68, 0.52], [0.7, 0.64], [0.74, 0.6], [0.8, 0.5], [0.86, 0.46]],
  [[0.12, 0.86], [0.3, 0.84], [0.52, 0.82], [0.72, 0.77], [0.88, 0.62], [0.9, 0.55]],
  [[0.57, 0.4], [0.58, 0.41]],
];

function catmull(pts, steps) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(pts.at(-1));
  return out;
}

async function signForMe() {
  if (signed || autoSigning) return;
  autoSigning = true;
  strokes = [];
  redraw();
  const r = canvas.getBoundingClientRect();
  const w = Math.min(r.width - 24, 520), h = r.height - 16;
  const ox = 12, oy = 6;
  let t = performance.now();
  for (const raw of SIGNATURE) {
    current = [];
    strokes.push(current);
    const pts = catmull(raw, 9);
    for (const [k, [x, y]] of pts.entries()) {
      // Ups are faster than downs: thin hairlines up, heavier strokes down, like a nib.
      const prev = pts[k - 1];
      const dy = prev ? y - prev[1] : 0;
      t += dy < 0 ? 4 : 11;
      addPoint({ x: ox + x * w + Math.sin(k * 1.7) * 0.4, y: oy + y * h, t });
      if (k % 4 === 0) await wait(12);
    }
    await wait(90);
  }
  current = null;
  autoSigning = false;
  maybeFinalize();
}

function clearPad() {
  if (applied || autoSigning) return;
  strokes = [];
  current = null;
  signed = false;
  clearTimeout(finalizeTimer);
  redraw();
  stamp.classList.remove("on");
  applyBtn.disabled = true;
  status.textContent = "Pending approval";
  planEl.dataset.state = "pending";
  hint.textContent = "Draw your signature. It is hashed into the plan.";
}

async function applyPlan() {
  if (!signed || applied) return;
  applied = true;
  applyBtn.disabled = true;
  applyBtn.textContent = "Applying…";
  status.textContent = "Applying";
  report.textContent = "";
  await visit.append("apply.started", { plan: plan.id });
  const evidence = [{ shipmentDate: "2026-11-14" }, { reorderPoint: 6 }, { id: "EM-1", outbox: "sent" }];
  const rows = $$(".steps li");
  for (const [k, li] of rows.entries()) {
    const key = `cs_${(await sha256(`${planHash}:${k}`)).slice(0, 12)}`;
    li.classList.add("running");
    li.querySelector("[data-ev]").textContent = `intent · ${key}`;
    await visit.append("step.intent", { step: k, key });
    await wait(650);
    li.classList.remove("running");
    li.classList.add("done");
    li.querySelector("[data-ev]").textContent = `verified · ${canonical(evidence[k])}`;
    await visit.append("step.succeeded", { step: k, evidence: evidence[k] });
    await wait(220);
  }
  const fin = await visit.append("apply.finished", { status: "applied" }, true);
  status.textContent = "Applied";
  planEl.dataset.state = "applied";
  applyBtn.textContent = "Applied";
  report.textContent = `Applied. 3 of 3 steps executed and verified against the system. Ledger head ${fin.seq}:${short(fin.hash)}. Apply again and nothing runs twice.`;
}

$("[data-sign-for-me]").addEventListener("click", signForMe);
$("[data-clear]").addEventListener("click", clearPad);
applyBtn.addEventListener("click", applyPlan);
new ResizeObserver(sizeCanvas).observe(canvas);

/* ------------------------------------------------------------------ contract */

const clauses = $$("[data-clause]");
let clauseIdx = 0;
let clauseAuto = true;
function selectClause(name) {
  for (const c of clauses) c.classList.toggle("on", c.dataset.clause === name);
  for (const l of $$("[data-line]")) l.classList.toggle("on", l.dataset.line === name);
}
for (const c of clauses) {
  const pick = () => {
    clauseAuto = false;
    selectClause(c.dataset.clause);
  };
  c.addEventListener("mouseenter", pick);
  c.addEventListener("click", pick);
  c.tabIndex = 0;
  c.addEventListener("focus", pick);
}
selectClause("observe");
let contractVisible = false;
new IntersectionObserver((it) => (contractVisible = it[0].isIntersecting), { threshold: 0.3 }).observe($("#contract"));
if (!reduced) {
  setInterval(() => {
    if (!clauseAuto || !contractVisible) return;
    clauseIdx = (clauseIdx + 1) % clauses.length;
    selectClause(clauses[clauseIdx].dataset.clause);
  }, 2400);
}

/* ------------------------------------------------------------------ tamper ledger */

const seed = [
  ["plan.created", '{"intent":"raise safety stock","by":"agent"}'],
  ["plan.approved", '{"by":"christen","planHash":"9a577c84"}'],
  ["apply.started", "{}"],
  ["step.intent", '{"step":0,"key":"cs_4f1a90e2"}'],
  ["step.succeeded", '{"step":0,"evidence":{"reorderPoint":6}}'],
  ["apply.finished", '{"status":"applied"}'],
];
const book = $("[data-book]");
const list = $("[data-entries]");
const chainStatus = $("[data-chain-status]");
let original = [];

async function hashRow(seq, type, data, prev) {
  return sha256(canonical({ seq, type, data, prevHash: prev }));
}

async function buildBook() {
  original = [];
  let prev = GENESIS;
  for (const [k, [type, data]] of seed.entries()) {
    const h = await hashRow(k + 1, type, data, prev);
    original.push({ seq: k + 1, type, data, hash: h });
    prev = h;
  }
  list.replaceChildren(
    ...original.map((e) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="seq">${String(e.seq).padStart(3, "0")}</span><span class="type"></span><span class="data" contenteditable="plaintext-only" spellcheck="false"></span><span class="h"></span>`;
      li.querySelector(".type").textContent = e.type;
      const d = li.querySelector(".data");
      d.textContent = e.data;
      d.setAttribute("role", "textbox");
      d.setAttribute("aria-label", `Data of ledger entry ${e.seq}`);
      li.querySelector(".h").textContent = short(e.hash);
      d.addEventListener("input", () => {
        clearTimeout(d._t);
        d._t = setTimeout(verifyBook, 140);
      });
      d.addEventListener("keydown", (ev) => ev.key === "Enter" && (ev.preventDefault(), d.blur()));
      return li;
    }),
  );
  book.classList.remove("tampered");
  chainStatus.textContent = `Chain verified · ${original.length} entries · head ${short(original.at(-1).hash)}`;
}

let tamperLogged = false;
async function verifyBook() {
  const rows = $$("li", list);
  let prev = GENESIS;
  let firstBroken = -1;
  for (const [k, li] of rows.entries()) {
    const data = li.querySelector(".data").textContent;
    const h = await hashRow(k + 1, original[k].type, data, prev);
    prev = h;
    const broken = h !== original[k].hash;
    if (broken && firstBroken < 0) firstBroken = k;
    li.querySelector(".h").textContent = short(h);
    if (broken) {
      li.style.setProperty("--k", String(k - Math.max(firstBroken, 0)));
      li.classList.add("broken");
    } else li.classList.remove("broken");
  }
  if (firstBroken < 0) {
    book.classList.remove("tampered");
    chainStatus.textContent = `Chain verified · ${rows.length} entries · head ${short(original.at(-1).hash)}`;
    return;
  }
  book.classList.add("tampered");
  const n = rows.length - firstBroken;
  chainStatus.textContent = `Broken at #${firstBroken + 1} · ${n} ${n === 1 ? "entry no longer matches" : "entries no longer match"} the anchored head`;
  if (!tamperLogged) {
    tamperLogged = true;
    visit.append("ledger.tamper_detected", { at: firstBroken + 1 }, true);
  }
}
$("[data-restore]").addEventListener("click", () => {
  tamperLogged = false;
  buildBook();
});
buildBook();

/* ------------------------------------------------------------------ drift */

const erp = $("[data-erp]");
const driftPlan = $(".drift-plan");
const driftOut = $("[data-drift-out]");
const driftBtn = $("[data-drift-apply]");
const effect = $(".drift-effect .mono");
let drift = { before: 3, after: 6, state: "approved" };

function renderDrift() {
  effect.textContent = `${drift.before} → ${drift.after}`;
  driftBtn.textContent = drift.state === "stale" ? "Plan again" : "Apply →";
}

driftBtn.addEventListener("click", () => {
  const now = Number(erp.value);
  if (drift.state === "stale") {
    drift = { before: now, after: now + 3, state: "approved" };
    driftPlan.classList.remove("stale");
    driftOut.classList.remove("bad");
    driftOut.textContent = `New plan against the current value ${now}. Approved. Apply when ready.`;
    renderDrift();
    visit.append("plan.created", { plan: "pl_drift", before: now });
    return;
  }
  if (drift.state === "applied") {
    driftOut.classList.remove("bad");
    driftOut.textContent = "Already applied. The step has a recorded outcome, so nothing runs twice.";
    return;
  }
  if (now !== drift.before) {
    drift.state = "stale";
    driftPlan.classList.remove("stale");
    void driftPlan.offsetWidth;
    driftPlan.classList.add("stale");
    driftOut.classList.add("bad");
    driftOut.textContent = `[STALE_STATE] Refused: approved against ${drift.before}, the ERP now says ${now}. Nothing was written.`;
    renderDrift();
    visit.append("plan.stale", { approved: drift.before, found: now }, true);
    return;
  }
  // Recheck, write and state change happen in one synchronous turn: no window for a late edit,
  // and a double click finds the plan already applied.
  erp.value = String(drift.after);
  drift.state = "applied";
  driftOut.classList.remove("bad");
  driftOut.textContent = `Applied and verified: the ERP shows ${drift.after}.`;
  renderDrift();
  visit.append("step.succeeded", { plan: "pl_drift", evidence: { reorderPoint: drift.after } });
});
renderDrift();

/* ------------------------------------------------------------------ copy */

$("[data-copy]").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText($("[data-copy-src]").textContent.trim());
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Select it";
  }
  setTimeout(() => (btn.textContent = "Copy"), 1600);
});
