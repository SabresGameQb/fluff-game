const socket = io();

const urlParams = new URLSearchParams(window.location.search);
let gameId = urlParams.get('game') || null;
let myName = localStorage.getItem('fluff_name') || '';

document.getElementById('name').value = myName;

const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const createResult = document.getElementById('createResult');
const joinArea = document.getElementById('joinArea');
const joinGameBtn = document.getElementById('joinGameBtn');
const joinGameId = document.getElementById('joinGameId');

const lobbyInfo = document.getElementById('lobbyInfo');
const gameLink = document.getElementById('gameLink');
const playersList = document.getElementById('playersList');
const hostControls = document.getElementById('hostControls');
const startGameBtn = document.getElementById('startGame');

const lobby = document.getElementById('lobby');
const gameDiv = document.getElementById('game');

const statusDiv = document.getElementById('status');
const yourDiceDiv = document.getElementById('yourDice');
const currentBidDiv = document.getElementById('currentBid');
const turnInfo = document.getElementById('turnInfo');
const bidQty = document.getElementById('bidQty');
const bidFace = document.getElementById('bidFace');
const placeBidBtn = document.getElementById('placeBid');
const callBtn = document.getElementById('callBtn');
const roundLog = document.getElementById('roundLog');

createBtn.onclick = async () => {
  myName = document.getElementById('name').value.trim() || 'Player';
  localStorage.setItem('fluff_name', myName);
  // create via POST /create
  const resp = await fetch('/create', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ defaultDice: 5 })
  });
  const data = await resp.json();
  gameId = data.gameId;
  createResult.innerHTML = `Created game: <a href="${data.link}" target="_blank">${data.link}</a>`;
  showJoinArea(gameId);
  // auto join
  joinGame(gameId);
};

joinBtn.onclick = () => {
  joinArea.style.display = joinArea.style.display === 'none' ? 'block' : 'none';
};

joinGameBtn.onclick = () => {
  let raw = joinGameId.value.trim();
  if (!raw) return alert('Enter game id or link');
  // extract id if full link
  const m = raw.match(/([0-9a-fA-F]{8})$/);
  const id = m ? m[1] : raw;
  joinGame(id);
};

function showJoinArea(id) {
  lobbyInfo.style.display = 'block';
  gameLink.innerHTML = `Game link: <a href="?game=${id}">${location.origin}/?game=${id}</a>`;
}

async function joinGame(id) {
  myName = document.getElementById('name').value.trim() || 'Player';
  gameId = id;
  socket.emit('joinGame', { gameId: id, name: myName }, (resp) => {
    if (resp.error) return alert(resp.error);
    const amHost = resp.host;
    lobby.style.display = 'none';
    gameDiv.style.display = 'block';
    if (amHost) hostControls.style.display = 'block';
    else hostControls.style.display = 'none';
    statusDiv.innerText = `Joined game ${id} as ${myName}` ;
  });
}

startGameBtn.onclick = () => {
  socket.emit('startGame', { gameId }, (resp) => {
    if (resp.error) alert(resp.error);
  });
};

socket.on('lobbyUpdate', (data) => {
  playersList.innerHTML = '';
  for (const p of data.players) {
    const li = document.createElement('li');
    li.innerText = `${p.name} — dice: ${p.diceCount}`;
    playersList.appendChild(li);
  }
  if (data.host === socket.id) hostControls.style.display = 'block';
  else hostControls.style.display = 'none';
});

socket.on('gameStarted', (data) => {
  roundLog.innerHTML = '';
  currentBidDiv.innerText = '—';
  statusDiv.innerText = 'Game started';
  updateTurnInfo(data.currentTurn);
});

socket.on('privateDice', (dice) => {
  yourDiceDiv.innerHTML = '';
  for (const d of dice) {
    const span = document.createElement('span');
    span.innerText = d;
    yourDiceDiv.appendChild(span);
  }
});

socket.on('newBid', ({ qty, face, by, nextTurn }) => {
  currentBidDiv.innerText = `${qty} × ${face} (by ${by.name})`;
  appendLog(`${by.name} bids ${qty} × ${face}`);
  updateTurnInfo(nextTurn);
});

placeBidBtn.onclick = () => {
  const qty = parseInt(bidQty.value);
  const face = parseInt(bidFace.value);
  if (!qty || !face) return alert('Enter qty and face');
  socket.emit('bid', { gameId, qty, face }, (resp) => {
    if (resp.error) alert(resp.error);
    else {
      bidQty.value = '';
      bidFace.value = '';
    }
  });
};

callBtn.onclick = () => {
  socket.emit('call', { gameId }, (resp) => {
    if (resp.error) alert(resp.error);
  });
};

socket.on('roundResult', (data) => {
  // reveal dice
  let revealText = 'Revealed dice:\n';
  for (const [id, dice] of Object.entries(data.reveal)) {
    revealText += `${data.players.find(p => p.id===id)?.name || id}: [${dice.join(', ')}]\n`;
  }
  appendLog(data.resultText);
  appendLog(revealText);
  // display updated players
  let playersText = 'Players: ' + data.players.map(p => `${p.name}(${p.diceCount})${p.alive? '':''}`).join(', ');
  appendLog(playersText);
  if (data.winner) {
    appendLog(`🏆 Winner: ${data.winner.name}`);
    statusDiv.innerText = `Winner: ${data.winner.name}`;
  } else {
    updateTurnInfo(data.nextTurn);
  }
  currentBidDiv.innerText = '—';
});

function appendLog(txt) {
  const el = document.createElement('div');
  el.innerText = txt;
  roundLog.appendChild(el);
  roundLog.scrollTop = roundLog.scrollHeight;
}

function updateTurnInfo(nextTurnId) {
  if (!nextTurnId) {
    turnInfo.innerText = 'No next turn';
    return;
  }
  // if it's me
  if (nextTurnId === socket.id) turnInfo.innerText = 'Your turn';
  else {
    const name = document.querySelector(`#playersList li`)?.innerText || '';
    turnInfo.innerText = `Waiting for player ${nextTurnId}`;
  }
}

// If page loaded with ?game=..., auto-join prompt the user to enter name & join
if (gameId) {
  document.getElementById('createArea').style.display = 'none';
  showJoinArea(gameId);
  // prompt for name if missing
  if (!myName) {
    const nm = prompt('Enter display name for the game') || 'Player';
    document.getElementById('name').value = nm;
    localStorage.setItem('fluff_name', nm);
  }
  joinGame(gameId);
}
