import { TypedEventTarget } from './TypeEventTarget';

const maxString = String.fromCharCode(65535);
const noop = <T>(data: T) => data;

export interface StoresDefinitions {
  [storeName: string]: string;
}

export interface VersionDefinition {
  version: number;
  stores: StoresDefinitions;
  upgradeFunction?: UpgradeFunction;
}

export type UpgradeFunction = (oldVersion?: number, transaction?: IDBTransaction) => void;
export type IDBTransactionMode = 'readonly' | 'readwrite' | 'versionchange';
export type CursorIterator = (cursor: IDBCursor, transaction: IDBTransaction) => false | any;

export interface ChangeDetail<T = any, K extends IDBValidKey = string> extends StoreChangeDetail<T, K> {
  store: ObjectStore;
}

export interface StoreChangeDetail<T = any, K extends IDBValidKey = string> {
  obj: T;
  key: K;
  declaredFrom: 'local' | 'remote';
}

export interface UpgradeDetail {
  upgradedFrom: number;
}

export interface BrowserbaseEventMap {
  create: Event;
  upgrade: CustomEvent<UpgradeDetail>;
  open: Event;
  error: ErrorEvent;
  change: CustomEvent<ChangeDetail>;
  blocked: Event;
  close: Event;
}

export interface ObjectStoreEventMap<T = any, K extends IDBValidKey = string> {
  change: CustomEvent<StoreChangeDetail<T, K>>;
}

export interface StoreIterator<Type, R = any> {
  (obj: Type, cursor: IDBCursor, transaction: IDBTransaction): R;
}

export type ObjectStoreMap<T = Record<string, ObjectStore<any, IDBValidKey>>> = {
  [key in keyof T]: ObjectStore<any, IDBValidKey>;
};

interface ErrorDispatcher {
  dispatchError: (err: Error) => void;
}

interface BrowserbaseConstructor {
  new <Stores extends ObjectStoreMap<Stores> = {}>(
    name: string,
    options?: { dontDispatch?: boolean },
    parent?: Browserbase
  ): Browserbase<Stores>;
}

const transactionPromise = new WeakMap<IDBTransaction, Promise<any>>();

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
export class Browserbase<Stores extends ObjectStoreMap<Stores> = {}> extends TypedEventTarget<BrowserbaseEventMap> {
  /**
   * Deletes a database by name.
   */
  static deleteDatabase(name: string) {
    return requestToPromise(indexedDB.deleteDatabase(name));
  }

  db: IDBDatabase | null;
  stores: Stores;

  _parent?: this;
  _current: IDBTransaction | null;
  _dispatchRemote: boolean;
  _versionMap: Record<number, StoresDefinitions>;
  _versionHandlers: Record<number, UpgradeFunction>;
  _channel: BroadcastChannel | null;
  _opening?: Promise<void>;

  /**
   * Creates a new indexeddb database with the given name.
   */
  constructor(public name: string, public options: { dontDispatch?: boolean } = {}, parent?: Browserbase) {
    super();
    this.db = null;
    this.stores = {} as Stores;
    this._dispatchRemote = false;
    this._current = null;
    this._versionMap = {};
    this._versionHandlers = {};
    this._channel = null;
    this._parent = parent as this;
  }

  /**
   * Defines a version for the database. Additional versions may be added, but existing version should not be changed.
   */
  version(version: number, stores: StoresDefinitions, upgradeFunction?: UpgradeFunction) {
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
      const version = parseInt(key);
      return { version, stores: this._versionMap[version], upgradeFunction: this._versionHandlers[version] };
    });
  }

  /**
   * Whether this database is open or closed.
   */
  isOpen() {
    return Boolean(this.db);
  }

  /**
   * Open a database, call this after defining versions.
   */
  open() {
    if (this._opening) {
      return this._opening;
    }

    if (!Object.keys(this._versionMap).length) {
      return Promise.reject(new Error('Must declare at least a version 1 schema for Browserbase'));
    }

    let version = Object.keys(this._versionMap)
      .map(key => parseInt(key))
      .sort((a, b) => a - b)
      .pop();
    let upgradedFrom: number | null = null;

    return (this._opening = new Promise<IDBDatabase>((resolve, reject) => {
      let request = indexedDB.open(this.name, version);
      request.onsuccess = successHandler(resolve);
      request.onerror = errorHandler(reject, this);
      request.onblocked = event => {
        const blockedEvent = new Event('blocked', { cancelable: true });
        this.dispatchEvent(blockedEvent);
        if (!blockedEvent.defaultPrevented) {
          if (!event.newVersion || event.newVersion < event.oldVersion) {
            console.warn(`Browserbase.delete('${this.name}') was blocked`);
          } else {
            console.warn(`Upgrade '${this.name}' blocked by other connection holding version ${event.oldVersion}`);
          }
        }
      };
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
      if (upgradedFrom === 0) this.dispatchEvent(new Event('create'));
      else if (upgradedFrom) this.dispatchEvent(new CustomEvent('upgrade', { detail: { upgradedFrom } }));
      this.dispatchEvent(new Event('open'));
    }));
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
   */
  start(storeNames?: string[] | IDBTransaction, mode: IDBTransactionMode = 'readwrite') {
    if (!storeNames) storeNames = Array.from(this.db.objectStoreNames);
    if (this._current) throw new Error('Cannot start a new transaction on an existing transaction browserbase');

    const Constructor = this.constructor as BrowserbaseConstructor;
    const db = new Constructor<Stores>(this.name, this.options, this);
    db.db = this.db;
    db._channel = this._channel;
    Object.keys(this.stores).forEach((key: keyof Stores & string) => {
      const store = this.stores[key];
      if (!(store instanceof ObjectStore)) return;
      const childStore = new ObjectStore(db, store.name, store.keyPath) as any;
      db.stores[key] = childStore;
      childStore.store = store.store;
      childStore.revive = store.revive;
    });

    try {
      const trans = (db._current =
        storeNames instanceof IDBTransaction ? storeNames : this.db.transaction(safariMultiStoreFix(storeNames), mode));
      transactionPromise.set(
        trans,
        requestToPromise(trans, null, db).then(
          result => {
            if (db._current === trans) db._current = null;
            return result;
          },
          error => {
            if (db._current === trans) db._current = null;
            this.dispatchEvent(new ErrorEvent('error', { error }));
            return Promise.reject(error);
          }
        )
      );
    } catch (error) {
      Promise.resolve().then(() => {
        this.dispatchEvent(new ErrorEvent('error', { error }));
      });
      throw error;
    }

    return db;
  }

  /**
   * Finishes a started transaction so that other transactions may be run. This is not needed for a transaction to run,
   * but it allows other transactions to be run in this thread. It ought to be called to avoid conflicts with other
   * code elsewhere.
   */
  commit(options?: { remoteChange?: boolean }) {
    if (!this._current) throw new Error('There is no current transaction to commit.');
    const promise = transactionPromise.get(this._current);
    if (options && options.remoteChange) {
      this._dispatchRemote = true;
      promise.then(() => (this._dispatchRemote = false));
    }
    this._current = null;
    return promise;
  }

  /**
   * Dispatches a change event when an object is being added, saved, or deleted. When deleted, the object will be null.
   */
  dispatchChange(
    store: ObjectStore<any, any>,
    obj: any,
    key: any,
    from: 'local' | 'remote' = 'local',
    dispatchRemote = false
  ) {
    const declaredFrom = this._dispatchRemote || dispatchRemote ? 'remote' : from;
    store.dispatchEvent(new CustomEvent('change', { detail: { obj, key, declaredFrom } }));
    this.dispatchEvent(new CustomEvent('change', { detail: { store, obj, key, declaredFrom } }));

    if (from === 'local' && this._channel) {
      postMessage(this, { path: `${store.name}/${key}`, obj });
    }
  }

  /**
   * Dispatch an error event.
   */
  dispatchError(error: Error) {
    this.dispatchEvent(new ErrorEvent('error', { error }));
  }

  /**
   * Creates or updates a store with the given indexesString. If null will delete the store.
   */
  upgradeStore(storeName: string, indexesString: string) {
    if (!this._current) this.start().upgradeStore(storeName, indexesString);
    else upgradeStore(this.db, this._current, storeName, indexesString);
  }
}

/**
 * An abstraction on object stores, allowing to more easily work with them without needing to always explicitly create a
 * transaction first. Also helps with ranges and indexes and promises.
 */
export class ObjectStore<Type = any, Key extends IDBValidKey = string> extends TypedEventTarget<
  ObjectStoreEventMap<Type, Key>
> {
  /**
   * Set this function to alter objects to be stored in this database store.
   */
  store: (obj: Type) => Type;

  /**
   * Set this function to alter objects when they are retrieved from this database store.
   */
  revive: (obj: Type) => Type;

  constructor(public db: Browserbase, public name: string, public keyPath: string | string[]) {
    super();
    this.db = db;
    this.store = noop;
    this.revive = noop;
  }

  _transStore(mode: IDBTransactionMode) {
    if (!this.db._current && !this.db.db) {
      throw new Error('Database is not opened');
    }
    try {
      let trans = this.db._current || this.db.db.transaction(this.name, mode);
      return trans.objectStore(this.name);
    } catch (error) {
      Promise.resolve().then(() => {
        this.db.dispatchEvent(new ErrorEvent('error', { error }));
      });
      throw error;
    }
  }

  /**
   * Dispatches a change event.
   */
  dispatchChange(obj: Type, key: Key) {
    this.db.dispatchChange(this, obj, key);
  }

  /**
   * Dispatch an error event.
   */
  dispatchError(error: Error) {
    this.db.dispatchError(error);
  }

  /**
   * Get an object from the store by its primary key
   */
  get(key: Key) {
    return requestToPromise<Type>(this._transStore('readonly').get(key), null, this).then(this.revive);
  }

  /**
   * Get all objects in this object store. To get only a range, use where()
   */
  async getAll() {
    const results = await requestToPromise<Type[]>(this._transStore('readonly').getAll(), null, this);
    return results.map(this.revive);
  }

  /**
   * Gets the count of all objects in this store
   */
  count() {
    return requestToPromise<number>(this._transStore('readonly').count(), null, this);
  }

  /**
   * Adds an object to the store. If an object with the given key already exists, it will not overwrite it.
   */
  async add(obj: Type, key?: Key) {
    let store = this._transStore('readwrite');
    key = await requestToPromise(store.add(this.store(obj), key), store.transaction, this);
    this.dispatchChange(obj, key);
    return key;
  }

  /**
   * Adds an array of objects to the store in once transaction. You can also call startTransaction and use add().
   */
  async addAll(array: Type[]) {
    let store = this._transStore('readwrite');
    await Promise.all(
      array.map(async obj => {
        const key = await requestToPromise<Key>(store.add(this.store(obj)), store.transaction, this);
        this.dispatchChange(obj, key);
      })
    );
  }

  /**
   * Adds an array of objects to the store in once transaction. You can also call startTransaction and use add(). Alias
   * of addAll().
   */
  async bulkAdd(array: Type[]) {
    await this.addAll(array);
  }

  /**
   * Saves an object to the store. If an object with the given key already exists, it will overwrite it.
   */
  async put(obj: Type, key?: Key) {
    let store = this._transStore('readwrite');
    key = await requestToPromise<Key>(store.put(this.store(obj), key), store.transaction, this);
    this.dispatchChange(obj, key);
    return key;
  }

  /**
   * Saves an array of objects to the store in once transaction. You can also call startTransaction and use put().
   */
  async putAll(array: Type[]) {
    let store = this._transStore('readwrite');
    await Promise.all(
      array.map(async obj => {
        const key = await requestToPromise<Key>(store.put(this.store(obj)), store.transaction, this);
        this.dispatchChange(obj, key);
      })
    );
  }

  /**
   * Saves an array of objects to the store in once transaction. You can also call startTransaction and use put(). Alias
   * of putAll().
   */
  async bulkPut(array: Type[]) {
    await this.putAll(array);
  }

  /**
   * Deletes an object from the store.
   */
  async delete(key: Key) {
    let store = this._transStore('readwrite');
    await requestToPromise(store.delete(key), store.transaction, this);
    this.dispatchChange(null, key);
  }

  /**
   * Deletes all objects from a store.
   */
  deleteAll() {
    return this.where().deleteAll();
  }

  /**
   * Use to get a subset of items from the store by id or index. Returns a Where object to allow setting the range and
   * limit.
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
export class Where<Type, Key extends IDBValidKey> {
  protected _upper: IDBValidKey | undefined;
  protected _lower: IDBValidKey | undefined;
  protected _upperOpen: boolean;
  protected _lowerOpen: boolean;
  protected _value: IDBValidKey | undefined;
  protected _limit: number | undefined;
  protected _direction: IDBCursorDirection;

  constructor(public store: ObjectStore<Type, Key>, public index: string) {
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
  dispatchChange(obj: Type, key: Key) {
    this.store.dispatchChange(obj, key);
  }

  /**
   * Dispatch an error event.
   */
  dispatchError(error: Error) {
    this.store.dispatchError(error);
  }

  /**
   * Set greater than the value provided.
   */
  startsAfter(value: IDBValidKey) {
    this._lower = value;
    this._lowerOpen = true;
    return this;
  }

  /**
   * Set greater than or equal to the value provided.
   */
  startsAt(value: IDBValidKey) {
    this._lower = value;
    this._lowerOpen = false;
    return this;
  }

  /**
   * Set less than the value provided.
   */
  endsBefore(value: IDBValidKey) {
    this._upper = value;
    this._upperOpen = true;
    return this;
  }

  /**
   * Set less than or equal to the value provided.
   */
  endsAt(value: IDBValidKey) {
    this._upper = value;
    this._upperOpen = false;
    return this;
  }

  /**
   * Set the exact match, no range.
   */
  equals(value: IDBValidKey) {
    this._value = value;
    return this;
  }

  /**
   * Sets the upper and lower bounds to match any string starting with this prefix.
   */
  startsWith(prefix: IDBValidKey) {
    const endsAt: IDBValidKey = Array.isArray(prefix) ? prefix.concat([[]]) : prefix + maxString;
    return this.startsAt(prefix).endsAt(endsAt);
  }

  /**
   * Limit the return results to the given count.
   */
  limit(count: number) {
    this._limit = count;
    return this;
  }

  /**
   * Reverses the direction a cursor will get things.
   */
  reverse() {
    this._direction = 'prev';
    return this;
  }

  /**
   * Converts this Where to its IDBKeyRange equivalent.
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
   */
  async getAll() {
    let range = this.toRange();
    // Handle reverse with cursor
    if (this._direction === 'prev') {
      let results: Type[] = [];
      if (this._limit <= 0) return Promise.resolve(results);
      await this.forEach(obj => results.push(this.store.revive(obj)));
      return results;
    }

    let store = this.store._transStore('readonly');
    let source = this.index ? store.index(this.index) : store;
    const records = await requestToPromise<Type[]>(source.getAll(range, this._limit), null, this);
    return records.map(this.store.revive);
  }

  /**
   * Get all the keys matching the range limited by the limit.
   */
  async getAllKeys() {
    let range = this.toRange();
    // Handle reverse with cursor
    if (this._direction === 'prev') {
      let results: Key[] = [];
      if (this._limit <= 0) return Promise.resolve(results);
      await this.cursor(cursor => results.push(cursor.key as Key), 'readonly', true);
      return results;
    }

    let store = this.store._transStore('readonly');
    let source = this.index ? store.index(this.index) : store;
    return requestToPromise<Key[]>(source.getAllKeys(range, this._limit), null, this);
  }

  /**
   * Gets a single object, the first one matching the criteria
   */
  async get() {
    const rows = await this.limit(1).getAll();
    return this.store.revive(rows[0]);
  }

  /**
   * Gets a single key, the first one matching the criteria
   */
  async getKey() {
    // Allow reverse() to be used by going through the getAllKeys method
    const rows = await this.limit(1).getAllKeys();
    return rows[0];
  }

  /**
   * Gets the count of the objects matching the criteria
   */
  count() {
    let range = this.toRange();
    let store = this.store._transStore('readonly');
    let source = this.index ? store.index(this.index) : store;
    return requestToPromise<number>(source.count(range), null, this);
  }

  /**
   * Deletes all the objects within this range.
   */
  async deleteAll() {
    // Uses a cursor to delete so that each item can get a change event dispatched for it
    const promises = await this.map(async (_, cursor, trans) => {
      let key = cursor.primaryKey as Key;
      await requestToPromise(cursor.delete(), trans, this);
      this.dispatchChange(null, key);
    }, 'readwrite');
    await Promise.all(promises);
  }

  /**
   * Uses a cursor to efficiently iterate over the objects matching the range calling the iterator for each one.
   */
  cursor(iterator: CursorIterator, mode: IDBTransactionMode = 'readonly', keyCursor = false) {
    return new Promise<void>((resolve, reject) => {
      let range = this.toRange();
      let store = this.store._transStore(mode);
      let source = this.index ? store.index(this.index) : store;
      let method: 'openKeyCursor' | 'openCursor' = keyCursor ? 'openKeyCursor' : 'openCursor';
      let request = source[method](range, this._direction);
      let count = 0;
      request.onsuccess = () => {
        var cursor = request.result;
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
   */
  async update(iterator: StoreIterator<Type, Type | null | undefined>) {
    const promises = await this.map(async (object, cursor, trans) => {
      let key = cursor.primaryKey as Key;
      let newValue = iterator(object, cursor, trans);
      if (newValue === null) {
        await requestToPromise(cursor.delete(), trans, this);
        this.dispatchChange(null, key);
      } else if (newValue !== undefined) {
        await requestToPromise(cursor.update(this.store.store(newValue)), trans, this);
        this.dispatchChange(newValue, key);
      }
    }, 'readwrite');
    await Promise.all(promises);
  }

  /**
   * Uses a cursor to efficiently iterate over the objects matching the range calling the iterator for each one.
   */
  forEach(iterator: StoreIterator<Type>, mode: IDBTransactionMode = 'readonly') {
    return this.cursor((cursor, trans) => {
      iterator(this.store.revive((cursor as any).value as Type), cursor, trans);
    }, mode);
  }

  /**
   * Uses a cursor to efficiently iterate over the objects matching the range calling the iterator for each one and
   * returning the results of the iterator in an array.
   */
  async map<R = any>(iterator: StoreIterator<Type, R>, mode: IDBTransactionMode = 'readonly') {
    let results: R[] = [];
    await this.forEach((object, cursor, trans) => {
      results.push(iterator(object, cursor, trans));
    }, mode);
    return results;
  }
}

function requestToPromise<T = unknown>(
  request: any,
  transaction?: IDBTransaction,
  errorDispatcher?: ErrorDispatcher
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (transaction) {
      let promise = transactionPromise.get(transaction);
      if (!promise) {
        promise = requestToPromise(transaction, null, errorDispatcher);
      }
      promise = promise.then(
        () => resolve(request.result),
        err => {
          let requestError;
          try {
            requestError = request.error;
          } catch (e) {}
          reject(requestError || err);
          return Promise.reject(err);
        }
      );
      transactionPromise.set(transaction, promise);
    } else if (request.onsuccess === null) {
      request.onsuccess = successHandler(resolve);
    }
    if (request.oncomplete === null) request.oncomplete = successHandler(resolve);
    if (request.onerror === null) request.onerror = errorHandler(reject, errorDispatcher);
    if (request.onabort === null) request.onabort = () => reject(new Error('Abort'));
  });
}

function successHandler(resolve: (result: any) => void) {
  return (event: Event) => resolve((event.target as any).result);
}

function errorHandler(reject: (err: Error) => void, errorDispatcher?: ErrorDispatcher) {
  return (event: Event) => {
    reject((event.target as any).error);
    errorDispatcher && errorDispatcher.dispatchError((event.target as any).error);
  };
}

function safariMultiStoreFix(storeNames: DOMStringList | string[]) {
  return storeNames.length === 1 ? storeNames[0] : Array.from(storeNames);
}

function upgrade(
  oldVersion: number,
  transaction: IDBTransaction,
  db: IDBDatabase,
  versionMap: Record<number, StoresDefinitions>,
  versionHandlers: Record<number, UpgradeFunction>,
  browserbase: Browserbase
) {
  let versions;
  // Optimization for creating a new database. A version 0 may be used as the "latest" version to create a database.
  if (oldVersion === 0 && versionMap[0]) {
    versions = [0];
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

function upgradeStore(db: IDBDatabase, transaction: IDBTransaction, storeName: string, indexesString: string) {
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

    let options: IDBIndexParameters = {};

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

function onOpen(browserbase: Browserbase) {
  const db = browserbase.db;

  db.onversionchange = event => {
    const versionEvent = new Event('versionchange', { cancelable: true });
    browserbase.dispatchEvent(versionEvent);
    if (!versionEvent.defaultPrevented) {
      if (event.newVersion > 0) {
        console.warn(
          `Another connection wants to upgrade database '${browserbase.name}'. Closing db now to resume the upgrade.`
        );
      } else {
        console.warn(
          `Another connection wants to delete database '${browserbase.name}'. Closing db now to resume the delete request.`
        );
      }
      browserbase.close();
    }
  };
  db.onclose = () => browserbase.open();
  db.onerror = event => browserbase.dispatchEvent(new ErrorEvent('error', { error: (event.target as any).error }));
  if (!browserbase.options.dontDispatch) {
    browserbase._channel = createChannel(browserbase);
  }

  // Store keyPath's for each store
  addStores(browserbase, db, db.transaction(safariMultiStoreFix(db.objectStoreNames), 'readonly'));
}

function createChannel(browserbase: Browserbase) {
  const channel = new BroadcastChannel(`browserbase/${browserbase.name}`);
  channel.onmessage = event => {
    try {
      const { path, obj } = event.data;
      const [storeName, key] = path.split('/');
      const store = (browserbase.stores as ObjectStoreMap)[storeName];
      if (store) {
        browserbase.dispatchChange(store, obj, key, 'remote');
      } else {
        console.warn(`A change event came from another tab for store "${storeName}", but no such store exists.`);
      }
    } catch (err) {
      console.warn('Error parsing object change from browserbase:', err);
    }
  };
  return browserbase._channel;
}

function postMessage(browserbase: Browserbase, message: any) {
  if (!browserbase._channel) return;
  try {
    browserbase._channel.postMessage(message);
  } catch (e) {
    // If the channel is closed, create a new one and try again
    if (e.name === 'InvalidStateError') {
      browserbase._channel = createChannel(browserbase);
      postMessage(browserbase, message);
    }
  }
}

function addStores(browserbase: Browserbase, db: IDBDatabase, transaction: IDBTransaction) {
  const names = db.objectStoreNames;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    (browserbase.stores as ObjectStoreMap)[name] = new ObjectStore(
      browserbase,
      name,
      transaction.objectStore(name).keyPath
    );
  }
}

function onClose(browserbase: Browserbase) {
  if (browserbase._channel) browserbase._channel.close();
  browserbase._channel = null;
  browserbase.db = null;
  browserbase.dispatchEvent(new Event('close'));
}

function getStoreOptions(keyString: string) {
  let keyPath: string | string[] = keyString.replace(/\s/g, '');
  let storeOptions: IDBObjectStoreParameters = {};
  if (keyPath.slice(0, 2) === '++') {
    keyPath = keyPath.replace('++', '');
    storeOptions.autoIncrement = true;
  } else if (keyPath[0] === '[') {
    keyPath = keyPath.replace(/^\[|\]$/g, '').split(/\+/);
  }
  if (keyPath) storeOptions.keyPath = keyPath;
  return storeOptions;
}
