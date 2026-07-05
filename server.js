// ============================================================================
// server.js — سيرفر لعبة المافيا (Node.js + Express + Socket.io)
// اللعبة بالكامل تدار من هنا (authoritative state)، والواجهة (index.html)
// بس تعرض الحالة وترسل أوامر. جاهز للرفع مباشرة على Render.
// ============================================================================

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

// ============================================================================
// أدوات مساعدة عامة
// ============================================================================

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بدون أحرف ملتبسة
function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  } while (rooms[code]);
  return code;
}

function makeToken() {
  return crypto.randomBytes(12).toString('hex');
}

function nowTimeStr() {
  return new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
}

function isMafiaRole(role) {
  return role === 'مافيا';
}
function isMafiaAligned(role) {
  return role === 'مافيا' || role === 'جاسوس';
}
function isSensitiveRole(role) {
  return role === 'شايب' || role === 'دكتور';
}

const COLORS = ['#e23e4a', '#3fa7d6', '#3fd08a', '#f3c14a', '#b18cff', '#ff8a5c', '#5cd1e0', '#e05cc4', '#8cd15c', '#d15c5c'];

// ============================================================================
// حالة الغرف (Rooms) — كلها بالذاكرة (in-memory)
// ============================================================================

const rooms = {}; // roomCode -> roomState

function createRoom() {
  const roomCode = generateRoomCode();
  const hostToken = makeToken();
  const room = {
    roomCode,
    hostToken,
    hostSocketId: null,
    hostOnline: false,

    phase: 'lobby', // 'lobby' | 'night' | 'day'
    roundNumber: 1,

    players: [], // {id, token, name, socketId, online, dead, color, role, roleRevealed,
                 //  protected, protectedByCrazyId, markedKill, markedElder, markedSpy, markedHunter, markedCrazy,
                 //  elderKnownRole, spyKnownRole}

    rolePool: { مافيا: 1, دكتور: 1, شايب: 1, جاسوس: 0, هنتر: 0, مجنون: 0 },

    killLimit: 1,
    protectLimit: 1,
    elderLimit: 1,
    spyLimit: 1,
    hunterLimit: 1,
    crazyLimit: 1,
    hunterUsesTotal: 0,
    crazyUsesTotal: 0,
    elderUsesThisRound: 0,
    spyUsesThisRound: 0,

    nightSummaryLines: null,
    mafiaChatMemberIds: [],
    mafiaChatMessages: [],

    votingActive: false,
    votes: {}, // voterId -> targetId | '__skip__'
    voteRevealEnabled: false,
    lastVoteResult: null,

    allRolesRevealed: false,

    chatMessages: [],
    gameLog: [],   // سجل كامل (خاص بالهوست)
    publicLog: [], // سجل عام (يشوفه كل اللاعبين)

    timer: { seconds: 60, total: 60, running: false, endTs: null, interval: null },

    gameEnded: false,
    gameEndedInfo: null,

    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  rooms[roomCode] = room;
  return room;
}

function touchRoom(room) {
  room.lastActivity = Date.now();
}

function logEvent(room, text, publicText) {
  const time = nowTimeStr();
  room.gameLog.unshift({ text, time });
  if (room.gameLog.length > 80) room.gameLog = room.gameLog.slice(0, 80);
  if (publicText !== null) {
    room.publicLog.unshift({ text: publicText === undefined ? text : publicText, time });
    if (room.publicLog.length > 40) room.publicLog = room.publicLog.slice(0, 40);
  }
}

// ============================================================================
// بناء وبث حالة اللعبة لكل عميل (كل واحد يشوف بس اللي يخصه)
// ============================================================================

function buildStateForPlayer(room, player) {
  const self = player;
  const isMafia = !!(self && !self.dead && isMafiaRole(self.role));
  const isDoctor = !!(self && !self.dead && self.role === 'دكتور');
  const isElder = !!(self && !self.dead && self.role === 'شايب');
  const isSpy = !!(self && !self.dead && self.role === 'جاسوس');
  const isHunter = !!(self && !self.dead && self.role === 'هنتر');
  const isCrazy = !!(self && !self.dead && self.role === 'مجنون');
  const alive = room.players.filter(p => !p.dead);
  const isMafiaChatMember = !!(self && room.mafiaChatMemberIds.includes(self.id));

  return {
    type: 'state',
    roomCode: room.roomCode,
    phase: room.phase,
    self: self ? { id: self.id, name: self.name, role: self.role || null, dead: self.dead } : null,
    isMafia, isDoctor, isElder, isSpy, isHunter, isCrazy,
    players: room.players.map(p => ({
      id: p.id, name: p.name, dead: p.dead, online: !!p.online,
      knownRole: (isElder && p.elderKnownRole) || (isSpy && p.spyKnownRole) || null,
      revealedRole: room.allRolesRevealed ? (p.role || null) : null
    })),
    aliveTargets: (isMafia && room.phase === 'night') ? room.players.filter(p => !p.dead && p.id !== self.id).map(p => ({ id: p.id, name: p.name, marked: !!p.markedKill })) : [],
    killInfo: isMafia ? { limit: room.killLimit, marked: room.players.filter(p => p.markedKill && !p.dead).length } : null,
    protectTargets: (isDoctor && room.phase === 'night') ? room.players.filter(p => !p.dead).map(p => ({ id: p.id, name: p.name, marked: !!(p.protected && !p.protectedByCrazyId) })) : [],
    protectInfo: isDoctor ? { limit: room.protectLimit, marked: room.players.filter(p => p.protected && !p.dead && !p.protectedByCrazyId).length } : null,
    elderTargets: (isElder && room.phase === 'night') ? room.players.filter(p => !p.dead).map(p => ({ id: p.id, name: p.name, marked: !!p.markedElder })) : [],
    elderInfo: isElder ? { used: room.elderUsesThisRound + room.players.filter(p => p.markedElder && !p.dead).length, limit: room.elderLimit } : null,
    spyTargets: (isSpy && room.phase === 'night') ? room.players.filter(p => !p.dead && p.id !== self.id).map(p => ({ id: p.id, name: p.name, marked: !!p.markedSpy })) : [],
    spyInfo: isSpy ? { limit: room.spyLimit, marked: room.players.filter(p => p.markedSpy && !p.dead).length } : null,
    hunterTargets: (isHunter && room.phase === 'night') ? room.players.filter(p => !p.dead && p.id !== self.id).map(p => ({ id: p.id, name: p.name, marked: !!p.markedHunter })) : [],
    hunterInfo: isHunter ? { limit: room.hunterLimit, marked: room.players.filter(p => p.markedHunter && !p.dead).length, usedTotal: room.hunterUsesTotal } : null,
    crazyTargets: (isCrazy && room.phase === 'night') ? room.players.filter(p => !p.dead && p.id !== self.id).map(p => ({ id: p.id, name: p.name, marked: !!p.markedCrazy })) : [],
    crazyInfo: isCrazy ? { limit: room.crazyLimit, marked: room.players.filter(p => p.markedCrazy && !p.dead).length, usedTotal: room.crazyUsesTotal } : null,
    crazyProtectTargets: (isCrazy && room.phase === 'night') ? room.players.filter(p => !p.dead).map(p => ({ id: p.id, name: p.name, marked: !!(p.protected && p.protectedByCrazyId === self.id) })) : [],
    crazyHasKilledThisRound: isCrazy ? room.players.some(p => p.markedCrazy && !p.dead) : false,
    crazyHasProtectedThisRound: isCrazy ? room.players.some(p => p.protectedByCrazyId === self.id) : false,
    nightSummary: room.nightSummaryLines,
    lastVoteResult: room.lastVoteResult,
    mafiaChat: isMafiaChatMember ? {
      isMember: true,
      members: room.mafiaChatMemberIds.map(id => { const pl = room.players.find(p => p.id === id); return pl ? pl.name : '؟'; }),
      messages: room.mafiaChatMessages.slice(-100)
    } : { isMember: false },
    timer: { seconds: room.timer.seconds, total: room.timer.total, running: room.timer.running, endTs: room.timer.running ? Date.now() + room.timer.seconds * 1000 : null },
    log: room.publicLog.slice(0, 30),
    chat: room.chatMessages.slice(-50),
    remain: alive.length,
    round: room.roundNumber,
    gameOver: room.gameEnded ? room.gameEndedInfo : null,
    voting: (room.votingActive && room.phase === 'day') ? {
      active: true,
      candidates: [...alive.filter(p => p.id !== self?.id).map(p => ({ id: p.id, name: p.name })), { id: '__skip__', name: '⏭️ تخطي (بدون طرد)' }],
      myVote: self ? (room.votes[self.id] || null) : null,
      totalVoters: alive.length,
      votedCount: Object.keys(room.votes).length,
      revealed: room.voteRevealEnabled,
      tally: room.voteRevealEnabled ? (() => {
        const t = {}; alive.forEach(p => t[p.id] = 0); t['__skip__'] = 0;
        Object.values(room.votes).forEach(v => { if (t[v] !== undefined) t[v]++; });
        return [...alive.map(p => ({ id: p.id, name: p.name, count: t[p.id] })), { id: '__skip__', name: '⏭️ تخطي', count: t['__skip__'] }];
      })() : null
    } : { active: false }
  };
}

function buildStateForHost(room) {
  const alive = room.players.filter(p => !p.dead);
  return {
    type: 'hostState',
    roomCode: room.roomCode,
    phase: room.phase,
    round: room.roundNumber,
    players: room.players.map(p => ({
      id: p.id, name: p.name, online: !!p.online, dead: p.dead, role: p.role || null,
      roleRevealed: p.roleRevealed, protected: !!p.protected, protectedByCrazyId: p.protectedByCrazyId || null,
      markedKill: !!p.markedKill, markedElder: !!p.markedElder, markedSpy: !!p.markedSpy,
      markedHunter: !!p.markedHunter, markedCrazy: !!p.markedCrazy, color: p.color
    })),
    rolePool: room.rolePool,
    limits: {
      killLimit: room.killLimit, protectLimit: room.protectLimit, elderLimit: room.elderLimit,
      spyLimit: room.spyLimit, hunterLimit: room.hunterLimit, crazyLimit: room.crazyLimit,
      hunterUsesTotal: room.hunterUsesTotal, crazyUsesTotal: room.crazyUsesTotal
    },
    nightSummary: room.nightSummaryLines,
    lastVoteResult: room.lastVoteResult,
    allRolesRevealed: room.allRolesRevealed,
    mafiaChat: {
      members: room.mafiaChatMemberIds.map(id => { const pl = room.players.find(p => p.id === id); return pl ? pl.name : '؟'; }),
      messages: room.mafiaChatMessages.slice(-200)
    },
    voting: {
      active: room.votingActive,
      votes: room.votes,
      voteRevealEnabled: room.voteRevealEnabled
    },
    timer: room.timer,
    log: room.gameLog.slice(0, 80),
    chat: room.chatMessages.slice(-100),
    remain: alive.length,
    gameOver: room.gameEnded ? room.gameEndedInfo : null
  };
}

function broadcastRoom(room) {
  touchRoom(room);
  room.players.forEach(p => {
    if (p.socketId && io.sockets.sockets.get(p.socketId)) {
      io.to(p.socketId).emit('state', buildStateForPlayer(room, p));
    }
  });
  if (room.hostSocketId && io.sockets.sockets.get(room.hostSocketId)) {
    io.to(room.hostSocketId).emit('hostState', buildStateForHost(room));
  }
}

function broadcastLobby(room) {
  const payload = {
    type: 'lobbyInfo',
    phase: room.phase,
    players: room.players.map(p => ({ id: p.id, name: p.name, online: !!p.online, dead: !!p.dead }))
  };
  // كل اللاعبين المتصلين (حتى اللي ما سجلوا بعد ما لهم socket مخصص هنا، نبثها فقط لسوكيتات اللوبي المسجلة بمصفوفة منفصلة)
  (room.lobbyWatchers || []).forEach(sid => {
    if (io.sockets.sockets.get(sid)) io.to(sid).emit('state', payload);
  });
  if (room.hostSocketId) io.to(room.hostSocketId).emit('hostState', buildStateForHost(room));
}

// ============================================================================
// منطق اللعبة: توزيع الأدوار
// ============================================================================

function distributeRoles(room) {
  if (room.phase !== 'lobby') return { ok: false, message: '🚫 اللعبة بدأت بالفعل. اعمل "إعادة تعيين الكل" لو تبي تبدأ من جديد.' };
  const unassigned = room.players.filter(p => !p.dead && !p.role);
  if (unassigned.length === 0) return { ok: false, message: 'كل اللاعبين عندهم رول بالفعل' };

  const pool = [];
  Object.entries(room.rolePool).forEach(([role, count]) => {
    for (let i = 0; i < (count || 0); i++) pool.push(role);
  });

  const order = [...unassigned];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const shuffledPool = [...pool];
  for (let i = shuffledPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledPool[i], shuffledPool[j]] = [shuffledPool[j], shuffledPool[i]];
  }

  let leftover = 0;
  const n = Math.min(order.length, shuffledPool.length);
  for (let i = 0; i < order.length; i++) {
    if (i < n) {
      order[i].role = shuffledPool[i];
    } else {
      order[i].role = 'مواطن';
      leftover++;
    }
    order[i].roleRevealed = false;
  }

  room.gameEnded = false;
  room.gameEndedInfo = null;
  room.allRolesRevealed = false;
  room.players.forEach(p => { p.elderKnownRole = null; p.spyKnownRole = null; });

  const mafiaPlayers = room.players.filter(p => isMafiaRole(p.role));
  room.mafiaChatMemberIds = mafiaPlayers.map(p => p.id);
  room.mafiaChatMessages = [];

  if (leftover > 0) {
    logEvent(room, `🎭 تم توزيع الرولات على ${n} لاعب، و${leftover} لاعب صاروا مواطنين`);
  } else {
    logEvent(room, `🎭 تم توزيع الرولات على ${n} لاعب`);
  }
  if (mafiaPlayers.length >= 2) {
    logEvent(room, `🕶️ تم فتح شات المافيا السري تلقائيًا (${mafiaPlayers.length} أعضاء)`);
  }

  startNightInternal(room, true);
  return { ok: true };
}

// ============================================================================
// دورة الليل والنهار
// ============================================================================

function startNightInternal(room, isFirst) {
  room.votingActive = false;
  room.votes = {};
  room.phase = 'night';
  room.nightSummaryLines = null;
  if (!isFirst) room.roundNumber += 1;
  room.elderUsesThisRound = 0;
  room.spyUsesThisRound = 0;
  logEvent(room, `🌙 بدأ الليل — راوند ${room.roundNumber}`, `🌙 بدأ الليل — راوند ${room.roundNumber}`);
  broadcastRoom(room);
}

function goNightPhase(room) {
  if (room.phase === 'lobby') return { ok: false, message: '🚫 لازم توزّع الرولات أول.' };
  if (room.phase === 'night') return { ok: false, message: '🌙 إحنا بالفعل بطور الليل.' };
  startNightInternal(room, false);
  return { ok: true };
}

function publicDeathLine(p, cause) {
  if (isSensitiveRole(p.role)) return `💀 مات اللاعب ${p.name}`;
  if (cause === 'mafia') return `💀 ${p.name} — تم قتل مواطن الليلة`;
  if (cause === 'crazy') {
    return isMafiaRole(p.role) ? `💀 ${p.name} — قُتل الليلة (كان روله: ${p.role})` : `💀 ${p.name} — تم قتل مواطن الليلة`;
  }
  return `💀 ${p.name} — قُتل الليلة`;
}

function goDayPhase(room) {
  if (room.phase !== 'night') return { ok: false, message: '🚫 لازم تكون بطور الليل عشان تنهيه.' };

  const mafiaTargets = room.players.filter(p => p.markedKill && !p.dead);
  const crazyTargets = room.players.filter(p => p.markedCrazy && !p.dead);
  const hunterTargets = room.players.filter(p => p.markedHunter && !p.dead);
  const spyTargets = room.players.filter(p => p.markedSpy && !p.dead);
  const elderTargets = room.players.filter(p => p.markedElder);

  let resultLines = [];
  let spyReveals = [];
  let elderReveals = [];

  function resolveKill(p, cause) {
    if (p.dead) return false;
    if (p.protected) {
      resultLines.push(`🛡️ ${p.name} — استُهدفت بس نجت`);
      return false;
    }
    p.dead = true;
    p.roleRevealed = true;
    resultLines.push(publicDeathLine(p, cause));
    return true;
  }

  mafiaTargets.forEach(p => resolveKill(p, 'mafia'));
  crazyTargets.forEach(p => { resolveKill(p, 'crazy'); room.crazyUsesTotal += 1; });

  hunterTargets.forEach(p => {
    room.hunterUsesTotal += 1;
    if (p.dead) return;
    p.dead = true;
    p.roleRevealed = true;
    if (isSensitiveRole(p.role)) {
      resultLines.push(`💀 مات اللاعب ${p.name}`);
    } else if (isMafiaRole(p.role)) {
      resultLines.push(`🏹 ${p.name} — صادها الهنتر، طلع رولها: ${p.role}`);
    } else {
      resultLines.push(`🏹 ${p.name} — مات بصدمة عكسية من طلقة الهنتر`);
    }
  });

  spyTargets.forEach(p => {
    room.spyUsesThisRound += 1;
    const revealText = p.role || 'بدون رول';
    spyReveals.push({ target: p.name, role: revealText });
    p.spyKnownRole = revealText;
    if (isMafiaRole(p.role)) {
      const spyPlayer = room.players.find(pl => !pl.dead && pl.role === 'جاسوس');
      if (spyPlayer && !room.mafiaChatMemberIds.includes(spyPlayer.id)) {
        room.mafiaChatMemberIds.push(spyPlayer.id);
        logEvent(room, '🕶️ الجاسوس اكتشف هوية مافيا وانضم سريًا لشاتهم الخاص', null);
      }
    }
  });

  elderTargets.forEach(p => {
    room.elderUsesThisRound += 1;
    const revealText = p.role || 'بدون رول';
    elderReveals.push({ target: p.name, role: revealText });
    p.elderKnownRole = revealText;
  });

  room.players.forEach(p => {
    p.markedKill = false;
    p.protected = false;
    p.protectedByCrazyId = null;
    p.markedCrazy = false;
    p.markedHunter = false;
    p.markedSpy = false;
    p.markedElder = false;
  });

  room.nightSummaryLines = resultLines.length ? resultLines.slice() : ['😴 ما صار شي هذي الليلة، الجميع نجا بسلام'];
  room.phase = 'day';

  if (spyReveals.length) {
    logEvent(room, `🕵️ نتائج الجاسوس: ${spyReveals.map(r => r.target + ': ' + r.role).join(' | ')}`, null);
    const spyPlayer = room.players.find(pl => !pl.dead && pl.role === 'جاسوس');
    if (spyPlayer && spyPlayer.socketId) {
      io.to(spyPlayer.socketId).emit('privateAlert', `🕵️ نتائج تجسسك هذا الراوند:\n${spyReveals.map(r => r.target + ': ' + r.role).join('\n')}`);
    }
  }
  if (elderReveals.length) {
    logEvent(room, `👁️ نتيجة سؤال الشايب: ${elderReveals.map(r => r.target + ': ' + r.role).join(' | ')}`, null);
    const elderPlayer = room.players.find(pl => !pl.dead && pl.role === 'شايب');
    if (elderPlayer && elderPlayer.socketId) {
      io.to(elderPlayer.socketId).emit('privateAlert', `👁️ نتيجة سؤالك هذا الراوند:\n${elderReveals.map(r => r.target + ': ' + r.role).join('\n')}`);
    }
  }

  checkWinCondition(room);
  if (!room.gameEnded) {
    logEvent(room, `☀️ بدأ النهار — ${room.nightSummaryLines.join(' | ')}`, `☀️ بدأ النهار`);
    startVotingAuto(room);
  } else {
    logEvent(room, '🏁 انتهت اللعبة مباشرة بعد نتيجة الليل');
  }
  broadcastRoom(room);
  return { ok: true };
}

// ============================================================================
// التصويت
// ============================================================================

function startVotingAuto(room) {
  if (room.phase !== 'day') return;
  const alive = room.players.filter(p => !p.dead);
  room.lastVoteResult = null;
  if (alive.length < 2) {
    logEvent(room, '⏭️ ما فيه لاعبين أحياء كفاية للتصويت، رجعنا لليل مباشرة');
    setTimeout(() => startNightInternal(room, false), 300);
    return;
  }
  room.votingActive = true;
  room.votes = {};
  logEvent(room, '🗳️ بدأ التصويت تلقائيًا مع بداية النهار', '🗳️ بدأ التصويت، صوّتوا الحين');
}

function endVoting(room) {
  if (!room.votingActive) return { ok: false, message: 'ما فيه تصويت شغال' };
  const alive = room.players.filter(p => !p.dead);
  const tally = {};
  alive.forEach(p => tally[p.id] = 0);
  tally['__skip__'] = 0;
  Object.values(room.votes).forEach(t => { if (tally[t] !== undefined) tally[t]++; });

  let max = 0, winners = [];
  [...alive.map(p => p.id), '__skip__'].forEach(id => {
    if (tally[id] > max) { max = tally[id]; winners = [id]; }
    else if (tally[id] === max && max > 0) { winners.push(id); }
  });

  const breakdown = alive.map(voter => {
    const choice = room.votes[voter.id];
    let choiceName = '🤐 لم يصوّت';
    if (choice === '__skip__') choiceName = '⏭️ تخطي';
    else if (choice) { const t = room.players.find(pl => pl.id === choice); choiceName = t ? t.name : 'غير معروف'; }
    return { voter: voter.name, choice: choiceName };
  });

  room.votingActive = false;
  room.votes = {};

  let out = null;
  if (max === 0 || winners.length !== 1) {
    logEvent(room, '🤝 التصويت انتهى بدون طرد أحد (تعادل أو ما فيه أصوات)');
  } else if (winners[0] === '__skip__') {
    logEvent(room, '⏭️ صوّتت الأغلبية على التخطي، ما طاح أحد هالجولة', '⏭️ صوّتت الأغلبية على التخطي، ما طاح أحد');
  } else {
    out = room.players.find(p => p.id === winners[0]);
    out.dead = true;
    const sensitive = isSensitiveRole(out.role);
    if (sensitive) {
      out.roleRevealed = false;
      logEvent(room, `⚖️ تم طرد ${out.name} بالتصويت — (روله: ${out.role})`, `💀 مات اللاعب ${out.name}`);
    } else {
      out.roleRevealed = true;
      logEvent(room, `⚖️ تم طرد ${out.name} بالتصويت — كان روله: ${out.role || 'غير معروف'}`, `⚖️ تم طرد ${out.name} بالتصويت${out.role ? (' — كان روله: ' + out.role) : ''}`);
    }
  }

  room.lastVoteResult = {
    breakdown,
    eliminated: out ? { name: out.name, role: isSensitiveRole(out.role) ? null : (out.role || null) } : null
  };

  checkWinCondition(room);
  broadcastRoom(room);
  if (!room.gameEnded) {
    setTimeout(() => startNightInternal(room, false), 600);
  }
  return { ok: true };
}

function cancelVoting(room) {
  if (!room.votingActive) return { ok: false, message: 'ما فيه تصويت شغال' };
  room.votingActive = false;
  room.votes = {};
  room.lastVoteResult = null;
  logEvent(room, '❌ تم إلغاء التصويت بدون طرد أحد', null);
  broadcastRoom(room);
  setTimeout(() => startNightInternal(room, false), 300);
  return { ok: true };
}

// ============================================================================
// شروط الفوز
// ============================================================================

function checkWinCondition(room) {
  const alive = room.players.filter(p => !p.dead && p.role);
  if (alive.length === 0) return;
  const mafiaAligned = alive.filter(p => isMafiaAligned(p.role));
  const citizenAligned = alive.filter(p => !isMafiaAligned(p.role));

  if (mafiaAligned.length === 0) {
    room.gameEnded = true;
    room.gameEndedInfo = { team: 'citizens', survivors: citizenAligned.map(p => p.name) };
    logEvent(room, '🏆 فاز صف المواطنين! تم القضاء على كل المافيا', '🏆 فاز صف المواطنين!');
  } else if (mafiaAligned.length >= citizenAligned.length) {
    room.gameEnded = true;
    room.gameEndedInfo = { team: 'mafia', survivors: mafiaAligned.map(p => p.name) };
    logEvent(room, '🏆 فازت المافيا! أصبح عددهم مساوي أو أكبر من باقي اللاعبين', '🏆 فازت المافيا!');
  }
}

// ============================================================================
// إدارة الاتصال (Socket.io)
// ============================================================================

io.on('connection', (socket) => {

  // ---------------- الهوست: إنشاء غرفة جديدة ----------------
  socket.on('host:create', (_data, cb) => {
    const room = createRoom();
    room.hostSocketId = socket.id;
    room.hostOnline = true;
    room.lobbyWatchers = [];
    socket.data.roomCode = room.roomCode;
    socket.data.isHost = true;
    socket.join(room.roomCode);
    cb && cb({ ok: true, roomCode: room.roomCode, hostToken: room.hostToken });
    broadcastRoom(room);
  });

  // ---------------- الهوست: رجوع بعد تحديث الصفحة ----------------
  socket.on('host:rejoin', ({ roomCode, hostToken }, cb) => {
    const room = rooms[(roomCode || '').toUpperCase()];
    if (!room || room.hostToken !== hostToken) {
      cb && cb({ ok: false, message: 'الغرفة غير موجودة أو الرمز غلط' });
      return;
    }
    room.hostSocketId = socket.id;
    room.hostOnline = true;
    socket.data.roomCode = room.roomCode;
    socket.data.isHost = true;
    socket.join(room.roomCode);
    cb && cb({ ok: true, roomCode: room.roomCode, hostToken: room.hostToken });
    broadcastRoom(room);
  });

  // ---------------- اللاعب: طلب معلومات اللوبي (بانتظار كتابة الاسم) ----------------
  socket.on('lobby:watch', ({ roomCode }, cb) => {
    const room = rooms[(roomCode || '').toUpperCase()];
    if (!room) { cb && cb({ ok: false, message: '🚫 ما فيه غرفة بهذا الكود' }); return; }
    room.lobbyWatchers = room.lobbyWatchers || [];
    if (!room.lobbyWatchers.includes(socket.id)) room.lobbyWatchers.push(socket.id);
    socket.data.roomCode = room.roomCode;
    socket.join(room.roomCode + ':lobby');
    cb && cb({
      ok: true,
      phase: room.phase,
      players: room.players.map(p => ({ id: p.id, name: p.name, online: !!p.online, dead: !!p.dead }))
    });
  });

  // ---------------- اللاعب: تسجيل اسم جديد أو رجوع بنفس الاسم ----------------
  socket.on('player:register', ({ roomCode, name }, cb) => {
    const room = rooms[(roomCode || '').toUpperCase()];
    if (!room) { cb && cb({ ok: false, message: '🚫 ما فيه غرفة بهذا الكود' }); return; }
    const cleanName = (name || '').toString().trim().slice(0, 24);
    if (!cleanName) { cb && cb({ ok: false, message: 'اكتب اسم صحيح أول' }); return; }

    const existing = room.players.find(pl => pl.name.trim().toLowerCase() === cleanName.toLowerCase());
    if (existing) {
      existing.socketId = socket.id;
      existing.online = true;
      socket.data.roomCode = room.roomCode;
      socket.data.playerId = existing.id;
      socket.join(room.roomCode);
      cb && cb({ ok: true, playerId: existing.id, playerToken: existing.token, name: existing.name });
      logEvent(room, `🔌 ${existing.name} رجع بنفس اسمه بعد انقطاع الاتصال`, `🔌 ${existing.name} رجع للعبة`);
      broadcastRoom(room);
      return;
    }

    if (room.phase !== 'lobby') {
      cb && cb({ ok: false, message: '🚫 اللعبة بدأت بالفعل، انتظر لعبة جديدة عشان تنضم' });
      return;
    }

    const newP = {
      id: crypto.randomBytes(8).toString('hex'),
      token: makeToken(),
      name: cleanName,
      socketId: socket.id,
      online: true,
      dead: false,
      color: COLORS[room.players.length % COLORS.length],
      role: null, roleRevealed: false,
      protected: false, protectedByCrazyId: null,
      markedKill: false, markedElder: false, markedSpy: false, markedHunter: false, markedCrazy: false,
      elderKnownRole: null, spyKnownRole: null
    };
    room.players.push(newP);
    socket.data.roomCode = room.roomCode;
    socket.data.playerId = newP.id;
    socket.join(room.roomCode);
    cb && cb({ ok: true, playerId: newP.id, playerToken: newP.token, name: newP.name });
    logEvent(room, `🪑 ${newP.name} حجز مقعده باللوبي`, `🪑 ${newP.name} انضم للعبة`);
    broadcastLobby(room);
    broadcastRoom(room);
  });

  // ---------------- اللاعب: رجوع تلقائي بعد تحديث الصفحة (بالتوكن المحفوظ) ----------------
  socket.on('player:rejoin', ({ roomCode, playerId, playerToken }, cb) => {
    const room = rooms[(roomCode || '').toUpperCase()];
    if (!room) { cb && cb({ ok: false, message: '🚫 الغرفة ما عادت موجودة' }); return; }
    const p = room.players.find(pl => pl.id === playerId && pl.token === playerToken);
    if (!p) { cb && cb({ ok: false, message: 'مقعدك ما عاد موجود، سجّل من جديد' }); return; }
    p.socketId = socket.id;
    p.online = true;
    socket.data.roomCode = room.roomCode;
    socket.data.playerId = p.id;
    socket.join(room.roomCode);
    cb && cb({ ok: true, playerId: p.id, playerToken: p.token, name: p.name });
    logEvent(room, `🔌 ${p.name} رجع للعبة`, `🔌 ${p.name} رجع للعبة`);
    broadcastRoom(room);
  });

  // ---------------- أوامر الهوست ----------------
  function withHostRoom(handler) {
    return (data, cb) => {
      const roomCode = socket.data.roomCode;
      const room = rooms[roomCode];
      if (!room || room.hostSocketId !== socket.id) { cb && cb({ ok: false, message: 'مو مسموح' }); return; }
      handler(room, data || {}, cb);
    };
  }

  socket.on('host:addPlayer', withHostRoom((room, { name }, cb) => {
    const cleanName = (name || '').toString().trim().slice(0, 24);
    if (!cleanName) { cb && cb({ ok: false, message: 'اكتب اسم' }); return; }
    if (room.players.some(p => p.name.trim().toLowerCase() === cleanName.toLowerCase())) {
      cb && cb({ ok: false, message: 'فيه لاعب بنفس الاسم' }); return;
    }
    room.players.push({
      id: crypto.randomBytes(8).toString('hex'), token: makeToken(), name: cleanName,
      socketId: null, online: false, dead: false, color: COLORS[room.players.length % COLORS.length],
      role: null, roleRevealed: false, protected: false, protectedByCrazyId: null,
      markedKill: false, markedElder: false, markedSpy: false, markedHunter: false, markedCrazy: false,
      elderKnownRole: null, spyKnownRole: null
    });
    logEvent(room, `➕ الهوست أضاف لاعب محلي: ${cleanName}`, null);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('host:kickPlayer', withHostRoom((room, { playerId }, cb) => {
    const p = room.players.find(pl => pl.id === playerId);
    if (!p) { cb && cb({ ok: false }); return; }
    room.players = room.players.filter(pl => pl.id !== playerId);
    logEvent(room, `🗑️ تم حذف اللاعب: ${p.name}`, null);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('host:setRolePool', withHostRoom((room, { rolePool }, cb) => {
    if (room.phase !== 'lobby') { cb && cb({ ok: false, message: 'ما تقدر تغير الرولات بعد بدء اللعبة' }); return; }
    room.rolePool = { ...room.rolePool, ...(rolePool || {}) };
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('host:setLimits', withHostRoom((room, limits, cb) => {
    ['killLimit', 'protectLimit', 'elderLimit', 'spyLimit', 'hunterLimit', 'crazyLimit'].forEach(k => {
      if (typeof limits[k] === 'number' && limits[k] >= 0) room[k] = limits[k];
    });
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('host:distributeRoles', withHostRoom((room, _d, cb) => {
    const r = distributeRoles(room);
    broadcastRoom(room);
    cb && cb(r);
  }));

  socket.on('host:goNight', withHostRoom((room, _d, cb) => {
    const r = goNightPhase(room);
    cb && cb(r);
  }));

  socket.on('host:goDay', withHostRoom((room, _d, cb) => {
    const r = goDayPhase(room);
    cb && cb(r);
  }));

  socket.on('host:endVoting', withHostRoom((room, _d, cb) => {
    const r = endVoting(room);
    cb && cb(r);
  }));

  socket.on('host:cancelVoting', withHostRoom((room, _d, cb) => {
    const r = cancelVoting(room);
    cb && cb(r);
  }));

  socket.on('host:toggleVoteReveal', withHostRoom((room, { value }, cb) => {
    room.voteRevealEnabled = !!value;
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('host:revealAllRoles', withHostRoom((room, _d, cb) => {
    room.allRolesRevealed = !room.allRolesRevealed;
    logEvent(room, room.allRolesRevealed ? '🔓 تم كشف كل الأدوار لجميع اللاعبين' : '🙈 تم إخفاء كل الأدوار مرة ثانية',
      room.allRolesRevealed ? '🔓 الهوست كشف كل الأدوار للجميع' : null);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('host:hideRole', withHostRoom((room, { playerId }, cb) => {
    const p = room.players.find(pl => pl.id === playerId);
    if (p) p.roleRevealed = false;
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('host:manualMark', withHostRoom((room, { kind, playerId }, cb) => {
    const p = room.players.find(pl => pl.id === playerId);
    if (!p || p.dead) { cb && cb({ ok: false }); return; }
    if (kind === 'kill') p.markedKill = !p.markedKill;
    else if (kind === 'protect') { p.protected = !p.protected; if (!p.protected) p.protectedByCrazyId = null; }
    else if (kind === 'elder') p.markedElder = !p.markedElder;
    else if (kind === 'spy') p.markedSpy = !p.markedSpy;
    else if (kind === 'hunter') p.markedHunter = !p.markedHunter;
    else if (kind === 'crazy') p.markedCrazy = !p.markedCrazy;
    else if (kind === 'crazyProtect') {
      if (p.protected && p.protectedByCrazyId) { p.protected = false; p.protectedByCrazyId = null; }
      else { room.players.forEach(pl => { if (pl.protectedByCrazyId) { pl.protected = false; pl.protectedByCrazyId = null; } }); p.protected = true; p.protectedByCrazyId = 'host-manual'; }
    }
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('host:timerStart', withHostRoom((room, { seconds }, cb) => {
    clearInterval(room.timer.interval);
    room.timer.total = seconds || room.timer.total || 60;
    room.timer.seconds = room.timer.total;
    room.timer.running = true;
    room.timer.interval = setInterval(() => {
      room.timer.seconds -= 1;
      if (room.timer.seconds <= 0) {
        room.timer.seconds = 0;
        room.timer.running = false;
        clearInterval(room.timer.interval);
      }
      broadcastRoom(room);
    }, 1000);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('host:timerStop', withHostRoom((room, _d, cb) => {
    clearInterval(room.timer.interval);
    room.timer.running = false;
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('host:resetEverything', withHostRoom((room, _d, cb) => {
    clearInterval(room.timer.interval);
    room.phase = 'lobby';
    room.roundNumber = 1;
    room.players.forEach(p => {
      p.dead = false; p.role = null; p.roleRevealed = false;
      p.protected = false; p.protectedByCrazyId = null;
      p.markedKill = false; p.markedElder = false; p.markedSpy = false; p.markedHunter = false; p.markedCrazy = false;
      p.elderKnownRole = null; p.spyKnownRole = null;
    });
    room.hunterUsesTotal = 0; room.crazyUsesTotal = 0; room.elderUsesThisRound = 0; room.spyUsesThisRound = 0;
    room.nightSummaryLines = null;
    room.mafiaChatMessages = []; room.mafiaChatMemberIds = [];
    room.votingActive = false; room.votes = {}; room.lastVoteResult = null;
    room.allRolesRevealed = false;
    room.gameEnded = false; room.gameEndedInfo = null;
    room.chatMessages = []; room.gameLog = []; room.publicLog = [];
    room.timer = { seconds: 60, total: 60, running: false, endTs: null, interval: null };
    logEvent(room, '🔄 تم إعادة تعيين كل شي للبداية');
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('host:chatSend', withHostRoom((room, { text }, cb) => {
    const clean = (text || '').toString().trim().slice(0, 300);
    if (!clean) return;
    room.chatMessages.push({ sender: 'الهوست', text: clean, time: nowTimeStr(), isHost: true });
    if (room.chatMessages.length > 200) room.chatMessages = room.chatMessages.slice(-200);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  // ---------------- أوامر اللاعبين ----------------
  function withPlayerRoom(handler) {
    return (data, cb) => {
      const roomCode = socket.data.roomCode;
      const playerId = socket.data.playerId;
      const room = rooms[roomCode];
      if (!room || !playerId) { cb && cb({ ok: false }); return; }
      const player = room.players.find(p => p.id === playerId);
      if (!player) { cb && cb({ ok: false }); return; }
      handler(room, player, data || {}, cb);
    };
  }

  socket.on('player:markKill', withPlayerRoom((room, shooter, { targetId }, cb) => {
    if (room.phase !== 'night') { cb && cb({ ok: false, message: '🌙 قدرة المافيا تشتغل بس بالليل' }); return; }
    if (shooter.dead || !isMafiaRole(shooter.role)) { cb && cb({ ok: false, message: 'ما تقدر تستهدف' }); return; }
    const target = room.players.find(p => p.id === targetId);
    if (!target || target.dead) { cb && cb({ ok: false, message: 'الهدف مو متاح' }); return; }
    if (!target.markedKill) {
      const activeCount = room.players.filter(p => p.markedKill && !p.dead).length;
      if (activeCount >= room.killLimit) { cb && cb({ ok: false, message: `🚫 وصلتوا الحد الأقصى (${room.killLimit})` }); return; }
    }
    target.markedKill = !target.markedKill;
    logEvent(room, target.markedKill ? `🎯 ${shooter.name} استهدف: ${target.name}` : `↩️ ${shooter.name} ألغى استهداف ${target.name}`, null);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('player:markProtect', withPlayerRoom((room, doctor, { targetId }, cb) => {
    if (room.phase !== 'night') { cb && cb({ ok: false, message: '🌙 قدرة الدكتور تشتغل بس بالليل' }); return; }
    if (doctor.dead || doctor.role !== 'دكتور') { cb && cb({ ok: false, message: 'ما تقدر تحمي' }); return; }
    const target = room.players.find(p => p.id === targetId);
    if (!target || target.dead) { cb && cb({ ok: false, message: 'الهدف مو متاح' }); return; }
    if (!target.protected) {
      const activeCount = room.players.filter(p => p.protected && !p.dead && !p.protectedByCrazyId).length;
      if (activeCount >= room.protectLimit) { cb && cb({ ok: false, message: `🚫 وصلتوا الحد الأقصى (${room.protectLimit})` }); return; }
      target.protected = true;
    } else {
      target.protected = false;
    }
    logEvent(room, target.protected ? `🛡️ تفعيل حماية على: ${target.name}` : `⛔ تم إلغاء حماية ${target.name}`, null);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('player:elderPeek', withPlayerRoom((room, elder, { targetId }, cb) => {
    if (room.phase !== 'night') { cb && cb({ ok: false, message: '🌙 قدرة الشايب تشتغل بس بالليل' }); return; }
    if (elder.dead || elder.role !== 'شايب') { cb && cb({ ok: false, message: 'ما تقدر تستخدم هذي القدرة' }); return; }
    const target = room.players.find(p => p.id === targetId);
    if (!target || target.dead) { cb && cb({ ok: false, message: 'الهدف مو متاح' }); return; }
    if (!target.markedElder) {
      const activeCount = room.players.filter(p => p.markedElder && !p.dead).length;
      if (room.elderUsesThisRound + activeCount >= room.elderLimit) {
        cb && cb({ ok: false, message: `🚫 استخدمت حد استخداماتك هذا الراوند (${room.elderLimit})` }); return;
      }
    }
    target.markedElder = !target.markedElder;
    logEvent(room, target.markedElder ? `👁️ الشايب حدد ${target.name}` : `↩️ الشايب ألغى سؤاله عن ${target.name}`, null);
    broadcastRoom(room);
    cb && cb({ ok: true, message: target.markedElder ? `👁️ بتعرف رول ${target.name} بعد نهاية الليل` : `↩️ ألغيت السؤال عن ${target.name}` });
  }));

  socket.on('player:markSpy', withPlayerRoom((room, spy, { targetId }, cb) => {
    if (room.phase !== 'night') { cb && cb({ ok: false, message: '🌙 قدرة الجاسوس تشتغل بس بالليل' }); return; }
    if (spy.dead || spy.role !== 'جاسوس') { cb && cb({ ok: false, message: 'ما تقدر تستخدم هذي القدرة' }); return; }
    const target = room.players.find(p => p.id === targetId);
    if (!target || target.dead) { cb && cb({ ok: false, message: 'الهدف مو متاح' }); return; }
    if (!target.markedSpy) {
      const activeCount = room.players.filter(p => p.markedSpy && !p.dead).length;
      if (activeCount >= room.spyLimit) { cb && cb({ ok: false, message: `🚫 وصلتوا حد التجسس (${room.spyLimit})` }); return; }
    }
    target.markedSpy = !target.markedSpy;
    logEvent(room, target.markedSpy ? `🕵️ تحديد هدف الجاسوس: ${target.name}` : `↩️ إلغاء هدف الجاسوس ${target.name}`, null);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('player:markHunter', withPlayerRoom((room, hunter, { targetId }, cb) => {
    if (room.phase !== 'night') { cb && cb({ ok: false, message: '🌙 قدرة الهنتر تشتغل بس بالليل' }); return; }
    if (hunter.dead || hunter.role !== 'هنتر') { cb && cb({ ok: false, message: 'ما تقدر تستخدم هذي القدرة' }); return; }
    const target = room.players.find(p => p.id === targetId);
    if (!target || target.dead) { cb && cb({ ok: false, message: 'الهدف مو متاح' }); return; }
    if (target.markedHunter) { cb && cb({ ok: false, message: '🚫 اخترت هدفك بالفعل' }); return; }
    const activeCount = room.players.filter(p => p.markedHunter && !p.dead).length;
    if (room.hunterUsesTotal + activeCount >= room.hunterLimit) { cb && cb({ ok: false, message: `🚫 ما عندك رصاص كافي` }); return; }
    target.markedHunter = true;
    logEvent(room, `🏹 تحديد هدف الهنتر (رصاصة نهائية): ${target.name}`, null);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('player:markCrazy', withPlayerRoom((room, crazy, { targetId }, cb) => {
    if (room.phase !== 'night') { cb && cb({ ok: false, message: '🌙 قدرة المجنون تشتغل بس بالليل' }); return; }
    if (crazy.dead || crazy.role !== 'مجنون') { cb && cb({ ok: false, message: 'ما تقدر تستخدم هذي القدرة' }); return; }
    const target = room.players.find(p => p.id === targetId);
    if (!target || target.dead) { cb && cb({ ok: false, message: 'الهدف مو متاح' }); return; }
    if (target.markedCrazy) { cb && cb({ ok: false, message: '🚫 اخترت هدفك بالفعل' }); return; }
    if (room.players.some(p => p.protectedByCrazyId === crazy.id)) { cb && cb({ ok: false, message: '🚫 اخترت الحماية هالراوند، ما تقدر تسوي الاثنين' }); return; }
    const activeCount = room.players.filter(p => p.markedCrazy && !p.dead).length;
    if (room.crazyUsesTotal + activeCount >= room.crazyLimit) { cb && cb({ ok: false, message: `🚫 استخدمت كل قتلاتك المتاحة` }); return; }
    target.markedCrazy = true;
    logEvent(room, `🃏 تحديد هدف المجنون (اختيار نهائي): ${target.name}`, null);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('player:markCrazyProtect', withPlayerRoom((room, crazy, { targetId }, cb) => {
    if (room.phase !== 'night') { cb && cb({ ok: false, message: '🌙 قدرة المجنون تشتغل بس بالليل' }); return; }
    if (crazy.dead || crazy.role !== 'مجنون') { cb && cb({ ok: false, message: 'ما تقدر تستخدم هذي القدرة' }); return; }
    const target = room.players.find(p => p.id === targetId);
    if (!target || target.dead) { cb && cb({ ok: false, message: 'الهدف مو متاح' }); return; }
    if (target.protected && target.protectedByCrazyId === crazy.id) {
      target.protected = false; target.protectedByCrazyId = null;
      logEvent(room, `↩️ المجنون ألغى حمايته عن ${target.name}`, null);
      broadcastRoom(room); cb && cb({ ok: true }); return;
    }
    if (room.players.some(p => p.markedCrazy && !p.dead)) { cb && cb({ ok: false, message: '🚫 اخترت القتل هالراوند، ما تقدر تسوي الاثنين' }); return; }
    const prev = room.players.find(p => p.protectedByCrazyId === crazy.id);
    if (prev) { prev.protected = false; prev.protectedByCrazyId = null; }
    target.protected = true;
    target.protectedByCrazyId = crazy.id;
    logEvent(room, `🛡️ المجنون اختار يحمي: ${target.name}`, null);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('player:castVote', withPlayerRoom((room, voter, { targetId }, cb) => {
    if (!room.votingActive || room.phase !== 'day' || voter.dead) { cb && cb({ ok: false }); return; }
    if (targetId === '__skip__') {
      room.votes[voter.id] = '__skip__';
    } else if (targetId) {
      const target = room.players.find(p => p.id === targetId);
      if (!target || target.dead || target.id === voter.id) { cb && cb({ ok: false }); return; }
      room.votes[voter.id] = targetId;
    } else {
      delete room.votes[voter.id];
    }
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('player:chatSend', withPlayerRoom((room, player, { text }, cb) => {
    if (player.dead) return;
    const clean = (text || '').toString().trim().slice(0, 300);
    if (!clean) return;
    room.chatMessages.push({ sender: player.name, text: clean, time: nowTimeStr(), isHost: false });
    if (room.chatMessages.length > 200) room.chatMessages = room.chatMessages.slice(-200);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  socket.on('player:mafiaChatSend', withPlayerRoom((room, player, { text }, cb) => {
    if (player.dead || !room.mafiaChatMemberIds.includes(player.id)) return;
    const clean = (text || '').toString().trim().slice(0, 300);
    if (!clean) return;
    room.mafiaChatMessages.push({ sender: player.name, text: clean, time: nowTimeStr() });
    if (room.mafiaChatMessages.length > 200) room.mafiaChatMessages = room.mafiaChatMessages.slice(-200);
    broadcastRoom(room);
    cb && cb({ ok: true });
  }));

  // ---------------- الانقطاع ----------------
  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (socket.data.isHost && room.hostSocketId === socket.id) {
      room.hostOnline = false;
      room.hostSocketId = null;
    } else if (socket.data.playerId) {
      const p = room.players.find(pl => pl.id === socket.data.playerId);
      if (p) {
        p.online = false;
        p.socketId = null;
        broadcastRoom(room);
      }
    }
    if (room.lobbyWatchers) room.lobbyWatchers = room.lobbyWatchers.filter(sid => sid !== socket.id);
  });
});

// تنظيف دوري للغرف الميتة تمامًا (بدون هوست ولا لاعبين أونلاين لأكثر من 6 ساعات)
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach(code => {
    const room = rooms[code];
    const anyoneOnline = room.hostOnline || room.players.some(p => p.online);
    if (!anyoneOnline && now - room.lastActivity > 6 * 60 * 60 * 1000) {
      clearInterval(room.timer.interval);
      delete rooms[code];
    }
  });
}, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`🎭 سيرفر لعبة المافيا شغال على المنفذ ${PORT}`);
});
