'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var slice = Array.prototype.slice;

/**
 * Simple event dispatcher
 */
var EventDispatcher = function EventDispatcher() {
  // Define a non-enumerable "private" property to hold all event listeners
  Object.defineProperty(this, '_events', { configurable: true, writable: true, value: {} });
};

/**
 * Adds an event listener
 */
EventDispatcher.prototype.on = function on (type, listener) {
  this._events[type] = getEventListeners(this, type).concat([listener]);
  return this;
};

/**
 * Adds an event listener to be triggered only once
 */
EventDispatcher.prototype.once = function once (type, listener) {
  this.on(type, function wrap() {
    this.off(type, wrap);
    listener.apply(this, arguments);
  });
  return this;
};

/**
 * Removes a previously added event listener
 */
EventDispatcher.prototype.off = function off (type, listener) {
  this._events[type] = getEventListeners(this, type).filter(function(l) {
    return l !== listener;
  });
  return this;
};

/**
 * Dispatches an event calling all listeners with the given args (minus type).
 */
EventDispatcher.prototype.dispatchEvent = function dispatchEvent (type /*[, args]*/) {
  var args = slice.call(arguments, 1);
  getEventListeners(this, type).forEach(function(listener) {
    listener.apply(this, args);
  }, this);
  return this;
};

/**
 * Dispatches an event but stops on the first listener to return false. Returns true if no listeners cancel the
 * action. Use for "cancelable" actions to check if they can be performed.
 */
EventDispatcher.prototype.dispatchCancelableEvent = function dispatchCancelableEvent (type /*[, args]*/) {
  var args = slice.call(arguments, 1);
  return getEventListeners(this, type).every(function(listener) {
    return listener.apply(this, args) !== false;
  }, this);
};

EventDispatcher.prototype.removeAllEvents = function removeAllEvents () {
  this._events = {};
};


/**
 * Get the listeners for the given object by the given event type.
 */
function getEventListeners(obj, type) {
  var listeners = obj._events[type];
  if (!listeners) {
    obj._events[type] = listeners = [];
  }
  return listeners;
}

var maxString = String.fromCharCode(65535);
var localStorage = window.localStorage;
var noop = function (data) { return data; };


/**
 * A nice promise-based syntax on indexedDB also providing events when open, closed, and whenever data is changed.
 * Dispatches the change events even when the change did not originate in this browser tab.
 *
 * Versioning is simplified. You provide a string of new indexes for each new version, with the first being the primary
 * key. For primary keys, use a "++" prefix to indicate auto-increment, leave it empty if the key isn't part of the
 * object. For indexes, use a "-" index to delete a defined index, use "&" to indicate a unique index, use "*" for a
 * multiEntry index, and use "[field + anotherField]" for compound indexes. Examples:
 *
 * // Initial version, should remain the same with updates
 * db.version(1, {
 *   friends: 'fullName, age'
 * });
 *
 * // Next version, we don't add any indexes, but we want to run our own update code to prepopulate the database
 * db.version(2, {}, function(oldVersion, transaction) {
 *   // prepopulate with some initial data
 *   transaction.objectStore('friends').put({ fullName: 'Tom' });
 * });
 *
 * // Remove the age index and add one for birthdate, add another object store with an auto-incrementing primary key
 * // that isn't part of the object, and a multiEntry index on the labels array.
 * db.version(3, {
 *   friends: 'birthdate, -age, [lastName + firstName]',
 *   events: '++, date, *labels'
 * });
 *
 *
 * After the database is opened, a property will be added to the database instance for each object store in the
 * database. This is how you will work with the data in the database. For e.g.
 *
 * db.version(1, { foo: 'id' });
 *
 * // Will be triggered once for any add, put, or delete done in any browser tab. The object will be null when it was
 * // deleted, so use the key when object is null.
 * db.on('change', (object, key) => {
 *   console.log('Object with key', key, 'was', object === null ? 'deleted' : 'saved');
 * });
 *
 * db.open().then(() => {
 *   db.foo.put({ id: 'bar' }).then(() => {
 *     console.log('An object was saved to the database.');
 *   });
 * }, err => {
 *   console.warn('There was an error opening the database:', err);
 * });
 */
var Browserbase = /*@__PURE__*/(function (EventDispatcher) {
  function Browserbase(name, parentDb) {
    EventDispatcher.call(this);
    this.name = name;
    this.db = null;
    this.parentDb = parentDb;
    this._dispatchRemote = false;
    this._current = null;
    this._versionMap = {};
    this._versionHandlers = {};
    this._onStorage = null;
  }

  if ( EventDispatcher ) Browserbase.__proto__ = EventDispatcher;
  Browserbase.prototype = Object.create( EventDispatcher && EventDispatcher.prototype );
  Browserbase.prototype.constructor = Browserbase;

  /**
   * Defines a version for the database. Additional versions may be added, but existing version should not be changed.
   * @param  {Number} version           The version number
   * @param  {Object} stores            An object with store name as the key and a comma-delimited string of indexes
   * @param  {Function} upgradeFunction An optional function that will be called when upgrading, used for data updates
   * @return {Browserbase}                A reference to itself
   */
  Browserbase.deleteDatabase = function deleteDatabase (name) {
    return requestToPromise(window.indexedDB.deleteDatabase(name));
  };

  Browserbase.prototype.version = function version (version$1, stores, upgradeFunction) {
    this._versionMap[version$1] = stores;
    if (upgradeFunction) {
      this._versionHandlers[version$1] = upgradeFunction;
    }
    return this;
  };

  /**
   * Returns a list of the defined versions.
   */
  Browserbase.prototype.getVersions = function getVersions () {
    var this$1 = this;

    return Object.keys(this._versionMap).map(function (key) {
      return { version: parseInt(key), stores: this$1._versionMap[key], upgradeFunction: this$1._versionHandlers[key] };
    });
  };

  /**
   * Whether this database is open or closed.
   * @return {Boolean}
   */
  Browserbase.prototype.isOpen = function isOpen () {
    return Boolean(this.db);
  };

  /**
   * Open a database, call this after defining versions.
   * @return {Promise}
   */
  Browserbase.prototype.open = function open () {
    var this$1 = this;

    if (this._opening) {
      return this._opening;
    }

    if (!Object.keys(this._versionMap).length) {
      return Promise.reject(new Error('Must declare at least a version 1 schema for Browserbase'));
    }

    var version = Object.keys(this._versionMap).map(function (key) { return parseInt(key); }).sort(function (a, b) { return a - b; }).pop();
    var upgradedFrom = null;

    return this._opening = new Promise(function (resolve, reject) {
      var request = window.indexedDB.open(this$1.name, version);
      request.onsuccess = successHandler(resolve);
      request.onerror = errorHandler(reject, this$1);
      request.onupgradeneeded = function (event) {
        this$1.db = request.result;
        this$1.db.onerror = errorHandler(reject, this$1);
        this$1.db.onabort = errorHandler(function () { return reject(new Error('Abort')); }, this$1);
        var oldVersion = event.oldVersion > Math.pow(2, 62) ? 0 : event.oldVersion; // Safari 8 fix.
        upgradedFrom = oldVersion;
        upgrade(oldVersion, request.transaction, this$1.db, this$1._versionMap, this$1._versionHandlers, this$1);
      };
    }).then(function (db) {
      this$1.db = db;
      onOpen(this$1);
      if (upgradedFrom === 0) { this$1.dispatchEvent('create'); }
      else if (upgradedFrom) { this$1.dispatchEvent('upgrade', upgradedFrom); }
      this$1.dispatchEvent('open');
    });
  };

  /**
   * Closes the database.
   */
  Browserbase.prototype.close = function close () {
    if (!this.db) { return; }
    this.db.close();
    this._opening = undefined;
    onClose(this);
  };

  /**
   * Deletes this database.
   */
  Browserbase.prototype.deleteDatabase = function deleteDatabase () {
    return Browserbase.deleteDatabase(this.name);
  };

  /**
   * Starts a multi-store transaction. All store methods on the returned database clone will be part of this transaction
   * until the next tick or until calling db.commit().
   * @param  {Array} storeNames  Array of all the store names which will be used within this transaction
   * @param  {String} mode       The mode, defaults to readwrite unlike the indexedDB API
   * @return {BrowserDB}         A temporary copy of BrowserDB to be used for this transaction only
   */
  Browserbase.prototype.start = function start (storeNames, mode) {
    var this$1 = this;
    if ( mode === void 0 ) mode = 'readwrite';

    if (!storeNames) { storeNames = this.db.objectStoreNames; }
    if (this._current) { throw new Error('Cannot start a new transaction on an existing transaction browserbase'); }

    var db = new this.constructor(this.name, this);
    db.db = this.db;
    Object.keys(this).forEach(function (key) {
      var store = this$1[key];
      if (!(store instanceof ObjectStore)) { return; }
      db[key] = new ObjectStore(db, store.name, store.keyPath);
    });

    try {
      var trans = db._current = storeNames instanceof IDBTransaction
        ? storeNames
        : this.db.transaction(safariMultiStoreFix(storeNames), mode);
      trans.promise = requestToPromise(trans, null, db).then(function (result) {
        if (db._current === trans) { db._current = null; }
        return result;
      }, function (err) {
        if (db._current === trans) { db._current = null; }
        this$1.dispatchEvent('error', err);
        return Promise.reject(err);
      });
    } catch (err) {
      Promise.resolve().then(function () {
        this$1.dispatchEvent('error', err);
      });
      throw err;
    }

    return db;
  };

  /**
   * Finishes a started transaction so that other transactions may be run. This is not needed for a transaction to run,
   * but it allows other transactions to be run in this thread. It ought to be called to avoid conflicts with other
   * code elsewhere.
   * @return {Promise} The same promise returned by start() which will resolve once the transaction is done.
   */
  Browserbase.prototype.commit = function commit (options) {
    var this$1 = this;

    if (!this._current) { throw new Error('There is no current transaction to commit.'); }
    var promise = this._current.promise;
    if (options && options.remoteChange) {
      this._dispatchRemote = true;
      promise.then(function () { return this$1._dispatchRemote = false; });
    }
    this._current = null;
    return promise;
  };

  /**
   * Dispatches a change event when an object is being added, saved, or deleted. When deleted, the object will be null.
   * @param {ObjectStore} store  The object store this object is stored in
   * @param {Object}      obj    The object being modified or null if the object is deleted
   * @param {mixed}       key    The key of the object being changed or deleted
   * @param {String}      from   The source of this event, whether it was from the 'local' window or a 'remote' window
   */
  Browserbase.prototype.dispatchChange = function dispatchChange (store, obj, key, from, dispatchRemote) {
    if ( from === void 0 ) from = 'local';
    if ( dispatchRemote === void 0 ) dispatchRemote = false;

    var declaredFrom = this._dispatchRemote || dispatchRemote ? 'remote' : from;
    this[store.name].dispatchEvent('change', obj, key, declaredFrom);
    this.dispatchEvent('change', store.name, obj, key, declaredFrom);

    if (this.parentDb) {
      this.parentDb.dispatchChange(store, obj, key, from, this._dispatchRemote);
    } else if (from === 'local') {
      var itemKey = "browserbase/" + (this.name) + "/" + (store.name);
      // Stringify the key since it could be a string, number, or even an array
      localStorage.setItem(itemKey, JSON.stringify(key));
      localStorage.removeItem(itemKey);
    }
  };

  /**
   * Dispatch an error event.
   */
  Browserbase.prototype.dispatchError = function dispatchError (err) {
    this.dispatchEvent('error', err);
    if (this.parentDb) {
      this.dispatchEvent('error', err);
    }
  };

  /**
   * Creates or updates a store with the given indexesString. If null will delete the store.
   * @param  {String} storeName     The store name
   * @param  {String} indexesString The string definition of the indexes to add to the store
   * @return {Promise}           Resolves with an array which is the return result of each iteration
   */
  Browserbase.prototype.upgradeStore = function upgradeStore$1 (storeName, indexesString) {
    if (!this._current) { return this.start().upgradeStore(storeName, indexesString); }
    upgradeStore(this.db, this._current, storeName, indexesString);
  };

  return Browserbase;
}(EventDispatcher));


/**
 * An abstraction on object stores, allowing to more easily work with them without needing to always explicitly create a
 * transaction first. Also helps with ranges and indexes and promises.
 */
var ObjectStore = /*@__PURE__*/(function (EventDispatcher) {
  function ObjectStore(db, name, keyPath) {
    EventDispatcher.call(this);
    this.db = db;
    this.name = name;
    this.keyPath = keyPath;
    this.store = noop;
    this.revive = noop;
  }

  if ( EventDispatcher ) ObjectStore.__proto__ = EventDispatcher;
  ObjectStore.prototype = Object.create( EventDispatcher && EventDispatcher.prototype );
  ObjectStore.prototype.constructor = ObjectStore;

  ObjectStore.prototype._transStore = function _transStore (mode) {
    var this$1 = this;

    try {
      var trans = this.db._current || this.db.db.transaction(this.name, mode);
      return trans.objectStore(this.name);
    } catch (err) {
      Promise.resolve().then(function () {
        this$1.db.dispatchEvent('error', err);
      });
      throw err;
    }
  };

  /**
   * Dispatches a change event.
   */
  ObjectStore.prototype.dispatchChange = function dispatchChange (obj, key) {
    this.db.dispatchChange(this, obj, key);
  };

  /**
   * Dispatch an error event.
   */
  ObjectStore.prototype.dispatchError = function dispatchError (err) {
    this.db.dispatchError(err);
  };

  /**
   * Get an object from the store by its primary key
   * @param  {mixed} id The key of the object being retreived
   * @return {Promise}  Resolves with the object being retreived
   */
  ObjectStore.prototype.get = function get (key) {
    return requestToPromise(this._transStore('readonly').get(key), null, this).then(this.revive);
  };

  /**
   * Get all objects in this object store. To get only a range, use where()
   * @return {Promise} Resolves with an array of objects
   */
  ObjectStore.prototype.getAll = function getAll () {
    var this$1 = this;

    return requestToPromise(this._transStore('readonly').getAll(), null, this)
      .then(function (results) { return results.map(this$1.revive); });
  };

  /**
   * Gets the count of all objects in this store
   * @return {Promise} Resolves with a number
   */
  ObjectStore.prototype.count = function count () {
    return requestToPromise(this._transStore('readonly').count(), null, this);
  };

  /**
   * Adds an object to the store. If an object with the given key already exists, it will not overwrite it.
   * @param {Object} obj The object you want to add to the store
   * @param {mixed} key Optional, the key of the object when it is not part of the object fields
   * @return {Promise}
   */
  ObjectStore.prototype.add = function add (obj, key) {
    var this$1 = this;

    var store = this._transStore('readwrite');
    return requestToPromise(store.add(this.store(obj), key), store.transaction, this).then(function (key) {
      this$1.dispatchChange(obj, key);
      return key;
    });
  };

  /**
   * Adds an array of objects to the store in once transaction. You can also call startTransaction and use add().
   * @param {Array} array The array of objects you want to add to the store
   * @return {Promise}
   */
  ObjectStore.prototype.addAll = function addAll (array) {
    var this$1 = this;

    var store = this._transStore('readwrite');
    return Promise.all(array.map(function (obj) {
      return requestToPromise(store.add(this$1.store(obj)), store.transaction, this$1).then(function (key) {
        this$1.dispatchChange(obj, key);
      });
    }));
  };

  /**
   * Adds an array of objects to the store in once transaction. You can also call startTransaction and use add(). Alias
   * of addAll().
   * @param {Array} array The array of objects you want to add to the store
   * @return {Promise}
   */
  ObjectStore.prototype.bulkAdd = function bulkAdd (array) {
    return this.addAll(array);
  };

  /**
   * Saves an object to the store. If an object with the given key already exists, it will overwrite it.
   * @param {Object} obj The object you want to add to the store
   * @param {mixed} key Optional, the key of the object when it is not part of the object fields
   * @return {Promise}
   */
  ObjectStore.prototype.put = function put (obj, key) {
    var this$1 = this;

    var store = this._transStore('readwrite');
    return requestToPromise(store.put(this.store(obj), key), store.transaction, this).then(function (key) {
      this$1.dispatchChange(obj, key);
      return key;
    });
  };

  /**
   * Saves an array of objects to the store in once transaction. You can also call startTransaction and use put().
   * @param {Array} array The array of objects you want to save to the store
   * @return {Promise}
   */
  ObjectStore.prototype.putAll = function putAll (array) {
    var this$1 = this;

    var store = this._transStore('readwrite');
    return Promise.all(array.map(function (obj) {
      return requestToPromise(store.put(this$1.store(obj)), store.transaction, this$1).then(function (key) {
        this$1.dispatchChange(obj, key);
      });
    }));
  };

  /**
   * Saves an array of objects to the store in once transaction. You can also call startTransaction and use put(). Alias
   * of putAll().
   * @param {Array} array The array of objects you want to save to the store
   * @return {Promise}
   */
  ObjectStore.prototype.bulkPut = function bulkPut (array) {
    return this.putAll(array);
  };

  /**
   * Deletes an object from the store.
   * @param {mixed} key The key of the object to delete.
   * @return {Promise}
   */
  ObjectStore.prototype.delete = function delete$1 (key) {
    var this$1 = this;

    var store = this._transStore('readwrite');
    return requestToPromise(store.delete(key), store.transaction, this).then(function () {
      this$1.dispatchChange(null, key);
    });
  };

  /**
   * Deletes all objects from a store.
   * @return {Promise}
   */
  ObjectStore.prototype.deleteAll = function deleteAll () {
    return this.where().deleteAll();
  };

  /**
   * Use to get a subset of items from the store by id or index. Returns a Where object to allow setting the range and
   * limit.
   * @param  {String} index The key or index that will be used to retreive the range of objects
   * @return {Where}        A Where instance associated with this object store
   */
  ObjectStore.prototype.where = function where (index) {
    if ( index === void 0 ) index = '';

    index = index.replace(/\s/g, '');
    return new Where(this, index === this.keyPath ? '' : index);
  };

  return ObjectStore;
}(EventDispatcher));


/**
 * Helps with a ranged getAll or openCursor by helping to create the range and providing a nicer API with returning a
 * promise or iterating through with a callback.
 */
var Where = function Where(store, index) {
  this.store = store;
  this.index = index;
  this._upper = undefined;
  this._lower = undefined;
  this._upperOpen = false;
  this._lowerOpen = false;
  this._value = undefined;
  this._limit = undefined;
  this._direction = 'next';
};

/**
 * Dispatches a change event.
 */
Where.prototype.dispatchChange = function dispatchChange (obj, key) {
  this.store.dispatchChange(obj, key);
};

/**
 * Dispatch an error event.
 */
Where.prototype.dispatchError = function dispatchError (err) {
  this.store.dispatchError(err);
};

/**
 * Set greater than the value provided.
 * @param{mixed} value The lower bound
 * @return {Where}     Reference to this
 */
Where.prototype.startsAfter = function startsAfter (value) {
  this._lower = value;
  this._lowerOpen = true;
  return this;
};

/**
 * Set greater than or equal to the value provided.
 * @param{mixed} value The lower bound
 * @return {Where}     Reference to this
 */
Where.prototype.startsAt = function startsAt (value) {
  this._lower = value;
  this._lowerOpen = false;
  return this;
};

/**
 * Set less than the value provided.
 * @param{mixed} value The upper bound
 * @return {Where}     Reference to this
 */
Where.prototype.endsBefore = function endsBefore (value) {
  this._upper = value;
  this._upperOpen = true;
  return this;
};

/**
 * Set less than or equal to the value provided.
 * @param{mixed} value The upper bound
 * @return {Where}     Reference to this
 */
Where.prototype.endsAt = function endsAt (value) {
  this._upper = value;
  this._upperOpen = false;
  return this;
};

/**
 * Set the exact match, no range.
 * @param{mixed} value The value that needs matching on
 * @return {Where}     Reference to this
 */
Where.prototype.equals = function equals (value) {
  this._value = value;
  return this;
};

/**
 * Sets the upper and lower bounds to match any string starting with this prefix.
 * @param{String} prefix The string prefix
 * @return {Where}       Reference to this
 */
Where.prototype.startsWith = function startsWith (prefix) {
  return this.startsAt(prefix).endsAt(Array.isArray(prefix) ? prefix.concat([[]]) : prefix + maxString);
};

/**
 * Limit the return results to the given count.
 * @param{Number} count The max number of objects to return
 * @return {Where}      Reference to this
 */
Where.prototype.limit = function limit (count) {
  this._limit = count;
  return this;
};

/**
 * Reverses the direction a cursor will get things.
 * @return {Where} Reference to this
 */
Where.prototype.reverse = function reverse () {
  this._direction = 'prev';
  return this;
};

/**
 * Converts this Where to its IDBKeyRange equivalent.
 * @return {IDBKeyRange} The range this Where represents
 */
Where.prototype.toRange = function toRange () {
  if (this._upper !== undefined && this._lower !== undefined) {
    return IDBKeyRange.bound(this._lower, this._upper, this._lowerOpen, this._upperOpen);
  } else if (this._upper !== undefined) {
    return IDBKeyRange.upperBound(this._upper, this._upperOpen);
  } else if (this._lower !== undefined) {
    return IDBKeyRange.lowerBound(this._lower, this._lowerOpen);
  } else if (this._value !== undefined) {
    return IDBKeyRange.only(this._value);
  }
};

/**
 * Get all the objects matching the range limited by the limit.
 * @return {Promise} Resolves with an array of objects
 */
Where.prototype.getAll = function getAll () {
    var this$1 = this;

  var range = this.toRange();
  // Handle reverse with cursor
  if (this._direction === 'prev') {
    var results = [];
    if (this._limit <= 0) { return Promise.resolve(results); }
    return this.forEach(function (obj) { return results.push(this$1.store.revive(obj)); }).then(function () { return results; });
  }

  var store = this.store._transStore('readonly');
  var source = this.index ? store.index(this.index) : store;
  return requestToPromise(source.getAll(range, this._limit), null, this)
    .then(function (results) { return results.map(this$1.store.revive); });
};

/**
 * Get all the keys matching the range limited by the limit.
 * @return {Promise} Resolves with an array of objects
 */
Where.prototype.getAllKeys = function getAllKeys () {
  var range = this.toRange();
  // Handle reverse with cursor
  if (this._direction === 'prev') {
    var results = [];
    if (this._limit <= 0) { return Promise.resolve(results); }
    return this.cursor(function (cursor) { return results.push(cursor.key); }, 'readonly', true).then(function () { return results; });
  }

  var store = this.store._transStore('readonly');
  var source = this.index ? store.index(this.index) : store;
  return requestToPromise(source.getAllKeys(range, this._limit), null, this);
};

/**
 * Gets a single object, the first one matching the criteria
 * @return {Promise} Resolves with an object or undefined if none was found
 */
Where.prototype.get = function get () {
    var this$1 = this;

  return this.limit(1).getAll().then(function (result) { return this$1.store.revive(result[0]); });
};

/**
 * Gets a single key, the first one matching the criteria
 * @return {Promise} Resolves with an object or undefined if none was found
 */
Where.prototype.getKey = function getKey () {
  // Allow reverse() to be used by going through the getAllKeys method
  return this.limit(1).getAllKeys().then(function (result) { return result[0]; });
};

/**
 * Gets the count of the objects matching the criteria
 * @return {Promise} Resolves with a number
 */
Where.prototype.count = function count () {
  var range = this.toRange();
  var store = this.store._transStore('readonly');
  var source = this.index ? store.index(this.index) : store;
  return requestToPromise(source.count(range), null, this);
};

/**
 * Deletes all the objects within this range.
 * @return {Promise} Resolves without result when finished
 */
Where.prototype.deleteAll = function deleteAll () {
    var this$1 = this;

  // Uses a cursor to delete so that each item can get a change event dispatched for it
  return this.map(function (object, cursor, trans) {
    var key = cursor.primaryKey;
    return requestToPromise(cursor.delete(), trans, this$1).then(function () {
      this$1.dispatchChange(null, key);
    });
  }, 'readwrite').then(function (promises) { return Promise.all(promises); }).then(function () {});
};

/**
 * Uses a cursor to efficiently iterate over the objects matching the range calling the iterator for each one.
 * @param{Function} iterator A function which will be called for each object with the (object, cursor) signature
 * @return {Promise}         Resolves without result when the cursor has finished
 */
Where.prototype.cursor = function cursor (iterator, mode, keyCursor) {
    var this$1 = this;
    if ( mode === void 0 ) mode = 'readonly';
    if ( keyCursor === void 0 ) keyCursor = false;

  return new Promise(function (resolve, reject) {
    var range = this$1.toRange();
    var store = this$1.store._transStore(mode);
    var source = this$1.index ? store.index(this$1.index) : store;
    var method = keyCursor ? 'openKeyCursor' : 'openCursor';
    var request = source[method](range, this$1._direction);
    var count = 0;
    request.onsuccess = function (event) {
      var cursor = event.target.result;
      if (cursor) {
        var result = iterator(cursor, store.transaction);
        if (this$1._limit !== undefined && ++count >= this$1._limit) { result = false; }
        if (result !== false) { cursor.continue(); }
        else { resolve(); }
      } else {
        resolve();
      }
    };
    request.onerror = errorHandler(reject, this$1);
  });
};

/**
 * Updates objects using a cursor to update many objects at once matching the range.
 * @param{Function} iterator A function which will be called for each object and which should return the new value
 * for the object, undefined if no changes should be made, or null if the object should be deleted.
 * @return {Promise}         Resolves without result when finished
 */
Where.prototype.update = function update (iterator) {
    var this$1 = this;

  var ref = this.store;
    var store = ref.store;
    var revive = ref.revive;
  return this.map(function (object, cursor, trans) {
    var key = cursor.primaryKey;
    var newValue = iterator(object, cursor);
    if (newValue === null) {
      return requestToPromise(cursor.delete(), trans, this$1).then(function () {
        this$1.dispatchChange(null, key);
      });
    } else if (newValue !== undefined) {
      return requestToPromise(cursor.update(this$1.store.store(newValue)), trans, this$1).then(function () {
        this$1.dispatchChange(newValue, key);
      });
    } else {
      return undefined;
    }
  }, 'readwrite').then(function (promises) { return Promise.all(promises); }).then(function () {});
};

/**
 * Uses a cursor to efficiently iterate over the objects matching the range calling the iterator for each one.
 * @param{Function} iterator A function which will be called for each object with the (object, cursor) signature
 * @return {Promise}         Resolves without result when the cursor has finished
 */
Where.prototype.forEach = function forEach (iterator, mode) {
    var this$1 = this;
    if ( mode === void 0 ) mode = 'readonly';

  return this.cursor(function (cursor, trans) {
    iterator(this$1.store.revive(cursor.value), cursor, trans);
  }, mode);
};

/**
 * Uses a cursor to efficiently iterate over the objects matching the range calling the iterator for each one and
 * returning the results of the iterator in an array.
 * @param{Function} iterator A function which will be called for each object with the (object, cursor) signature
 * @return {Promise}         Resolves with an array which is the return result of each iteration
 */
Where.prototype.map = function map (iterator, mode) {
    if ( mode === void 0 ) mode = 'readonly';

  var results = [];
  return this.forEach(function (object, cursor, trans) {
    results.push(iterator(object, cursor, trans));
  }, mode).then(function () { return results; });
};



function requestToPromise(request, transaction, errorDispatcher) {
  return new Promise(function (resolve, reject) {
    if (transaction) {
      if (!transaction.promise) { transaction.promise = requestToPromise(transaction, null, errorDispatcher); }
      transaction.promise = transaction.promise.then(function () { return resolve(request.result); }, function (err) {
        reject(request.error || err);
        return Promise.reject(err);
      });
    } else if (request.onsuccess === null) {
      request.onsuccess = successHandler(resolve);
    }
    if (request.oncomplete === null) { request.oncomplete = successHandler(resolve); }
    if (request.onerror === null) { request.onerror = errorHandler(reject, errorDispatcher); }
    if (request.onabort === null) { request.onabort = function () { return reject(new Error('Abort')); }; }
  });
}

function successHandler(resolve) {
  return function (event) { return resolve(event.target.result); };
}

function errorHandler(reject, errorDispatcher) {
  return function (event) {
    reject(event.target.error);
    errorDispatcher && errorDispatcher.dispatchError(event.target.error);
  };
}

function safariMultiStoreFix(storeNames) {
  return storeNames.length === 1 ? storeNames[0] : storeNames;
}


function upgrade(oldVersion, transaction, db, versionMap, versionHandlers, browserbase) {
  var versions = Object.keys(versionMap).map(function (key) { return parseInt(key); }).sort(function (a, b) { return a - b; });
  versions.forEach(function (version) {
    if (version <= oldVersion) { return; }
    var stores = versionMap[version];
    Object.keys(stores).forEach(function (name) {
      var indexesString = stores[name];
      upgradeStore(db, transaction, name, indexesString);
    });

    var handler = versionHandlers[version];
    if (handler) {
      // Ensure browserbase has the current object stores for working with in the handler
      addStores(browserbase, db, transaction);
      handler(oldVersion, transaction);
    }
  });
}


function upgradeStore(db, transaction, storeName, indexesString) {
  var indexes = indexesString && indexesString.split(/\s*,\s*/);
  var store;

  if (indexesString === null) {
    db.deleteObjectStore(storeName);
    return;
  }

  if (db.objectStoreNames.contains(storeName)) {
    store = transaction.objectStore(storeName);
  } else {
    store = db.createObjectStore(storeName, getStoreOptions(indexes.shift()));
  }

  indexes.forEach(function (name) {
    if (!name) { return; }
    if (name[0] === '-') { return store.deleteIndex(name.replace(/^-[&*]?/, '')); }

    var options = {};

    name = name.replace(/\s/g, '');
    if (name[0] === '&') {
      name = name.slice(1);
      options.unique = true;
    } else if (name[0] === '*') {
      name = name.slice(1);
      options.multiEntry = true;
    }
    var keyPath = name[0] === '[' ? name.replace(/^\[|\]$/g, '').split(/\+/) : name;
    store.createIndex(name, keyPath, options);
  });
}


function onOpen(browserbase) {
  var db = browserbase.db;

  db.onversionchange = function (event) {
    if (browserbase.dispatchCancelableEvent('versionchange')) {
      if (event.newVersion > 0) {
        console.warn(("Another connection wants to upgrade database '" + (browserbase.name) + "'. Closing db now to resume the upgrade."));
      } else {
        console.warn(("Another connection wants to delete database '" + (browserbase.name) + "'. Closing db now to resume the delete request."));
      }
      browserbase.close();
    }
  };
  db.onblocked = function (event) {
    if (browserbase.dispatchCancelableEvent('blocked')) {
      if (!event.newVersion || event.newVersion < event.oldVersion) {
        console.warn(("Browserbase.delete('" + (browserbase.name) + "') was blocked"));
      } else {
        console.warn(("Upgrade '" + (browserbase.name) + "' blocked by other connection holding version " + (event.oldVersion)));
      }
    }
  };
  db.onclose = function () { return onClose(browserbase); };
  db.onerror = function (event) { return browserbase.dispatchEvent('error', event.target.error); };
  var prefix = "browserbase/" + (browserbase.name) + "/";
  browserbase._onStorage = function (event) {
    if (event.storageArea !== localStorage) { return; }
    if (event.newValue === null || event.newValue === '') { return; }
    if (event.key.slice(0, prefix.length) !== prefix) { return; }
    try {
      var storeName = event.key.replace(prefix, '');
      var key = JSON.parse(event.newValue);
      var store = browserbase[storeName];
      if (store) {
        store.get(key).then(function (object) {
          if ( object === void 0 ) object = null;

          browserbase.dispatchChange(store, object, key, 'remote');
        });
      } else {
        console.warn(("A change event came from another tab for store \"" + storeName + "\", but no such store exists."));
      }
    } catch (err) {
      console.warn('Error parsing object change from browserbase:', err);
    }
  };

  window.addEventListener('storage', browserbase._onStorage);

  // Store keyPath's for each store
  addStores(browserbase, db, db.transaction(safariMultiStoreFix(db.objectStoreNames), 'readonly'));
}


function addStores(browserbase, db, transaction) {
  var names = db.objectStoreNames;
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    browserbase[name] = new ObjectStore(browserbase, name, transaction.objectStore(name).keyPath);
  }
}

function onClose(browserbase) {
  window.removeEventListener('storage', browserbase._onStorage);
  browserbase.db = null;
  browserbase.dispatchEvent('close');
}

function getStoreOptions(keyString) {
  var keyPath = keyString.replace(/\s/g, '');
  var storeOptions = {};
  if (keyPath.slice(0, 2) === '++') {
    keyPath = keyPath.replace('++', '');
    storeOptions.autoIncrement = true;
  } else if (keyPath[0] === '[') {
    keyPath = keyPath.replace(/^\[|\]$/g, '').split(/\+/);
  }
  if (keyPath) { storeOptions.keyPath = keyPath; }
  return storeOptions;
}

exports.Browserbase = Browserbase;
exports.EventDispatcher = EventDispatcher;
//# sourceMappingURL=index.js.map
