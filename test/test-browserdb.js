import BrowserDB from '../src/browserdb';


describe('BrowserDB', () => {
  let db;

  beforeEach(() => {
    db = new BrowserDB('test');
  });

  afterEach(() => {
    db.close();
    BrowserDB.deleteDatabase('test');
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
        return db.foo.where('key').startAt('test2').endBefore('test5').getAll().then(objects => {
          expect(objects).to.deep.equal([
            { key: 'test2' },
            { key: 'test3' },
            { key: 'test4' },
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
        return db.foo.where('key').startAfter('test2').endAt('test5').deleteAll().then(() => db.foo.getAll()).then(objects => {
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
        return db.foo.where('key').startAt('test2').endAt('test5').update(obj => {
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

});
