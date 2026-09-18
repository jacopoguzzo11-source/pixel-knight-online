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
const PLAYER_RADIUS = 0.56;
const PLAYER_MIN_DISTANCE = 1.18;
const TICK = 1000 / 30;

const MAPS = {
  keep: {
    id: "keep",
    name: "Fortezza di Pietra",
    arena: 16,
    spawns: [
      { x: -9, z: 0, yaw: -Math.PI / 2 },
      { x: 9, z: 0, yaw: Math.PI / 2 }
    ],
    obstacles: [{ x: 0, z: 0, r: 1.65 }]
  },
  forest: {
    id: "forest",
    name: "Rovine della Foresta",
    arena: 18,
    spawns: [
      { x: -11, z: -2, yaw: -Math.PI / 2 },
      { x: 11, z: 2, yaw: Math.PI / 2 }
    ],
    obstacles: [
      { x: -5.5, z: -4.0, r: 0.95 },
      { x: 5.0, z: 4.5, r: 0.95 },
      { x: -4.0, z: 6.2, r: 0.85 },
      { x: 6.0, z: -5.5, r: 0.85 }
    ]
  },
  colosseum: {
    id: "colosseum",
    name: "Colosseo delle Ceneri",
    arena: 17,
    spawns: [
      { x: 0, z: 10.5, yaw: 0 },
      { x: 0, z: -10.5, yaw: Math.PI }
    ],
    obstacles: [
      { x: -6.2, z: -6.2, r: 0.8 },
      { x: 6.2, z: -6.2, r: 0.8 },
      { x: -6.2, z: 6.2, r: 0.8 },
      { x: 6.2, z: 6.2, r: 0.8 }
    ]
  }
};

const WEAPONS = {
  sword: { name: "Spada", type: "melee", damage: 28, reach: 3.35, width: 0.95, cooldown: 500, stamina: 17 },
  spear: { name: "Lancia", type: "melee", damage: 24, reach: 4.65, width: 0.72, cooldown: 650, stamina: 20 },
  axe: { name: "Ascia da guerra", type: "melee", damage: 40, reach: 2.85, width: 1.02, cooldown: 820, stamina: 27 },
  bow: { name: "Arco", type: "bow", damage: 22, cooldown: 800, stamina: 12 }
};

const PRICES = { bow: 75, arrows: 20, spear: 65, axe: 85, shield: 120 };

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function getRoom(socket) { return socket.data.room ? rooms.get(socket.data.room) : null; }
function sanitizeName(s) {
  return String(s || "Cavaliere").replace(/[<>]/g, "").slice(0, 18) || "Cavaliere";
}
function mapOf(room) { return MAPS[room.map] || MAPS.keep; }
function forwardFromYaw(yaw) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}
function spawnForIndex(room, i) {
  return mapOf(room).spawns[i] || mapOf(room).spawns[0];
}
function playerPublic(p) {
  return {
    id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
    hp: p.hp, stamina: p.stamina, weapon: p.weapon, blocking: p.blocking,
    ammo: p.ammo, coins: p.coins, score: p.score, ready: p.ready,
    owned: p.owned, shieldOwned: p.shieldOwned, shieldEquipped: p.shieldEquipped
  };
}
function roomPublic(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    map: room.map,
    mapName: mapOf(room).name,
    phase: room.phase,
    countdown: room.countdown,
    players: [...room.players.values()].map(playerPublic),
    arrows: [...room.arrows.values()].map(a => ({
      id: a.id, x: a.x, y: a.y, z: a.z, yaw: a.yaw, pitch: a.pitch, owner: a.owner
    })),
    message: room.message || ""
  };
}
function emitRoom(room) { io.to(room.code).emit("state", roomPublic(room)); }

function resolveMapCollision(room, x, z) {
  const m = mapOf(room);
  const limit = m.arena - PLAYER_RADIUS;
  x = clamp(x, -limit, limit);
  z = clamp(z, -limit, limit);
  for (const o of m.obstacles) {
    let dx = x - o.x, dz = z - o.z;
    let d = Math.hypot(dx, dz);
    const min = o.r + PLAYER_RADIUS;
    if (d < min) {
      if (d < 0.001) { dx = 1; dz = 0; d = 1; }
      x = o.x + dx / d * min;
      z = o.z + dz / d * min;
    }
  }
  return { x, z };
}
function resolvePlayerCollision(room, self, x, z) {
  const other = [...room.players.values()].find(p => p.id !== self.id);
  if (!other) return { x, z };
  let dx = x - other.x, dz = z - other.z;
  let d = Math.hypot(dx, dz);
  if (d < PLAYER_MIN_DISTANCE) {
    if (d < 0.001) {
      dx = self.x - other.x;
      dz = self.z - other.z;
      d = Math.hypot(dx, dz);
      if (d < 0.001) { dx = 1; dz = 0; d = 1; }
    }
    x = other.x + dx / d * PLAYER_MIN_DISTANCE;
    z = other.z + dz / d * PLAYER_MIN_DISTANCE;
  }
  return resolveMapCollision(room, x, z);
}
function resetRound(room) {
  room.phase = "active";
  room.message = "";
  room.arrows.clear();
  const ps = [...room.players.values()];
  ps.forEach((p, i) => {
    const s = spawnForIndex(room, i);
    p.x = s.x; p.y = 0; p.z = s.z; p.yaw = s.yaw; p.pitch = 0;
    p.hp = 100; p.stamina = 100; p.blocking = false;
    p.attackAt = 0; p.lastMoveAt = Date.now();
    if (p.weapon === "bow" && p.ammo < 6) p.ammo = 6;
  });
  io.to(room.code).emit("roundStart", {
    map: room.map,
    scores: ps.map(p => ({ id: p.id, score: p.score }))
  });
  emitRoom(room);
}
function beginCountdown(room) {
  if (room.phase !== "lobby") return;
  room.phase = "countdown";
  room.countdown = 3;
  emitRoom(room);
  const iv = setInterval(() => {
    if (!rooms.has(room.code)) { clearInterval(iv); return; }
    if (room.players.size < 2) {
      clearInterval(iv);
      room.phase = "lobby"; room.countdown = 0;
      emitRoom(room); return;
    }
    room.countdown--;
    if (room.countdown <= 0) {
      clearInterval(iv);
      resetRound(room);
    } else emitRoom(room);
  }, 1000);
}
function endRound(room, loser, winner) {
  if (room.phase !== "active") return;
  room.phase = "roundEnd";
  winner.score++;
  room.message = `${winner.name} vince il round`;
  io.to(room.code).emit("roundEnd", { winner: winner.id, loser: loser.id, score: winner.score });
  emitRoom(room);
  if (winner.score >= 3) {
    room.phase = "matchEnd";
    room.message = `${winner.name} vince il duello`;
    io.to(room.code).emit("matchEnd", { winner: winner.id });
    setTimeout(() => {
      if (!rooms.has(room.code)) return;
      room.players.forEach(p => {
        p.score = 0; p.ready = false; p.hp = 100; p.stamina = 100; p.blocking = false;
      });
      room.phase = "lobby"; room.message = "";
      emitRoom(room);
    }, 6000);
  } else {
    setTimeout(() => {
      if (rooms.has(room.code) && room.players.size === 2) resetRound(room);
    }, 3500);
  }
}
function targetOf(room, attacker) {
  return [...room.players.values()].find(p => p.id !== attacker.id);
}
function targetFacesAttacker(target, attacker) {
  const f = forwardFromYaw(target.yaw);
  const dx = attacker.x - target.x, dz = attacker.z - target.z;
  const d = Math.hypot(dx, dz) || 1;
  return (f.x * dx / d + f.z * dz / d) > 0.48;
}
function meleeCanHit(attacker, target, weapon) {
  const f = forwardFromYaw(attacker.yaw);
  const dx = target.x - attacker.x, dz = target.z - attacker.z;
  const along = dx * f.x + dz * f.z;
  const side = Math.abs(dx * f.z - dz * f.x);
  return along > -0.15 &&
         along <= weapon.reach &&
         side <= weapon.width + PLAYER_RADIUS;
}
function applyDamage(room, attacker, target, damage, source) {
  if (room.phase !== "active" || target.hp <= 0) return;
  let dealt = damage;
  let blocked = false;
  if (target.blocking &&
      target.shieldOwned &&
      target.shieldEquipped &&
      target.weapon !== "bow" &&
      target.stamina > 0 &&
      targetFacesAttacker(target, attacker)) {
    blocked = true;
    dealt = Math.max(2, Math.round(damage * 0.15));
    target.stamina = Math.max(0, target.stamina - 25);
  }
  target.hp = Math.max(0, target.hp - dealt);
  io.to(room.code).emit("combatEvent", {
    type: blocked ? "block" : "hit",
    attacker: attacker.id,
    target: target.id,
    damage: dealt,
    rawDamage: damage,
    source,
    x: target.x,
    z: target.z
  });
  if (target.hp <= 0) endRound(room, target, attacker);
}
function createPlayer(socket, name, room, index) {
  const s = spawnForIndex(room, index);
  return {
    id: socket.id,
    name: sanitizeName(name),
    x: s.x, y: 0, z: s.z, yaw: s.yaw, pitch: 0,
    hp: 100, stamina: 100,
    weapon: "sword",
    owned: { sword: true, spear: false, axe: false, bow: false },
    shieldOwned: false,
    shieldEquipped: false,
    blocking: false,
    ammo: 0,
    coins: 220,
    score: 0,
    ready: false,
    attackAt: 0,
    lastMoveAt: Date.now()
  };
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name } = {}) => {
    let c = roomCode();
    while (rooms.has(c)) c = roomCode();
    const room = {
      code: c,
      hostId: socket.id,
      map: "keep",
      players: new Map(),
      arrows: new Map(),
      phase: "lobby",
      countdown: 0,
      message: "",
      arrowSeq: 1
    };
    rooms.set(c, room);
    const p = createPlayer(socket, name, room, 0);
    room.players.set(socket.id, p);
    socket.join(c); socket.data.room = c;
    socket.emit("joined", { code: c, id: socket.id });
    emitRoom(room);
  });

  socket.on("joinRoom", ({ code: raw, name } = {}) => {
    const c = String(raw || "").trim().toUpperCase();
    const room = rooms.get(c);
    if (!room) return socket.emit("joinError", "Stanza inesistente.");
    if (room.players.size >= 2) return socket.emit("joinError", "La stanza è piena.");
    if (room.phase !== "lobby") return socket.emit("joinError", "Il duello è già iniziato.");
    const p = createPlayer(socket, name, room, 1);
    room.players.set(socket.id, p);
    socket.join(c); socket.data.room = c;
    socket.emit("joined", { code: c, id: socket.id });
    emitRoom(room);
  });

  socket.on("setMap", mapId => {
    const room = getRoom(socket);
    if (!room || room.phase !== "lobby" || room.hostId !== socket.id || !MAPS[mapId]) return;
    room.map = mapId;
    room.players.forEach(p => { p.ready = false; });
    const ps = [...room.players.values()];
    ps.forEach((p, i) => {
      const s = spawnForIndex(room, i);
      p.x = s.x; p.y = 0; p.z = s.z; p.yaw = s.yaw; p.pitch = 0;
    });
    emitRoom(room);
  });

  socket.on("ready", () => {
    const room = getRoom(socket);
    if (!room || room.phase !== "lobby") return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !p.ready;
    emitRoom(room);
    if (room.players.size === 2 && [...room.players.values()].every(x => x.ready)) beginCountdown(room);
  });

  socket.on("purchase", item => {
    const room = getRoom(socket);
    if (!room || room.phase !== "lobby") return;
    const p = room.players.get(socket.id);
    if (!p) return;

    if (item === "arrows") {
      if (!p.owned.bow || p.coins < PRICES.arrows) return;
      p.coins -= PRICES.arrows;
      p.ammo += 12;
      emitRoom(room);
      return;
    }
    if (item === "shield") {
      if (p.shieldOwned || p.coins < PRICES.shield) return;
      p.coins -= PRICES.shield;
      p.shieldOwned = true;
      p.shieldEquipped = p.weapon !== "bow";
      emitRoom(room);
      return;
    }
    if (!WEAPONS[item] || item === "sword" || p.owned[item]) return;
    if (p.coins < PRICES[item]) return;

    p.coins -= PRICES[item];
    p.owned[item] = true;
    p.weapon = item;
    if (item === "bow") {
      p.ammo += 8;
      p.shieldEquipped = false;
    }
    emitRoom(room);
  });

  socket.on("selectWeapon", w => {
    const room = getRoom(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !WEAPONS[w] || !p.owned[w]) return;
    p.weapon = w;
    if (w === "bow") p.shieldEquipped = false;
    emitRoom(room);
  });

  socket.on("toggleShield", () => {
    const room = getRoom(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !p.shieldOwned || p.weapon === "bow") return;
    p.shieldEquipped = !p.shieldEquipped;
    if (!p.shieldEquipped) p.blocking = false;
    emitRoom(room);
  });

  socket.on("pose", data => {
    const room = getRoom(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;

    const now = Date.now();
    const dt = Math.max(0.016, Math.min(0.25, (now - p.lastMoveAt) / 1000));
    p.lastMoveAt = now;

    let nx = Number(data?.x), nz = Number(data?.z);
    if (!Number.isFinite(nx) || !Number.isFinite(nz)) return;

    const d = Math.hypot(nx - p.x, nz - p.z);
    const max = 8.2 * dt + 0.42;
    if (d > max && d > 0) {
      nx = p.x + (nx - p.x) / d * max;
      nz = p.z + (nz - p.z) / d * max;
    }

    let resolved = resolveMapCollision(room, nx, nz);
    resolved = resolvePlayerCollision(room, p, resolved.x, resolved.z);
    p.x = resolved.x;
    p.z = resolved.z;
    const ny = Number(data?.y);
    if (Number.isFinite(ny)) p.y = clamp(ny, 0, 2.35);
    p.yaw = Number.isFinite(data.yaw) ? data.yaw : p.yaw;
    p.pitch = clamp(Number.isFinite(data.pitch) ? data.pitch : p.pitch, -1.2, 1.2);

    const canBlock = p.shieldOwned && p.shieldEquipped && p.weapon !== "bow";
    p.blocking = !!data.blocking && canBlock && p.stamina > 0 && room.phase === "active";
  });

  socket.on("attack", () => {
    const room = getRoom(socket);
    if (!room || room.phase !== "active") return;
    const p = room.players.get(socket.id);
    if (!p || p.hp <= 0 || p.blocking) return;

    const w = WEAPONS[p.weapon] || WEAPONS.sword;
    const now = Date.now();
    if (now - p.attackAt < w.cooldown || p.stamina < w.stamina) return;
    p.attackAt = now;
    p.stamina -= w.stamina;

    const target = targetOf(room, p);

    if (w.type === "bow") {
      if (p.ammo <= 0) {
        socket.emit("noAmmo");
        emitRoom(room);
        return;
      }
      p.ammo--;
      const id = String(room.arrowSeq++);
      const cp = Math.cos(p.pitch);
      room.arrows.set(id, {
        id,
        owner: p.id,
        x: p.x,
        y: 1.55,
        z: p.z,
        dx: -Math.sin(p.yaw) * cp,
        dy: Math.sin(p.pitch),
        dz: -Math.cos(p.yaw) * cp,
        yaw: p.yaw,
        pitch: p.pitch,
        life: 2.25
      });
      io.to(room.code).emit("combatEvent", { type: "shot", attacker: p.id, source: "bow" });
    } else {
      io.to(room.code).emit("combatEvent", { type: "swing", attacker: p.id, source: p.weapon });
      if (target && meleeCanHit(p, target, w)) {
        applyDamage(room, p, target, w.damage, p.weapon);
      }
    }
    emitRoom(room);
  });

  socket.on("disconnect", () => {
    const room = getRoom(socket);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === socket.id) room.hostId = [...room.players.keys()][0];
    room.phase = "lobby";
    room.message = "L'avversario si è disconnesso.";
    room.players.forEach(p => {
      p.ready = false; p.score = 0; p.hp = 100; p.stamina = 100; p.blocking = false;
    });
    io.to(room.code).emit("opponentLeft");
    emitRoom(room);
  });
});

setInterval(() => {
  const dt = TICK / 1000;
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (room.phase === "active") {
        if (p.blocking) {
          p.stamina = Math.max(0, p.stamina - 12 * dt);
          if (p.stamina <= 0) p.blocking = false;
        } else {
          p.stamina = Math.min(100, p.stamina + 18 * dt);
        }
      } else {
        p.stamina = Math.min(100, p.stamina + 28 * dt);
      }
    }

    if (room.phase === "active") {
      for (const [id, a] of room.arrows) {
        a.x += a.dx * 19 * dt;
        a.z += a.dz * 19 * dt;
        a.y += a.dy * 19 * dt;
        a.dy -= 1.75 * dt;
        a.life -= dt;

        const owner = room.players.get(a.owner);
        const target = [...room.players.values()].find(p => p.id !== a.owner);
        if (owner && target && target.hp > 0) {
          const dh = Math.hypot(a.x - target.x, a.z - target.z);
          if (dh < PLAYER_RADIUS + 0.2 && Math.abs(a.y - ((target.y || 0) + 1.15)) < 1.2) {
            applyDamage(room, owner, target, WEAPONS.bow.damage, "bow");
            room.arrows.delete(id);
            continue;
          }
        }
        if (a.life <= 0 || a.y < 0) room.arrows.delete(id);
      }
    }
    emitRoom(room);
  }
}, TICK);

server.listen(PORT, () => console.log(`Pixel Knight Online v2: http://localhost:${PORT}`));
