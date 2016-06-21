// Handles baning of users.
"use strict";

var crypto = require("crypto"),
    drupal = require("drupal"),
    util = require("util");

// In-memory cache of current bans.
var bans = {};

// Currently valid ban codes.
// To ban a user, a valid ban code must be specified. These are
// generated by admins and are stored here. They are not persisted
// across server restarts.
var banCodes = [];

// Get a digest from IP adress.
var getDigest = module.exports.getDigest = function (ip, salt) {
  var shasum = crypto.createHash('sha512');

  shasum.update(salt, 'utf-8');
  shasum.update(ip, 'utf-8');

  return shasum.digest('hex');
};

// Create a new ban.
module.exports.create = function (ip, salt) {
  var digest = getDigest(ip, salt);

  // Add the ban to the in-memory array so it's effective immediately.
  bans[digest] = true;

  // Add the ban to the database for persistance.
  drupal.db.query('INSERT INTO opeka_bans (ip_hash) VALUES (?)', [digest], function (err, result) {
    util.log('Info: User banned by admin.');
  });
};

// Check if an IP adress is banned.
module.exports.checkIP = function (ip, salt) {
  var digest = getDigest(ip, salt);

  return {
    digest: digest,
    isBanned: !!bans[digest],
  };
};

// Check if a ban code is valid.
module.exports.getCode = function () {
  var digest = crypto.createHash('md5').update(crypto.randomBytes(256)).digest('hex');

  banCodes.push(digest);

  return digest;
};

// Mark a ban code as invalid. Typically called when the ban code is used.
module.exports.invalidateCode = function (banCode) {
  delete banCodes[banCodes.indexOf(banCode)];
};

// Check if a ban code is valid.
module.exports.validCode = function (banCode) {
  return (banCodes.indexOf(banCode) !== -1);
};

// Load all current bans from the database.
module.exports.loadAll = function () {
  drupal.db.query('SELECT ip_hash FROM opeka_bans WHERE expiry IS NULL OR expiry > UNIX_TIMESTAMP()', [], function (err, result, fields) {
    result.forEach(function (row) {
      bans[row.ip_hash] = true;
    });
  });
};
