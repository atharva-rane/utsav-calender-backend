'use strict';

/** An error that carries an HTTP status and a message that is safe to show to the client. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Forward rejected promises from async route handlers to the error middleware. */
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

// Express recognises error middleware by its 4 arguments, so `next` must stay.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File is too large (max 5 MB)' });
  }
  console.error(err);
  return res.status(500).json({ error: 'Something went wrong' });
}

module.exports = { HttpError, asyncHandler, errorHandler };
