/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const isErrorConstructorName = require('./is-error-constructor-name');

// eslint-disable-next-line complexity
function isTimeoutError(err) {
  if (typeof err !== 'object') return false;

  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;

  // better-sqlite3 will return this error message as a TypeError
  if (err.message === 'This database connection is busy executing a query')
    return true;

  // in case database is locked, consider it a timeout error
  if (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED') return true;

  // redis/mongo connection errors should retry
  // and be considered a timeout error
  if (
    err.name === 'RedisError' ||
    err.name === 'MongooseServerSelectionError' ||
    err.name === 'MongoBulkWriteError' ||
    err.name === 'MongoNetworkError' ||
    err.name === 'MongoNetworkTimeoutError' ||
    err.name === 'PoolClearedOnNetworkError' ||
    err.name === 'MongoPoolClearedError' ||
    isErrorConstructorName(err, 'MongoNetworkError') ||
    isErrorConstructorName(err, 'MongoNetworkTimeoutError') ||
    isErrorConstructorName(err, 'MongoError') ||
    isErrorConstructorName(err, 'MongoBulkWriteError') ||
    isErrorConstructorName(err, 'PoolClearedOnNetworkError') ||
    isErrorConstructorName(err, 'MongoPoolClearedError') ||
    isErrorConstructorName(err, 'MongooseServerSelectionError') ||
    isErrorConstructorName(err, 'RedisError')
  )
    return true;

  for (const key of ['message', 'response']) {
    if (typeof err[key] !== 'string') continue;
    const str = err[key].toLowerCase();
    if (
      str.includes('request aborted') ||
      str.includes('timeout') ||
      str.includes('request time-out') ||
      str.includes('timeout - closing connection') ||
      str.includes('connection timed out')
    )
      return true;
  }

  return false;
}

module.exports = isTimeoutError;
