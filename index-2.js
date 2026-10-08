const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");

const PHONE_NUMBER = process.env.PHONE_NUMBER;
const MAX_LINKS = 3; // أكثر من 3 روابط = طرد تلقائي

// كلمات السب الممنوعة، عدّل فيها زي ما تريد
// تطبيع الحروف عشان يلقط التشكيل والتاء المربوطة والهمزات
const clean = (s) =>
  s
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[\u064B-\u0652ـ]/g, "");

// كلمات طويلة: تنحجب حتى لو جات داخل كلمة أو ملصوقة
const BAD_SUBSTR = [
  "كسمك", "سب الدين", "شرموطه", "قحبه", "متناك", "جعبات",
].map(clean);

// كلمات قصيرة: تنحجب لو جات كلمة لوحدها بس (عشان ما نحجب كلمات سليمة)
const BAD_EXACT = [
  "امك", "ابوك", "زب", "كس",
  "كلب", "حمار", "حيوان", "غبي", "زفت", "قذر", "تافه", "وسخ",
].map(clean);

function hasBad(text) {
  const t = clean(text);
  if (BAD_SUBSTR.some((w) => t.includes(w))) return true;
  const words = t.split(/[\s.,،؟?!:;()"'\-_]+/);
  return words.some((w) => BAD_EXACT.includes(w));
}

const LINK_RE =
  /(https?:\/\/|www\.|chat\.whatsapp\.com|\b[a-z0-9-]+\.(com|net|org|me|io|xyz|ly|co)\b)/i;

// ---------- الإعدادات المحفوظة ----------
const DB_FILE = "settings.json";
let db = { groups: {} };
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
} catch {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
const gset = (jid) => {
  if (!db.groups[jid])
    db.groups[jid] = {
      welcome: true,
      welcomeText: "أهلاً {name} 👋\nنورتنا يا حب، ح تستمتع معانا لو احترمت نفسك",
      antiLink: false,
      antiInsult: false,
      antiSticker: false,
      muted: [],
    };
  return db.groups[jid];
};

const strikes = {}; // عداد الروابط
const games = {}; // لعبة الإيموجي

// ---------- أدوات ----------
const norm = (j) => (j ? j.replace(/:\d+@/, "@") : j);
const num = (j) => (j || "").split("@")[0];

function getText(msg) {
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ""
  );
}

function getTargets(m, args) {
  const ctx = m.message.extendedTextMessage?.contextInfo;
  const list = [...(ctx?.mentionedJid || [])];
  if (!list.length && ctx?.participant) list.push(ctx.participant);
  for (const a of args) {
    const d = a.replace(/\D/g, "");
    if (d.length >= 8 && d.length <= 15) list.push(d + "@s.whatsapp.net");
  }
  return [...new Set(list)];
}

const CMDS = {
  kick: ["طرد", "kick"],
  add: ["اضافة", "اضافه", "add"],
  mute: ["كتم", "mute"],
  unmute: ["فك_الكتم", "فك", "unmute"],
  tagall: ["منشن", "tagall"],
  setname: ["اسم", "setname"],
  setpic: ["صورة", "صوره", "setpic"],
  welcome: ["ترحيب", "welcome"],
  setwelcome: ["ضبط_ترحيب", "setwelcome"],
  antilink: ["منع_الروابط", "antilink"],
  antiinsult: ["منع_السب", "antiinsult"],
  antisticker: ["منع_الملصقات", "antisticker"],
  lock: ["قفل", "lock"],
  open: ["فتح", "open"],
  dice: ["نرد", "dice"],
  luck: ["حظ", "luck"],
  emoji: ["ايموجي", "emoji"],
  guess: ["خمن", "guess"],
  help: ["اوامر", "help"],
  ping: ["ping"],
};
const ADMIN_ONLY = new Set([
  "kick", "add", "mute", "unmute", "tagall", "setname", "setpic",
  "welcome", "setwelcome", "antilink", "antiinsult", "antisticker",
  "lock", "open",
]);
const findCmd = (n) => Object.keys(CMDS).find((k) => CMDS[k].includes(n));

const HELP = `🤖 *أوامر البوت*

👮 *للمشرفين فقط:*
!طرد @شخص
!اضافة 249xxxxxxxxx
!كتم @شخص  |  !فك_الكتم @شخص
!منشن [رسالة]
!اسم الاسم_الجديد
!صورة (مع صورة أو بالرد على صورة)
!ترحيب تشغيل/ايقاف
!ضبط_ترحيب النص (استخدم {name} للاسم)
!منع_الروابط تشغيل/ايقاف
!منع_السب تشغيل/ايقاف
!منع_الملصقات تشغيل/ايقاف
!قفل  |  !فتح

🎮 *للجميع:*
!نرد  🎲
!حظ  🍀
!ايموجي  ثم  !خمن 🦁
!اوامر`;

// ---------- المعالج الرئيسي ----------
async function handle(sock, m) {
  if (!m.message) return;
  const jid = m.key.remoteJid;
  if (!jid || jid === "status@broadcast") return;

  const isGroup = jid.endsWith("@g.us");
  const fromMe = !!m.key.fromMe;
  const sender = norm(fromMe ? sock.user.id : m.key.participant || jid);
  const text = getText(m.message).trim();
  const reply = (t, mentions = []) =>
    sock.sendMessage(jid, { text: t, mentions }, { quoted: m });
  const del = () => sock.sendMessage(jid, { delete: m.key }).catch(() => {});

  // هل المرسل مشرف؟ (صاحب البوت يُعتبر مشرف دائماً)
  let admin = fromMe;
  let meta = null;
  if (isGroup) {
    meta = await sock.groupMetadata(jid).catch(() => null);
    if (meta && !admin)
      admin = meta.participants.some(
        (p) => p.admin && (norm(p.id) === sender || norm(p.phoneNumber) === sender)
      );
  }

  // ---------- الحماية التلقائية (للأعضاء فقط) ----------
  if (isGroup && !admin) {
    const g = gset(jid);

    if (g.muted.includes(sender)) return del();

    if (g.antiSticker && m.message.stickerMessage) return del();

    if (g.antiLink && LINK_RE.test(text)) {
      await del();
      const key = jid + sender;
      strikes[key] = (strikes[key] || 0) + 1;
      if (strikes[key] > MAX_LINKS) {
        strikes[key] = 0;
        await reply(`🚫 تم طرد @${num(sender)} بسبب تكرار الروابط`, [sender]);
        await sock.groupParticipantsUpdate(jid, [sender], "remove").catch(() => {});
      } else {
        await sock.sendMessage(jid, {
          text: `⚠️ @${num(sender)} الروابط ممنوعة (${strikes[key]}/${MAX_LINKS})`,
          mentions: [sender],
        });
      }
      return;
    }

    if (g.antiInsult && hasBad(text)) {
      await del();
      return sock.sendMessage(jid, {
        text: `⚠️ @${num(sender)} السب ممنوع في القروب`,
        mentions: [sender],
      });
    }
  }

  // ---------- الأوامر ----------
  if (!text.startsWith("!")) return;
  const args = text.slice(1).split(/\s+/);
  const cmd = findCmd((args.shift() || "").toLowerCase());
  if (!cmd) return;

  if (ADMIN_ONLY.has(cmd)) {
    if (!isGroup) return reply("هذا الأمر داخل القروب فقط");
    if (!admin) return reply("🚫 هذا الأمر للمشرفين فقط");
  }
  const g = isGroup ? gset(jid) : null;
  const onoff = (a) => (["تشغيل", "on", "فتح"].includes(a) ? true : ["ايقاف", "off", "إيقاف"].includes(a) ? false : null);

  try {
    switch (cmd) {
      case "ping":
        return reply("pong 🏓");

      case "help":
        return reply(HELP);

      case "kick": {
        const t = getTargets(m, args);
        if (!t.length) return reply("منشن الشخص أو رد على رسالته");
        await sock.groupParticipantsUpdate(jid, t, "remove");
        return reply("✅ تم الطرد");
      }

      case "add": {
        const t = getTargets(m, args);
        if (!t.length) return reply("اكتب الرقم: !اضافة 249xxxxxxxxx");
        await sock.groupParticipantsUpdate(jid, t, "add");
        return reply("✅ تمت محاولة الإضافة");
      }

      case "mute": {
        const t = getTargets(m, args).map(norm);
        if (!t.length) return reply("منشن الشخص أو رد على رسالته");
        t.forEach((x) => !g.muted.includes(x) && g.muted.push(x));
        save();
        return reply("🔇 تم الكتم، أي رسالة منه حتتحذف تلقائياً");
      }

      case "unmute": {
        const t = getTargets(m, args).map(norm);
        g.muted = g.muted.filter((x) => !t.includes(x));
        save();
        return reply("🔊 تم فك الكتم");
      }

      case "tagall": {
        const ids = meta.participants.map((p) => p.id);
        const msg = args.join(" ") || "انتبهوا جميعاً";
        const list = ids.map((i) => `@${num(i)}`).join(" ");
        return sock.sendMessage(jid, {
          text: `📢 ${msg}\n\n${list}`,
          mentions: ids,
        });
      }

      case "setname": {
        const name = args.join(" ");
        if (!name) return reply("اكتب الاسم: !اسم اسم القروب");
        await sock.groupUpdateSubject(jid, name);
        return reply("✅ تم تغيير اسم القروب");
      }

      case "setpic": {
        const ctx = m.message.extendedTextMessage?.contextInfo;
        let src = null;
        if (m.message.imageMessage) src = m;
        else if (ctx?.quotedMessage?.imageMessage)
          src = {
            key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant },
            message: ctx.quotedMessage,
          };
        if (!src) return reply("ارسل صورة مع الأمر !صورة أو رد على صورة");
        const buf = await downloadMediaMessage(src, "buffer", {});
        await sock.updateProfilePicture(jid, buf);
        return reply("✅ تم تغيير صورة القروب");
      }

      case "welcome": {
        const v = onoff(args[0]);
        if (v === null) return reply("اكتب: !ترحيب تشغيل  أو  !ترحيب ايقاف");
        g.welcome = v;
        save();
        return reply(v ? "✅ الترحيب شغال" : "⛔ الترحيب متوقف");
      }

      case "setwelcome": {
        const t = args.join(" ");
        if (!t) return reply("اكتب النص، واستخدم {name} للاسم");
        g.welcomeText = t;
        save();
        return reply("✅ تم حفظ رسالة الترحيب");
      }

      case "antilink":
      case "antiinsult":
      case "antisticker": {
        const v = onoff(args[0]);
        if (v === null) return reply("اكتب: تشغيل أو ايقاف");
        const key = { antilink: "antiLink", antiinsult: "antiInsult", antisticker: "antiSticker" }[cmd];
        g[key] = v;
        save();
        return reply(v ? "✅ تم التشغيل" : "⛔ تم الإيقاف");
      }

      case "lock":
        await sock.groupSettingUpdate(jid, "announcement");
        return reply("🔒 تم قفل الشات، المشرفين فقط");

      case "open":
        await sock.groupSettingUpdate(jid, "not_announcement");
        return reply("🔓 تم فتح الشات للجميع");

      case "dice":
        return reply(`🎲 طلع لك: *${1 + Math.floor(Math.random() * 6)}*`);

      case "luck": {
        const n = Math.floor(Math.random() * 101);
        const e = n > 80 ? "🔥" : n > 50 ? "😎" : n > 25 ? "😐" : "😭";
        return reply(`🍀 حظك اليوم: *${n}%* ${e}`);
      }

      case "emoji": {
        const ALL = ["😀", "😎", "🤖", "👻", "🦁", "🍕", "⚽", "🚀", "🐍", "🌙"];
        const opts = [...ALL].sort(() => Math.random() - 0.5).slice(0, 4);
        games[jid] = opts[Math.floor(Math.random() * 4)];
        return reply(
          `🎯 خمّن الإيموجي السري!\nالخيارات: ${opts.join("  ")}\n\nاكتب: !خمن ${opts[0]}`
        );
      }

      case "guess": {
        if (!games[jid]) return reply("ابدأ لعبة جديدة بـ !ايموجي");
        if (!args[0]) return reply("اكتب: !خمن 🦁");
        if (args[0] === games[jid]) {
          delete games[jid];
          return reply(`🎉 مبروك @${num(sender)} خمّنت صح!`, [sender]);
        }
        return reply("❌ غلط، حاول مرة ثانية");
      }
    }
  } catch (e) {
    console.log("خطأ في الأمر:", cmd, e.message);
    return reply("❌ ما قدرت أنفذ الأمر. اتأكد إن البوت مشرف في القروب.");
  }
}

// ---------- تشغيل البوت ----------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER) {
      console.log("ضيف متغير البيئة PHONE_NUMBER (مثال: 249912345678)");
      process.exit(1);
    }
    setTimeout(async () => {
      const code = await sock.requestPairingCode(PHONE_NUMBER);
      console.log("كود الربط:", code);
    }, 3000);
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "open") console.log("✅ البوت اتربط بالواتس");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) start();
      else console.log("اتعمل تسجيل خروج، احذف مجلد auth وأعد الربط");
    }
  });

  // الترحيب بالأعضاء الجدد
  sock.ev.on("group-participants.update", async (u) => {
    if (u.action !== "add") return;
    const g = gset(u.id);
    if (!g.welcome) return;
    for (const p of u.participants) {
      const id = typeof p === "string" ? p : p.id;
      await sock.sendMessage(u.id, {
        text: g.welcomeText.replace("{name}", `@${num(id)}`),
        mentions: [id],
      });
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        await handle(sock, m);
      } catch (e) {
        console.log("خطأ:", e.message);
      }
    }
  });
}

start();
