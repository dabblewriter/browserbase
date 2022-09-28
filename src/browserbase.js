import EventDispatcher from './event-dispatcher';
const maxString = String.fromCharCode(65535);
const noop = data => data;


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
export default class Browserbase extends EventDispatcher {

  /**
   * Deletes a database by name.
   * @return {Promise}
   */
  static deleteDatabase(name) {
    return requestToPromise(indexedDB.deleteDatabase(name));
  }

  /**
   * Creates a new indexeddb database with the given name.
   * @param  {String} name           The name of the database, stored in IndexedDB
   * @param  {Object} options        Options for this database.
   * @param           {Boolean} dontDispatch      If true, don't use localStorage to dispatch events across tabs. Use
   *                                              this if using Browserbase in a worker for e.g.
   */
  constructor(name, options) {
    super();
    this.name = name;
    this.db = null;
    this.options = options || {};
    this._dispatchRemote = false;
    this._current = null;
    this._versionMap = {};
    this._versionHandlers = {};
    this._onStorage = null;
    this._storageEvents = {};
  }

  /**
   * Defines a version for the database. Additional versions may be added, but existing version should not be changed.
   * @param  {Number} version           The version number
   * @param  {Object} stores            An object with store name as the key and a comma-delimited string of indexes
   * @param  {Function} upgradeFunction An optional function that will be called when upgrading, used for data updates
   * @return {Browserbase}              A reference to itself
   */
  version(version, stores, upgradeFunction) {
    this._versionMap[version] = stores;
    if (upgradeFunction) {
      this._versionHandlers[version] = upgradeFunction;
    }
    return this;
  }

  /**
   * Returns a list of the defined versions.
   */
  getVersions() {
    return Object.keys(this._versionMap).map(key => {
      return { version: parseInt(key), stores: this._versionMap[key], upgradeFunction: this._versionHandlers[key] };
    });
  }

  /**
   * Whether this database is open or closed.
   * @return {Boolean}
   */
  isOpen() {
    return Boolean(this.db);
  }

  /**
   * Open a database, call this after defining versions.
   * @return {Promise}
   */
  open() {
    if (this._opening) {
      return this._opening;
    }

    if (!Object.keys(this._versionMap).length) {
      return Promise.reject(new Error('Must declare at least a version 1 schema for Browserbase'));
    }

    let version = Object.keys(this._versionMap).map(key => parseInt(key)).sort((a, b) => a - b).pop();
    let upgradedFrom = null;

    return this._opening = new Promise((resolve, reject) => {
      let request = indexedDB.open(this.name, version);
      request.onsuccess = successHandler(resolve);
      request.onerror = errorHandler(reject, this);
      request.onupgradeneeded = event => {
        this.db = request.result;
        this.db.onerror = errorHandler(reject, this);
        this.db.onabort = errorHandler(() => reject(new Error('Abort')), this);
        let oldVersion = event.oldVersion > Math.pow(2, 62) ? 0 : event.oldVersion; // Safari 8 fix.
        upgradedFrom = oldVersion;
        upgrade(oldVersion, request.transaction, this.db, this._versionMap, this._versionHandlers, this);
      };
    }).then(db => {
      this.db = db;
      onOpen(this);
      if (upgradedFrom === 0) this.dispatchEvent('create');
      else if (upgradedFrom) this.dispatchEvent('upgrade', upgradedFrom);
      this.dispatchEvent('open');
    });
  }

  /**
   * Closes the database.
   */
  close() {
    if (!this.db) return;
    this.db.close();
    this._opening = undefined;
    onClose(this);
  }

  /**
   * Deletes this database.
   */
  deleteDatabase() {
    this.close();
    return Browserbase.deleteDatabase(this.name);
  }

  /**
   * Starts a multi-store transaction. All store methods on the returned database clone will be part of this transaction
   * until the next tick or until calling db.commit().
   * @param  {Array} storeNames  Array of all the store names which will be used within this transaction
   * @param  {String} mode       The mode, defaults to readwrite unlike the indexedDB API
   * @return {BrowserDB}         A temporary copy of BrowserDB to be used for this transaction only
   */
  start(storeNames, mode = 'readwrite') {
    if (!storeNames) storeNames = this.db.objectStoreNames;
    if (this._current) throw new Error('Cannot start a new transaction on an existing transaction browserbase');

    const db = new this.constructor(this.name, this);
    db.db = this.db;
    Object.keys(this).forEach(key => {
      const store = this[key];
      if (!(store instanceof ObjectStore)) return;
      db[key] = new ObjectStore(db, store.name, store.keyPath);
      db[key].store = store.store;
      db[key].revive = store.revive;
    });

    try {
      const trans = db._current = storeNames instanceof IDBTransaction
        ? storeNames
        : this.db.transaction(safariMultiStoreFix(storeNames), mode);
      trans.promise = requestToPromise(trans, null, db).then(result => {
        if (db._current === trans) db._current = null;
        return result;
      }, err => {
        if (db._current === trans) db._current = null;
        this.dispatchEvent('error', err);
        return Promise.reject(err);
      });
    } catch (err) {
      Promise.resolve().then(() => {
        this.dispatchEvent('error', err);
      });
      throw err;
    }

    return db;
  }

  /**
   * Finishes a started transaction so that other transactions may be run. This is not needed for a transaction to run,
   * but it allows other transactions to be run in this thread. It ought to be called to avoid conflicts with other
   * code elsewhere.
   * @return {Promise} The same promise returned by start() which will resolve once the transaction is done.
   */
  commit(options) {
    if (!this._current) throw new Error('There is no current transaction to commit.');
    const promise = this._current.promise;
    if (options && options.remoteChange) {
      this._dispatchRemote = true;
      promise.then(() => this._dispatchRemote = false);
    }
    this._current = null;
    return promise;
  }

  /**
   * Dispatches a change event when an object is being added, saved, or deleted. When deleted, the object will be null.
   * @param {ObjectStore} store  The object store this object is stored in
   * @param {Object}      obj    The object being modified or null if the object is deleted
   * @param {mixed}       key    The key of the object being changed or deleted
   * @param {String}      from   The source of this event, whether it was from the 'local' scope or a 'remote' scope
   */
  dispatchChange(store, obj, key, from = 'local', dispatchRemote = false) {
    const declaredFrom = this._dispatchRemote || dispatchRemote ? 'remote' : from;
    this[store.name].dispatchEvent('change', obj, key, declaredFrom);
    this.dispatchEvent('change', store.name, obj, key, declaredFrom);

    if (from === 'local' && !this.options.dontDispatch) {
      const id = createId();
      let itemKey = `browserbase/${this.name}/${store.name}/${id}`;
      // Stringify the key since it could be a string, number, or even an array
      this._storageEvents[id] = true;
      setTimeout(() => delete this._storageEvents[id], 2000);
      localStorage.setItem(itemKey, JSON.stringify(key));
      localStorage.removeItem(itemKey);
    }
  }

  /**
   * Dispatch an error event.
   */
  dispatchError(err) {
    this.dispatchEvent('error', err);
  }

  /**
   * Creates or updates a store with the given indexesString. If null will delete the store.
   * @param  {String} storeName     The store name
   * @param  {String} indexesString The string definition of the indexes to add to the store
   * @return {Promise}           Resolves with an array which is the return result of each iteration
   */
  upgradeStore(storeName, indexesString) {
    if (!this._current) return this.start().upgradeStore(storeName, indexesString);
    upgradeStore(this.db, this._current, storeName, indexesString);
  }

}


/**
 * An abstraction on object stores, allowing to more easily work with them without needing to always explicitly create a
 * transaction first. Also helps with ranges and indexes and promises.
 */
class ObjectStore extends EventDispatcher {

  constructor(db, name, keyPath) {
    super();
    this.db = db;
    this.name = name;
    this.keyPath = keyPath;
    this.store = noop;
    this.revive = noop;
  }

  _transStore(mode) {
    if (!this.db._current && !this.db.db) {
      throw new Error('Database is not opened');
    }
    try {
      let trans = this.db._current || this.db.db.transaction(this.name, mode);
      return trans.objectStore(this.name);
    } catch (err) {
      Promise.resolve().then(() => {
        this.db.dispatchEvent('error', err);
      });
      throw err;
    }
  }

  /**
   * Dispatches a change event.
   */
  dispatchChange(obj, key) {
    this.db.dispatchChange(this, obj, key);
  }

  /**
   * Dispatch an error event.
   */
  dispatchError(err) {
    this.db.dispatchError(err);
  }

  /**
   * Get an object from the store by its primary key
   * @param  {mixed} id The key of the object being retreived
   * @return {Promise}  Resolves with the object being retreived
   */
  get(key) {
    return requestToPromise(this._transStore('readonly').get(key), null, this).then(this.revive);
  }

  /**
   * Get all objects in this object store. To get only a range, use where()
   * @return {Promise} Resolves with an array of objects
   */
  getAll() {
    return requestToPromise(this._transStore('readonly').getAll(), null, this)
      .then(results => results.map(this.revive));
  }

  /**
   * Gets the count of all objects in this store
   * @return {Promise} Resolves with a number
   */
  count() {
    return requestToPromise(this._transStore('readonly').count(), null, this);
  }

  /**
   * Adds an object to the store. If an object with the given key already exists, it will not overwrite it.
   * @param {Object} obj The object you want to add to the store
   * @param {mixed} key Optional, the key of the object when it is not part of the object fields
   * @return {Promise}
   */
  add(obj, key) {
    let store = this._transStore('readwrite');
    return requestToPromise(store.add(this.store(obj), key), store.transaction, this).then(key => {
      this.dispatchChange(obj, key);
      return key;
    });
  }

  /**
   * Adds an array of objects to the store in once transaction. You can also call startTransaction and use add().
   * @param {Array} array The array of objects you want to add to the store
   * @return {Promise}
   */
  addAll(array) {
    let store = this._transStore('readwrite');
    return Promise.all(array.map(obj => {
      return requestToPromise(store.add(this.store(obj)), store.transaction, this).then(key => {
        this.dispatchChange(obj, key);
      });
    }));
  }

  /**
   * Adds an array of objects to the store in once transaction. You can also call startTransaction and use add(). Alias
   * of addAll().
   * @param {Array} array The array of objects you want to add to the store
   * @return {Promise}
   */
  bulkAdd(array) {
    return this.addAll(array);
  }

  /**
   * Saves an object to the store. If an object with the given key already exists, it will overwrite it.
   * @param {Object} obj The object you want to add to the store
   * @param {mixed} key Optional, the key of the object when it is not part of the object fields
   * @return {Promise}
   */
  put(obj, key) {
    let store = this._transStore('readwrite');
    return requestToPromise(store.put(this.store(obj), key), store.transaction, this).then(key => {
      this.dispatchChange(obj, key);
      return key;
    });
  }

  /**
   * Saves an array of objects to the store in once transaction. You can also call startTransaction and use put().
   * @param {Array} array The array of objects you want to save to the store
   * @return {Promise}
   */
  putAll(array) {
    let store = this._transStore('readwrite');
    return Promise.all(array.map(obj => {
      return requestToPromise(store.put(this.store(obj)), store.transaction, this).then(key => {
        this.dispatchChange(obj, key);
      });
    }));
  }

  /**
   * Saves an array of objects to the store in once transaction. You can also call startTransaction and use put(). Alias
   * of putAll().
   * @param {Array} array The array of objects you want to save to the store
   * @return {Promise}
   */
  bulkPut(array) {
    return this.putAll(array);
  }

  /**
   * Deletes an object from the store.
   * @param {mixed} key The key of the object to delete.
   * @return {Promise}
   */
  delete(key) {
    let store = this._transStore('readwrite');
    return requestToPromise(store.delete(key), store.transaction, this).then(() => {
      this.dispatchChange(null, key);
    });
  }

  /**
   * Deletes all objects from a store.
   * @return {Promise}
   */
  deleteAll() {
    return this.where().deleteAll();
  }

  /**
   * Use to get a subset of items from the store by id or index. Returns a Where object to allow setting the range and
   * limit.
   * @param  {String} index The key or index that will be used to retreive the range of objects
   * @return {Where}        A Where instance associated with this object store
   */
  where(index = '') {
    index = index.replace(/\s/g, '');
    return new Where(this, index === this.keyPath ? '' : index);
  }
}


/**
 * Helps with a ranged getAll or openCursor by helping to create the range and providing a nicer API with returning a
 * promise or iterating through with a callback.
 */
class Where {
  constructor(store, index) {
    this.store = store;
    this.index = index;
    this._upper = undefined;
    this._lower = undefined;
    this._upperOpen = false;
    this._lowerOpen = false;
    this._value = undefined;
    this._limit = undefined;
    this._direction = 'next';
  }

  /**
   * Dispatches a change event.
   */
  dispatchChange(obj, key) {
    this.store.dispatchChange(obj, key);
  }

  /**
   * Dispatch an error event.
   */
  dispatchError(err) {
    this.store.dispatchError(err);
  }

  /**
   * Set greater than the value provided.
   * @param  {mixed} value The lower bound
   * @return {Where}       Reference to this
   */
  startsAfter(value) {
    this._lower = value;
    this._lowerOpen = true;
    return this;
  }

  /**
   * Set greater than or equal to the value provided.
   * @param  {mixed} value The lower bound
   * @return {Where}       Reference to this
   */
  startsAt(value) {
    this._lower = value;
    this._lowerOpen = false;
    return this;
  }

  /**
   * Set less than the value provided.
   * @param  {mixed} value The upper bound
   * @return {Where}       Reference to this
   */
  endsBefore(value) {
    this._upper = value;
    this._upperOpen = true;
    return this;
  }

  /**
   * Set less than or equal to the value provided.
   * @param  {mixed} value The upper bound
   * @return {Where}       Reference to this
   */
  endsAt(value) {
    this._upper = value;
    this._upperOpen = false;
    return this;
  }

  /**
   * Set the exact match, no range.
   * @param  {mixed} value The value that needs matching on
   * @return {Where}       Reference to this
   */
  equals(value) {
    this._value = value;
    return this;
  }

  /**
   * Sets the upper and lower bounds to match any string starting with this prefix.
   * @param  {String} prefix The string prefix
   * @return {Where}         Reference to this
   */
  startsWith(prefix) {
    return this.startsAt(prefix).endsAt(Array.isArray(prefix) ? prefix.concat([[]]) : prefix + maxString);
  }

  /**
   * Limit the return results to the given count.
   * @param  {Number} count The max number of objects to return
   * @return {Where}        Reference to this
   */
  limit(count) {
    this._limit = count;
    return this;
  }

  /**
   * Reverses the direction a cursor will get things.
   * @return {Where} Reference to this
   */
  reverse() {
    this._direction = 'prev';
    return this;
  }

  /**
   * Converts this Where to its IDBKeyRange equivalent.
   * @return {IDBKeyRange} The range this Where represents
   */
  toRange() {
    if (this._upper !== undefined && this._lower !== undefined) {
      return IDBKeyRange.bound(this._lower, this._upper, this._lowerOpen, this._upperOpen);
    } else if (this._upper !== undefined) {
      return IDBKeyRange.upperBound(this._upper, this._upperOpen);
    } else if (this._lower !== undefined) {
      return IDBKeyRange.lowerBound(this._lower, this._lowerOpen);
    } else if (this._value !== undefined) {
      return IDBKeyRange.only(this._value);
    }
  }

  /**
   * Get all the objects matching the range limited by the limit.
   * @return {Promise} Resolves with an array of objects
   */
  getAll() {
    let range = this.toRange();
    // Handle reverse with cursor
    if (this._direction === 'prev') {
      let results = [];
      if (this._limit <= 0) return Promise.resolve(results);
      return this.forEach(obj => results.push(this.store.revive(obj))).then(() => results);
    }

    let store = this.store._transStore('readonly');
    let source = this.index ? store.index(this.index) : store;
    return requestToPromise(source.getAll(range, this._limit), null, this)
      .then(results => results.map(this.store.revive));
  }

  /**
   * Get all the keys matching the range limited by the limit.
   * @return {Promise} Resolves with an array of objects
   */
  getAllKeys() {
    let range = this.toRange();
    // Handle reverse with cursor
    if (this._direction === 'prev') {
      let results = [];
      if (this._limit <= 0) return Promise.resolve(results);
      return this.cursor(cursor => results.push(cursor.key), 'readonly', true).then(() => results);
    }

    let store = this.store._transStore('readonly');
    let source = this.index ? store.index(this.index) : store;
    return requestToPromise(source.getAllKeys(range, this._limit), null, this);
  }

  /**
   * Gets a single object, the first one matching the criteria
   * @return {Promise} Resolves with an object or undefined if none was found
   */
  get() {
    return this.limit(1).getAll().then(result => this.store.revive(result[0]));
  }

  /**
   * Gets a single key, the first one matching the criteria
   * @return {Promise} Resolves with an object or undefined if none was found
   */
  getKey() {
    // Allow reverse() to be used by going through the getAllKeys method
    return this.limit(1).getAllKeys().then(result => result[0]);
  }

  /**
   * Gets the count of the objects matching the criteria
   * @return {Promise} Resolves with a number
   */
  count() {
    let range = this.toRange();
    let store = this.store._transStore('readonly');
    let source = this.index ? store.index(this.index) : store;
    return requestToPromise(source.count(range), null, this);
  }

  /**
   * Deletes all the objects within this range.
   * @return {Promise} Resolves without result when finished
   */
  deleteAll() {
    // Uses a cursor to delete so that each item can get a change event dispatched for it
    return this.map((object, cursor, trans) => {
      let key = cursor.primaryKey;
      return requestToPromise(cursor.delete(), trans, this).then(() => {
        this.dispatchChange(null, key);
      });
    }, 'readwrite').then(promises => Promise.all(promises)).then(() => {});
  }

  /**
   * Uses a cursor to efficiently iterate over the objects matching the range calling the iterator for each one.
   * @param  {Function} iterator A function which will be called for each object with the (object, cursor) signature
   * @return {Promise}           Resolves without result when the cursor has finished
   */
  cursor(iterator, mode = 'readonly', keyCursor = false) {
    return new Promise((resolve, reject) => {
      let range = this.toRange();
      let store = this.store._transStore(mode);
      let source = this.index ? store.index(this.index) : store;
      let method = keyCursor ? 'openKeyCursor' : 'openCursor'
      let request = source[method](range, this._direction);
      let count = 0;
      request.onsuccess = event => {
        var cursor = event.target.result;
        if (cursor) {
          let result = iterator(cursor, store.transaction);
          if (this._limit !== undefined && ++count >= this._limit) result = false;
          if (result !== false) cursor.continue();
          else resolve();
        } else {
          resolve();
        }
      };
      request.onerror = errorHandler(reject, this);
    });
  }

  /**
   * Updates objects using a cursor to update many objects at once matching the range.
   * @param  {Function} iterator A function which will be called for each object and which should return the new value
   * for the object, undefined if no changes should be made, or null if the object should be deleted.
   * @return {Promise}           Resolves without result when finished
   */
  update(iterator) {
    const { store, revive } = this.store;
    return this.map((object, cursor, trans) => {
      let key = cursor.primaryKey;
      let newValue = iterator(object, cursor);
      if (newValue === null) {
        return requestToPromise(cursor.delete(), trans, this).then(() => {
          this.dispatchChange(null, key);
        });
      } else if (newValue !== undefined) {
        return requestToPromise(cursor.update(this.store.store(newValue)), trans, this).then(() => {
          this.dispatchChange(newValue, key);
        });
      } else {
        return undefined;
      }
    }, 'readwrite').then(promises => Promise.all(promises)).then(() => {});
  }

  /**
   * Uses a cursor to efficiently iterate over the objects matching the range calling the iterator for each one.
   * @param  {Function} iterator A function which will be called for each object with the (object, cursor) signature
   * @return {Promise}           Resolves without result when the cursor has finished
   */
  forEach(iterator, mode = 'readonly') {
    return this.cursor((cursor, trans) => {
      iterator(this.store.revive(cursor.value), cursor, trans);
    }, mode);
  }

  /**
   * Uses a cursor to efficiently iterate over the objects matching the range calling the iterator for each one and
   * returning the results of the iterator in an array.
   * @param  {Function} iterator A function which will be called for each object with the (object, cursor) signature
   * @return {Promise}           Resolves with an array which is the return result of each iteration
   */
  map(iterator, mode = 'readonly') {
    let results = [];
    return this.forEach((object, cursor, trans) => {
      results.push(iterator(object, cursor, trans));
    }, mode).then(() => results);
  }
}



function requestToPromise(request, transaction, errorDispatcher) {
  return new Promise((resolve, reject) => {
    if (transaction) {
      if (!transaction.promise) transaction.promise = requestToPromise(transaction, null, errorDispatcher);
      transaction.promise = transaction.promise.then(() => resolve(request.result), err => {
        let requestError;
        try { requestError = request.error } catch(e) {}
        reject(requestError || err);
        return Promise.reject(err);
      });
    } else if (request.onsuccess === null) {
      request.onsuccess = successHandler(resolve);
    }
    if (request.oncomplete === null) request.oncomplete = successHandler(resolve);
    if (request.onerror === null) request.onerror = errorHandler(reject, errorDispatcher);
    if (request.onabort === null) request.onabort = () => reject(new Error('Abort'));
  });
}

function successHandler(resolve) {
  return event => resolve(event.target.result);
}

function errorHandler(reject, errorDispatcher) {
  return event => {
    reject(event.target.error);
    errorDispatcher && errorDispatcher.dispatchError(event.target.error);
  };
}

function safariMultiStoreFix(storeNames) {
  return storeNames.length === 1 ? storeNames[0] : storeNames;
}


function upgrade(oldVersion, transaction, db, versionMap, versionHandlers, browserbase) {
  let versions;
  // Optimization for creating a new database. A version 0 may be used as the "latest" version to create a database.
  if (oldVersion === 0 && versionMap[0]) {
    versions = [ 0 ];
  } else {
    versions = Object.keys(versionMap)
      .map(key => parseInt(key))
      .filter(version => version > oldVersion)
      .sort((a, b) => a - b);
  }

  versions.forEach(version => {
    const stores = versionMap[version];
    Object.keys(stores).forEach(name => {
      const indexesString = stores[name];
      upgradeStore(db, transaction, name, indexesString);
    });

    const handler = versionHandlers[version];
    if (handler) {
      // Ensure browserbase has the current object stores for working with in the handler
      addStores(browserbase, db, transaction);
      handler(oldVersion, transaction);
    }
  });
}


function upgradeStore(db, transaction, storeName, indexesString) {
  const indexes = indexesString && indexesString.split(/\s*,\s*/);
  let store;

  if (indexesString === null) {
    db.deleteObjectStore(storeName);
    return;
  }

  if (db.objectStoreNames.contains(storeName)) {
    store = transaction.objectStore(storeName);
  } else {
    store = db.createObjectStore(storeName, getStoreOptions(indexes.shift()));
  }

  indexes.forEach(name => {
    if (!name) return;
    if (name[0] === '-') return store.deleteIndex(name.replace(/^-[&*]?/, ''));

    let options = {};

    name = name.replace(/\s/g, '');
    if (name[0] === '&') {
      name = name.slice(1);
      options.unique = true;
    } else if (name[0] === '*') {
      name = name.slice(1);
      options.multiEntry = true;
    }
    let keyPath = name[0] === '[' ? name.replace(/^\[|\]$/g, '').split(/\+/) : name;
    store.createIndex(name, keyPath, options);
  });
}


function onOpen(browserbase) {
  const db = browserbase.db;

  db.onversionchange = event => {
    if (browserbase.dispatchCancelableEvent('versionchange')) {
      if (event.newVersion > 0) {
        console.warn(`Another connection wants to upgrade database '${browserbase.name}'. Closing db now to resume the upgrade.`);
      } else {
        console.warn(`Another connection wants to delete database '${browserbase.name}'. Closing db now to resume the delete request.`);
      }
      browserbase.close();
    }
  };
  db.onblocked = event => {
    if (browserbase.dispatchCancelableEvent('blocked')) {
      if (!event.newVersion || event.newVersion < event.oldVersion) {
        console.warn(`Browserbase.delete('${browserbase.name}') was blocked`);
      } else {
        console.warn(`Upgrade '${browserbase.name}' blocked by other connection holding version ${event.oldVersion}`);
      }
    }
  };
  db.onclose = () => onClose(browserbase);
  db.onerror = event => browserbase.dispatchEvent('error', event.target.error);
  if (!browserbase.options.dontDispatch) {
    const prefix = `browserbase/${browserbase.name}/`;
    browserbase._onStorage = event => {
      if (event.storageArea !== localStorage) return;
      if (event.newValue === null || event.newValue === '') return;
      if (event.key.slice(0, prefix.length) !== prefix) return;
      if (browserbase._storageEvents[event.key.split('/').pop()]) return; // Safari fix, dispatches to own tab
      try {
        const storeName = event.key.replace(prefix, '').split('/')[0];
        const key = JSON.parse(event.newValue);
        const store = browserbase[storeName];
        if (store) {
          if (browserbase.hasListeners('change') || store.hasListeners('change')) {
            store.get(key).then((object = null) => {
              browserbase.dispatchChange(store, object, key, 'remote');
            });
          }
        } else {
          console.warn(`A change event came from another tab for store "${storeName}", but no such store exists.`);
        }
      } catch (err) {
        console.warn('Error parsing object change from browserbase:', err);
      }
    };

    addEventListener('storage', browserbase._onStorage);
  }

  // Store keyPath's for each store
  addStores(browserbase, db, db.transaction(safariMultiStoreFix(db.objectStoreNames), 'readonly'));
}


function addStores(browserbase, db, transaction) {
  const names = db.objectStoreNames;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    browserbase[name] = new ObjectStore(browserbase, name, transaction.objectStore(name).keyPath);
  }
}

function onClose(browserbase) {
  removeEventListener('storage', browserbase._onStorage);
  browserbase.db = null;
  browserbase.dispatchEvent('close');
}

function getStoreOptions(keyString) {
  let keyPath = keyString.replace(/\s/g, '');
  let storeOptions = {};
  if (keyPath.slice(0, 2) === '++') {
    keyPath = keyPath.replace('++', '');
    storeOptions.autoIncrement = true;
  } else if (keyPath[0] === '[') {
    keyPath = keyPath.replace(/^\[|\]$/g, '').split(/\+/);
  }
  if (keyPath) storeOptions.keyPath = keyPath;
  return storeOptions;
}

const chars = ('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz').split('');

function createId() {
  let length = 6;
  let id = '';
  while (length--) {
    id += chars[Math.random() * chars.length | 0];
  }
  return id;
}
