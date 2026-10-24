import asyncio,json,pathlib,os
from genehub_agent import Agent,Session,serve,events
class ProbeSession(Session):
 async def send(self,turn_id,text,attachments):
  p=pathlib.Path(self.ctx.config.cwd)/'self-update-sends.jsonl'
  with p.open('a') as f:f.write(json.dumps({'pid':os.getpid(),'sessionId':self.ctx.session_id,'hasUpdateReceipt':'Machine update result' in text})+'\n')
  self.ctx.set_persist({'checkpoint':'updating'})
  async def work():
   if 'Machine update result' not in text:
    child=await asyncio.create_subprocess_exec(os.environ['GENEHUB_CLI'],'update','live','--request-id','self-live','--wait',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,env={**os.environ,**self.ctx.config.session_environment()})
    out,err=await child.communicate()
    if child.returncode:raise RuntimeError(err.decode())
   self.ctx.emit(events.item(turn_id,events.assistant_message('reply-'+turn_id,'original goal completed after update')))
   self.ctx.emit(events.turn_completed(turn_id))
  self.task=asyncio.create_task(work())
 async def interrupt(self):
  if hasattr(self,'task'):self.task.cancel()
 async def close(self):await self.interrupt()
class ProbeAgent(Agent):
 async def refresh(self,ctx):
  ctx.set_state(ready=True,capabilities={'resume':True,'interrupt':True},catalog={'models':[{'id':'probe','label':'Probe','contextWindow':4096,'reasoning':False}],'modes':[],'defaultModel':'probe'})
 async def open_session(self,ctx):return ProbeSession(ctx)
serve(ProbeAgent())
