"use strict";

const $ = (selector) => document.querySelector(selector);
const authView = $("#authView");
const appView = $("#appView");
const authForm = $("#authForm");
const authMessage = $("#authMessage");
const authSubmit = $("#authSubmit");
const authHint = $("#authHint");
const callSheet = $("#callSheet");
const toastNode = $("#toast");

let authMode = "login";
let currentUser = null;
let socket = null;
let friendData = [];
let requestData = [];
let searchData = [];
let activeCall = null;
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let rtcConfiguration = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
let pendingIceCandidates = [];
let searchTimer = null;
let searchRequestId = 0;
let toastTimer = null;

async function api(url, options) {
  const response = await fetch(url, Object.assign({
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" }
  }, options || {}));
  if (response.status === 204) return null;
  let data = {};
  try { data = await response.json(); } catch (_error) {}
  if (!response.ok) {
    const error = new Error(data.error || "Something went wrong.");
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function setMessage(node, message, isError) {
  node.textContent = message || "";
  node.classList.toggle("is-error", Boolean(isError));
}

function notifyDesktop(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(title, { body, tag: "testing-sandbox-" + title });
    setTimeout(() => notification.close(), 8000);
  } catch (_error) {}
}

function updateNotificationButton() {
  const button = $("#enableNotifications");
  if (!button || !("Notification" in window)) return;
  if (Notification.permission === "granted") {
    button.textContent = "Notifications on";
    button.disabled = true;
  } else if (Notification.permission === "denied") {
    button.textContent = "Notifications blocked";
    button.disabled = true;
    button.title = "Allow notifications for this site in your browser settings.";
  }
}

function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove("visible"), 3200);
}

function avatarFor(name, className) {
  const node = document.createElement("span");
  node.className = "avatar" + (className ? " " + className : "");
  node.textContent = (name || "?").slice(0, 1).toUpperCase();
  node.setAttribute("aria-hidden", "true");
  return node;
}

function setAuthMode(mode) {
  authMode = mode;
  const isRegister = mode === "register";
  $("#loginTab").classList.toggle("active", !isRegister);
  $("#registerTab").classList.toggle("active", isRegister);
  $("#loginTab").setAttribute("aria-selected", String(!isRegister));
  $("#registerTab").setAttribute("aria-selected", String(isRegister));
  authSubmit.textContent = isRegister ? "Create account" : "Sign in";
  authHint.textContent = isRegister
    ? "Choose a username and a strong password. Your password is stored as a one-way hash."
    : "Welcome back. Sign in to see your friends.";
  $("#password").setAttribute("autocomplete", isRegister ? "new-password" : "current-password");
  setMessage(authMessage, "", false);
}

function showAuth(message) {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  stopCallLocally();
  currentUser = null;
  appView.hidden = true;
  authView.hidden = false;
  $("#password").value = "";
  setMessage(authMessage, message || "", Boolean(message));
}

async function enterApp(user) {
  currentUser = user;
  authView.hidden = true;
  appView.hidden = false;
  $("#topUsername").textContent = user.username;
  $("#welcomeName").textContent = user.username;
  $("#avatarLetter").textContent = user.username.slice(0, 1).toUpperCase();
  await loadRtcConfiguration();
  await refreshFriends();
  connectSocket();
}

async function loadRtcConfiguration() {
  try {
    const data = await api("/api/config");
    if (data && data.rtcConfiguration) rtcConfiguration = data.rtcConfiguration;
  } catch (_error) {
    // STUN fallback remains available if optional configuration cannot load.
  }
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = $("#username").value.trim();
  const password = $("#password").value;
  setMessage(authMessage, "", false);
  authSubmit.disabled = true;
  authSubmit.textContent = authMode === "register" ? "Creating…" : "Signing in…";
  try {
    const data = await api("/api/auth/" + (authMode === "register" ? "register" : "login"), {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    await enterApp(data.user);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = authMode === "register" ? "Create account" : "Sign in";
  }
});

$("#enableNotifications").addEventListener("click", async () => {
  if (!("Notification" in window)) return toast("This browser does not support desktop notifications.");
  const permission = await Notification.requestPermission();
  updateNotificationButton();
  if (permission === "granted") toast("Notifications are enabled.");
  else toast("Notifications were not enabled.");
});
updateNotificationButton();

$("#loginTab").addEventListener("click", () => setAuthMode("login"));
$("#registerTab").addEventListener("click", () => setAuthMode("register"));

$("#logoutButton").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch (_error) {}
  showAuth("You have signed out.");
});

async function refreshFriends() {
  try {
    const data = await api("/api/friends");
    friendData = data.friends || [];
    requestData = data.requests || [];
    renderFriends();
    renderRequests();
    renderPeople();
  } catch (error) {
    if (error.status === 401) showAuth("Your session expired. Please sign in again.");
    else $("#globalMessage").textContent = error.message;
  }
}

function makeFriendRow(friend, compact) {
  const row = document.createElement("div");
  row.className = "friend-row" + (friend.online ? " is-online" : "");
  row.appendChild(avatarFor(friend.username));
  const info = document.createElement("div");
  info.className = "friend-info";
  const name = document.createElement("span");
  name.className = "friend-name";
  name.textContent = friend.username;
  const status = document.createElement("span");
  status.className = "friend-status";
  const dot = document.createElement("i");
  status.appendChild(dot);
  status.appendChild(document.createTextNode(friend.online ? "Online" : "Offline"));
  info.append(name, status);
  row.appendChild(info);

  if (!compact) {
    const voice = document.createElement("button");
    voice.className = "mini-call";
    voice.type = "button";
    voice.textContent = "☎";
    voice.title = "Start voice call";
    voice.setAttribute("aria-label", "Start voice call with " + friend.username);
    voice.disabled = !friend.online;
    voice.addEventListener("click", () => startCall(friend, false));
    row.appendChild(voice);
  }
  return row;
}

function renderFriends() {
  const onlineFriends = friendData.filter((friend) => friend.online);
  const offlineFriends = friendData.filter((friend) => !friend.online);
  $("#onlineFriends").replaceChildren();
  $("#offlineFriends").replaceChildren();
  onlineFriends.forEach((friend) => $("#onlineFriends").appendChild(makeFriendRow(friend, false)));
  offlineFriends.forEach((friend) => $("#offlineFriends").appendChild(makeFriendRow(friend, false)));
  if (!onlineFriends.length) {
    const empty = document.createElement("p");
    empty.className = "empty-sidebar";
    empty.textContent = "No friends online right now.";
    $("#onlineFriends").appendChild(empty);
  }
  if (!offlineFriends.length && friendData.length) {
    const empty = document.createElement("p");
    empty.className = "empty-sidebar";
    empty.textContent = "All your friends are online.";
    $("#offlineFriends").appendChild(empty);
  }
  $("#friendCount").textContent = String(friendData.length);
  $("#onlineCount").textContent = String(onlineFriends.length);
  $("#allFriendCount").textContent = String(friendData.length);
  $("#peopleSummary").textContent = friendData.length
    ? friendData.length + " friend" + (friendData.length === 1 ? "" : "s") + " · " + onlineFriends.length + " online"
    : "No friends yet";
}

function renderRequests() {
  const list = $("#friendRequests");
  list.replaceChildren();
  $("#requestCount").textContent = String(requestData.filter((request) => request.direction === "incoming").length);
  requestData.filter((request) => request.direction === "incoming").forEach((request) => {
    const row = document.createElement("div");
    row.className = "request-row";
    const title = document.createElement("strong");
    title.textContent = request.username + " wants to connect";
    const actions = document.createElement("div");
    actions.className = "request-actions";
    const accept = document.createElement("button");
    accept.className = "accept";
    accept.type = "button";
    accept.textContent = "Accept";
    accept.addEventListener("click", () => respondToRequest(request.id, "accepted"));
    const decline = document.createElement("button");
    decline.type = "button";
    decline.textContent = "Decline";
    decline.addEventListener("click", () => respondToRequest(request.id, "declined"));
    actions.append(accept, decline);
    row.append(title, actions);
    list.appendChild(row);
  });
  if (!requestData.some((request) => request.direction === "incoming")) {
    const empty = document.createElement("p");
    empty.className = "empty-sidebar";
    empty.textContent = "No new requests.";
    list.appendChild(empty);
  }
}

async function respondToRequest(requestId, status) {
  try {
    await api("/api/friends/requests/" + encodeURIComponent(requestId) + "/respond", {
      method: "POST",
      body: JSON.stringify({ status })
    });
    await refreshFriends();
    toast(status === "accepted" ? "Friend request accepted." : "Friend request declined.");
  } catch (error) {
    toast(error.message);
  }
}

function renderPeople() {
  const grid = $("#peopleGrid");
  grid.replaceChildren();
  if (!friendData.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const symbol = document.createElement("div");
    symbol.className = "empty-symbol";
    symbol.textContent = "✳";
    const title = document.createElement("h3");
    title.textContent = "Your circle starts here";
    const copy = document.createElement("p");
    copy.textContent = "Search for a username to add someone. When they're online, you can call them.";
    const button = document.createElement("button");
    button.className = "button button-secondary";
    button.type = "button";
    button.textContent = "Find someone";
    button.addEventListener("click", focusSearch);
    empty.append(symbol, title, copy, button);
    grid.appendChild(empty);
    return;
  }

  friendData.forEach((friend) => {
    const card = document.createElement("article");
    card.className = "person-card";
    card.appendChild(avatarFor(friend.username));
    const details = document.createElement("div");
    details.className = "person-details";
    const name = document.createElement("strong");
    name.textContent = friend.username;
    const status = document.createElement("small");
    status.textContent = friend.online ? "● Online now" : "○ Offline";
    details.append(name, status);
    card.appendChild(details);

    const actions = document.createElement("div");
    actions.className = "person-call-actions";
    const voice = document.createElement("button");
    voice.type = "button";
    voice.textContent = "☎";
    voice.title = "Voice call";
    voice.disabled = !friend.online;
    voice.addEventListener("click", () => startCall(friend, false));
    const video = document.createElement("button");
    video.type = "button";
    video.textContent = "▣";
    video.title = "Video call";
    video.disabled = !friend.online;
    video.addEventListener("click", () => startCall(friend, true));
    actions.append(voice, video);
    card.appendChild(actions);
    grid.appendChild(card);
  });
}

function renderSearch() {
  const list = $("#searchResults");
  list.replaceChildren();
  searchData.forEach((user) => {
    const row = document.createElement("div");
    row.className = "friend-row" + (user.online ? " is-online" : "");
    row.appendChild(avatarFor(user.username));
    const info = document.createElement("div");
    info.className = "friend-info";
    const name = document.createElement("span");
    name.className = "friend-name";
    name.textContent = user.username;
    const status = document.createElement("span");
    status.className = "friend-status";
    status.textContent = user.online ? "Online · available" : "Offline";
    info.append(name, status);
    row.appendChild(info);
    const add = document.createElement("button");
    add.className = "mini-call";
    add.type = "button";
    add.textContent = "+";
    add.title = "Send friend request";
    add.setAttribute("aria-label", "Add " + user.username);
    add.addEventListener("click", () => sendFriendRequest(user));
    row.appendChild(add);
    list.appendChild(row);
  });
  if (!searchData.length && $("#userSearch").value.trim().length >= 2) {
    const empty = document.createElement("p");
    empty.className = "empty-sidebar";
    empty.textContent = "No matching players found.";
    list.appendChild(empty);
  }
}

async function searchUsers(query) {
  const requestId = ++searchRequestId;
  if (query.length < 2) {
    searchData = [];
    renderSearch();
    return;
  }
  try {
    const data = await api("/api/sandbox_users/search?q=" + encodeURIComponent(query));
    if (requestId !== searchRequestId || query !== $("#userSearch").value.trim()) return;
    searchData = data.sandbox_users || [];
    renderSearch();
  } catch (error) {
    if (error.status === 401) showAuth("Your session expired. Please sign in again.");
    else toast(error.message);
  }
}

$("#userSearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = $("#userSearch").value.trim();
  searchTimer = setTimeout(() => searchUsers(query), 220);
});

function focusSearch() {
  $("#userSearch").focus();
  $("#userSearch").scrollIntoView({ behavior: "smooth", block: "center" });
}
$("#focusSearch").addEventListener("click", focusSearch);
$("#emptySearchButton").addEventListener("click", focusSearch);

async function sendFriendRequest(user) {
  try {
    await api("/api/friends/requests", {
      method: "POST",
      body: JSON.stringify({ userId: user.id })
    });
    toast("Friend request sent to " + user.username + ".");
    searchData = searchData.filter((candidate) => candidate.id !== user.id);
    renderSearch();
  } catch (error) {
    toast(error.message);
  }
}

function setConnectionState(state, label) {
  const node = $("#connectionState");
  node.classList.toggle("connected", state === "connected");
  node.classList.toggle("disconnected", state === "disconnected");
  node.textContent = label;
  const dot = document.createElement("i");
  node.prepend(dot);
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
    timeout: 12000
  });

  socket.on("connect", () => setConnectionState("connected", "Connected"));
  socket.on("disconnect", () => {
    setConnectionState("disconnected", "Reconnecting");
    if (activeCall) $("#callStatus").textContent = "Connection interrupted. Reconnecting…";
  });
  socket.on("connect_error", (error) => {
    const message = error && error.message;
    setConnectionState("disconnected", "Connection issue");
    if (message === "AUTH_REQUIRED") showAuth("Your session expired. Please sign in again.");
    else if (message === "DATABASE_UNAVAILABLE") toast("The server database is not ready yet.");
  });
  socket.on("session:ready", () => refreshFriends());
  socket.on("presence:update", (update) => {
    const friend = friendData.find((item) => item.id === update.userId);
    if (friend) {
      friend.online = Boolean(update.online);
      renderFriends();
      renderPeople();
    }
    const found = searchData.find((item) => item.id === update.userId);
    if (found) {
      found.online = Boolean(update.online);
      renderSearch();
    }
  });
  socket.on("friend:request", (payload) => {
    const sender = payload.from && payload.from.username || "Someone";
    toast(sender + " sent you a friend request.");
    notifyDesktop("Friend request", sender + " sent you a friend request.");
    refreshFriends();
  });
  socket.on("friend:response", () => refreshFriends());

  socket.on("call:incoming", (payload) => {
    if (activeCall) {
      socket.emit("call:reject", { callId: payload.callId });
      return;
    }
    notifyDesktop("Incoming call", (payload.from && payload.from.username || "A friend") + " is calling you.");
    activeCall = {
      callId: payload.callId,
      peerId: payload.from.id,
      peerName: payload.from.username,
      video: Boolean(payload.video),
      direction: "incoming",
      state: "ringing"
    };
    renderCall();
    callSheet.hidden = false;
  });

  socket.on("call:outgoing", (payload) => {
    if (!activeCall) return;
    activeCall.callId = payload.callId;
    activeCall.state = "ringing";
    renderCall();
  });

  socket.on("call:accepted", async (payload) => {
    if (!activeCall || activeCall.callId !== payload.callId) return;
    activeCall.state = "connecting";
    if (activeCall.direction === "outgoing") {
      try {
        await ensureLocalMedia(activeCall.video);
        await ensurePeerConnection();
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit("call:signal", {
          callId: activeCall.callId,
          type: "offer",
          data: peerConnection.localDescription
        });
      } catch (error) {
        toast("Could not start media: " + error.message);
        endCall();
        return;
      }
    }
    renderCall();
  });

  socket.on("call:signal", async (payload) => {
    if (!activeCall || activeCall.callId !== payload.callId) return;
    try {
      if (payload.type === "offer") {
        await ensureLocalMedia(activeCall.video);
        await ensurePeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.data));
        for (const candidate of pendingIceCandidates) {
          await peerConnection.addIceCandidate(candidate);
        }
        pendingIceCandidates = [];
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit("call:signal", {
          callId: activeCall.callId,
          type: "answer",
          data: peerConnection.localDescription
        });
      } else if (payload.type === "answer" && peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.data));
        for (const candidate of pendingIceCandidates) {
          await peerConnection.addIceCandidate(candidate);
        }
        pendingIceCandidates = [];
      } else if (payload.type === "ice" && payload.data) {
        const candidate = new RTCIceCandidate(payload.data);
        if (peerConnection && peerConnection.remoteDescription) {
          await peerConnection.addIceCandidate(candidate);
        } else {
          pendingIceCandidates.push(candidate);
        }
      }
    } catch (error) {
      toast("Call connection error: " + error.message);
      endCall();
    }
  });

  socket.on("call:rejected", (payload) => {
    if (activeCall && activeCall.callId === payload.callId) {
      stopCallLocally();
      toast("Your call was declined.");
    }
  });
  socket.on("call:missed", (payload) => {
    if (activeCall && activeCall.callId === payload.callId) {
      stopCallLocally();
      toast("No answer. Try again later.");
    }
  });
  socket.on("call:ended", (payload) => {
    if (activeCall && activeCall.callId === payload.callId) {
      const byOther = payload.byUserId && payload.byUserId !== currentUser.id;
      stopCallLocally();
      if (byOther) toast("The other person left the call.");
    }
  });
  socket.on("app:error", (payload) => {
    const message = payload && payload.message || "Action failed.";
    const code = payload && payload.code;
    if (activeCall && ["INVALID_CALL_TARGET", "NOT_FRIENDS", "USER_OFFLINE", "CALL_BUSY", "CALL_FAILED", "CALL_EXPIRED"].includes(code)) {
      stopCallLocally();
    }
    toast(message);
  });
}

function renderCall() {
  if (!activeCall) return;
  $("#callTitle").textContent = activeCall.peerName || "Call";
  $("#audioStageName").textContent = activeCall.video ? "Video call" : "Voice call";
  $("#callAvatar").textContent = (activeCall.peerName || "?").slice(0, 1).toUpperCase();
  $("#remoteInitial").textContent = (activeCall.peerName || "?").slice(0, 1).toUpperCase();
  $("#callStatus").textContent = activeCall.state === "ringing"
    ? (activeCall.direction === "incoming" ? "Incoming " : "Calling… ") + (activeCall.video ? "video call" : "voice call")
    : activeCall.state === "connecting" ? "Connecting securely…" : "Call connected";
  $("#incomingText").textContent = (activeCall.peerName || "A friend") + " is calling you" +
    (activeCall.video ? " with video." : ".");
  $("#incomingControls").hidden = activeCall.direction !== "incoming" || activeCall.state !== "ringing";
  $("#activeControls").hidden = activeCall.state === "ringing" && activeCall.direction === "incoming";
  $("#videoStage").hidden = !activeCall.video;
  $("#audioStage").hidden = Boolean(activeCall.video);
  $("#cameraButton").hidden = !activeCall.video;
  callSheet.hidden = false;
}

async function startCall(friend, video) {
  if (!socket || !socket.connected) return toast("Still connecting to the call server. Try again in a moment.");
  if (activeCall) return toast("Finish your current call first.");
  if (!friend.online) return toast("That friend is offline.");
  activeCall = {
    callId: null,
    peerId: friend.id,
    peerName: friend.username,
    video: Boolean(video),
    direction: "outgoing",
    state: "ringing"
  };
  renderCall();
  callSheet.hidden = false;
  socket.emit("call:invite", { targetUserId: friend.id, video: Boolean(video) });
}

async function ensureLocalMedia(video) {
  if (localStream) return localStream;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("This browser does not support camera or microphone access.");
  }
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: video ? {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 }
    } : false
  });
  $("#localVideo").srcObject = localStream;
  $("#remoteVideoPlaceholder").hidden = false;
  $("#muteButton").classList.remove("active");
  $("#cameraButton").classList.remove("active");
  return localStream;
}

async function ensurePeerConnection() {
  if (peerConnection) return peerConnection;
  peerConnection = new RTCPeerConnection(rtcConfiguration);
  remoteStream = new MediaStream();
  $("#remoteVideo").srcObject = remoteStream;
  $("#remoteAudio").srcObject = remoteStream;
  $("#remoteVideo").onloadedmetadata = () => {
    $("#remoteVideoPlaceholder").hidden = true;
    $("#remoteVideo").play().catch(() => {});
  };
  peerConnection.ontrack = (event) => {
    const streams = event.streams && event.streams.length ? event.streams : [];
    const source = streams[0];
    if (source) {
      source.getTracks().forEach((track) => {
        if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) {
          remoteStream.addTrack(track);
        }
      });
    } else if (!remoteStream.getTracks().some((existing) => existing.id === event.track.id)) {
      remoteStream.addTrack(event.track);
    }
    $("#remoteAudio").play().catch(() => {});
    if (activeCall && activeCall.video && remoteStream.getVideoTracks().length) {
      $("#remoteVideoPlaceholder").hidden = true;
      $("#remoteVideo").play().catch(() => {});
    }
  };
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && socket && activeCall) {
      socket.emit("call:signal", {
        callId: activeCall.callId,
        type: "ice",
        data: event.candidate
      });
    }
  };
  peerConnection.onconnectionstatechange = () => {
    if (!activeCall || !peerConnection) return;
    const state = peerConnection.connectionState;
    if (state === "connected") {
      activeCall.state = "connected";
      renderCall();
    } else if (state === "failed") {
      $("#callStatus").textContent = "Could not connect. A TURN relay may be needed on this network.";
    } else if (state === "disconnected") {
      $("#callStatus").textContent = "Reconnecting media…";
    }
  };
  if (localStream) {
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  }
  return peerConnection;
}

async function acceptIncomingCall() {
  if (!activeCall || activeCall.direction !== "incoming" || !socket) return;
  const callId = activeCall.callId;
  $("#acceptCall").disabled = true;
  try {
    await ensureLocalMedia(activeCall.video);
    activeCall.state = "connecting";
    socket.emit("call:accept", { callId });
    renderCall();
    await ensurePeerConnection();
  } catch (error) {
    toast("Microphone or camera permission was not granted: " + error.message);
    socket.emit("call:reject", { callId });
    stopCallLocally();
  } finally {
    $("#acceptCall").disabled = false;
  }
}

function endCall() {
  if (activeCall && activeCall.callId && socket) {
    socket.emit("call:end", { callId: activeCall.callId });
  }
  stopCallLocally();
}

function stopCallLocally() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  if (remoteStream) {
    remoteStream.getTracks().forEach((track) => track.stop());
    remoteStream = null;
  }
  pendingIceCandidates = [];
  $("#localVideo").srcObject = null;
  $("#remoteVideo").srcObject = null;
  $("#remoteAudio").srcObject = null;
  $("#remoteVideoPlaceholder").hidden = false;
  $("#incomingControls").hidden = true;
  $("#activeControls").hidden = true;
  callSheet.hidden = true;
  activeCall = null;
}

$("#acceptCall").addEventListener("click", acceptIncomingCall);
$("#declineCall").addEventListener("click", () => {
  if (activeCall && activeCall.callId && socket) socket.emit("call:reject", { callId: activeCall.callId });
  stopCallLocally();
});
$("#hangupButton").addEventListener("click", endCall);

$("#muteButton").addEventListener("click", () => {
  if (!localStream) return;
  const tracks = localStream.getAudioTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach((track) => { track.enabled = enabled; });
  $("#muteButton").classList.toggle("active", !enabled);
  $("#muteButton").querySelector("small").textContent = enabled ? "Mute" : "Unmute";
  $("#muteButton").setAttribute("aria-label", enabled ? "Mute microphone" : "Unmute microphone");
});

$("#cameraButton").addEventListener("click", () => {
  if (!localStream) return;
  const tracks = localStream.getVideoTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach((track) => { track.enabled = enabled; });
  $("#cameraButton").classList.toggle("active", !enabled);
  $("#cameraButton").querySelector("small").textContent = enabled ? "Camera" : "Camera off";
});

async function loadCurrentUser() {
  try {
    const data = await api("/api/me");
    await enterApp(data.user);
  } catch (error) {
    if (error.status === 503) {
      setMessage(authMessage, "The server is online, but the database still needs to be configured.", true);
    }
  }
}

loadCurrentUser();
