(function () {
  'use strict';

  const DB_NAME = 'rust-reader-cache';
  const DB_VERSION = 1;
  const STORE_NAME = 'books';
  const CACHE_VERSION = 1;

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
    });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, {keyPath:'bookId'});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开 IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB 升级被阻止'));
    });
  }

  async function withStore(mode, action) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, mode);
      const completion = new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已中止'));
      });
      let result;
      try {
        result = await action(transaction.objectStore(STORE_NAME));
      } catch (error) {
        await completion.catch(() => {});
        throw error;
      }
      await completion;
      return result;
    } finally {
      database.close();
    }
  }

  async function remove(bookId) {
    await withStore('readwrite', store => requestResult(store.delete(String(bookId))));
  }

  async function get(bookId, book) {
    const key = String(bookId);
    const record = await withStore('readonly', store => requestResult(store.get(key)));
    if (!record) return null;
    const valid = record.cacheVersion === CACHE_VERSION
      && record.size === Number(book.size)
      && record.updatedAt === Number(book.updated_at)
      && record.kind === book.kind;
    if (valid) return record;
    console.info('[reader cache] stale entry removed', {bookId:key});
    await remove(key);
    return null;
  }

  async function put(bookId, book, file, metadata) {
    const record = {
      bookId:String(bookId),
      cacheVersion:CACHE_VERSION,
      size:Number(book.size),
      updatedAt:Number(book.updated_at),
      kind:book.kind,
      file,
      metadata
    };
    await withStore('readwrite', store => requestResult(store.put(record)));
  }

  window.readerCache = {CACHE_VERSION, get, put, remove};
})();
