const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const cron = require('node-cron');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const qrcode = require('qrcode');
const XLSX = require('xlsx');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadContentFromMessage,
} = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(__dirname));

const DATA_DIR = process.env.DATA_DIR || __dirname;
['uploads','sessions','exports'].forEach(d=>{
  const p=path.join(DATA_DIR,d);
  if(!fs.existsSync(p))fs.mkdirSync(p,{recursive:true});
});
app.use('/uploads', express.static(path.join(DATA_DIR,'uploads')));

const cfg = JSON.parse(fs.readFileSync('config.json','utf8'));
const contacts = JSON.parse(fs.readFileSync('contacts.json','utf8'));
const allContacts = [...contacts.agms,...contacts.bms];

// ── Per-user state ─────────────────────────────────────────────────────────────
// users[userId] = { socket, waSocket, waReady, myInfo, picCache, chatHistory, lastActivity }
const users = {};

function getUser(userId) {
  if (!users[userId]) {
    users[userId] = {
      sockets: new Set(),
      waSocket: null,
      waReady: false,
      myInfo: null,
      picCache: {},
      chatHistory: {}, // jid → msgs[]
      lastActivity: Date.now(),
    };
  }
  return users[userId];
}

function emitToUser(userId, event, data) {
  const u = users[userId];
  if (!u) return;
  u.sockets.forEach(s => s.emit(event, data));
}

// ── 3-day idle check per user ─────────────────────────────────────────────────
cron.schedule('0 * * * *', async () => {
  for (const [uid, u] of Object.entries(users)) {
    if (!u.waReady) continue;
    if (Date.now() - u.lastActivity > 3*24*60*60*1000) {
      console.log(`[${uid}] 3-day idle logout`);
      try { await u.waSocket.logout(); } catch(e){}
      u.waReady = false; u.waSocket = null;
      emitToUser(uid,'wa:disconnected','idle_3days');
    }
  }
});

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.diskStorage({
  destination: path.join(DATA_DIR,'uploads'),
  filename:(req,file,cb)=>cb(null,Date.now()+path.extname(file.originalname))
})});
app.post('/upload', upload.single('file'), (req,res)=>{
  if(!req.file)return res.status(400).json({error:'no file'});
  res.json({path:'uploads/'+req.file.filename,name:req.file.originalname,mime:req.file.mimetype});
});

// ── Export ────────────────────────────────────────────────────────────────────
app.get('/export', (req,res)=>{
  const {userId,jid,from,to,limit=500}=req.query;
  const u=users[userId];
  if(!u)return res.status(404).json({error:'user not found'});
  let msgs=u.chatHistory[jid]||[];
  if(from)msgs=msgs.filter(m=>m.timestamp>=parseInt(from));
  if(to)msgs=msgs.filter(m=>m.timestamp<=parseInt(to));
  msgs=msgs.slice(-parseInt(limit));
  const rows=msgs.map(m=>({
    Time:new Date(m.timestamp*1000).toLocaleString(),
    From:m.fromMe?'Me':m.name,
    Message:m.body||(m.media?'[Media]':''),
    Type:m.media?m.media.mimetype?.split('/')[0]||'media':'text',
    Status:m.ack===3?'Read':m.ack===2?'Delivered':m.ack===1?'Sent':'Unknown'
  }));
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'Chat');
  const fname=path.join(DATA_DIR,`exports/chat_${Date.now()}.xlsx`);
  XLSX.writeFile(wb,fname);
  res.download(fname);
});

// ── Baileys per user ──────────────────────────────────────────────────────────
async function startWA(userId) {
  const u = getUser(userId);
  const sessDir = path.join(DATA_DIR,'sessions',userId,'baileys');
  fs.mkdirSync(sessDir,{recursive:true});

  const {state,saveCreds} = await useMultiFileAuthState(sessDir);
  const {version} = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth:{creds:state.creds,keys:makeCacheableSignalKeyStore(state.keys,pino({level:'silent'}))},
    printQRInTerminal:false,
    logger:pino({level:'silent'}),
    browser:['Sathya Messenger','Chrome','120.0'],
    syncFullHistory:false,
    markOnlineOnConnect:true,
    generateHighQualityLinkPreview:false,
    getMessage:async()=>({conversation:''}),
  });

  u.waSocket = sock;
  sock.ev.on('creds.update',saveCreds);

  sock.ev.on('connection.update',async({connection,lastDisconnect,qr})=>{
    if(qr){
      const url=await qrcode.toDataURL(qr,{width:260,margin:2,color:{dark:'#111827',light:'#fff'}});
      emitToUser(userId,'wa:qr',url);
    }
    if(connection==='open'){
      u.waReady=true; u.lastActivity=Date.now();
      u.myInfo=sock.user;
      try{u.picCache['me']=await sock.profilePictureUrl(sock.user.id,'image');}catch(e){}
      emitToUser(userId,'wa:ready',{name:sock.user.name||sock.user.id.split(':')[0],pic:u.picCache['me']||null});
      loadAllPics(userId);
    }
    if(connection==='close'){
      u.waReady=false;
      const code=lastDisconnect?.error?.output?.statusCode;
      const loggedOut=code===DisconnectReason.loggedOut;
      emitToUser(userId,'wa:disconnected',loggedOut?'logout':'reconnecting');
      if(!loggedOut){setTimeout(()=>startWA(userId),3000);}
      else{u.waSocket=null;fs.rmSync(sessDir,{recursive:true,force:true});setTimeout(()=>startWA(userId),1000);}
    }
  });

  sock.ev.on('messages.upsert',async({messages,type})=>{
    if(type!=='notify')return;
    for(const msg of messages){
      if(!msg.message)continue;
      u.lastActivity=Date.now();
      const jid=msg.key.remoteJid;
      const fromMe=msg.key.fromMe;
      const msgType=Object.keys(msg.message)[0];
      const content=msg.message[msgType];
      let body='',media=null;
      if(msgType==='conversation'||msgType==='extendedTextMessage'){
        body=content?.text||content||'';
      } else if(['imageMessage','videoMessage','audioMessage','documentMessage'].includes(msgType)){
        body=content.caption||'';
        try{
          const stream=await downloadContentFromMessage(content,msgType.replace('Message',''));
          const chunks=[];for await(const c of stream)chunks.push(c);
          media={data:Buffer.concat(chunks).toString('base64'),mimetype:content.mimetype,filename:content.fileName||msgType};
        }catch(e){media={mimetype:content.mimetype,filename:content.fileName||msgType,failed:true};}
      }
      const out={id:msg.key.id,jid,fromMe,body,timestamp:msg.messageTimestamp,name:fromMe?(u.myInfo?.name||'Me'):msg.pushName||'',media,ack:fromMe?1:0};
      if(!u.chatHistory[jid])u.chatHistory[jid]=[];
      u.chatHistory[jid].push(out);
      if(u.chatHistory[jid].length>500)u.chatHistory[jid].shift();
      emitToUser(userId,'wa:msg',out);
      if(!fromMe)emitToUser(userId,'wa:toast',{name:out.name,body:body.substring(0,60)});
      // cache pic
      if(!u.picCache[jid]&&!fromMe){
        try{u.picCache[jid]=await sock.profilePictureUrl(jid,'image');}catch(e){}
        const phone='+'+jid.replace('@s.whatsapp.net','');
        const c=allContacts.find(x=>x.phone===phone);
        if(c&&u.picCache[jid])emitToUser(userId,'wa:pic',{id:c.id,url:u.picCache[jid]});
      }
    }
  });

  sock.ev.on('messages.update',updates=>{
    for(const upd of updates){
      if(upd.update?.status!==undefined){
        emitToUser(userId,'wa:ack',{id:upd.key.id,ack:upd.update.status});
        const jid=upd.key.remoteJid;
        if(u.chatHistory[jid]){const m=u.chatHistory[jid].find(x=>x.id===upd.key.id);if(m)m.ack=upd.update.status;}
      }
    }
  });
}

async function loadAllPics(userId){
  const u=getUser(userId);const sock=u.waSocket;if(!sock)return;
  const BATCH=8;
  for(let i=0;i<allContacts.length;i+=BATCH){
    await Promise.all(allContacts.slice(i,i+BATCH).map(async c=>{
      const jid=c.phone.replace('+','')+'@s.whatsapp.net';
      if(u.picCache[jid]){emitToUser(userId,'wa:pic',{id:c.id,url:u.picCache[jid]});return;}
      try{const url=await sock.profilePictureUrl(jid,'image');if(url){u.picCache[jid]=url;emitToUser(userId,'wa:pic',{id:c.id,url});}}catch(e){}
    }));
  }
}

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  let userId = null;

  socket.on('init', async (uid) => {
    userId = uid;
    const u = getUser(userId);
    u.sockets.add(socket);
    socket.emit('contacts', contacts);

    // send cached pics
    Object.entries(u.picCache).forEach(([jid,url])=>{
      const phone='+'+jid.replace('@s.whatsapp.net','');
      const c=allContacts.find(x=>x.phone===phone);
      if(c)socket.emit('wa:pic',{id:c.id,url});
    });

    if(u.waReady){
      socket.emit('wa:ready',{name:u.myInfo?.name||'',pic:u.picCache['me']||null});
    } else {
      startWA(userId);
    }
  });

  socket.on('wa:send',async({to,message,mediaPath,mime})=>{
    if(!userId)return;
    const u=getUser(userId);if(!u.waReady)return socket.emit('err','Not connected');
    u.lastActivity=Date.now();
    const jid=to.replace('+','')+'@s.whatsapp.net';
    try{
      let sent;
      if(mediaPath){
        const buf=fs.readFileSync(path.join(DATA_DIR,mediaPath));
        const mt=mime||'application/octet-stream';
        if(mt.startsWith('image/'))sent=await u.waSocket.sendMessage(jid,{image:buf,caption:message||''});
        else if(mt.startsWith('video/'))sent=await u.waSocket.sendMessage(jid,{video:buf,caption:message||''});
        else if(mt.startsWith('audio/'))sent=await u.waSocket.sendMessage(jid,{audio:buf,mimetype:mt});
        else sent=await u.waSocket.sendMessage(jid,{document:buf,mimetype:mt,fileName:path.basename(mediaPath),caption:message||''});
      } else {
        sent=await u.waSocket.sendMessage(jid,{text:message});
      }
      const out={id:sent?.key?.id,jid,fromMe:true,body:message||'',timestamp:Math.floor(Date.now()/1000),name:'Me',media:null,ack:1};
      if(!u.chatHistory[jid])u.chatHistory[jid]=[];
      u.chatHistory[jid].push(out);
      socket.emit('wa:sent',{to,success:true,id:sent?.key?.id});
    }catch(e){socket.emit('wa:sent',{to,success:false,error:e.message});}
  });

  socket.on('wa:bulk',async({recipients,message,mediaPath,mime,delay})=>{
    if(!userId)return;
    const u=getUser(userId);if(!u.waReady)return socket.emit('err','Not connected');
    for(const phone of recipients){
      u.lastActivity=Date.now();
      const jid=phone.replace('+','')+'@s.whatsapp.net';
      try{
        if(mediaPath){
          const buf=fs.readFileSync(path.join(DATA_DIR,mediaPath));
          const mt=mime||'application/octet-stream';
          if(mt.startsWith('image/'))await u.waSocket.sendMessage(jid,{image:buf,caption:message||''});
          else if(mt.startsWith('video/'))await u.waSocket.sendMessage(jid,{video:buf,caption:message||''});
          else await u.waSocket.sendMessage(jid,{document:buf,mimetype:mt,fileName:path.basename(mediaPath)});
        } else {
          await u.waSocket.sendMessage(jid,{text:message});
        }
        socket.emit('wa:bulk_prog',{phone,success:true});
      }catch(e){socket.emit('wa:bulk_prog',{phone,success:false,error:e.message});}
      await new Promise(r=>setTimeout(r,delay||cfg.wa_message_delay_ms));
    }
    socket.emit('wa:bulk_done');
  });

  socket.on('wa:schedule',({recipients,message,datetime,mediaPath,mime})=>{
    if(!userId)return;
    const u=getUser(userId);
    const d=new Date(datetime);
    const expr=`${d.getSeconds()} ${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth()+1} *`;
    cron.schedule(expr,async()=>{
      for(const phone of recipients){
        const jid=phone.replace('+','')+'@s.whatsapp.net';
        try{
          if(mediaPath){const buf=fs.readFileSync(path.join(DATA_DIR,mediaPath));const mt=mime||'application/octet-stream';if(mt.startsWith('image/'))await u.waSocket.sendMessage(jid,{image:buf,caption:message||''});else await u.waSocket.sendMessage(jid,{document:buf,mimetype:mt,fileName:path.basename(mediaPath)});}
          else await u.waSocket.sendMessage(jid,{text:message});
          emitToUser(userId,'wa:sched_sent',{phone});
        }catch(e){}
      }
    },{scheduled:true,runOnce:true});
    socket.emit('wa:scheduled',{datetime,count:recipients.length});
  });

  socket.on('wa:logout',async()=>{
    if(!userId)return;
    const u=getUser(userId);
    try{await u.waSocket.logout();}catch(e){}
    u.waReady=false;u.waSocket=null;
    const sessDir=path.join(DATA_DIR,'sessions',userId,'baileys');
    fs.rmSync(sessDir,{recursive:true,force:true});
    emitToUser(userId,'wa:disconnected','manual');
    setTimeout(()=>startWA(userId),1000);
  });

  socket.on('sms:send',async({to,message})=>{
    try{
      await axios.post(`${cfg.sms_gateway_url}/message`,{phoneNumber:to,message},{auth:{username:cfg.sms_gateway_user,password:cfg.sms_gateway_pass},timeout:10000});
      socket.emit('sms:sent',{to,success:true});
    }catch(e){socket.emit('sms:sent',{to,success:false,error:e.message});}
  });

  socket.on('sms:bulk',async({recipients,message,delay})=>{
    for(const phone of recipients){
      try{
        await axios.post(`${cfg.sms_gateway_url}/message`,{phoneNumber:phone,message},{auth:{username:cfg.sms_gateway_user,password:cfg.sms_gateway_pass},timeout:10000});
        socket.emit('sms:bulk_prog',{phone,success:true});
      }catch(e){socket.emit('sms:bulk_prog',{phone,success:false,error:e.message});}
      await new Promise(r=>setTimeout(r,delay||cfg.sms_message_delay_ms));
    }
    socket.emit('sms:bulk_done');
  });

  socket.on('sms:schedule',({recipients,message,datetime})=>{
    const d=new Date(datetime);
    const expr=`${d.getSeconds()} ${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth()+1} *`;
    cron.schedule(expr,async()=>{
      for(const phone of recipients){
        try{await axios.post(`${cfg.sms_gateway_url}/message`,{phoneNumber:phone,message},{auth:{username:cfg.sms_gateway_user,password:cfg.sms_gateway_pass}});emitToUser(userId,'sms:sched_sent',{phone});}catch(e){}
      }
    },{scheduled:true,runOnce:true});
    socket.emit('sms:scheduled',{datetime,count:recipients.length});
  });

  socket.on('disconnect',()=>{
    if(userId&&users[userId]){
      users[userId].sockets.delete(socket);
    }
  });
});

// ── Keep-alive ────────────────────────────────────────────────────────────────
const APP_URL=cfg.fly_app_url||cfg.hf_space_url;
if(APP_URL)setInterval(()=>{
  require('https').get(APP_URL,r=>console.log(`[ping] ${r.statusCode}`)).on('error',e=>console.log('[ping fail]',e.message));
},25*60*1000);

const PORT=cfg.server_port||8080;
server.listen(PORT,()=>console.log(`\n✅ Sathya Messenger → http://localhost:${PORT}\n`));
