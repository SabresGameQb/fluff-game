const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");

app.use(express.static(path.join(__dirname, "../client")));

const defaultDiceCount = 5;
const rooms = {};

function rollDice(count) {
  const dice = [];
  for (let i = 0; i < count; i++) {
    dice.push(Math.floor(Math.random() * 6) + 1);
  }
  return dice;
}

function isSameBid(a, b) {
  return a.count === b.count && a.value === b.value;
}

function isValidBid(currentBid, newBid) {
  if (!currentBid) return true;

  const currentTotal = currentBid.count * currentBid.value;
  const newTotal = newBid.count * newBid.value;

  if (isSameBid(currentBid, newBid)) return false; // exact same bid not allowed

  if (newTotal > currentTotal) return true;

  if (newTotal === currentTotal) {
    // allow equal total if either count or value is different (already covered by isSameBid)
    return true;
  }

  return false;
}

function nextPlayer(room) {
  const game = rooms[room];
  if (!game) return null;

  if (game.players.length === 0) return null;

  game.turnIndex = (game.turnIndex + 1) % game.players.length;
  return game.players[game.turnIndex];
}

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("joinRoom", ({ roomId, name }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        turnIndex: 0,
        currentBid: null,
      };
    }
    const game = rooms[roomId];

    // Add player if not already in the room
    if (!game.players.find((p) => p.id === socket.id)) {
      const dice = rollDice(defaultDiceCount);
      game.players.push({
        id: socket.id,
        name: name || `Player${game.players.length + 1}`,
        diceCount: defaultDiceCount,
        dice,
      });
    }

    socket.join(roomId);

    // Send private dice to the player
    const player = game.players.find((p) => p.id === socket.id);
    socket.emit("yourDice", player.dice);

    // Broadcast updated players list
    io.to(roomId).emit(
      "updatePlayers",
      game.players.map((p) => ({ id: p.id, name: p.name, diceCount: p.diceCount }))
    );

    // Send current bid
    io.to(roomId).emit("updateBid", game.currentBid);

    // Announce whose turn it is
    const currentTurn = game.players[game.turnIndex];
    io.to(roomId).emit("turnUpdate", currentTurn ? currentTurn.id : null);
  });

  socket.on("placeBid", ({ roomId, count, value }) => {
    const game = rooms[roomId];
    if (!game) {
      socket.emit("errorMsg", "Game not found");
      return;
    }
    const playerIndex = game.players.findIndex((p) => p.id === socket.id);
    if (playerIndex !== game.turnIndex) {
      socket.emit("errorMsg", "Not your turn");
      return;
    }

    const newBid = { count, value };
    if (!isValidBid(game.currentBid, newBid)) {
      socket.emit("errorMsg", "Invalid bid according to Fluff rules");
      return;
    }

    game.currentBid = newBid;

    // Advance turn
    game.turnIndex = (game.turnIndex + 1) % game.players.length;

    // Notify all players about new bid and next turn
    io.to(roomId).emit("updateBid", game.currentBid);
    const nextPlayerId = game.players[game.turnIndex].id;
    io.to(roomId).emit("turnUpdate", nextPlayerId);
  });

  socket.on("callFluff", ({ roomId }) => {
    const game = rooms[roomId];
    if (!game) {
      socket.emit("errorMsg", "Game not found");
      return;
    }
    if (game.players[game.turnIndex].id !== socket.id) {
      socket.emit("errorMsg", "Not your turn to call Fluff");
      return;
    }
    if (!game.currentBid) {
      socket.emit("errorMsg", "No bid to call Fluff on");
      return;
    }

    const bid = game.currentBid;
    const totalBid = bid.count * bid.value;

    // Count total dice * face value across all players
    let actualTotal = 0;
    game.players.forEach((p) => {
      actualTotal += p.dice.reduce((acc, die) => acc + die, 0);
    });

    const resultText = actualTotal >= totalBid
      ? `Bid was correct! Total actual dice sum: ${actualTotal}.`
      : `Bid was wrong! Total actual dice sum: ${actualTotal}.`;

    // Reset bid and advance turn after call
    game.currentBid = null;
    game.turnIndex = (game.turnIndex + 1) % game.players.length;

    io.to(roomId).emit("fluffResult", {
      message: resultText,
      actualTotal,
      nextPlayerId: game.players[game.turnIndex].id,
    });

    io.to(roomId).emit("turnUpdate", game.players[game.turnIndex].id);
    io.to(roomId).emit("updateBid", null);
  });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const game = rooms[roomId];
      const index = game.players.findIndex((p) => p.id === socket.id);
      if (index !== -1) {
        game.players.splice(index, 1);
        // Adjust turn index if needed
        if (game.turnIndex >= game.players.length) {
          game.turnIndex = 0;
        }
        io.to(roomId).emit(
          "updatePlayers",
          game.players.map((p) => ({ id: p.id, name: p.name, diceCount: p.diceCount }))
        );
        io.to(roomId).emit("turnUpdate", game.players[game.turnIndex]?.id || null);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
