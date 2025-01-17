var process = require('process');
// Handle SIGINT
process.on('SIGINT', () => {
  console.info('SIGINT Received, exiting...');
  process.exit(0);
});

// Handle SIGTERM
process.on('SIGTERM', () => {
  console.info('SIGTERM Received, exiting...');
  process.exit(0);
});

const parser = require('ua-parser-js');
const { uniqueNamesGenerator, animals, colors } = require('unique-names-generator');

const GLOBAL_ROOM_NAME = '__GLOBAL_ROOM__';
const USE_GLOBAL_ROOM_BY_DEFAULT = process.env.USE_GLOBAL_ROOM_BY_DEFAULT === 'true';

class SnapdropServer {
  constructor(port) {
    const WebSocket = require('ws');
    this._wss = new WebSocket.Server({ port: port });
    this._wss.on('connection', (socket, request) => this._onConnection(new Peer(socket, request)));
    this._wss.on('headers', (headers, response) => this._onHeaders(headers, response));

    this._rooms = {};

    console.log('Snapdrop is running on port', port);
  }

  _onConnection(peer) {
    this._joinRoom(peer);
    peer.socket.on('message', (message) => this._onMessage(peer, message));
    peer.socket.on('error', console.error);
    this._keepAlive(peer);

    // send displayName
    this._send(peer, {
      type: 'display-name',
      message: {
        displayName: peer.name.displayName,
        deviceName: peer.name.deviceName,
      },
    });

    this._sendRoomToPeer(peer);
  }

  _onHeaders(headers, response) {
    if (response.headers.cookie && response.headers.cookie.indexOf('peerid=') > -1) return;
    response.peerId = Peer.uuid();
    headers.push('Set-Cookie: peerid=' + response.peerId + '; SameSite=Strict; Secure');
  }

  _onMessage(sender, message) {
    // Try to parse message
    try {
      message = JSON.parse(message);
    } catch (e) {
      return; // TODO: handle malformed JSON
    }

    switch (message.type) {
      case 'disconnect':
        this._leaveRoom(sender);
        break;
      case 'pong':
        sender.lastBeat = Date.now();
        break;
      case 'changeRoom':
        this._changeRoom(sender, message.roomState);
        break;
    }

    // relay message to recipient
    if (message.to && this._rooms[sender.getRoom()]) {
      const recipientId = message.to; // TODO: sanitize
      const recipient = this._rooms[sender.getRoom()][recipientId];
      delete message.to;
      // add sender id
      message.sender = sender.id;
      this._send(recipient, message);
      return;
    }
  }

  _joinRoom(peer) {
    // if room doesn't exist, create it
    if (!this._rooms[peer.getRoom()]) {
      this._rooms[peer.getRoom()] = {};
    }

    // notify all other peers
    for (const otherPeerId in this._rooms[peer.getRoom()]) {
      const otherPeer = this._rooms[peer.getRoom()][otherPeerId];
      this._send(otherPeer, {
        type: 'peer-joined',
        peer: peer.getInfo(),
      });
    }

    // notify peer about the other peers
    const otherPeers = [];
    for (const otherPeerId in this._rooms[peer.getRoom()]) {
      otherPeers.push(this._rooms[peer.getRoom()][otherPeerId].getInfo());
    }

    this._send(peer, {
      type: 'peers',
      peers: otherPeers,
    });

    // add peer to room
    this._rooms[peer.getRoom()][peer.id] = peer;
  }

  _leaveRoom(peer, terminate = true) {
    if (!this._rooms[peer.getRoom()] || !this._rooms[peer.getRoom()][peer.id]) return;
    if (terminate) {
      this._cancelKeepAlive(this._rooms[peer.getRoom()][peer.id]);
      peer.socket.terminate();
    }

    // delete the peer
    delete this._rooms[peer.getRoom()][peer.id];

    //if room is empty, delete the room
    if (!Object.keys(this._rooms[peer.getRoom()]).length) {
      delete this._rooms[peer.getRoom()];
    } else {
      // notify all other peers
      for (const otherPeerId in this._rooms[peer.getRoom()]) {
        const otherPeer = this._rooms[peer.getRoom()][otherPeerId];
        this._send(otherPeer, { type: 'peer-left', peerId: peer.id });
      }
    }
  }

  _changeRoom(peer, roomState) {
    this._leaveRoom(peer, false);
    peer.setRoom(roomState);
    this._joinRoom(peer);

    this._sendRoomToPeer(peer);
  }

  _sendRoomToPeer(peer) {
    this._send(peer, {
      type: 'room',
      message: {
        room: peer.room,
        useLocalRoom: peer.useLocalRoom,
      },
    });
  }

  _send(peer, message) {
    if (!peer) return;
    if (this._wss.readyState !== this._wss.OPEN) return;
    message = JSON.stringify(message);
    peer.socket.send(message, (error) => '');
  }

  _keepAlive(peer) {
    this._cancelKeepAlive(peer);
    var timeout = 30000;
    if (!peer.lastBeat) {
      peer.lastBeat = Date.now();
    }
    if (Date.now() - peer.lastBeat > 2 * timeout) {
      this._leaveRoom(peer);
      return;
    }

    this._send(peer, { type: 'ping' });

    peer.timerId = setTimeout(() => this._keepAlive(peer), timeout);
  }

  _cancelKeepAlive(peer) {
    if (peer && peer.timerId) {
      clearTimeout(peer.timerId);
    }
  }
}

class Peer {
  constructor(socket, request) {
    // set socket
    this.socket = socket;

    // set remote ip
    this._setIP(request);

    // set peer id
    this._setPeerId(request);
    // is WebRTC supported ?
    this.rtcSupported = request.url.indexOf('webrtc') > -1;
    // set name
    this._setName(request);
    // for keepalive
    this.timerId = 0;
    this.lastBeat = Date.now();
    // handle custom rooms
    this.room = GLOBAL_ROOM_NAME;
    this.useLocalRoom = !USE_GLOBAL_ROOM_BY_DEFAULT;
  }

  _setIP(request) {
    if (request.headers['x-forwarded-for']) {
      this.ip = request.headers['x-forwarded-for'].split(/\s*,\s*/)[0];
    } else {
      this.ip = request.connection.remoteAddress;
    }
    // IPv4 and IPv6 use different values to refer to localhost
    if (this.ip == '::1' || this.ip == '::ffff:127.0.0.1') {
      this.ip = '127.0.0.1';
    }
  }

  _setPeerId(request) {
    if (request.peerId) {
      this.id = request.peerId;
    } else {
      this.id = request.headers.cookie.replace('peerid=', '');
    }
  }

  toString() {
    return `<Peer id=${this.id} ip=${this.ip} rtcSupported=${this.rtcSupported}>`;
  }

  _setName(req) {
    let ua = parser(req.headers['user-agent']);

    let deviceName = '';

    if (ua.os && ua.os.name) {
      deviceName = ua.os.name.replace('Mac OS', 'Mac') + ' ';
    }

    if (ua.device.model) {
      deviceName += ua.device.model;
    } else {
      deviceName += ua.browser.name;
    }

    if (!deviceName) deviceName = 'Unknown Device';

    const displayName = uniqueNamesGenerator({
      length: 2,
      separator: ' ',
      dictionaries: [colors, animals],
      style: 'capital',
      seed: this.id.hashCode(),
    });

    this.name = {
      model: ua.device.model,
      os: ua.os.name,
      browser: ua.browser.name,
      type: ua.device.type,
      deviceName,
      displayName,
    };
  }

  getInfo() {
    return {
      id: this.id,
      name: this.name,
      rtcSupported: this.rtcSupported,
    };
  }

  getRoom() {
    if (this.useLocalRoom) {
      return this.ip;
    }
    return this.room;
  }

  setRoom({ room, useLocalRoom }) {
    this.room = String(room);
    this.useLocalRoom = Boolean(useLocalRoom);
  }

  // return uuid of form xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  static uuid() {
    let uuid = '',
      ii;
    for (ii = 0; ii < 32; ii += 1) {
      switch (ii) {
        case 8:
        case 20:
          uuid += '-';
          uuid += ((Math.random() * 16) | 0).toString(16);
          break;
        case 12:
          uuid += '-';
          uuid += '4';
          break;
        case 16:
          uuid += '-';
          uuid += ((Math.random() * 4) | 8).toString(16);
          break;
        default:
          uuid += ((Math.random() * 16) | 0).toString(16);
      }
    }
    return uuid;
  }
}

Object.defineProperty(String.prototype, 'hashCode', {
  value: function () {
    var hash = 0,
      i,
      chr;
    for (i = 0; i < this.length; i++) {
      chr = this.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return hash;
  },
});

const server = new SnapdropServer(process.env.PORT || 3000);
