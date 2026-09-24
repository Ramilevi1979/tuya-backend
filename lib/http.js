'use strict';

/** An error whose message is safe to show to the person using the app. */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.publicMessage = message;
  return err;
}

/** Lets async route handlers throw; Express 4 needs the rejection forwarded. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { httpError, wrap };
