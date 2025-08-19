const socket = io();

const joinBtn = document.getElementById("joinBtn");
const startBtn = document.getElementById("startBtn");
const betBtn = document.getElementById("betBtn");
const callBtn = document.getElementById("callBtn");
const output = document.getElementById("output");

let currentTurn = null;
let myId = null;

socket.on("connect", () => {
  myId = socket.id;
});

joinBtn.onclick = () => {
  const name = document.getElementById("nameInput").value;
  if (name) socket.emit("joinGame", name);
};

startBtn.onclick = () => {
  socket.emit("startGame");
};

betBtn.onclick = () => {
  const count = parseInt(document.getElementById("betCount").value);
  const value = document.getElementById("betValue").value;
  if (count && value) {
    socket.emit("makeBet", { count, value });
  }
};

callBtn.onclick = () => {
  socket.emit("callBluff");
};

socket.on("playerList", (players) => {
  output.innerHTML = `<h3>Players</h3>`;
  Object.values(players).forEach(p => {
    output.innerHTML += `<p>${p.name} - ${p.diceCount} dice</p>`;
  });
});

socket.on("roundStarted", (data) => {
  output.innerHTML += `<h3>New Round!</h3>`;
  output.innerHTML += `<p>It's ${data.players[data.currentTurn].name}'s turn</p>`;
  if (data.players[myId]) {
    output.innerHTML += `<p>Your dice: ${data.players[myId].dice.join(", ")}</p>`;
  }
  currentTurn = data.currentTurn;
});

socket.on("turnChanged", (data) => {
  currentTurn = data.currentTurn;
  output.innerHTML += `<p>Now it's ${data.currentTurn}'s turn</p>`;
});

socket.on("betMade", (data) => {
  output.innerHTML += `<p>${data.player} bets ${data.bet.count} ${data.bet.value}'s</p>`;
});

socket.on("betRejected", (msg) => {
  output.innerHTML += `<p style="color:red;">${msg}</p>`;
});

socket.on("bluffResult", (data) => {
  output.innerHTML += `<h3>Bluff called!</h3>`;
  output.innerHTML += `<p>Bet was ${data.bet.count} ${data.bet.value}'s</p>`;
  output.innerHTML += `<p>Actual count: ${data.totalCount}</p>`;
  output.innerHTML += `<p>${data.loser} loses a die!</p>`;
});

socket.on("playerOut", (data) => {
  output.innerHTML += `<p style="color:red;">${data.name} is out of the game!</p>`;
});

socket.on("gameOver", (data) => {
  output.innerHTML += `<h2>🏆 ${data.winner} wins the game!</h2>`;
});
