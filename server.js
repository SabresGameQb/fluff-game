const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

let players = {};
let turnOrder = [];
let currentTurnIndex = 0;
let currentBet = null;
let playedBets = new Set();
let gameInProgress = false;

function rollDice(num) {
  let dice = [];
  for (let i = 0; i < num; i++) {
    let roll = Math.floor(Math.random() * 6) + 1;
    dice.push(roll === 1 ? "🐍" : roll);
  }
  return dice;
}

function startRound() {
  currentBet = null;
  playedBets = new Set();
  turnOrder = Object.keys(players).filter(id => players[id].diceCount > 0);

  turnOrder.forEach(id => {
    players[id].dice = rollDice(players[id].diceCount);
  });

  currentTurnIndex = 0;
  io.emit("roundStarted", {
    players,
    currentTurn: turnOrder[currentTurnIndex]
  });
}

function nextTurn() {
  currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length;
  io.emit("turnChanged", { currentTurn: turnOrder[currentTurnIndex] });
}

function checkWinner() {
  let remaining = Object.keys(players).filter(id => players[id].diceCount > 0);
  if (remaining.length === 1) {
    gameInProgress = false;
    io.emit("gameOver", { winner: players[remaining[0]].name });
    return true;
  }
  return false;
}

io.on("connection", (socket) => {
  socket.on("joinGame", (name) => {
    if (!players[socket.id]) {
      players[socket.id] = { name, diceCount: 5, dice: [] };
    }
    io.emit("playerList", players);
  });

  socket.on("startGame", () => {
    if (!gameInProgress && Object.keys(players).length > 1) {
      gameInProgress = true;
      startRound();
    }
  });

  socket.on("makeBet", (bet) => {
    let betKey = `${bet.count}-${bet.value}`;
    if (playedBets.has(betKey)) {
      socket.emit("betRejected", "That bet has already been played this round.");
      return;
    }
    playedBets.add(betKey);
    currentBet = bet;
    io.emit("betMade", { bet, player: players[socket.id].name });
    nextTurn();
  });

  socket.on("callBluff", () => {
    if (!currentBet) return;

    let totalCount = 0;
    Object.values(players).forEach(p => {
      p.dice.forEach(d => {
        if (d === currentBet.value || d === "🐍") {
          totalCount++;
        }
      });
    });

    let loserId;
    if (totalCount >= currentBet.count) {
      // Bluff caller loses
      loserId = socket.id;
    } else {
      // Better loses
      let currentPlayerIndex = (currentTurnIndex - 1 + turnOrder.length) % turnOrder.length;
      loserId = turnOrder[currentPlayerIndex];
    }

    players[loserId].diceCount--;

    io.emit("bluffResult", {
      bet: currentBet,
      totalCount,
      loser: players[loserId].name
    });

    if (players[loserId].diceCount <= 0) {
      io.emit("playerOut", { name: players[loserId].name });
    }

    if (!checkWinner()) {
      startRound();
    }
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("playerList", players);

    if (gameInProgress && checkWinner()) {
      gameInProgress = false;
    }
  });
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
