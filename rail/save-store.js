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
    async function putMany(rows) {
      const db=await open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction('saves','readwrite'), store=tx.objectStore('saves');
        let failure;
        tx.oncomplete=()=>resolve();
        tx.onabort=()=>reject(failure || tx.error || Error('COMMIT_ABORTED'));
        try {
          for(const {key,value,expected} of rows){
            const read=store.get(key);
            read.onsuccess=()=>{
              if(failure)return;
              const old=read.result;
              const matches=old===undefined ? expected===null : typeof old?.text==='string' && old.text===expected;
              if(expected!==undefined && !matches){
                failure=Error('COMMIT_CONFLICT');
                tx.abort();
                return;
              }
              store.put(value,key);
            };
          }
        }catch(error){
          failure=error;
          tx.abort();
        }
      });
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
      put:(key,value,expected)=>putMany([{key,value,expected}]),
      putMany
    };
  }

  const native=(action,args)=>(typeof module!=='undefined'&&module.exports?require('./bootstrap-wasm'):root.RailBootstrap).persistence(action,args);
  function create(adapter,legacy){
    let queue;
    const writes=()=>queue||(queue=(typeof module!=='undefined'&&module.exports?require('./save-queue'):root.RailSaveQueue).create({coalesce:false}));
    const legacyRead=key=>{try{return legacy?.getItem(key)??null;}catch{return null;}};
    function replacementLegacy(key){
      try{return legacy?.getItem(key)??null;}catch{throw Error('READ_STORAGE');}
    }
    async function read(key){await writes().flush();let record,failed=false;try{record=await adapter.get(key);native('storageObserved',{key,text:record?.text??null});}catch{failed=true;}return native('read',{record,legacy:legacyRead(key),failed});}
    function writeRecord(key,record,legacyText=null){return writes().request(async()=>{
      if(!native('storageExpected',{key}).known){const old=await adapter.get(key);native('storageObserved',{key,text:old?.text??null});}
      await adapter.put(key,record,native('storageExpected',{key}).text);native('storageObserved',{key,text:record.text});
      const result=native('committed',{record:{bytes:record.bytes,savedAt:record.savedAt},legacy:legacyText,currentLegacy:legacyRead(key)});
      if(result.cleanup)try{legacy.removeItem(key);}catch{}
      return result;
    });}
    async function replacementBase(key,guardActive=false){
      await writes().flush();
      let record;
      try{record=await adapter.get(key);}catch{throw Error('READ_STORAGE');}
      const {source}=native('replacementBase',{key,record,guardActive});
      const legacyText=source==='legacy'?replacementLegacy(key):null;
      return Object.freeze({key,expected:record?.text??null,previous:record?.text??legacyText,checkLegacy:source==='legacy',legacyText});
    }
    function writeReplacement(entries){
      return writes().request(async()=>{
        if(!entries.length || new Set(entries.map(({base})=>base.key)).size!==entries.length)throw Error('COMMIT_INVALID_TARGET');
        const rows=entries.map(({base,record})=>{
          if(record.saveKey!==undefined && record.saveKey!==base.key)throw Error('COMMIT_INVALID_TARGET');
          if(base.checkLegacy && replacementLegacy(base.key)!==base.legacyText)throw Error('COMMIT_CONFLICT');
          const {text,bytes,savedAt}=record;
          return {key:base.key,expected:base.expected,value:{text,bytes,savedAt}};
        });
        if(rows.length===1)await adapter.put(rows[0].key,rows[0].value,rows[0].expected);
        else await adapter.putMany(rows);
        // IDB has committed. Auxiliary observations and legacy cleanup cannot
        // turn that success into a retry of the replacement.
        for(const {base,record} of entries){
          try{
            native('storageObserved',{key:base.key,text:record.text});
            if(base.legacyText!==null && legacyRead(base.key)===base.legacyText)legacy.removeItem(base.key);
          }catch(error){console.warn('Checkpoint bookkeeping',error);}
        }
        const {bytes,savedAt}=rows[0].value;
        return {source:'indexeddb',bytes,savedAt};
      });
    }
    function write(key,value,legacyText=null){const record=native('prepareWrite',{value,at:Date.now()});return writeRecord(key,record,legacyText);}
    function records(key,value,state,checkpoint){const result=native('records',{raw:legacyRead(key),value,state,checkpoint});return result;}
    function persistRecords(key,value,state){const result=records(key,value,state);try{legacy?.setItem(key,result.text);}catch{}return result.value;}
    return {read,write,writeRecord,replacementBase,writeReplacement,records,persistRecords,flush:()=>writes().flush()};
  }
  function workerSerializer(){return value=>Promise.resolve(native('encode',{value}).text);}
  const node=typeof module!=='undefined'&&module.exports;
  let legacy=null;try{legacy=root.localStorage;}catch{}
  const api=create(indexedAdapter(root.indexedDB),legacy);
  Object.assign(api,{create,indexedAdapter,workerSerializer});
  if(node)module.exports=api;else root.RailSaveStore=api;
})(typeof globalThis!=='undefined'?globalThis:this);
