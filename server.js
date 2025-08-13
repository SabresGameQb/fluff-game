const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};
const socketToRoom = {}; // track which room a socket is in

// Utility: Roll dice
function rollDice(count) {
  return Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1);
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Client asks to refresh the players list after receiving currentTurn
  socket.on("requestPlayers", () => {
    const roomId = socketToRoom[socket.id];
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;

    // Send ONLY to the requester to refresh their list highlighting
    io.to(socket.id).emit(
      "updatePlayers",
      room.players.map((p) => ({
        id: p.id,
        name: p.name,
        diceCount: p.dice.length,
      }))
    );
  });

  socket.on("joinRoom", ({ roomId, name }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { players: [], bids: [], turnIndex: 0 };
    }

    rooms[roomId].players.push({
      id: socket.id,
      name,
      dice: rollDice(5),
    });
    socketToRoom[socket.id] = roomId;

    socket.join(roomId);

    // Send dice to joining player
    io.to(socket.id).emit(
      "yourDice",
      rooms[roomId].players.find((p) => p.id === socket.id).dice
    );

    const room = rooms[roomId];

    // Emit current turn FIRST, then players, then current bid
    io.to(roomId).emit("currentTurn", room.players[room.turnIndex].id);

    io.to(roomId).emit(
      "updatePlayers",
      room.players.map((p) => ({
        id: p.id,
        name: p.name,
        diceCount: p.dice.length,
      }))
    );

    io.to(roomId).emit(
      "updateBid",
      room.bids.length > 0 ? room.bids[room.bids.length - 1] : null
    );
  });

  socket.on("placeBid", ({ roomId, count, value }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Disallow exact duplicate bids within the round
    const duplicateBid = room.bids.find(
      (bid) => bid.count === count && bid.value === value
    );
    if (duplicateBid) {
      io.to(socket.id).emit(
        "invalidBid",
        "This exact bid has already been made this round."
      );
      return;
    }

    const lastBid =
      room.bids.length > 0 ? room.bids[room.bids.length - 1] : null;

    // Fluff rule: totals compare by multiplication (count * value)
    if (lastBid) {
      const lastTotal = lastBid.count * lastBid.value;
      const currentTotal = count * value;

      if (currentTotal < lastTotal) {
        io.to(socket.id).emit(
          "invalidBid",
          `Your bid total (${currentTotal}) must be at least as high as the previous bid total (${lastTotal}).`
        );
        return;
      }
    }

    room.bids.push({ count, value });

    // Advance turn to next player
    room.turnIndex = (room.turnIndex + 1) % room.players.length;

    // Emit current turn FIRST, then players, then bid
    io.to(roomId).emit("currentTurn", room.players[room.turnIndex].id);

    io.to(roomId).emit(
      "updatePlayers",
      room.players.map((p) => ({
        id: p.id,
        name: p.name,
        diceCount: p.dice.length,
      }))
    );

    io.to(roomId).emit("updateBid", { count, value });
  });

  socket.on("callFluff", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const lastBid =
      room.bids.length > 0 ? room.bids[room.bids.length - 1] : null;
    if (!lastBid) return;

    // Count dice that match lastBid.value or wilds (1's are 🐍 wildcards)
    let actualCount = 0;
    room.players.forEach((player) => {
      player.dice.forEach((die) => {
        if (die === lastBid.value || die === 1) {
          actualCount++;
        }
      });
    });

    const caller = room.players.find((p) => p.id === socket.id);
    const lastBidderIndex =
      (room.turnIndex - 1 + room.players.length) % room.players.length;
    const lastBidder = room.players[lastBidderIndex];

    let loser;
    let resultText;
    if (actualCount >= lastBid.count) {
      // Bid was correct -> caller loses
      loser = caller;
      resultText = `${caller.name} called Fluff wrongly and loses a die.`;
    } else {
      // Bid was wrong -> last bidder loses
      loser = lastBidder;
      resultText = `${caller.name} called Fluff correctly! ${lastBidder.name} loses a die.`;
    }

    // Remove one die from loser
    loser.dice.pop();

    // Check for game over
    if (loser.dice.length === 0) {
      const winner =
        room.players.find((p) => p.dice.length > 0)?.name || "Unknown";
      io.to(roomId).emit("gameOver", { winner });
      // Clean up this room
      delete rooms[roomId];
      return;
    }

    // Reset bids for new round
    room.bids = [];

    // Loser starts the next round
    room.turnIndex = room.players.indexOf(loser);

    // Reroll all players' dice (preserve counts)
    room.players.forEach((p) => {
      p.dice = rollDice(p.dice.length);
    });

    // Send each player their new dice
    room.players.forEach((p) => {
      io.to(p.id).emit("yourDice", p.dice);
    });

    // Announce result of the call
    io.to(roomId).emit("result", {
      actualCount,
      lastBid,
      resultText,
      loserName: loser.name,
    });

    // Emit current turn FIRST, then players, then clear bid
    io.to(roomId).emit("currentTurn", room.players[room.turnIndex].id);

    io.to(roomId).emit(
      "updatePlayers",
      room.players.map((p) => ({
        id: p.id,
        name: p.name,
        diceCount: p.dice.length,
      }))
    );

    io.to(roomId).emit("updateBid", null);
  });

  socket.on("disconnect", () => {
    const roomId = socketToRoom[socket.id];
    delete socketToRoom[socket.id];

    if (!roomId || !rooms[roomId]) {
      console.log("User disconnected:", socket.id);
      return;
    }

    const room = rooms[roomId];
    const idx = room.players.findIndex((p) => p.id === socket.id);
    if (idx === -1) {
      console.log("User disconnected:", socket.id);
      return;
    }

    // Remove the player
    room.players.splice(idx, 1);

    // If room empty, remove it
    if (room.players.length === 0) {
      delete rooms[roomId];
      console.log("User disconnected, room removed:", socket.id);
      return;
    }

    // Keep turnIndex valid and sensible
    // If the removed player was before the current index, shift left by one
    if (idx < room.turnIndex) {
      room.turnIndex = room.turnIndex - 1;
    }
    // Clamp into range
    room.turnIndex = room.turnIndex % room.players.length;

    // Emit current turn FIRST, then players (bid unchanged)
    io.to(roomId).emit("currentTurn", room.players[room.turnIndex].id);

    io.to(roomId).emit(
      "updatePlayers",
      room.players.map((p) => ({
        id: p.id,
        name: p.name,
        diceCount: p.dice.length,
      }))
    );

    console.log("User disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
