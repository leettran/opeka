/**
 * Main opeka module.
 *
 * This contains the core of the Opeka code encapsulated in the Server
 * object, so you can instance it from your own code if need be.
 */
"use strict";

// Load all our dependencies.
var _ = require("underscore"),
    async = require("async"),
    nowjs = require("now"),
    util = require("util"),
    uuid = require('node-uuid'),
    opeka = {
      rooms: require('./rooms'),
      user: require('./user')
    };


function Server(settings) {
  var self = this;

  self.construct = function () {
    self.settings = settings;

    // Configure the main web server.
    self.server = self.createServer(self.settings, function (req, res) {
      res.writeHead(200);
      res.write('Welcome to Opeka.');
      res.end();
    });
    self.server.listen(self.settings.httpPort);

    // Initialise Now.js on our server object.
    self.everyone = nowjs.initialize(self.server);

    // Create groups for councellors and guests.
    self.councellors = nowjs.getGroup('councellors');
    self.guests = nowjs.getGroup("guests");
    self.signedIn = nowjs.getGroup("signedIn");
  };

  /**
   * Create a server instance, HTTP or HTTPS depending on settings.
   */
  self.createServer = function (settings, callback) {
    if (settings.https) {
      return require('https').createServer(settings.https, callback);
    }
    else {
      return require('http').createServer(callback);
    }
  };

  // Update the client side guest/councellor counts.
  self.updateUserStatus = function (context) {
    // Getting the user count for groups is an async operation, so we
    // need to use async.parallel to marshall the results.
    async.parallel({
      councellors: function (callback) {
        self.councellors.count(function (count) {
          callback(null, count);
        });
      },
      guests: function (callback) {
        self.guests.count(function (count) {
          callback(null, count);
        });
      }
    }, function (err, results) {
      console.log('counted', results);

      if (results && _.isFunction(context.updateStatus)) {
        context.updateStatus(results);
      }
    });
  };

  // The following methods require Nowjs to be instantiated, so we need
  // to call the constructor here. That is bad form, but it requires
  // more refactoring to change that I care for right now.
  self.construct();

  /**
   * This function is called by the client when he's ready to load the chat.
   *
   * This usually means after loading client-side templates and other
   * resources required for the safe operation of the chat.
   */
  self.everyone.now.signIn = function (clientUser, callback) {
    var client = this;
    util.log(clientUser.nickname + ' connected.');

    opeka.user.authenticate(clientUser, function (err, account) {
      if (err) {
        throw err;
      }

      // Add the user to the signedIn group.
      self.signedIn.addUser(client.user.clientId);

      // Add the user to the overall group he belongs in.
      // This is important, since it governs what methods he has access
      // to, so only councellors can create rooms, etc.
      if (clientUser.statusOnly) {
        // In this case the user that is connected is only interested in the status of the chat.
        // This is 0 if not active, 1 if busy and 2 if open.
        client.now.receiveStatus(self.getCurrentStatus());

      } else if (account.isAdmin) {
        self.councellors.addUser(client.user.clientId);

        client.now.receiveRoomList(opeka.rooms.clientData(true));
      }
      else {
        self.guests.addUser(client.user.clientId);
        // The following is done in order to put each user in a single group.
        // In this way we are able to give to the counselors the ability to whisper
        nowjs.getGroup(client.user.clientId).addUser(client.user.clientId);


        // Store the location information for later use, if they have been defined.
        if (clientUser.address) {
          var add = clientUser.address.split(", ");
          client.user.city = add[0];
          client.user.state = add[1];
        }

        client.now.receiveRoomList(opeka.rooms.clientData());
      }

      // Store the account and nickname for later use.
      client.user.account = account;
      client.user.nickname = clientUser.nickname;
      client.user.gender = clientUser.gender;
      client.user.age = clientUser.age;

      // Update online users count for all clients.
      self.updateUserStatus(self.everyone.now);

      if (callback) {
        callback(account);
      }
    });
  };

  // Allow the councellors to pause a room.
  self.councellors.now.pauseRoom = function (roomId, callback) {
    var context = this;
    var room = opeka.rooms.list[roomId];

    if (room.paused) {
      console.log('User ' + this.user.clientId + ' tried to pause room ' + roomId + ' that was already paused.');
      callback("Error Pause: the room has already been paused.");
      return;
    } else {
      room.paused = true;
      self.everyone.now.roomUpdated(roomId, { paused: true });
      self.sendSystemMessage('[Pause]: Chat has been paused.', room.group);
      callback();
    }
  };

  // Allow the councellors to unpause a room.
  self.councellors.now.unpauseRoom = function (roomId, callback) {
    var context = this;
    var room = opeka.rooms.list[roomId];

    if (!room.paused) {
      console.log('User ' + this.user.clientId + ' tried to unpause room ' + roomId + ' that was not paused.');
      callback("Error Unpause: the room has not been paused.");
      return;
    } else {
      room.paused = false;
      self.everyone.now.roomUpdated(roomId, { paused: false });
      self.sendSystemMessage('[Pause]: Chat is available again.', room.group);
      callback();
    }
  };

  /* Function used by the counselors in order to kick an user out his room */
  self.councellors.now.kick = function (clientId, messageText, roomId) {
    // Get room.
    var room = opeka.rooms.list[roomId],
        roomGroup = nowjs.getGroup(roomId);
    // Tell that the user is being removed.
    roomGroup.now.roomUserKicked(roomId, clientId, messageText, self.everyone.users[clientId].user.nickname);
    // Remove the user.
    room.removeUser(clientId, function (users) {
      opeka.user.sendUserList(room.counsellorGroup, room.id, users);
    });
  };

  /* Function used in order to mute a single user */
  self.councellors.now.mute = function (roomId, clientId, messageText) {
    var room = opeka.rooms.list[roomId],
        roomGroup = nowjs.getGroup(roomId);
    // Mute the user.
    room.users[clientId].muted = true;
    // Tell the councellors about the muted user.
    opeka.user.sendUserList(room.counsellorGroup, room.id, room.users);
    // Tell the user that he was muted.
    roomGroup.now.roomUserMuted(roomId, clientId, room.users[clientId], this.user.nickname, messageText);
  };

  /* Function used in order to unmute a single user */
  self.councellors.now.unmute = function (roomId, clientId, messageText) {
    var room = opeka.rooms.list[roomId],
        roomGroup = nowjs.getGroup(roomId);
    // Mute the user.
    room.users[clientId].muted = false;
    // Tell the councellors about the muted user.
    opeka.user.sendUserList(room.counsellorGroup, room.id, room.users);
    // Tell the user that he was muted.
    roomGroup.now.roomUserUnmuted(roomId, clientId, room.users[clientId], this.user.nickname, messageText);
  };

  /* Function used by the counselors in order to whisper to an user */
  self.councellors.now.whisper = function (clientId, messageText) {
    var whisperClientId = this.user.clientId,
        whisperName = this.user.nickname,
        recieverName = self.everyone.users[clientId].user.nickname;
    // Send to user being whispered.
    self.everyone.users[clientId].now.roomRecieveWhisper(clientId, messageText, whisperName, true);
    // Send to counselor who did the whispering.
    this.now.roomRecieveWhisper(whisperClientId, messageText, recieverName, false);
  };

  // Called by the Counsellors in order to create a new room.
  self.councellors.now.createRoom = function (attributes, callback) {
    if (attributes.name.length > 0) {
      var room = new opeka.rooms.Room(attributes);

      if (callback) {
        callback(null, room.clientData());
      }

      // Send the new complete room list to connected users.
      if (room.private) {
        self.councellors.now.roomCreated(room.clientData());
      } else {
        self.everyone.now.roomCreated(room.clientData());
      }

    } else {
      callback("Error creating room: room name too short.");
    }
  };

  // This function is called by the Counsellors in order to delete a room from the system
  self.councellors.now.deleteRoom = function (roomId, finalMessage) {
    var room = opeka.rooms.list[roomId];

    if (room) {
      opeka.rooms.remove(roomId);
      self.everyone.now.roomDeleted(roomId, finalMessage);
    } else {
      this.now.displayError("Error deleting room: a room with the specified ID does not exist.");
    }
  };

    /* Function used in order to delete all messages of a single user */
    self.councellors.now.deleteAllMsg = function (clientId) {
      var room = opeka.rooms.get(this.user.activeRoomId);
      if (room) {
        room.group.now.localDeleteAllMsg(clientId);
      }
    };

    /* Function used in order to delete a single message */
    self.councellors.now.roomDeleteMessage = function (roomId, messageId) {
      var room = opeka.rooms.list[roomId];

      if (room) {
        room.group.now.messageDeleted(roomId, messageId);
      }
    };

    // This function is used by the clients in order to change rooms
    self.signedIn.now.changeRoom = function (roomId, callback, quit) {
      var client = this,
          serv = self,
          newRoom = opeka.rooms.list[roomId];

      // If the user was muted, unmute it.
      if (client.user.muted) {
        client.user.muted = false;
        client.now.localUnmute();
      }

      // Check if the room is full, if so, put the user on queue.
      //if (newRoom && newRoom.isFull() && callback) {
      //  return callback(true);
      //}

      // If user is already in a different room, leave it.
      if (opeka.rooms.list[client.user.activeRoomId]) {
        var oldRoom = opeka.rooms.get(client.user.activeRoomId);

        oldRoom.removeUser(client.user.clientId, function (users) {
          opeka.user.sendUserList(oldRoom.counsellorGroup, oldRoom.id, users);
        });

        serv.sendSystemMessage(client.user.nickname + " left the room.", oldRoom.group);

        if (quit) {
          client.now.quitRoom(callback);
        }
      }

    //trying to add the user, if this returns false the room is full or does not exists
    var addedUser;
    if (newRoom) {
      addedUser = newRoom.addUser(client.user, function(users) {
        opeka.user.sendUserList(newRoom.counsellorGroup, newRoom.id, users);
        opeka.user.sendActiveUser(client, newRoom.id, users[client.user.clientId]);
      });
    }

    if (addedUser === 'OK') {
      client.user.activeRoomId = roomId;
      serv.sendSystemMessage(client.user.nickname + " joined the room “" + newRoom.name + "”.", newRoom.group);

      if (newRoom.paused && !client.user.account.isAdmin) {
      client.now.localMute();

      process.nextTick(function () {
        serv.sendSystemMessage("[Warning] The room is paused.", client);
        });
      }
    }

    if (callback) {
      callback(addedUser);
    }
  };

  self.everyone.now.sendMessageToRoom = function (roomId, messageText) {
    var room = opeka.rooms.list[roomId],
        user = this.user,
        messageObj = {
          date: new Date(),
          message: messageText,
          name: user.nickname,
          messageId: uuid(),
          senderId: user.clientId
        };

    // Send the message if the sender is in the room.
    room.group.hasClient(this.user.clientId, function (inRoom) {
      if (inRoom && !user.muted) {
        room.group.now.receiveMessage(messageObj);
      }
    });
  };

  /**
   * When a client connects, let him know how many others are online.
   *
   * The client not counted as online until it calls clientReady.
   */
  self.everyone.on("connect", function () {
    self.updateUserStatus(this.now);
  });

  /**
   * When a client disconnects, we need to clean up after him.
   *
   * This includes closing open chats, letting others know he was
   * disconnected, etc.
   */
  self.everyone.on("disconnect", function () {
    var client = this;
    // We need to wait a single tick before updating the online counts,
    // since there's a bit of delay before they are accurate.
    process.nextTick(function () {

      // Leave the active room, if it is defined and it still exists.
      if (opeka.rooms.list[client.user.activeRoomId]) {
        var oldRoom = opeka.rooms.list[client.user.activeRoomId];

        oldRoom.removeUser(client.user.clientId, function(users) {
          self.sendSystemMessage(client.user.nickname + " left the room.", oldRoom.name);
          opeka.user.sendUserList(oldRoom.counsellorGroup, oldRoom.id, users);
        });

        client.user.activeRoomId = null;
      }

      self.updateUserStatus(self.everyone.now);
    });
  });

// -------- HELPERS -----------

  /**
   * Function used in order to send a system message.
   */
  self.sendSystemMessage = function(messageToSend, to) {
    var messageObj = {
      date: new Date(),
      message: messageToSend,
      system: true
    };
    to.now.receiveMessage(messageObj);
  };

  /* Function used in order to retrieve the status of the chat system*/
  self.getCurrentStatus = function() {
    var found;
    if (opeka.rooms.public_roomOrder.length === 0) {
      //No public room is active, the chat is not active
      return 0;
    } else {
      //check if any public room is not full
      found = false;

      opeka.rooms.public_roomOrder.forEach(function (roomId, index) {
        var room = opeka.rooms.get(roomId);

        if (room && !room.isFull()) {
          //there are room that are not full, then the chat is available
          found = true;
          return;
        }
      });

      if (found) {
        return 2;
      }
      return 1;
    }
  };

  return self;
}

module.exports = opeka;
module.exports.Server = Server;

