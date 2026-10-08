const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");

// رقمك بالصيغة الدولية بدون + (مثال السودان: 249912345678)
const PHONE_NUMBER = process.env.PHONE_NUMBER;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  // طلب كود الاقتران لو الرقم لسه ما مربوط
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

  // ترحيب بالأعضاء الجدد
  sock.ev.on("group-participants.update", async (u) => {
    if (u.action === "add") {
      for (const p of u.participants) {
        const id = typeof p === "string" ? p : p.id;
        await sock.sendMessage(u.id, {
          text: `أهلاً بيك @${id.split("@")[0]} في القروب 👋`,
          mentions: [id],
        });
      }
    }
  });

  // الأوامر
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const jid = m.key.remoteJid;
    const text =
      m.message.conversation || m.message.extendedTextMessage?.text || "";

    if (text === "!ping") {
      await sock.sendMessage(jid, { text: "pong 🏓" }, { quoted: m });
    }
    if (text === "!help") {
      await sock.sendMessage(jid, {
        text: "الأوامر:\n!ping - اختبار البوت\n!help - المساعدة",
      });
    }
  });
}

start();
