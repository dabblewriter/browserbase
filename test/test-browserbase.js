import Browserbase from '../src/browserbase';


describe('Browserbase', () => {
  let db;

  beforeEach(() => {
    db = new Browserbase('test');
  });

  afterEach(() => {
    db.close();
    Browserbase.deleteDatabase('test');
  });

  it('should fail if no versions were set', () => {
    return db.open().then(() => {
      throw new Error('It opened just fine');
    }, err => {
      // It caused an error as it should have
    });
  });

  it('should create a version with an object store', () => {
    db.version(1, { foo: 'bar' });
    return db.open().then(() => {
      expect(db).to.have.property('foo');
    });
  });

  it('should create a version with multiple object stores', () => {
    db.version(1, { foo: 'bar', bar: 'foo' });
    return db.open().then(() => {
      expect(db).to.have.property('foo');
      expect(db).to.have.property('bar');
    });
  });

  it('should add onto existing versions', () => {
    db.version(1, { foo: 'bar', bar: 'foo' });
    db.version(2, { foo: 'foobar' });
    return db.open().then(() => {
      expect(db.db.transaction('foo').objectStore('foo').indexNames.contains('foobar')).to.be.true;
    });
  });

  it('should add onto existing versions which have already been created', () => {
    db.version(1, { foo: 'bar', bar: 'foo' });
    return db.open().then(() => {
      expect(db.db.transaction('foo').objectStore('foo').indexNames.contains('foobar')).to.be.false;
      db.close();
      db.version(2, { foo: 'foobar' });
      return db.open().then(() => {
        expect(db.db.transaction('foo').objectStore('foo').indexNames.contains('foobar')).to.be.true;
      });
    });
  });

  it('should support deleting indexes from previous versions', () => {
    db.version(1, { foo: 'bar', bar: 'foo' });
    db.version(2, { foo: 'foobar' });
    db.version(3, { foo: '-foobar' });
    return db.open().then(() => {
      expect(db.db.transaction('foo').objectStore('foo').indexNames.contains('foobar')).to.be.false;
    });
  });

  it('should delete indexes from previous versions that already exist', () => {
    db.version(1, { foo: 'bar', bar: 'foo' });
    db.version(2, { foo: 'foobar' });
    return db.open().then(() => {
      expect(db.db.transaction('foo').objectStore('foo').indexNames.contains('foobar')).to.be.true;
      db.close();
      db.version(3, { foo: '-foobar' });
      return db.open().then(() => {
        expect(db.db.transaction('foo').objectStore('foo').indexNames.contains('foobar')).to.be.false;
      });
    });
  });

  it('should add objects to the store', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      return db.foo.add({ key: 'abc' }).then(() => {
        return db.foo.get('abc').then(obj => {
          expect(obj.key).to.equal('abc');
        });
      });
    });
  });

  it('should fail to add objects that already exist', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      return db.foo.add({ key: 'abc' }).then(() => {
        return db.foo.get('abc').then(obj => {
          expect(obj.key).to.equal('abc');
          return db.foo.add({ key: 'abc' }).then(() => {
            throw new Error('Did not fail');
          }, err => {
            // good, good
            expect(err.name).to.equal('ConstraintError');
          });
        });
      });
    });
  });

  it('should add objects to the store in bulk', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      return db.foo.bulkAdd([{ key: 'abc' }, { key: 'abcc' }]).then(() => {
        return db.foo.getAll().then(arr => {
          expect(arr).to.deep.equal([{ key: 'abc' }, { key: 'abcc' }]);
        });
      });
    });
  });

  it('should save objects to the store', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      return db.foo.put({ key: 'abc' }).then(() => {
        return db.foo.get('abc').then(obj => {
          expect(obj.key).to.equal('abc');
          return db.foo.put({ key: 'abc', test: true }).then(() => {
            return db.foo.get('abc').then(obj => {
              expect(obj.test).to.be.true;
            });
          });
        });
      });
    });
  });

  it('should save objects to the store in bulk', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      return db.foo.bulkPut([{ key: 'abc' }, { key: 'abcc' }]).then(() => {
        return db.foo.getAll().then(arr => {
          expect(arr).to.deep.equal([{ key: 'abc' }, { key: 'abcc' }]);
        });
      });
    });
  });

  it('should delete objects from the store', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      return db.foo.put({ key: 'abc' }).then(() => {
        return db.foo.get('abc').then(obj => {
          expect(obj.key).to.equal('abc');
          return db.foo.delete('abc').then(() => {
            return db.foo.get('abc').then(obj => {
              expect(obj).to.be.undefined;
            });
          });
        });
      });
    });
  });

  it('should dispatch a change for add/put/delete', () => {
    let lastChange, lastKey;
    db.on('change', (storeName, obj, key) => {
      lastChange = obj;
      lastKey = key;
    });

    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      return db.foo.put({ key: 'abc' }).then(() => {
        expect(lastChange).to.deep.equal({ key: 'abc' });
        expect(lastKey).to.equal('abc');
        return db.foo.delete('abc').then(() => {
          expect(lastChange).to.equal(null);
          expect(lastKey).to.equal('abc');
        });
      });
    });
  });

  it('should allow one transaction for many puts', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      expect(db.foo._transStore('readonly').transaction).to.not.equal(db.current);
      db.start();
      db.foo.put({ key: 'test1' });
      db.foo.put({ key: 'test2' });
      db.foo.put({ key: 'test3' });
      expect(db.foo._transStore('readonly').transaction).to.equal(db.current);
      return db.commit();
    });
  });

  it('should not report success if the transaction fails', () => {
    db.version(1, { foo: 'key, &unique' });
    let success1;
    let success2;

    return db.open().then(() => {
      db.start();
      db.foo.add({ key: 'test1' }).then(id => {
        success1 = true;
      }, err => {
        success1 = false;
      });
      db.foo.put({ key: 'test2', unique: 10 }).then(id => {
        success2 = true;
      }, err => {
        success2 = false;
      });
      db.foo.add({ key: 'test1' });
      db.foo.put({ key: 'test3', unique: 10 });
      return db.commit().catch(() => {
        expect(success1, 'add did not give an error').to.be.false;
        expect(success2, 'put did not give an error').to.be.false;
      }).then(() => {
        return db.foo.get('test1');
      }).then(obj => {
        expect(obj).to.be.undefined;
      });
    });
  });

  it('should not report to finish if the transaction fails', () => {
    db.version(1, { foo: 'key, &unique' });
    let success = false;

    return db.open().then(() => {
      db.start();
      db.foo.add({ key: 'test1', unique: 10 });
      db.foo.add({ key: 'test2', unique: 11 });
      db.foo.add({ key: 'test3', unique: 12 });
      return db.commit().then(() => {
        db.foo.on('change', (obj, key, from) => {
          success = true;
        });
        return db.foo.where('key').update(obj => {
          if (obj.key === 'test2') {
            obj.unique = 15;
            return obj;
          } else if (obj.key === 'test3') {
            obj.unique = 10;
            return obj;
          }
        });
      }).catch(() => {}).then(() => {
        expect(success).to.be.false;
        return db.foo.getAll().then(res => {
          expect(res).to.deep.equal([
            { key: 'test1', unique: 10 },
            { key: 'test2', unique: 11 },
            { key: 'test3', unique: 12 }
          ]);
        });
      });
    });
  });

  it('should get all objects', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      db.start();
      db.foo.put({ key: 'test1' });
      db.foo.put({ key: 'test2' });
      db.foo.put({ key: 'test3' });
      return db.commit().then(() => {
        return db.foo.getAll().then(objects => {
          expect(objects).to.have.lengthOf(3);
        });
      });
    });
  });

  it('should set keyPath on the store', () => {
    db.version(1, { foo: 'key', bar: ', test', baz: '++id' });
    return db.open().then(() => {
      expect(db.foo.keyPath).to.equal('key');
      expect(db.bar.keyPath).to.equal('');
      expect(db.baz.keyPath).to.equal('id');
    });
  });

  it('should get a range of objects', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      db.start();
      db.foo.put({ key: 'test1' });
      db.foo.put({ key: 'test2' });
      db.foo.put({ key: 'test3' });
      db.foo.put({ key: 'test4' });
      db.foo.put({ key: 'test5' });
      db.foo.put({ key: 'test6' });
      return db.commit().then(() => {
        return db.foo.where('key').startsAt('test2').endsBefore('test5').getAll().then(objects => {
          expect(objects).to.deep.equal([
            { key: 'test2' },
            { key: 'test3' },
            { key: 'test4' },
          ]);
        });
      });
    });
  });

  it('should get a range of objects with limit', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      db.start();
      db.foo.put({ key: 'test1' });
      db.foo.put({ key: 'test2' });
      db.foo.put({ key: 'test3' });
      db.foo.put({ key: 'test4' });
      db.foo.put({ key: 'test5' });
      db.foo.put({ key: 'test6' });
      return db.commit().then(() => {
        return db.foo.where('key').startsAt('test2').endsBefore('test5').limit(2).getAll().then(objects => {
          expect(objects).to.deep.equal([
            { key: 'test2' },
            { key: 'test3' },
          ]);
        });
      });
    });
  });

  it('should cursor over a range of objects with limit', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      db.start();
      let objects = [];
      db.foo.put({ key: 'test1' });
      db.foo.put({ key: 'test2' });
      db.foo.put({ key: 'test3' });
      db.foo.put({ key: 'test4' });
      db.foo.put({ key: 'test5' });
      db.foo.put({ key: 'test6' });
      return db.commit().then(() => {
        return db.foo.where('key').startsAt('test2').endsBefore('test5').limit(2)
        .forEach(obj => objects.push(obj)).then(() => {
          expect(objects).to.deep.equal([
            { key: 'test2' },
            { key: 'test3' },
          ]);
        });
      });
    });
  });

  it('should delete a range of objects', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      db.start();
      db.foo.put({ key: 'test1' });
      db.foo.put({ key: 'test2' });
      db.foo.put({ key: 'test3' });
      db.foo.put({ key: 'test4' });
      db.foo.put({ key: 'test5' });
      db.foo.put({ key: 'test6' });
      return db.commit().then(() => {
        return db.foo.where('key').startsAfter('test2').endsAt('test5').deleteAll().then(() => db.foo.getAll()).then(objects => {
          expect(objects).to.deep.equal([
            { key: 'test1' },
            { key: 'test2' },
            { key: 'test6' },
          ]);
        });
      });
    });
  });

  it('should update a range of objects', () => {
    db.version(1, { foo: 'key' });
    return db.open().then(() => {
      db.start();
      db.foo.put({ key: 'test1' });
      db.foo.put({ key: 'test2' });
      db.foo.put({ key: 'test3' });
      db.foo.put({ key: 'test4' });
      db.foo.put({ key: 'test5' });
      db.foo.put({ key: 'test6' });
      return db.commit().then(() => {
        return db.foo.where('key').startsAt('test2').endsAt('test5').update(obj => {
          if (obj.key === 'test2') return null;
          if (obj.key === 'test5') return;
          obj.name = obj.key;
          return obj;
        }).then(() => db.foo.getAll()).then(objects => {
          expect(objects).to.deep.equal([
            { key: 'test1' },
            { key: 'test3', name: 'test3' },
            { key: 'test4', name: 'test4' },
            { key: 'test5' },
            { key: 'test6' },
          ]);
        });
      });
    });
  });

  it('should handle compound indexes', () => {
    db.version(1, { foo: 'key, [name + date]' });

    return db.open().then(() => {
      db.start();
      db.foo.add({ key: 'test4', name: 'b', date: new Date('2010-01-01') });
      db.foo.add({ key: 'test1', name: 'a', date: new Date('2004-01-01') });
      db.foo.add({ key: 'test2', name: 'a', date: new Date('2005-01-01') });
      db.foo.add({ key: 'test3', name: 'a', date: new Date('2002-01-01') });
      db.foo.add({ key: 'test5', name: 'b', date: new Date('2000-01-01') });
      return db.commit().then(() => {
        return db.foo.where('[name+ date]').getAll();
      }).then(objs => {
        expect(objs).to.deep.equal([
          { key: 'test3', name: 'a', date: new Date('2002-01-01') },
          { key: 'test1', name: 'a', date: new Date('2004-01-01') },
          { key: 'test2', name: 'a', date: new Date('2005-01-01') },
          { key: 'test5', name: 'b', date: new Date('2000-01-01') },
          { key: 'test4', name: 'b', date: new Date('2010-01-01') },
        ]);

        return db.foo.where('[name+date]').startsAt(['a', new Date('2005-01-01')]).reverse().getAll();
      }).then(objs => {
        expect(objs).to.deep.equal([
          { key: 'test4', name: 'b', date: new Date('2010-01-01') },
          { key: 'test5', name: 'b', date: new Date('2000-01-01') },
          { key: 'test2', name: 'a', date: new Date('2005-01-01') },
        ]);
      });
    });
  });

  it('should handle compound primary keys', () => {
    db.version(1, { foo: '[name + date]' });

    return db.open().then(() => {
      db.start();
      db.foo.add({ key: 'test4', name: 'b', date: new Date('2010-01-01') });
      db.foo.add({ key: 'test1', name: 'a', date: new Date('2004-01-01') });
      db.foo.add({ key: 'test2', name: 'a', date: new Date('2005-01-01') });
      db.foo.add({ key: 'test3', name: 'a', date: new Date('2002-01-01') });
      db.foo.add({ key: 'test5', name: 'b', date: new Date('2000-01-01') });
      return db.commit().then(() => {
        return db.foo.where().getAll();
      }).then(objs => {
        expect(objs).to.deep.equal([
          { key: 'test3', name: 'a', date: new Date('2002-01-01') },
          { key: 'test1', name: 'a', date: new Date('2004-01-01') },
          { key: 'test2', name: 'a', date: new Date('2005-01-01') },
          { key: 'test5', name: 'b', date: new Date('2000-01-01') },
          { key: 'test4', name: 'b', date: new Date('2010-01-01') },
        ]);

        return db.foo.where().startsAt(['a', new Date('2005-01-01')]).reverse().getAll();
      }).then(objs => {
        expect(objs).to.deep.equal([
          { key: 'test4', name: 'b', date: new Date('2010-01-01') },
          { key: 'test5', name: 'b', date: new Date('2000-01-01') },
          { key: 'test2', name: 'a', date: new Date('2005-01-01') },
        ]);
      });
    });
  });

  it('should handle compound indexes with startsWith', () => {
    db.version(1, { foo: 'key, [name + date]' });

    return db.open().then(() => {
      db.start();
      db.foo.add({ key: 'test4', name: 'b', date: new Date('2010-01-01') });
      db.foo.add({ key: 'test1', name: 'a', date: new Date('2004-01-01') });
      db.foo.add({ key: 'test2', name: 'a', date: new Date('2005-01-01') });
      db.foo.add({ key: 'test3', name: 'a', date: new Date('2002-01-01') });
      db.foo.add({ key: 'test5', name: 'b', date: new Date('2000-01-01') });
      return db.commit().then(() => {
        return db.foo.where('[name+ date]').startsWith(['a']).getAll();
      }).then(objs => {
        expect(objs).to.deep.equal([
          { key: 'test3', name: 'a', date: new Date('2002-01-01') },
          { key: 'test1', name: 'a', date: new Date('2004-01-01') },
          { key: 'test2', name: 'a', date: new Date('2005-01-01') },
        ]);

        return db.foo.where('[name+date]').startsWith(['b']).reverse().getAll();
      }).then(objs => {
        expect(objs).to.deep.equal([
          { key: 'test4', name: 'b', date: new Date('2010-01-01') },
          { key: 'test5', name: 'b', date: new Date('2000-01-01') },
        ]);
      });
    });
  });

});
