const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {}; // If you want rooms later, can extend this

// Utility: Roll dice
function rollDice(count) {
  return Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1);
}

let players = {};       // { socket.id: { name, dice: [] } }
let turnOrder = [];     // array of socket.ids
let currentTurnIndex = 0;
let currentBid = null;

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Join Game
  socket.on("joinGame", (name) => {
    if (!name) return;

    players[socket.id] = {
      name,
      dice: rollDice(5),
    };
    turnOrder.push(socket.id);

    io.emit("playerList", getPlayerStates());
  });

  // Start Game
  socket.on("startGame", () => {
    if (turnOrder.length < 2) return; // need at least 2 players

    currentTurnIndex = 0;
    currentBid = null;

    io.emit("roundStarted", {
      players: getPlayerStates(),
      currentTurn: turnOrder[currentTurnIndex],
    });

    sendDiceToPlayers();
  });

  // Place Bet
  socket.on("makeBet", ({ count, value }) => {
    if (!isMyTurn(socket.id)) return;

    if (currentBid) {
      // Simple bet validation: must be higher count, or same count with higher value
      if (
        count < currentBid.count ||
        (count === currentBid.count && value <= currentBid.value)
      ) {
        socket.emit("betRejected", "Bet must increase count or value.");
        return;
      }
    }

    currentBid = { count, value };
    io.emit("betMade", { player: players[socket.id].name, bet: currentBid });

    // Next turn
    currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length;
    io.emit("turnChanged", {
      currentTurn: turnOrder[currentTurnIndex],
    });
  });

  // Call Bluff
  socket.on("callBluff", () => {
    if (!isMyTurn(socket.id)) return;
    if (!currentBid) return;

    let actualCount = 0;
    for (const pid of turnOrder) {
      for (const d of players[pid].dice) {
        if (d === currentBid.value || d === 1) actualCount++;
      }
    }

    const lastBidderIndex =
      (currentTurnIndex - 1 + turnOrder.length) % turnOrder.length;
    const lastBidder = turnOrder[lastBidderIndex];
    const caller = socket.id;

    let loserId;
    if (actualCount >= currentBid.count) {
      // Bid was valid → caller loses
      loserId = caller;
    } else {
      // Bid was false → last bidder loses
      loserId = lastBidder;
    }

    players[loserId].dice.pop();

    io.emit("bluffResult", {
      bet: currentBid,
      totalCount: actualCount,
      loser: players[loserId].name,
    });

    // Check if loser is out
    if (players[loserId].dice.length === 0) {
      io.emit("playerOut", { name: players[loserId].name });
      turnOrder = turnOrder.filter((id) => id !== loserId);
      delete players[loserId];
    }

    // Game over check
    if (turnOrder.length === 1) {
      const winner = players[turnOrder[0]].name;
      io.emit("gameOver", { winner });
      resetGame();
      return;
    }

    // Next round
    currentBid = null;
    currentTurnIndex = turnOrder.indexOf(loserId); // loser starts next
    io.emit("roundStarted", {
      players: getPlayerStates(),
      currentTurn: turnOrder[currentTurnIndex],
    });

    // Reroll dice
    for (const pid of turnOrder) {
      players[pid].dice = rollDice(players[pid].dice.length);
    }
    sendDiceToPlayers();
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (players[socket.id]) {
      console.log("User disconnected:", players[socket.id].name);
      turnOrder = turnOrder.filter((id) => id !== socket.id);
      delete players[socket.id];

      io.emit("playerList", getPlayerStates());

      if (turnOrder.length === 1) {
        const winner = players[turnOrder[0]].name;
        io.emit("gameOver", { winner });
        resetGame();
      }
    }
  });
});

// Helpers
function getPlayerStates() {
  const out = {};
  for (const [id, p] of Object.entries(players)) {
    out[id] = {
      name: p.name,
      diceCount: p.dice.length,
      dice: p.dice, // only sent for self in sendDiceToPlayers
    };
  }
  return out;
}

function isMyTurn(id) {
  return turnOrder[currentTurnIndex] === id;
}

function sendDiceToPlayers() {
  for (const [id, p] of Object.entries(players)) {
    io.to(id).emit("roundStarted", {
      players: getPlayerStates(),
      currentTurn: turnOrder[currentTurnIndex],
    });
    io.to(id).emit("yourDice", p.dice);
  }
}

function resetGame() {
  players = {};
  turnOrder = [];
  currentTurnIndex = 0;
  currentBid = null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
