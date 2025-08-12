const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || null;

app.use(express.static('public'));
app.use(express.json());

/* In-memory games structure:
games = {
  gameId: {
    id,
    hostSocketId,
    players: { socketId: {name, diceCount, dice: [] , alive:true } },
    order: [socketId,...],
    turnIndex: 0,
    currentBid: {qty, face, bySocketId} or null,
    started: false,
    defaultDice: 5
  }
}
*/
const games = {};

app.post('/create', (req, res) => {
  const gameId = uuidv4().slice(0,8);
  const defaultDice = req.body.defaultDice || 5;
  games[gameId] = {
    id: gameId,
    hostSocketId: null,
    players: {},
    order: [],
    turnIndex: 0,
    currentBid: null,
    started: false,
    defaultDice
  };

  const link = `${req.protocol}://${req.get('host')}/?game=${gameId}`;
  // optional Discord webhook post
  if (DISCORD_WEBHOOK) {
    axios.post(DISCORD_WEBHOOK, {
      content: `New Fluff (Liar's Dice) game created! Join: ${link}`
    }).catch(err => console.warn('discord webhook failed', err.message));
  }

  res.json({ gameId, link });
});

io.on('connection', socket => {
  console.log('socket connected', socket.id);

  socket.on('joinGame', ({ gameId, name }, cb) => {
    const game = games[gameId];
    if (!game) return cb({ error: 'Game not found' });

    // first joiner becomes host if no host
    if (!game.hostSocketId) game.hostSocketId = socket.id;

    game.players[socket.id] = {
      name: name || 'Player',
      diceCount: game.defaultDice,
      dice: [],
      alive: true
    };
    game.order.push(socket.id);
    socket.join(gameId);

    // notify lobby
    io.to(gameId).emit('lobbyUpdate', {
      players: Object.entries(game.players).map(([id, p]) => ({ id, name: p.name, diceCount: p.diceCount })),
      host: game.hostSocketId
    });
    cb({ ok: true, host: game.hostSocketId === socket.id });
  });

  socket.on('startGame', ({ gameId }, cb) => {
    const game = games[gameId];
    if (!game) return cb({ error: 'Game not found' });
    if (socket.id !== game.hostSocketId) return cb({ error: 'Only host can start' });
    if (game.started) return cb({ error: 'Already started' });

    game.started = true;
    // deal dice to each player (roll)
    for (const [id, p] of Object.entries(game.players)) {
      p.dice = rollDice(p.diceCount);
      io.to(id).emit('privateDice', p.dice); // private to the player socket
    }
    game.currentBid = null;
    game.turnIndex = 0;
    io.to(gameId).emit('gameStarted', {
      order: game.order.map(id => ({ id, name: game.players[id].name })),
      currentTurn: game.order[game.turnIndex]
    });
    cb({ ok: true });
  });

  socket.on('bid', ({ gameId, qty, face }, cb) => {
    const game = games[gameId];
    if (!game || !game.started) return cb({ error: 'Game not running' });
    const currentPlayerId = game.order[game.turnIndex];
    if (socket.id !== currentPlayerId) return cb({ error: "Not your turn" });

    qty = parseInt(qty);
    face = parseInt(face);
    if (!Number.isInteger(qty) || !Number.isInteger(face) || face < 1 || face > 6 || qty < 1) {
      return cb({ error: 'Invalid bid' });
    }

    // Validate bid higher than previous: either qty higher or same qty but face higher
    const prev = game.currentBid;
    if (prev) {
      if (qty < prev.qty || (qty === prev.qty && face <= prev.face)) {
        return cb({ error: 'Bid must be higher than previous bid' });
      }
    }

    game.currentBid = { qty, face, bySocketId: socket.id };
    // advance turn
    game.turnIndex = nextAliveIndex(game, game.turnIndex);
    io.to(gameId).emit('newBid', {
      qty, face, by: { id: socket.id, name: game.players[socket.id].name },
      nextTurn: game.order[game.turnIndex]
    });
    cb({ ok: true });
  });

  socket.on('call', ({ gameId }, cb) => {
    const game = games[gameId];
    if (!game || !game.started) return cb({ error: 'Game not running' });
    if (!game.currentBid) return cb({ error: 'No bid to call' });

    // When someone calls, we reveal all dice and resolve
    const total = countDiceAcrossGame(game);
    const bidQty = game.currentBid.qty;
    const bidFace = game.currentBid.face;

    const matchingCount = total.actualCountForFace(bidFace); // includes wild 1s
    const callerId = socket.id;
    const bidderId = game.currentBid.bySocketId;

    // Determine loser: if matchingCount >= bidQty -> caller loses a die; else bidder loses a die
    let loserId;
    let resultText;
    if (matchingCount >= bidQty) {
      loserId = callerId;
      resultText = `${game.players[bidderId].name}'s bid was correct (${matchingCount} >= ${bidQty}). ${game.players[callerId].name} loses a die.`;
    } else {
      loserId = bidderId;
      resultText = `${game.players[bidderId].name}'s bid failed (${matchingCount} < ${bidQty}). ${game.players[bidderId].name} loses a die.`;
    }

    // decrement loser dice count
    game.players[loserId].diceCount = Math.max(0, game.players[loserId].diceCount - 1);
    if (game.players[loserId].diceCount === 0) {
      game.players[loserId].alive = false;
      // remove from order
      game.order = game.order.filter(id => id !== loserId);
    }

    // Reveal all dice to everyone
    const reveal = {};
    for (const [id, p] of Object.entries(game.players)) {
      reveal[id] = p.dice;
    }

    // reset dice for next round (roll for alive players)
    for (const [id, p] of Object.entries(game.players)) {
      if (p.alive) {
        p.dice = rollDice(p.diceCount);
        io.to(id).emit('privateDice', p.dice);
      } else {
        p.dice = [];
      }
    }

    // Check win condition
    let winner = null;
    const alivePlayers = Object.values(game.players).filter(p => p.alive);
    if (alivePlayers.length === 1) {
      // find the winner id
      for (const [id, p] of Object.entries(game.players)) {
        if (p.alive) { winner = { id, name: p.name }; break; }
      }
    }

    // set next turn index: find the index of the player after the loser (or bidder if loser removed)
    let nextIndex = 0;
    if (game.order.length > 0) {
      // if the loser was removed, next turn is the player after the loser in the new order; otherwise after loser
      const idxOfLastBidder = game.order.indexOf(bidderId);
      // ensure it's valid
      nextIndex = (idxOfLastBidder === -1) ? 0 : ( (idxOfLastBidder + 1) % game.order.length );
      game.turnIndex = nextIndex;
    } else {
      game.turnIndex = 0;
    }

    // clear current bid
    game.currentBid = null;

    io.to(gameId).emit('roundResult', {
      reveal,
      matchingCount,
      bidQty,
      bidFace,
      loserId,
      loserName: game.players[loserId].name,
      resultText,
      players: Object.entries(game.players).map(([id, p]) => ({ id, name: p.name, diceCount: p.diceCount, alive: p.alive })),
      nextTurn: winner ? null : (game.order[game.turnIndex] || null),
      winner
    });

    cb({ ok: true });
  });

  socket.on('disconnecting', () => {
    // remove player from all games they're in
    for (const gameId of socket.rooms) {
      if (!games[gameId]) continue;
      const game = games[gameId];
      if (game.players[socket.id]) {
        delete game.players[socket.id];
        game.order = game.order.filter(id => id !== socket.id);
        // if host left, assign new host
        if (game.hostSocketId === socket.id) {
          game.hostSocketId = game.order[0] || null;
        }
        io.to(gameId).emit('lobbyUpdate', {
          players: Object.entries(game.players).map(([id, p]) => ({ id, name: p.name, diceCount: p.diceCount })),
          host: game.hostSocketId
        });
      }
    }
  });

});

function rollDice(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(Math.random() * 6) + 1);
  return out;
}

function countDiceAcrossGame(game) {
  // returns object with helper actualCountForFace(face)
  const all = [];
  for (const p of Object.values(game.players)) {
    if (p.dice) all.push(...p.dice);
  }
  const counts = {};
  for (const d of all) counts[d] = (counts[d] || 0) + 1;
  counts['total'] = all.length;
  return {
    counts,
    actualCountForFace: (face) => {
      // 1s are wild: count all 1s + face
      const ones = counts[1] || 0;
      const faceCount = counts[face] || 0;
      if (face === 1) {
        // if bidding on ones themselves, ones count as normal (but wild rule typically means 1 is wild for others; treat 1s as normal if bid on 1)
        return ones;
      }
      return ones + faceCount;
    }
  };
}

function nextAliveIndex(game, currentIndex) {
  if (!game.order || game.order.length === 0) return 0;
  let idx = (currentIndex + 1) % game.order.length;
  return idx;
}

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  console.log(`Create games by POST /create (returns link). Or open / and create from UI.`);
});
