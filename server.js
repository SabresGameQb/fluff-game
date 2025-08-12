const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};

// Utility: Roll dice
function rollDice(count) {
  return Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1);
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinRoom", ({ roomId, name }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { players: [], bids: [], turnIndex: 0 };
    }

    rooms[roomId].players.push({
      id: socket.id,
      name,
      dice: rollDice(5),
    });

    socket.join(roomId);

    // Send dice to player
    io.to(socket.id).emit("yourDice", rooms[roomId].players.find(p => p.id === socket.id).dice);

    // Broadcast updated players + dice count
    io.to(roomId).emit(
      "updatePlayers",
      rooms[roomId].players.map(p => ({
        id: p.id,
        name: p.name,
        diceCount: p.dice.length,
      }))
    );

    // Send current bid and current turn
    const room = rooms[roomId];
    io.to(roomId).emit("updateBid", room.bids.length > 0 ? room.bids[room.bids.length - 1] : null);
    io.to(roomId).emit("currentTurn", room.players[room.turnIndex].id);
  });

  socket.on("placeBid", ({ roomId, count, value }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Check if exact same bid already made this round
    const duplicateBid = room.bids.find(bid => bid.count === count && bid.value === value);
    if (duplicateBid) {
      io.to(socket.id).emit("invalidBid", "This exact bid has already been made this round.");
      return;
    }

    const lastBid = room.bids.length > 0 ? room.bids[room.bids.length - 1] : null;

    if (lastBid) {
      const lastTotal = lastBid.count * lastBid.value;
      const currentTotal = count * value;

      if (currentTotal < lastTotal) {
        io.to(socket.id).emit("invalidBid", `Your bid total (${currentTotal}) must be at least as high as the previous bid total (${lastTotal}).`);
        return;
      }
    }

    room.bids.push({ count, value });

    // Advance turn
    room.turnIndex = (room.turnIndex + 1) % room.players.length;

    io.to(roomId).emit("updateBid", { count, value });

    io.to(roomId).emit(
      "updatePlayers",
      room.players.map(p => ({
        id: p.id,
        name: p.name,
        diceCount: p.dice.length,
      }))
    );

    io.to(roomId).emit("currentTurn", room.players[room.turnIndex].id);
  });

  socket.on("callFluff", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const lastBid = room.bids.length > 0 ? room.bids[room.bids.length - 1] : null;
    if (!lastBid) return;

    // Count dice that match lastBid.value or wilds (1's 🐍 count as wildcards)
    let actualCount = 0;
    room.players.forEach(player => {
      player.dice.forEach(die => {
        if (die === lastBid.value || die === 1) {
          actualCount++;
        }
      });
    });

    const caller = room.players.find(p => p.id === socket.id);

    // Player who made the last bid is previous player (turnIndex points to next player)
    const lastBidderIndex = (room.turnIndex - 1 + room.players.length) % room.players.length;
    const lastBidder = room.players[lastBidderIndex];

    // Determine loser correctly:
    // If actualCount >= lastBid.count -> last bid was correct -> caller loses (wrong call)
    // Else last bidder loses (bid was wrong)
    let loser;
    let resultText;
    if (actualCount >= lastBid.count) {
      loser = caller;
      resultText = `${caller.name} called Fluff wrongly and loses a die.`;
    } else {
      loser = lastBidder;
      resultText = `${caller.name} called Fluff correctly! ${lastBidder.name} loses a die.`;
    }

    // Remove one die from loser
    loser.dice.pop();

    // Check if game over (no dice left)
    if (loser.dice.length === 0) {
      // Find the winner (last player with dice left)
      const winner = room.players.find(p => p.dice.length > 0)?.name || "Unknown";
      io.to(roomId).emit("gameOver", { winner });

      // Reset game state for this room
      delete rooms[roomId];
      return;
    }

    // Reset bids for new round
    room.bids = [];

    // Reset turnIndex to loser’s next player (so game continues from correct player)
    room.turnIndex = room.players.indexOf(loser);
    room.turnIndex = (room.turnIndex + 1) % room.players.length;

    // Reroll dice for each player, keeping dice count same
    room.players.forEach(p => {
      p.dice = rollDice(p.dice.length);
    });

    // IMPORTANT: Send each player's new dice to them individually, so they update their dice display!
    room.players.forEach(p => {
      io.to(p.id).emit("yourDice", p.dice);
    });

    io.to(roomId).emit("result", { actualCount, lastBid, resultText, loserName: loser.name });

    io.to(roomId).emit(
      "updatePlayers",
      room.players.map(p => ({
        id: p.id,
        name: p.name,
        diceCount: p.dice.length,
      }))
    );

    io.to(roomId).emit("updateBid", null);
    io.to(roomId).emit("currentTurn", room.players[room.turnIndex].id);
  });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
      io.to(roomId).emit(
        "updatePlayers",
        rooms[roomId].players.map(p => ({
          id: p.id,
          name: p.name,
          diceCount: p.dice.length,
        }))
      );
    }
    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
