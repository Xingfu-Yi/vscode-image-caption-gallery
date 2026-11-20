const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const tick=()=>new Promise(setImmediate);
function setup(t,copy=async()=>{},language='en'){
 const dom=new JSDOM('<main id="root"><button id="target">File</button><span id="text">Selected text</span><textarea id="editor"></textarea></main>',{runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,doc=w.document,root=doc.querySelector('#root');let record={id:'a',filePath:'/data/中文 100% %20%2F #?.jpg'};
 w.eval(fs.readFileSync(path.join(__dirname,'../media/fileContextMenu.js'),'utf8'));
 const menu=new w.GalleryFileMenu({root,resolveTarget:event=>event.target.closest('#target')?record:null,copy,language});t.after(()=>{menu.dispose();w.close()});
 const context=(selector='#target',extra={})=>{const event=new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:100,clientY:90,...extra});doc.querySelector(selector).dispatchEvent(event);return event};
 return {w,doc,root,menu,context,setRecord:value=>record=value};
}
test('right click and keyboard menu share one item inside the viewer; inputs keep their native menu',t=>{
 const ui=setup(t,undefined,'zh');assert.equal(ui.context().defaultPrevented,true);assert.equal(ui.doc.querySelectorAll('[role=menuitem]').length,1);assert.equal(ui.doc.querySelector('[role=menuitem]').textContent,'复制文件路径');assert.ok(ui.root.contains(ui.menu.menu));
 assert.equal(ui.context('#editor').defaultPrevented,false);assert.equal(ui.menu.menu,null);
 const target=ui.doc.querySelector('#target');target.focus();const event=new ui.w.KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true});target.dispatchEvent(event);assert.equal(event.defaultPrevented,true);assert.ok(ui.menu.menu);
 ui.menu.close();target.dispatchEvent(new ui.w.KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true,cancelable:true}));assert.ok(ui.menu.menu);
});
test('menu clamps to the viewport and consumes Escape before gallery navigation; dismissal removes it',t=>{
 const ui=setup(t);Object.defineProperties(ui.w,{innerWidth:{value:320},innerHeight:{value:200}});const rect=ui.w.HTMLElement.prototype.getBoundingClientRect;
 ui.w.HTMLElement.prototype.getBoundingClientRect=function(){return this.classList.contains('gallery-file-menu')?{width:180,height:40}:rect.call(this)};
 ui.context('#target',{clientX:319,clientY:199});assert.equal(ui.menu.menu.style.left,'136px');assert.equal(ui.menu.menu.style.top,'156px');
 let exits=0;ui.doc.addEventListener('keydown',()=>exits++,true);ui.doc.dispatchEvent(new ui.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(exits,0);assert.equal(ui.doc.querySelector('[role=menu]'),null);
 ui.context();ui.doc.querySelector('#editor').dispatchEvent(new ui.w.Event('pointerdown',{bubbles:true}));assert.equal(ui.menu.menu,null);
 for(const event of ['blur','resize','pagehide']){ui.context();ui.w.dispatchEvent(new ui.w.Event(event));assert.equal(ui.menu.menu,null)}
 ui.context();ui.root.dispatchEvent(new ui.w.Event('scroll'));assert.equal(ui.menu.menu,null);
});
test('copy snapshots the chosen file, keeps failed menus retryable and closes only the successful menu',async t=>{
 const calls=[];let fail=true;const ui=setup(t,async record=>{calls.push(record);if(fail)throw Error('Clipboard denied')});ui.context();ui.setRecord({id:'b',filePath:'/new.jpg'});ui.doc.querySelector('[role=menuitem]').click();await tick();
 assert.equal(calls[0].id,'a');assert.match(ui.doc.querySelector('[role=alert]').textContent,/Could not copy/);assert.equal(ui.doc.querySelector('[role=menuitem]').disabled,false);
 fail=false;ui.doc.querySelector('[role=menuitem]').click();await tick();assert.equal(calls[1].id,'a');assert.equal(ui.menu.menu,null);
 ui.menu.dispose();assert.equal(ui.context().defaultPrevented,false);
});
test('clipboard API receives exact literal path and fallback preserves focus and selection in fullscreen root',async t=>{
 const ui=setup(t),written=[];const value='/data/中文 100% %20%2F #?.jpg';Object.defineProperty(ui.w.navigator,'clipboard',{configurable:true,value:{writeText:text=>{written.push(text);return Promise.resolve()}}});
 const pending=ui.w.GalleryFileMenu.writeText(value);assert.deepEqual(written,[value],'clipboard call occurs synchronously during the click');await pending;
 const active=ui.doc.querySelector('#target');active.focus();const range=ui.doc.createRange();range.selectNodeContents(ui.doc.querySelector('#text'));ui.w.getSelection().removeAllRanges();ui.w.getSelection().addRange(range);assert.equal(ui.w.getSelection().toString(),'Selected text');Object.defineProperty(ui.doc,'fullscreenElement',{configurable:true,value:ui.root});
 ui.doc.execCommand=command=>{assert.equal(command,'copy');const field=ui.root.querySelector('.gallery-copy-field');assert.equal(field.value,value);return true};
 for(const writeText of [()=>Promise.reject(Error('denied')),()=>{throw Error('denied')}]){Object.defineProperty(ui.w.navigator,'clipboard',{configurable:true,value:{writeText}});await ui.w.GalleryFileMenu.writeText(value);assert.equal(ui.doc.activeElement,active);assert.equal(ui.w.getSelection().toString(),'Selected text');assert.equal(ui.doc.querySelector('.gallery-copy-field'),null)}
 Object.defineProperty(ui.w.navigator,'clipboard',{value:undefined});await ui.w.GalleryFileMenu.writeText(value);
 ui.doc.execCommand=()=>false;await assert.rejects(ui.w.GalleryFileMenu.writeText(value),/Clipboard access was denied/);await assert.rejects(ui.w.GalleryFileMenu.writeText(''),/unavailable/);
});

test('copy failure repositions the expanded error menu above the viewport edge',async t=>{
 const ui=setup(t,async()=>{throw Error('denied')});Object.defineProperty(ui.w,'innerHeight',{value:200});const rect=ui.w.HTMLElement.prototype.getBoundingClientRect;
 ui.w.HTMLElement.prototype.getBoundingClientRect=function(){return this.classList.contains('gallery-file-menu')?{width:180,height:this.querySelector('[role=alert]').hidden?40:80}:rect.call(this)};
 ui.context('#target',{clientY:199});assert.equal(ui.menu.menu.style.top,'156px');ui.doc.querySelector('[role=menuitem]').click();await tick();assert.equal(ui.menu.menu.style.top,'116px');
});
