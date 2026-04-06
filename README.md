# 🎨 Mivimoose — Multiplayer Drawing Game

A full-featured multiplayer drawing & guessing game built with **Node.js + Socket.io** and Claude. This is fully vibecoded so don't @ me

## Features
- 🎨 Real-time drawing canvas synced across all players
- 🔤 Word selection (choose from 3 options), hints, & 80s timer
- 💬 Chat & guess box with "close guess" detection
- 🏆 Live scoreboard with round bonuses
- 👑 Host controls & up to 8 players per room
- 🔄 Auto-advances through rounds, returns to lobby after game ends

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
node server.js
```
Or for auto-reload during development:
```bash
npx nodemon server.js
```

### 3. Open in browser
```
http://localhost:3000
```

---

## How to Play

1. **Create a Room** — Enter your name and click "Create Room"
2. **Share the code** — Share the 6-letter room code with friends
3. **Friends join** — They enter the code on the home screen
4. **Host starts the game** — Host clicks "Start Game" (need ≥ 2 players)
5. **Take turns drawing** — Each player draws while others guess
6. **Score points** — Faster correct guesses = more points. Drawer earns points too!
7. **Win!** — After all rounds, the player with the most points wins

---

## Game Rules
- **80 seconds** per drawing round
- **3 rounds** per game (each player draws once per round)
- Word chooser gets **3 word options** and 15 seconds to pick
- **2 hints** are revealed automatically at 2/3 and 1/3 time remaining
- Close guesses are flagged but not counted as correct
- Drawer cannot guess

---

## Project Structure
```
mivimoose/
├── server.js          # Node.js + Socket.io game server
├── package.json
└── public/
    └── index.html     # Full client-side game (single file)
```
