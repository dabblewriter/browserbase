import indexeddb, { IDBKeyRange, IDBTransaction } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Browserbase, ObjectStore } from './Browserbase';

// Skipping files that produce errors because either vitest isn't catching them, or fake-indexeddb is throwing them
// twice, the second time delayed. I think the latter.

globalThis.indexedDB = indexeddb;
globalThis.IDBTransaction = IDBTransaction;
globalThis.IDBKeyRange = IDBKeyRange;

describe('Browserbase', () => {
  let db: Browserbase<{
    foo: ObjectStore<{ key: string; test?: boolean; name?: string; date?: Date; unique?: number }>;
    bar: ObjectStore<{ key: string }>;
    baz: ObjectStore<{ id: string }>;
  }>;

  beforeEach(() => {
    db = new Browserbase('test' + (Math.random() + '').slice(2));
  });

  afterEach(async () => {
    db.close();
    Browserbase.deleteDatabase('test');
  });

  it('should fail if no versions were set', () => {
    return db.open().then(
      () => {
        throw new Error('It opened just fine');
      },
      err => {
        // It caused an error as it should have
      }
    );
  });

  it('should create a version with an object store', async () => {
    db.version(1, { foo: 'bar' });
    await db.open();
    expect(db.stores).to.have.property('foo');
  });

  it('should create a version with multiple object stores', async () => {
    db.version(1, { foo: 'bar', bar: 'foo' });
    await db.open();
    expect(db.stores).to.have.property('foo');
    expect(db.stores).to.have.property('bar');
  });

  it('should add onto existing versions', async () => {
    db.version(1, { foo: 'bar', bar: 'foo' });
    db.version(2, { foo: 'foobar' });
    await db.open();
    expect(db.db!.transaction('foo').objectStore('foo').indexNames.contains('foobar')).toBe(true);
  });

  it('should add onto existing versions which have already been created', async () => {
    db.version(1, { foo: 'bar', bar: 'foo' });
    await db.open();
    expect(db.db!.transaction('foo').objectStore('foo').indexNames.contains('foobar')).toBe(false);
    db.close();
    db.version(2, { foo: 'foobar' });
    await db.open();
    expect(db.db!.transaction('foo').objectStore('foo').indexNames.contains('foobar')).toBe(true);
  });

  it('should support deleting indexes from previous versions', async () => {
    db.version(1, { foo: 'bar', bar: 'foo' });
    db.version(2, { foo: 'foobar' });
    db.version(3, { foo: '-foobar' });
    await db.open();
    expect(db.db!.transaction('foo').objectStore('foo').indexNames.contains('foobar')).toBe(false);
  });

  it('should delete indexes from previous versions that already exist', async () => {
    db.version(1, { foo: 'bar', bar: 'foo' });
    db.version(2, { foo: 'foobar' });
    await db.open();
    expect(db.db!.transaction('foo').objectStore('foo').indexNames.contains('foobar')).toBe(true);
    db.close();
    db.version(3, { foo: '-foobar' });
    await db.open();
    expect(db.db!.transaction('foo').objectStore('foo').indexNames.contains('foobar')).toBe(false);
  });

  it('should add objects to the store', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    await db.stores.foo.add({ key: 'abc' });
    const obj_1 = await db.stores.foo.get('abc');
    expect(obj_1.key).to.equal('abc');
  });

  it.skip('should fail to add objects that already exist', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    await db.stores.foo.add({ key: 'abc' });
    const obj_1 = await db.stores.foo.get('abc');
    expect(obj_1.key).to.equal('abc');
    try {
      await db.stores.foo.add({ key: 'abc' });
      expect(false).toBe(true);
    } catch (err) {
      // good, good
      expect(err.name).to.equal('ConstraintError');
    }
  });

  it('should add objects to the store in bulk', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    await db.stores.foo.bulkAdd([{ key: 'abc' }, { key: 'abcc' }]);
    const arr = await db.stores.foo.getAll();
    expect(arr).to.eql([{ key: 'abc' }, { key: 'abcc' }]);
  });

  it('should save objects to the store', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    await db.stores.foo.put({ key: 'abc' });
    const obj_1 = await db.stores.foo.get('abc');
    expect(obj_1.key).to.equal('abc');
    await db.stores.foo.put({ key: 'abc', test: true });
    const obj_2 = await db.stores.foo.get('abc');
    expect(obj_2.test).toBe(true);
  });

  it('should save objects to the store in bulk', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    await db.stores.foo.bulkPut([{ key: 'abc' }, { key: 'abcc' }]);
    const arr = await db.stores.foo.getAll();
    expect(arr).to.eql([{ key: 'abc' }, { key: 'abcc' }]);
  });

  it('should delete objects from the store', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    await db.stores.foo.put({ key: 'abc' });
    const obj_1 = await db.stores.foo.get('abc');
    expect(obj_1.key).to.equal('abc');
    await db.stores.foo.delete('abc');
    const obj_2 = await db.stores.foo.get('abc');
    expect(obj_2).toBe(undefined);
  });

  it('should dispatch a change for add/put/delete', async () => {
    let lastChange: any, lastKey: string | undefined;
    db.addEventListener('change', ({ detail: { obj, key } }) => {
      lastChange = obj;
      lastKey = key;
    });

    db.version(1, { foo: 'key' });
    await db.open();
    await db.stores.foo.put({ key: 'abc' });
    expect(lastChange).to.eql({ key: 'abc' });
    expect(lastKey).to.equal('abc');
    await db.stores.foo.delete('abc');
    expect(lastChange).to.equal(null);
    expect(lastKey).to.equal('abc');
  });

  it('should allow one transaction for many puts', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    expect(db.stores.foo._transStore('readonly').transaction).not.to.equal(db._current);
    const trans = db.start();
    trans.stores.foo.put({ key: 'test1' });
    trans.stores.foo.put({ key: 'test2' });
    trans.stores.foo.put({ key: 'test3' });
    expect(trans.stores.foo._transStore('readonly').transaction).to.equal(trans._current);
    return await trans.commit();
  });

  it.skip('should not report success if the transaction fails', async () => {
    db.version(1, { foo: 'key, &unique' });
    let success1: boolean | undefined;
    let success2: boolean | undefined;

    await db.open();
    const trans = db.start();
    trans.stores.foo.add({ key: 'test1' }).then(
      id => {
        success1 = true;
      },
      err => {
        success1 = false;
      }
    );
    trans.stores.foo.put({ key: 'test2', unique: 10 }).then(
      id_1 => {
        success2 = true;
      },
      err_1 => {
        success2 = false;
      }
    );
    trans.stores.foo.add({ key: 'test1' });
    trans.stores.foo.put({ key: 'test3', unique: 10 });
    try {
      await trans.commit();
    } catch {
      expect(success1).toBe(false);
      expect(success2).toBe(false);
    }
    const obj_2 = await db.stores.foo.get('test1');
    expect(obj_2).toBe(undefined);
  });

  it.skip('should not report to finish if the transaction fails', async () => {
    db.version(1, { foo: 'key, &unique' });
    let success = false;

    await db.open();
    const trans = db.start();
    trans.stores.foo.add({ key: 'test1', unique: 10 });
    trans.stores.foo.add({ key: 'test2', unique: 11 });
    trans.stores.foo.add({ key: 'test3', unique: 12 });
    try {
      await trans.commit();
      db.stores.foo.addEventListener('change', () => {
        success = true;
      });
      await db.stores.foo.where('key').update(obj_1 => {
        if (obj_1.key === 'test2') {
          obj_1.unique = 15;
          return obj_1;
        } else if (obj_1.key === 'test3') {
          obj_1.unique = 10;
          return obj_1;
        }
      });
    } catch {}
    expect(success).toBe(false);
    const res = await db.stores.foo.getAll();
    expect(res).to.eql([
      { key: 'test1', unique: 10 },
      { key: 'test2', unique: 11 },
      { key: 'test3', unique: 12 },
    ]);
  });

  it('should get all objects', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    const trans = db.start();
    trans.stores.foo.put({ key: 'test1' });
    trans.stores.foo.put({ key: 'test2' });
    trans.stores.foo.put({ key: 'test3' });
    await trans.commit();
    const objects = await db.stores.foo.getAll();
    expect(objects).to.have.length(3);
  });

  it('should set keyPath on the store', async () => {
    db.version(1, { foo: 'key', bar: ', test', baz: '++id' });
    await db.open();
    expect(db.stores.foo.keyPath).to.equal('key');
    expect(db.stores.bar.keyPath).to.equal(null);
    expect(db.stores.baz.keyPath).to.equal('id');
  });

  it('should get a range of objects', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    const trans = db.start();
    trans.stores.foo.put({ key: 'test1' });
    trans.stores.foo.put({ key: 'test2' });
    trans.stores.foo.put({ key: 'test3' });
    trans.stores.foo.put({ key: 'test4' });
    trans.stores.foo.put({ key: 'test5' });
    trans.stores.foo.put({ key: 'test6' });
    await trans.commit();
    const objects = await db.stores.foo.where('key').startsAt('test2').endsBefore('test5').getAll();
    expect(objects).to.eql([{ key: 'test2' }, { key: 'test3' }, { key: 'test4' }]);
  });

  it('should get a range of objects with limit', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    const trans = db.start();
    trans.stores.foo.put({ key: 'test1' });
    trans.stores.foo.put({ key: 'test2' });
    trans.stores.foo.put({ key: 'test3' });
    trans.stores.foo.put({ key: 'test4' });
    trans.stores.foo.put({ key: 'test5' });
    trans.stores.foo.put({ key: 'test6' });
    await trans.commit();
    const objects = await db.stores.foo.where('key').startsAt('test2').endsBefore('test5').limit(2).getAll();
    expect(objects).to.eql([{ key: 'test2' }, { key: 'test3' }]);
  });

  it('should cursor over a range of objects with limit', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    const trans = db.start();
    let objects: any[] = [];
    trans.stores.foo.put({ key: 'test1' });
    trans.stores.foo.put({ key: 'test2' });
    trans.stores.foo.put({ key: 'test3' });
    trans.stores.foo.put({ key: 'test4' });
    trans.stores.foo.put({ key: 'test5' });
    trans.stores.foo.put({ key: 'test6' });
    await trans.commit();
    await db.stores.foo
      .where('key')
      .startsAt('test2')
      .endsBefore('test5')
      .limit(2)
      .forEach(obj_1 => objects.push(obj_1));
    expect(objects).to.eql([{ key: 'test2' }, { key: 'test3' }]);
  });

  it('should delete a range of objects', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    const trans = db.start();
    trans.stores.foo.put({ key: 'test1' });
    trans.stores.foo.put({ key: 'test2' });
    trans.stores.foo.put({ key: 'test3' });
    trans.stores.foo.put({ key: 'test4' });
    trans.stores.foo.put({ key: 'test5' });
    trans.stores.foo.put({ key: 'test6' });
    await trans.commit();
    await db.stores.foo.where('key').startsAfter('test2').endsAt('test5').deleteAll();
    const objects = await db.stores.foo.getAll();
    expect(objects).to.eql([{ key: 'test1' }, { key: 'test2' }, { key: 'test6' }]);
  });

  it('should update a range of objects', async () => {
    db.version(1, { foo: 'key' });
    await db.open();
    const trans = db.start();
    trans.stores.foo.put({ key: 'test1' });
    trans.stores.foo.put({ key: 'test2' });
    trans.stores.foo.put({ key: 'test3' });
    trans.stores.foo.put({ key: 'test4' });
    trans.stores.foo.put({ key: 'test5' });
    trans.stores.foo.put({ key: 'test6' });
    await trans.commit();
    await db.stores.foo
      .where('key')
      .startsAt('test2')
      .endsAt('test5')
      .update(obj_1 => {
        if (obj_1.key === 'test2') return null;
        if (obj_1.key === 'test5') return;
        obj_1.name = obj_1.key;
        return obj_1;
      });
    const objects = await db.stores.foo.getAll();
    expect(objects).to.eql([
      { key: 'test1' },
      { key: 'test3', name: 'test3' },
      { key: 'test4', name: 'test4' },
      { key: 'test5' },
      { key: 'test6' },
    ]);
  });

  it('should handle compound indexes', async () => {
    db.version(1, { foo: 'key, [name + date]' });

    await db.open();
    const trans = db.start();
    trans.stores.foo.add({ key: 'test4', name: 'b', date: new Date('2010-01-01') });
    trans.stores.foo.add({ key: 'test1', name: 'a', date: new Date('2004-01-01') });
    trans.stores.foo.add({ key: 'test2', name: 'a', date: new Date('2005-01-01') });
    trans.stores.foo.add({ key: 'test3', name: 'a', date: new Date('2002-01-01') });
    trans.stores.foo.add({ key: 'test5', name: 'b', date: new Date('2000-01-01') });
    await trans.commit();
    const objs = await db.stores.foo.where('[name+ date]').getAll();
    expect(objs).to.eql([
      { key: 'test3', name: 'a', date: new Date('2002-01-01') },
      { key: 'test1', name: 'a', date: new Date('2004-01-01') },
      { key: 'test2', name: 'a', date: new Date('2005-01-01') },
      { key: 'test5', name: 'b', date: new Date('2000-01-01') },
      { key: 'test4', name: 'b', date: new Date('2010-01-01') },
    ]);
    const rows = await db.stores.foo
      .where('[name+date]')
      .startsAt(['a', new Date('2005-01-01')])
      .reverse()
      .getAll();
    expect(rows).to.eql([
      { key: 'test4', name: 'b', date: new Date('2010-01-01') },
      { key: 'test5', name: 'b', date: new Date('2000-01-01') },
      { key: 'test2', name: 'a', date: new Date('2005-01-01') },
    ]);
  });

  it('should handle compound primary keys', async () => {
    db.version(1, { foo: '[name + date]' });

    await db.open();
    const trans = db.start();
    trans.stores.foo.add({ key: 'test4', name: 'b', date: new Date('2010-01-01') });
    trans.stores.foo.add({ key: 'test1', name: 'a', date: new Date('2004-01-01') });
    trans.stores.foo.add({ key: 'test2', name: 'a', date: new Date('2005-01-01') });
    trans.stores.foo.add({ key: 'test3', name: 'a', date: new Date('2002-01-01') });
    trans.stores.foo.add({ key: 'test5', name: 'b', date: new Date('2000-01-01') });
    await trans.commit();
    const objs = await db.stores.foo.where().getAll();
    expect(objs).to.eql([
      { key: 'test3', name: 'a', date: new Date('2002-01-01') },
      { key: 'test1', name: 'a', date: new Date('2004-01-01') },
      { key: 'test2', name: 'a', date: new Date('2005-01-01') },
      { key: 'test5', name: 'b', date: new Date('2000-01-01') },
      { key: 'test4', name: 'b', date: new Date('2010-01-01') },
    ]);
    const objs_1 = await db.stores.foo
      .where()
      .startsAt(['a', new Date('2005-01-01')])
      .reverse()
      .getAll();
    expect(objs_1).to.eql([
      { key: 'test4', name: 'b', date: new Date('2010-01-01') },
      { key: 'test5', name: 'b', date: new Date('2000-01-01') },
      { key: 'test2', name: 'a', date: new Date('2005-01-01') },
    ]);
  });

  it('should handle compound indexes with startsWith', async () => {
    db.version(1, { foo: 'key, [name + date]' });

    await db.open();
    const trans = db.start();
    trans.stores.foo.add({ key: 'test4', name: 'b', date: new Date('2010-01-01') });
    trans.stores.foo.add({ key: 'test1', name: 'a', date: new Date('2004-01-01') });
    trans.stores.foo.add({ key: 'test2', name: 'a', date: new Date('2005-01-01') });
    trans.stores.foo.add({ key: 'test3', name: 'a', date: new Date('2002-01-01') });
    trans.stores.foo.add({ key: 'test5', name: 'b', date: new Date('2000-01-01') });
    await trans.commit();
    const objs = await db.stores.foo.where('[name+ date]').startsWith(['a']).getAll();
    expect(objs).to.eql([
      { key: 'test3', name: 'a', date: new Date('2002-01-01') },
      { key: 'test1', name: 'a', date: new Date('2004-01-01') },
      { key: 'test2', name: 'a', date: new Date('2005-01-01') },
    ]);
    const objs_1 = await db.stores.foo.where('[name+date]').startsWith(['b']).reverse().getAll();
    expect(objs_1).to.eql([
      { key: 'test4', name: 'b', date: new Date('2010-01-01') },
      { key: 'test5', name: 'b', date: new Date('2000-01-01') },
    ]);
  });
});
