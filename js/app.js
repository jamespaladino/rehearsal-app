/*
 * Rehearsal app logic: script library (IndexedDB), screenplay editor, reader-line recording,
 * and play mode (reader playback + voice detection for the actor's lines).
 *
 * Loaded as a classic deferred script after vendor/lucide/lucide.min.js and js/icons.js,
 * so the app keeps working when index.html is opened directly from disk (file://).
 */
// Swap the <i data-lucide> placeholders in index.html for Lucide SVGs before any UI code runs.
renderIcons();

// Save appearance separately from scripts and recordings.
const $=id=>document.getElementById(id);
const shell=document.querySelector('.app-shell');
// Sidebar: docked beside the page on wider screens; on mobile (under 768px, shadcn's
// breakpoint) it starts hidden and opens over the page with a backdrop.
const mobileQuery=matchMedia('(max-width: 767px)');
function setSidebar(open){
  if(mobileQuery.matches){
    shell.classList.toggle('sidebar-mobile-open',open);
    $('sidebarBackdrop').classList.toggle('hidden',!open);
    document.body.style.overflow=open||!$('playPane').classList.contains('hidden')?'hidden':'';
    $('openSidebar').classList.remove('hidden');
    (open?$('collapseSidebar'):$('openSidebar')).focus({preventScroll:true});
  }else{
    shell.classList.toggle('sidebar-closed',!open);
    $('openSidebar').classList.toggle('hidden',open);
  }
}
function closeMobileSidebar(){if(shell.classList.contains('sidebar-mobile-open'))setSidebar(false)}
// Crossing the breakpoint resets to that size's default.
function syncSidebarToViewport(){
  shell.classList.remove('sidebar-mobile-open');$('sidebarBackdrop').classList.add('hidden');
  if(!$('playPane').classList.contains('hidden'))document.body.style.overflow='hidden';else document.body.style.overflow='';
  $('openSidebar').classList.toggle('hidden',!mobileQuery.matches&&!shell.classList.contains('sidebar-closed'));
}
mobileQuery.addEventListener('change',syncSidebarToViewport);syncSidebarToViewport();
$('collapseSidebar').onclick=()=>setSidebar(false);
$('openSidebar').onclick=()=>setSidebar(true);
$('sidebarBackdrop').onclick=()=>setSidebar(false);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&shell.classList.contains('sidebar-mobile-open')&&!modalAction)setSidebar(false)});
// Theme: a shadcn ToggleGroup (sun = light, moon = dark); the active theme shows as pressed.
function applyTheme(theme){
  const dark=theme==='dark';document.documentElement.dataset.theme=dark?'dark':'light';
  $('themeLight').setAttribute('aria-pressed',String(!dark));
  $('themeDark').setAttribute('aria-pressed',String(dark));
}
let savedTheme='light';try{savedTheme=localStorage.getItem('rehearsal-theme')||'light'}catch(e){}
applyTheme(savedTheme);
for(const [id,theme] of [['themeLight','light'],['themeDark','dark']]){
  $(id).addEventListener('click',()=>{applyTheme(theme);try{localStorage.setItem('rehearsal-theme',theme)}catch(e){}});
}

let db,script=null,recorder=null,stream=null,chunks=[],audioCtx=null,analyser=null,raf=null,playing=false,idx=0,heard=false,speechAt=0,lastVoice=0,noiseFloor=.015,activeAudio=null,beatTimer=null,partsNeeded=1,partsHeard=0,gapTimer=null;
// Every reader recording currently sounding (more than one while lines overlap).
const playingAudios=new Set();
// A single shared microphone stream is reused for recording and rehearsal.
async function getMicrophone(){
  if(stream && stream.getAudioTracks().some(t=>t.readyState==='live'))return stream;
  stream=null;
  stream=await navigator.mediaDevices.getUserMedia({audio:true});
  stream.getTracks().forEach(t=>t.addEventListener('ended',()=>{
    if(stream && !stream.getAudioTracks().some(track=>track.readyState==='live')){
      stream=null;updateMicState();
    }
  }));
  updateMicState();return stream;
}
function updateMicState(){
  const live=!!(stream && stream.getAudioTracks().some(t=>t.readyState==='live'));
  const label=live?'Microphone: connected (released on return to library)':'Microphone: not connected';
  const micButton=$('micState');
  micButton.replaceChildren(icon(live?'mic':'mic-off'));
  micButton.setAttribute('aria-label',label);
  setTip(micButton,label);
  $('micStatusLabel').textContent=label;
  $('connectMic').classList.toggle('hidden',live);
  $('releaseMic').classList.toggle('hidden',!live);
}
function releaseMicrophone(){
  stop();
  if(recorder && recorder.state!=='inactive')recorder.stop();
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}
  updateMicState();
}
// Microphone dropdown: status label plus Connect / Release.
function setMicMenu(open){
  $('micMenu').classList.toggle('hidden',!open);
  $('micState').setAttribute('aria-expanded',String(open));
}
$('micState').onclick=e=>{e.stopPropagation();setMicMenu($('micMenu').classList.contains('hidden'))};
$('micMenu').onclick=e=>e.stopPropagation();
document.addEventListener('click',()=>setMicMenu(false));
document.addEventListener('keydown',e=>{if(e.key==='Escape')setMicMenu(false)});
$('connectMic').onclick=async()=>{setMicMenu(false);try{await getMicrophone()}catch(e){alert('Microphone unavailable: '+e.message)}};
$('releaseMic').onclick=()=>{setMicMenu(false);releaseMicrophone()};
window.addEventListener('pagehide',()=>{if(stream)stream.getTracks().forEach(t=>t.stop())});
const req=indexedDB.open('rehearsal-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('scripts',{keyPath:'id'});req.onsuccess=async()=>{db=req.result;try{const scripts=await getAll();const lastId=localStorage.getItem("rehearsal-last-opened");const target=scripts.find(s=>s.id===lastId)||scripts[0];if(target)await openScript(target);else await library()}catch(e){console.error("Could not restore last script",e);await library()}};req.onerror=()=>alert('Local storage unavailable. Try a modern browser.');
const store=(mode='readonly')=>db.transaction('scripts',mode).objectStore('scripts');const getAll=()=>new Promise((ok,no)=>{let r=store().getAll();r.onsuccess=()=>ok(r.result);r.onerror=no});const put=s=>new Promise((ok,no)=>{let r=store('readwrite').put(s);r.onsuccess=ok;r.onerror=no});const del=id=>new Promise((ok,no)=>{let r=store('readwrite').delete(id);r.onsuccess=ok;r.onerror=no});
function el(tag,text){let x=document.createElement(tag);if(text!==undefined)x.textContent=text;return x}
// shadcn DropdownMenuItem. variant: undefined (default) or 'destructive'; iconName: optional Lucide icon.
function dropdownItem(label,onSelect,variant,iconName){
  const item=el('button',label);item.type='button';item.className='dropdown-menu-item';
  if(variant)item.dataset.variant=variant;
  if(iconName)item.prepend(icon(iconName));
  item.onclick=e=>{e.stopPropagation();onSelect()};
  return item;
}
// shadcn DropdownMenuSeparator.
function dropdownSeparator(){const line=el('div');line.className='dropdown-menu-separator';line.setAttribute('role','separator');return line}

// Beat length: stored on the block as seconds (0–120, default 2).
const BEAT_DURATIONS=[1,2,3,5,10];
function beatSeconds(t){const d=Number(t.duration??2);return Math.max(0,Math.min(120,Number.isFinite(d)?d:2))}
function secondsLabel(n){return n+' second'+(n===1?'':'s')}
// shadcn DropdownMenuRadioItem: {label, icon?, checked, onSelect}; the checked item shows a check mark.
function dropdownRadioItem(opt){
  const option=el('button');option.type='button';option.className='dropdown-menu-radio-item';
  option.setAttribute('role','menuitemradio');option.setAttribute('aria-checked',String(!!opt.checked));
  const indicator=el('span');indicator.className='dropdown-menu-radio-item-indicator';if(opt.checked)indicator.append(icon('check'));
  option.append(indicator);
  if(opt.icon)option.append(icon(opt.icon));
  option.append(document.createTextNode(opt.label));
  option.onclick=e=>{e.stopPropagation();opt.onSelect()};
  return option;
}
// shadcn DropdownMenuSub with RadioItems: a trigger row that opens a list to its right.
// options: [{label, icon?, checked, onSelect}] — the checked option shows a check mark.
function dropdownSubmenu(triggerIcon,triggerLabel,options){
  const sub=el('div');sub.className='dropdown-menu-sub';
  const trigger=el('button');trigger.type='button';trigger.className='dropdown-menu-sub-trigger';
  trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');
  trigger.append(icon(triggerIcon),el('span',triggerLabel),icon('chevron-right'));
  const content=el('div');content.className='dropdown-menu dropdown-menu-sub-content hidden';content.setAttribute('role','menu');
  for(const opt of options)content.append(dropdownRadioItem(opt));
  const setOpen=open=>{content.classList.toggle('hidden',!open);trigger.toggleAttribute('data-open',open);trigger.setAttribute('aria-expanded',String(open))};
  trigger.onclick=e=>{e.stopPropagation();setOpen(content.classList.contains('hidden'))};
  if(matchMedia('(hover: hover)').matches){sub.onmouseenter=()=>setOpen(true);sub.onmouseleave=()=>setOpen(false)}
  trigger.onkeydown=e=>{if(e.key==='ArrowRight'){e.preventDefault();setOpen(true);content.querySelector('[aria-checked="true"]')?.focus()||content.querySelector('button')?.focus()}};
  content.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='Escape'){e.preventDefault();e.stopPropagation();setOpen(false);trigger.focus()}};
  sub.append(trigger,content);
  return sub;
}
// Beat length: the trigger shows the current length.
function beatDurationSubmenu(t,onChange){
  const current=beatSeconds(t);
  return dropdownSubmenu('timer',secondsLabel(current),BEAT_DURATIONS.map(n=>({label:secondsLabel(n),checked:n===current,onSelect:()=>onChange(n)})));
}
// Reader spacing (per script): seconds between back-to-back reader lines. Negative values
// overlap them: the next line starts that long before the current one ends.
const READER_SPACING=[
  {value:-1,label:'Overlap 1 second'},{value:-0.5,label:'Overlap ½ second'},{value:0,label:'No gap'},
  {value:0.5,label:'½ second'},{value:1,label:'1 second'},{value:2,label:'2 seconds'},
];
function readerSpacing(){const v=Number(script?.readerSpacing);return Number.isFinite(v)?Math.max(-5,Math.min(10,v)):0}
// Play pane settings menu: a "Reader spacing" label with a radio list of spacings.
function renderPlaySettings(){
  const current=readerSpacing();
  const label=el('div','Reader spacing');label.className='dropdown-menu-label';
  $('playSettingsMenu').replaceChildren(label,...READER_SPACING.map(o=>dropdownRadioItem({label:o.label,checked:o.value===current,onSelect:()=>{
    script.readerSpacing=o.value;queueSave(true);renderPlaySettings();
    $('playSettingsMenu').querySelector('[aria-checked="true"]')?.focus({preventScroll:true});
  }})));
}
function setPlaySettings(open){
  if(open)renderPlaySettings();
  $('playSettingsMenu').classList.toggle('hidden',!open);
  $('playSettingsToggle').setAttribute('aria-expanded',String(open));
}
// Length of a recording in seconds. Browser recordings often don't report it, so decode the audio once.
const audioDurations=new WeakMap();
function audioDuration(blob){
  if(!audioDurations.has(blob))audioDurations.set(blob,blob.arrayBuffer().then(data=>audioCtx.decodeAudioData(data)).then(buffer=>buffer.duration));
  return audioDurations.get(blob);
}
// Block types a block can be turned into, in menu order.
const BLOCK_TYPES=[
  {who:'me',label:'Me',icon:'arrow-left',apply:t=>{t.who='me'}},
  {who:'them',label:'Them',icon:'arrow-right',apply:t=>{t.who='them'}},
  {who:'beat',label:'Beat',icon:'gap-vertical',apply:t=>{t.who='beat';t.duration??=2}},
  {who:'heading',label:'Scene heading',icon:'clapperboard',apply:t=>{t.who='heading';t.text=(t.text||'').toUpperCase()}},
  {who:'action',label:'Action',icon:'pilcrow',apply:t=>{t.who='action'}},
];
function turnIntoSubmenu(t,onChange){
  return dropdownSubmenu('repeat','Turn into',BLOCK_TYPES.map(type=>({label:type.label,icon:type.icon,checked:t.who===type.who,onSelect:()=>{type.apply(t);onChange()}})));
}
// Tooltips: any element with data-tooltip shows one on mouse hover or keyboard focus.
const tooltip=el('div');tooltip.className='tooltip';tooltip.setAttribute('aria-hidden','true');document.body.append(tooltip);
let tipTarget=null;
function showTip(t){
  tipTarget=t;tooltip.textContent=t.dataset.tooltip;
  const r=t.getBoundingClientRect(),w=tooltip.offsetWidth,h=tooltip.offsetHeight;
  let top=r.top-h-4;if(top<4)top=r.bottom+4;
  const left=Math.max(4,Math.min(r.left+r.width/2-w/2,innerWidth-w-4));
  tooltip.style.top=top+'px';tooltip.style.left=left+'px';tooltip.classList.add('visible');
}
function hideTip(){tipTarget=null;tooltip.classList.remove('visible')}
function setTip(b,text){b.dataset.tooltip=text;b.removeAttribute('title');if(tipTarget===b)showTip(b)}
document.addEventListener('mouseover',e=>{const t=e.target.closest?.('[data-tooltip]');if(t===tipTarget)return;if(t&&matchMedia('(hover:hover)').matches)showTip(t);else hideTip()});
document.addEventListener('mouseout',e=>{if(!e.relatedTarget)hideTip()});
document.addEventListener('focusin',e=>{const t=e.target.closest?.('[data-tooltip]');if(t&&t.matches(':focus-visible'))showTip(t);else if(t!==tipTarget)hideTip()});
document.addEventListener('focusout',e=>{if(e.target===tipTarget)hideTip()});
document.addEventListener('pointerdown',hideTip,true);
document.addEventListener('keydown',e=>{if(e.key==='Escape')hideTip()});
window.addEventListener('scroll',hideTip,true);
let modalAction=null,modalPreviousFocus=null;let openBlockMenu=null;
let saveTimer=null, saveChain=Promise.resolve();
function queueSave(immediate=false){
  if(!script)return;
  clearTimeout(saveTimer);
  const id=script.id;
  saveTimer=setTimeout(()=>{
    if(!script||script.id!==id)return;
    const snapshot=structuredClone(script);
    saveChain=saveChain.catch(()=>{}).then(()=>put(snapshot)).then(()=>library()).catch(e=>console.error('Autosave failed:',e));
  },immediate?0:400);
}
async function flushSave(){
  clearTimeout(saveTimer);
  if(script){const snapshot=structuredClone(script);saveChain=saveChain.catch(()=>{}).then(()=>put(snapshot));}
  await saveChain;
}

function closeModal(){modalAction=null;$('modalBackdrop').classList.add('hidden');$('modalError').textContent='';if(modalPreviousFocus?.isConnected)modalPreviousFocus.focus()}
function openModal(type,s){modalPreviousFocus=document.activeElement;modalAction={type,id:s.id};$('modalTitle').textContent=type==='rename'?'Rename script':'Delete script?';$('modalMessage').textContent=type==='rename'?'Choose a new name for this script.':`Delete “${s.title||'Untitled'}” and all its recordings? This cannot be undone.`;$('renameFields').classList.toggle('hidden',type!=='rename');$('renameInput').required=type==='rename';$('renameInput').value=s.title||'';$('modalConfirm').textContent=type==='rename'?'Save':'Delete';$('modalConfirm').className='btn '+(type==='rename'?'btn-default':'btn-destructive');$('modalError').textContent='';$('modalBackdrop').classList.remove('hidden');(type==='rename'?$('renameInput'):$('modalCancel')).focus()}
$('modalCancel').onclick=closeModal;
$('modalBackdrop').addEventListener('click',e=>{if(e.target===$('modalBackdrop'))closeModal()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modalAction){e.preventDefault();closeModal()}});
$('modalForm').onsubmit=async e=>{e.preventDefault();if(!modalAction)return;const {type,id}=modalAction;const btn=$('modalConfirm');btn.disabled=true;try{if(type==='rename'){const title=$('renameInput').value.trim();if(!title){$('modalError').textContent='Enter a script name.';return}const r=store().get(id);const saved=await new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});if(!saved)throw new Error('Script no longer exists');saved.title=title;await put(saved);if(script?.id===id){script.title=title;$('title').value=title;$('scriptHeading').textContent=title;updateScriptHeader()}}else{if(script?.id===id){clearTimeout(saveTimer);script=null;}await saveChain;await del(id);try{if(localStorage.getItem("rehearsal-last-opened")===id)localStorage.removeItem("rehearsal-last-opened")}catch(e){}if(!script){stop();releaseMicrophone();script=null;$('playButton').classList.add('hidden');closePlayPane();$('editor').classList.add('hidden');updateScriptHeader()}}closeModal();await library()}catch(err){$('modalError').textContent=err.message||'Could not save changes.';$('renameFields').classList.remove('hidden')}finally{btn.disabled=false}};
let activeMenu=null;
function closeMenu(){if(activeMenu){activeMenu.classList.add('hidden');activeMenu.previousElementSibling?.setAttribute('aria-expanded','false');activeMenu=null}}
document.addEventListener('click',()=>closeMenu());
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu()});
async function library(){
  closeMenu();
  // Load first, then replace the list in one step, so overlapping calls can't add duplicate rows.
  const scripts=await getAll();
  const list=$('library');list.replaceChildren();
  for(const s of scripts){
    const name=s.title||'Untitled script';
    const item=el('li');item.className='sidebar-menu-item';
    const open=el('button');open.type='button';open.className='sidebar-menu-button';
    open.setAttribute('aria-label','Open '+name);
    if(script?.id===s.id){open.dataset.active='';open.setAttribute('aria-current','true')}
    open.append(el('span',s.title||'Untitled'));
    open.onclick=()=>{closeMenu();closeMobileSidebar();openScript(s)};
    const toggle=el('button');toggle.type='button';toggle.className='sidebar-menu-action';toggle.dataset.showOnHover='';toggle.append(icon('ellipsis'));
    toggle.setAttribute('aria-label','Options for '+name);toggle.setAttribute('aria-haspopup','true');toggle.setAttribute('aria-expanded','false');
    const menu=el('div');menu.className='dropdown-menu script-menu hidden';
    menu.append(
      dropdownItem('Rename',()=>{closeMenu();openModal('rename',s)},undefined,'pen'),
      dropdownItem('Delete',()=>{closeMenu();openModal('delete',s)},'destructive','trash'));
    menu.onclick=e=>e.stopPropagation();
    toggle.onclick=e=>{e.stopPropagation();const wasOpen=!menu.classList.contains('hidden');closeMenu();if(!wasOpen){menu.classList.remove('hidden');toggle.setAttribute('aria-expanded','true');activeMenu=menu}};
    item.append(open,toggle,menu);list.append(item);
  }
}
function updateScriptHeader(){
  $('topScriptTitleText').textContent=script?(script.title||'Untitled script'):'';
  $('titleDropdownWrap').classList.toggle('hidden',!script);
  closeTitleDropdown();
  $('topScriptActions').classList.toggle('hidden',!script);
  $('topScriptMenu').classList.add('hidden');
  $('topScriptMenuToggle').setAttribute('aria-expanded','false');
}
function closeTitleDropdown(){
  $('titleDropdown').classList.add('hidden');
  $('topScriptTitle').setAttribute('aria-expanded','false');
}
$('topScriptTitle').onclick=e=>{
  e.stopPropagation();if(!script)return;
  const opening=$('titleDropdown').classList.contains('hidden');
  closeTitleDropdown();
  if(opening){
    $('quickRenameInput').value=script.title||'';
    $('quickRenameError').textContent='';
    $('titleDropdown').classList.remove('hidden');
    $('topScriptTitle').setAttribute('aria-expanded','true');
    $('quickRenameInput').focus();$('quickRenameInput').select();
  }
};
$('titleDropdown').onclick=e=>e.stopPropagation();
$('quickRenameCancel').onclick=closeTitleDropdown;
$('titleDropdown').onsubmit=async e=>{
  e.preventDefault();if(!script)return;
  const name=$('quickRenameInput').value.trim();
  if(!name){$('quickRenameError').textContent='Enter a script name.';return}
  const button=$('titleDropdown').querySelector('[type="submit"]');button.disabled=true;
  try{
    script.title=name;$('title').value=name;
    await flushSave();updateScriptHeader();await library();
  }catch(err){$('quickRenameError').textContent=err.message||'Could not rename script.'}
  finally{button.disabled=false}
};
document.addEventListener('click',e=>{if(!e.target.closest('#titleDropdownWrap'))closeTitleDropdown()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeTitleDropdown()});
$('topScriptMenuToggle').onclick=e=>{e.stopPropagation();const menu=$('topScriptMenu');const opening=menu.classList.contains('hidden');menu.classList.toggle('hidden',!opening);$('topScriptMenuToggle').setAttribute('aria-expanded',String(opening))};
$('topScriptActions').onclick=e=>e.stopPropagation();
document.addEventListener('click',e=>{if(!e.target.closest('#topScriptActions'))$('topScriptMenu').classList.add('hidden')});
$('topRename').onclick=()=>{if(script){$('topScriptMenu').classList.add('hidden');openModal('rename',script)}};
$('topDelete').onclick=()=>{if(script){$('topScriptMenu').classList.add('hidden');openModal('delete',script)}};
// New scripts start with one blank dialogue line, ready for the first character name.
$('newScript').onclick=async()=>{closeMobileSidebar();await flushSave();const fresh={id:crypto.randomUUID(),title:'Untitled script',meCharacter:'ME',otherCharacters:[],turns:[{who:'heading',text:''},{who:'action',text:''},newDialogueLine()]};await put(fresh);await openScript(fresh);focusBlockText(0)};$('back').onclick=async()=>{await flushSave();stop();releaseMicrophone();script=null;$('playButton').classList.add('hidden');closePlayPane();$('editor').classList.add('hidden');updateScriptHeader();library()};
async function openScript(s){await flushSave();$('playButton').classList.remove('hidden');if(script?.id!==s.id){stop();releaseMicrophone()}script=s;try{localStorage.setItem("rehearsal-last-opened",s.id)}catch(e){}$('title').value=s.title;updateScriptHeader();$('editor').classList.remove('hidden');enterMode('record');render();library()}
function showHome(){stop();$('scriptHeading').textContent=script.title||'Untitled script';$('scriptHome').classList.remove('hidden');$('workspace').classList.add('hidden')}
function enterMode(m){$('scriptHome').classList.add('hidden');$('workspace').classList.remove('hidden');setMode(m)}
$('home').onclick=()=>{script.title=$('title').value.trim()||'Untitled script';showHome()};$('enterRecord').onclick=()=>enterMode('record');$('enterPlay').onclick=()=>enterMode('play');
// Play mode is a full-page pane over the editor; record mode is the editor itself.
function setMode(m){if(m==='play')openPlayPane();else closePlayPane()}
function openPlayPane(){
  if(!script)return;
  stop();hideTip();
  $('playPaneTitle').textContent=script.title||'Untitled script';
  const all=scenes();
  const kept=sceneRange.scriptId===script.id&&all.find(scene=>scene.start===sceneRange.start);
  selectScene(kept||all[0]);
  setPlayHelp(false);setPlaySettings(false);
  setScenesOpen(mobileQuery.matches?false:scenesPreferred);
  $('playPane').classList.remove('hidden');document.body.style.overflow='hidden';
  display(true); // center the cued line now that the pane is visible
  $('start').focus({preventScroll:true});
}
function closePlayPane(){
  const wasOpen=!$('playPane').classList.contains('hidden');
  stop();setPlayHelp(false);setPlaySettings(false);$('playPane').classList.add('hidden');document.body.style.overflow='';
  if(wasOpen&&!$('playButton').classList.contains('hidden'))$('playButton').focus();
}
$('playButton').onclick=()=>setMode('play');$('closePlay').onclick=()=>setMode('record');
// Escape closes the help or settings menu first, then the play pane.
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape'||modalAction||$('playPane').classList.contains('hidden'))return;
  e.preventDefault();
  if(!$('playHelp').classList.contains('hidden')){setPlayHelp(false);$('playHelpToggle').focus();return}
  if(!$('playSettingsMenu').classList.contains('hidden')){setPlaySettings(false);$('playSettingsToggle').focus({preventScroll:true});return}
  if(mobileQuery.matches&&scenesVisible()){setScenesOpen(false);$('toggleScenes').focus({preventScroll:true});return}
  setMode('record');
});
// Play-mode help dropdown (rehearsal tips).
function setPlayHelp(open){
  $('playHelp').classList.toggle('hidden',!open);
  $('playHelpToggle').setAttribute('aria-expanded',String(open));
}
$('playHelpToggle').onclick=e=>{e.stopPropagation();setPlayHelp($('playHelp').classList.contains('hidden'))};
$('playHelp').onclick=e=>e.stopPropagation();
document.addEventListener('click',()=>setPlayHelp(false));
$('toggleScenes').onclick=()=>setScenesOpen(!scenesVisible());
$('playScenesBackdrop').onclick=()=>setScenesOpen(false);
$('playSettingsToggle').onclick=e=>{e.stopPropagation();setPlaySettings($('playSettingsMenu').classList.contains('hidden'))};
$('playSettingsMenu').onclick=e=>e.stopPropagation();
document.addEventListener('click',()=>setPlaySettings(false));
$('addLine').onclick=()=>addDialogueLine();$('addBeat').onclick=()=>{script.turns.push({who:'beat',text:'',duration:2});render();queueSave(true)};
function newDialogueLine(){return {who:'them',character:'',text:'',audio:null}}
function addDialogueLine(index=script.turns.length){
  script.turns.splice(index,0,newDialogueLine());
  render();queueSave(true);
  focusCharacter(index);
}
// Put the cursor in a block's character name field.
function focusCharacter(index){
  const input=$('turns').children[index]?.querySelector('.character-picker input');
  if(input){input.focus({preventScroll:true});input.select()}
}
// Scene headings ('heading') and action ('action') are full-width text blocks.
function addTextBlock(index,who){
  script.turns.splice(index,0,{who,text:''});
  render();queueSave(true);
  focusBlockText(index);
}
// Script typing: Tab / Shift+Tab move between text fields (character, dialogue, scene
// heading, action) and skip the block buttons. Outside the script, the usual tab order applies.
const SCRIPT_FIELDS='.character, .dialogue, .block-text';
function tabbableElements(){
  return [...document.querySelectorAll('button, input, textarea, select, a[href], [tabindex]')].filter(el=>
    el.tabIndex>=0&&!el.disabled&&el.getClientRects().length&&!(el.closest('#turns')&&!el.matches(SCRIPT_FIELDS)));
}
function moveFocus(from,backward,{withinScript=false,caret='end'}={}){
  const list=withinScript?[...$('turns').querySelectorAll(SCRIPT_FIELDS)].filter(el=>el.getClientRects().length):tabbableElements();
  const target=list[list.indexOf(from)+(backward?-1:1)];
  if(!target)return false;
  target.focus();
  if(target.matches('#turns input, #turns textarea')){const at=caret==='start'?0:target.value.length;target.setSelectionRange(at,at)}
  return true;
}
// Up/Down arrows: in a multi-line field, only leave it from the first (Up) or last (Down)
// visual line. Measured with a hidden copy of the field, since lines can wrap.
let caretMirror=null;
function caretOnEdgeLine(field,edge){
  if(field.tagName!=='TEXTAREA')return true;
  const cs=getComputedStyle(field);
  if(!caretMirror){caretMirror=el('div');caretMirror.setAttribute('aria-hidden','true');Object.assign(caretMirror.style,{position:'absolute',top:'-9999px',left:'-9999px',visibility:'hidden',whiteSpace:'pre-wrap',overflowWrap:'break-word'});document.body.append(caretMirror)}
  for(const p of ['boxSizing','width','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderStyle','fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','lineHeight','textTransform','tabSize'])caretMirror.style[p]=cs[p];
  const pos=edge==='first'?field.selectionStart:field.selectionEnd;
  const marker=el('span','\u200b');
  caretMirror.replaceChildren(document.createTextNode(field.value.slice(0,pos)),marker,document.createTextNode(field.value.slice(pos)||'\u200b'));
  const lineHeight=parseFloat(cs.lineHeight)||parseFloat(cs.fontSize)*1.35;
  const top=marker.offsetTop-parseFloat(cs.paddingTop);
  const textHeight=caretMirror.scrollHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom);
  return edge==='first'?top<lineHeight/2:top+lineHeight>textHeight-lineHeight/2;
}
// Character names save on Tab (like Enter); saving redraws the script, so continue from the new field.
function tabFromCharacter(field,blockIndex,backward,changed,commit,options){
  if(field.value.trim()&&changed()){commit();moveFocus($('turns').children[blockIndex].querySelector('.character'),backward,options)}
  else moveFocus(field,backward,options);
}
// Whether there is a script field above (up) or below the given one.
function moveTarget(field,up){const list=[...$('turns').querySelectorAll(SCRIPT_FIELDS)].filter(el=>el.getClientRects().length);return !!list[list.indexOf(field)+(up?-1:1)]}
const plainArrow=e=>(e.key==='ArrowUp'||e.key==='ArrowDown')&&!e.shiftKey&&!e.altKey&&!e.metaKey&&!e.ctrlKey;
const arrowOptions=up=>({withinScript:true,caret:up?'end':'start'});
$('turns').addEventListener('keydown',e=>{
  if(e.defaultPrevented||!e.target.matches(SCRIPT_FIELDS))return;
  if(e.key==='Tab'){e.preventDefault();moveFocus(e.target,e.shiftKey);return}
  if(plainArrow(e)){
    const field=e.target,up=e.key==='ArrowUp';
    if(field.selectionStart!==field.selectionEnd||!caretOnEdgeLine(field,up?'first':'last'))return;
    if(moveFocus(field,up,arrowOptions(up)))e.preventDefault();
  }
});
function focusBlockText(index){$('turns').children[index]?.querySelector('.block-text')?.focus({preventScroll:true})}

function normalizeCharacters(){
  if(!script)return;
  if(!script.meCharacter){
    script.meCharacter=(script.turns.find(t=>t.who==='me'&&t.character?.trim())?.character.trim()||'ME').toUpperCase();
  }
  // Character suggestions are derived from characters currently used in blocks.
  // Removing or renaming the last occurrence automatically removes the old name.
  script.meCharacter=script.meCharacter.toUpperCase();
  script.turns.filter(t=>t.who==='me').forEach(t=>t.character=script.meCharacter);
  script.otherCharacters=[...new Set(script.turns.filter(t=>t.who==='them').map(t=>(t.character||'').trim().toUpperCase()).filter(Boolean))];
}
function render(){
  normalizeCharacters();
  hideTip();const root=$('turns');const savedScroll=window.scrollY;root.replaceChildren();openBlockMenu=null;
  script.turns.forEach((t,i)=>{
    const div=el('div');div.className='turn'+(t.who==='beat'?' beat':'');div.dataset.who=t.who;
    const tools=el('div');tools.className='margin-tools';
    const add=el('button');add.type='button';add.className='btn btn-ghost btn-icon';add.setAttribute('aria-haspopup','true');add.setAttribute('aria-expanded','false');add.append(icon('plus'));setTip(add,'Insert');add.setAttribute('aria-label','Insert');
    const dots=el('button');dots.type='button';dots.className='btn btn-ghost btn-icon';dots.setAttribute('aria-haspopup','true');dots.append(icon('grip-vertical'));setTip(dots,'Options');dots.setAttribute('aria-label','Options');dots.setAttribute('aria-expanded','false');
    const menu=el('div');menu.className='dropdown-menu block-menu hidden';
    const menuItem=(name,fn,variant,iconName)=>{const b=dropdownItem(name,fn,variant,iconName);menu.append(b);return b};
    const insert=(who)=>{if(who==='line'){addDialogueLine(i+1);return}if(who==='heading'||who==='action'){addTextBlock(i+1,who);return}script.turns.splice(i+1,0,{who:'beat',text:'',duration:2});render();queueSave(true)};
    add.onclick=e=>{e.stopPropagation();const was=menu.classList.contains('hidden');document.querySelectorAll('.block-menu').forEach(m=>m.classList.add('hidden'));menu.replaceChildren();menuItem('Add line',()=>insert('line'),undefined,'text-align-start');menuItem('Add beat',()=>insert('beat'),undefined,'gap-vertical');menuItem('Add scene heading',()=>insert('heading'),undefined,'clapperboard');menuItem('Add action',()=>insert('action'),undefined,'pilcrow');menu.classList.toggle('hidden',!was);resetBlockMenuButtons();add.setAttribute('aria-expanded',String(was))};
    dots.onclick=e=>{e.stopPropagation();const was=menu.classList.contains('hidden');document.querySelectorAll('.block-menu').forEach(m=>m.classList.add('hidden'));menu.replaceChildren();
      if(t.who==='beat'){menu.append(beatDurationSubmenu(t,n=>{t.duration=n;render();queueSave(true)}),dropdownSeparator())}
      menu.append(turnIntoSubmenu(t,()=>{render();queueSave(true)}),dropdownSeparator());
      const up=menuItem('Move up',()=>{[script.turns[i-1],script.turns[i]]=[script.turns[i],script.turns[i-1]];render();queueSave(true)},undefined,'arrow-up');up.disabled=i===0;
      const down=menuItem('Move down',()=>{[script.turns[i+1],script.turns[i]]=[script.turns[i],script.turns[i+1]];render();queueSave(true)},undefined,'arrow-down');down.disabled=i===script.turns.length-1;
      menu.append(dropdownSeparator());
      menuItem('Delete block',()=>{script.turns.splice(i,1);render();queueSave(true)},'destructive','trash');
      menu.classList.toggle('hidden',!was);resetBlockMenuButtons();dots.setAttribute('aria-expanded',String(was));
    };
    tools.append(add,dots);div.append(tools,menu);
    if(t.who==='me'||t.who==='them'){
      const picker=el('div');picker.className='character-picker';
      const character=el('input');character.className='character';character.type='text';
      character.placeholder=t.who==='me'?'ME':'Character name…';
      character.value=t.who==='me'?script.meCharacter:(t.character||'');
      character.setAttribute('aria-label',t.who==='me'?'Your character name (applies to all your lines)':'Select or create reader character');
      const choices=el('div');choices.className='dropdown-menu character-choices hidden';
      const commit=(focusDialogue=false)=>{
        const name=character.value.trim().toUpperCase();if(!name)return;
        character.value=name;
        if(t.who==='me'){
          script.meCharacter=name;
          script.turns.filter(x=>x.who==='me').forEach(x=>x.character=name);
        }else if(name===script.meCharacter){
          t.who='me';t.character=script.meCharacter;t.audio=null;
        }else{
          t.who='them';t.character=name;
        }
        queueSave(true);render();
        if(focusDialogue){const next=$('turns').children[i]?.querySelector('textarea.dialogue');next?.focus({preventScroll:true});}
      };
      if(t.who==='them'){
        let activeChoice=0;
        const drawChoices=()=>{
          choices.replaceChildren();activeChoice=0;
          const typed=character.value.trim().toUpperCase();
          const existing=[script.meCharacter,...script.otherCharacters.filter(name=>name!==script.meCharacter)].filter(name=>name.includes(typed));
          existing.forEach((name,index)=>{
            const option=el('button');option.type='button';option.className='dropdown-menu-item';
            option.append(document.createTextNode(name));
            if(name===script.meCharacter){const hint=el('span',' (me)');hint.className='me-hint';option.append(hint)}
            option.toggleAttribute('data-highlighted',index===activeChoice);
            option.onmousedown=e=>e.preventDefault();
            option.onclick=()=>{character.value=name;commit()};
            choices.append(option);
          });
          choices.classList.toggle('hidden',!typed||!choices.childElementCount);
        };
        character.oninput=()=>{
          const pos=character.selectionStart;
          character.value=character.value.toUpperCase();
          character.setSelectionRange(pos,pos);
          if(character.value.trim())drawChoices();else choices.classList.add('hidden');
        };
        character.onkeydown=e=>{
          const options=[...choices.querySelectorAll('button')];
          if(!choices.classList.contains('hidden')&&options.length&&(e.key==='ArrowDown'||e.key==='ArrowUp')){
            e.preventDefault();activeChoice=(activeChoice+(e.key==='ArrowDown'?1:-1)+options.length)%options.length;
            options.forEach((option,index)=>option.toggleAttribute('data-highlighted',index===activeChoice));
            options[activeChoice].scrollIntoView({block:'nearest'});return;
          }
          if(e.key==='Enter'){
            e.preventDefault();
            if(!choices.classList.contains('hidden')&&options.length)character.value=options[activeChoice].textContent.replace(/\s*\(me\)$/i,'');
            commit(true);
          }
          if(e.key==='Escape'){choices.classList.add('hidden');character.blur()}
          if(e.key==='Tab'){
            e.preventDefault();
            if(!choices.classList.contains('hidden')&&options.length)character.value=options[activeChoice].textContent.replace(/\s*\(me\)$/i,'');
            choices.classList.add('hidden');
            tabFromCharacter(character,i,e.shiftKey,()=>character.value.trim().toUpperCase()!==(t.character||''),commit);
          }
          if(plainArrow(e)&&!e.defaultPrevented){
            const up=e.key==='ArrowUp';
            if(!moveTarget(character,up))return;
            e.preventDefault();choices.classList.add('hidden');
            tabFromCharacter(character,i,up,()=>character.value.trim().toUpperCase()!==(t.character||''),commit,arrowOptions(up));
          }
        };
        character.onblur=()=>{choices.classList.add('hidden');if(character.value.trim()&&character.value.trim()!==t.character){character.value=t.character||''}};
      }else{
        character.oninput=()=>{const pos=character.selectionStart;character.value=character.value.toUpperCase();character.setSelectionRange(pos,pos)};
        character.onkeydown=e=>{
          if(e.key==='Enter'){e.preventDefault();commit(true)}
          if(e.key==='Tab'){e.preventDefault();tabFromCharacter(character,i,e.shiftKey,()=>character.value.trim().toUpperCase()!==script.meCharacter,commit)}
          if(plainArrow(e)){const up=e.key==='ArrowUp';if(!moveTarget(character,up))return;e.preventDefault();tabFromCharacter(character,i,up,()=>character.value.trim().toUpperCase()!==script.meCharacter,commit,arrowOptions(up))}
        };
        character.onblur=()=>{if(character.value.trim()&&character.value.trim()!==script.meCharacter){script.meCharacter=character.value.trim();commit()}};
      }
      picker.append(character,choices);div.append(picker);
    }else if(t.who==='beat'){
      const beat=el('div','Beat.');beat.className='beat-text';div.append(beat);
    }
    let field=null;
    if(t.who==='me'||t.who==='them'){
      field=el('textarea');field.className='dialogue';field.placeholder='Dialogue…';field.value=t.text||'';field.setAttribute('aria-label','Dialogue');field.oninput=()=>{t.text=field.value;field.style.height='auto';field.style.height=field.scrollHeight+'px';queueSave()};
      field.onkeydown=e=>{
        if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){
          e.preventDefault();
          t.text=field.value;
          addDialogueLine(i+1);
        }
      };
      div.append(field);
    }else if(t.who==='heading'||t.who==='action'){
      // Scene heading (INT./EXT. location, uppercase) or action: full-width, left-aligned text.
      const heading=t.who==='heading';
      field=el('textarea');field.className='block-text'+(heading?' scene-heading':'');field.rows=1;
      field.placeholder=heading?'INT. LOCATION - DAY':'Action…';field.setAttribute('aria-label',heading?'Scene heading':'Action');
      field.value=t.text||'';
      field.oninput=()=>{
        if(heading){const pos=field.selectionStart;field.value=field.value.toUpperCase();field.setSelectionRange(pos,pos)}
        t.text=field.value;field.style.height='auto';field.style.height=field.scrollHeight+'px';queueSave();
      };
      // Enter: heading moves on to its action (adding one if needed); action moves on to a new dialogue line.
      field.onkeydown=e=>{
        if(e.key!=='Enter'||e.shiftKey||e.isComposing)return;
        e.preventDefault();t.text=field.value;
        if(heading){if(script.turns[i+1]?.who==='action')focusBlockText(i+1);else addTextBlock(i+1,'action')}
        else addDialogueLine(i+1);
      };
      div.append(field);
    }
    if(t.who==='them'){
      const controls=el('div');controls.className='record-controls';
      const record=el('button');record.type='button';record.className='btn btn-ghost btn-icon';const recordLabel=t.audio?'Rerecord audio':'Record audio';record.setAttribute('aria-label',recordLabel);setTip(record,recordLabel);
      record.replaceChildren(icon('mic'));
      record.onclick=()=>recordLine(i,record);controls.append(record);
      if(t.audio){const listen=el('button');listen.type='button';listen.className='btn btn-ghost btn-icon';setTip(listen,'Listen');listen.setAttribute('aria-label','Listen');listen.replaceChildren(icon('play'));listen.onclick=()=>{const url=URL.createObjectURL(t.audio);const a=new Audio(url);a.onended=()=>URL.revokeObjectURL(url);a.onerror=()=>URL.revokeObjectURL(url);a.play()};controls.append(listen)}div.append(controls);
    }
    root.append(div);if(field){field.style.height='auto';field.style.height=Math.max(field.classList.contains('dialogue')?46:0,field.scrollHeight)+'px'}
  });
  if(Math.abs(window.scrollY-savedScroll)>2)window.scrollTo({top:savedScroll,behavior:'instant'});
}
document.addEventListener('click',e=>{if(!e.target.closest('.margin-tools')&&!e.target.closest('.block-menu')){document.querySelectorAll('.block-menu').forEach(m=>m.classList.add('hidden'));resetBlockMenuButtons()}})
function resetBlockMenuButtons(){document.querySelectorAll('.margin-tools [aria-expanded]').forEach(b=>b.setAttribute('aria-expanded','false'))};
async function recordLine(i,button){
  if(recorder){if(recorder.state!=='inactive')recorder.stop();return}
  try{
    // Track the block itself, not its position, so moves/deletes during recording can't misplace audio.
    const turn=script.turns[i];
    const mic=await getMicrophone();chunks=[];
    const currentRecorder=new MediaRecorder(mic);recorder=currentRecorder;
    currentRecorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    currentRecorder.onstop=()=>{
      if(turn&&turn.who==='them'&&script?.turns?.includes(turn))turn.audio=new Blob(chunks,{type:currentRecorder.mimeType});
      recorder=null;render();queueSave(true);
      // Do not stop the shared microphone here.
    };
    currentRecorder.start();button.classList.add('recording');button.classList.replace('btn-ghost','btn-destructive');setTip(button,'Stop recording');button.setAttribute('aria-label','Stop recording');button.replaceChildren(icon('square')); 
  }catch(e){alert('Microphone unavailable: '+e.message)}
}
function status(s){$('status').textContent=s}
const isPlayable=t=>!!t&&(t.who==='me'||t.who==='them'||t.who==='beat');
// "(then)" or "(beat)" inside your line marks a pause with more to come: the line is only
// done after every part has been spoken. A marker with nothing after it doesn't add a part.
const PAUSE_MARKER=/\(\s*(?:then|beat)\s*\)/i;
function lineParts(text){return Math.max(1,(text||'').split(PAUSE_MARKER).filter(part=>part.trim()).length)}
// Play mode plays one scene at a time: a scene starts at each scene heading beginning
// with INT. or EXT. (including INT./EXT.) and runs until the next one.
let sceneRange={start:0,end:0,scriptId:null};
const SCENE_HEADING=/^\s*(INT|EXT)[.\s\/]/i;
function scenes(){
  const turns=script.turns,list=[];
  turns.forEach((t,i)=>{if(t.who==='heading'&&SCENE_HEADING.test(t.text||''))list.push({start:i,name:t.text.trim()})});
  if(!list.length)return [{start:0,end:turns.length,name:'Untitled scene'}];
  if(list[0].start>0&&turns.slice(0,list[0].start).some(isPlayable))list.unshift({start:0,name:'Opening'});
  list.forEach((scene,k)=>{scene.end=k+1<list.length?list[k+1].start:turns.length});
  return list;
}
function renderSceneList(){
  $('sceneList').replaceChildren(...scenes().map(scene=>{
    const item=el('li');item.className='sidebar-menu-item';
    const button=el('button');button.type='button';button.className='sidebar-menu-button';
    button.append(el('span',scene.name));
    if(scene.start===sceneRange.start){button.dataset.active='';button.setAttribute('aria-current','true')}
    button.onclick=()=>selectScene(scene);
    item.append(button);return item;
  }));
}
function selectScene(scene){
  stop();
  sceneRange={start:scene.start,end:scene.end,scriptId:script.id};
  renderSceneList();renderPrompter();idx=firstPlayable(scene.start);display(true);status('Ready');
  if(mobileQuery.matches&&scenesVisible())setScenesOpen(false);
}
// Scene sidebar: the header's sidebar button opens and closes it. On desktop it starts open
// (and remembers your choice while in play mode); on mobile it starts closed and opens over
// the teleprompter, closing again once you pick a scene.
let scenesPreferred=true;
function setScenesOpen(open){
  const mobile=mobileQuery.matches;
  if(!mobile)scenesPreferred=open;
  $('playPane').classList.toggle('scenes-visible',open);
  $('playScenesBackdrop').classList.toggle('hidden',!(open&&mobile));
  $('toggleScenes').setAttribute('aria-expanded',String(open));
  setTip($('toggleScenes'),open?'Hide scenes':'Show scenes');
}
const scenesVisible=()=>$('playPane').classList.contains('scenes-visible');
mobileQuery.addEventListener('change',()=>{if(!$('playPane').classList.contains('hidden'))setScenesOpen(mobileQuery.matches?false:scenesPreferred)});
function firstPlayable(from){let i=from;while(i<sceneRange.end&&!isPlayable(script.turns[i]))i++;return i}
// Teleprompter: every block of the scene, with the current one cued in the middle of the screen.
function renderPrompter(){
  const list=$('prompter');list.replaceChildren();
  script.turns.slice(sceneRange.start,sceneRange.end).forEach((t,k)=>{
    const line=el('li');line.className='prompter-line';line.dataset.who=t.who;line.dataset.index=sceneRange.start+k;
    const who=t.who==='me'?script.meCharacter:t.who==='them'?(t.character||'Reader'):'';
    const name=el('div',who);name.className='prompter-character';
    const text=el('div',t.who==='beat'?'Beat.':(t.text||''));text.className='prompter-text';
    line.append(name,text);list.append(line);
  });
}
// instant: jump to the cued line (opening the pane, switching scenes) instead of scrolling smoothly.
function display(instant=false){
  const lines=[...$('prompter').children];
  lines.forEach(line=>{const i=Number(line.dataset.index);line.toggleAttribute('data-active',i===idx);line.toggleAttribute('data-past',i<idx)});
  const current=lines.find(line=>Number(line.dataset.index)===idx);
  if(current){const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;current.scrollIntoView({block:'center',behavior:instant||reduce?'auto':'smooth'})}
  const t=script.turns[idx];
  const playable=script.turns.slice(sceneRange.start,sceneRange.end).filter(isPlayable);
  $('progress').textContent=isPlayable(t)?`Line ${playable.indexOf(t)+1} of ${playable.length}`:'';
}
// Show Start when idle and Stop while playing, keeping keyboard focus on whichever is visible.
function setTransport(isPlaying){
  const hadFocus=document.activeElement===$('start')||document.activeElement===$('stop');
  $('start').classList.toggle('hidden',isPlaying);$('stop').classList.toggle('hidden',!isPlaying);
  if(hadFocus)$(isPlaying?'stop':'start').focus({preventScroll:true});
}
$('start').onclick=async()=>{if(!script.turns.slice(sceneRange.start,sceneRange.end).some(isPlayable))return alert('This scene has no lines yet');try{const mic=await getMicrophone();audioCtx=new AudioContext();await audioCtx.resume();let source=audioCtx.createMediaStreamSource(mic);analyser=audioCtx.createAnalyser();analyser.fftSize=2048;source.connect(analyser);playing=true;idx=firstPlayable(sceneRange.start);setTransport(true);next()}catch(e){alert('Microphone unavailable: '+e.message);stop()}};$('stop').onclick=()=>stop();
function next(){if(!playing)return;cancelAnimationFrame(raf);idx=firstPlayable(idx);if(idx>=sceneRange.end){status('Scene complete');stop(true);return}display();let t=script.turns[idx];if(t.who==='beat'){let seconds=beatSeconds(t);status(`Beat — ${seconds} second${seconds===1?'':'s'}…`);beatTimer=setTimeout(()=>{beatTimer=null;idx++;next()},seconds*1000);return}if(t.who==='them'){status('Playing reader…');if(!t.audio){status('Reader recording missing — skipping');idx++;setTimeout(next,250);return}playReaderLine(t);return}else{partsNeeded=lineParts(t.text);partsHeard=0;status(partsNeeded>1?`Listening for your line… (part 1 of ${partsNeeded})`:'Listening for your line…');heard=false;speechAt=0;lastVoice=0;listen()}}
// Plays one reader line. Back-to-back reader lines use the script's Reader spacing:
// a pause after this line ends, or (negative) starting the next line before this one ends.
function playReaderLine(t){
  const url=URL.createObjectURL(t.audio);const audio=new Audio(url);
  activeAudio=audio;playingAudios.add(audio);
  const following=script.turns[firstPlayable(idx+1)];
  const spacing=following?.who==='them'&&following.audio?readerSpacing():0;
  let advanced=false;
  const advance=()=>{if(advanced||!playing)return;advanced=true;clearTimeout(gapTimer);gapTimer=null;idx++;next()};
  const cleanup=()=>{URL.revokeObjectURL(url);playingAudios.delete(audio);if(activeAudio===audio)activeAudio=null};
  audio.onended=()=>{cleanup();if(spacing>0&&!advanced&&playing)gapTimer=setTimeout(advance,spacing*1000);else advance()};
  audio.onerror=()=>{cleanup();advance()};
  audio.play().then(async()=>{
    if(spacing>=0)return;
    const duration=await audioDuration(t.audio).catch(()=>null);
    if(duration&&playing&&!advanced)gapTimer=setTimeout(advance,Math.max(0,duration-audio.currentTime+spacing)*1000);
  }).catch(e=>{status('Playback failed: '+e.message);stop()});
}
function listen(){if(!playing)return;let a=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(a);let sum=0;for(let v of a)sum+=v*v;let rms=Math.sqrt(sum/a.length),now=performance.now();const threshold=Math.max(.022,noiseFloor*2.8);if(rms>threshold){if(!speechAt)speechAt=now;if(now-speechAt>120){if(!heard)status(partsNeeded>1?`Speaking… (part ${partsHeard+1} of ${partsNeeded})`:'Speaking…');heard=true;lastVoice=now}}else{speechAt=0;if(!heard)noiseFloor=noiseFloor*.98+rms*.02;if(heard&&now-lastVoice>850){
  partsHeard++;
  if(partsHeard<partsNeeded){heard=false;status(`Keep going… (part ${partsHeard+1} of ${partsNeeded})`)}
  else{idx++;next();return}
}}raf=requestAnimationFrame(listen)}
function stop(done=false){playing=false;cancelAnimationFrame(raf);if(beatTimer!==null){clearTimeout(beatTimer);beatTimer=null}if(gapTimer!==null){clearTimeout(gapTimer);gapTimer=null}playingAudios.forEach(a=>a.pause());playingAudios.clear();activeAudio=null;/* Keep microphone permission/stream alive until explicitly released. */if(audioCtx){audioCtx.close();audioCtx=null}setTransport(false);if(!done&&$('status'))status('Stopped')}
