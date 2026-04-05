const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// Load word lists from words/ directory
const wordLists = {};
function loadWordLists() {
  const wordsDir = path.join(__dirname, 'words');
  if (!fs.existsSync(wordsDir)) return;
  const files = fs.readdirSync(wordsDir).filter(f => f.endsWith('.txt'));
  files.forEach(file => {
    const name = path.basename(file, '.txt');
    const content = fs.readFileSync(path.join(wordsDir, file), 'utf8');
    const words = content.split('\n').map(w => w.trim()).filter(w => w.length > 0);
    if (words.length > 0) wordLists[name] = words;
  });
  console.log(`Loaded word lists: ${Object.keys(wordLists).join(', ')}`);
}
loadWordLists();

const ROUNDS_PER_GAME = 3;
const MAX_PLAYERS = 8;

const rooms = {};

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Weighted random list selection: each list has a weight (1-5).
// Within a list, words used fewer times in this game are preferred.
function getRandomWords(room, count) {
  const selected = (room.selectedLists && room.selectedLists.length > 0)
    ? room.selectedLists.filter(l => wordLists[l] && wordLists[l].length > 0)
    : Object.keys(wordLists);

  if (selected.length === 0) return [];

  const weights = room.listWeights || {};

  // Build weighted list pool
  function pickList() {
    const totalWeight = selected.reduce((s, n) => s + (weights[n] || 1), 0);
    let r = Math.random() * totalWeight;
    for (const name of selected) {
      r -= (weights[name] || 1);
      if (r <= 0) return name;
    }
    return selected[selected.length - 1];
  }

  // Word variety weight: inversely proportional to how many times it's been used
  function wordVarietyWeight(word) {
    const uses = room.wordUsedCount[word] || 0;
    if (uses === 0) return 4;
    if (uses === 1) return 2;
    return 1;
  }

  function pickWordFromList(listName) {
    const list = wordLists[listName];
    const totalW = list.reduce((s, w) => s + wordVarietyWeight(w), 0);
    let r = Math.random() * totalW;
    for (const word of list) {
      r -= wordVarietyWeight(word);
      if (r <= 0) return word;
    }
    return list[list.length - 1];
  }

  if (room.options.combinations) {
    const pairs = [];
    const usedPairs = new Set();
    let attempts = 0;
    while (pairs.length < count && attempts < 300) {
      attempts++;
      const w1 = pickWordFromList(pickList());
      const w2 = pickWordFromList(pickList());
      if (w1 !== w2) {
        const key = [w1, w2].sort().join('+');
        if (!usedPairs.has(key)) {
          usedPairs.add(key);
          pairs.push(`${w1}+${w2}`);
        }
      }
    }
    return pairs;
  }

  const result = [];
  const used = new Set();
  let attempts = 0;

  while (result.length < count && attempts < 300) {
    attempts++;
    const listName = pickList();
    const word = pickWordFromList(listName);
    if (!used.has(word)) {
      used.add(word);
      result.push(word);
    }
  }

  return result;
}

function maskWord(word) {
  return word.split('').map(c => (c === ' ' || c === '+') ? c : '_').join('');
}

// Random hints: reveals `additionalCount` new random letters beyond already-revealed ones.
// `revealedIndices` is mutated in place.
function giveHint(word, revealedIndices, additionalCount) {
  const chars = word.split('');
  const allIndices = chars.map((c, i) => c !== ' ' ? i : -1).filter(i => i !== -1);
  const unrevealed = allIndices.filter(i => !revealedIndices.includes(i));
  const shuffled = unrevealed.sort(() => Math.random() - 0.5);
  const newReveal = shuffled.slice(0, additionalCount);
  revealedIndices.push(...newReveal);
  return chars.map((c, i) => {
    if (c === ' ') return ' ';
    if (revealedIndices.includes(i)) return c;
    return '_';
  }).join('');
}

function createRoom(hostId, hostName) {
  const roomId = generateRoomId();
  rooms[roomId] = {
    id: roomId,
    players: [],
    host: hostId,
    state: 'lobby',
    round: 0,
    currentDrawerIndex: 0,
    currentWord: null,
    wordChoices: [],
    timer: null,
    timeLeft: 0,
    strokes: [],        // array of stroke arrays, for undo
    currentStroke: [],  // draw events since last strokeEnd
    drawHistory: [],    // flat replay list
    scores: {},
    guessedPlayers: new Set(),
    hintsGiven: 0,
    revealedIndices: [],
    selectedLists: Object.keys(wordLists),
    listWeights: {},    // listName -> 1-5
    wordUsedCount: {},  // word -> times chosen this game
    options: {
      wordChoices: 3,
      roundTime: 80,
      hintCount: 2,
      combinations: false,
      hidden: false,
    },
  };
  return roomId;
}

function getRoom(roomId) { return rooms[roomId]; }

function addPlayer(roomId, socketId, name) {
  const room = getRoom(roomId);
  if (!room) return false;
  if (room.players.length >= MAX_PLAYERS) return false;
  room.players.push({ id: socketId, name, score: 0 });
  room.scores[socketId] = 0;
  return true;
}

function removePlayer(roomId, socketId) {
  const room = getRoom(roomId);
  if (!room) return;
  room.players = room.players.filter(p => p.id !== socketId);
  delete room.scores[socketId];
  if (room.players.length === 0) {
    clearRoomTimer(room);
    delete rooms[roomId];
    return;
  }
  if (room.host === socketId && room.players.length > 0) {
    room.host = room.players[0].id;
  }
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function getRoomPublicState(room) {
  return {
    id: room.id,
    state: room.state,
    round: room.round,
    totalRounds: ROUNDS_PER_GAME,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: room.scores[p.id] || 0,
    })),
    host: room.host,
    currentDrawerId: room.players[room.currentDrawerIndex]?.id || null,
    timeLeft: room.timeLeft,
    wordLength: (room.currentWord && !room.options.hidden) ? room.currentWord.length : 0,
    wordSpaces: (room.currentWord && !room.options.hidden) ? maskWord(room.currentWord) : null,
    hiddenMode: !!(room.options && room.options.hidden),
    wordLists: {
      available: Object.keys(wordLists).map(name => ({ name, count: wordLists[name].length })),
      selected: room.selectedLists,
      weights: room.listWeights,
    },
    options: { ...room.options },
  };
}

function startRound(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  clearRoomTimer(room);

  room.strokes = [];
  room.currentStroke = [];
  room.drawHistory = [];
  room.guessedPlayers = new Set();
  room.hintsGiven = 0;
  room.revealedIndices = [];
  room.currentWord = null;

  if (room.currentDrawerIndex >= room.players.length) {
    room.currentDrawerIndex = 0;
    room.round++;
  }

  if (room.round > ROUNDS_PER_GAME) {
    endGame(roomId);
    return;
  }

  const drawer = room.players[room.currentDrawerIndex];
  if (!drawer) { endGame(roomId); return; }

  room.wordChoices = getRandomWords(room, room.options.wordChoices);
  room.state = 'choosing';
  room.timeLeft = 20;

  io.to(roomId).emit('roundStart', {
    ...getRoomPublicState(room),
    drawerId: drawer.id,
    drawerName: drawer.name,
  });

  io.to(drawer.id).emit('wordChoices', { words: room.wordChoices });

  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(roomId).emit('timerTick', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      clearRoomTimer(room);
      if (room.state === 'choosing') {
        wordChosen(roomId, room.wordChoices[0]);
      }
    }
  }, 1000);
}

function wordChosen(roomId, word) {
  const room = getRoom(roomId);
  if (!room) return;
  clearRoomTimer(room);

  room.currentWord = word;
  room.wordUsedCount[word] = (room.wordUsedCount[word] || 0) + 1;
  room.state = 'drawing';
  room.timeLeft = room.options.roundTime;
  room.strokes = [];
  room.currentStroke = [];
  room.drawHistory = [];
  room.revealedIndices = [];

  const drawer = room.players[room.currentDrawerIndex];
  const masked = maskWord(word);

  io.to(roomId).emit('drawingStart', {
    ...getRoomPublicState(room),
    maskedWord: masked,
    drawerId: drawer.id,
    drawerName: drawer.name,
  });

  io.to(drawer.id).emit('yourWord', { word });

  const roundTime = room.options.roundTime;
  const hintCount = room.options.hintCount;
  const skipHints = room.options.hidden || room.options.combinations;
  // Spread hints evenly across the round
  const hintTimes = [];
  if (!skipHints) {
    for (let i = 1; i <= hintCount; i++) {
      hintTimes.push(Math.floor(roundTime * (hintCount - i + 1) / (hintCount + 1)));
    }
  }

  room.timer = setInterval(() => {
    room.timeLeft--;

    if (!skipHints) {
      const wordChars = word.replace(/ /g, '').length;
      const lettersPerHint = Math.max(1, Math.floor(wordChars / (hintCount + 1)));

      for (let i = 0; i < hintTimes.length; i++) {
        if (room.timeLeft === hintTimes[i] && room.hintsGiven === i) {
          room.hintsGiven = i + 1;
          const hint = giveHint(word, room.revealedIndices, lettersPerHint);
          io.to(roomId).emit('hint', { hint });
          break;
        }
      }
    }

    io.to(roomId).emit('timerTick', { timeLeft: room.timeLeft });

    if (room.timeLeft <= 0) {
      clearRoomTimer(room);
      endDrawingRound(roomId);
    }
  }, 1000);
}

function endDrawingRound(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  clearRoomTimer(room);
  room.state = 'roundEnd';

  io.to(roomId).emit('roundEnd', {
    word: room.currentWord,
    scores: room.players.map(p => ({ id: p.id, name: p.name, score: room.scores[p.id] || 0 })),
  });

  room.currentDrawerIndex++;

  setTimeout(() => {
    if (rooms[roomId]) startRound(roomId);
  }, 6000);
}

function endGame(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  clearRoomTimer(room);
  room.state = 'gameEnd';

  const finalScores = room.players
    .map(p => ({ id: p.id, name: p.name, score: room.scores[p.id] || 0 }))
    .sort((a, b) => b.score - a.score);

  io.to(roomId).emit('gameEnd', { finalScores });

  setTimeout(() => {
    if (rooms[roomId]) {
      room.state = 'lobby';
      room.round = 0;
      room.currentDrawerIndex = 0;
      room.wordUsedCount = {};
      room.players.forEach(p => { room.scores[p.id] = 0; });
      io.to(roomId).emit('backToLobby', getRoomPublicState(room));
    }
  }, 10000);
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName = null;

  socket.on('createRoom', ({ name }) => {
    playerName = name || 'Player';
    const roomId = createRoom(socket.id, playerName);
    addPlayer(roomId, socket.id, playerName);
    socket.join(roomId);
    currentRoom = roomId;
    const room = getRoom(roomId);
    socket.emit('roomCreated', { roomId, state: getRoomPublicState(room) });
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    const room = getRoom(roomId);
    if (!room) { socket.emit('error', { message: 'Room not found.' }); return; }
    if (room.players.length >= MAX_PLAYERS) { socket.emit('error', { message: 'Room is full.' }); return; }
    if (room.state !== 'lobby') { socket.emit('error', { message: 'Game already in progress.' }); return; }

    playerName = name || 'Player';
    addPlayer(roomId, socket.id, playerName);
    socket.join(roomId);
    currentRoom = roomId;

    socket.emit('roomJoined', { roomId, state: getRoomPublicState(room) });
    socket.to(roomId).emit('playerJoined', { player: { id: socket.id, name: playerName }, state: getRoomPublicState(room) });
  });

  socket.on('startGame', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room) return;
    if (room.host !== socket.id) { socket.emit('error', { message: 'Only the host can start.' }); return; }
    if (room.players.length < 2) { socket.emit('error', { message: 'Need at least 2 players.' }); return; }

    room.round = 1;
    room.currentDrawerIndex = 0;
    room.wordUsedCount = {};
    room.players.forEach(p => { room.scores[p.id] = 0; });
    startRound(currentRoom);
  });

  socket.on('setWordLists', ({ lists, weights }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.host !== socket.id || room.state !== 'lobby') return;
    const valid = lists.filter(l => wordLists[l]);
    room.selectedLists = valid.length > 0 ? valid : Object.keys(wordLists);
    if (weights && typeof weights === 'object') {
      room.listWeights = {};
      for (const [name, w] of Object.entries(weights)) {
        if (wordLists[name]) room.listWeights[name] = Math.max(1, Math.min(5, Number(w) || 1));
      }
    }
    io.to(currentRoom).emit('stateUpdate', getRoomPublicState(room));
  });

  socket.on('setGameOptions', ({ options }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.host !== socket.id || room.state !== 'lobby') return;
    if (options.wordChoices !== undefined) room.options.wordChoices = Math.max(2, Math.min(6, parseInt(options.wordChoices) || 3));
    if (options.roundTime !== undefined) room.options.roundTime = Math.max(15, Math.min(180, parseInt(options.roundTime) || 80));
    if (options.hintCount !== undefined) room.options.hintCount = Math.max(0, Math.min(5, parseInt(options.hintCount) || 2));
    if (options.combinations !== undefined) room.options.combinations = !!options.combinations;
    if (options.hidden !== undefined) room.options.hidden = !!options.hidden;
    io.to(currentRoom).emit('stateUpdate', getRoomPublicState(room));
  });

  socket.on('chooseWord', ({ word }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room) return;
    const drawer = room.players[room.currentDrawerIndex];
    if (!drawer || drawer.id !== socket.id) return;
    if (room.state !== 'choosing') return;
    if (!room.wordChoices.includes(word)) return;
    wordChosen(currentRoom, word);
  });

  socket.on('draw', (data) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'drawing') return;
    const drawer = room.players[room.currentDrawerIndex];
    if (!drawer || drawer.id !== socket.id) return;
    room.currentStroke.push(data);
    room.drawHistory.push(data);
    socket.to(currentRoom).emit('draw', data);
  });

  socket.on('strokeEnd', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'drawing') return;
    const drawer = room.players[room.currentDrawerIndex];
    if (!drawer || drawer.id !== socket.id) return;
    if (room.currentStroke.length > 0) {
      room.strokes.push(room.currentStroke);
      room.currentStroke = [];
    }
  });

  socket.on('undo', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'drawing') return;
    const drawer = room.players[room.currentDrawerIndex];
    if (!drawer || drawer.id !== socket.id) return;
    // Discard any in-progress stroke too
    room.currentStroke = [];
    if (room.strokes.length > 0) room.strokes.pop();
    room.drawHistory = room.strokes.flat();
    io.to(currentRoom).emit('redrawAll', { history: room.drawHistory });
  });

  socket.on('clearCanvas', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room) return;
    const drawer = room.players[room.currentDrawerIndex];
    if (!drawer || drawer.id !== socket.id) return;
    room.strokes = [];
    room.currentStroke = [];
    room.drawHistory = [];
    socket.to(currentRoom).emit('clearCanvas');
  });

  socket.on('guess', ({ text }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'drawing') return;
    const drawer = room.players[room.currentDrawerIndex];
    if (drawer && drawer.id === socket.id) return;
    if (room.guessedPlayers.has(socket.id)) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const guess = text.trim().toLowerCase();
    const answer = room.currentWord.toLowerCase();
    let isCorrect = false;
    let wasAutocorrected = false;
    let dist = Infinity;

    if (room.options.combinations && answer.includes('+')) {
      const aParts = answer.split('+').map(p => p.trim());
      const gParts = guess.split('+').map(p => p.trim());
      isCorrect = gParts.length === 2 && (
        (gParts[0] === aParts[0] && gParts[1] === aParts[1]) ||
        (gParts[0] === aParts[1] && gParts[1] === aParts[0])
      );
    } else {
      dist = levenshtein(guess, answer);
      isCorrect = guess === answer || (answer.length >= 4 && dist === 1);
      wasAutocorrected = isCorrect && guess !== answer;
    }

    if (isCorrect) {
      room.guessedPlayers.add(socket.id);
      const timeBonus = Math.floor((room.timeLeft / room.options.roundTime) * 500);
      const points = 100 + timeBonus;
      room.scores[socket.id] = (room.scores[socket.id] || 0) + points;

      if (drawer) {
        room.scores[drawer.id] = (room.scores[drawer.id] || 0) + 50;
      }

      io.to(currentRoom).emit('correctGuess', {
        playerId: socket.id,
        playerName: player.name,
        points,
        autocorrected: wasAutocorrected,
        scores: room.players.map(p => ({ id: p.id, name: p.name, score: room.scores[p.id] || 0 })),
      });

      const nonDrawers = room.players.filter(p => p.id !== drawer?.id);
      if (nonDrawers.every(p => room.guessedPlayers.has(p.id))) {
        clearRoomTimer(room);
        endDrawingRound(currentRoom);
      }
    } else {
      const isClose = dist <= 2 && guess.length > 2;
      io.to(currentRoom).emit('chat', {
        playerId: socket.id,
        playerName: player.name,
        text,
        isClose,
        isGuess: true,
      });
    }
  });

  socket.on('chat', ({ text }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    io.to(currentRoom).emit('chat', {
      playerId: socket.id,
      playerName: player.name,
      text,
      isGuess: false,
    });
  });

  socket.on('requestState', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room) return;
    socket.emit('stateUpdate', getRoomPublicState(room));
    if (room.drawHistory.length > 0) {
      socket.emit('drawHistory', { history: room.drawHistory });
    }
  });

  socket.on('kickPlayer', ({ playerId }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.host !== socket.id || room.state !== 'lobby') return;
    if (playerId === socket.id) return;
    const targetSocket = io.sockets.sockets.get(playerId);
    if (targetSocket) targetSocket.emit('kicked');
    removePlayer(currentRoom, playerId);
    if (rooms[currentRoom]) {
      io.to(currentRoom).emit('stateUpdate', getRoomPublicState(room));
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    const name = player?.name || 'A player';
    removePlayer(currentRoom, socket.id);
    if (rooms[currentRoom]) {
      io.to(currentRoom).emit('playerLeft', { playerName: name, state: getRoomPublicState(rooms[currentRoom]) });
      if (room.state === 'drawing' || room.state === 'choosing') {
        if (room.players.length < 2) {
          clearRoomTimer(room);
          room.state = 'lobby';
          io.to(currentRoom).emit('backToLobby', getRoomPublicState(room));
        }
      }
    }
  });
});

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎨 Mivimoose server running on http://localhost:${PORT}`));
