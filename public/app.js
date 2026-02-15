import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, collection, query, where, onSnapshot, orderBy, addDoc, serverTimestamp, runTransaction, getDocs, deleteDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

let app, auth, db, storage;
let currentUser = null;
let currentChatUid = null;
let unsubscribeChat = null;
let unsubscribeIncomingCall = null;

let peerConnection = null;
let localStream = null;
let remoteStream = null;
let callDocId = null;

const DEFAULT_PFP = "https://files.clugo.my.id/Rwj8w.jpeg";
const servers = { iceServers: [{ urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }] };

async function init() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();
        app = initializeApp(config);
        auth = getAuth(app);
        db = getFirestore(app);
        storage = getStorage(app);
        setupAuthListeners();
        setupUIListeners();
        updateTimeAndBattery();
    } catch (error) {
        console.error(error);
    }
}

function setupAuthListeners() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            document.getElementById('authOverlay').classList.remove('active');
            const userDoc = await getDoc(doc(db, "users", user.uid));
            if (!userDoc.exists()) {
                document.getElementById('setupOverlay').classList.add('active');
            } else {
                currentUser = userDoc.data();
                currentUser.uid = user.uid;
                loadChats();
                loadStatuses();
                updateSettingsUI();
                listenForIncomingCalls();
            }
        } else {
            document.getElementById('authOverlay').classList.add('active');
        }
    });

    document.getElementById('googleLoginBtn').addEventListener('click', async () => {
        try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (error) {}
    });
}

function encryptText(text, uid1, uid2) {
    if (!text) return "";
    const key = [uid1, uid2].sort().join('_');
    return CryptoJS.AES.encrypt(text, key).toString();
}

function decryptText(cipher, uid1, uid2) {
    if (!cipher) return "";
    const key = [uid1, uid2].sort().join('_');
    try {
        const bytes = CryptoJS.AES.decrypt(cipher, key);
        const dec = bytes.toString(CryptoJS.enc.Utf8);
        return dec || cipher;
    } catch (e) {
        return cipher;
    }
}

async function uploadFile(file, path) {
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, file);
    return await getDownloadURL(storageRef);
}

function setupUIListeners() {
    document.querySelectorAll('.wa-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            document.querySelectorAll('.wa-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            e.currentTarget.classList.add('active');
            document.getElementById(`${e.currentTarget.dataset.tab}Tab`).classList.add('active');
        });
    });

    document.getElementById('setupPhotoBtn').addEventListener('click', () => document.getElementById('setupPhotoInput').click());
    document.getElementById('setupPhotoInput').addEventListener('change', (e) => {
        if(e.target.files[0]) document.getElementById('setupPreview').src = URL.createObjectURL(e.target.files[0]);
    });

    document.getElementById('setupSubmitBtn').addEventListener('click', async () => {
        const name = document.getElementById('setupNameInput').value.trim();
        if(!name) return;
        let photoUrl = DEFAULT_PFP;
        const file = document.getElementById('setupPhotoInput').files[0];
        if (file) photoUrl = await uploadFile(file, `profiles/${auth.currentUser.uid}`);
        
        const seqId = await generateSequentialId();
        const userData = { id: seqId, name: name, photoUrl: photoUrl, createdAt: serverTimestamp() };
        await setDoc(doc(db, "users", auth.currentUser.uid), userData);
        currentUser = { ...userData, uid: auth.currentUser.uid };
        
        document.getElementById('setupOverlay').classList.remove('active');
        loadChats();
        loadStatuses();
        updateSettingsUI();
        listenForIncomingCalls();
    });

    document.getElementById('settingsIcon').addEventListener('click', () => {
        document.getElementById('settingsOverlay').classList.add('active');
    });

    document.getElementById('settingsCloseBtn').addEventListener('click', () => {
        document.getElementById('settingsOverlay').classList.remove('active');
    });

    document.getElementById('settingsPhotoBtn').addEventListener('click', () => document.getElementById('settingsPhotoInput').click());
    document.getElementById('settingsPhotoInput').addEventListener('change', (e) => {
        if(e.target.files[0]) document.getElementById('settingsPreview').src = URL.createObjectURL(e.target.files[0]);
    });

    document.getElementById('settingsSaveBtn').addEventListener('click', async () => {
        const name = document.getElementById('settingsNameInput').value.trim();
        if(!name) return;
        const file = document.getElementById('settingsPhotoInput').files[0];
        let photoUrl = currentUser.photoUrl;
        if (file) photoUrl = await uploadFile(file, `profiles/${currentUser.uid}`);
        await setDoc(doc(db, "users", currentUser.uid), { name, photoUrl }, { merge: true });
        currentUser.name = name;
        currentUser.photoUrl = photoUrl;
        updateSettingsUI();
        document.getElementById('settingsOverlay').classList.remove('active');
    });

    document.getElementById('newChatIcon').addEventListener('click', () => {
        document.getElementById('newChatOverlay').classList.add('active');
    });
    
    document.getElementById('closeNewChatBtn').addEventListener('click', () => {
        document.getElementById('newChatOverlay').classList.remove('active');
    });

    document.getElementById('startChatBtn').addEventListener('click', async () => {
        const idToFind = parseInt(document.getElementById('searchIdInput').value);
        if(idToFind === currentUser.id) return;
        const q = query(collection(db, "users"), where("id", "==", idToFind));
        const snap = await getDocs(q);
        if(snap.empty) return;
        const targetUser = snap.docs[0].data();
        targetUser.uid = snap.docs[0].id;
        document.getElementById('newChatOverlay').classList.remove('active');
        openChat(targetUser);
    });

    document.getElementById('backButton').addEventListener('click', () => {
        document.getElementById('chatPage').classList.remove('active');
        if(unsubscribeChat) { unsubscribeChat(); unsubscribeChat = null; }
        currentChatUid = null;
    });

    document.getElementById('sendButton').addEventListener('click', sendMessage);
    document.getElementById('messageInput').addEventListener('keypress', (e) => {
        if(e.key === 'Enter') { e.preventDefault(); sendMessage(); }
    });

    document.getElementById('myStatusBtn').addEventListener('click', () => {
        document.getElementById('statusUploadInput').click();
    });

    document.getElementById('statusUploadInput').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if(!file) return;
        const url = await uploadFile(file, `statuses/${currentUser.uid}_${Date.now()}`);
        await addDoc(collection(db, "statuses"), {
            uid: currentUser.uid,
            url: url,
            type: file.type.startsWith('image') ? 'image' : 'video',
            timestamp: Date.now()
        });
    });

    document.getElementById('videoCallBtn').addEventListener('click', () => startCall(true));
    document.getElementById('audioCallBtn').addEventListener('click', () => startCall(false));
    document.getElementById('endCallBtn').addEventListener('click', hangUp);
    document.getElementById('answerCallBtn').addEventListener('click', answerCall);
}

async function generateSequentialId() {
    const counterRef = doc(db, "metadata", "usersCounter");
    try {
        return await runTransaction(db, async (transaction) => {
            const docSnap = await transaction.get(counterRef);
            let nextId = 1;
            if (docSnap.exists()) nextId = docSnap.data().currentId + 1;
            transaction.set(counterRef, { currentId: nextId });
            return nextId;
        });
    } catch (e) {
        return Date.now();
    }
}

function updateSettingsUI() {
    document.getElementById('settingsUserId').innerText = currentUser.id;
    document.getElementById('settingsNameInput').value = currentUser.name;
    document.getElementById('settingsPreview').src = currentUser.photoUrl;
    document.getElementById('myStatusImg').src = currentUser.photoUrl;
}

function loadChats() {
    const chatList = document.getElementById('chatList');
    const q = query(collection(db, "users"));
    onSnapshot(q, (snapshot) => {
        chatList.innerHTML = '';
        snapshot.forEach((docSnap) => {
            if(docSnap.id === currentUser.uid) return;
            const user = docSnap.data();
            user.uid = docSnap.id;
            const div = document.createElement('div');
            div.className = 'chat-item';
            div.innerHTML = `
                <div class="chat-avatar"><img src="${user.photoUrl}"></div>
                <div class="chat-info">
                    <div class="chat-header"><div class="chat-name">${user.name}</div></div>
                    <div class="chat-preview">ID: ${user.id}</div>
                </div>
            `;
            div.onclick = () => openChat(user);
            chatList.appendChild(div);
        });
    });
}

function openChat(user) {
    currentChatUid = user.uid;
    document.getElementById('activeChatName').innerText = user.name;
    document.getElementById('activeChatAvatar').src = user.photoUrl;
    document.getElementById('chatPage').classList.add('active');
    
    const chatId = [currentUser.uid, user.uid].sort().join('_');
    const q = query(collection(db, `chats/${chatId}/messages`), orderBy('timestamp', 'asc'));
    const container = document.getElementById('messagesContainer');
    
    if(unsubscribeChat) unsubscribeChat();
    unsubscribeChat = onSnapshot(q, (snapshot) => {
        container.innerHTML = `<div class="encryption-notice"><i class="fas fa-lock"></i><span>Pesan dienkripsi secara E2E.</span></div>`;
        snapshot.forEach(docSnap => {
            const msg = docSnap.data();
            const decrypted = decryptText(msg.text, currentUser.uid, user.uid);
            const isMe = msg.sender === currentUser.uid;
            const div = document.createElement('div');
            div.className = `message ${isMe ? 'outgoing' : 'incoming'}`;
            const date = msg.timestamp ? new Date(msg.timestamp.toDate()) : new Date();
            const time = `${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
            div.innerHTML = `<div class="message-bubble">${decrypted}</div><div class="message-time">${time}</div>`;
            container.appendChild(div);
        });
        container.scrollTop = container.scrollHeight;
    });
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if(!text || !currentChatUid) return;
    const encrypted = encryptText(text, currentUser.uid, currentChatUid);
    const chatId = [currentUser.uid, currentChatUid].sort().join('_');
    input.value = '';
    await addDoc(collection(db, `chats/${chatId}/messages`), {
        text: encrypted,
        sender: currentUser.uid,
        timestamp: serverTimestamp()
    });
}

function loadStatuses() {
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    const q = query(collection(db, "statuses"), where("timestamp", ">", twentyFourHoursAgo), orderBy("timestamp", "desc"));
    onSnapshot(q, async (snapshot) => {
        const list = document.getElementById('updatesList');
        list.innerHTML = '';
        for (const docSnap of snapshot.docs) {
            const status = docSnap.data();
            const userDoc = await getDoc(doc(db, "users", status.uid));
            if(!userDoc.exists()) continue;
            const userData = userDoc.data();
            const div = document.createElement('div');
            div.className = 'update-item';
            div.style.padding = '10px 16px';
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.borderBottom = '1px solid var(--wa-border)';
            const date = new Date(status.timestamp);
            const time = `${date.getHours()}:${date.getMinutes()}`;
            div.innerHTML = `
                <img src="${userData.photoUrl}" style="width:50px; height:50px; border-radius:50%; margin-right:15px; border:2px solid var(--wa-green); padding:2px;">
                <div style="flex:1;">
                    <div style="font-size:16px; color:white; margin-bottom:4px;">${userData.name}</div>
                    <div style="font-size:13px; color:var(--wa-text-secondary);">${time}</div>
                </div>
                <a href="${status.url}" target="_blank" style="color:var(--wa-green); text-decoration:none;"><i class="fas fa-eye"></i></a>
            `;
            list.appendChild(div);
        }
    });
}

async function startCall(video) {
    if(!currentChatUid) return;
    document.getElementById('callOverlay').classList.add('active');
    document.getElementById('answerCallBtn').style.display = 'none';
    document.getElementById('callStatusText').innerText = "Memanggil...";
    
    localStream = await navigator.mediaDevices.getUserMedia({ video: video, audio: true });
    document.getElementById('localVideo').srcObject = localStream;
    
    peerConnection = new RTCPeerConnection(servers);
    remoteStream = new MediaStream();
    document.getElementById('remoteVideo').srcObject = remoteStream;
    
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    peerConnection.ontrack = event => { event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track)); };
    
    const callDoc = doc(collection(db, "calls"));
    callDocId = callDoc.id;
    const offerCandidates = collection(callDoc, "offerCandidates");
    const answerCandidates = collection(callDoc, "answerCandidates");
    
    peerConnection.onicecandidate = event => {
        if(event.candidate) addDoc(offerCandidates, event.candidate.toJSON());
    };
    
    const offerDescription = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offerDescription);
    
    const callData = {
        offer: { type: offerDescription.type, sdp: offerDescription.sdp },
        caller: currentUser.uid,
        receiver: currentChatUid,
        status: "calling"
    };
    await setDoc(callDoc, callData);
    
    onSnapshot(callDoc, snapshot => {
        const data = snapshot.data();
        if(!peerConnection.currentRemoteDescription && data && data.answer) {
            const answerDescription = new RTCSessionDescription(data.answer);
            peerConnection.setRemoteDescription(answerDescription);
            document.getElementById('callStatusText').innerText = "Terhubung";
        }
        if(data && data.status === "ended") hangUp();
    });
    
    onSnapshot(answerCandidates, snapshot => {
        snapshot.docChanges().forEach(change => {
            if(change.type === "added") {
                const candidate = new RTCIceCandidate(change.doc.data());
                peerConnection.addIceCandidate(candidate);
            }
        });
    });
}

function listenForIncomingCalls() {
    if(unsubscribeIncomingCall) unsubscribeIncomingCall();
    const q = query(collection(db, "calls"), where("receiver", "==", currentUser.uid), where("status", "==", "calling"));
    unsubscribeIncomingCall = onSnapshot(q, snapshot => {
        snapshot.docChanges().forEach(change => {
            if(change.type === "added") {
                callDocId = change.doc.id;
                document.getElementById('callOverlay').classList.add('active');
                document.getElementById('answerCallBtn').style.display = 'flex';
                document.getElementById('callStatusText').innerText = "Panggilan Masuk...";
            }
        });
    });
}

async function answerCall() {
    document.getElementById('answerCallBtn').style.display = 'none';
    document.getElementById('callStatusText').innerText = "Menghubungkan...";
    
    const callDoc = doc(db, "calls", callDocId);
    const callData = (await getDoc(callDoc)).data();
    
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('localVideo').srcObject = localStream;
    
    peerConnection = new RTCPeerConnection(servers);
    remoteStream = new MediaStream();
    document.getElementById('remoteVideo').srcObject = remoteStream;
    
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    peerConnection.ontrack = event => { event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track)); };
    
    const offerCandidates = collection(callDoc, "offerCandidates");
    const answerCandidates = collection(callDoc, "answerCandidates");
    
    peerConnection.onicecandidate = event => {
        if(event.candidate) addDoc(answerCandidates, event.candidate.toJSON());
    };
    
    const offerDescription = new RTCSessionDescription(callData.offer);
    await peerConnection.setRemoteDescription(offerDescription);
    const answerDescription = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answerDescription);
    
    await updateDoc(callDoc, { answer: { type: answerDescription.type, sdp: answerDescription.sdp }, status: "answered" });
    document.getElementById('callStatusText').innerText = "Terhubung";
    
    onSnapshot(offerCandidates, snapshot => {
        snapshot.docChanges().forEach(change => {
            if(change.type === "added") {
                const candidate = new RTCIceCandidate(change.doc.data());
                peerConnection.addIceCandidate(candidate);
            }
        });
    });
    
    onSnapshot(callDoc, snapshot => {
        const data = snapshot.data();
        if(data && data.status === "ended") hangUp();
    });
}

async function hangUp() {
    document.getElementById('callOverlay').classList.remove('active');
    if(peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if(localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if(remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
        remoteStream = null;
    }
    if(callDocId) {
        const callDoc = doc(db, "calls", callDocId);
        try { await updateDoc(callDoc, { status: "ended" }); } catch (e) {}
        callDocId = null;
    }
}

function updateTimeAndBattery() {
    setInterval(() => {
        const d = new Date();
        document.getElementById('currentTime').innerText = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    }, 1000);
    if (navigator.getBattery) {
        navigator.getBattery().then(b => {
            const update = () => {
                const lvl = Math.round(b.level * 100);
                document.getElementById('batteryLevel').style.width = `${lvl}%`;
                document.getElementById('batteryPercent').innerText = `${lvl}%`;
            };
            update();
            b.addEventListener('levelchange', update);
        });
    }
}

init();