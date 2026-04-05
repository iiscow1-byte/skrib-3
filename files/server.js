const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const WORDS = [
  'apple','banana','guitar','elephant','rainbow','bicycle','castle','dragon',
  'umbrella','volcano','lighthouse','pineapple','astronaut','butterfly','cactus',
  'diamond','eagle','flamingo','giraffe','hamster','igloo','jellyfish','kangaroo',
  'lantern','mushroom','ninja','octopus','penguin','quicksand','raccoon','sunset',
  'tornado','unicorn','violin','waterfall','xylophone','yoga','zebra','airplane',
  'balloon','camera','dolphin','eiffel','forest','galaxy','helicopter','island',
  'jungle','kitten','lemon','mermaid','noodles','orange','parrot','robot',
  'sandwich','trophy','ukulele','vampire','wizard','yacht','zombie','anchor',
  'bridge','cloud','desert','engine','feather','ghost','haunted','ink','jewel',
  'knight','ladder','magnet','nurse','orbit','palace','queen','river','snow',
  'telescope','universe','vortex','whale','xray','yoyo','zipper'
];

const ROUND_TIME = 80;
const ROUNDS_PER_GAME = 3;
const MAX_PLAYERS = 8;
const WORD_CHOICES = 3;

const rooms = {};

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function getRandomWords(count) {
  const shuffled = [...WORDS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function maskWord(word) {
  return word.split('').map(c => c === ' ' ? ' ' : '_').join('');
}

function hintWord(word, revealCount) {
  const chars = word.split('');
  const indices = chars.map((c, i) => c !== ' ' ? i : -1).filter(i => i !== -1);
  const toReveal = indices.slice(0, revealCount);
  return chars.map((c, i) => {
    if (c === ' ') return ' ';
    if (toReveal.includes(i)) return c;
    return '_';
  }).join('');
}

function createRoom(hostId, hostName) {
  const roomId = generateRoomId();
  rooms[roomId] = {
    id: roomId,
    players: [],
    host: hostId,
    state: 'lobby', // lobby | choosing | drawing | roundEnd | gameEnd
    round: 0,
    currentDrawerIndex: 0,
    currentWord: null,
    wordChoices: [],
    timer: null,
    timeLeft: 0,
    drawHistory: [],
    scores: {},
    guessedPlayers: new Set(),
    hintsGiven: 0,
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
    wordLength: room.currentWord ? room.currentWord.length : 0,
    wordSpaces: room.currentWord ? maskWord(room.currentWord) : null,
  };
}

function startRound(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  clearRoomTimer(room);

  room.drawHistory = [];
  room.guessedPlayers = new Set();
  room.hintsGiven = 0;
  room.currentWord = null;

  // Pick drawer
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

  room.wordChoices = getRandomWords(WORD_CHOICES);
  room.state = 'choosing';
  room.timeLeft = 15;

  io.to(roomId).emit('roundStart', {
    ...getRoomPublicState(room),
    drawerId: drawer.id,
    drawerName: drawer.name,
  });

  // Send word choices only to drawer
  io.to(drawer.id).emit('wordChoices', { words: room.wordChoices });

  // Auto-pick if drawer doesn't choose
  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(roomId).emit('timerTick', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      clearRoomTimer(room);
      if (room.state === 'choosing') {
        const autoWord = room.wordChoices[0];
        wordChosen(roomId, autoWord);
      }
    }
  }, 1000);
}

function wordChosen(roomId, word) {
  const room = getRoom(roomId);
  if (!room) return;
  clearRoomTimer(room);

  room.currentWord = word;
  room.state = 'drawing';
  room.timeLeft = ROUND_TIME;
  room.drawHistory = [];

  const drawer = room.players[room.currentDrawerIndex];
  const masked = maskWord(word);

  io.to(roomId).emit('drawingStart', {
    ...getRoomPublicState(room),
    maskedWord: masked,
    drawerId: drawer.id,
    drawerName: drawer.name,
  });

  // Drawer gets the actual word
  io.to(drawer.id).emit('yourWord', { word });

  room.timer = setInterval(() => {
    room.timeLeft--;

    // Give hints at 2/3 and 1/3 time
    const hintAt2 = Math.floor(ROUND_TIME * 2 / 3);
    const hintAt1 = Math.floor(ROUND_TIME * 1 / 3);
    const wordChars = word.replace(/ /g, '').length;
    const maxHints = Math.max(1, Math.floor(wordChars / 3));

    if (room.timeLeft === hintAt2 && room.hintsGiven < maxHints) {
      room.hintsGiven = 1;
      const hint = hintWord(word, 1);
      io.to(roomId).emit('hint', { hint });
    } else if (room.timeLeft === hintAt1 && room.hintsGiven < maxHints) {
      room.hintsGiven = 2;
      const hint = hintWord(word, 2);
      io.to(roomId).emit('hint', { hint });
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
  }, 5000);
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

  // Reset for new game
  setTimeout(() => {
    if (rooms[roomId]) {
      room.state = 'lobby';
      room.round = 0;
      room.currentDrawerIndex = 0;
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
    room.players.forEach(p => { room.scores[p.id] = 0; });
    startRound(currentRoom);
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
    room.drawHistory.push(data);
    socket.to(currentRoom).emit('draw', data);
  });

  socket.on('clearCanvas', () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room) return;
    const drawer = room.players[room.currentDrawerIndex];
    if (!drawer || drawer.id !== socket.id) return;
    room.drawHistory = [];
    socket.to(currentRoom).emit('clearCanvas');
  });

  socket.on('guess', ({ text }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'drawing') return;
    const drawer = room.players[room.currentDrawerIndex];
    if (drawer && drawer.id === socket.id) return; // Drawer can't guess
    if (room.guessedPlayers.has(socket.id)) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const guess = text.trim().toLowerCase();
    const answer = room.currentWord.toLowerCase();

    if (guess === answer) {
      room.guessedPlayers.add(socket.id);
      const timeBonus = Math.floor((room.timeLeft / ROUND_TIME) * 500);
      const points = 100 + timeBonus;
      room.scores[socket.id] = (room.scores[socket.id] || 0) + points;

      // Drawer gets points too
      if (drawer) {
        room.scores[drawer.id] = (room.scores[drawer.id] || 0) + 50;
      }

      io.to(currentRoom).emit('correctGuess', {
        playerId: socket.id,
        playerName: player.name,
        points,
        scores: room.players.map(p => ({ id: p.id, name: p.name, score: room.scores[p.id] || 0 })),
      });

      // All non-drawers guessed?
      const nonDrawers = room.players.filter(p => p.id !== drawer?.id);
      if (nonDrawers.every(p => room.guessedPlayers.has(p.id))) {
        clearRoomTimer(room);
        endDrawingRound(currentRoom);
      }
    } else {
      // Close guess hint
      const isClose = levenshtein(guess, answer) <= 2 && guess.length > 2;
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
    // Send draw history to catch up
    if (room.drawHistory.length > 0) {
      socket.emit('drawHistory', { history: room.drawHistory });
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
      // If current drawer left mid-draw, advance
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
