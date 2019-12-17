# Browserbase

Browserbase is a wrapper around the IndexedDB browser database which makes it easier to use. It provides
* a Promise-based API using native browser promises (provide your own polyfill for IE 11)
* easy versioning with indexes
* events for open, close, and error
* cancelable events for blocked and versionchange (see [IndexedDB documentation](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/onversionchange))
* change events for any changes, even when they originate from another tab

To learn more about IndexedDB (which will help you with this API) read through the interfaces at
https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API.

## Why another wrapper?

Dexie was the only robust wrapper with a decent API at the time I wrote Browserbase, but it is much larger than it needs
to be and catches errors in your code giving you a `console.warn` about them. Libraries should never do this.

## Overview of Browserbase vs IndexedDB Interfaces

I will attempt to summarize the IndexedDB interfaces and how Browserbase wraps them.

Here is a list of the main IndexedDB interfaces. I skip over the request interfaces.

* `IDBEnvironment` just says that `window` should have a property called `indexedDB` which is a `IDBFactory`.
* `IDBFactory` is `window.indexedDB` and defines the `open`, `deleteDatabase`, and `cmp` methods.
* `IDBDatabase` is the database connection you get with a successful `open` and lets you create transactions.
* `IDBTransaction` is a transaction with an `objectStore()` method that returns an object store.
* `IDBObjectStore` is an object store (or table in RDBMS databases) with methods for reading and writing and accessing indexes.
* `IDBIndex` is an index in an object store that lets you look up objects (and ranges) by a predefined index.
* `IDBCursor` lets you iterate over objects in a store one at a time for better memory usage (e.g. if you have millions of records).
* `IDBKeyRange` helps you define a range with min/max records on an index to select a range of objects.

When you create a new Browserbase instance it does not interact with any IndexedDB interfaces until you call `open()`.
This then opens an IndexedDB database assigning the `IDBDatabase` instance to the `db` property.

Most actions in IndexedDB are performed within a transaction. You don't have to "commit" a transaction, you just create
a new transaction object and access stores, indexes, and cursors from it. Everything you do on the store, index, or
cursor is part of the transaction, and you can continue using that transaction immediately after actions complete. The
transaction is offically finished once there is nothing being done within it during a microtask/frame.

Browserbase attempts to hide transactions for simplification. It provides the following interfaces.

* `Browserbase` represents the database connection, provides events, provides database versioning, and provides access to
  the object stores.
* `ObjectStore` represents an object store, but it doesn't access an actual object store until calling an action so that
  it can create a new transaction before it does.
* `Where` helps creating a range for reading and writing data in bulk from/to the database. It will use indexes and
  cursors as needed.

Browserbase knows that often you are only performing a single action within a transaction. So it tries to simplify
transactions by making them implicit. When you perform an `add` or a `put` on a store it automatically creates a
`readwrite` transaction with that one object store for you and runs the operation within it.

The `where()` API will use an object store if the primary key (or nothing) is passed in, and will use an index if the
property is passed in. When using methods like `forEach` it will use a cursor to iterate over the records.

## API

To keep small, Browserbase doesn't provide too many features on top of IndexedDB, opting to just the API that will make it
IndexedDB easier to use (at least, easier to use in the author's opinion).

### Versioning

Versioning is simplified. You provide a string of new indexes for each new version, with the first being the primary
key. For primary keys, use a "++" prefix to indicate auto-increment and leave it empty if the key isn't part of the
object. For indexes, use a "-" index to delete a previously defined index, use "&" to indicate a unique index, and use
"*" for a multiEntry index. You shouldn't ever change existing versions, only add new ones.

Example:

```js
// Initial version, should remain the same with later updates
db.version(1, {
 friends: 'fullName, age'
});

// Next version, we don't add any indexes, but we want to run our own update code to prepopulate the database
db.version(2, {}, function(oldVersion, transaction) {
 // prepopulate with some initial data
 transaction.objectStore('friends').put({ fullName: 'Tom' });
});

// Remove the age index and add one for birthdate, add another object store with an auto-incrementing primary key
// that isn't part of the object, and a multiEntry index on the labels array.
db.version(3, {
 friends: 'birthdate, -age',
 events: '++, date, *labels'
});

db.open().then(() => {
  console.log('database is now open');
});
```

After the database is opened, a property will be added to the database instance for each object store in the
database. This is how you will work with the data in the database.

Example:

```js
// Create the object store "foo"
db.version(1, { foo: 'id' });

// Will be triggered once for any add, put, or delete done in any browser tab. The object will be null when it was
// deleted, so use the key when object is null.
db.on('change', (object, key) => {
 console.log('Object with key', key, 'was', object === null ? 'deleted' : 'saved');
});

db.open().then(() => {
 db.foo.put({ id: 'bar' }).then(() => {
   console.log('An object was saved to the database.');
 });
}, err => {
 console.warn('There was an error opening the database:', err);
});
```

TODO complete documentation
