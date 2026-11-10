/* IndexedDB game checkpoints. No network operations; localStorage is read only for legacy migration. */
(function(root) {
  'use strict';

  function indexedAdapter(idb) {
    let opened = null;

    function open() {
      if (opened) return opened;
      opened = new Promise((resolve, reject) => {
        if (!idb) {
          reject(Error('此浏览器未开放本地数据库。'));
          return;
        }
        const req = idb.open('guanchao-rail-checkpoints', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('saves')) req.result.createObjectStore('saves');
        };
        req.onerror = () => reject(req.error || Error('无法打开本地数据库。'));
        req.onblocked = () => reject(Error('本地数据库被其他页面占用，请关闭旧游戏标签页后重试。'));
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            opened = null;
          };
          resolve(db);
        };
      }).catch(error => {
        opened = null;
        throw error;
      });
      return opened;
    }
    return {
      async get(key) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction('saves', 'readonly'),
            r = tx.objectStore('saves').get(key);
          let value;
          r.onsuccess = () => value = r.result;
          tx.oncomplete = () => resolve(value);
          tx.onerror = () => reject(tx.error || r.error || Error('存档读取失败。'));
          tx.onabort = () => reject(tx.error || Error('存档读取中断。'));
        });
      },
      async put(key, value, expected) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction('saves', 'readwrite');
          const store=tx.objectStore('saves'), read=store.get(key);
          let conflict=false;
          read.onsuccess=()=>{if(expected!==undefined&&(read.result?.text??null)!==expected){conflict=true;tx.abort();}else store.put(value,key);};
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || Error('存档写入失败。'));
          tx.onabort = () => reject(Error(conflict?'COMMIT_CONFLICT':(tx.error?.message||'COMMIT_ABORTED')));
        });
      }
    };
  }

  const native=(action,args)=>(typeof module!=='undefined'&&module.exports?require('./bootstrap-wasm'):root.RailBootstrap).persistence(action,args);
  function create(adapter,legacy){
    let queue;
    const writes=()=>queue||(queue=(typeof module!=='undefined'&&module.exports?require('./save-queue'):root.RailSaveQueue).create({coalesce:false}));
    const legacyRead=key=>{try{return legacy?.getItem(key)??null;}catch{return null;}};
    async function read(key){await writes().flush();let record,failed=false;try{record=await adapter.get(key);native('storageObserved',{key,text:record?.text??null});}catch{failed=true;}return native('read',{record,legacy:legacyRead(key),failed});}
    function writeRecord(key,record,legacyText=null){return writes().request(async()=>{
      if(!native('storageExpected',{key}).known){const old=await adapter.get(key);native('storageObserved',{key,text:old?.text??null});}
      await adapter.put(key,record,native('storageExpected',{key}).text);native('storageObserved',{key,text:record.text});
      const result=native('committed',{record:{bytes:record.bytes,savedAt:record.savedAt},legacy:legacyText,currentLegacy:legacyRead(key)});
      if(result.cleanup)try{legacy.removeItem(key);}catch{}
      return result;
    });}
    function write(key,value,legacyText=null){const record=native('prepareWrite',{value,at:Date.now()});return writeRecord(key,record,legacyText);}
    function records(key,value,state,checkpoint){const result=native('records',{raw:legacyRead(key),value,state,checkpoint});return result;}
    function persistRecords(key,value,state){const result=records(key,value,state);try{legacy?.setItem(key,result.text);}catch{}return result.value;}
    return {read,write,writeRecord,records,persistRecords,flush:()=>writes().flush()};
  }
  function workerSerializer(){return value=>Promise.resolve(native('encode',{value}).text);}
  const node=typeof module!=='undefined'&&module.exports;
  let legacy=null;try{legacy=root.localStorage;}catch{}
  const api=create(indexedAdapter(root.indexedDB),legacy);
  Object.assign(api,{create,indexedAdapter,workerSerializer});
  if(node)module.exports=api;else root.RailSaveStore=api;
})(typeof globalThis!=='undefined'?globalThis:this);
