const socket = io();

const joinArea = document.getElementById("joinArea");
const gameArea = document.getElementById("gameArea");
const joinBtn = document.getElementById("joinBtn");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const joinStatus = document.getElementById("joinStatus");

const roomNameDisplay = document.getElementById("roomName");
const playersList = document.getElementById("playersList");
const yourDiceDiv = document.getElementById("yourDice");
const turnInfo = document.getElementById("turnInfo");
const bidCountInput = document.getElementById("bidCount");
const bidValueInput = document.getElementById("bidValue");
const placeBidBtn = document.getElementById("placeBidBtn");
const callFluffBtn = document.getElementById("callFluffBtn");
const currentBidDisplay = document.getElementById("currentBidDisplay");
const resultMessage = document.getElementById("resultMessage");

let currentTurnId = null;
let currentBids = []; // Track bids to prevent duplicates on client side (optional)

joinBtn.onclick = () => {
  const name = nameInput.value.trim();
  const room = roomInput.value.trim();
  if (!name || !room) {
    joinStatus.textContent = "Please enter your name and room ID.";
    return;
  }
  joinStatus.textContent = "";
  socket.emit("joinRoom", { roomId: room, name });
  roomNameDisplay.textContent = room;
  joinArea.style.display = "none";
  gameArea.style.display = "block";
};

placeBidBtn.onclick = () => {
  const count = parseInt(bidCountInput.value);
  const value = parseInt(bidValueInput.value);

  if (!count || !value || value < 1 || value > 6) {
    alert("Please enter valid bid count and value.");
    return;
  }

  // Optional: check if bid already played locally
  if (currentBids.some(b => b.count === count && b.value === value)) {
    alert("This exact bid has already been made this round.");
    return;
  }

  socket.emit("placeBid", {
    roomId: roomNameDisplay.textContent,
    count,
    value,
  });
  resultMessage.textContent = "";
};

callFluffBtn.onclick = () => {
  socket.emit("callFluff", { roomId: roomNameDisplay.textContent });
  resultMessage.textContent = "";
};

socket.on("yourDice", (dice) => {
  yourDiceDiv.textContent = dice.map((d) => `🎲${d}`).join(" ");
});

socket.on("updatePlayers", (players) => {
  playersList.innerHTML = "";
  players.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = `${p.name} (${p.diceCount} dice)`;
    if (p.id === currentTurnId) {
      li.style.fontWeight = "bold";
      li.style.color = "#ffa500";
      li.textContent += " ← Current Turn";
    }
    playersList.appendChild(li);
  });
});

socket.on("updateBid", (bid) => {
  if (!bid) {
    currentBidDisplay.textContent = "No bids placed yet.";
    currentBids = [];
  } else {
    currentBidDisplay.textContent = `Current Bid: ${bid.count} x ${bid.value}'s (Total: ${bid.count * bid.value})`;
    currentBids.push(bid); // update local bids list
  }
});

socket.on("currentTurn", (playerId) => {
  currentTurnId = playerId;
  // Refresh players list to highlight current player
  socket.emit("requestPlayers");
});

socket.on("result", ({ actualCount, lastBid, resultText, loserName }) => {
  resultMessage.textContent = `${resultText} Actual count: ${actualCount} ${lastBid.value}'s`;
});

socket.on("invalidBid", (msg) => {
  alert(msg);
});

socket.on("invalidCall", (msg) => {
  alert(msg);
});

socket.on("gameOver", ({ winner }) => {
  alert(`Game over! Winner is ${winner}.`);
  location.reload();
});

// Request updated players list on demand (you can implement if needed)
socket.on("connect", () => {
  socket.emit("requestPlayers");
});
