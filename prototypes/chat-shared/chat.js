const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const area=$('#prompt'), attachments=$('#attachments'), file=$('#file'), modal=$('#runtime'), preview=$('#preview'), toast=$('#toast');
function grow(){area.style.height='0';area.style.height=Math.min(area.scrollHeight,220)+'px';area.style.overflowY=area.scrollHeight>220?'auto':'hidden'}
area.addEventListener('input',grow); grow();
function say(t){toast.textContent=t;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),1700)}
function addFiles(files){[...files].filter(f=>f.type.startsWith('image/')).forEach(f=>{const url=URL.createObjectURL(f), el=document.createElement('div');el.className='thumb';el.innerHTML=`<img src="${url}" alt="${f.name}"><button aria-label="移除图片">×</button>`;el.querySelector('img').onclick=()=>showPreview(url);el.querySelector('button').onclick=e=>{e.stopPropagation();el.remove()};attachments.append(el)});if(files.length)say('图片已加入，可点击预览')}
file.addEventListener('change',()=>addFiles(file.files));
area.addEventListener('paste',e=>{const fs=[...e.clipboardData.files].filter(f=>f.type.startsWith('image/'));if(fs.length){e.preventDefault();addFiles(fs)}});
$('#attach').onclick=()=>file.click();
function showPreview(url){$('#previewImg').src=url;preview.classList.add('open')}; preview.onclick=e=>{if(e.target===preview||e.target.closest('.close'))preview.classList.remove('open')};
function openRuntime(tab='agent'){modal.classList.add('open');selectTab(tab);setTimeout(()=>$('#runtimeSearch').focus(),50)}
$$('[data-runtime]').forEach(b=>b.onclick=()=>openRuntime(b.dataset.runtime));$('#closeRuntime').onclick=()=>modal.classList.remove('open');modal.onclick=e=>{if(e.target===modal)modal.classList.remove('open')};
function selectTab(tab){$$('.sheetnav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));$$('[data-panel]').forEach(p=>p.hidden=p.dataset.panel!==tab)}
$$('.sheetnav button').forEach(b=>b.onclick=()=>selectTab(b.dataset.tab));
$('#runtimeSearch').addEventListener('input',e=>$$('.model-option').forEach(x=>x.hidden=!x.textContent.toLowerCase().includes(e.target.value.toLowerCase())));
$$('.option').forEach(o=>o.onclick=()=>{const group=o.closest('[data-panel]');$$('.option',group).forEach(x=>x.classList.remove('selected'));o.classList.add('selected');if(o.dataset.agent){$('#agentLabel').textContent=o.dataset.agent;selectTab('model')}if(o.dataset.model)$('#modelLabel').textContent=o.dataset.model;say('设置已用于下一条消息')});
$$('.segments button').forEach(b=>b.onclick=()=>{const p=b.parentElement;$$('button',p).forEach(x=>x.classList.remove('active'));b.classList.add('active')});
let recording=false;$('#mic').onclick=()=>{recording=!recording;$('#voicebar').classList.toggle('open',recording);$('#mic').setAttribute('aria-pressed',recording);if(!recording){area.value+=(area.value?' ':'')+'请把这部分交互做成移动端优先。';grow();say('转写已插入，可继续编辑')}};$('#voiceDone').onclick=()=>{$('#mic').click()};
let running=false;$('#send').onclick=()=>{if(running){running=false;$('#send').classList.remove('stop');$('#send').textContent='↑';say('已停止 Agent');return}if(!area.value.trim()&&!attachments.children.length)return say('请输入消息或添加图片');running=true;$('#send').classList.add('stop');$('#send').textContent='■';area.value='';attachments.innerHTML='';grow();say('消息已发送，点击方块停止');setTimeout(()=>{if(running){running=false;$('#send').classList.remove('stop');$('#send').textContent='↑'}},3500)};
area.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#send').click()}if(e.key==='/'&&!area.value)say('继续输入以搜索 Agent 命令')});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){$$('.scrim.open').forEach(x=>x.classList.remove('open'))}if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();openRuntime('model')}});
