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
var Browserbase = (function (EventDispatcher$$1) {
  function Browserbase(name) {
    EventDispatcher$$1.call(this);
    this.name = name;
    this.db = null;
    this.current = null;
    this._versionMap = {};
    this._versionHandlers = {};
    this._onStorage = null;
  }

  if ( EventDispatcher$$1 ) Browserbase.__proto__ = EventDispatcher$$1;
  Browserbase.prototype = Object.create( EventDispatcher$$1 && EventDispatcher$$1.prototype );
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

    if (!Object.keys(this._versionMap).length) {
      return Promise.reject(new Error('Must declare at least a version 1 schema for Browserbase'));
    }
    var version = Object.keys(this._versionMap).map(function (key) { return parseInt(key); }).sort(function (a, b) { return a - b; }).pop();
    return new Promise(function (resolve, reject) {
      var request = window.indexedDB.open(this$1.name, version);
      request.onsuccess = successHandler(resolve);
      request.onerror = errorHandler(reject);
      request.onupgradeneeded = function (event) {
        this$1.db = request.result;
        this$1.db.onerror = errorHandler(reject);
        this$1.db.onabort = errorHandler(function () { return reject(new Error('Abort')); });
        var oldVersion = event.oldVersion > Math.pow(2, 62) ? 0 : event.oldVersion; // Safari 8 fix.
        upgrade(oldVersion, request.transaction, this$1.db, this$1._versionMap, this$1._versionHandlers);
      };
    }).then(function (db) {
      this$1.db = db;
      this$1.dispatchEvent('open');
      onOpen(this$1);
    });
  };

  /**
   * Closes the databse.
   */
  Browserbase.prototype.close = function close () {
    if (!this.db) { return; }
    this.db.close();
    onClose(this);
  };

  /**
   * Starts a multi-store transaction. All store methods after calling this will be part of this transaction until
   * the next tick or until calling commitTransaction().
   * @param  {Array} storeNames  Array of all the store names which will be used within this transaction
   * @param  {String} mode       The mode, defaults to readwrite unlike the indexedDB API
   * @return {Promise}           A promise which is resolved once the transaction is complete
   */
  Browserbase.prototype.start = function start (storeNames, mode) {
    var this$1 = this;
    if ( mode === void 0 ) mode = 'readwrite';

    if (!storeNames) { storeNames = this.db.objectStoreNames; }
    var trans = this.current = this.db.transaction(safariMultiStoreFix(storeNames), mode);
    return this.current.promise = requestToPromise(this.current).then(function (result) {
      if (this$1.current === trans) { this$1.current = null; }
      return result;
    }, function (err) {
      if (this$1.current === trans) { this$1.current = null; }
      return Promise.reject(err);
    });
  };

  /**
   * Finishes a started transaction so that other transactions may be run. This is not needed for a transaction to run,
   * but it allows other transactions to be run in this thread. It ought to be called to avoid conflicts with other
   * code elsewhere.
   * @return {Promise} The same promise returned by start() which will resolve once the transaction is done.
   */
  Browserbase.prototype.commit = function commit () {
    if (!this.current) { throw new Error('There is no current transaction to commit.'); }
    var promise = this.current.promise;
    this.current = null;
    return promise;
  };

  /**
   * Dispatches a change event when an object is being added, saved, or deleted. When deleted, the object will be null.
   * @param {ObjectStore} store  The object store this object is stored in
   * @param {Object}      obj    The object being modified or null if the object is deleted
   * @param {mixed}       key    The key of the object being changed or deleted
   * @param {String}      from   The source of this event, whether it was from the 'local' window or a 'remote' window
   */
  Browserbase.prototype.dispatchChange = function dispatchChange (store, obj, key, from) {
    if ( from === void 0 ) from = 'local';

    this.dispatchEvent('change', store.name, obj, key, from);
    store.dispatchEvent('change', obj, key, from);
    if (from === 'local') {
      var itemKey = "browserbase/" + (this.name) + "/" + (store.name);
      localStorage.setItem(itemKey, key);
      localStorage.removeItem(itemKey);
    }
  };

  return Browserbase;
}(EventDispatcher));


/**
 * An abstraction on object stores, allowing to more easily work with them without needing to always explicitly create a
 * transaction first. Also helps with ranges and indexes and promises.
 */
var ObjectStore = (function (EventDispatcher$$1) {
  function ObjectStore(db, name, keyPath) {
    EventDispatcher$$1.call(this);
    this.db = db;
    this.name = name;
    this.keyPath = keyPath;
  }

  if ( EventDispatcher$$1 ) ObjectStore.__proto__ = EventDispatcher$$1;
  ObjectStore.prototype = Object.create( EventDispatcher$$1 && EventDispatcher$$1.prototype );
  ObjectStore.prototype.constructor = ObjectStore;

  ObjectStore.prototype._transStore = function _transStore (mode, index) {
    var trans = this.db.current || this.db.db.transaction(this.name, mode);
    return trans.objectStore(this.name);
  };

  /**
   * Get an object from the store by its primary key
   * @param  {mixed} id The key of the object being retreived
   * @return {Promise}  Resolves with the object being retreived
   */
  ObjectStore.prototype.get = function get (key) {
    return requestToPromise(this._transStore('readonly').get(key));
  };

  /**
   * Get all objects in this object store. To get only a range, use where()
   * @return {Promise} Resolves with an array of objects
   */
  ObjectStore.prototype.getAll = function getAll () {
    return requestToPromise(this._transStore('readonly').getAll());
  };

  /**
   * Gets the count of all objects in this store
   * @return {Promise} Resolves with a number
   */
  ObjectStore.prototype.count = function count () {
    return requestToPromise(this._transStore('readonly').count());
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
    return requestToPromise(store.add(obj, key), store.transaction).then(function (key) {
      this$1.db.dispatchChange(this$1, obj, key);
      return key;
    });
  };

  /**
   * Adds an array of objects to the store in once transaction. You can also call startTransaction and use add().
   * @param {Array} array The array of objects you want to add to the store
   * @return {Promise}
   */
  ObjectStore.prototype.bulkAdd = function bulkAdd (array) {
    var this$1 = this;

    var store = this._transStore('readwrite');
    return Promise.all(array.map(function (obj) {
      return requestToPromise(store.add(obj), store.transaction).then(function (key) {
        this$1.db.dispatchChange(this$1, obj, key);
      });
    }));
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
    return requestToPromise(store.put(obj, key), store.transaction).then(function (key) {
      this$1.db.dispatchChange(this$1, obj, key);
      return key;
    });
  };

  /**
   * Saves an array of objects to the store in once transaction. You can also call startTransaction and use put().
   * @param {Array} array The array of objects you want to save to the store
   * @return {Promise}
   */
  ObjectStore.prototype.bulkPut = function bulkPut (array) {
    var this$1 = this;

    var store = this._transStore('readwrite');
    return Promise.all(array.map(function (obj) {
      return requestToPromise(store.put(obj), store.transaction).then(function (key) {
        this$1.db.dispatchChange(this$1, obj, key);
      });
    }));
  };

  /**
   * Deletes an object from the store.
   * @param {mixed} key The key of the object to delete.
   * @return {Promise}
   */
  ObjectStore.prototype.delete = function delete$1 (key) {
    var this$1 = this;

    var store = this._transStore('readwrite');
    return requestToPromise(store.delete(key), store.transaction).then(function () {
      this$1.db.dispatchChange(this$1, null, key);
    });
  };

  /**
   * Deletes an object from the store.
   * @param {mixed} key The key of the object to delete.
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
  var range = this.toRange();
  // Handle reverse with getAll and get
  if (this._direction === 'prev') {
    var results = [];
    if (this._limit <= 0) { return Promise.resolve(results); }
    return this.forEach(function (obj) { return results.push(obj); }).then(function () { return results; });
  }

  var store = this.store._transStore('readonly');
  var source = this.index ? store.index(this.index) : store;
  return requestToPromise(source.getAll(range, this._limit));
};

/**
 * Get all the keys matching the range limited by the limit.
 * @return {Promise} Resolves with an array of objects
 */
Where.prototype.getAllKeys = function getAllKeys () {
  var range = this.toRange();
  // Handle reverse with getAll and get
  if (this._direction === 'prev') {
    var results = [];
    if (this._limit <= 0) { return Promise.resolve(results); }
    return this.cursor(function (cursor) { return results.push(cursor.key); }, 'readonly', true).then(function () { return results; });
  }

  var store = this.store._transStore('readonly');
  var source = this.index ? store.index(this.index) : store;
  return requestToPromise(source.getAllKeys(range, this._limit));
};

/**
 * Gets a single object, the first one matching the criteria
 * @return {Promise} Resolves with an object or undefined if none was found
 */
Where.prototype.get = function get () {
  return this.limit(1).getAll().then(function (result) { return result[0]; });
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
  return requestToPromise(source.count(range));
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
    return requestToPromise(cursor.delete(), trans).then(function () {
      this$1.store.db.dispatchChange(this$1.store, null, key);
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
    request.onerror = errorHandler(reject);
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

  return this.map(function (object, cursor, trans) {
    var key = cursor.primaryKey;
    var newValue = iterator(object, cursor);
    if (newValue === null) {
      return requestToPromise(cursor.delete()).then(function () {
        this$1.store.db.dispatchChange(this$1.store, null, key);
      });
    } else if (newValue !== undefined) {
      return requestToPromise(cursor.update(newValue), trans).then(function () {
        this$1.store.db.dispatchChange(this$1.store, newValue, key);
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
    if ( mode === void 0 ) mode = 'readonly';

  return this.cursor(function (cursor, trans) {
    iterator(cursor.value, cursor, trans);
  }, mode);
};

/**
 * Uses a cursor to efficiently iterate over the objects matching the range calling the iterator for each one.
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



function requestToPromise(request, transaction) {
  return new Promise(function (resolve, reject) {
    if (transaction) {
      if (!transaction.promise) { transaction.promise = requestToPromise(transaction); }
      transaction.promise = transaction.promise.then(function () { return resolve(request.result); }, function (err) {
        reject(request.error || err);
        return Promise.reject(err);
      });
    } else if (request.onsuccess === null) {
      request.onsuccess = successHandler(resolve);
    }
    if (request.oncomplete === null) { request.oncomplete = successHandler(resolve); }
    if (request.onerror === null) { request.onerror = errorHandler(reject); }
    if (request.onabort === null) { request.onabort = function () { return reject(new Error('Abort')); }; }
  });
}

function successHandler(resolve) {
  return function (event) { return resolve(event.target.result); };
}

function errorHandler(reject) {
  return function (event) { return reject(event.target.error); };
}

function safariMultiStoreFix(storeNames) {
  return storeNames.length === 1 ? storeNames[0] : storeNames;
}


function upgrade(oldVersion, transaction, db, versionMap, versionHandlers) {
  var versions = Object.keys(versionMap).map(function (key) { return parseInt(key); }).sort(function (a, b) { return a - b; });
  versions.forEach(function (version) {
    if (oldVersion < version) {
      var stores = versionMap[version];
      Object.keys(stores).forEach(function (name) {
        var value = stores[name];
        var indexes = value && value.split(/\s*,\s*/);
        var store;

        if (value === null) {
          db.deleteObjectStore(name);
          return;
        }

        if (db.objectStoreNames.contains(name)) {
          store = transaction.objectStore(name);
        } else {
          var keyPath = indexes.shift().replace(/\s/g, '');
          var storeOptions = {};
          if (keyPath.slice(0, 2) === '++') {
            keyPath = keyPath.replace('++', '');
            storeOptions.autoIncrement = true;
          } else if (keyPath[0] === '[') {
            keyPath = keyPath.replace(/^\[|\]$/g, '').split(/\+/);
          }
          if (keyPath) { storeOptions.keyPath = keyPath; }
          store = db.createObjectStore(name, storeOptions);
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
      });

      var handler = versionHandlers[version];
      if (handler) { handler(oldVersion, transaction); }
    }
  });
}


function onOpen(browserbase) {
  // Store keyPath's for each store
  var keyPaths = {};
  var versions = Object.keys(browserbase._versionMap).map(function (key) { return parseInt(key); }).sort(function (a, b) { return a - b; });
  versions.forEach(function (version) {
    var stores = browserbase._versionMap[version];
    Object.keys(stores).forEach(function (name) {
      if (keyPaths[name] || !stores[name]) { return; }
      var indexes = stores[name].split(/\s*,\s*/);
      keyPaths[name] = indexes[0].replace(/^\+\+/, '');
    });
  });

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
      var key = event.newValue;
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

  var names = db.objectStoreNames;
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    browserbase[name] = new ObjectStore(browserbase, name, keyPaths[name]);
  }
}


function onClose(browserbase) {
  window.removeEventListener('storage', browserbase._onStorage);
  browserbase.db = null;
  browserbase.dispatchEvent('close');
}

exports.EventDispatcher = EventDispatcher;
exports.Browserbase = Browserbase;
//# sourceMappingURL=index.js.map
