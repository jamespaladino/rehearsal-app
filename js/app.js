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
// Theme: 'system' (follows the device), 'light' or 'dark', chosen in Settings.
const systemDark=window.matchMedia('(prefers-color-scheme: dark)');
const THEMES=[{value:'system',label:'System',icon:'monitor'},{value:'light',label:'Light',icon:'sun'},{value:'dark',label:'Dark',icon:'moon'}];
let themeChoice='light';try{themeChoice=localStorage.getItem('rehearsal-theme')||'light'}catch(e){}
function applyTheme(){
  const dark=themeChoice==='dark'||(themeChoice==='system'&&systemDark.matches);
  document.documentElement.dataset.theme=dark?'dark':'light';
  $('themeValue').textContent=(THEMES.find(t=>t.value===themeChoice)||THEMES[1]).label;
}
function setTheme(choice){themeChoice=choice;applyTheme();try{localStorage.setItem('rehearsal-theme',choice)}catch(e){}}
applyTheme();
systemDark.addEventListener('change',()=>{if(themeChoice==='system')applyTheme()});

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
  $('connectMic').classList.toggle('hidden',live);
  $('releaseMic').classList.toggle('hidden',!live);
  const status=$('micSettingsStatus');
  status.textContent=live?'Connected':'Not connected';
  status.toggleAttribute('data-connected',live);
}
function releaseMicrophone(){
  stop();
  if(recorder && recorder.state!=='inactive')recorder.stop();
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}
  updateMicState();
}
// Gives the microphone back when a run ends (scene finished or Stop in play mode, or Stop on a
// reader recording), so the browser's mic indicator goes off in between. The next Start or Record
// asks for it again (no prompt once allowed). Unlike releaseMicrophone() it doesn't call stop()
// again, and it leaves the mic alone while a recording or a run is still going.
function releaseMicIfIdle(){
  if(playing||(recorder&&recorder.state!=='inactive'))return;
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}
  updateMicState();
}
// Microphone dropdown: status label plus Connect / Release.
// Settings > General: theme dropdown (radio items, right-aligned under its button).
function setThemeMenu(open){
  if(open)$('themeMenu').replaceChildren(...THEMES.map(t=>dropdownRadioItem({label:t.label,icon:t.icon,checked:t.value===themeChoice,onSelect:()=>{setTheme(t.value);setThemeMenu(false);$('themeToggle').focus()}})));
  $('themeMenu').classList.toggle('hidden',!open);
  $('themeToggle').setAttribute('aria-expanded',String(open));
  if(open)$('themeMenu').querySelector('[aria-checked="true"]')?.focus({preventScroll:true});
}
$('themeToggle').onclick=e=>{e.stopPropagation();setThemeMenu($('themeMenu').classList.contains('hidden'))};
$('themeMenu').onclick=e=>e.stopPropagation();
document.addEventListener('click',()=>setThemeMenu(false));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('themeMenu').classList.contains('hidden')){setThemeMenu(false);$('themeToggle').focus()}});
$('connectMic').onclick=async()=>{try{await getMicrophone()}catch(e){alert('Microphone unavailable: '+e.message)}};
$('releaseMic').onclick=()=>releaseMicrophone();
window.addEventListener('pagehide',()=>{if(stream)stream.getTracks().forEach(t=>t.stop())});
// Storage: ask the browser not to clear our data, and show whether it agreed (Settings > Storage).
const installed=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const isIOS=()=>/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
async function updateStorageStatus(){
  const out=$('storageStatus');if(!out)return;
  let kept=false,used=null;
  try{if(navigator.storage?.persist)kept=await navigator.storage.persisted()||await navigator.storage.persist()}catch(e){}
  try{const est=await navigator.storage?.estimate?.();if(est?.usage!=null)used=`${(est.usage/1048576).toFixed(1)} MB`}catch(e){}
  let text;
  if(installed())text=kept?'The browser reports persistent storage for this Home Screen app.':'The browser has not confirmed persistent storage for this Home Screen app.';
  else if(kept)text='This browser has agreed to keep your data.';
  else if(isIOS())text='Safari may clear it after 7 days without a visit. Use Share > Add to Home Screen and open the app from there. Recordings made here won\'t carry over to it.';
  else text='The browser may clear it if the device runs low on space.';
  // The usage amount is bold: "… 51.5 MB used."
  out.replaceChildren(text);if(used)out.append(' ',el('strong',used),' used.');
}
updateStorageStatus();
// Settings > Install: Chrome and Edge offer an install prompt (beforeinstallprompt), which the
// Install button shows. Safari and Firefox have no prompt, so the row says how to do it by hand.
let installPrompt=null;
function updateInstallStatus(){
  const ua=navigator.userAgent,btn=$('installApp');
  const macSafari=/Macintosh/.test(ua)&&/Safari/.test(ua)&&!/Chrome|Chromium|Edg|Firefox/.test(ua)&&!isIOS();
  let text;
  if(installed())text='Installed. You\'re using the app.';
  else if(installPrompt)text='Add Rehearsal to this device.';
  else if(isIOS())text='In Safari, tap Share, then Add to Home Screen.';
  else if(macSafari)text='In Safari, choose File > Add to Dock.';
  else if(/Firefox/.test(ua))text='Firefox can\'t install apps. Open Rehearsal in Chrome, Edge or Safari to install it.';
  else text='Use Install in the address bar or browser menu. If it\'s already installed, open it from there.';
  $('installStatus').textContent=text;
  btn.classList.toggle('hidden',!installPrompt||installed());
}
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;updateInstallStatus()});
window.addEventListener('appinstalled',()=>{installPrompt=null;updateInstallStatus()});
$('installApp').onclick=async()=>{
  if(!installPrompt)return;
  const p=installPrompt;installPrompt=null;
  try{await p.prompt();await p.userChoice}catch(e){}
  updateInstallStatus();
};
updateInstallStatus();
const req=indexedDB.open('rehearsal-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('scripts',{keyPath:'id'});req.onsuccess=async()=>{db=req.result;try{const scripts=await getAll();const lastId=localStorage.getItem("rehearsal-last-opened");if(lastId==='tests'){await openTests();return}if(lastId==='settings'){await openSettings();return}const target=scripts.find(s=>s.id===lastId)||scripts[0];if(target)await openScript(target);else await library()}catch(e){console.error("Could not restore last script",e);await library()}};req.onerror=()=>alert('Local storage unavailable. Try a modern browser.');
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
function placeMenuAside(content){
  delete content.dataset.side;delete content.dataset.align;
  const bounds=content.getBoundingClientRect();
  if(bounds.right>innerWidth-8){
    content.dataset.side='left';
    if(content.getBoundingClientRect().left<8)content.dataset.side='over';
  }
  if(content.dataset.side!=='over'&&bounds.bottom>innerHeight-8)content.dataset.align='end';
}
// shadcn DropdownMenuSub with RadioItems: a trigger row that opens a list to its right.
// options: [{label, icon?, checked, onSelect}] — the checked option shows a check mark.
// extra: {value?, note?} — value shows muted at the end of the trigger (DropdownMenuShortcut),
// note is a short explanation below the submenu options. triggerIcon may be null.
// The submenu flips left / bottom-aligns when it would leave the window.
function dropdownSubmenu(triggerIcon,triggerLabel,options,extra={}){
  const sub=el('div');sub.className='dropdown-menu-sub';
  const trigger=el('button');trigger.type='button';trigger.className='dropdown-menu-sub-trigger';
  trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');
  if(triggerIcon)trigger.append(icon(triggerIcon));
  trigger.append(el('span',triggerLabel));
  if(extra.value!=null){const value=el('span',extra.value);value.className='dropdown-menu-shortcut';trigger.append(value)}
  trigger.append(icon('chevron-right'));
  const content=el('div');content.className='dropdown-menu dropdown-menu-sub-content hidden';content.setAttribute('role','menu');
  for(const opt of options)content.append(dropdownRadioItem(opt));
  if(extra.note){const note=el('div',extra.note);note.className='dropdown-menu-note';content.append(dropdownSeparator(),note)}
  const setOpen=open=>{content.classList.toggle('hidden',!open);trigger.toggleAttribute('data-open',open);trigger.setAttribute('aria-expanded',String(open));if(open)placeMenuAside(content)};
  // With a mouse, hovering opens and leaving closes, so a click only ever opens (a toggle would
  // close the submenu hover just opened). Touch screens toggle on tap.
  const hover=matchMedia('(hover: hover)').matches;
  trigger.onclick=e=>{e.stopPropagation();setOpen(hover||content.classList.contains('hidden'))};
  if(hover){sub.onmouseenter=()=>setOpen(true);sub.onmouseleave=()=>setOpen(false)}
  trigger.onkeydown=e=>{if(e.key==='ArrowRight'){e.preventDefault();setOpen(true);(content.querySelector('[aria-checked="true"]')||content.querySelector('button'))?.focus()}};
  content.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='Escape'){e.preventDefault();e.stopPropagation();setOpen(false);trigger.focus()}};
  sub.append(trigger,content);
  return sub;
}
// Beat length: the trigger shows the current length.
function beatDurationOptions(t,onChange){
  const current=beatSeconds(t);
  return BEAT_DURATIONS.map(n=>({label:secondsLabel(n),checked:n===current,onSelect:()=>onChange(n)}));
}
// Reader spacing (per script): seconds between back-to-back reader lines. Negative values
// overlap them: the next line starts that long before the current one ends.
const READER_SPACING=[
  {value:-1,label:'Overlap 1 second'},{value:-0.5,label:'Overlap ½ second'},{value:0,label:'No gap'},
  {value:0.5,label:'Pause ½ second'},{value:1,label:'Pause 1 second'},{value:2,label:'Pause 2 seconds'},
];
function readerSpacing(){const v=Number(script?.readerSpacing);return Number.isFinite(v)?Math.max(-5,Math.min(10,v)):0}
// Line detection (saved for this device, not per script): how play mode decides you've finished
// your line. Voice activity waits for a pause; the speech engines (from speech-lab/, see
// speech-lab/js/rehearsal-engine.js) move on as soon as they hear the line's last N words (the cue).
const LINE_DETECTION=[
  {value:'vad',label:'VAD',description:'Voice activity detection advances after it hears you speak and then pause.'},
  // Runtime versions from speech-lab/pins.json.
  {value:'vosk',label:'Vosk 0.0.8',description:'Uses a compact English speech model in your browser and advances when it recognizes the last few words of your line.'},
  {value:'sherpa',label:'Sherpa-ONNX v1.13.7',description:'Uses a streaming English Zipformer model in your browser and advances when it recognizes the last few words of your line.'},
];
const CUE_WORDS=[2,3,4,5,6,8];
const DEFAULT_CUE_WORDS=2;
function pref(key,fallback){try{return localStorage.getItem(key)??fallback}catch(e){return fallback}}
function setPref(key,value){try{localStorage.setItem(key,String(value))}catch(e){}}
function lineDetection(){const v=pref('rehearsal-line-detection','vad');return LINE_DETECTION.some(o=>o.value===v)?v:'vad'}
function cueWords(){const n=Number(pref('rehearsal-cue-words',DEFAULT_CUE_WORDS));return CUE_WORDS.includes(n)?n:DEFAULT_CUE_WORDS}
// Lines with fewer words than the cue length use voice activity by default.
function shortLinesUseVad(){return pref('rehearsal-short-lines-vad','true')==='true'}
function menuLabel(text){const label=el('div',text);label.className='dropdown-menu-label';return label}
// Menu row with a switch at its end (shadcn Switch inside a menuitemcheckbox).
function dropdownSwitchItem(iconName,label,checked,onToggle){
  const item=el('button');item.type='button';item.className='dropdown-menu-item';
  item.setAttribute('role','menuitemcheckbox');item.setAttribute('aria-checked',String(checked));
  const sw=el('span');sw.className='switch';sw.toggleAttribute('data-checked',checked);
  const thumb=el('span');thumb.className='switch-thumb';sw.append(thumb);
  item.append(icon(iconName),el('span',label),sw);
  item.onclick=e=>{e.stopPropagation();onToggle()};
  return item;
}
// Line detection menu (play bar, left of settings): mode, cue length, VAD override, and reader spacing.
// The button shows the current mode.
function renderPlayDetection(){
  const pick=(apply,key)=>()=>{apply();renderPlayDetection();$('playDetectionMenu').querySelector(`[data-key="${key}"]`)?.focus({preventScroll:true})};
  const detection=lineDetection();
  const item=(b,key)=>{b.dataset.key=key;return b};
  let activeDetails;
  const withDetails=(choice,title,description)=>{
    const row=el('div');row.className='dropdown-menu-sub';
    const details=el('div');details.className='popover dropdown-menu-sub-content play-detection-details hidden';
    details.id=choice.dataset.key+'-help';
    details.setAttribute('role','tooltip');
    details.append(el('strong',title),el('span',description));
    choice.setAttribute('aria-describedby',details.id);
    const showDetails=()=>{
      activeDetails?.classList.add('hidden');
      details.classList.remove('hidden');
      placeMenuAside(details);
      activeDetails=details;
    };
    row.onpointerenter=e=>{if(e.pointerType==='mouse'||e.pointerType==='pen')showDetails()};
    row.onpointerleave=()=>details.classList.add('hidden');
    choice.onfocus=()=>{if(choice.matches(':focus-visible'))showDetails()};
    choice.onblur=()=>details.classList.add('hidden');
    row.append(choice,details);
    return row;
  };
  const choices=LINE_DETECTION.map(o=>{
    const key='detect-'+o.value;
    const choice=item(dropdownRadioItem({label:o.label,checked:o.value===detection,onSelect:pick(()=>{
      setPref('rehearsal-line-detection',o.value);
      if(playing)status('Line detection changes next time you press Start');
    },key)}),key);
    return withDetails(choice,o.label,o.description);
  });
  const items=[menuLabel('Line detection'),...choices,dropdownSeparator()];
  let override;
  if(detection!=='vad'){
    const words=cueWords();
    const cue=dropdownSubmenu('message-square-quote','Cue',CUE_WORDS.map(n=>({label:`${n} words`,checked:n===words,onSelect:pick(()=>setPref('rehearsal-cue-words',n),'cue')})),
      {value:`${words} words`,note:'Your line ends when the last words of it are heard.'});
    cue.querySelector('.dropdown-menu-sub-trigger').dataset.key='cue';
    const short=item(dropdownSwitchItem('audio-lines','VAD override',shortLinesUseVad(),pick(()=>setPref('rehearsal-short-lines-vad',!shortLinesUseVad()),'short')),'short');
    override=withDetails(short,'VAD override',`When enabled, lines with fewer than ${words} words advance after you speak and pause.`);
    items.push(cue);
  }
  const current=readerSpacing();
  const spacing=dropdownSubmenu('blend','Spacing',READER_SPACING.map(o=>({
    label:o.label,checked:o.value===current,onSelect:pick(()=>{
      script.readerSpacing=o.value;
      queueSave(true);
    },'reader-spacing'),
  })),{value:READER_SPACING.find(o=>o.value===current)?.label,
    note:'Sets the pause or overlap between consecutive reader lines.'});
  spacing.querySelector('.dropdown-menu-sub-trigger').dataset.key='reader-spacing';
  const trim=item(dropdownSwitchItem('scissors','Auto-trim recordings',autoTrimRecordings(),pick(()=>{
    script.autoTrimRecordings=!autoTrimRecordings();
    queueSave(true);
  },'auto-trim')),'auto-trim');
  items.push(spacing,withDetails(trim,'Auto-trim recordings','Skips silence at the start and end of reader recordings during rehearsal. The original takes are kept.'));
  if(override)items.push(override);
  $('playDetectionMenu').replaceChildren(...items);
  updateDetectionButton();
}
function updateDetectionButton(){
  const name=LINE_DETECTION.find(o=>o.value===lineDetection()).label;
  $('playDetectionLabel').textContent=name;
  $('playDetectionToggle').setAttribute('aria-label',`Line detection: ${name}`);
  $('playDetectionToggle').dataset.tooltip=`Line detection: ${name}`;
}
function setPlayDetection(open){
  if(open){setPlaySettings(false);renderPlayDetection()}
  $('playDetectionMenu').classList.toggle('hidden',!open);
  $('playDetectionToggle').setAttribute('aria-expanded',String(open));
}
const DIALOGUE_SIZES=[
  {value:'small',label:'Small'},{value:'medium',label:'Medium'},
  {value:'large',label:'Large'},{value:'extra-large',label:'Extra Large'},
];
const dialogueSizeKey='rehearsal-dialogue-size';
let dialogueSize=DIALOGUE_SIZES.find(o=>o.value===pref(dialogueSizeKey,'medium'))||DIALOGUE_SIZES[1];
$('prompter').dataset.dialogueSize=dialogueSize.value;

function autoTrimRecordings(){return script?.autoTrimRecordings??true}
function renderPlaySettings(){
  const size=dropdownSubmenu('type','Font size',DIALOGUE_SIZES.map(o=>({
    label:o.label,checked:o===dialogueSize,onSelect:()=>{
      dialogueSize=o;
      setPref(dialogueSizeKey,o.value);
      $('prompter').dataset.dialogueSize=o.value;
      display(true);
      renderPlaySettings();
      $('playSettingsMenu').querySelector('.dropdown-menu-sub-trigger').focus({preventScroll:true});
    },
  })),{value:dialogueSize.label});
  $('playSettingsMenu').replaceChildren(size);
}
function setPlaySettings(open){
  if(open){setPlayDetection(false);renderPlaySettings()}
  $('playSettingsMenu').classList.toggle('hidden',!open);
  $('playSettingsToggle').setAttribute('aria-expanded',String(open));
}
// Length of a recording in seconds. Browser recordings often don't report it, so decode the audio once.
const audioDurations=new WeakMap();
function audioDuration(blob){
  if(!audioDurations.has(blob))audioDurations.set(blob,blob.arrayBuffer().then(data=>audioCtx.decodeAudioData(data)).then(buffer=>buffer.duration));
  return audioDurations.get(blob);
}

// Cache the detected bounds with the original take. Only keep decoded audio for the
// two most recently requested takes so rehearsing a long scene stays bounded.
const readerTrimBounds=new WeakMap();
const decodedReaderTakes=new Map();
function decodeReaderTake(blob,context){
  const cached=decodedReaderTakes.get(blob);
  if(cached){decodedReaderTakes.delete(blob);decodedReaderTakes.set(blob,cached);return cached}
  const decoded=blob.arrayBuffer().then(data=>context.decodeAudioData(data)).catch(()=>null);
  decodedReaderTakes.set(blob,decoded);
  if(decodedReaderTakes.size>2)decodedReaderTakes.delete(decodedReaderTakes.keys().next().value);
  return decoded;
}
function findReaderTrim(buffer){
  const step=Math.round(buffer.sampleRate*.02);
  const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
  const levels=[];
  let peak=0;
  for(let start=0;start<buffer.length;start+=step){
    const end=Math.min(start+step,buffer.length);
    let level=0;
    for(const samples of channels){
      let sum=0;
      for(let i=start;i<end;i++)sum+=samples[i]*samples[i];
      level=Math.max(level,Math.sqrt(sum/(end-start)));
    }
    levels.push(level);
    peak=Math.max(peak,level);
  }
  const sorted=[...levels].sort((a,b)=>a-b);
  const floor=sorted[Math.floor(sorted.length*.2)]||0;
  const threshold=Math.max(.003,peak*.04,floor*3);
  if(peak<threshold*2)return {start:0,end:buffer.duration};
  let first=-1,last=-1,run=0;
  for(let i=0;i<levels.length;i++){
    run=levels[i]>=threshold?run+1:0;
    if(run<3)continue;
    if(first<0)first=i-2;
    last=i;
  }
  if(first<0)return {start:0,end:buffer.duration};
  return {
    start:Math.max(0,first*step/buffer.sampleRate-.12),
    end:Math.min(buffer.duration,(last+1)*step/buffer.sampleRate+.18),
  };
}
// Block types a block can be turned into, in menu order. A "Line" is dialogue: whether it's
// yours or a reader's comes from its character name, so there's one option for both.
const isLine=t=>t.who==='me'||t.who==='them';
const BLOCK_TYPES=[
  {label:'Line',icon:'text-align-start',is:isLine,apply:t=>{if(!isLine(t)){t.who='them';t.character='';t.audio=null}}},
  {label:'Beat',icon:'gap-vertical',is:t=>t.who==='beat',apply:t=>{t.who='beat';t.duration??=2}},
  {label:'Scene heading',icon:'clapperboard',is:t=>t.who==='heading',apply:t=>{t.who='heading';t.text=(t.text||'').toUpperCase()}},
  {label:'Action',icon:'pilcrow',is:t=>t.who==='action',apply:t=>{t.who='action'}},
];
// onChange(becameLine): becameLine is true when a non-dialogue block was turned into a line.
function turnIntoOptions(t,onChange){
  return BLOCK_TYPES.map(type=>({label:type.label,icon:type.icon,checked:type.is(t),onSelect:()=>{
    if(type.is(t))return;
    rememberScriptEdit();type.apply(t);onChange(isLine(t));
  }}));
}
// Tooltips: any element with data-tooltip shows one on mouse hover or keyboard focus.
const tooltip=el('div');tooltip.className='tooltip';tooltip.setAttribute('aria-hidden','true');document.body.append(tooltip);
let tipTarget=null;
function showTip(t){
  tipTarget=t;tooltip.textContent=t.dataset.tooltip;
  if(t.dataset.tooltipShortcut){
    const key=el('kbd',t.dataset.tooltipShortcut);key.dataset.slot='kbd';tooltip.append(key);
  }
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

const SCRIPT_HISTORY_LIMIT=50;
const scriptUndo=[],scriptRedo=[];
let historyScriptId=null,typingField=null,typingTime=0;
function updateScriptHistoryButtons(){
  const id=script?.id??null;
  if(historyScriptId!==id){
    historyScriptId=id;scriptUndo.length=0;scriptRedo.length=0;typingField=null;
  }
  $('scriptHistory').classList.toggle('hidden',!script);
  $('undoScript').disabled=!!recorder||!scriptUndo.length;
  $('redoScript').disabled=!!recorder||!scriptRedo.length;
}
function snapshotScriptEdit(){
  // Turn fields are replaced on edit. Keep immutable audio blobs shared across snapshots.
  const {title,meCharacter,turns}=script;
  return {title,meCharacter,turns:turns.map(turn=>({...turn}))};
}
function rememberScriptEdit(field=null){
  const now=performance.now();
  if(!field||field!==typingField||now-typingTime>400){
    scriptUndo.push(snapshotScriptEdit());
    if(scriptUndo.length>SCRIPT_HISTORY_LIMIT)scriptUndo.shift();
  }
  typingField=field;typingTime=now;scriptRedo.length=0;
  updateScriptHistoryButtons();
}
function restoreScriptEdit(from,to){
  if(!script||recorder||!from.length)return;
  const restoreMobileFocus=mobileQuery.matches&&!script.turns.length;
  if(!$('scriptHistory').closest('#mobileEditBar'))leaveScriptField();
  if(!from.length)return;
  to.push(snapshotScriptEdit());
  Object.assign(script,from.pop());typingField=null;
  $('title').value=script.title;$('scriptHeading').textContent=script.title;
  updateScriptHeader();render();queueSave(true);
  if(restoreMobileFocus)$('turns').querySelector(MOBILE_BLOCK_FIELDS)?.focus();
}
$('undoScript').onclick=()=>restoreScriptEdit(scriptUndo,scriptRedo);
$('redoScript').onclick=()=>restoreScriptEdit(scriptRedo,scriptUndo);

const UNTITLED_SCRIPT='Untitled script';
const DEFAULT_ACTOR_NAME='YOU';
function isBlankNewScript(s){
  return s?.newDraft===true&&s.title===UNTITLED_SCRIPT&&!isPinned(s)&&
    (s.meCharacter===DEFAULT_ACTOR_NAME||s.meCharacter==='ME')&&
    s.turns.length===1&&s.turns[0].who==='heading'&&
    !s.turns[0].text?.trim();
}
async function finishScript(){
  if(!isBlankNewScript(script)){
    if(script?.newDraft)delete script.newDraft;
    await flushSave();
    return;
  }
  const draft=script;
  clearTimeout(saveTimer);
  script=null;
  // Let any in-flight autosave finish before checking and deleting the draft.
  saveChain=saveChain.catch(()=>{}).then(()=>new Promise((resolve,reject)=>{
    const scripts=store('readwrite');
    const request=scripts.get(draft.id);
    request.onsuccess=()=>{if(isBlankNewScript(request.result))scripts.delete(draft.id)};
    scripts.transaction.oncomplete=resolve;
    scripts.transaction.onabort=()=>reject(scripts.transaction.error);
  }));
  try{await saveChain}catch(err){script??=draft;throw err}
  try{
    if(localStorage.getItem('rehearsal-last-opened')===draft.id)localStorage.removeItem('rehearsal-last-opened');
  }catch(e){}
}

function closeModal(){modalAction=null;$('modalBackdrop').classList.add('hidden');$('modalError').textContent='';if(modalPreviousFocus?.isConnected)modalPreviousFocus.focus()}
function openModal(type,s){
  modalPreviousFocus=document.activeElement;modalAction={type,id:s.id,name:s.name};
  const text={
    rename:{title:'Rename script',message:'Choose a new name for this script.',label:'Script name',value:s.title||'',confirm:'Save'},
    character:{title:'Rename character',message:'Every line by '+s.name+' will use the new name.',label:'Character name',value:s.name,confirm:'Save'},
    delete:{title:'Delete script?',message:`Delete “${s.title||'Untitled'}” and all its recordings? This cannot be undone.`,confirm:'Delete'},
    discardImport:{title:'Cancel import?',message:'This script hasn’t been imported yet. Your changes will be lost.',confirm:'Discard import',cancel:'Keep editing'},
    clearStorage:{title:'Clear storage?',message:`Delete ${s.count===1?'your 1 script':`all ${s.count} scripts`} and every recording on this device? Your settings are kept. This cannot be undone.`,confirm:'Clear storage'},
  }[type];
  const hasField=!['delete','discardImport','clearStorage'].includes(type);
  $('modalTitle').textContent=text.title;$('modalMessage').textContent=text.message;
  $('renameFields').classList.toggle('hidden',!hasField);$('renameInput').required=hasField;
  $('renameLabel').textContent=text.label||'';$('renameInput').value=text.value||'';
  // Character names are uppercase, like the rest of the script.
  $('renameInput').oninput=type==='character'?()=>{const el=$('renameInput'),pos=el.selectionStart;el.value=el.value.toUpperCase();el.setSelectionRange(pos,pos)}:null;
  $('modalConfirm').textContent=text.confirm;$('modalCancel').textContent=text.cancel||'Cancel';$('modalConfirm').className='btn '+(hasField?'btn-default':'btn-destructive');
  $('modalError').textContent='';$('modalBackdrop').classList.remove('hidden');
  if(hasField&&mobileQuery.matches)$('modalBackdrop').querySelector('.dialog-content').focus({preventScroll:true});
  else if(hasField){$('renameInput').focus({preventScroll:true});$('renameInput').select()}
  else $('modalCancel').focus({preventScroll:true});
}
$('modalCancel').onclick=closeModal;
$('modalBackdrop').addEventListener('click',e=>{if(e.target===$('modalBackdrop'))closeModal()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modalAction){e.preventDefault();closeModal()}});
$('modalForm').onsubmit=async e=>{e.preventDefault();if(!modalAction)return;const {type,id}=modalAction;if(type==='discardImport'){closeModal();closeImportPane();return}if(type==='clearStorage'){await clearStorage();return}const btn=$('modalConfirm');btn.disabled=true;try{if(type==='character'){const name=$('renameInput').value.trim().toUpperCase();if(!name){$('modalError').textContent='Enter a character name.';return}const oldName=modalAction.name;closeModal();renameCharacter(oldName,name);return}if(type==='rename'){const title=$('renameInput').value.trim();if(!title){$('modalError').textContent='Enter a script name.';return}if(script?.id===id){await renameOpenScript(title)}else{const r=store().get(id);const saved=await new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});if(!saved)throw new Error('Script no longer exists');saved.title=title;await put(saved)}}else{if(script?.id===id){clearTimeout(saveTimer);script=null;}await saveChain;await del(id);try{if(localStorage.getItem("rehearsal-last-opened")===id)localStorage.removeItem("rehearsal-last-opened")}catch(e){}if(!script){stop();releaseMicrophone();script=null;$('playButton').classList.add('hidden');closePlayPane();$('editor').classList.add('hidden');updateScriptHeader()}}closeModal();await library()}catch(err){$('modalError').textContent=err.message||'Could not save changes.';$('renameFields').classList.remove('hidden')}finally{btn.disabled=false}};
let activeMenu=null;
function closeMenu(){if(activeMenu){activeMenu.classList.add('hidden');activeMenu.previousElementSibling?.setAttribute('aria-expanded','false');activeMenu=null}}
document.addEventListener('click',()=>closeMenu());
// Script-row menus are positioned against the window (position: fixed) so the scrolling
// script list can't clip them: right-aligned with the ⋯ button, 4px below it, or above it
// when there isn't room below. They close if the list scrolls, and follow their button if the
// window resizes (phones resize when the address bar or keyboard appears).
function placeMenu(menu,trigger){
  const t=trigger.getBoundingClientRect(),h=menu.offsetHeight,gap=4,margin=8;
  const below=t.bottom+gap,above=t.top-gap-h;
  menu.style.top=(below+h>innerHeight-margin&&above>=margin?above:below)+'px';
  menu.style.right=Math.max(margin,innerWidth-t.right)+'px';
}
$('libraryPanel').addEventListener('scroll',()=>closeMenu());
addEventListener('resize',()=>{if(activeMenu?.closest('.sidebar'))placeMenu(activeMenu,activeMenu.previousElementSibling)});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu()});
// Pinned follows a saved manual order. Recents follows the last time each script was opened.
const SECTIONS_KEY='rehearsal-sidebar-collapsed';
const PINNED_ORDER_KEY='rehearsal-pinned-order';
let pinnedOrder=[],refreshLibraryAfterDrag=false;
function savePinnedOrder(order){
  pinnedOrder=order;
  try{localStorage.setItem(PINNED_ORDER_KEY,JSON.stringify(order))}catch(e){}
}
function orderPinned(scripts){
  let order=pinnedOrder;
  try{
    const saved=JSON.parse(localStorage.getItem(PINNED_ORDER_KEY));
    if(Array.isArray(saved))order=saved;
  }catch(e){}
  const byId=new Map(scripts.map(s=>[s.id,s]));
  const sorted=[];
  for(const id of order){
    if(byId.has(id)){sorted.push(byId.get(id));byId.delete(id)}
  }
  sorted.push(...byId.values());
  const ids=sorted.map(s=>s.id);
  if(ids.length!==order.length||ids.some((id,i)=>id!==order[i]))savePinnedOrder(ids);
  else pinnedOrder=ids;
  return sorted;
}
function movePinnedScript(id,to){
  const from=pinnedOrder.indexOf(id);
  if(from<0||from===to||to<0||to>=pinnedOrder.length)return;
  const order=[...pinnedOrder];
  order.splice(from,1);order.splice(to,0,id);
  savePinnedOrder(order);
  library();
}
function collapsedSections(){try{return JSON.parse(localStorage.getItem(SECTIONS_KEY)||'{}')}catch(e){return {}}}
function setSectionCollapsed(name,collapsed){const all=collapsedSections();all[name]=collapsed;try{localStorage.setItem(SECTIONS_KEY,JSON.stringify(all))}catch(e){}}
// shadcn SidebarGroup whose label is a collapsible trigger.
function sidebarSection(name,label,rows){
  const group=el('div');group.className='sidebar-group';group.dataset.section=name;
  const list=el('ul');list.className='sidebar-menu';list.id='section-'+name;list.append(...rows);
  const trigger=el('button');trigger.type='button';trigger.className='sidebar-group-label';
  trigger.setAttribute('aria-controls',list.id);
  trigger.append(el('span',label),icon('chevron-down'));
  const setOpen=open=>{list.classList.toggle('hidden',!open);trigger.setAttribute('aria-expanded',String(open))};
  setOpen(!collapsedSections()[name]);
  trigger.onclick=()=>{const open=list.classList.contains('hidden');setOpen(open);setSectionCollapsed(name,!open)};
  group.append(trigger,list);
  return group;
}
function scriptRow(s,pinnedIndex=null){
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
    dropdownItem(isPinned(s)?'Unpin':'Pin',()=>{closeMenu();togglePin(s.id)},undefined,isPinned(s)?'pin-off':'pin'),
    dropdownItem('Rename',()=>{closeMenu();openModal('rename',s)},undefined,'pen'));
  if(pinnedIndex!==null&&pinnedOrder.length>1){
    item.dataset.pinnedScriptId=s.id;
    const up=dropdownItem('Move up',()=>movePinnedScript(s.id,pinnedIndex-1),undefined,'arrow-up');
    const down=dropdownItem('Move down',()=>movePinnedScript(s.id,pinnedIndex+1),undefined,'arrow-down');
    up.disabled=pinnedIndex===0;down.disabled=pinnedIndex===pinnedOrder.length-1;
    menu.append(dropdownSeparator(),up,down);
  }
  menu.append(dropdownSeparator(),dropdownItem('Delete',()=>{closeMenu();openModal('delete',s)},'destructive','trash'));
  menu.onclick=e=>e.stopPropagation();
  toggle.onclick=e=>{e.stopPropagation();const wasOpen=!menu.classList.contains('hidden');closeMenu();if(!wasOpen){menu.classList.remove('hidden');placeMenu(menu,toggle);toggle.setAttribute('aria-expanded','true');activeMenu=menu}};
  item.append(open,toggle,menu);
  return item;
}
const scriptSearch=$('scriptSearch'),scriptSearchToggle=$('toggleScriptSearch');
const searchUsesMeta=/Mac|iPhone|iPad|iPod/.test(navigator.platform);
scriptSearchToggle.dataset.tooltipShortcut=searchUsesMeta?'⌘ K':'Ctrl K';
scriptSearchToggle.setAttribute('aria-keyshortcuts',searchUsesMeta?'Meta+K':'Control+K');
function setScriptSearch(open){
  scriptSearch.classList.toggle('hidden',!open);
  scriptSearchToggle.setAttribute('aria-expanded',String(open));
  if(open){scriptSearch.focus();return}
  scriptSearch.value='';
  scriptSearchToggle.focus();
  if(db)library();
}
scriptSearchToggle.onclick=()=>setScriptSearch(scriptSearch.classList.contains('hidden'));
scriptSearch.oninput=()=>{if(db)library()};
scriptSearch.onkeydown=e=>{
  if(e.key!=='Escape')return;
  e.preventDefault();e.stopPropagation();setScriptSearch(false);
};
document.addEventListener('keydown',e=>{
  const modifier=searchUsesMeta?e.metaKey&&!e.ctrlKey:e.ctrlKey&&!e.metaKey;
  if(e.defaultPrevented||e.isComposing||e.altKey||e.shiftKey||!modifier||e.key.toLowerCase()!=='k')return;
  if(modalAction||!$('playPane').classList.contains('hidden')||!$('importPane').classList.contains('hidden'))return;
  e.preventDefault();
  setSidebar(true);setScriptSearch(true);
});
async function library(){
  closeMenu();
  // Load first, then replace the list in one step, so overlapping calls can't add duplicate rows.
  const scripts=(await getAll()).sort((a,b)=>(b.lastUsed||0)-(a.lastUsed||0));
  if(reorderDrag?.sidebar){refreshLibraryAfterDrag=true;return}
  $('emptyLibrary').classList.toggle('hidden',!!(script||currentPage||scripts.length));
  const pinned=orderPinned(scripts.filter(isPinned)),recents=scripts.filter(s=>!isPinned(s));
  const query=scriptSearch.value.trim().toLowerCase();
  if(query){
    const matches=scripts.filter(s=>(s.title||'Untitled').toLowerCase().includes(query));
    const results=el(matches.length?'ul':'p');
    if(matches.length){
      results.className='sidebar-menu';
      results.append(...matches.map(s=>scriptRow(s)));
    }else{
      results.className='sidebar-search-empty muted';
      results.textContent='No matching scripts.';
    }
    $('library').replaceChildren(results);
    return;
  }
  const sections=[];
  if(pinned.length)sections.push(sidebarSection('pinned','Pinned',pinned.map(scriptRow)));
  if(recents.length)sections.push(sidebarSection('recents','Recents',recents.map(s=>scriptRow(s))));
  $('library').replaceChildren(...sections);
}
// Pinned scripts: stored as "pinned" (scripts saved earlier as "favorite" count as pinned).
const isPinned=s=>!!(s.pinned??s.favorite);
function setPinned(s,pinned){s.pinned=pinned;delete s.favorite}
async function togglePin(id){
  if(script?.id===id){setPinned(script,!isPinned(script));await flushSave()}
  else{const saved=(await getAll()).find(x=>x.id===id);if(!saved)return;setPinned(saved,!isPinned(saved));await put(saved)}
  await library();
}
function updateScriptHeader(){
  updateScriptHistoryButtons();
  syncMobileEditBar();
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
    if(mobileQuery.matches)$('titleDropdown').focus({preventScroll:true});
    else{$('quickRenameInput').focus({preventScroll:true});$('quickRenameInput').select()}
  }
};
$('titleDropdown').onclick=e=>e.stopPropagation();
$('quickRenameCancel').onclick=closeTitleDropdown;
async function renameOpenScript(title){
  if(script.title!==title)rememberScriptEdit();
  script.title=title;$('title').value=title;$('scriptHeading').textContent=title;
  await flushSave();updateScriptHeader();
}
$('titleDropdown').onsubmit=async e=>{
  e.preventDefault();if(!script)return;
  const name=$('quickRenameInput').value.trim();
  if(!name){$('quickRenameError').textContent='Enter a script name.';return}
  const button=$('titleDropdown').querySelector('[type="submit"]');button.disabled=true;
  try{
    await renameOpenScript(name);await library();
  }catch(err){$('quickRenameError').textContent=err.message||'Could not rename script.'}
  finally{button.disabled=false}
};
document.addEventListener('click',e=>{if(!e.target.closest('#titleDropdownWrap'))closeTitleDropdown()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeTitleDropdown()});
$('topScriptMenuToggle').onclick=e=>{e.stopPropagation();const menu=$('topScriptMenu');const opening=menu.classList.contains('hidden');if(opening&&script)$('topPin').replaceChildren(icon(isPinned(script)?'pin-off':'pin'),document.createTextNode(isPinned(script)?'Unpin':'Pin'));menu.classList.toggle('hidden',!opening);$('topScriptMenuToggle').setAttribute('aria-expanded',String(opening))};
$('topScriptActions').onclick=e=>e.stopPropagation();
document.addEventListener('click',e=>{if(!e.target.closest('#topScriptActions'))$('topScriptMenu').classList.add('hidden')});
$('topPin').onclick=()=>{if(script){$('topScriptMenu').classList.add('hidden');togglePin(script.id)}};
$('topRename').onclick=()=>{if(script){$('topScriptMenu').classList.add('hidden');openModal('rename',script)}};
$('topDelete').onclick=()=>{if(script){$('topScriptMenu').classList.add('hidden');openModal('delete',script)}};
// New scripts start with just a scene heading (cursor in it). Enter adds the action, then Enter
// again starts the first dialogue line.
$('newScript').onclick=async()=>{
  closeMobileSidebar();
  const fresh={id:crypto.randomUUID(),title:UNTITLED_SCRIPT,newDraft:true,meCharacter:DEFAULT_ACTOR_NAME,otherCharacters:[],turns:[{who:'heading',text:''}]};
  await openScript(fresh,{create:true});
  focusBlockText(0);
};
async function returnToLibrary(){
  await finishScript();stop();releaseMicrophone();script=null;
  $('playButton').classList.add('hidden');closePlayPane();$('editor').classList.add('hidden');
  showView(null);updateScriptHeader();await library();
}
$('back').onclick=returnToLibrary;
// iOS can't play a recording straight from IndexedDB through a blob URL (the <audio> element
// fails without an error), though its bytes still read fine. Copy each take into memory once
// when a script opens so playback uses an in-memory blob instead.
const inMemoryTakes=new WeakSet();
async function loadRecordingsIntoMemory(s){
  await Promise.all(s.turns.map(async turn=>{
    const take=turn.audio;
    if(!take||inMemoryTakes.has(take))return;
    try{
      const copy=new Blob([await take.arrayBuffer()],{type:take.type});
      inMemoryTakes.add(copy);
      if(turn.audio===take)turn.audio=copy;
    }catch(e){console.error('Could not load a recording',e)}
  }));
}
async function openScript(s,{create=false}={}){
  if(script?.id===s.id){s=script;await flushSave()}
  else{
    await finishScript();
    // A sidebar row can still be visible while its draft is being discarded.
    if(!create&&s.newDraft){
      s=(await getAll()).find(saved=>saved.id===s.id);
      if(!s)return;
    }
    stop();releaseMicrophone();
  }
  if(create)await put(s);
  await loadRecordingsIntoMemory(s);
  showView(null);$('playButton').classList.remove('hidden');
  script=s;script.lastUsed=Date.now();queueSave(true);
  try{localStorage.setItem('rehearsal-last-opened',s.id)}catch(e){}
  $('title').value=s.title;updateScriptHeader();$('editor').classList.remove('hidden');
  enterMode('record');render();await library();
}
// Pages above the library (Tests, Settings) open in the main area the same way a script opens:
// the current script closes, the sidebar row is selected, and it's remembered as last opened.
const PAGES={
  tests:{view:'testsView',row:'openTests',title:'Tests'},
  settings:{view:'settingsView',row:'openSettings',title:'Settings'},
};
let currentPage=null;
const testTabs=[...$('testsTabs').querySelectorAll('[role="tab"]')];
let activeTestTab=testTabs[0];
function positionAudioTestDialog(){
  const frame=$('testsFrame');
  if(!frame.getAttribute('src')||!frame.getClientRects().length)return;
  const bounds=frame.getBoundingClientRect();
  const viewport=window.visualViewport;
  const top=Math.max(bounds.top,$('testsTabs').getBoundingClientRect().bottom,viewport?.offsetTop??0);
  const bottom=Math.min(bounds.bottom,viewport?viewport.offsetTop+viewport.height:innerHeight);
  const root=frame.contentDocument?.documentElement;
  root?.style.setProperty('--test-visible-top',Math.max(0,top-bounds.top)+'px');
  root?.style.setProperty('--test-visible-height',Math.max(0,bottom-top)+'px');
}
for(const frame of $('testsView').querySelectorAll('iframe[data-src]')){
  let observer;
  frame.addEventListener('load',()=>{
    observer?.disconnect();
    const main=frame.contentDocument?.querySelector('main');
    if(!main)return;
    const fit=()=>{
      const height=Math.ceil(main.getBoundingClientRect().bottom+frame.contentWindow.scrollY);
      if(height>0)frame.style.height=height+'px';
      if(frame===$('testsFrame'))positionAudioTestDialog();
    };
    observer=new ResizeObserver(fit);
    observer.observe(main);
    fit();
  });
}
window.addEventListener('scroll',positionAudioTestDialog,{passive:true});
window.addEventListener('resize',positionAudioTestDialog);
window.visualViewport?.addEventListener('resize',positionAudioTestDialog);
window.visualViewport?.addEventListener('scroll',positionAudioTestDialog);
function selectTestTab(selected){
  const changed=activeTestTab!==selected;
  activeTestTab=selected;
  for(const tab of testTabs){
    const on=tab===selected;
    tab.setAttribute('aria-selected',String(on));
    tab.tabIndex=on?0:-1;
    $(tab.getAttribute('aria-controls')).classList.toggle('hidden',!on);
  }
  const panel=$(selected.getAttribute('aria-controls'));
  const frame=panel.querySelector('iframe');
  const needsServer=$('testsNeedsServer');
  const fromDisk=location.protocol==='file:';
  needsServer.classList.toggle('hidden',!(frame&&fromDisk));
  if(!frame){
    document.dispatchEvent(new Event('storage-diagnostics-open'));
  }else if(fromDisk){
    frame.classList.add('hidden');
    panel.append(needsServer);
  }else if(!frame.getAttribute('src')){
    // Keep the frame mounted after its first use so switching tabs preserves test state.
    frame.src=frame.dataset.src;
  }
  if(changed)window.scrollTo({top:0,behavior:'instant'});
  if(frame===$('testsFrame'))positionAudioTestDialog();
}
for(const tab of testTabs)tab.onclick=()=>selectTestTab(tab);
$('testsTabs').onkeydown=e=>{
  const index=testTabs.indexOf(e.target);
  if(index<0)return;
  let next;
  switch(e.key){
    case 'ArrowLeft':next=(index-1+testTabs.length)%testTabs.length;break;
    case 'ArrowRight':next=(index+1)%testTabs.length;break;
    case 'Home':next=0;break;
    case 'End':next=testTabs.length-1;break;
    default:return;
  }
  e.preventDefault();selectTestTab(testTabs[next]);testTabs[next].focus();
};
window.addEventListener('message',e=>{
  if(db&&e.origin===location.origin&&e.source===$('importTestsFrame').contentWindow&&e.data==='test-script-saved')library();
});
function showView(name){
  finishReorder();
  currentPage=name;
  $('emptyLibrary').classList.add('hidden');
  for(const [id,page] of Object.entries(PAGES)){
    const on=id===name;
    $(page.view).classList.toggle('hidden',!on);
    const row=$(page.row);row.toggleAttribute('data-active',on);
    if(on)row.setAttribute('aria-current','true');else row.removeAttribute('aria-current');
  }
  $('topViewTitle').classList.toggle('hidden',!name);
  if(name)$('topViewTitle').textContent=PAGES[name].title;
  if(name==='tests')selectTestTab(activeTestTab);
}
async function openPage(name){
  // Tests uses its own microphone, so the app's is released. Settings leaves a connected
  // microphone on, so its status and Release button show it (a recording in progress still ends).
  closeMenu();closeMobileSidebar();await finishScript();stop();
  if(name==='settings'){if(recorder&&recorder.state!=='inactive')recorder.stop()}else releaseMicrophone();
  script=null;$('playButton').classList.add('hidden');closePlayPane();$('editor').classList.add('hidden');
  updateScriptHeader();showView(name);
  try{localStorage.setItem('rehearsal-last-opened',name)}catch(e){}
  await library();
}
const openTests=()=>openPage('tests'),openSettings=()=>{updateStorageStatus();return openPage('settings')};
// Settings > Storage > Clear storage: deletes every script and recording after a confirmation.
// Preferences (theme, font size, collapsed sections) stay.
$('clearStorage').onclick=async()=>{let count=0;try{count=(await getAll()).length}catch(e){}if(!count){$('storageStatus').textContent='There are no scripts or recordings to clear.';return}openModal('clearStorage',{count})};
async function clearStorage(){
  const btn=$('modalConfirm');btn.disabled=true;
  try{
    clearTimeout(saveTimer);await saveChain;
    await new Promise((ok,no)=>{const r=store('readwrite').clear();r.onsuccess=ok;r.onerror=()=>no(r.error)});
    try{const last=localStorage.getItem('rehearsal-last-opened');if(last&&last!=='settings'&&last!=='tests')localStorage.removeItem('rehearsal-last-opened')}catch(e){}
    closeModal();await library();updateStorageStatus();
  }catch(err){$('modalMessage').textContent='Could not clear storage: '+(err?.message||'unknown error')}
  finally{btn.disabled=false}
}
$('openTests').onclick=openTests;$('openSettings').onclick=openSettings;

// ---- Import flow ----------------------------------------------------------
// Import in the sidebar opens the file picker. Choosing a file opens the import pane (a full-page
// pane like the teleprompter's): name the script, pick your character, review the blocks. Import
// saves it and opens the script; exiting asks first. The importer is script-import/ (ES modules,
// loaded on first use); review-ui.js renders the character list and the block table.
let importUi=null,importReview=null,importBusy=false;
async function loadImportUi(){
  if(!importUi)importUi=await import(new URL('script-import/review-ui.js',document.baseURI).href);
  return importUi;
}
$('openImport').onclick=()=>{
  closeMobileSidebar();
  if(location.protocol==='file:'){alert('Importing needs a local server. From the repository root, run python3 speech-lab/serve.py, then open http://localhost:8000/');return}
  $('importFile').value='';$('importFile').click();
};
$('emptyNewScript').onclick=()=>$('newScript').click();
$('emptyImportScript').onclick=()=>$('openImport').click();
$('importFile').onchange=e=>{const file=e.target.files[0];if(file)startImport(file)};
async function startImport(file){
  if(isBlankNewScript(script))await returnToLibrary();
  openImportPane(file.name);
  $('importStatus').textContent=`Reading ${file.name}…`;
  try{
    const ui=await loadImportUi();
    importReview||=ui.createImportReview({characters:$('importCharacters'),selectId:'importMe',blocks:$('importBlocks'),filter:$('importFilter'),confidence:false,onChange:renderImportSummary});
    const result=await ui.readScriptFile(file);
    if($('importPane').classList.contains('hidden'))return; // exited while reading
    $('importTitle').value=result.title||file.name.replace(/\.[^.]+$/,'');
    $('importStatus').textContent='';$('importContent').classList.remove('hidden');
    importReview.load(result);
    $('importConfirm').disabled=!result.blocks.length;
    $('importTitle').focus({preventScroll:true});
  }catch(err){console.error(err);$('importStatus').textContent=`Couldn't read ${file.name}: ${err.message}`}
}
function renderImportSummary(review){
  const r=review.result;
  $('importUndo').classList.toggle('hidden',!review.canUndo);
  // Above the table: how many blocks still need review (hidden when none do).
  const toReview=r.blocks.filter(b=>b.review).length;
  $('importReviewAlert').classList.toggle('hidden',!toReview);
  $('importReviewAlertTitle').textContent=toReview===1?'1 block needs review':`${toReview} blocks need review`;
  $('importWarnings').replaceChildren(...r.warnings.map(w=>{const a=el('div');a.className='alert import-warning';a.setAttribute('role','alert');const d=el('div',w);d.className='alert-description';a.append(d);return a}));
}
function openImportPane(fileName){
  closeMenu();hideTip();
  $('importFileName').textContent=fileName;
  $('importContent').classList.add('hidden');$('importWarnings').replaceChildren();
  $('importUndo').classList.add('hidden');$('importConfirm').disabled=true;
  $('importPane').classList.remove('hidden');document.body.style.overflow='hidden';
  $('importPane').querySelector('.import-pane-main').scrollTop=0;
  $('cancelImport').focus({preventScroll:true});
}
function closeImportPane(){
  $('importPane').classList.add('hidden');
  if($('playPane').classList.contains('hidden'))document.body.style.overflow='';
}
// Nothing is saved until Import, so leaving asks first once a file has been read.
function requestExitImport(){
  if(importBusy)return;
  if($('importContent').classList.contains('hidden')){closeImportPane();return}
  openModal('discardImport',{});
}
$('cancelImport').onclick=requestExitImport;
$('importUndo').onclick=()=>importReview?.undo();
$('importConfirm').onclick=async()=>{
  if(!importReview?.result||importBusy)return;
  importBusy=true;$('importConfirm').disabled=true;
  try{
    const s=importReview.toScript({title:$('importTitle').value.trim()});
    s.lastUsed=Date.now();
    await put(s);
    closeImportPane();
    await openScript(s);
  }catch(err){alert('Could not import: '+err.message)}
  finally{importBusy=false;$('importConfirm').disabled=false}
};
// Escape asks to exit (after an open dialog has handled its own Escape).
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&!modalAction&&!$('importPane').classList.contains('hidden')){e.preventDefault();requestExitImport()}});
function showHome(){stop();$('scriptHeading').textContent=script.title||'Untitled script';$('scriptHome').classList.remove('hidden');$('workspace').classList.add('hidden')}
function enterMode(m){$('scriptHome').classList.add('hidden');$('workspace').classList.remove('hidden');setMode(m)}
$('home').onclick=()=>{script.title=$('title').value.trim()||'Untitled script';showHome()};$('enterRecord').onclick=()=>enterMode('record');$('enterPlay').onclick=()=>enterMode('play');
// Play mode is a full-page pane over the editor; record mode is the editor itself.
function setMode(m){if(m==='play')openPlayPane();else closePlayPane()}
function openPlayPane(){
  if(!script)return;
  stop();hideTip();
  $('playScriptTitle').textContent=script.title||'Untitled script';
  const all=scenes();
  const kept=sceneRange.scriptId===script.id&&all.find(scene=>scene.start===sceneRange.start);
  selectScene(kept||all[0]);
  setPlaySettings(false);setPlayDetection(false);updateDetectionButton();
  setScenesOpen(mobileQuery.matches?false:scenesPreferred);
  $('playPane').classList.remove('hidden');document.body.style.overflow='hidden';
  display(true); // center the cued line now that the pane is visible
  $('start').focus({preventScroll:true});
}
function closePlayPane(){
  const wasOpen=!$('playPane').classList.contains('hidden');
  stop();setPlaySettings(false);setPlayDetection(false);$('playPane').classList.add('hidden');document.body.style.overflow='';
  if(wasOpen&&!$('playButton').classList.contains('hidden'))$('playButton').focus();
}
$('playButton').onclick=()=>setMode('play');$('closePlay').onclick=()=>setMode('record');
// Escape closes an open play-bar menu first, then the play pane.
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape'||modalAction||$('playPane').classList.contains('hidden'))return;
  e.preventDefault();
  if(!$('playSettingsMenu').classList.contains('hidden')){setPlaySettings(false);$('playSettingsToggle').focus({preventScroll:true});return}
  const detectionHelp=$('playDetectionMenu').querySelector('.play-detection-details:not(.hidden)');
  if(!$('playDetectionMenu').classList.contains('hidden')&&detectionHelp){detectionHelp.classList.add('hidden');return}
  if(!$('playDetectionMenu').classList.contains('hidden')){setPlayDetection(false);$('playDetectionToggle').focus({preventScroll:true});return}
  if(mobileQuery.matches&&scenesVisible()){setScenesOpen(false);$('toggleScenes').focus({preventScroll:true});return}
  setMode('record');
});
// Play-mode help dropdown (rehearsal tips).
$('toggleScenes').onclick=()=>setScenesOpen(!scenesVisible());
$('playScenesBackdrop').onclick=()=>setScenesOpen(false);
$('playSettingsToggle').onclick=e=>{e.stopPropagation();setPlaySettings($('playSettingsMenu').classList.contains('hidden'))};
$('playSettingsMenu').onclick=e=>e.stopPropagation();
document.addEventListener('click',()=>setPlaySettings(false));
$('playDetectionToggle').onclick=e=>{e.stopPropagation();setPlayDetection($('playDetectionMenu').classList.contains('hidden'))};
$('playDetectionMenu').onclick=e=>e.stopPropagation();
document.addEventListener('click',()=>setPlayDetection(false));
function newDialogueLine(){return {who:'them',character:'',text:'',audio:null}}
function addDialogueLine(index=script.turns.length){
  rememberScriptEdit();
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
  rememberScriptEdit();
  script.turns.splice(index,0,{who,text:''});
  render();queueSave(true);
  focusBlockText(index);
}
// Script typing: Tab / Shift+Tab move between text fields (character, dialogue, scene
// heading, action) and skip the block buttons. Outside the script, the usual tab order applies.
const SCRIPT_FIELDS='.character, .dialogue, .block-text';
const MOBILE_BLOCK_FIELDS=SCRIPT_FIELDS+', .beat-text';
const mobileEditBar=$('mobileEditBar');
const renderedBlocks=new WeakMap();
let mobileEditorField=null;

const dropLine=el('div');
dropLine.className='reorder-drop-line hidden';
dropLine.setAttribute('aria-hidden','true');
document.body.append(dropLine);
const libraryPanel=$('libraryPanel');
let reorderDrag=null,suppressReorderClick=false;

function trackReorder(item,x,y,id,touch,commit){
  const list=item.parentElement;
  if(reorderDrag||list.children.length<2)return;
  reorderDrag={item,list,commit,sidebar:list.id==='section-pinned',startX:x,startY:y,y,id,touch};
  if(touch)reorderDrag.timer=setTimeout(startReorder,350);
}
function startReorder(){
  const drag=reorderDrag;
  if(!drag?.item.isConnected){finishReorder();return}
  drag.active=true;
  closeBlockMenu();closeMenu();hideTip();
  document.body.classList.add('reordering-items');
  drag.item.classList.add('reorder-source');
  dropLine.classList.toggle('sidebar-drop-line',drag.sidebar);
  dropLine.classList.remove('hidden');
  scheduleDropLine();
}
function dropTarget(list,y){
  const items=list.children;
  let first=0,last=items.length;
  while(first<last){
    const middle=Math.floor((first+last)/2);
    const bounds=items[middle].getBoundingClientRect();
    if(y<bounds.top+bounds.height/2)last=middle;
    else first=middle+1;
  }
  const before=items[first]?.getBoundingClientRect();
  const after=items[first-1]?.getBoundingClientRect();
  const top=before&&after?(before.top+after.bottom)/2:before?before.top-1:after.bottom+1;
  return {index:first,top,bounds:before||after};
}
function scheduleDropLine(){
  if(reorderDrag?.active&&!reorderDrag.frame)reorderDrag.frame=requestAnimationFrame(drawDropLine);
}
function drawDropLine(){
  const drag=reorderDrag;
  drag.frame=0;
  if(!drag.item.isConnected||!drag.list.getClientRects().length){finishReorder();return}
  const target=dropTarget(drag.list,drag.y);
  const viewport=window.visualViewport;
  const visibleTop=viewport?.offsetTop??0;
  const visibleBottom=viewport?viewport.height+visibleTop:innerHeight;
  const panel=drag.sidebar?libraryPanel.getBoundingClientRect():null;
  const top=Math.max(visibleTop,panel?.top??document.querySelector('.app-header').getBoundingClientRect().bottom);
  const bottom=Math.min(visibleBottom,panel?.bottom??
    (mobileEditBar.classList.contains('hidden')?visibleBottom:mobileEditBar.getBoundingClientRect().top));
  dropLine.style.top=(drag.sidebar?Math.max(top,Math.min(bottom,target.top)):target.top)+'px';
  dropLine.style.left=target.bounds.left+'px';
  dropLine.style.width=target.bounds.width+'px';
  const speed=drag.y<top+48?-Math.min(20,(top+48-drag.y)/3):
    drag.y>bottom-48?Math.min(20,(drag.y-bottom+48)/3):0;
  if(speed){
    const scroller=drag.sidebar?libraryPanel:document.scrollingElement;
    const previous=scroller.scrollTop;
    scroller.scrollBy({top:speed,behavior:'instant'});
    if(previous!==scroller.scrollTop)scheduleDropLine();
  }
}
function moveReorder(x,y){
  const drag=reorderDrag;
  drag.y=y;
  if(!drag.active&&Math.hypot(x-drag.startX,y-drag.startY)>6){
    if(drag.touch){finishReorder();return}
    startReorder();
  }
  scheduleDropLine();
}
function finishReorder(drop=false){
  const drag=reorderDrag;
  if(!drag)return;
  reorderDrag=null;
  clearTimeout(drag.timer);cancelAnimationFrame(drag.frame);
  if(drag.sidebar&&refreshLibraryAfterDrag){
    refreshLibraryAfterDrag=false;
    setTimeout(()=>library(),0);
  }
  if(!drag.active)return;
  drag.item.classList.remove('reorder-source');
  document.body.classList.remove('reordering-items');
  dropLine.classList.add('hidden');
  if(!drop||!drag.item.isConnected||!drag.list.getClientRects().length)return;
  const from=Array.prototype.indexOf.call(drag.list.children,drag.item);
  const gap=dropTarget(drag.list,drag.y).index;
  const to=gap>from?gap-1:gap;
  if(from>=0&&from!==to)drag.commit(to);
}
function trackScriptBlock(block,x,y,id,touch){
  const turn=renderedBlocks.get(block)?.turn,current=script;
  if(!turn||!current)return;
  trackReorder(block,x,y,id,touch,to=>{
    const from=current.turns.indexOf(turn);
    if(current!==script||from<0)return;
    rememberScriptEdit();
    current.turns.splice(from,1);current.turns.splice(to,0,turn);
    render();queueSave(true);
  });
}
function trackPinnedRow(row,x,y,id,touch){
  trackReorder(row,x,y,id,touch,to=>movePinnedScript(row.dataset.pinnedScriptId,to));
}

$('turns').addEventListener('pointerdown',e=>{
  const grip=e.target.closest('.block-grip');
  if(grip&&e.pointerType!=='touch'&&e.button===0)trackScriptBlock(grip.closest('.turn'),e.clientX,e.clientY,e.pointerId,false);
});
libraryPanel.addEventListener('pointerdown',e=>{
  const row=e.target.closest('.sidebar-menu-button')?.closest('[data-pinned-script-id]');
  if(row&&e.pointerType!=='touch'&&e.button===0)trackPinnedRow(row,e.clientX,e.clientY,e.pointerId,false);
});
document.addEventListener('pointermove',e=>{
  if(!reorderDrag||reorderDrag.touch||reorderDrag.id!==e.pointerId)return;
  if(e.buttons)moveReorder(e.clientX,e.clientY);
  else finishReorder();
});
document.addEventListener('pointerup',e=>{
  if(!reorderDrag||reorderDrag.touch||reorderDrag.id!==e.pointerId)return;
  if(reorderDrag.active){
    reorderDrag.y=e.clientY;
    suppressReorderClick=true;setTimeout(()=>{suppressReorderClick=false},0);
  }
  finishReorder(true);
});
document.addEventListener('pointercancel',e=>{if(reorderDrag&&!reorderDrag.touch&&reorderDrag.id===e.pointerId)finishReorder()});
$('turns').addEventListener('touchstart',e=>{
  const block=e.target.closest('.turn');
  if(!block||e.touches.length!==1||e.target.closest('button, a, .dropdown-menu'))return;
  const touch=e.changedTouches[0];
  trackScriptBlock(block,touch.clientX,touch.clientY,touch.identifier,true);
},{passive:true});
libraryPanel.addEventListener('touchstart',e=>{
  const row=e.target.closest('[data-pinned-script-id]');
  if(!row||e.touches.length!==1||!e.target.closest('.sidebar-menu-button'))return;
  const touch=e.changedTouches[0];
  trackPinnedRow(row,touch.clientX,touch.clientY,touch.identifier,true);
},{passive:true});
document.addEventListener('touchmove',e=>{
  if(!reorderDrag?.touch)return;
  if(e.touches.length!==1){finishReorder();return}
  const touch=[...e.changedTouches].find(item=>item.identifier===reorderDrag.id);
  if(!touch)return;
  if(reorderDrag.active)e.preventDefault();
  moveReorder(touch.clientX,touch.clientY);
},{passive:false});
document.addEventListener('touchend',e=>{
  if(!reorderDrag?.touch)return;
  const touch=[...e.changedTouches].find(item=>item.identifier===reorderDrag.id);
  if(!touch)return;
  if(reorderDrag.active){reorderDrag.y=touch.clientY;e.preventDefault()}
  finishReorder(true);
},{passive:false});
document.addEventListener('touchcancel',()=>{if(reorderDrag?.touch)finishReorder()});
document.addEventListener('contextmenu',e=>{if(reorderDrag?.active&&reorderDrag.touch)e.preventDefault()});
document.addEventListener('click',e=>{
  if(suppressReorderClick&&e.target.closest('#turns, #libraryPanel')){e.preventDefault();e.stopPropagation()}
},true);
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&reorderDrag){e.preventDefault();e.stopPropagation();finishReorder()}
},true);
window.addEventListener('blur',()=>finishReorder());
window.addEventListener('scroll',scheduleDropLine,{passive:true});
libraryPanel.addEventListener('scroll',scheduleDropLine,{passive:true});
window.addEventListener('storage',e=>{if(e.key===PINNED_ORDER_KEY&&db)library()});

function positionMobileEditBar(){
  const viewport=window.visualViewport;
  const inset=viewport?document.documentElement.clientHeight-viewport.height-viewport.offsetTop:0;
  mobileEditBar.style.setProperty('--keyboard-inset',Math.max(0,inset)+'px');
}
function syncMobileEditBar(){
  const active=document.activeElement;
  const field=active?.matches('#turns :is('+MOBILE_BLOCK_FIELDS+')')?active:
    mobileEditBar.contains(active)&&mobileEditorField?.isConnected?mobileEditorField:null;
  const block=field?.closest('.turn');
  const visible=!!(mobileQuery.matches&&script&&!$('editor').classList.contains('hidden')&&
    !$('workspace').classList.contains('hidden')&&(block||!script.turns.length)&&
    $('playPane').classList.contains('hidden')&&$('importPane').classList.contains('hidden'));
  if(openBlockMenu?.mobile&&(!visible||block!==openBlockMenu.origin))closeBlockMenu();
  mobileEditorField=visible?field:null;
  mobileEditBar.classList.toggle('hidden',!visible);
  const history=$('scriptHistory');
  if(visible){
    if(history.parentElement!==mobileEditBar)mobileEditBar.append(history);
    $('mobileTurnInto').disabled=!block;
    $('mobileDeleteBlock').disabled=!block;
    $('mobileMoveUp').disabled=!block?.previousElementSibling;
    $('mobileMoveDown').disabled=!block?.nextElementSibling;
    $('mobileBeatDuration').classList.toggle('hidden',block?.dataset.who!=='beat');
    positionMobileEditBar();
  }else if(history.parentElement===mobileEditBar)$('playButton').before(history);
}
document.addEventListener('focusin',syncMobileEditBar);
document.addEventListener('focusout',()=>queueMicrotask(syncMobileEditBar));
mobileQuery.addEventListener('change',syncMobileEditBar);
window.visualViewport?.addEventListener('resize',positionMobileEditBar);
window.visualViewport?.addEventListener('scroll',positionMobileEditBar);
mobileEditBar.addEventListener('mousedown',e=>{if(e.target.closest('button'))e.preventDefault()});
$('turns').addEventListener('mousedown',e=>{
  if(mobileEditorField&&e.target.closest('.record-controls button'))e.preventDefault();
});
function activeMobileBlock(){
  return renderedBlocks.get(mobileEditorField?.closest('.turn'));
}
$('mobileInsert').onclick=e=>{
  const block=activeMobileBlock();
  if(block)block.openInsert(e.currentTarget);
  else if(script&&!script.turns.length)addTextBlock(0,'heading');
};
$('mobileTurnInto').onclick=e=>activeMobileBlock()?.openTurnInto(e.currentTarget);
$('mobileBeatDuration').onclick=e=>activeMobileBlock()?.openBeatDuration(e.currentTarget);
$('mobileMoveUp').onclick=()=>activeMobileBlock()?.move(-1);
$('mobileMoveDown').onclick=()=>activeMobileBlock()?.move(1);
$('mobileDeleteBlock').onclick=()=>activeMobileBlock()?.remove();
function closeBlockMenu(){
  if(!openBlockMenu)return;
  const {menu,origin,trigger}=openBlockMenu;
  menu.classList.add('hidden');
  if(menu.parentElement!==origin)origin.append(menu);
  trigger.setAttribute('aria-expanded','false');
  openBlockMenu=null;
}
function showBlockMenu(menu,origin,trigger,fill){
  const wasOpen=openBlockMenu?.trigger===trigger;
  closeBlockMenu();
  if(wasOpen)return;
  menu.replaceChildren();fill();
  const mobile=mobileEditBar.contains(trigger);
  if(mobile)mobileEditBar.append(menu);
  menu.classList.remove('hidden');
  trigger.setAttribute('aria-expanded','true');
  openBlockMenu={menu,origin,trigger,mobile};
}
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
// Re-render the script without losing the field the user just moved into (e.g. clicking
// from a character name into dialogue): find the same field in the same block afterwards.
function renderKeepingFocus(target){
  const turn=target?.closest?.('#turns .turn');
  const kind=turn&&['.character','.dialogue','.block-text'].find(k=>target.matches(k));
  const key=kind&&{i:[...$('turns').children].indexOf(turn),kind,start:target.selectionStart,end:target.selectionEnd};
  render();
  if(!key)return;
  const field=$('turns').children[key.i]?.querySelector(key.kind);
  if(field){field.focus({preventScroll:true});try{field.setSelectionRange(key.start,key.end)}catch(e){}}
}
// Leave any script field first, so its "save on click-away" can't write the old name back
// once the script is redrawn (used before renaming a character).
function leaveScriptField(){if(document.activeElement?.closest?.('#turns'))document.activeElement.blur()}
// Rename a character on every one of their lines (your own character included).
function renameCharacter(oldName,newName){
  if(!newName||oldName===newName)return;
  leaveScriptField();
  rememberScriptEdit();
  if(oldName===script.meCharacter)script.meCharacter=newName;
  else script.turns.forEach(x=>{if(x.who==='them'&&(x.character||'').toUpperCase()===oldName){x.character=newName;if(newName===script.meCharacter)x.who='me'}});
  queueSave(true);render();
}
function focusBlockText(index){$('turns').children[index]?.querySelector('.block-text')?.focus({preventScroll:true})}

function normalizeCharacters(){
  if(!script)return;
  if(!script.meCharacter){
    script.meCharacter=(script.turns.find(t=>t.who==='me'&&t.character?.trim())?.character.trim()||DEFAULT_ACTOR_NAME).toUpperCase();
  }
  // Character suggestions are derived from characters currently used in blocks.
  // Removing or renaming the last occurrence automatically removes the old name.
  script.meCharacter=script.meCharacter.toUpperCase();
  script.turns.filter(t=>t.who==='me').forEach(t=>t.character=script.meCharacter);
  script.otherCharacters=[...new Set(script.turns.filter(t=>t.who==='them').map(t=>(t.character||'').trim().toUpperCase()).filter(Boolean))];
}
// Character extensions (V.O., O.S., CONT'D) stay on the line, shown after the name as in the
// script; the line still belongs to the bare name (you vs reader, the character list).
function cueSuffix(t){return extensionText(t.extensions)}
function extensionText(list){return list?.length?' '+list.map(e=>`(${e})`).join(' '):''}
function splitCue(value){
  let name=value.trim().toUpperCase();const extensions=[];let m;
  while((m=name.match(/\s*\(([^()]*)\)\s*$/))){if(m[1].trim())extensions.unshift(m[1].trim());name=name.slice(0,m.index).trim()}
  return {name,extensions};
}
function preserveTypedPunctuation(event,previous){
  if(event.isComposing||!['insertText','insertReplacementText'].includes(event.inputType))return;
  const field=event.target;
  const end=field.selectionStart;
  const punctuation=field.value[end-1];
  const literal=punctuation==='—'?'--':punctuation==='…'?'...':null;
  if(!literal)return;
  const prefix=field.value.slice(0,end-1),suffix=field.value.slice(end);
  // Replace only when the browser collapsed a punctuation run at the caret.
  if(previous===prefix+literal+suffix||previous===prefix+literal.slice(1)+suffix){
    field.setRangeText(literal,end-1,end,'end');
  }
}
function render(){
  normalizeCharacters();
  const root=$('turns');
  const focused=mobileEditorField?.isConnected?mobileEditorField:null;
  const focusedBlock=focused?.closest('.turn');
  const focusedIndex=focusedBlock?[...root.children].indexOf(focusedBlock):-1;
  const focusedTurn=renderedBlocks.get(focusedBlock)?.turn;
  const focusedKind=focused&&['.character','.dialogue','.block-text','.beat-text'].find(selector=>focused.matches(selector));
  const savedScroll=window.scrollY;
  hideTip();closeBlockMenu();root.replaceChildren();
  script.turns.forEach((t,i)=>{
    const div=el('div');div.className='turn'+(t.who==='beat'?' beat':'');div.dataset.who=t.who;
    const tools=el('div');tools.className='margin-tools';
    const add=el('button');add.type='button';add.className='btn btn-ghost btn-icon block-add';add.setAttribute('aria-haspopup','true');add.setAttribute('aria-expanded','false');add.append(icon('plus'));setTip(add,'Insert');add.setAttribute('aria-label','Insert');
    const dots=el('button');dots.type='button';dots.className='btn btn-ghost btn-icon block-grip';dots.setAttribute('aria-haspopup','true');dots.append(icon('grip-vertical'));setTip(dots,'Drag to move, click to open menu');dots.setAttribute('aria-label','Options');dots.setAttribute('aria-expanded','false');
    const menu=el('div');menu.className='dropdown-menu block-menu hidden';
    const menuItem=(name,fn,variant,iconName)=>{const b=dropdownItem(name,fn,variant,iconName);menu.append(b);return b};
    const insert=(who)=>{if(who==='line'){addDialogueLine(i+1);return}if(who==='heading'||who==='action'){addTextBlock(i+1,who);return}rememberScriptEdit();script.turns.splice(i+1,0,{who:'beat',text:'',duration:2});render();queueSave(true)};
    const openInsert=trigger=>showBlockMenu(menu,div,trigger,()=>{
      if(trigger===$('mobileInsert'))menu.append(menuLabel('Insert'));
      menuItem('Line',()=>insert('line'),undefined,'text-align-start');
      menuItem('Beat',()=>insert('beat'),undefined,'gap-vertical');
      menuItem('Scene heading',()=>insert('heading'),undefined,'clapperboard');
      menuItem('Action',()=>insert('action'),undefined,'pilcrow');
    });
    const onTypeChange=becameLine=>{render();queueSave(true);if(becameLine)focusCharacter(i)};
    const openTurnInto=trigger=>showBlockMenu(menu,div,trigger,()=>{
      menu.append(menuLabel('Turn into'),...turnIntoOptions(t,onTypeChange).map(dropdownRadioItem));
    });
    const durationOptions=()=>beatDurationOptions(t,n=>{
      if(n===beatSeconds(t))return;
      rememberScriptEdit();t.duration=n;render();queueSave(true);
    });
    const openBeatDuration=trigger=>showBlockMenu(menu,div,trigger,()=>{
      menu.append(...durationOptions().map(dropdownRadioItem));
    });
    const move=delta=>{
      const next=i+delta;
      if(next<0||next>=script.turns.length)return;
      rememberScriptEdit();
      [script.turns[i],script.turns[next]]=[script.turns[next],script.turns[i]];
      render();queueSave(true);
    };
    const remove=()=>{rememberScriptEdit();script.turns.splice(i,1);render();queueSave(true)};
    renderedBlocks.set(div,{turn:t,openInsert,openTurnInto,openBeatDuration,move,remove});
    add.onclick=e=>{e.stopPropagation();openInsert(add)};
    dots.onclick=e=>{e.stopPropagation();showBlockMenu(menu,div,dots,()=>{
      if(t.who==='beat')menu.append(dropdownSubmenu('timer',secondsLabel(beatSeconds(t)),durationOptions()),dropdownSeparator());
      menu.append(dropdownSubmenu('repeat','Turn into',turnIntoOptions(t,onTypeChange)),dropdownSeparator());
      const up=menuItem('Move up',()=>move(-1),undefined,'arrow-up');up.disabled=i===0;
      const down=menuItem('Move down',()=>move(1),undefined,'arrow-down');down.disabled=i===script.turns.length-1;
      menu.append(dropdownSeparator());
      menuItem('Delete block',remove,'destructive','trash');
    })};
    tools.append(add,dots);div.append(tools,menu);
    if(t.who==='me'||t.who==='them'){
      const picker=el('div');picker.className='character-picker';
      const character=el('input');character.className='character';character.type='text';
      // The block's committed character: your character for your lines, the reader's otherwise.
      const current=()=>t.who==='me'?script.meCharacter:(t.character||'');
      character.placeholder='Character name…';
      character.value=current()+cueSuffix(t);
      character.setAttribute('aria-label',t.who==='me'?'Character name (you)':'Character name');
      const choices=el('div');choices.className='dropdown-menu character-choices hidden';
      // Assign this block's character. Your character's name makes it your line; any other
      // name makes it a reader line. An empty name puts the previous one back.
      const commit=(focusDialogue=false,nextFocus=null)=>{
        const {name,extensions}=splitCue(character.value);
        if(!name){character.value=current()+cueSuffix(t);return}
        if(changed())rememberScriptEdit();
        if(extensions.length)t.extensions=extensions;else delete t.extensions;
        character.value=name+cueSuffix(t);
        if(name===script.meCharacter){if(t.who!=='me')t.audio=null;t.who='me';t.character=name}
        else{t.who='them';t.character=name}
        queueSave(true);
        if(nextFocus)renderKeepingFocus(nextFocus);else render();
        if(focusDialogue){const next=$('turns').children[i]?.querySelector('textarea.dialogue');next?.focus({preventScroll:true});}
      };
      const changed=()=>character.value.trim().toUpperCase()!==current()+cueSuffix(t);
      // Dropdown: every character (yours marked "(you)", the current one checked), narrowed while
      // typing; then "Rename" for the block's current character. Up/Down move through every
      // item in the list while it's showing; Enter picks the character or runs the action.
      let activeChoice=-1;
      const items=()=>[...choices.querySelectorAll('.dropdown-menu-item')];
      const highlight=()=>items().forEach((o,k)=>o.toggleAttribute('data-highlighted',k===activeChoice));
      const drawChoices=()=>{
        const typed=splitCue(character.value).name,name=current(),filtering=!!typed&&typed!==name;
        const names=[...new Set([script.meCharacter,...script.otherCharacters])].filter(n=>n&&(!filtering||n.includes(typed)));
        choices.replaceChildren();
        for(const n of names){
          const option=el('button');option.type='button';option.className='dropdown-menu-item character-option';
          option.append(el('span',n));
          if(n===script.meCharacter){const hint=el('span','(you)');hint.className='me-hint';option.append(hint)}
          if(n===name&&!filtering)option.append(icon('check'));
          option.onmousedown=e=>e.preventDefault();
          option.onclick=()=>{character.value=n+extensionText(splitCue(character.value).extensions);choices.classList.add('hidden');commit(true)};
          choices.append(option);
        }
        activeChoice=filtering&&names.length?0:-1;highlight();
        if(name&&!filtering){
          const actions=[];
          actions.push(dropdownItem('Rename',()=>{choices.classList.add('hidden');openModal('character',{id:script.id,name})},undefined,'pen'));
          for(const a of actions)a.onmousedown=e=>e.preventDefault();
          if(names.length)choices.append(dropdownSeparator());
          choices.append(...actions);
        }
        choices.classList.toggle('hidden',!choices.childElementCount);
      };
      // While typing, Enter/Tab take the highlighted suggestion.
      // The highlighted item, if the list is showing.
      const highlighted=()=>choices.classList.contains('hidden')?null:items()[activeChoice]||null;
      // Enter/Tab take a highlighted character name, keeping any extensions typed in the field.
      const takeHighlighted=()=>{const o=highlighted();if(o?.classList.contains('character-option'))character.value=o.firstChild.textContent+extensionText(splitCue(character.value).extensions)};
      character.onfocus=drawChoices;
      character.oninput=()=>{
        const pos=character.selectionStart;
        character.value=character.value.toUpperCase();
        character.setSelectionRange(pos,pos);
        drawChoices();
      };
      character.onkeydown=e=>{
        const all=items();
        if((e.key==='ArrowDown'||e.key==='ArrowUp')&&!e.shiftKey&&all.length&&!choices.classList.contains('hidden')){
          e.preventDefault();
          const down=e.key==='ArrowDown';
          activeChoice=activeChoice<0?(down?0:all.length-1):(activeChoice+(down?1:-1)+all.length)%all.length;
          highlight();all[activeChoice].scrollIntoView({block:'nearest'});return;
        }
        if(e.key==='Enter'){
          e.preventDefault();
          const o=highlighted();
          if(o&&!o.classList.contains('character-option')){o.click();return} // an action, e.g. Rename
          takeHighlighted();choices.classList.add('hidden');commit(true);return;
        }
        if(e.key==='Escape'){character.value=current()+cueSuffix(t);choices.classList.add('hidden');character.blur();return}
        if(e.key==='Tab'){
          e.preventDefault();takeHighlighted();choices.classList.add('hidden');
          tabFromCharacter(character,i,e.shiftKey,changed,commit);return;
        }
        if(plainArrow(e)){
          const up=e.key==='ArrowUp';
          if(!moveTarget(character,up))return;
          e.preventDefault();choices.classList.add('hidden');
          tabFromCharacter(character,i,up,changed,commit,arrowOptions(up));
        }
      };
      // Clicking away saves the typed name (and keeps the click's new focus).
      character.onblur=e=>{choices.classList.add('hidden');if(character.isConnected&&changed())commit(false,e.relatedTarget)};
      picker.append(character,choices);div.append(picker);
    }else if(t.who==='beat'){
      const beat=el('div','Beat.');beat.className='beat-text';beat.tabIndex=-1;
      beat.onclick=()=>{if(mobileQuery.matches)beat.focus({preventScroll:true})};
      div.append(beat);
    }
    let field=null;
    if(t.who==='me'||t.who==='them'){
      field=el('textarea');field.className='dialogue';field.placeholder='Dialogue…';field.value=t.text||'';field.setAttribute('aria-label','Dialogue');
      field.oninput=e=>{
        preserveTypedPunctuation(e,t.text||'');
        if(field.value!==(t.text||''))rememberScriptEdit(field);
        t.text=field.value;field.style.height='auto';field.style.height=field.scrollHeight+'px';queueSave();
      };
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
      field.oninput=e=>{
        preserveTypedPunctuation(e,t.text||'');
        if(heading){const pos=field.selectionStart;field.value=field.value.toUpperCase();field.setSelectionRange(pos,pos)}
        if(field.value!==(t.text||''))rememberScriptEdit(field);
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
      if(t.audio){const listen=el('button');listen.type='button';listen.className='btn btn-ghost btn-icon';setTip(listen,'Listen');listen.setAttribute('aria-label','Listen');listen.replaceChildren(icon('play'));listen.onclick=()=>{const url=URL.createObjectURL(t.audio);const a=new Audio(url);const fail=message=>{URL.revokeObjectURL(url);alert(`Couldn't play this recording (${t.audio.size} bytes, ${t.audio.type||'unknown format'}). ${message||''}`.trim())};a.onended=()=>URL.revokeObjectURL(url);a.onerror=()=>fail(a.error?.message);a.play().catch(e=>{if(!a.error)fail(e.message)})};controls.append(listen)}div.append(controls);
    }
    root.append(div);if(field){field.style.height='auto';field.style.height=Math.max(field.classList.contains('dialogue')?46:0,field.scrollHeight)+'px'}
  });
  if(focusedKind&&focusedIndex>=0){
    const currentIndex=script.turns.indexOf(focusedTurn);
    const index=currentIndex>=0?currentIndex:Math.min(focusedIndex,root.children.length-1);
    const block=root.children[index];
    const nextField=block?.querySelector(focusedKind)||block?.querySelector(MOBILE_BLOCK_FIELDS);
    if(nextField){
      nextField.focus({preventScroll:true});
      if(focused.matches(SCRIPT_FIELDS))nextField.setSelectionRange?.(focused.selectionStart,focused.selectionEnd);
    }
  }
  syncMobileEditBar();
  if(Math.abs(window.scrollY-savedScroll)>2)window.scrollTo({top:savedScroll,behavior:'instant'});
}
document.addEventListener('click',e=>{if(!e.target.closest('.margin-tools, .block-menu, .mobile-edit-bar'))closeBlockMenu()});
async function recordLine(i,button){
  if(recorder){if(recorder.state!=='inactive')recorder.stop();return}
  try{
    // Track the block itself, not its position, so moves/deletes during recording can't misplace audio.
    const turn=script.turns[i];
    const mic=await getMicrophone();
    if(!turn||!script?.turns.includes(turn)||turn.who!=='them'){releaseMicIfIdle();return}
    if(recorder)return;
    chunks=[];
    const currentRecorder=new MediaRecorder(mic);
    currentRecorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    currentRecorder.onstop=()=>{
      recorder=null;
      if(turn.who==='them'&&script?.turns.includes(turn)){
        rememberScriptEdit();
        turn.audio=new Blob(chunks,{type:currentRecorder.mimeType});
        render();queueSave(true);
      }else updateScriptHistoryButtons();
      releaseMicIfIdle();
    };
    currentRecorder.start();recorder=currentRecorder;updateScriptHistoryButtons();
    button.classList.add('recording');button.classList.replace('btn-ghost','btn-destructive');setTip(button,'Stop recording');button.setAttribute('aria-label','Stop recording');button.replaceChildren(icon('square'));
  }catch(e){alert('Microphone unavailable: '+e.message)}
}
function status(s){$('status').textContent=s}
// Speech-engine line detection for the current play session (null = voice activity).
let engineSession=null,engineModule=null,engineListen=null;
const PAUSE_MARKERS=/\(\s*(?:then|beat)\s*\)/gi;
const spokenText=text=>(text||'').replace(PAUSE_MARKERS,' ');
const lastWords=(text,n=8)=>{const w=text.trim().split(/\s+/);return (w.length>n?'… ':'')+w.slice(-n).join(' ')};
const detectionLabel=id=>({vosk:'Vosk',sherpa:'Sherpa-ONNX'}[id]||id);
// Loads the chosen engine and attaches it to the microphone. Falls back to voice activity on failure.
async function startEngineSession(mic){
  const id=lineDetection();
  if(id==='vad')return;
  const name=detectionLabel(id);
  try{
    status(`Loading ${name}…`);
    // import() resolves against this script (js/), so build the URL from the page instead.
    engineModule=await import(new URL('speech-lab/js/rehearsal-engine.js',document.baseURI).href);
    await engineModule.loadEngine(id,({stage,fraction})=>status(`${name}: ${stage}${fraction==null?'…':` ${Math.round(fraction*100)}%`}`));
    engineSession=await engineModule.startSession(id,mic);
  }catch(e){
    console.error('Speech engine unavailable',e);
    engineSession=null;
    const hint=location.protocol==='file:'?'Open the app through python3 speech-lab/serve.py.':'Run python3 speech-lab/setup.py.';
    status(`${name} unavailable — using voice activity. ${hint}`);
    await new Promise(r=>setTimeout(r,2500));
  }
}
function stopEngineSession(){
  if(engineListen){engineListen.cancel();engineListen=null}
  if(engineSession){const s=engineSession;engineSession=null;s.close()}
}
// Listens for your line with the speech engine; moves on when its cue (last N words) is heard.
function listenWithEngine(t){
  const h=engineSession.listenFor(spokenText(t.text),{cueWords:cueWords(),onHeard:heard=>{if(engineListen===h&&heard)status('Heard: '+lastWords(heard))}});
  engineListen=h;
  status(`Listening for your line… (${engineSession.label})`);
  h.done.then(r=>{if(engineListen!==h||!r||!playing)return;engineListen=null;idx++;next()});
}
function useEngineFor(t){
  if(!engineSession)return false;
  if(shortLinesUseVad()&&engineModule.wordCount(spokenText(t.text))<cueWords())return false;
  return true;
}
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
  $('playSceneTitle').textContent=scene.name;
  renderSceneList();renderPrompter();idx=firstPlayable(scene.start);display(true);status('Ready');
  if(mobileQuery.matches&&scenesVisible())setScenesOpen(false);
}
// Keep the space reserved under the teleprompter equal to the bottom dock (alert + bar), so
// the cued line stays centred above it whether or not the alert is showing.
let dockHeight=0;
new ResizeObserver(()=>{
  const h=$('playDock').offsetHeight;
  if(!h||h===dockHeight)return;
  dockHeight=h;$('playMain').style.setProperty('--play-bar-height',(h+24)+'px');
  if(!$('playPane').classList.contains('hidden'))display(true); // re-centre the cued line
}).observe($('playDock'));
// Scene sidebar: the header's sidebar button opens and closes it. On desktop it starts open
// (and remembers your choice while in play mode); on mobile it starts closed and opens over
// the teleprompter, closing again once you pick a scene.
// With only one scene there's nothing to pick: the sidebar stays closed and its button is
// hidden (without changing the remembered desktop choice).
let scenesPreferred=true;
function setScenesOpen(open){
  const mobile=mobileQuery.matches,single=scenes().length<2;
  $('toggleScenes').classList.toggle('hidden',single);
  if(single)open=false;else if(!mobile)scenesPreferred=open;
  $('playPane').classList.toggle('scenes-visible',open);
  $('playScenesBackdrop').classList.toggle('hidden',!(open&&mobile));
  $('toggleScenes').setAttribute('aria-expanded',String(open));
  setTip($('toggleScenes'),open?'Hide scenes':'Show scenes');
}
const scenesVisible=()=>$('playPane').classList.contains('scenes-visible');
mobileQuery.addEventListener('change',()=>{if(!$('playPane').classList.contains('hidden'))setScenesOpen(mobileQuery.matches?false:scenesPreferred)});
function firstPlayable(from){let i=from;while(i<sceneRange.end&&!isPlayable(script.turns[i]))i++;return i}
// Teleprompter: the scene's spoken lines only (character and dialogue; no scene headings, action
// or beats), with the current one cued in the middle of the screen. Beats still pause rehearsal.
function renderPrompter(){
  // Alert when reader lines in this scene have no recording (they're skipped in rehearsal).
  const missing=script.turns.slice(sceneRange.start,sceneRange.end).filter(t=>t.who==='them'&&!t.audio).length;
  $('playAlert').classList.toggle('hidden',!missing);
  $('playAlertTitle').textContent=missing===1?"1 reader line in this scene hasn't been recorded":missing+" reader lines in this scene haven't been recorded";
  const list=$('prompter');list.replaceChildren();
  script.turns.slice(sceneRange.start,sceneRange.end).forEach((t,k)=>{
    if(t.who!=='me'&&t.who!=='them')return;
    const line=el('li');line.className='prompter-line';line.dataset.who=t.who;line.dataset.index=sceneRange.start+k;
    const who=t.who==='me'?script.meCharacter:t.who==='them'?(t.character||'Reader'):'';
    const name=el('div',who&&who+cueSuffix(t));name.className='prompter-character';
    if(t.who==='them'&&!t.audio){const flag=el('span');flag.className='prompter-flag';flag.dataset.tooltip='Not recorded';flag.setAttribute('aria-label','Not recorded');flag.append(icon('circle-exclamation-point'));name.append(flag);line.dataset.unrecorded=''}
    const text=el('div',t.text||'');text.className='prompter-text';
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
$('start').onclick=async()=>{if(!script.turns.slice(sceneRange.start,sceneRange.end).some(isPlayable))return alert('This scene has no lines yet');try{const mic=await getMicrophone();audioCtx=new AudioContext();await audioCtx.resume();let source=audioCtx.createMediaStreamSource(mic);analyser=audioCtx.createAnalyser();analyser.fftSize=2048;source.connect(analyser);await startEngineSession(mic);if(!audioCtx){stopEngineSession();return}playing=true;idx=firstPlayable(sceneRange.start);setTransport(true);next()}catch(e){alert('Microphone unavailable: '+e.message);stop()}};$('stop').onclick=()=>{stop();releaseMicIfIdle()};
function next(){if(!playing)return;cancelAnimationFrame(raf);if(engineListen){engineListen.cancel();engineListen=null}idx=firstPlayable(idx);if(idx>=sceneRange.end){status('Scene complete');stop(true);releaseMicIfIdle();return}display();let t=script.turns[idx];if(t.who==='beat'){let seconds=beatSeconds(t);status(`Beat — ${seconds} second${seconds===1?'':'s'}…`);beatTimer=setTimeout(()=>{beatTimer=null;idx++;next()},seconds*1000);return}if(t.who==='them'){status('Playing reader…');if(!t.audio){status('Reader recording missing — skipping');idx++;setTimeout(next,250);return}playReaderLine(t);return}else if(useEngineFor(t)){listenWithEngine(t)}else{partsNeeded=lineParts(t.text);partsHeard=0;status(partsNeeded>1?`Listening for your line… (part 1 of ${partsNeeded})`:'Listening for your line…');heard=false;speechAt=0;lastVoice=0;listen()}}
// Plays one reader line. Back-to-back reader lines use the script's Reader spacing:
// a pause after this line ends, or (negative) starting the next line before this one ends.
async function playReaderLine(t){
  const context=audioCtx;
  const following=script.turns[firstPlayable(idx+1)];
  const spacing=following?.who==='them'&&following.audio?readerSpacing():0;
  let advanced=false;
  const isCurrent=()=>playing&&audioCtx===context;
  const advance=()=>{if(advanced||!isCurrent())return;advanced=true;clearTimeout(gapTimer);gapTimer=null;idx++;next()};
  const onEnded=()=>{
    if(advanced||!isCurrent())return;
    if(spacing>0)gapTimer=setTimeout(advance,spacing*1000);
    else advance();
  };
  if(autoTrimRecordings()){
    const decoded=decodeReaderTake(t.audio,context);
    if(following?.who==='them'&&following.audio)decodeReaderTake(following.audio,context);
    const buffer=await decoded;
    if(!isCurrent())return;
    if(buffer){
      let bounds=readerTrimBounds.get(t.audio);
      if(!bounds){bounds=findReaderTrim(buffer);readerTrimBounds.set(t.audio,bounds)}
      const source=context.createBufferSource();
      source.buffer=buffer;
      source.connect(context.destination);
      source.onended=()=>{source.disconnect();onEnded()};
      const duration=bounds.end-bounds.start;
      source.start(0,bounds.start,duration);
      if(spacing<0)gapTimer=setTimeout(advance,Math.max(0,duration+spacing)*1000);
      return;
    }
  }
  const url=URL.createObjectURL(t.audio);const audio=new Audio(url);
  activeAudio=audio;playingAudios.add(audio);
  const cleanup=()=>{URL.revokeObjectURL(url);playingAudios.delete(audio);if(activeAudio===audio)activeAudio=null};
  audio.onended=()=>{cleanup();onEnded()};
  audio.onerror=()=>{cleanup();advance()};
  audio.play().then(async()=>{
    if(spacing>=0||!isCurrent())return;
    const duration=await audioDuration(t.audio).catch(()=>null);
    if(duration&&isCurrent()&&!advanced)gapTimer=setTimeout(advance,Math.max(0,duration-audio.currentTime+spacing)*1000);
  }).catch(e=>{cleanup();if(isCurrent()){stop();status('Playback failed: '+e.message)}});
}
function listen(){if(!playing)return;let a=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(a);let sum=0;for(let v of a)sum+=v*v;let rms=Math.sqrt(sum/a.length),now=performance.now();const threshold=Math.max(.022,noiseFloor*2.8);if(rms>threshold){if(!speechAt)speechAt=now;if(now-speechAt>120){if(!heard)status(partsNeeded>1?`Speaking… (part ${partsHeard+1} of ${partsNeeded})`:'Speaking…');heard=true;lastVoice=now}}else{speechAt=0;if(!heard)noiseFloor=noiseFloor*.98+rms*.02;if(heard&&now-lastVoice>850){
  partsHeard++;
  if(partsHeard<partsNeeded){heard=false;status(`Keep going… (part ${partsHeard+1} of ${partsNeeded})`)}
  else{idx++;next();return}
}}raf=requestAnimationFrame(listen)}
function stop(done=false){playing=false;cancelAnimationFrame(raf);stopEngineSession();if(beatTimer!==null){clearTimeout(beatTimer);beatTimer=null}if(gapTimer!==null){clearTimeout(gapTimer);gapTimer=null}playingAudios.forEach(a=>a.pause());playingAudios.clear();activeAudio=null;decodedReaderTakes.clear();/* Keep microphone permission/stream alive until explicitly released. */if(audioCtx){audioCtx.close();audioCtx=null}setTransport(false);if(!done&&$('status'))status('Stopped')}
