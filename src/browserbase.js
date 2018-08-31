import EventDispatcher from './event-dispatcher';
const maxString = String.fromCharCode(65535);
const localStorage = window.localStorage;


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
    return requestToPromise(window.indexedDB.deleteDatabase(name));
  }

  /**
   * Creates a new indexeddb database with the given name.
   */
  constructor(name) {
    super();
    this.name = name;
    this.db = null;
    this.current = null;
    this._versionMap = {};
    this._versionHandlers = {};
    this._onStorage = null;
  }

  /**
   * Defines a version for the database. Additional versions may be added, but existing version should not be changed.
   * @param  {Number} version           The version number
   * @param  {Object} stores            An object with store name as the key and a comma-delimited string of indexes
   * @param  {Function} upgradeFunction An optional function that will be called when upgrading, used for data updates
   * @return {Browserbase}                A reference to itself
   */
  version(version, stores, upgradeFunction) {
    this._versionMap[version] = stores;
    if (upgradeFunction) {
      this._versionHandlers[version] = upgradeFunction;
    }
    return this;
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
    if (!Object.keys(this._versionMap).length) {
      return Promise.reject(new Error('Must declare at least a version 1 schema for Browserbase'));
    }
    let version = Object.keys(this._versionMap).map(key => parseInt(key)).sort((a, b) => a - b).pop();
    return new Promise((resolve, reject) => {
      let request = window.indexedDB.open(this.name, version);
      request.onsuccess = successHandler(resolve);
      request.onerror = errorHandler(reject);
      request.onupgradeneeded = event => {
        this.db = request.result;
        this.db.onerror = errorHandler(reject);
        this.db.onabort = errorHandler(() => reject(new Error('Abort')));
        let oldVersion = event.oldVersion > Math.pow(2, 62) ? 0 : event.oldVersion; // Safari 8 fix.
        upgrade(oldVersion, request.transaction, this.db, this._versionMap, this._versionHandlers);
      };
    }).then(db => {
      this.db = db;
      this.dispatchEvent('open');
      onOpen(this);
    });
  }

  /**
   * Closes the databse.
   */
  close() {
    if (!this.db) return;
    this.db.close();
    onClose(this);
  }

  /**
   * Starts a multi-store transaction. All store methods after calling this will be part of this transaction until
   * the next tick or until calling commitTransaction().
   * @param  {Array} storeNames  Array of all the store names which will be used within this transaction
   * @param  {String} mode       The mode, defaults to readwrite unlike the indexedDB API
   * @return {Promise}           A promise which is resolved once the transaction is complete
   */
  start(storeNames, mode = 'readwrite') {
    if (!storeNames) storeNames = this.db.objectStoreNames;
    let trans = this.current = this.db.transaction(safariMultiStoreFix(storeNames), mode);
    return this.current.promise = requestToPromise(this.current).then(result => {
      if (this.current === trans) this.current = null;
      return result;
    }, err => {
      if (this.current === trans) this.current = null;
      return Promise.reject(err);
    });
  }

  /**
   * Finishes a started transaction so that other transactions may be run. This is not needed for a transaction to run,
   * but it allows other transactions to be run in this thread. It ought to be called to avoid conflicts with other
   * code elsewhere.
   * @return {Promise} The same promise returned by start() which will resolve once the transaction is done.
   */
  commit() {
    if (!this.current) throw new Error('There is no current transaction to commit.');
    let promise = this.current.promise;
    this.current = null;
    return promise;
  }

  /**
   * Dispatches a change event when an object is being added, saved, or deleted. When deleted, the object will be null.
   * @param {ObjectStore} store  The object store this object is stored in
   * @param {Object}      obj    The object being modified or null if the object is deleted
   * @param {mixed}       key    The key of the object being changed or deleted
   * @param {String}      from   The source of this event, whether it was from the 'local' window or a 'remote' window
   */
  dispatchChange(store, obj, key, from = 'local') {
    this.dispatchEvent('change', store.name, obj, key, from);
    store.dispatchEvent('change', obj, key, from);
    if (from === 'local') {
      let itemKey = `browserbase/${this.name}/${store.name}`;
      localStorage.setItem(itemKey, key);
      localStorage.removeItem(itemKey);
    }
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
  }

  _transStore(mode, index) {
    let trans = this.db.current || this.db.db.transaction(this.name, mode);
    return trans.objectStore(this.name);
  }

  /**
   * Get an object from the store by its primary key
   * @param  {mixed} id The key of the object being retreived
   * @return {Promise}  Resolves with the object being retreived
   */
  get(key) {
    return requestToPromise(this._transStore('readonly').get(key));
  }

  /**
   * Get all objects in this object store. To get only a range, use where()
   * @return {Promise} Resolves with an array of objects
   */
  getAll() {
    return requestToPromise(this._transStore('readonly').getAll());
  }

  /**
   * Gets the count of all objects in this store
   * @return {Promise} Resolves with a number
   */
  count() {
    return requestToPromise(this._transStore('readonly').count());
  }

  /**
   * Adds an object to the store. If an object with the given key already exists, it will not overwrite it.
   * @param {Object} obj The object you want to add to the store
   * @param {mixed} key Optional, the key of the object when it is not part of the object fields
   * @return {Promise}
   */
  add(obj, key) {
    let store = this._transStore('readwrite');
    return requestToPromise(store.add(obj, key), store.transaction).then(key => {
      this.db.dispatchChange(this, obj, key);
      return key;
    });
  }

  /**
   * Adds an array of objects to the store in once transaction. You can also call startTransaction and use add().
   * @param {Array} array The array of objects you want to add to the store
   * @return {Promise}
   */
  bulkAdd(array) {
    let store = this._transStore('readwrite');
    return Promise.all(array.map(obj => {
      return requestToPromise(store.add(obj), store.transaction).then(key => {
        this.db.dispatchChange(this, obj, key);
      });
    }));
  }

  /**
   * Saves an object to the store. If an object with the given key already exists, it will overwrite it.
   * @param {Object} obj The object you want to add to the store
   * @param {mixed} key Optional, the key of the object when it is not part of the object fields
   * @return {Promise}
   */
  put(obj, key) {
    let store = this._transStore('readwrite');
    return requestToPromise(store.put(obj, key), store.transaction).then(key => {
      this.db.dispatchChange(this, obj, key);
      return key;
    });
  }

  /**
   * Saves an array of objects to the store in once transaction. You can also call startTransaction and use put().
   * @param {Array} array The array of objects you want to save to the store
   * @return {Promise}
   */
  bulkPut(array) {
    let store = this._transStore('readwrite');
    return Promise.all(array.map(obj => {
      return requestToPromise(store.put(obj), store.transaction).then(key => {
        this.db.dispatchChange(this, obj, key);
      });
    }));
  }

  /**
   * Deletes an object from the store.
   * @param {mixed} key The key of the object to delete.
   * @return {Promise}
   */
  delete(key) {
    let store = this._transStore('readwrite');
    return requestToPromise(store.delete(key), store.transaction).then(() => {
      this.db.dispatchChange(this, null, key);
    });
  }

  /**
   * Deletes an object from the store.
   * @param {mixed} key The key of the object to delete.
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
    return this.startsAt(prefix).endsAt(prefix + maxString);
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
    // Handle reverse with getAll and get
    if (this._direction === 'prev') {
      let results = [];
      if (this._limit <= 0) return Promise.resolve(results);
      return this.forEach(obj => results.push(obj)).then(() => results);
    }

    let store = this.store._transStore('readonly');
    let source = this.index ? store.index(this.index) : store;
    return requestToPromise(source.getAll(range, this._limit));
  }

  /**
   * Get all the keys matching the range limited by the limit.
   * @return {Promise} Resolves with an array of objects
   */
  getAllKeys() {
    let range = this.toRange();
    // Handle reverse with getAll and get
    if (this._direction === 'prev') {
      let results = [];
      if (this._limit <= 0) return Promise.resolve(results);
      return this.cursor(cursor => results.push(cursor.key), 'readonly', true).then(() => results);
    }

    let store = this.store._transStore('readonly');
    let source = this.index ? store.index(this.index) : store;
    return requestToPromise(source.getAllKeys(range, this._limit));
  }

  /**
   * Gets a single object, the first one matching the criteria
   * @return {Promise} Resolves with an object or undefined if none was found
   */
  get() {
    return this.limit(1).getAll().then(result => result[0]);
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
    return requestToPromise(source.count(range));
  }

  /**
   * Deletes all the objects within this range.
   * @return {Promise} Resolves without result when finished
   */
  deleteAll() {
    // Uses a cursor to delete so that each item can get a change event dispatched for it
    return this.map((object, cursor, trans) => {
      let key = cursor.primaryKey;
      return requestToPromise(cursor.delete(), trans).then(() => {
        this.store.db.dispatchChange(this.store, null, key);
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
      request.onerror = errorHandler(reject);
    });
  }

  /**
   * Updates objects using a cursor to update many objects at once matching the range.
   * @param  {Function} iterator A function which will be called for each object and which should return the new value
   * for the object, undefined if no changes should be made, or null if the object should be deleted.
   * @return {Promise}           Resolves without result when finished
   */
  update(iterator) {
    return this.map((object, cursor, trans) => {
      let key = cursor.primaryKey;
      let newValue = iterator(object, cursor);
      if (newValue === null) {
        return requestToPromise(cursor.delete()).then(() => {
          this.store.db.dispatchChange(this.store, null, key);
        });
      } else if (newValue !== undefined) {
        return requestToPromise(cursor.update(newValue), trans).then(() => {
          this.store.db.dispatchChange(this.store, newValue, key);
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
      iterator(cursor.value, cursor, trans);
    }, mode);
  }

  /**
   * Uses a cursor to efficiently iterate over the objects matching the range calling the iterator for each one.
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



function requestToPromise(request, transaction) {
  return new Promise((resolve, reject) => {
    if (transaction) {
      if (!transaction.promise) transaction.promise = requestToPromise(transaction);
      transaction.promise = transaction.promise.then(() => resolve(request.result), err => {
        reject(request.error || err);
        return Promise.reject(err);
      });
    } else if (request.onsuccess === null) {
      request.onsuccess = successHandler(resolve);
    }
    if (request.oncomplete === null) request.oncomplete = successHandler(resolve);
    if (request.onerror === null) request.onerror = errorHandler(reject);
    if (request.onabort === null) request.onabort = () => reject(new Error('Abort'));
  });
}

function successHandler(resolve) {
  return event => resolve(event.target.result);
}

function errorHandler(reject) {
  return event => reject(event.target.error);
}

function safariMultiStoreFix(storeNames) {
  return storeNames.length === 1 ? storeNames[0] : storeNames;
}


function upgrade(oldVersion, transaction, db, versionMap, versionHandlers) {
  let versions = Object.keys(versionMap).map(key => parseInt(key)).sort((a, b) => a - b);
  versions.forEach(version => {
    if (oldVersion < version) {
      let stores = versionMap[version];
      Object.keys(stores).forEach(name => {
        let value = stores[name];
        let indexes = value && value.split(/\s*,\s*/);
        let store;

        if (value === null) {
          db.deleteObjectStore(name);
          return;
        }

        if (db.objectStoreNames.contains(name)) {
          store = transaction.objectStore(name);
        } else {
          let keyPath = indexes.shift();
          let storeOptions = {};
          if (keyPath.slice(0, 2) === '++') {
            keyPath = keyPath.replace('++', '');
            storeOptions.autoIncrement = true;
          }
          if (keyPath) storeOptions.keyPath = keyPath;
          store = db.createObjectStore(name, storeOptions);
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
      });

      let handler = versionHandlers[version];
      if (handler) handler(oldVersion, transaction);
    }
  })
}


function onOpen(browserbase) {
  // Store keyPath's for each store
  let keyPaths = {};
  let versions = Object.keys(browserbase._versionMap).map(key => parseInt(key)).sort((a, b) => a - b);
  versions.forEach(version => {
    let stores = browserbase._versionMap[version];
    Object.keys(stores).forEach(name => {
      if (keyPaths[name] || !stores[name]) return;
      let indexes = stores[name].split(/\s*,\s*/);
      keyPaths[name] = indexes[0].replace(/^\+\+/, '');
    });
  });

  let db = browserbase.db;

  db.onversionchange = event => {
    if (browserbase.dispatchCancelableEvent('versionchange')) {
      if (event.newVersion > 0) {
        console.warn(`Another connection wants to upgrade database '${this.name}'. Closing db now to resume the upgrade.`);
      } else {
        console.warn(`Another connection wants to delete database '${this.name}'. Closing db now to resume the delete request.`);
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
  const prefix = `browserbase/${browserbase.name}/`;
  browserbase._onStorage = event => {
    if (event.storageArea !== localStorage) return;
    if (event.newValue === null || event.newValue === '') return;
    if (event.key.slice(0, prefix.length) !== prefix) return;
    try {
      let storeName = event.key.replace(prefix, '');
      let key = event.newValue;
      let store = browserbase[storeName];
      if (store) {
        store.get(key).then((object = null) => {
          browserbase.dispatchChange(store, object, key, 'remote');
        });
      } else {
        console.warn(`A change event came from another tab for store "${storeName}", but no such store exists.`);
      }
    } catch (err) {
      console.warn('Error parsing object change from browserbase:', err);
    }
  };

  window.addEventListener('storage', browserbase._onStorage);

  let names = db.objectStoreNames;
  for (let i = 0; i < names.length; i++) {
    let name = names[i];
    browserbase[name] = new ObjectStore(browserbase, name, keyPaths[name]);
  }
}


function onClose(browserbase) {
  window.removeEventListener('storage', browserbase._onStorage);
  browserbase.db = null;
  browserbase.dispatchEvent('close');
}
