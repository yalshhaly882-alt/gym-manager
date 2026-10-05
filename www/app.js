(function () {
"use strict";

/* =====================================================================
   إدارة الجيم
   - قاعدة بيانات SQLite مشفرة (SQLCipher) على الموبايل
   - رقم سري لفتح التطبيق
   - إشعارات محلية عند انتهاء الاشتراك (بدون نت)
   ===================================================================== */

var Cap = window.Capacitor;
var native = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
function plug(n) { return Cap && Cap.Plugins && Cap.Plugins[n]; }

var DAYS = { month: 30, half: 15 };
var TYPE_AR = { month: "شهر", half: "نص شهر" };
var HOURS = [7, 8, 9, 10, 12, 15, 18, 20];
var PIN_LEN = 6;

var state = { subs: [], pays: [], settings: {} };
var ui = { tab: "home", filter: "all", q: "", type: "month", rtype: "month", pdate: today(),
           locked: true, mode: "enter", pin: "", first: "", msg: "", err: false, changing: false };
var pendingImport = null;
var hiddenAt = 0;

/* ---------- helpers ---------- */
function pad(n) { return n < 10 ? "0" + n : "" + n; }
function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function parse(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
function today() { return iso(new Date()); }
function addDays(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
function diff(a, b) { return Math.round((parse(a) - parse(b)) / 86400000); }
function fmt(s) { var p = s.split("-"); return p[2] + "/" + p[1] + "/" + p[0]; }
function money(n) { return (Math.round(n * 100) / 100).toLocaleString("en-US") + " ج"; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
  return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function atHour(dateStr, h) { var d = parse(dateStr); d.setHours(h, 0, 0, 0); return d; }
function priceVal(el) { var v = parseFloat(String(el.value).replace(",", ".")); return isNaN(v) || v < 0 ? null : v; }

var enc = new TextEncoder();
function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
function unhex(h) { return new Uint8Array(h.match(/../g).map(function (x) { return parseInt(x, 16); })); }
function randHex(n) { return hex(crypto.getRandomValues(new Uint8Array(n))); }
async function pbkdf2(pass, salt, bits) {
  var k = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt, iterations: 150000, hash: "SHA-256" }, k, bits);
}
async function encryptBackup(obj, pass) {
  var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  var key = await crypto.subtle.importKey("raw", await pbkdf2(pass, salt, 256), "AES-GCM", false, ["encrypt"]);
  var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, enc.encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, salt: hex(salt), iv: hex(iv), data: hex(ct) });
}
async function decryptBackup(text, pass) {
  var j = JSON.parse(text);
  var key = await crypto.subtle.importKey("raw", await pbkdf2(pass, unhex(j.salt), 256), "AES-GCM", false, ["decrypt"]);
  var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(j.iv) }, key, unhex(j.data));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* =====================================================================
   التخزين
   ===================================================================== */
var DB = "gymdb";
var SCHEMA =
  "CREATE TABLE IF NOT EXISTS subs(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,type TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT NOT NULL,price REAL NOT NULL DEFAULT 0);" +
  "CREATE TABLE IF NOT EXISTS pays(id INTEGER PRIMARY KEY AUTOINCREMENT,date TEXT NOT NULL,amount REAL NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,note TEXT,sub_id INTEGER);" +
  "CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT);" +
  "CREATE INDEX IF NOT EXISTS idx_pays_date ON pays(date);";

var SqlStore = {
  sql: function () { return plug("CapacitorSQLite"); },
  async q(sql, v) {
    var r = await this.sql().query({ database: DB, statement: sql, values: v || [], readonly: false });
    return r.values || [];
  },
  async run(sql, v) {
    return this.sql().run({ database: DB, statement: sql, values: v || [], transaction: true, readonly: false, returnMode: "no" });
  },
  async init() {
    var s = this.sql();
    var st = await s.isSecretStored();
    // مفتاح التشفير بيتعمل عشوائي مرة واحدة ويتخزن في Android Keystore
    if (!st.result) await s.setEncryptionSecret({ passphrase: randHex(32) });
    try { await s.createConnection({ database: DB, encrypted: true, mode: "secret", version: 1, readonly: false }); } catch (e) {}
    await s.open({ database: DB, readonly: false });
    await s.execute({ database: DB, statements: SCHEMA, transaction: true, readonly: false });
  },
  async loadAll() {
    var subs = (await this.q("SELECT * FROM subs")).map(function (r) {
      return { id: r.id, name: r.name, type: r.type, start: r.start_date, end: r.end_date, price: r.price }; });
    var pays = (await this.q("SELECT * FROM pays")).map(function (r) {
      return { id: r.id, date: r.date, amount: r.amount, kind: r.kind, name: r.name, note: r.note, subId: r.sub_id }; });
    var settings = {};
    (await this.q("SELECT * FROM settings")).forEach(function (r) { settings[r.k] = r.v; });
    return { subs: subs, pays: pays, settings: settings };
  },
  async insertSub(s) {
    var r = await this.run("INSERT INTO subs(name,type,start_date,end_date,price) VALUES(?,?,?,?,?)", [s.name, s.type, s.start, s.end, s.price]);
    return r.changes.lastId;
  },
  async updateSub(s) {
    await this.run("UPDATE subs SET type=?,start_date=?,end_date=?,price=? WHERE id=?", [s.type, s.start, s.end, s.price, s.id]);
  },
  async deleteSub(id) { await this.run("DELETE FROM subs WHERE id=?", [id]); },
  async insertPay(p) {
    var r = await this.run("INSERT INTO pays(date,amount,kind,name,note,sub_id) VALUES(?,?,?,?,?,?)", [p.date, p.amount, p.kind, p.name, p.note || null, p.subId || null]);
    return r.changes.lastId;
  },
  async setSetting(k, v) { await this.run("INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)", [k, String(v)]); },
  async replaceAll(subs, pays) {
    var set = [{ statement: "DELETE FROM subs", values: [] }, { statement: "DELETE FROM pays", values: [] }];
    subs.forEach(function (s) { set.push({ statement: "INSERT INTO subs(id,name,type,start_date,end_date,price) VALUES(?,?,?,?,?,?)", values: [s.id, s.name, s.type, s.start, s.end, s.price] }); });
    pays.forEach(function (p) { set.push({ statement: "INSERT INTO pays(id,date,amount,kind,name,note,sub_id) VALUES(?,?,?,?,?,?,?)", values: [p.id, p.date, p.amount, p.kind, p.name, p.note || null, p.subId || null] }); });
    await this.sql().executeSet({ database: DB, set: set, transaction: true, readonly: false, returnMode: "no" });
  }
};

/* للتجربة على المتصفح بس (غير مشفر) */
var LocalStore = {
  d: { subs: [], pays: [], settings: {}, seq: 1 },
  save: function () { try { localStorage.setItem("gym_dev", JSON.stringify(this.d)); } catch (e) {} },
  async init() { try { var r = localStorage.getItem("gym_dev"); if (r) this.d = JSON.parse(r); } catch (e) {} },
  async loadAll() { return JSON.parse(JSON.stringify(this.d)); },
  async insertSub(s) { var id = this.d.seq++; this.d.subs.push(Object.assign({ id: id }, s)); this.save(); return id; },
  async updateSub(s) { var i = this.d.subs.findIndex(function (x) { return x.id === s.id; }); if (i > -1) this.d.subs[i] = Object.assign({}, s); this.save(); },
  async deleteSub(id) { this.d.subs = this.d.subs.filter(function (x) { return x.id !== id; }); this.save(); },
  async insertPay(p) { var id = this.d.seq++; this.d.pays.push(Object.assign({ id: id }, p)); this.save(); return id; },
  async setSetting(k, v) { this.d.settings[k] = String(v); this.save(); },
  async replaceAll(subs, pays) {
    this.d.subs = subs; this.d.pays = pays;
    var m = 0; subs.concat(pays).forEach(function (x) { if (x.id > m) m = x.id; });
    this.d.seq = m + 1; this.save();
  }
};
var Store = native ? SqlStore : LocalStore;

async function setSetting(k, v) { state.settings[k] = String(v); await Store.setSetting(k, v); }
function gymName() { return state.settings.gym_name || "إدارة الجيم"; }
function lastPrice(k) { try { return (JSON.parse(state.settings.last_price || "{}"))[k] || ""; } catch (e) { return ""; } }
async function saveLastPrice(k, v) {
  var o = {}; try { o = JSON.parse(state.settings.last_price || "{}"); } catch (e) {}
  o[k] = v; await setSetting("last_price", JSON.stringify(o));
}

/* =====================================================================
   المنطق
   ===================================================================== */
function status(s) {
  var left = diff(s.end, today());
  if (left <= 0) return { k: "exp", left: left, txt: left === 0 ? "انتهى النهارده" : "منتهي من " + (-left) + " يوم" };
  if (left <= 3) return { k: "soon", left: left, txt: "باقي " + left + (left === 1 ? " يوم" : " أيام") };
  return { k: "ok", left: left, txt: "باقي " + left + " يوم" };
}
function counts() {
  var c = { all: state.subs.length, ok: 0, soon: 0, exp: 0 };
  state.subs.forEach(function (s) { var k = status(s).k; if (k === "exp") c.exp++; else { c.ok++; if (k === "soon") c.soon++; } });
  return c;
}
function sumDay(d) {
  var sub = 0, ses = 0;
  state.pays.forEach(function (p) { if (p.date === d) { if (p.kind === "sub") sub += p.amount; else ses += p.amount; } });
  return { sub: sub, ses: ses, total: sub + ses };
}
async function addSub(name, type, start, price) {
  var s = { name: name, type: type, start: start, end: addDays(start, DAYS[type]), price: price };
  s.id = await Store.insertSub(s);
  state.subs.push(s);
  var p = { date: today(), amount: price, kind: "sub", name: name, note: "اشتراك " + TYPE_AR[type], subId: s.id };
  p.id = await Store.insertPay(p); state.pays.push(p);
  await saveLastPrice(type, price);
  await scheduleAll();
  return { sub: s, pay: p };
}
async function renewSub(id, type, price) {
  var s = state.subs.find(function (x) { return x.id === id; }); if (!s) return;
  var t = today(), start = diff(s.end, t) > 0 ? s.end : t;
  s.type = type; s.start = start; s.end = addDays(start, DAYS[type]); s.price = price;
  await Store.updateSub(s);
  var p = { date: t, amount: price, kind: "sub", name: s.name, note: "تجديد " + TYPE_AR[type], subId: s.id };
  p.id = await Store.insertPay(p); state.pays.push(p);
  await saveLastPrice(type, price);
  await scheduleAll();
  return { sub: s, pay: p };
}

/* =====================================================================
   الوصل (صورة تتطبع أو تتبعت)
   ===================================================================== */
var curReceipt = null;
var FONT = '"Segoe UI",Tahoma,"Noto Naskh Arabic","Noto Sans Arabic",sans-serif';
function receiptData(s, p) {
  return { no: p ? p.id : s.id, name: s.name, type: s.type, price: p ? p.amount : s.price, start: s.start, end: s.end, date: p ? p.date : today() };
}
function drawReceipt(r) {
  var W = 576, H = 700, c = document.createElement("canvas");
  c.width = W; c.height = H;
  var x = c.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  x.fillStyle = "#000"; x.strokeStyle = "#000"; x.direction = "rtl";

  // شعار الدمبل
  x.save(); x.translate(W / 2, 62); x.rotate(-35 * Math.PI / 180);
  [[-30, -5, 60, 10], [-24, -24, 12, 48], [12, -24, 12, 48], [-38, -16, 11, 32], [27, -16, 11, 32]].forEach(function (b) {
    if (x.roundRect) { x.beginPath(); x.roundRect(b[0], b[1], b[2], b[3], 4); x.fill(); } else x.fillRect(b[0], b[1], b[2], b[3]);
  });
  x.restore();

  x.textAlign = "center";
  x.font = "bold 34px " + FONT; x.fillText(gymName(), W / 2, 140);
  x.font = "26px " + FONT; x.fillText("وصل اشتراك", W / 2, 180);
  function dash(y) { x.save(); x.setLineDash([8, 6]); x.lineWidth = 2; x.beginPath(); x.moveTo(30, y); x.lineTo(W - 30, y); x.stroke(); x.restore(); }
  dash(205);

  var rows = [
    ["رقم الوصل", String(r.no)],
    ["تاريخ الوصل", fmt(r.date)],
    ["الاسم", r.name],
    ["نوع الاشتراك", TYPE_AR[r.type]],
    ["السعر", money(r.price)],
    ["بداية الاشتراك", fmt(r.start)],
    ["نهاية الاشتراك", fmt(r.end)]
  ];
  var y = 258;
  rows.forEach(function (row) {
    x.textAlign = "right"; x.font = "24px " + FONT; x.fillStyle = "#444";
    x.fillText(row[0], W - 30, y);
    var lw = x.measureText(row[0]).width, size = 28, maxW = W - 60 - lw - 20;
    x.fillStyle = "#000"; x.font = "bold " + size + "px " + FONT;
    while (x.measureText(row[1]).width > maxW && size > 14) { size -= 2; x.font = "bold " + size + "px " + FONT; }
    x.textAlign = "left"; x.fillText(row[1], 30, y);
    y += 60;
  });
  dash(y - 28);
  x.textAlign = "center"; x.fillStyle = "#000"; x.font = "bold 26px " + FONT;
  x.fillText("شكرًا لاشتراكك معانا", W / 2, y + 16);
  x.font = "20px " + FONT; x.fillStyle = "#444";
  x.fillText("احتفظ بالوصل لحين انتهاء الاشتراك", W / 2, y + 52);
  return c.toDataURL("image/png");
}
function showReceipt(r) {
  var url = drawReceipt(r); curReceipt = { url: url, no: r.no };
  sheet("<h2>وصل الاشتراك</h2>" +
    '<img src="' + url + '" alt="وصل الاشتراك" style="width:100%;border-radius:10px;background:#fff;margin-top:8px">' +
    '<button class="btn" data-act="shrec">طباعة / مشاركة</button><button class="btn ghost" data-act="close">إغلاق</button>');
}
async function cleanCache() {
  var FS = plug("Filesystem"); if (!native || !FS) return;
  try {
    var l = await FS.readdir({ path: "", directory: "CACHE" });
    for (var i = 0; i < l.files.length; i++) {
      var n = typeof l.files[i] === "string" ? l.files[i] : l.files[i].name;
      if (/^receipt-.*\.png$/.test(n) || /\.gymbak$/.test(n)) { try { await FS.deleteFile({ path: n, directory: "CACHE" }); } catch (e) {} }
    }
  } catch (e) {}
}

/* =====================================================================
   الإشعارات (بتشتغل والتطبيق مقفول)
   ===================================================================== */
async function initChannel() {
  var LN = plug("LocalNotifications"); if (!native || !LN) return;
  try { await LN.createChannel({ id: "expiry", name: "انتهاء الاشتراكات", description: "تنبيه لما اشتراك مشترك ينتهي", importance: 5, visibility: 1, vibration: true }); } catch (e) {}
}
async function ensureNotif() {
  var LN = plug("LocalNotifications"); if (!native || !LN) return false;
  try {
    var p = await LN.checkPermissions();
    if (p.display !== "granted") p = await LN.requestPermissions();
    try {
      var e = await LN.checkExactNotificationSetting();
      if (e.exact_alarm !== "granted") await LN.changeExactNotificationSetting();
    } catch (x) {}
    return p.display === "granted";
  } catch (e) { return false; }
}
async function scheduleAll() {
  var LN = plug("LocalNotifications"); if (!native || !LN) return;
  try {
    var pend = await LN.getPending();
    if (pend.notifications && pend.notifications.length) {
      await LN.cancel({ notifications: pend.notifications.map(function (n) { return { id: n.id }; }) });
    }
    var hour = parseInt(state.settings.notif_hour || "9", 10);
    var before = state.settings.notif_before !== "0";
    var now = Date.now(), list = [];
    state.subs.forEach(function (s) {
      var at = atHour(s.end, hour);
      if (at.getTime() > now) list.push({ id: s.id * 10 + 1, title: "انتهى اشتراك", body: s.name + " - اشتراك " + TYPE_AR[s.type] + " خلص النهارده", channelId: "expiry", schedule: { at: at, allowWhileIdle: true } });
      if (before) {
        var b = atHour(addDays(s.end, -1), hour);
        if (b.getTime() > now) list.push({ id: s.id * 10 + 2, title: "اشتراك هينتهي بكرة", body: s.name + " - اشتراكه هينتهي بكرة", channelId: "expiry", schedule: { at: b, allowWhileIdle: true } });
      }
    });
    if (list.length) await LN.schedule({ notifications: list });
  } catch (e) {}
}

/* =====================================================================
   واجهة
   ===================================================================== */
var app = document.getElementById("app");
var toastT;
function toast(m) {
  var o = document.querySelector(".toast"); if (o) o.remove();
  var t = document.createElement("div"); t.className = "toast"; t.textContent = m; document.body.appendChild(t);
  clearTimeout(toastT); toastT = setTimeout(function () { t.remove(); }, 2300);
}
function sheet(html) {
  closeSheet();
  var o = document.createElement("div"); o.className = "ov"; o.id = "ov";
  o.innerHTML = '<div class="sheet">' + html + "</div>";
  o.addEventListener("click", function (e) { if (e.target === o) closeSheet(); });
  document.body.appendChild(o);
}
function closeSheet() { var o = document.getElementById("ov"); if (o) o.remove(); }

function logo(size) {
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 120 120" aria-hidden="true">' +
    '<defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#0a5fcf"/></linearGradient></defs>' +
    '<rect width="120" height="120" rx="30" fill="url(#lg)"/>' +
    '<rect x="4" y="4" width="112" height="112" rx="27" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="3"/>' +
    '<g transform="rotate(-35 60 60)" fill="#fff">' +
    '<rect x="30" y="55" width="60" height="10" rx="5"/>' +
    '<rect x="36" y="36" width="12" height="48" rx="4"/><rect x="72" y="36" width="12" height="48" rx="4"/>' +
    '<rect x="22" y="44" width="11" height="32" rx="4"/><rect x="87" y="44" width="11" height="32" rx="4"/></g></svg>';
}
function head() {
  return '<header><div class="brand">' + logo(48) + "<div><h1>" + esc(gymName()) + "</h1><p>" + fmt(today()) + "</p></div></div></header>";
}

/* ----- شاشة القفل ----- */
function viewLock() {
  var titles = { setup1: "اعمل رقم سري للتطبيق", setup2: "اكتب الرقم السري تاني للتأكيد", enter: "اكتب الرقم السري" };
  var dots = ""; for (var i = 0; i < PIN_LEN; i++) dots += '<i class="' + (i < ui.pin.length ? "f" : "") + '"></i>';
  var keys = "";
  [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(function (n) { keys += '<button data-act="key" data-v="' + n + '" aria-label="' + n + '">' + n + "</button>"; });
  keys += '<button class="sp" disabled></button><button data-act="key" data-v="0" aria-label="0">0</button><button data-act="back" aria-label="مسح">⌫</button>';
  return '<div class="lock">' + logo(86) + "<h1>" + esc(gymName()) + "</h1>" +
    '<div class="msg ' + (ui.err ? "err" : "") + '">' + esc(ui.msg || titles[ui.mode]) + "</div>" +
    '<div class="dots">' + dots + '</div><div class="pad">' + keys + "</div>" +
    (ui.changing ? '<button class="btn sm ghost" style="margin-top:14px" data-act="cancelpin">إلغاء</button>' : "") + "</div>";
}
async function pinPress(d) {
  if (ui.pin.length >= PIN_LEN) return;
  ui.pin += d; ui.err = false; ui.msg = "";
  if (ui.pin.length < PIN_LEN) { render(); return; }
  var pin = ui.pin; ui.pin = "";
  if (ui.mode === "setup1") { ui.first = pin; ui.mode = "setup2"; render(); return; }
  if (ui.mode === "setup2") {
    if (pin !== ui.first) { ui.mode = "setup1"; ui.first = ""; ui.err = true; ui.msg = "الرقمين مش زي بعض، ابدأ من الأول"; render(); return; }
    var salt = randHex(16);
    await setSetting("pin_salt", salt);
    await setSetting("pin_hash", hex(await pbkdf2(pin, unhex(salt), 256)));
    await setSetting("fails", "0"); await setSetting("lock_until", "0");
    ui.changing = false; await unlock(true); return;
  }
  var until = parseInt(state.settings.lock_until || "0", 10);
  if (Date.now() < until) { ui.err = true; ui.msg = "استنى " + Math.ceil((until - Date.now()) / 1000) + " ثانية وحاول تاني"; render(); return; }
  var h = hex(await pbkdf2(pin, unhex(state.settings.pin_salt), 256));
  if (h === state.settings.pin_hash) { await setSetting("fails", "0"); await setSetting("lock_until", "0"); await unlock(false); return; }
  var f = parseInt(state.settings.fails || "0", 10) + 1;
  await setSetting("fails", f);
  if (f >= 5) await setSetting("lock_until", Date.now() + Math.min(30 * Math.pow(2, f - 5), 3600) * 1000);
  ui.err = true; ui.msg = f >= 5 ? "محاولات كتير، استنى شوية" : "الرقم السري غلط";
  render();
}
async function unlock(first) {
  ui.locked = false; ui.pin = ""; ui.msg = ""; ui.err = false; ui.tab = "home";
  render();
  if (state.settings.notif_asked !== "1") { await setSetting("notif_asked", "1"); await ensureNotif(); }
  await scheduleAll();
  cleanCache();
  if (!first) checkExpired();
}
function lockNow() {
  ui.locked = true; ui.mode = "enter"; ui.pin = ""; ui.msg = ""; ui.err = false; closeSheet(); render();
}

/* ----- الرئيسية ----- */
function itemHtml(s) {
  var st = status(s);
  return '<div class="item ' + st.k + '"><div class="top"><div><div class="nm">' + esc(s.name) + "</div>" +
    '<div class="meta">' + TYPE_AR[s.type] + " • من " + fmt(s.start) + " إلى " + fmt(s.end) + "</div></div>" +
    '<span class="badge">' + st.txt + "</span></div>" +
    '<div class="acts"><button class="btn sm" data-act="renew" data-id="' + s.id + '">تجديد</button>' +
    '<button class="btn sm ghost" data-act="receipt" data-id="' + s.id + '">وصل</button>' +
    '<button class="btn sm danger" data-act="del" data-id="' + s.id + '">حذف</button></div></div>';
}
function viewHome() {
  var c = counts(), t = sumDay(today());
  var exp = state.subs.filter(function (s) { return status(s).k === "exp"; }).sort(function (a, b) { return diff(b.end, a.end); });
  var h = '<div class="stats"><div class="stat money"><span>ربح النهارده</span><b>' + money(t.total) + "</b></div>" +
    '<div class="stat"><b>' + c.ok + "</b><span>اشتراك شغال</span></div>" +
    '<div class="stat"><b style="color:var(--bad)">' + c.exp + "</b><span>اشتراك منتهي</span></div>" +
    '<div class="stat"><b>' + c.all + "</b><span>كل المشتركين</span></div>" +
    '<div class="stat"><b style="color:var(--warn)">' + c.soon + "</b><span>هيخلص خلال 3 أيام</span></div></div>";
  h += '<div class="card"><h2>اشتراكات انتهت</h2>';
  if (!exp.length) h += '<div class="empty">مفيش اشتراكات منتهية دلوقتي</div>';
  exp.forEach(function (s) { h += itemHtml(s); });
  return h + "</div>";
}

/* ----- المشتركين ----- */
function chip(k, t) { return '<button class="chip ' + (ui.filter === k ? "on" : "") + '" data-act="filter" data-v="' + k + '">' + t + "</button>"; }
function listHtml() {
  var q = ui.q.trim().toLowerCase();
  var arr = state.subs.filter(function (s) {
    var k = status(s).k;
    if (ui.filter === "ok" && k === "exp") return false;
    if (ui.filter === "soon" && k !== "soon") return false;
    if (ui.filter === "exp" && k !== "exp") return false;
    return !q || s.name.toLowerCase().indexOf(q) > -1;
  }).sort(function (a, b) { return diff(a.end, b.end); });
  if (!arr.length) return '<div class="empty">' + (state.subs.length ? "مفيش نتايج" : "لسه مفيش مشتركين. ضيف أول مشترك من فوق") + "</div>";
  return arr.map(itemHtml).join("");
}
function viewSubs() {
  var c = counts();
  var h = '<div class="card"><h2>مشترك جديد</h2>' +
    '<label for="n">الاسم</label><input id="n" autocomplete="off" placeholder="اسم المشترك">' +
    '<label>نوع الاشتراك</label><div class="seg" id="typeSeg">' +
    '<button data-act="type" data-v="month" class="' + (ui.type === "month" ? "on" : "") + '">شهر</button>' +
    '<button data-act="type" data-v="half" class="' + (ui.type === "half" ? "on" : "") + '">نص شهر</button></div>' +
    '<div class="row2"><div><label for="d">تاريخ البداية</label><input id="d" type="date" value="' + today() + '"></div>' +
    '<div><label for="p">السعر</label><input id="p" type="number" inputmode="decimal" min="0" value="' + esc(lastPrice(ui.type)) + '" placeholder="0"></div></div>' +
    '<button class="btn" data-act="addsub">حفظ المشترك</button></div>';
  h += '<div class="card"><h2>المشتركين</h2><input id="q" placeholder="ابحث بالاسم" value="' + esc(ui.q) + '">' +
    '<div class="chips">' + chip("all", "الكل (" + c.all + ")") + chip("ok", "شغال (" + c.ok + ")") +
    chip("soon", "قرب يخلص (" + c.soon + ")") + chip("exp", "منتهي (" + c.exp + ")") +
    '</div><div id="list">' + listHtml() + "</div></div>";
  return h;
}

/* ----- الحصص ----- */
function viewSession() {
  var t = today();
  var list = state.pays.filter(function (p) { return p.kind === "session" && p.date === t; }).reverse();
  var h = '<div class="card"><h2>حصة جديدة</h2>' +
    '<label for="sn">الاسم</label><input id="sn" autocomplete="off" placeholder="اسم اللاعب">' +
    '<label for="sp">سعر الحصة</label><input id="sp" type="number" inputmode="decimal" min="0" value="' + esc(lastPrice("session")) + '" placeholder="0">' +
    '<button class="btn" data-act="addses">تسجيل الحصة</button></div>';
  h += '<div class="card"><h2>حصص النهارده</h2>';
  if (!list.length) h += '<div class="empty">لسه مفيش حصص النهارده</div>';
  list.forEach(function (p) { h += '<div class="line"><div>' + esc(p.name) + '</div><div class="amt">' + money(p.amount) + "</div></div>"; });
  return h + "</div>";
}

/* ----- الأرباح ----- */
function viewProfit() {
  var d = ui.pdate, s = sumDay(d), ym = d.slice(0, 7), mt = 0;
  state.pays.forEach(function (p) { if (p.date.slice(0, 7) === ym) mt += p.amount; });
  var list = state.pays.filter(function (p) { return p.date === d; }).reverse();
  var h = '<div class="card"><h2>الأرباح</h2><label for="pd">اليوم</label><input id="pd" type="date" value="' + d + '">' +
    '<div class="stat money" style="margin-top:12px"><span>إجمالي ربح ' + fmt(d) + "</span><b>" + money(s.total) + "</b></div>" +
    '<div class="split"><div><small>اشتراكات</small><b>' + money(s.sub) + "</b></div><div><small>حصص</small><b>" + money(s.ses) + "</b></div></div>" +
    '<p class="note">إجمالي الشهر ده: <b>' + money(mt) + "</b></p></div>";
  h += '<div class="card"><h2>تفاصيل اليوم</h2>';
  if (!list.length) h += '<div class="empty">مفيش حركات في اليوم ده</div>';
  list.forEach(function (p) {
    h += '<div class="line"><div>' + esc(p.name) + "<small>" + (p.kind === "sub" ? esc(p.note || "اشتراك") : "حصة") + '</small></div><div class="amt">' + money(p.amount) + "</div></div>";
  });
  return h + "</div>";
}

/* ----- الإعدادات ----- */
function viewSettings() {
  var hour = parseInt(state.settings.notif_hour || "9", 10), before = state.settings.notif_before !== "0";
  var opts = HOURS.map(function (h) {
    var label = (h > 12 ? h - 12 : h) + (h >= 12 ? " مساءً" : " صباحًا");
    return '<option value="' + h + '"' + (h === hour ? " selected" : "") + ">" + label + "</option>";
  }).join("");
  return '<div class="card"><h2>اسم الجيم</h2><input id="gn" value="' + esc(state.settings.gym_name || "") + '" placeholder="اكتب اسم الجيم">' +
    '<button class="btn" data-act="savegym">حفظ الاسم</button></div>' +
    '<div class="card"><h2>التنبيهات</h2>' +
    '<label for="nh">وقت التنبيه يوم انتهاء الاشتراك</label><select id="nh">' + opts + "</select>" +
    '<label>تنبيه قبلها بيوم</label><div class="seg"><button data-act="before" data-v="1" class="' + (before ? "on" : "") + '">أيوه</button>' +
    '<button data-act="before" data-v="0" class="' + (!before ? "on" : "") + '">لأ</button></div>' +
    '<button class="btn ghost" data-act="perm">تفعيل صلاحيات التنبيه</button>' +
    '<p class="note">لو الإشعارات مش بتوصل: افتح إعدادات التليفون ← التطبيقات ← إدارة الجيم ← البطارية ← "بدون قيود"، وفعّل التشغيل التلقائي لو موجود.</p></div>' +
    '<div class="card"><h2>الأمان</h2><p class="note" style="margin-top:0">البيانات متشفرة على التليفون ومحدش يقدر يفتحها من برة التطبيق.</p>' +
    '<div class="tools"><button class="btn sm" data-act="chpin">تغيير الرقم السري</button><button class="btn sm ghost" data-act="lock">قفل التطبيق</button></div></div>' +
    '<div class="card"><h2>نسخة احتياطية</h2><p class="note" style="margin-top:0">النسخة بتتشفر بكلمة سر تختارها. احتفظ بيها بعيد عن التليفون، لأن لو التطبيق اتمسح البيانات بتروح.</p>' +
    '<div class="tools"><button class="btn sm" data-act="export">حفظ نسخة</button><button class="btn sm ghost" data-act="import">استرجاع نسخة</button></div>' +
    '<input id="file" type="file" hidden></div>';
}

function nav() {
  var t = [["home", "الرئيسية"], ["subs", "المشتركين"], ["ses", "الحصص"], ["profit", "الأرباح"], ["set", "الإعدادات"]];
  return '<nav><div class="in">' + t.map(function (x) {
    return '<button data-act="tab" data-v="' + x[0] + '" class="' + (ui.tab === x[0] ? "on" : "") + '">' + x[1] + "</button>"; }).join("") + "</div></nav>";
}
function render(keep) {
  var y = window.scrollY;
  if (ui.locked) { app.innerHTML = viewLock(); return; }
  var v = { home: viewHome, subs: viewSubs, ses: viewSession, profit: viewProfit, set: viewSettings }[ui.tab]();
  app.innerHTML = head() + v + nav();
  window.scrollTo(0, keep ? y : 0);
}

/* ----- تجديد ----- */
function openRenew(id) {
  var s = state.subs.find(function (x) { return x.id === id; }); if (!s) return;
  ui.rtype = s.type;
  var from = diff(s.end, today()) > 0 ? s.end : today();
  sheet("<h2>تجديد اشتراك " + esc(s.name) + "</h2>" +
    '<p class="note" style="margin-top:0">التجديد هيبدأ من ' + fmt(from) + "</p>" +
    '<label>نوع التجديد</label><div class="seg">' +
    '<button data-act="rtype" data-v="month" class="' + (s.type === "month" ? "on" : "") + '">شهر</button>' +
    '<button data-act="rtype" data-v="half" class="' + (s.type === "half" ? "on" : "") + '">نص شهر</button></div>' +
    '<label for="rp">السعر</label><input id="rp" type="number" inputmode="decimal" min="0" value="' + esc(lastPrice(s.type) || s.price || "") + '">' +
    '<button class="btn" data-act="dorenew" data-id="' + id + '">تأكيد التجديد</button>' +
    '<button class="btn ghost" data-act="close">إلغاء</button>');
}

/* ----- تنبيه داخل التطبيق ----- */
async function checkExpired() {
  var al = {}; try { al = JSON.parse(state.settings.alerted || "{}"); } catch (e) {}
  var fresh = state.subs.filter(function (s) { return status(s).k === "exp" && al[s.id] !== s.end; });
  if (!fresh.length) return;
  sheet("<h2>انتهى اشتراك " + fresh.length + (fresh.length > 1 ? " مشتركين" : " مشترك") + "</h2><div style=\"margin:8px 0\">" +
    fresh.map(function (s) { return '<div class="line"><div>' + esc(s.name) + "<small>انتهى في " + fmt(s.end) + "</small></div></div>"; }).join("") +
    '</div><button class="btn" data-act="close">تمام</button>');
  fresh.forEach(function (s) { al[s.id] = s.end; });
  await setSetting("alerted", JSON.stringify(al));
}

/* =====================================================================
   الأحداث
   ===================================================================== */
document.addEventListener("click", function (e) {
  var b = e.target.closest("[data-act]"); if (!b) return;
  handle(b.dataset.act, b.dataset.v, b.dataset.id ? parseInt(b.dataset.id, 10) : null).catch(function (err) { toast("حصلت مشكلة، حاول تاني"); });
});

async function handle(a, v, id) {
  if (a === "key") return pinPress(v);
  if (a === "back") { ui.pin = ui.pin.slice(0, -1); return render(); }
  if (a === "cancelpin") { ui.changing = false; ui.locked = false; return render(); }

  if (a === "tab") { ui.tab = v; render(); }
  else if (a === "type") {
    ui.type = v;
    document.querySelectorAll("#typeSeg button").forEach(function (x) { x.classList.toggle("on", x.dataset.v === v); });
    var pe = document.getElementById("p"); if (pe && !pe.dataset.touched) pe.value = lastPrice(v);
  }
  else if (a === "filter") { ui.filter = v; render(true); }
  else if (a === "addsub") {
    var n = document.getElementById("n").value.trim(), d = document.getElementById("d").value, p = priceVal(document.getElementById("p"));
    if (!n) return toast("اكتب اسم المشترك");
    if (!d) return toast("اختار تاريخ البداية");
    if (p === null) return toast("اكتب السعر");
    var res = await addSub(n, ui.type, d, p); render(); showReceipt(receiptData(res.sub, res.pay));
  }
  else if (a === "renew") openRenew(id);
  else if (a === "rtype") {
    ui.rtype = v;
    document.querySelectorAll(".sheet .seg button").forEach(function (x) { x.classList.toggle("on", x.dataset.v === v); });
    var rp = document.getElementById("rp"); if (rp && lastPrice(v)) rp.value = lastPrice(v);
  }
  else if (a === "dorenew") {
    var pr = priceVal(document.getElementById("rp")); if (pr === null) return toast("اكتب السعر");
    var rr = await renewSub(id, ui.rtype, pr); closeSheet(); render(true); if (rr) showReceipt(receiptData(rr.sub, rr.pay));
  }
  else if (a === "close") closeSheet();
  else if (a === "receipt") {
    var rs = state.subs.find(function (x) { return x.id === id; }); if (!rs) return;
    var lastPay = null;
    state.pays.forEach(function (q) { if (q.subId === rs.id) lastPay = q; });
    showReceipt(receiptData(rs, lastPay));
  }
  else if (a === "shrec") {
    if (!curReceipt) return;
    var fn = "receipt-" + curReceipt.no + ".png", b64 = curReceipt.url.split(",")[1];
    if (native && plug("Filesystem") && plug("Share")) {
      var w = await plug("Filesystem").writeFile({ path: fn, data: b64, directory: "CACHE" });
      await plug("Share").share({ title: "وصل اشتراك", url: w.uri, dialogTitle: "اختار الطباعة أو واتساب" });
    } else {
      var l = document.createElement("a"); l.href = curReceipt.url; l.download = fn; document.body.appendChild(l); l.click(); l.remove();
    }
  }
  else if (a === "del") {
    var s = state.subs.find(function (x) { return x.id === id; }); if (!s) return;
    sheet("<h2>حذف " + esc(s.name) + "؟</h2><p class=\"note\" style=\"margin-top:0\">هيتمسح من المشتركين. سجل الأرباح القديم هيفضل زي ما هو.</p>" +
      '<button class="btn red" data-act="dodel" data-id="' + id + '">احذف</button><button class="btn ghost" data-act="close">إلغاء</button>');
  }
  else if (a === "dodel") {
    await Store.deleteSub(id); state.subs = state.subs.filter(function (x) { return x.id !== id; });
    await scheduleAll(); closeSheet(); toast("تم الحذف"); render(true);
  }
  else if (a === "addses") {
    var sn = document.getElementById("sn").value.trim(), sp = priceVal(document.getElementById("sp"));
    if (!sn) return toast("اكتب اسم اللاعب");
    if (sp === null) return toast("اكتب سعر الحصة");
    var pay = { date: today(), amount: sp, kind: "session", name: sn, note: null, subId: null };
    pay.id = await Store.insertPay(pay); state.pays.push(pay);
    await saveLastPrice("session", sp); toast("تم تسجيل الحصة"); render(true);
    var el = document.getElementById("sn"); if (el) el.focus();
  }
  else if (a === "savegym") {
    await setSetting("gym_name", document.getElementById("gn").value.trim()); toast("تم الحفظ"); render(true);
  }
  else if (a === "before") { await setSetting("notif_before", v); await scheduleAll(); render(true); }
  else if (a === "perm") { var ok = await ensureNotif(); await scheduleAll(); toast(ok ? "التنبيهات شغالة" : "التنبيهات مش مفعّلة"); }
  else if (a === "chpin") { ui.changing = true; ui.locked = true; ui.mode = "setup1"; ui.pin = ""; ui.first = ""; ui.msg = ""; render(); }
  else if (a === "lock") lockNow();
  else if (a === "export") {
    sheet("<h2>كلمة سر النسخة</h2><p class=\"note\" style=\"margin-top:0\">هتحتاجها وقت الاسترجاع. لو نسيتها النسخة مش هتتفتح.</p>" +
      '<label for="bp">كلمة السر</label><input id="bp" type="password" autocomplete="off">' +
      '<button class="btn" data-act="doexport">حفظ النسخة</button><button class="btn ghost" data-act="close">إلغاء</button>');
  }
  else if (a === "doexport") {
    var pw = document.getElementById("bp").value;
    if (pw.length < 4) return toast("كلمة السر لازم 4 حروف على الأقل");
    var text = await encryptBackup({ subs: state.subs, pays: state.pays }, pw);
    var fname = "gym-backup-" + today() + ".gymbak";
    closeSheet();
    if (native && plug("Filesystem") && plug("Share")) {
      var r = await plug("Filesystem").writeFile({ path: fname, data: text, directory: "CACHE", encoding: "utf8" });
      await plug("Share").share({ title: "نسخة احتياطية", url: r.uri });
    } else {
      var u = URL.createObjectURL(new Blob([text], { type: "application/json" })), l = document.createElement("a");
      l.href = u; l.download = fname; document.body.appendChild(l); l.click(); l.remove();
    }
  }
  else if (a === "import") document.getElementById("file").click();
  else if (a === "doimport") {
    var pw2 = document.getElementById("ip").value, data;
    try { data = await decryptBackup(pendingImport, pw2); } catch (err) { return toast("كلمة السر غلط أو الملف تالف"); }
    if (!data || !Array.isArray(data.subs) || !Array.isArray(data.pays)) return toast("الملف ده مش نسخة صحيحة");
    await Store.replaceAll(data.subs, data.pays);
    state.subs = data.subs; state.pays = data.pays; pendingImport = null;
    await scheduleAll(); closeSheet(); toast("تم استرجاع النسخة"); render();
  }
}

document.addEventListener("input", function (e) {
  if (e.target.id === "q") { ui.q = e.target.value; document.getElementById("list").innerHTML = listHtml(); }
  if (e.target.id === "p") e.target.dataset.touched = "1";
});
document.addEventListener("change", async function (e) {
  if (e.target.id === "pd" && e.target.value) { ui.pdate = e.target.value; render(true); }
  if (e.target.id === "nh") { await setSetting("notif_hour", e.target.value); await scheduleAll(); toast("تم حفظ الوقت"); }
  if (e.target.id === "file" && e.target.files[0]) {
    var r = new FileReader();
    r.onload = function () {
      pendingImport = r.result;
      sheet("<h2>استرجاع نسخة</h2><p class=\"note\" style=\"margin-top:0\">الاسترجاع هيستبدل كل البيانات الحالية.</p>" +
        '<label for="ip">كلمة سر النسخة</label><input id="ip" type="password" autocomplete="off">' +
        '<button class="btn" data-act="doimport">استرجاع</button><button class="btn ghost" data-act="close">إلغاء</button>');
    };
    r.readAsText(e.target.files[0]); e.target.value = "";
  }
});

/* ستارة تخفي البيانات في شاشة التطبيقات الأخيرة + قفل تلقائي */
document.addEventListener("visibilitychange", function () {
  var c = document.getElementById("curtain");
  if (document.hidden) {
    hiddenAt = Date.now();
    if (!c) { c = document.createElement("div"); c.id = "curtain"; c.className = "curtain"; document.body.appendChild(c); }
  } else {
    if (c) c.remove();
    if (!ui.locked && hiddenAt && Date.now() - hiddenAt > 30000) lockNow();
    else if (!ui.locked) { render(true); checkExpired(); scheduleAll(); }
  }
});

/* =====================================================================
   التشغيل
   ===================================================================== */
(async function boot() {
  try {
    await Store.init();
    var all = await Store.loadAll();
    state.subs = all.subs; state.pays = all.pays; state.settings = all.settings;
    await initChannel();
    ui.mode = state.settings.pin_hash ? "enter" : "setup1";
    ui.locked = true;
    render();
  } catch (err) {
    app.innerHTML = '<div class="lock"><h1>تعذر فتح قاعدة البيانات</h1><div class="msg err">اقفل التطبيق وافتحه تاني</div></div>';
  }
})();
})();
