const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"]
});
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const PLAYER_RADIUS = 0.55;
const ARENA = 16;
const TICK = 1000 / 30;

function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function angleDiff(a,b){
  let d = (a-b + Math.PI*3) % (Math.PI*2) - Math.PI;
  return d;
}
function getRoom(socket){
  return socket.data.room ? rooms.get(socket.data.room) : null;
}
function sanitizeName(s){
  return String(s || "Cavaliere").replace(/[<>]/g,"").slice(0,18) || "Cavaliere";
}
function playerPublic(p){
  return {
    id:p.id,name:p.name,x:p.x,z:p.z,yaw:p.yaw,pitch:p.pitch,
    hp:p.hp,stamina:p.stamina,weapon:p.weapon,blocking:p.blocking,
    ammo:p.ammo,coins:p.coins,score:p.score,ready:p.ready
  };
}
function roomPublic(room){
  return {
    code:room.code,
    phase:room.phase,
    countdown:room.countdown,
    players:[...room.players.values()].map(playerPublic),
    arrows:[...room.arrows.values()].map(a=>({id:a.id,x:a.x,y:a.y,z:a.z,yaw:a.yaw,pitch:a.pitch,owner:a.owner})),
    message:room.message || ""
  };
}
function emitRoom(room){
  io.to(room.code).emit("state", roomPublic(room));
}
function spawnForIndex(i){
  return i===0 ? {x:-9,z:0,yaw:Math.PI/2} : {x:9,z:0,yaw:-Math.PI/2};
}
function resetRound(room){
  room.phase = "active";
  room.message = "";
  room.arrows.clear();
  const ps=[...room.players.values()];
  ps.forEach((p,i)=>{
    const s=spawnForIndex(i);
    p.x=s.x;p.z=s.z;p.yaw=s.yaw;p.pitch=0;
    p.hp=100;p.stamina=100;p.blocking=false;
    p.attackAt=0;p.lastMoveAt=Date.now();
    p.ammo = Math.max(p.ammo, p.weapon==="bow" ? 6 : p.ammo);
  });
  io.to(room.code).emit("roundStart", { scores:ps.map(p=>({id:p.id,score:p.score})) });
  emitRoom(room);
}
function beginCountdown(room){
  if(room.phase!=="lobby") return;
  room.phase="countdown";
  room.countdown=3;
  emitRoom(room);
  const iv=setInterval(()=>{
    if(!rooms.has(room.code)){ clearInterval(iv); return; }
    if(room.players.size<2){ clearInterval(iv); room.phase="lobby"; room.countdown=0; emitRoom(room); return; }
    room.countdown--;
    if(room.countdown<=0){
      clearInterval(iv);
      resetRound(room);
    } else emitRoom(room);
  },1000);
}
function endRound(room, loser, winner){
  if(room.phase!=="active") return;
  room.phase="roundEnd";
  winner.score++;
  room.message=`${winner.name} vince il round`;
  io.to(room.code).emit("roundEnd",{winner:winner.id,loser:loser.id,score:winner.score});
  emitRoom(room);
  if(winner.score>=3){
    room.phase="matchEnd";
    room.message=`${winner.name} vince il duello`;
    io.to(room.code).emit("matchEnd",{winner:winner.id});
    setTimeout(()=>{
      if(!rooms.has(room.code)) return;
      room.players.forEach(p=>{p.score=0;p.ready=false;p.hp=100;p.stamina=100;p.blocking=false});
      room.phase="lobby";room.message="";emitRoom(room);
    },6000);
  } else {
    setTimeout(()=>{ if(rooms.has(room.code) && room.players.size===2) resetRound(room); },3500);
  }
}
function targetOf(room, attacker){
  return [...room.players.values()].find(p=>p.id!==attacker.id);
}
function facingBlock(target, attacker){
  const toward = Math.atan2(attacker.x-target.x, -(attacker.z-target.z));
  return Math.abs(angleDiff(toward,target.yaw)) < 1.05;
}
function applyDamage(room, attacker, target, damage){
  if(room.phase!=="active" || target.hp<=0) return;
  let dealt=damage;
  if(target.blocking && target.stamina>0 && facingBlock(target,attacker)){
    dealt=Math.max(2, Math.round(damage*0.16));
    target.stamina=Math.max(0,target.stamina-22);
    io.to(room.code).emit("combatEvent",{type:"block",x:target.x,z:target.z,target:target.id});
  } else {
    io.to(room.code).emit("combatEvent",{type:"hit",x:target.x,z:target.z,target:target.id});
  }
  target.hp=Math.max(0,target.hp-dealt);
  if(target.hp<=0) endRound(room,target,attacker);
}
function createPlayer(socket,name,index){
  const s=spawnForIndex(index);
  return {
    id:socket.id,name:sanitizeName(name),x:s.x,z:s.z,yaw:s.yaw,pitch:0,
    hp:100,stamina:100,weapon:"sword",blocking:false,ammo:0,coins:120,
    score:0,ready:false,attackAt:0,lastMoveAt:Date.now()
  };
}

io.on("connection", socket=>{
  socket.on("createRoom", ({name}={})=>{
    let c=code(); while(rooms.has(c)) c=code();
    const room={code:c,players:new Map(),arrows:new Map(),phase:"lobby",countdown:0,message:"",arrowSeq:1};
    rooms.set(c,room);
    const p=createPlayer(socket,name,0); room.players.set(socket.id,p);
    socket.join(c);socket.data.room=c;
    socket.emit("joined",{code:c,id:socket.id});
    emitRoom(room);
  });

  socket.on("joinRoom", ({code:raw,name}={})=>{
    const c=String(raw||"").trim().toUpperCase();
    const room=rooms.get(c);
    if(!room) return socket.emit("joinError","Stanza inesistente.");
    if(room.players.size>=2) return socket.emit("joinError","La stanza è piena.");
    if(room.phase!=="lobby") return socket.emit("joinError","Il duello è già iniziato.");
    const p=createPlayer(socket,name,1);room.players.set(socket.id,p);
    socket.join(c);socket.data.room=c;
    socket.emit("joined",{code:c,id:socket.id});
    emitRoom(room);
  });

  socket.on("ready", ()=>{
    const room=getRoom(socket);if(!room||room.phase!=="lobby")return;
    const p=room.players.get(socket.id);if(!p)return;
    p.ready=!p.ready;emitRoom(room);
    if(room.players.size===2 && [...room.players.values()].every(x=>x.ready)) beginCountdown(room);
  });

  socket.on("purchase", item=>{
    const room=getRoom(socket);if(!room||room.phase!=="lobby")return;
    const p=room.players.get(socket.id);if(!p)return;
    if(item==="bow" && p.weapon!=="bow"){
      if(p.coins<70)return;
      p.coins-=70;p.weapon="bow";p.ammo+=8;
    } else if(item==="arrows"){
      if(p.coins<20)return;
      p.coins-=20;p.ammo+=12;
    } else if(item==="sword"){
      p.weapon="sword";
    }
    emitRoom(room);
  });

  socket.on("selectWeapon", w=>{
    const room=getRoom(socket);if(!room)return;
    const p=room.players.get(socket.id);if(!p)return;
    if(w==="sword") p.weapon="sword";
    if(w==="bow" && p.ammo>=0 && (p.weapon==="bow" || p.coins<=50)) p.weapon="bow";
    emitRoom(room);
  });

  socket.on("pose", data=>{
    const room=getRoom(socket);if(!room)return;
    const p=room.players.get(socket.id);if(!p)return;
    const now=Date.now(),dt=Math.max(.016,Math.min(.25,(now-p.lastMoveAt)/1000));
    p.lastMoveAt=now;
    let nx=Number(data?.x),nz=Number(data?.z);
    if(!Number.isFinite(nx)||!Number.isFinite(nz))return;
    nx=clamp(nx,-ARENA,ARENA);nz=clamp(nz,-ARENA,ARENA);
    const d=Math.hypot(nx-p.x,nz-p.z),max=8.0*dt+0.45;
    if(d>max && d>0){ nx=p.x+(nx-p.x)/d*max;nz=p.z+(nz-p.z)/d*max; }
    p.x=nx;p.z=nz;
    p.yaw=Number.isFinite(data.yaw)?data.yaw:p.yaw;
    p.pitch=clamp(Number.isFinite(data.pitch)?data.pitch:p.pitch,-1.2,1.2);
    p.blocking=!!data.blocking && p.stamina>0 && room.phase==="active";
  });

  socket.on("attack", ()=>{
    const room=getRoom(socket);if(!room||room.phase!=="active")return;
    const p=room.players.get(socket.id);if(!p||p.hp<=0||p.blocking)return;
    const now=Date.now();
    const cd=p.weapon==="bow"?720:520;
    const cost=p.weapon==="bow"?14:18;
    if(now-p.attackAt<cd || p.stamina<cost)return;
    p.attackAt=now;p.stamina-=cost;
    const target=targetOf(room,p);
    if(p.weapon==="bow"){
      if(p.ammo<=0){socket.emit("noAmmo");return;}
      p.ammo--;
      const id=String(room.arrowSeq++);
      const cp=Math.cos(p.pitch);
      room.arrows.set(id,{id,owner:p.id,x:p.x,y:1.55,z:p.z,dx:Math.sin(p.yaw)*cp,dy:Math.sin(p.pitch),dz:-Math.cos(p.yaw)*cp,yaw:p.yaw,pitch:p.pitch,life:2.2});
      io.to(room.code).emit("combatEvent",{type:"bow",owner:p.id});
    } else if(target) {
      const d=Math.hypot(target.x-p.x,target.z-p.z);
      const toward=Math.atan2(target.x-p.x,-(target.z-p.z));
      if(d<=2.65 && Math.abs(angleDiff(toward,p.yaw))<0.72){
        applyDamage(room,p,target,27);
      } else {
        io.to(room.code).emit("combatEvent",{type:"swing",owner:p.id});
      }
    }
    emitRoom(room);
  });

  socket.on("disconnect", ()=>{
    const room=getRoom(socket);if(!room)return;
    room.players.delete(socket.id);
    if(room.players.size===0){rooms.delete(room.code);return;}
    room.phase="lobby";room.message="L'avversario si è disconnesso.";
    room.players.forEach(p=>{p.ready=false;p.score=0;p.hp=100;p.stamina=100});
    io.to(room.code).emit("opponentLeft");
    emitRoom(room);
  });
});

setInterval(()=>{
  const dt=TICK/1000;
  for(const room of rooms.values()){
    for(const p of room.players.values()){
      if(room.phase==="active"){
        if(p.blocking){
          p.stamina=Math.max(0,p.stamina-12*dt);
          if(p.stamina<=0)p.blocking=false;
        }else{
          p.stamina=Math.min(100,p.stamina+18*dt);
        }
      } else p.stamina=Math.min(100,p.stamina+28*dt);
    }
    if(room.phase==="active"){
      for(const [id,a] of room.arrows){
        a.x+=a.dx*18*dt;a.z+=a.dz*18*dt;a.y+=a.dy*18*dt;a.dy-=1.8*dt;a.life-=dt;
        const owner=room.players.get(a.owner);
        const target=[...room.players.values()].find(p=>p.id!==a.owner);
        if(owner&&target&&target.hp>0){
          const dh=Math.hypot(a.x-target.x,a.z-target.z);
          if(dh<PLAYER_RADIUS+.18 && Math.abs(a.y-1.15)<1.2){
            applyDamage(room,owner,target,20);
            room.arrows.delete(id);continue;
          }
        }
        if(a.life<=0||a.y<0)room.arrows.delete(id);
      }
    }
    emitRoom(room);
  }
},TICK);

server.listen(PORT,()=>console.log(`Pixel Knight Online: http://localhost:${PORT}`));
