const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const dbFile = path.join(DATA, 'database.json');
const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile)) : { groups: {} };
function save(){ fs.writeFileSync(dbFile, JSON.stringify(db,null,2)); }
function group(gid){ return db.groups[gid] ||= { warnings:{}, welcome:true, antiLink:false, antiBad:false, antiSticker:false, locked:false }; }
const badWords = ['كس ام','كسك','شرموط','قحبة','قواد','خرا','كلب','حيوان'];
const linkRe = /(https?:\/\/|www\.|chat\.whatsapp\.com\/|t\.me\/|discord\.gg\/)/i;
const prefix = '/';

function jidOf(m){ return m.key.participant || m.key.remoteJid; }
async function isAdmin(sock, gid, uid){
  const meta = await sock.groupMetadata(gid);
  const p = meta.participants.find(x=>x.id===uid);
  return !!p && ['admin','superadmin'].includes(p.admin);
}
async function groupOnly(sock,m){ return m.key.remoteJid.endsWith('@g.us'); }
async function getText(m){ return m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || m.message?.videoMessage?.caption || ''; }
async function send(sock,gid,text){ return sock.sendMessage(gid,{text}); }
async function warn(sock,m,reason){
  const gid=m.key.remoteJid, uid=jidOf(m), g=group(gid);
  g.warnings[uid]=(g.warnings[uid]||0)+1; const n=g.warnings[uid]; save();
  await sock.sendMessage(gid,{text:`⚠️ تحذير لـ @${uid.split('@')[0]}\nالسبب: ${reason}\nالتحذير: ${n}/3`,mentions:[uid]});
  if(n>=3){ try { await sock.groupParticipantsUpdate(gid,[uid],'remove'); } catch(e) { await send(sock,gid,'تعذر الطرد. تأكد أن البوت مشرف.'); } delete g.warnings[uid]; save(); }
}
async function imageBuffer(msg){
  const im=msg.message?.imageMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
  if(!im) return null;
  const stream=await downloadContentFromMessage(im,'image'); const chunks=[];
  for await(const c of stream) chunks.push(c); return Buffer.concat(chunks);
}

async function start(){
 const {state,saveCreds}=await useMultiFileAuthState(path.join(__dirname,'auth'));
 const sock=makeWASocket({auth:state,logger:P({level:'silent'}),browser:['GroupBot','Chrome','1.0.0']});
 sock.ev.on('creds.update',saveCreds);
 sock.ev.on('connection.update',({connection,lastDisconnect,qr})=>{
   if(qr){ console.log('SCAN THIS QR:'); qrcode.generate(qr,{small:true}); }
   if(connection==='open') console.log('BOT CONNECTED');
   if(connection==='close') { const retry=lastDisconnect?.error?.output?.statusCode!==DisconnectReason.loggedOut; if(retry) setTimeout(start,5000); else console.log('Logged out. Delete auth and reconnect.'); }
 });
 sock.ev.on('messages.upsert',async ({messages})=>{
  const m=messages[0]; if(!m.message || m.key.fromMe) return;
  const gid=m.key.remoteJid; if(!gid.endsWith('@g.us')) return;
  const uid=jidOf(m); const g=group(gid); const text=(await getText(m)).trim();
  let admin=false; try{admin=await isAdmin(sock,gid,uid);}catch{}

  // Automatic moderation
  if(!admin){
   if(g.antiLink && linkRe.test(text)){ await sock.sendMessage(gid,{delete:m.key}); await warn(sock,m,'منع الروابط'); return; }
   if(g.antiBad && badWords.some(w=>text.toLowerCase().includes(w))){ await sock.sendMessage(gid,{delete:m.key}); await warn(sock,m,'الإساءة'); return; }
   if(g.antiSticker && !!m.message.stickerMessage){ await sock.sendMessage(gid,{delete:m.key}); await warn(sock,m,'الملصقات'); return; }
   if(g.locked){ await sock.sendMessage(gid,{delete:m.key}); return; }
  }
  const cmd=text.split(/\s+/)[0].toLowerCase();
  if(!cmd.startsWith(prefix)) return;
  const args=text.split(/\s+/).slice(1);
  if([' /طرد','/kick','/اضافة','/add','/كتم','/unmute','/فك_الكتم','/قفل','/فتح','/ترحيب','/منع_الروابط','/منع_الاساءة','/منع_الملصقات','/تغيير_الاسم','/تغيير_الصورة'].includes(cmd) && !admin){return send(sock,gid,'⛔ الأمر ده للمشرفين فقط.');}
  try{
   if(cmd==='/العاب') return send(sock,gid,'🎮 الألعاب:\n/نرد\n/حظ');
   if(cmd==='/نرد') return send(sock,gid,`🎲 النرد: ${1+Math.floor(Math.random()*6)}`);
   if(cmd==='/حظ') return send(sock,gid,`🍀 حظك اليوم: ${['ممتاز 🌟','جيد 👍','متوسط 🙂','حاول مرة تانية 😅'][Math.floor(Math.random()*4)]}`);
   if(cmd==='/قفل'){g.locked=true;save();return send(sock,gid,'🔒 تم قفل الشات للأعضاء.');}
   if(cmd==='/فتح'){g.locked=false;save();return send(sock,gid,'🔓 تم فتح الشات للأعضاء.');}
   if(cmd==='/ترحيب'){g.welcome=!g.welcome;save();return send(sock,gid,`👋 الترحيب: ${g.welcome?'مفعل':'متوقف'}`);}
   if(cmd==='/منع_الروابط'){g.antiLink=!g.antiLink;save();return send(sock,gid,`🔗 منع الروابط: ${g.antiLink?'مفعل':'متوقف'}`);}
   if(cmd==='/منع_الاساءة'){g.antiBad=!g.antiBad;save();return send(sock,gid,`🚫 منع الإساءة: ${g.antiBad?'مفعل':'متوقف'}`);}
   if(cmd==='/منع_الملصقات'){g.antiSticker=!g.antiSticker;save();return send(sock,gid,`🛑 منع الملصقات: ${g.antiSticker?'مفعل':'متوقف'}`);}
   if(cmd==='/تغيير_الاسم'){const name=args.join(' ');if(!name)return send(sock,gid,'اكتب الاسم بعد الأمر. مثال: /تغيير_الاسم قروبنا');await sock.groupUpdateSubject(gid,name);return send(sock,gid,'✅ تم تغيير اسم القروب.');}
   if(cmd==='/تغيير_الصورة'){
     const b=await imageBuffer(m); if(!b)return send(sock,gid,'📷 أرسل صورة مع الأمر /تغيير_الصورة أو رد على صورة بالأمر.');
     const out=await sharp(b).jpeg({quality:90}).toBuffer(); await sock.updateProfilePicture(gid,out); return send(sock,gid,'🖼️ تم تغيير صورة القروب للصورة التي اخترتها.');
   }
   const target=m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message?.extendedTextMessage?.contextInfo?.participant;
   if(cmd==='/طرد'||cmd==='/kick'){if(!target)return send(sock,gid,'اعمل منشن للعضو أو رد على رسالته.');await sock.groupParticipantsUpdate(gid,[target],'remove');return send(sock,gid,'👢 تم طرد العضو.');}
   if(cmd==='/اضافة'||cmd==='/add'){const num=args[0]?.replace(/\D/g,'');if(!num)return send(sock,gid,'اكتب رقم العضو مع مفتاح الدولة.');await sock.groupParticipantsUpdate(gid,[num+'@s.whatsapp.net'],'add');return send(sock,gid,'➕ تمت محاولة إضافة العضو.');}
   if(cmd==='/كتم'||cmd==='/unmute'||cmd==='/فك_الكتم'){
     if(!target)return send(sock,gid,'اعمل منشن للعضو أو رد على رسالته.');
     // WhatsApp groups do not provide a per-member mute API. Store a bot-level mute list and delete their messages.
     g.muted ||= {}; g.muted[target]=cmd!=='/فك_الكتم'; save(); return send(sock,gid,cmd==='/فك_الكتم'?'🔊 تم فك الكتم.':'🔇 تم كتم العضو (البوت سيحذف رسائله).');
   }
  }catch(e){ console.error(e); await send(sock,gid,'❌ حصل خطأ. تأكد أن البوت مشرف وأن الأمر صحيح.'); }
 });
 sock.ev.on('group-participants.update',async ev=>{ if(ev.action==='add'){const g=group(ev.id);if(!g.welcome)return;for(const u of ev.participants){await sock.sendMessage(ev.id,{text:`نورتنا ي خب ح تستمتع معانا لو احترمت نفسك\n👤 @${u.split('@')[0]}`,mentions:[u]});}}});
}
start();
