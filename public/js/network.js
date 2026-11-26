// Couche réseau : Socket.io, jeton de session local et reconnexion automatique.
const SESSION_KEY = 'tft_session_id';
const NAME_KEY = 'tft_player_name';

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible : la session ne survivra pas au rechargement */
  }
}

function newSessionId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 's' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class Network {
  constructor() {
    this.sessionId = storageGet(SESSION_KEY) || newSessionId();
    storageSet(SESSION_KEY, this.sessionId);
    this.handlers = {};
    this.socket = window.io({ transports: ['websocket', 'polling'] });
    this.socket.onAny((event, payload) => this.dispatch(event, payload));
    // À chaque (re)connexion, on tente de reprendre la partie en cours.
    this.socket.on('connect', () => {
      this.socket.emit('session:resume', { sessionId: this.sessionId });
      this.dispatch('net:connected', {});
    });
    this.socket.on('disconnect', () => this.dispatch('net:disconnected', {}));
  }

  get savedName() {
    return storageGet(NAME_KEY) || '';
  }

  saveName(name) {
    storageSet(NAME_KEY, name);
  }

  on(event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
  }

  dispatch(event, payload) {
    for (const fn of this.handlers[event] || []) fn(payload);
    for (const fn of this.handlers['*'] || []) fn(event, payload);
  }

  send(event, payload = {}) {
    this.socket.emit(event, { sessionId: this.sessionId, ...payload });
  }
}
