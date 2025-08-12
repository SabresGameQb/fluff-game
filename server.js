const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};

// Roll dice utility
function rollDice(count) {
  return Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1);
}

// Helper: Get next active player index
function nextActiveIndex(room, currentIndex) {
  const players = rooms[room].players;
  if (players.length === 0) return -1;

  let nextIndex = currentIndex;
  do {
    nextIndex = (nextIndex + 1) % players.length;
  } while (players[nextIndex].dice.length === 0 && nextIndex !== currentIndex);

  return nextIndex;
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinRoom", ({ roomId, name }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        bids: [],
        turnIndex: 0,
      };
    }

    const room = rooms[roomId];

    // Add player with 5 dice
    room.players.push({
      id: socket.id,
      name,
      dice: rollDice(5),
    });

    socket.join(roomId);

    // Send private dice to player
    io.to(socket.id).emit("yourDice", room.players.find((p) => p.id === socket.id).dice);

    // Broadcast player list and bids and current turn
    io.to(roomId).emit("updatePlayers", room.players.map(p => ({ id: p.id, name: p.name, diceCount: p.dice.length })));
    io.to(roomId).emit("updateBid", room.bids.length ? room.bids[room.bids.length -1] : null);
    io.to(roomId).emit("currentTurn", room.players[room.turnIndex]?.id || null);
  });

  socket.on("placeBid", ({ roomId, count, value }) => {
    const room = rooms[roomId];
    if (!room) return;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.turnIndex) {
      io.to(socket.id).emit("invalidBid", "It's not your turn.");
      return;
    }

    // Fluff rule validation:
    // No exact duplicates allowed
    // New bid total (count * value) must be > previous bid total
    // or if equal total, count or value must differ (strictly higher)
    const lastBid = room.bids.length ? room.bids[room.bids.length - 1] : null;
    const newTotal = count * value;

    if (lastBid) {
      const lastTotal = lastBid.count * lastBid.value;

      if (newTotal < lastTotal) {
        io.to(socket.id).emit("invalidBid", "Bid total must be higher than previous bid total.");
        return;
      }
      if (newTotal === lastTotal && count === lastBid.count && value === lastBid.value) {
        io.to(socket.id).emit("invalidBid", "Bid must not be the exact same as previous bid.");
        return;
      }
    }

    room.bids.push({ count, value, playerId: socket.id });

    // Advance turn skipping eliminated players
    room.turnIndex = nextActiveIndex(roomId, room.turnIndex);

    io.to(roomId).emit("updateBid", room.bids[room.bids.length -1]);
    io.to(roomId).emit("updatePlayers", room.players.map(p => ({ id: p.id, name: p.name, diceCount: p.dice.length })));
    io.to(roomId).emit("currentTurn", room.players[room.turnIndex]?.id || null);
  });

  socket.on("callFluff", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const callerIndex = room.players.findIndex(p => p.id === socket.id);
    if (callerIndex !== room.turnIndex) {
      io.to(socket.id).emit("invalidCall", "You can only call Fluff on your turn.");
      return;
    }

    const lastBid = room.bids.length ? room.bids[room.bids.length -1] : null;
    if (!lastBid) {
      io.to(socket.id).emit("invalidCall", "No bid to call Fluff on.");
      return;
    }

    // Count actual dice matching bid.value or wild (1)
    let actualCount = 0;
    room.players.forEach(p => {
      p.dice.forEach(die => {
        if (die === lastBid.value || die === 1) actualCount++;
      });
    });

    const bidderIndex = room.players.findIndex(p => p.id === lastBid.playerId);
    const caller = room.players[callerIndex];
    const bidder = room.players[bidderIndex];

    let loserIndex;
    let resultText;

    if (actualCount >= lastBid.count) {
      // Bidder was correct -> caller loses one die
      loserIndex = callerIndex;
      resultText = `${bidder.name}'s bid was correct! ${caller.name} loses one die.`;
    } else {
      // Bidder was wrong -> bidder loses one die
      loserIndex = bidderIndex;
      resultText = `${bidder.name}'s bid was incorrect! ${bidder.name} loses one die.`;
    }

    // Remove one die from loser
    if (loserIndex >= 0) {
      const loser = room.players[loserIndex];
      loser.dice.pop(); // remove one die
    }

    // Remove players with no dice
    room.players = room.players.filter(p => p.dice.length > 0);

    // Reset bids for next round
    room.bids = [];

    // Reset turn index if current turn player eliminated
    if (!room.players[room.turnIndex]) {
      room.turnIndex = 0;
    } else {
      // Move to next active player after loser
      room.turnIndex = nextActiveIndex(roomId, loserIndex);
    }

    // Re-roll dice for all alive players
    room.players.forEach(p => {
      p.dice = rollDice(p.dice.length);
      io.to(p.id).emit("yourDice", p.dice);
    });

    io.to(roomId).emit("updatePlayers", room.players.map(p => ({ id: p.id, name: p.name, diceCount: p.dice.length })));
    io.to(roomId).emit("updateBid", null);
    io.to(roomId).emit("currentTurn", room.players[room.turnIndex]?.id || null);
    io.to(roomId).emit("result", {
      actualCount,
      lastBid,
      resultText,
      loserName: room.players[loserIndex]?.name || "Player",
    });

    // Check for winner
    if (room.players.length === 1) {
      io.to(roomId).emit("gameOver", { winner: room.players[0].name });
      delete rooms[roomId];
    }
  });

  socket.on("disconnect", () => {
    // Remove player from all rooms
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        const leavingPlayer = room.players.splice(playerIndex, 1)[0];
        io.to(roomId).emit("updatePlayers", room.players.map(p => ({ id: p.id, name: p.name, diceCount: p.dice.length })));

        // Adjust turnIndex if necessary
        if (playerIndex < room.turnIndex) {
          room.turnIndex--;
        } else if (playerIndex === room.turnIndex) {
          room.turnIndex = room.players.length ? room.turnIndex % room.players.length : 0;
          io.to(roomId).emit("currentTurn", room.players[room.turnIndex]?.id || null);
        }

        // Clean up empty rooms
        if (room.players.length === 0) {
          delete rooms[roomId];
        }
      }
    }
    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
